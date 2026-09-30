import CoreBluetooth
import Foundation

/// The CoreBluetooth radio behind the BLE primitives (foreground sessions
/// only — no `bluetooth-central` background mode is requested, rule 5). The
/// central manager boots on its own serial queue; scans arm once the radio
/// reports `poweredOn`. The OS consent layer is this file's business: a
/// `.denied`/`.restricted` authorization is `BleRadioFailure.osDenied`
/// (the audit names the layer), `.unsupported` is the honest capability gap
/// a simulator answers.
///
/// Device and connection ids are opaque host-minted tokens keyed to the
/// CBPeripheral object addresses — a caller never sees a MAC-style address.
/// GATT waits are one in-flight call per connection (the JS caller is
/// serial, D2; a second call on the same connection replaces the waiter and
/// the first resolves through `failAll` when the tuple is missing).
final class SystemBleRadio: NSObject, BleRadio {
    private let queue = DispatchQueue(label: "org.dsh.ble.central")
    /// Created LAZILY on the first radio-touching call: instantiating
    /// CBCentralManager is what surfaces the OS permission prompt on a real
    /// device, so a session that never calls a BLE primitive (every other
    /// drive, the serving seat) must never create one.
    private var central: CBCentralManager?
    private var stateWaiters: [(Result<Void, BleRadioFailure>) -> Void] = []
    private var liveScans: [String: (filter: [String], end: DispatchWorkItem)] = [:]
    private var peripheralsByDevice: [String: CBPeripheral] = [:]
    private var deviceByPeripheral: [ObjectIdentifier: String] = [:]
    private var connections: [String: CBPeripheral] = [:]
    private var connectionByPeripheral: [ObjectIdentifier: String] = [:]
    private var connectWaiters: [ObjectIdentifier: (Result<String?, BleRadioFailure>) -> Void] = [:]
    private var dropHandlers: [ObjectIdentifier: (String) -> Void] = [:]
    private var callerClosed: Set<ObjectIdentifier> = []
    private var readWaiters: [String: (Result<Data, BleRadioFailure>) -> Void] = [:]
    private var writeWaiters: [String: (Result<Void, BleRadioFailure>) -> Void] = [:]
    private var subscribeWaiters: [String: (Result<Bool, BleRadioFailure>) -> Void] = [:]
    private var unsubscribeWaiters: [String: (Result<Bool, BleRadioFailure>) -> Void] = [:]
    private var notifyHandlers: [String: (Data) -> Void] = [:]
    private var nextId = 0

    /// Wired by BLEPrimitives at registration; the queue-serial device tap.
    var deviceSink: ((BleRadioDevice) -> Void)?

    /// The OS consent verdict from the CURRENT authorization — a STATIC,
    /// prompt-free read; `.notDetermined` is granted-through — the first
    /// scan surfaces the system prompt and the state callback answers
    /// `osDenied` if the user refuses.
    var consent: Result<Void, BleRadioFailure> {
        switch CBCentralManager.authorization {
        case .denied, .restricted:
            return .failure(.osDenied("bluetooth authorization refused by system policy"))
        default:
            return .success(())
        }
    }

    /// The lazy manager (see the property comment).
    private func ensureCentral() -> CBCentralManager {
        if let central { return central }
        let created = CBCentralManager(delegate: self, queue: queue, options: nil)
        central = created
        return created
    }

    /// Resolves once the radio can serve (poweredOn) or cannot — the arm
    /// posture. An `unknown` state (fresh manager) parks on the state
    /// callback.
    private func awaitReady(
        _ completion: @escaping (Result<Void, BleRadioFailure>) -> Void
    ) {
        queue.async { [self] in
            let manager = ensureCentral()
            switch manager.state {
            case .poweredOn:
                completion(.success(()))
            case .unknown:
                stateWaiters.append(completion)
            default:
                completion(.failure(Self.stateFailure(manager.state)))
            }
        }
    }

    private static func stateFailure(_ state: CBManagerState) -> BleRadioFailure {
        switch state {
        case .unsupported:
            return .unsupported("this device has no Bluetooth radio (a simulator)")
        case .unauthorized:
            return .osDenied("bluetooth authorization refused by system policy")
        case .poweredOff:
            return .unsupported("the Bluetooth radio is powered off")
        default:
            return .unsupported("the Bluetooth radio is not ready (\(state.rawValue))")
        }
    }

    private func mint(_ prefix: String) -> String {
        nextId += 1
        return "\(prefix):ble-\(nextId)"
    }

    func scanStart(
        filter: [String], timeoutMs: Int,
        completion: @escaping (Result<String, BleRadioFailure>) -> Void
    ) {
        awaitReady { [self] ready in
            guard case .success = ready else {
                completion(.failure(failureOf(ready)))
                return
            }
            let scanId = mint("scan")
            let services = filter.map(CBUUID.init(string:))
            let end = DispatchWorkItem { [weak self] in self?.scanStop(scanId) }
            // already ON the central queue (awaitReady's completion) — a
            // queue.sync here would deadlock against ourselves
            liveScans[scanId] = (filter, end)
            ensureCentral().scanForPeripherals(
                withServices: services.isEmpty ? nil : services, options: nil)
            completion(.success(scanId))
            DispatchQueue.main.asyncAfter(
                deadline: .now() + .milliseconds(bleScanTimeoutClamp(timeoutMs)),
                execute: end)
        }
    }

    func scanStop(_ scanId: String) -> Bool {
        queue.sync {
            guard liveScans.removeValue(forKey: scanId) != nil else { return false }
            if liveScans.isEmpty { central?.stopScan() }
            return true
        }
    }

    func connect(
        _ deviceId: String,
        onDisconnect: @escaping (String) -> Void,
        completion: @escaping (Result<String?, BleRadioFailure>) -> Void
    ) {
        awaitReady { [self] ready in
            guard case .success = ready else {
                completion(.failure(failureOf(ready)))
                return
            }
            guard let peripheral = peripheralsByDevice[deviceId] else {
                completion(.success(nil)) // walked away: a value, not an error
                return
            }
            let connectionId = mint("conn")
            // already ON the central queue (awaitReady's completion)
            connectWaiters[ObjectIdentifier(peripheral)] = completion
            dropHandlers[ObjectIdentifier(peripheral)] = onDisconnect
            connections[connectionId] = peripheral
            connectionByPeripheral[ObjectIdentifier(peripheral)] = connectionId
            ensureCentral().connect(peripheral, options: nil)
        }
    }

    func disconnect(_ connectionId: String) -> Bool {
        queue.sync {
            guard let peripheral = connections.removeValue(forKey: connectionId)
            else { return false }
            callerClosed.insert(ObjectIdentifier(peripheral))
            // the maps clear on didDisconnect — the drop event stays suppressed
            central?.cancelPeripheralConnection(peripheral)
            return true
        }
    }

    func read(
        _ connectionId: String, _ service: String, _ characteristic: String,
        completion: @escaping (Result<Data, BleRadioFailure>) -> Void
    ) {
        withCharacteristic(connectionId, service, characteristic) { peripheral, char in
            self.readWaiters[connectionId] = completion
            peripheral.readValue(for: char)
        }
    }

    func write(
        _ connectionId: String, _ service: String, _ characteristic: String,
        data: Data, response: Bool,
        completion: @escaping (Result<Void, BleRadioFailure>) -> Void
    ) {
        withCharacteristic(connectionId, service, characteristic) { peripheral, char in
            self.writeWaiters[connectionId] = completion
            peripheral.writeValue(
                data, for: char,
                type: response ? .withResponse : .withoutResponse)
        }
    }

    func subscribe(
        _ connectionId: String, _ service: String, _ characteristic: String,
        onNotify: @escaping (Data) -> Void,
        completion: @escaping (Result<Bool, BleRadioFailure>) -> Void
    ) {
        withCharacteristic(connectionId, service, characteristic) { peripheral, char in
            self.subscribeWaiters[connectionId] = completion
            self.notifyHandlers["\(connectionId)|\(service)|\(characteristic)"] = onNotify
            peripheral.setNotifyValue(true, for: char)
        }
    }

    func unsubscribe(
        _ connectionId: String, _ service: String, _ characteristic: String,
        completion: @escaping (Result<Bool, BleRadioFailure>) -> Void
    ) {
        withCharacteristic(connectionId, service, characteristic) { peripheral, char in
            self.unsubscribeWaiters[connectionId] = completion
            peripheral.setNotifyValue(false, for: char)
        }
    }

    /// Resolves the GATT tuple on a LIVE connection and runs `body` on the
    /// central queue, or fails the connection's in-flight waiters — the
    /// shared shape of all four GATT calls.
    private func withCharacteristic(
        _ connectionId: String, _ service: String, _ characteristic: String,
        _ body: @escaping (CBPeripheral, CBCharacteristic) -> Void
    ) {
        queue.async { [self] in
            guard let peripheral = connections[connectionId] else {
                failAll(connectionId, .unsupported("connection is not live"))
                return
            }
            guard let svc = peripheral.services?
                .first(where: { Self.matches($0.uuid, service) })
            else {
                failAll(connectionId, .unsupported(
                    "service \(service) was not discovered on this peer"))
                return
            }
            guard let char = svc.characteristics?
                .first(where: { Self.matches($0.uuid, characteristic) })
            else {
                failAll(connectionId, .unsupported(
                    "characteristic \(characteristic) was not discovered on \(service)"))
                return
            }
            body(peripheral, char)
        }
    }

    private static func matches(_ uuid: CBUUID, _ opaque: String) -> Bool {
        uuid.uuidString.lowercased() == opaque.lowercased()
    }

    /// Fails every in-flight waiter of one connection (a call never hangs
    /// when the tuple is missing or the link is gone).
    private func failAll(_ connectionId: String, _ failure: BleRadioFailure) {
        readWaiters.removeValue(forKey: connectionId)?(.failure(failure))
        writeWaiters.removeValue(forKey: connectionId)?(.failure(failure))
        subscribeWaiters.removeValue(forKey: connectionId)?(.failure(failure))
        unsubscribeWaiters.removeValue(forKey: connectionId)?(.failure(failure))
    }

    private func failureOf(_ ready: Result<Void, BleRadioFailure>) -> BleRadioFailure {
        if case .failure(let f) = ready { return f }
        return .unsupported("the radio did not come up")
    }
}

// ---- CBCentralManagerDelegate ----------------------------------------------

extension SystemBleRadio: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        let waiters = stateWaiters
        stateWaiters = []
        switch central.state {
        case .poweredOn:
            waiters.forEach { $0(.success(())) }
        default:
            let failure = Self.stateFailure(central.state)
            waiters.forEach { $0(.failure(failure)) }
        }
    }

    func centralManager(
        _ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
        advertisementData: [String: Any], rssi RSSI: NSNumber
    ) {
        let deviceId = deviceByPeripheral[ObjectIdentifier(peripheral)] ?? mint("device")
        deviceByPeripheral[ObjectIdentifier(peripheral)] = deviceId
        peripheralsByDevice[deviceId] = peripheral
        let localName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let uuids = (advertisementData[
            CBAdvertisementDataServiceUUIDsKey] as? [CBUUID])?
            .map { $0.uuidString.lowercased() } ?? []
        let device = BleRadioDevice(
            deviceId: deviceId, name: peripheral.name ?? localName,
            rssi: RSSI.intValue, serviceUuids: uuids)
        for scan in liveScans.values
        where scan.filter.isEmpty || !uuids.filter(scan.filter.contains).isEmpty {
            deviceSink?(device)
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.delegate = self
        peripheral.discoverServices(nil) // the GATT tuple space, then resolve
    }

    func centralManager(
        _ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral,
        error: Error?
    ) {
        settleConnect(peripheral, nil)
    }

    /// The dropped link: exactly one `disconnect` event per connection, and
    /// never for a close the caller itself performed (the mock's posture).
    func centralManager(
        _ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral,
        error: Error?
    ) {
        let oid = ObjectIdentifier(peripheral)
        let callerInitiated = callerClosed.remove(oid) != nil
        guard let connectionId = connectionByPeripheral.removeValue(forKey: oid)
        else { return }
        connections.removeValue(forKey: connectionId)
        failAll(connectionId, .unsupported("the link dropped"))
        settleConnect(peripheral, nil)
        if !callerInitiated {
            dropHandlers.removeValue(forKey: oid)?(connectionId)
        }
        dropHandlers.removeValue(forKey: oid)
    }

    /// Settles the connect completion exactly once and forgets the waiter.
    private func settleConnect(_ peripheral: CBPeripheral, _ connectionId: String?) {
        if let waiter = connectWaiters.removeValue(forKey: ObjectIdentifier(peripheral)) {
            waiter(connectionId.map { .success($0) } ?? .failure(
                .unsupported("the GATT link did not come up")))
        }
    }
}

// ---- CBPeripheralDelegate (the GATT callbacks) -------------------------------

extension SystemBleRadio: CBPeripheralDelegate {
    func peripheral(
        _ peripheral: CBPeripheral, didDiscoverServices error: Error?
    ) {
        guard error == nil else {
            settleConnect(peripheral, nil)
            return
        }
        peripheral.services?.forEach { peripheral.discoverCharacteristics(nil, for: $0) }
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didDiscoverCharacteristicsFor service: CBService, error: Error?
    ) {
        guard error == nil else {
            settleConnect(peripheral, nil)
            return
        }
        if peripheral.services?.allSatisfy({ $0.characteristics != nil }) == true {
            settleConnect(
                peripheral, connectionByPeripheral[ObjectIdentifier(peripheral)])
        }
    }

    func peripheral(
        _ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard let connectionId = connectionByPeripheral[ObjectIdentifier(peripheral)],
              let tuple = tupleOf(peripheral, characteristic) else { return }
        if let error {
            readWaiters.removeValue(forKey: connectionId)?(
                .failure(.unsupported("read failed: \(error.localizedDescription)")))
            return
        }
        readWaiters.removeValue(forKey: connectionId)?(
            .success(characteristic.value ?? Data()))
        notifyHandlers["\(connectionId)|\(tuple.0)|\(tuple.1)"]?(
            characteristic.value ?? Data())
    }

    func peripheral(
        _ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard let connectionId = connectionByPeripheral[ObjectIdentifier(peripheral)]
        else { return }
        if let error {
            writeWaiters.removeValue(forKey: connectionId)?(
                .failure(.unsupported("write failed: \(error.localizedDescription)")))
        } else {
            writeWaiters.removeValue(forKey: connectionId)?(.success(()))
        }
    }

    func peripheral(
        _ peripheral: CBPeripheral,
        didUpdateNotificationStateFor characteristic: CBCharacteristic,
        error: Error?
    ) {
        guard let connectionId = connectionByPeripheral[ObjectIdentifier(peripheral)]
        else { return }
        let outcome: Result<Bool, BleRadioFailure> = characteristic.isNotifying
            ? .success(true)
            : (error == nil ? .success(false) : .failure(
                .unsupported("unsubscribe failed: \(error!.localizedDescription)")))
        if characteristic.isNotifying || error != nil {
            subscribeWaiters.removeValue(forKey: connectionId)?(outcome)
        } else {
            unsubscribeWaiters.removeValue(forKey: connectionId)?(outcome)
        }
    }

    /// The "(service, characteristic)" opaque pair of one characteristic —
    /// the key the notify handlers are stored under.
    private func tupleOf(
        _ peripheral: CBPeripheral, _ characteristic: CBCharacteristic
    ) -> (String, String)? {
        guard let service = characteristic.service else { return nil }
        return (service.uuid.uuidString.lowercased(),
                characteristic.uuid.uuidString.lowercased())
    }
}
