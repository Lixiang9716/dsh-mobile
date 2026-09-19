import Foundation

/// One settled primitive call. `payload` is JSON-serializable (a dictionary,
/// an array, a String, a number, or NSNull for void/null results).
typealias GatewayDone = (Result<Any, GatewayError>) -> Void

/// Handler signature: runs OFF the runtime thread; must call `done` exactly
/// once (from any thread — the core routes the settle back onto the runtime
/// queue, ARCHITECTURE.md §6 thread rules).
typealias GatewayHandler = (GatewayCall, @escaping GatewayDone) -> Void

/// Arguments of one primitive call, decoded from the bridge's args JSON.
/// Bytes ride base64 in fields ending "B64" (frozen bridge convention).
struct GatewayCall {
    let callId: Int
    let args: [String: Any]

    func string(_ key: String) -> String? { args[key] as? String }

    func bool(_ key: String, default def: Bool = false) -> Bool {
        args[key] as? Bool ?? def
    }

    func dict(_ key: String) -> [String: Any] { args[key] as? [String: Any] ?? [:] }

    /// Decodes a base64 byte field ("<key>B64"); nil when absent/malformed.
    func b64(_ key: String) -> Data? {
        guard let text = string(key) else { return nil }
        return Data(base64Encoded: text)
    }
}

/// Contract §3 GatewayError — one structured rejection per failed call.
/// Codes are the closed set of primitives.md (unknown codes are fatal).
struct GatewayError: Error {
    let code: String
    let primitive: String
    let message: String
}

/// The caller's manifest (data-protocols.md §2), read from the staged bundle
/// root. Fail-loud: a missing or malformed manifest aborts the session.
struct GatewayManifest {
    static let caller = "dsh.spike.scenario"
    let id: String
    let required: [String]

    init(bundleRoot: URL) throws {
        let url = bundleRoot.appendingPathComponent("manifest.json")
        guard let data = FileManager.default.contents(atPath: url.path),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else {
            throw GatewayError(code: "io", primitive: "manifest",
                message: "bundle_root/manifest.json missing or unparseable")
        }
        guard obj["schemaVersion"] as? Int == 1, let id = obj["id"] as? String,
              let caps = obj["capabilities"] as? [String: Any],
              let required = caps["required"] as? [String]
        else {
            throw GatewayError(code: "io", primitive: "manifest",
                message: "manifest.json violates schemaVersion 1 shape")
        }
        self.id = id
        self.required = required
        guard id == Self.caller else {
            throw GatewayError(code: "io", primitive: "manifest",
                message: "unexpected caller identity \(id)")
        }
    }

    /// Permission-flag grammar: `<name>` or `<name>@<major>` — the caller
    /// holds the flag when any required entry names the primitive exactly or
    /// with a major suffix.
    func grants(primitive: String) -> Bool {
        required.contains { $0 == primitive || $0.hasPrefix(primitive + "@") }
    }
}

/// The capability gateway core: dispatch table name→handler, permission
/// enforcement against the manifest, and the mandatory structured audit of
/// primitives.md §6 — one record per call, never payload contents. Audit
/// lines use their own stdout prefix ("dsh.gateway.audit: ") so the
/// canonical "dsh.spike.log: " E2E stream stays one-to-one.
final class GatewayCore {
    /// The nine frozen primitives (contract/primitives.md §2).
    static let primitives = [
        "fsRead", "fsWrite", "fsScope", "httpFetch", "notify",
        "presentApproval", "presentPicker", "keychainGet", "keychainSet",
    ]
    static let auditPrefix = "dsh.gateway.audit: "

    let manifest: GatewayManifest
    private let workQueue = DispatchQueue(label: "org.dsh.gateway.work")
    private var handlers: [String: GatewayHandler] = [:]
    private let auditLock = NSLock()

    /// Wired by the session; each hops onto the runtime thread (the only
    /// thread allowed to touch the C runtime).
    var settle: ((Int, Bool, String) -> Void)?
    var emit: ((String) -> Void)?

    init(bundleRoot: URL) throws {
        manifest = try GatewayManifest(bundleRoot: bundleRoot)
    }

    func register(name: String, _ handler: @escaping GatewayHandler) {
        handlers[name] = handler
    }

    /// Entry point of the frozen bridge's on_call — invoked ON THE RUNTIME
    /// THREAD. Unknown or ungranted primitives settle denied with a "denied"
    /// audit verdict; granted calls run their handler off-thread.
    func dispatch(callId: Int, name: String, argsJSON: String) {
        if name == "httpFetch.abort" { return dispatchAbort(callId, argsJSON) }
        let base = name.split(separator: ".").first.map(String.init) ?? name
        guard let handler = handlers[name], manifest.grants(primitive: base) else {
            audit(primitive: name, verdict: "denied", outcome: "denied")
            let message = "primitive not granted to \(manifest.id)"
            let error = GatewayError(code: "denied", primitive: name, message: message)
            settle?(callId, false, Self.errorJSON(error))
            return
        }
        guard let data = argsJSON.data(using: .utf8),
              let args = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else {
            audit(primitive: name, verdict: "granted", outcome: "invalid")
            let error = GatewayError(
                code: "invalid", primitive: name, message: "args JSON unparseable")
            settle?(callId, false, Self.errorJSON(error))
            return
        }
        let call = GatewayCall(callId: callId, args: args)
        dispatchGranted(callId: callId, name: name, handler: handler, args: call)
    }

    /// Runs the handler on the work queue; the completion re-enters here for
    /// audit + the settle hop back onto the runtime queue.
    private func dispatchGranted(
        callId: Int, name: String, handler: @escaping GatewayHandler,
        args: GatewayCall
    ) {
        let done: GatewayDone = { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let payload):
                self.audit(primitive: name, verdict: "granted", outcome: "ok")
                self.settle?(callId, true, Self.encode(payload))
            case .failure(let error):
                self.audit(primitive: name, verdict: "granted", outcome: error.code)
                self.settle?(callId, false, Self.errorJSON(error))
            }
        }
        workQueue.async { handler(args, done) }
    }

    /// Control-plane call of the frozen bridge: JS global __dshGatewayAbort
    /// arrives as on_call with name "httpFetch.abort", args {"callId":N}.
    /// The handler parses the target (number or "body:<callId>" string).
    /// Fire-and-forget: the C side assigns abort on_calls no pending call
    /// id, so — unlike primitives — they are audited but never settled.
    private func dispatchAbort(_ callId: Int, _ argsJSON: String) {
        let args = (try? JSONSerialization.jsonObject(with: Data(argsJSON.utf8)))
            as? [String: Any]
        handlers["httpFetch.abort"]?(GatewayCall(callId: -1, args: args ?? [:]), { _ in })
        audit(primitive: "httpFetch.abort", verdict: "granted", outcome: "ok")
    }

    // ---- audit (mandatory, host-fixed, never payload contents) -------------

    func audit(primitive: String, verdict: String, outcome: String) {
        let record: [String: Any] = [
            "ts": Self.isoNow(),
            "primitive": primitive,
            "caller": manifest.id,
            "verdict": verdict,
            "outcome": outcome,
        ]
        guard let line = Self.jsonLine(record) else { return }
        auditLock.lock()
        print(Self.auditPrefix + line)
        fflush(stdout)
        NSLog("%@", Self.auditPrefix + line)
        auditLock.unlock()
    }

    // ---- shared JSON helpers ------------------------------------------------

    static func errorJSON(_ error: GatewayError) -> String {
        let obj: [String: Any] = [
            "code": error.code, "primitive": error.primitive, "message": error.message,
        ]
        return jsonLine(obj) ?? "{}"
    }

    static func encode(_ payload: Any) -> String { jsonLine(payload) ?? "null" }

    static func jsonLine(_ obj: Any) -> String? {
        guard JSONSerialization.isValidJSONObject(obj) || obj is NSNull else { return nil }
        if obj is NSNull { return "null" }
        guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func isoNow(_ date: Date = Date()) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: date)
    }

    /// stdout automation marker (NOT the canonical stream) for the E2E
    /// driver: "spike: ui-wait <name>" before an automatable surface,
    /// "spike: ui-done <name>" once it resolves.
    static func uiMarker(_ name: String, _ phase: String) {
        print("spike: ui-\(phase) \(name)")
        fflush(stdout)
    }
}
