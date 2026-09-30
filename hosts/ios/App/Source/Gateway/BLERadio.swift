import Foundation

/// The radio abstraction under the BLE primitives (the system capability
/// plane, BLE face): `SystemBleRadio` wraps CoreBluetooth for hardware, and
/// `MockBleRadio` is the deterministic in-process radio the E2E legs run
/// against — the SAME gateway enforcement and audit trail over BOTH, so CI
/// verifies the envelope without pretending a simulator has a radio. The
/// mock's device names carry the "DSH Mock BLE" prefix, and the mock
/// manifests pin those names, so evidence can never pass against a radio
/// that is not the named mock.
enum BleRadioFailure: Error {
    /// The radio layer cannot serve the call (a capability gap negotiation
    /// should have caught — contract §3 `unavailable`).
    case unsupported(String)
    /// The OS consent layer refused (contract `denied`, audit layer "os").
    case osDenied(String)
}

/// One advertisement batch record (proposal §7: `{scanId, kind: "device",
/// deviceId, name?, rssi, serviceUuids?}`).
struct BleRadioDevice {
    let deviceId: String
    let name: String?
    let rssi: Int
    let serviceUuids: [String]
}

protocol BleRadio: AnyObject {
    /// The OS consent verdict BEFORE any call: success, or the refusal /
    /// capability gap the primitives translate into `denied`/`unavailable`.
    var consent: Result<Void, BleRadioFailure> { get }

    /// The queue-serial advertisement tap — wired by BLEPrimitives at
    /// registration; both radios deliver discovered devices through it (the
    /// primitives fan out to every armed scan).
    var deviceSink: ((BleRadioDevice) -> Void)? { get set }

    /// The scan window's own close (the host-side timeout self-end): a
    /// terminal record on the session channel, the http.end precedent —
    /// the consumer's bound for a live-but-silent radio.
    var scanEndSink: ((String) -> Void)? { get set }

    /// Arms a scan; resolves the scanId WHEN ARMED (the micStart posture).
    /// Devices arrive through `deviceSink`; the scan ends itself at the
    /// timeout or at `scanStop`.
    func scanStart(
        filter: [String], timeoutMs: Int,
        completion: @escaping (Result<String, BleRadioFailure>) -> Void
    )
    /// Idempotent: false for an unknown or already-ended scanId.
    func scanStop(_ scanId: String) -> Bool

    /// Resolves the connectionId once the GATT link is up; `.success(nil)`
    /// when the device walked away (a VALUE, not an error); `.failure` when
    /// the radio layer cannot serve the call at all (the audit names it).
    /// Drops arrive through `onDisconnect` exactly once.
    func connect(
        _ deviceId: String,
        onDisconnect: @escaping (String) -> Void,
        completion: @escaping (Result<String?, BleRadioFailure>) -> Void
    )
    /// Idempotent: false for an unknown or already-closed connectionId.
    func disconnect(_ connectionId: String) -> Bool

    func read(
        _ connectionId: String, _ service: String, _ characteristic: String,
        completion: @escaping (Result<Data, BleRadioFailure>) -> Void
    )
    func write(
        _ connectionId: String, _ service: String, _ characteristic: String,
        data: Data, response: Bool,
        completion: @escaping (Result<Void, BleRadioFailure>) -> Void
    )
    /// Arms notifications; values arrive through `onNotify` (never polled).
    func subscribe(
        _ connectionId: String, _ service: String, _ characteristic: String,
        onNotify: @escaping (Data) -> Void,
        completion: @escaping (Result<Bool, BleRadioFailure>) -> Void
    )
    func unsubscribe(
        _ connectionId: String, _ service: String, _ characteristic: String,
        completion: @escaping (Result<Bool, BleRadioFailure>) -> Void
    )
}

/// The host-side clamp every radio honors: the proposal names the clamp, the
/// rejection (when one ever surfaces) names the range — never a silent
/// truncation (rule 5).
let bleScanTimeoutClamp = { (ms: Int) in min(max(ms, 100), 30_000) }

/// The deterministic mock radio (the CI-verifiable mock layer). Its closed
/// GATT db: battery-like 180f/2a19 (read answers one byte, notify capable)
/// and the unassigned vendor-test write space fe00/fe01. Two devices
/// advertise per scan, in order. No OS layer exists to ask — the consent
/// verdict is granted, and the audit trail simply never carries an OS
/// refusal on a mock run.
final class MockBleRadio: BleRadio {
    static let namePrefix = "DSH Mock BLE"
    static let tuple180F = "180f"
    static let char2A19 = "2a19"
    static let tupleFE00 = "fe00"
    static let charFE01 = "fe01"

    private let queue = DispatchQueue(label: "org.dsh.ble.mock")
    private var nextScan = 0
    private var liveScans: [String: DispatchWorkItem] = [:]
    private var connections: Set<String> = []
    private var notifying: Set<String> = []

    var consent: Result<Void, BleRadioFailure> { .success(()) }
    var deviceSink: ((BleRadioDevice) -> Void)?
    var scanEndSink: ((String) -> Void)?

    func scanStart(
        filter: [String], timeoutMs: Int,
        completion: @escaping (Result<String, BleRadioFailure>) -> Void
    ) {
        queue.async { [self] in
            nextScan += 1
            let scanId = "scan:mock-\(nextScan)"
            let end = DispatchWorkItem { [weak self] in self?.endScan(scanId) }
            liveScans[scanId] = end
            completion(.success(scanId))
            deliverBatch(scanId, filter: filter)
            DispatchQueue.main.asyncAfter(
                deadline: .now() + .milliseconds(bleScanTimeoutClamp(timeoutMs)),
                execute: end)
            DispatchQueue.main.asyncAfter(
                deadline: .now() + .milliseconds(bleScanTimeoutClamp(timeoutMs))
            ) { [weak self] in
                if self?.liveScans[scanId] == nil { return }
                self?.scanEndSink?(scanId)
            }
        }
    }

    /// The two-device batch, one bridge hop per advertisement (the
    /// proposal's "one advertisement batch per event"), honoring the filter.
    private func deliverBatch(_ scanId: String, filter: [String]) {
        let devices = [
            BleRadioDevice(
                deviceId: "device:mock-1", name: "\(Self.namePrefix) Sensor",
                rssi: -42, serviceUuids: [Self.tuple180F]),
            BleRadioDevice(
                deviceId: "device:mock-2", name: "\(Self.namePrefix) Beacon",
                rssi: -66, serviceUuids: []),
        ]
        for (index, device) in devices.enumerated() {
            guard filter.isEmpty
                || !device.serviceUuids.filter(filter.contains).isEmpty else { continue }
            queue.asyncAfter(
                deadline: .now() + .milliseconds(20 * (index + 1))
            ) { [weak self] in
                guard self?.liveScans[scanId] != nil else { return }
                self?.deviceSink?(device)
            }
        }
    }

    private func endScan(_ scanId: String) {
        queue.async { [weak self] in
            self?.liveScans.removeValue(forKey: scanId)
        }
    }

    func scanStop(_ scanId: String) -> Bool {
        queue.sync {
            guard let end = liveScans.removeValue(forKey: scanId) else { return false }
            end.cancel()
            return true
        }
    }

    func connect(
        _ deviceId: String,
        onDisconnect: @escaping (String) -> Void,
        completion: @escaping (Result<String?, BleRadioFailure>) -> Void
    ) {
        queue.async { [self] in
            guard deviceId.hasPrefix("device:mock-") else {
                // a device that walked away: a value, not an error
                completion(.success(nil))
                return
            }
            let connectionId = "conn:\(deviceId)"
            connections.insert(connectionId)
            completion(.success(connectionId))
        }
    }

    func disconnect(_ connectionId: String) -> Bool {
        queue.sync { connections.remove(connectionId) != nil }
    }

    func read(
        _ connectionId: String, _ service: String, _ characteristic: String,
        completion: @escaping (Result<Data, BleRadioFailure>) -> Void
    ) {
        queue.async { [self] in
            guard connections.contains(connectionId) else {
                completion(.failure(.unsupported("connection is not live")))
                return
            }
            if service == Self.tuple180F && characteristic == Self.char2A19 {
                completion(.success(Data([0x5a])))
            } else {
                completion(.failure(Self.noSuchTuple(service, characteristic)))
            }
        }
    }

    func write(
        _ connectionId: String, _ service: String, _ characteristic: String,
        data: Data, response: Bool,
        completion: @escaping (Result<Void, BleRadioFailure>) -> Void
    ) {
        queue.async { [self] in
            guard connections.contains(connectionId) else {
                completion(.failure(.unsupported("connection is not live")))
                return
            }
            if service == Self.tupleFE00 && characteristic == Self.charFE01 {
                completion(.success(()))
            } else {
                completion(.failure(Self.noSuchTuple(service, characteristic)))
            }
        }
    }

    func subscribe(
        _ connectionId: String, _ service: String, _ characteristic: String,
        onNotify: @escaping (Data) -> Void,
        completion: @escaping (Result<Bool, BleRadioFailure>) -> Void
    ) {
        queue.async { [self] in
            guard connections.contains(connectionId) else {
                completion(.failure(.unsupported("connection is not live")))
                return
            }
            guard service == Self.tuple180F && characteristic == Self.char2A19 else {
                completion(.failure(Self.noSuchTuple(service, characteristic)))
                return
            }
            let key = "\(connectionId)|\(service)|\(characteristic)"
            notifying.insert(key)
            completion(.success(true))
            for seq in 1...2 {
                queue.asyncAfter(
                    deadline: .now() + .milliseconds(30 * seq)
                ) { [weak self] in
                    guard self?.notifying.contains(key) == true else { return }
                    onNotify(Data([0x5a, UInt8(seq)]))
                }
            }
        }
    }

    func unsubscribe(
        _ connectionId: String, _ service: String, _ characteristic: String,
        completion: @escaping (Result<Bool, BleRadioFailure>) -> Void
    ) {
        queue.async { [self] in
            let key = "\(connectionId)|\(service)|\(characteristic)"
            notifying.remove(key)
            // the POST state (disarmed) — idempotent, never a lie about what
            // the call changed
            completion(.success(false))
        }
    }

    private static func noSuchTuple(_ service: String, _ characteristic: String)
        -> BleRadioFailure {
        .unsupported("tuple (\(service),\(characteristic)) is not in the mock GATT db")
    }
}
