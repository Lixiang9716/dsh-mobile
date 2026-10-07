import Foundation
import UIKit

/// Drives the m2 gateway-binding phase, modeled on CarrierRuntime: one C
/// runtime session on a dedicated RuntimeThread with the REAL capability
/// gateway bound through the frozen bridge — descriptor before eval, gateway
/// dispatch for on_call, settle/event hops back onto the runtime queue —
/// plus the loopback carrier in front (the WS page pump stays live). The
/// outcome settles exactly once: scenario completion or watchdog (180s;
/// the UI choreography takes time). JS runs ONLY on the runtime thread;
/// primitive handlers run off it; nothing blocks (ARCHITECTURE.md §6).
final class GatewaySession {
    static let defaultEntry = "scenario/gateway-binding.js"
    static let watchdogSeconds = 180

    /// The entry module + its embedded source (a generated
    /// dsh_runtime_res_* accessor). Defaults keep the m2 gateway-binding drive.
    private let entryModule: String
    private let sourceProvider: () -> String

    /// The BLE face's radio (nil = the real CoreBluetooth radio; the
    /// ble-plane-mock drive passes the deterministic mock).
    private let bleRadio: BleRadio?

    init(
        entryModule: String = GatewaySession.defaultEntry,
        sourceProvider: @escaping () -> String = {
            String(cString: dsh_runtime_res_scenario_m2_js(nil))
        },
        bleRadio: BleRadio? = nil
    ) {
        self.entryModule = entryModule
        self.sourceProvider = sourceProvider
        self.bleRadio = bleRadio
    }

    private let runtimeThread = RuntimeThread(name: "org.dsh.rt.gateway")
    private let server = CarrierServer()
    private let sink = RuntimeLogSink()
    private var core: GatewayCore?
    private var notifyPrimitive: NotifyPrimitive?
    private var host: OpaquePointer?
    private var watchdog: DispatchWorkItem?
    private var completion: ((JsOutcome) -> Void)?
    private var finished = false
    private var hostInfoDelivered = false
    private var stateObservers: [NSObjectProtocol] = []

    func run(completion: @escaping (JsOutcome) -> Void) {
        runtimeThread.start()
        runtimeThread.async { [self] in
            self.completion = completion
            self.startSession()
        }
    }

    // ---- session setup (runtime thread) ------------------------------------

    private func startSession() {
        let root: URL
        do {
            root = try BundleStager.stage()
            try Self.stageE2ETarget()
            core = try GatewayCore(bundleRoot: root)
        } catch {
            return finish(failOutcome("gateway bootstrap: \(error)"))
        }
        wireCore()
        server.onWSMessage = { [weak self] text in self?.ingest(text) }
        do {
            try server.installLegacyRoutes(webRoot: root.appendingPathComponent("web"))
            try server.start { [weak self] in
                self?.runtimeThread.async { self?.deliverHostInfo() }
            }
        } catch {
            return finish(failOutcome("gateway server: \(error)"))
        }
        var cSink = sink.cSink
        guard let host = dsh_runtime_new(root.path, &cSink) else {
            return finish(failOutcome("dsh_runtime_new returned NULL"))
        }
        self.host = host
        bindAndEval(host)
    }

    /// Descriptor before eval (frozen bridge order), then the bus seam, the
    /// gateway dispatch, the entry eval, and the first pump.
    private func bindAndEval(_ host: OpaquePointer) {
        dsh_runtime_set_descriptor(host, Self.descriptorJSON)
        dsh_runtime_set_bus_sink(host, { ud, line in
            guard let ud, let line else { return }
            let session = Unmanaged<GatewaySession>.fromOpaque(ud).takeUnretainedValue()
            session.busPosted(String(cString: line))
        }, Unmanaged.passUnretained(self).toOpaque())
        dsh_runtime_set_gateway_dispatch(host, { ud, callId, name, argsJSON in
            guard let ud, let name, let argsJSON else { return }
            let session = Unmanaged<GatewaySession>.fromOpaque(ud).takeUnretainedValue()
            session.gatewayCall(
                callId: Int(callId), name: String(cString: name),
                argsJSON: String(cString: argsJSON))
        }, Unmanaged.passUnretained(self).toOpaque())
        if dsh_runtime_eval(host, entryModule, sourceProvider()) != 0 {
            return finish(failOutcome("eval: \(String(cString: dsh_runtime_error(host)))"))
        }
        if dsh_runtime_pump(host) != 0 {
            return finish(failOutcome("pump: \(String(cString: dsh_runtime_error(host)))"))
        }
        observeAppState()
        deliverHostInfo()
        armWatchdog()
    }

    /// Wires the full serving table and the runtime-queue hops. All primitive
    /// instances stay alive through the registered closures; the notify
    /// primitive needs a stored ref (the center's delegate is weak).
    private func wireCore() {
        guard let core else { return }
        notifyPrimitive = core.registerStandardPrimitives(bleRadio: bleRadio)
        core.settle = { [weak self] callId, ok, json in
            self?.runtimeThread.async { self?.settle(callId: callId, ok: ok, json: json) }
        }
        core.emit = { [weak self] json in
            self?.runtimeThread.async { self?.emitJSON(json) }
        }
    }

    // ---- runtime-queue crossings ----------------------------------------------

    /// on_call entry (runtime thread, from C): parse + permission + off-thread
    /// execution all live in the core.
    private func gatewayCall(callId: Int, name: String, argsJSON: String) {
        guard !finished, let core else { return }
        core.dispatch(callId: callId, name: name, argsJSON: argsJSON)
    }

    /// Runtime queue only (frozen bridge: settle is RUNTIME THREAD ONLY).
    private func settle(callId: Int, ok: Bool, json: String) {
        guard let host, !finished else { return }
        let status = dsh_runtime_gateway_settle(host, Int32(callId), ok ? 1 : 0, json)
        if status != 0 {
            return finish(failOutcome(
                "gateway settle: \(String(cString: dsh_runtime_error(host)))"))
        }
        settleCheck("settle")
    }

    /// Runtime queue only (frozen bridge: gateway_event is RUNTIME THREAD ONLY).
    private func emitJSON(_ json: String) {
        guard let host, !finished else { return }
        if dsh_runtime_gateway_event(host, json) != 0 {
            return finish(failOutcome(
                "gateway event: \(String(cString: dsh_runtime_error(host)))"))
        }
        settleCheck("event")
    }

    /// After every settle/event: drain microtasks, then check completion.
    private func settleCheck(_ what: String) {
        guard let host, !finished else { return }
        if dsh_runtime_pump(host) != 0 {
            return finish(failOutcome(
                "pump after \(what): \(String(cString: dsh_runtime_error(host)))"))
        }
        if dsh_runtime_complete(host) != 0 {
            finish(JsOutcome(
                completed: true, passed: dsh_runtime_pass(host) != 0,
                error: "", canonicalLines: sink.lines))
        }
    }

    /// The scenario learns the loopback port through the gateway event
    /// channel ({"event":"host.info","port":N}) — once, when both the server
    /// and the runtime are live.
    private func deliverHostInfo() {
        guard !hostInfoDelivered, host != nil, server.port != 0 else { return }
        hostInfoDelivered = true
        emitJSON(GatewayCore.jsonLine(
            ["event": "host.info", "port": Int(server.port)]) ?? "{}")
    }

    // ---- WS page pump (kept alive from the m1 carrier patterns) ---------------

    private func busPosted(_ line: String) {
        guard !finished, host != nil, let msg = Self.parse(line) else { return }
        if msg["type"] as? String == "ws.send", let payload = msg["payload"],
           let text = GatewayCore.jsonLine(payload) {
            server.send(text) // CarrierServer.send hops to its own queue
        }
    }

    /// Called on the server queue; hops onto the runtime thread.
    private func ingest(_ text: String) {
        guard let payload = Self.parse(text) else { return }
        runtimeThread.async { [weak self] in
            guard let self, !self.finished else { return }
            if payload["type"] as? String == "hello" {
                self.emitBus([
                    "type": "ws.hello",
                    "href": payload["href"] ?? "",
                    "served": self.server.servedList(),
                ])
            } else {
                self.emitBus(["type": "ws.message", "payload": payload])
            }
        }
    }

    private func emitBus(_ obj: [String: Any]) {
        guard let line = GatewayCore.jsonLine(obj) else { return }
        emitJSON(line)
    }

    // ---- app.state lifecycle + watchdog + settling ------------------------------

    /// Main thread. Edges feed the notify primitive's app.state channel while
    /// this session is live; observers die with the session.
    private func observeAppState() {
        let center = NotificationCenter.default
        let background = center.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil, queue: .main
        ) { [weak self] _ in self?.notifyPrimitive?.appState("background") }
        let foreground = center.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil, queue: .main
        ) { [weak self] _ in self?.notifyPrimitive?.appState("foreground") }
        stateObservers = [background, foreground]
    }

    private func armWatchdog() {
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.runtimeThread.async { [weak self] in
                guard let self, !self.finished else { return }
                let message = "gateway watchdog: scenario did not complete in "
                    + "\(Self.watchdogSeconds)s"
                self.finish(self.failOutcome(message))
            }
        }
        watchdog = item
        DispatchQueue.global().asyncAfter(
            deadline: .now() + .seconds(Self.watchdogSeconds), execute: item)
    }

    private func finish(_ outcome: JsOutcome) {
        guard !finished else { return }
        finished = true
        watchdog?.cancel()
        DispatchQueue.main.async { [weak self] in self?.removeStateObservers() }
        dsh_runtime_free(host)
        host = nil
        server.stop()
        print("rt: gateway drive finished verdict=\(outcome.verdict)")
        fflush(stdout)
        runtimeThread.async { [weak self] in self?.runtimeThread.stop() }
        DispatchQueue.main.async { [weak self] in
            self?.completion?(outcome)
            self?.completion = nil
        }
    }

    private func removeStateObservers() {
        stateObservers.forEach(NotificationCenter.default.removeObserver)
        stateObservers = []
    }

    private func failOutcome(_ message: String) -> JsOutcome {
        print("rt: gateway FAIL \(message)")
        fflush(stdout)
        NSLog("%@", "rt: gateway FAIL \(message)")
        return JsOutcome(
            completed: false, passed: false, error: message, canonicalLines: sink.lines)
    }

    // ---- statics ------------------------------------------------------------

    /// The picker target for the live E2E: Documents/gateway-e2e/notes.txt
    /// (browsable via UIFileSharingEnabled).
    static func stageE2ETarget() throws {
        let documents = FileManager.default.urls(
            for: .documentDirectory, in: .userDomainMask)[0]
        let dir = documents.appendingPathComponent("gateway-e2e", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let target = dir.appendingPathComponent("notes.txt")
        // STAGE ONCE (run-ios.sh's recipe, mirrored app-side): rewriting the
        // target at EVERY launch knocked it out of the file-provider search
        // index right before the drive searched for it — measured 2026-09-30
        // (release regression final run): the launch rewrite invalidated the
        // index inside the picker's search window and the binding watchdog
        // starved at `ui-wait picker` (未找到相关结果), on a freshly erased
        // simulator with a settled copy. Only a MISSING target is created.
        guard !FileManager.default.fileExists(atPath: target.path) else { return }
        let notes = Data("gateway e2e target file — dsh-mobile m2\n".utf8)
        try notes.write(to: target)
    }

    /// RuntimeDescriptor pre-eval: the full serving table available, the
    /// capability plane's phased rows unavailable — the honest declaration
    /// (conformance §7, contract §1).
    private static let descriptorJSON: String = {
        GatewayCore.jsonLine([
            "available": GatewayCore.primitives,
            "unavailable": GatewayCore.phasedRows,
        ]) ?? "{}"
    }()

    private static func parse(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}
