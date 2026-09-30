import Foundation
import UIKit

/// The BLE face (the system capability plane, grant family `ble`): eight
/// primitives over one radio (`SystemBleRadio` on hardware, `MockBleRadio`
/// on the E2E legs — same enforcement, same audit). Consent is TWO layers:
/// the gateway grant first (the caller manifest's family flag; a caller
/// without it gets the SAME alert `presentApproval` uses — approve once /
/// approve & remember / decline), the OS permission second. The audit
/// record names the layer that refused; byte counts ride the records, never
/// payload bytes. `ble.event` records (device batches, GATT notifications,
/// disconnects) ride `core.emit` — never polled (D8).
final class BLEPrimitives {
    /// The standing-grant key ("Approve & Remember" persists app-scoped —
    /// the clipboardRead posture; revocation = deleting the app until the
    /// settings face lands).
    static let standingGrantKey = "dsh.ble.granted"

    private weak var core: GatewayCore?
    private let radio: BleRadio
    /// The session-scoped gateway grant (dies with the session).
    private var sessionGrant = false
    /// Armed scans with their arm timestamps — touched from the gateway work
    /// queue AND the radio's queue, so the lock is load-bearing.
    private let scanLock = NSLock()
    private var armedScans: [String: Date] = [:]

    private func armScan(_ scanId: String) {
        scanLock.lock()
        armedScans[scanId] = Date()
        scanLock.unlock()
    }

    init(core: GatewayCore, radio: BleRadio) {
        self.core = core
        self.radio = radio
        core.register(name: "bleScanStart") { call, done in self.scanStart(call, done) }
        core.register(name: "bleScanStop") { call, done in self.scanStop(call, done) }
        core.register(name: "bleConnect") { call, done in self.connect(call, done) }
        core.register(name: "bleDisconnect") { call, done in self.disconnect(call, done) }
        core.register(name: "bleRead") { call, done in self.read(call, done) }
        core.register(name: "bleWrite") { call, done in self.write(call, done) }
        core.register(name: "bleSubscribe") { call, done in self.subscribe(call, done) }
        core.register(name: "bleUnsubscribe") { call, done in self.unsubscribe(call, done) }
        radio.deviceSink = { [weak self] device in self?.deviceArrived(device) }
        radio.scanEndSink = { [weak self] scanId in self?.scanEnded(scanId) }
        // the capability plane's prompt layer: BLE rows route here before
        // the flat denial (GatewayCore.capabilityPrompter) — the runtime
        // approval's grant is session-scoped, its decline is the denial
        core.capabilityPrompter = { [weak self] primitive, grant, deny in
            guard let self, primitive.hasPrefix("ble") else { return deny() }
            self.ensurePrompt(grant, deny)
        }
    }

    /// The prompt layer's own gate: the session/standing grants answer
    /// without UI; otherwise the alert asks.
    private func ensurePrompt(_ grant: @escaping () -> Void, _ deny: @escaping () -> Void) {
        if sessionGrant || UserDefaults.standard.bool(forKey: Self.standingGrantKey) {
            return grant()
        }
        DispatchQueue.main.async { [weak self] in
            guard let self, let root = self.rootViewController() else {
                return deny()
            }
            root.present(self.consentAlert(grant, deny), animated: true)
        }
    }

    // ---- the gateway consent layer ------------------------------------------

    /// The family grant: manifest-declared, or already granted through the
    /// prompt layer (whose session/standing bookkeeping lives here). A
    /// caller that is neither never reaches this handler — the dispatch
    /// prompter intercepts ungranted capability rows before any handler
    /// runs, so the defensive deny below is belt-and-braces.
    private func ensureGrant(
        _ primitive: String, _ call: GatewayCall, _ done: @escaping GatewayDone,
        _ body: @escaping () -> Void
    ) {
        if let granted = core?.manifest.grants(primitive: primitive), granted {
            body()
            return
        }
        if sessionGrant || UserDefaults.standard.bool(forKey: Self.standingGrantKey) {
            body()
            return
        }
        done(.failure(GatewayError(code: "denied", primitive: primitive,
            message: "the gateway consent layer refused")))
    }

    /// The gateway consent surface — the SAME alert presentApproval uses;
    /// the three answers are the approval ladder (once / remember / decline;
    /// remember persists the standing grant, decline IS the denial).
    private func consentAlert(
        _ grant: @escaping () -> Void, _ deny: @escaping () -> Void
    ) -> UIAlertController {
        let alert = UIAlertController(
            title: "Allow Bluetooth access?",
            message: "The agent wants to reach nearby BLE devices "
                + "(scan, connect, GATT). Approve once, always, or decline.",
            preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Approve", style: .default) { [weak self] _ in
            self?.sessionGrant = true
            grant()
        })
        alert.addAction(UIAlertAction(title: "Approve & Remember", style: .default) { [weak self] _ in
            UserDefaults.standard.set(true, forKey: Self.standingGrantKey)
            self?.sessionGrant = true
            grant()
        })
        alert.addAction(UIAlertAction(title: "Decline", style: .cancel) { _ in
            deny()
        })
        return alert
    }

    private func rootViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes
        return scenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first?
            .rootViewController
    }

    // ---- the OS consent + capability gate ------------------------------------

    /// The radio's consent verdict → the call proceeds, or the honest
    /// rejection (`unavailable` for a missing radio, `denied` naming the OS
    /// layer). Runs before every radio-touching call.
    /// The radio's consent verdict → true to proceed, or the honest
    /// rejection settled here (`unavailable` for a missing radio, `denied`
    /// naming the OS layer). Synchronous — callers guard on it.
    private func guardRadio(_ primitive: String, _ done: @escaping GatewayDone) -> Bool {
        switch radio.consent {
        case .success:
            return true
        case .failure(.osDenied(let why)):
            core?.stageAuditDetail(["layer": "os", "family": "ble"])
            done(.failure(GatewayError(
                code: "denied", primitive: primitive, message: why)))
            return false
        case .failure(.unsupported(let why)):
            done(.failure(GatewayError(
                code: "unavailable", primitive: primitive, message: why)))
            return false
        }
    }

    // ---- scan -----------------------------------------------------------------

    /// The radio's scan-window close (the timeout self-end): fan out to
    /// every armed scan, then the scan is simply over — the caller's own
    /// stop settles idempotently afterwards.
    private func scanEnded(_ scanId: String) {
        scanLock.lock()
        armedScans.removeValue(forKey: scanId)
        scanLock.unlock()
        let record: [String: Any] = [
            "event": "ble.event", "kind": "scan-end", "scanId": scanId,
        ]
        core?.emit?(GatewayCore.jsonLine(record) ?? "{}")
    }

    private func scanStart(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        let filter = (call.args["serviceUuids"] as? [String]) ?? []
        let asked = (call.args["timeoutMs"] as? Int) ?? 5_000
        ensureGrant("bleScanStart", call, done) { [self] in
            guard guardRadio("bleScanStart", done) else { return }
            radio.scanStart(
                filter: filter, timeoutMs: asked,
                completion: { [weak self] result in
                    self?.onScanArmed(result, filter, asked, call, done)
                })
        }
    }

    /// The scan arm's completion — named so the consent-ladder nesting
    /// stays inside the indent budget; the audit detail carries the timer
    /// tag precedent (scanId / filters / clamp-named timeout / tag).
    private func onScanArmed(
        _ result: Result<String, BleRadioFailure>, _ filter: [String],
        _ asked: Int, _ call: GatewayCall, _ done: @escaping GatewayDone
    ) {
        switch result {
        case .success(let scanId):
            armScan(scanId)
            var detail: [String: Any] = [
                "scanId": scanId,
                "filters": filter.count,
                "timeoutMs": bleScanTimeoutClamp(asked),
            ]
            if let tag = call.string("tag") { detail["tag"] = tag }
            core?.stageAuditDetail(detail)
            done(.success(["scanId": scanId]))
        case .failure(let failure):
            doneRadioFailure("bleScanStart", failure, done)
        }
    }

    private func scanStop(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let scanId = call.string("scanId") else {
            return done(.failure(GatewayError(
                code: "invalid", primitive: "bleScanStop", message: "scanId missing")))
        }
        let stopped = radio.scanStop(scanId)
        var detail: [String: Any] = ["scanId": scanId, "stopped": stopped]
        scanLock.lock()
        let armed = armedScans.removeValue(forKey: scanId)
        scanLock.unlock()
        if stopped, let armed {
            detail["durationMs"] = Int(Date().timeIntervalSince(armed) * 1000)
        }
        core?.stageAuditDetail(detail)
        done(.success(["stopped": stopped]))
    }

    /// The radio's device tap fans out to every armed scan (the proposal's
    /// one channel per session object).
    private func deviceArrived(_ device: BleRadioDevice) {
        let payload: [String: Any] = [
            "event": "ble.event",
            "kind": "device",
            "deviceId": device.deviceId,
            "name": device.name ?? NSNull(),
            "rssi": device.rssi,
            "serviceUuids": device.serviceUuids,
        ]
        scanLock.lock()
        let scanIds = Array(armedScans.keys)
        scanLock.unlock()
        for scanId in scanIds {
            var record = payload
            record["scanId"] = scanId
            core?.emit?(GatewayCore.jsonLine(record) ?? "{}")
        }
    }

    // ---- connect / disconnect ---------------------------------------------------

    private func connect(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let deviceId = call.string("deviceId") else {
            return done(.failure(GatewayError(
                code: "invalid", primitive: "bleConnect", message: "deviceId missing")))
        }
        ensureGrant("bleConnect", call, done) { [self] in
            guard guardRadio("bleConnect", done) else { return }
            radio.connect(deviceId,
                onDisconnect: { [weak self] connectionId in
                    self?.emitDrop(connectionId)
                },
                completion: { [weak self] result in
                    self?.onConnected(result, deviceId, done)
                })
        }
    }

    /// The drop event: exactly one `disconnect` record per connection.
    private func emitDrop(_ connectionId: String) {
        let record: [String: Any] = [
            "event": "ble.event", "kind": "disconnect",
            "connectionId": connectionId, "reason": "link-lost",
        ]
        core?.emit?(GatewayCore.jsonLine(record) ?? "{}")
    }

    /// The connect completion — walked away resolves null (a value, not an
    /// error); the audit carries the device token and the outcome.
    private func onConnected(
        _ result: Result<String?, BleRadioFailure>, _ deviceId: String,
        _ done: @escaping GatewayDone
    ) {
        switch result {
        case .success(let connectionId):
            core?.stageAuditDetail([
                "deviceId": deviceId, "connected": connectionId != nil,
            ])
            done(.success(connectionId.map { ["connectionId": $0] } ?? NSNull()))
        case .failure(let failure):
            doneRadioFailure("bleConnect", failure, done)
        }
    }

    private func disconnect(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let connectionId = call.string("connectionId") else {
            return done(.failure(GatewayError(
                code: "invalid", primitive: "bleDisconnect",
                message: "connectionId missing")))
        }
        let closed = radio.disconnect(connectionId)
        core?.stageAuditDetail(["connectionId": connectionId, "closed": closed])
        done(.success(["closed": closed]))
    }

    // ---- GATT ---------------------------------------------------------------------

    private func read(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        tupleCall("bleRead", call, done) { connectionId, service, characteristic in
            self.radio.read(connectionId, service, characteristic) { [weak self] result in
                self?.onRead(result, connectionId, service, characteristic, done)
            }
        }
    }

    /// The read completion — one byte-count detail line, base64 payload.
    private func onRead(
        _ result: Result<Data, BleRadioFailure>, _ connectionId: String,
        _ service: String, _ characteristic: String, _ done: @escaping GatewayDone
    ) {
        switch result {
        case .success(let data):
            core?.stageAuditDetail(Self.gattDetail(
                "read", connectionId, service, characteristic, data.count))
            done(.success(["bytesB64": data.base64EncodedString()]))
        case .failure(let failure):
            doneRadioFailure("bleRead", failure, done)
        }
    }

    private func write(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let data = call.b64("bytesB64") else {
            return done(.failure(GatewayError(
                code: "invalid", primitive: "bleWrite",
                message: "bytesB64 missing or malformed")))
        }
        let withResponse = call.bool("response", default: true)
        tupleCall("bleWrite", call, done) { connectionId, service, characteristic in
            self.radio.write(
                connectionId, service, characteristic, data: data,
                response: withResponse,
                completion: { [weak self] result in
                    self?.onWritten(result, connectionId, service, characteristic, data.count, done)
                })
        }
    }

    /// The write completion — direction "write" + byte count in the record.
    private func onWritten(
        _ result: Result<Void, BleRadioFailure>, _ connectionId: String,
        _ service: String, _ characteristic: String, _ size: Int,
        _ done: @escaping GatewayDone
    ) {
        switch result {
        case .success:
            core?.stageAuditDetail(Self.gattDetail(
                "write", connectionId, service, characteristic, size))
            done(.success(["written": true]))
        case .failure(let failure):
            doneRadioFailure("bleWrite", failure, done)
        }
    }

    private func subscribe(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        tupleCall("bleSubscribe", call, done) { [weak self] connectionId, service, char in
            self?.radio.subscribe(
                connectionId, service, char,
                onNotify: { [weak self] data in
                    self?.emitNotify(connectionId, service, char, data)
                },
                completion: { result in
                    self?.settleArmed("bleSubscribe", result, connectionId, service, char, done)
                })
        }
    }

    /// The notify event: the value rides base64 (the bridge's convention).
    private func emitNotify(
        _ connectionId: String, _ service: String, _ characteristic: String,
        _ data: Data
    ) {
        let record: [String: Any] = [
            "event": "ble.event", "kind": "notify",
            "connectionId": connectionId, "service": service,
            "characteristic": characteristic,
            "bytesB64": data.base64EncodedString(),
        ]
        core?.emit?(GatewayCore.jsonLine(record) ?? "{}")
    }

    /// Subscribe/unsubscribe share the tuple-record + boolean settle.
    private func settleArmed(
        _ primitive: String, _ result: Result<Bool, BleRadioFailure>,
        _ connectionId: String, _ service: String, _ characteristic: String,
        _ done: @escaping GatewayDone
    ) {
        switch result {
        case .success(let armed):
            let direction = primitive == "bleSubscribe" ? "subscribe" : "unsubscribe"
            core?.stageAuditDetail(Self.gattDetail(
                direction, connectionId, service, characteristic, 0))
            done(.success(["subscribed": armed]))
        case .failure(let failure):
            doneRadioFailure(primitive, failure, done)
        }
    }

    private func unsubscribe(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        tupleCall("bleUnsubscribe", call, done) { [weak self] connectionId, service, char in
            self?.radio.unsubscribe(connectionId, service, char) { result in
                self?.settleArmed("bleUnsubscribe", result, connectionId, service, char, done)
            }
        }
    }

    /// The shared shape of the four GATT calls: validate the tuple, ride the
    /// consent ladder, then run the caller's body with the parsed parts.
    private func tupleCall(
        _ primitive: String, _ call: GatewayCall, _ done: @escaping GatewayDone,
        _ body: @escaping (String, String, String) -> Void
    ) {
        guard let connectionId = call.string("connectionId"),
              let service = call.string("service"),
              let characteristic = call.string("characteristic")
        else {
            return done(.failure(GatewayError(
                code: "invalid", primitive: primitive,
                message: "connectionId, service and characteristic are required")))
        }
        ensureGrant(primitive, call, done) { [self] in
            guard guardRadio(primitive, done) else { return }
            body(connectionId, service, characteristic)
        }
    }

    private static func gattDetail(
        _ direction: String, _ connectionId: String,
        _ service: String, _ characteristic: String, _ bytes: Int
    ) -> [String: Any] {
        var detail: [String: Any] = [
            "direction": direction, "connectionId": connectionId,
            "service": service, "characteristic": characteristic,
        ]
        if direction == "read" || direction == "write" {
            detail["bytes"] = bytes
        } else {
            detail["subscribed"] = direction == "subscribe"
        }
        return detail
    }

    private func doneRadioFailure(
        _ primitive: String, _ failure: BleRadioFailure,
        _ done: @escaping GatewayDone
    ) {
        switch failure {
        case .osDenied(let why):
            core?.stageAuditDetail(["layer": "os", "family": "ble"])
            done(.failure(GatewayError(
                code: "denied", primitive: primitive, message: why)))
        case .unsupported(let why):
            done(.failure(GatewayError(
                code: "unavailable", primitive: primitive, message: why)))
        }
    }
}
