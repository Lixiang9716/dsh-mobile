import Foundation
import UIKit

/// Drives the first ON-DEVICE session (`m2.session`): one C runtime session
/// on the dedicated RuntimeThread with the capability gateway bound, the
/// loopback carrier serving the ACTIVE Web Client plugin's web/ directory,
/// and the session projection pushed JS → bus → WS → page. The scenario
/// starts only when the Web Client is mounted AND connected (the host.info
/// readiness signal), so the token deltas stream live into the rendered
/// page. Carrier-side evidence is logged through the canonical
/// `dsh.spike.log:` envelope as scenario `m2.webclient.mount`.
final class SessionRuntime {
    static let entryModule = "scenario/m2-session.js"
    static let scenario = "m2.webclient.mount"
    static let watchdogSeconds = 120
    /// Host configuration: which Web Client plugin is ACTIVE (presentation/
    /// is pluggable; the host mounts exactly one). Overridable for E2E via
    /// launch argument `-dsh-web-client <id>`; the staged bundle carries the
    /// plugin under webclient/.
    static var activeWebClient: String = {
        let args = ProcessInfo.processInfo.arguments
        if let at = args.firstIndex(of: "-dsh-web-client"), at + 1 < args.count {
            return args[at + 1]
        }
        return "dsh-web-client"
    }()

    private let runtimeThread = RuntimeThread(name: "org.dsh.spike.session")
    private let server = CarrierServer()
    private let sink = SpikeLogSink()
    private var core: GatewayCore?
    private var host: OpaquePointer?
    private var watchdog: DispatchWorkItem?
    private var completion: ((SpikeOutcome) -> Void)?
    private var finished = false
    private var mountedLogged = false
    private var connectedLogged = false
    private var hostInfoDelivered = false
    /// Projection lines pushed so far (replay for late-connecting pages).
    private var projection: [String] = []
    private var firstDelta: Int?
    private var lastDelta: Int?

    /// Main-thread callback carrying the loopback origin once the carrier
    /// can serve the Web Client (the Presentation surface loads it here).
    var onOpenOrigin: ((URL) -> Void)?

    func run(completion: @escaping (SpikeOutcome) -> Void) {
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
            root = try SpikeBundleStager.stage()
            core = try GatewayCore(bundleRoot: root)
        } catch {
            return finish(failOutcome("session bootstrap: \(error)"))
        }
        wireCore()
        server.onWSMessage = { [weak self] text in self?.ingest(text) }
        server.onStaticServed = { [weak self] path in self?.webClientServed(path) }
        do {
            try server.start(webRoot: root.appendingPathComponent("webclient/web")) {
                [weak self] in
                self?.openOrigin()
            }
        } catch {
            return finish(failOutcome("session server: \(error)"))
        }
        var cSink = sink.cSink
        guard let host = dsh_spike_new(root.path, &cSink) else {
            return finish(failOutcome("dsh_spike_new returned NULL"))
        }
        self.host = host
        bindAndEval(host)
    }

    /// Full capability surface (same wiring as the gateway-binding phase):
    /// the session itself only exercises fs, and no native UI is presented
    /// because the scenario never calls the ui service.
    private func wireCore() {
        guard let core else { return }
        let fs = FSPrimitives()
        fs.register(on: core)
        _ = HTTPPrimitive(core: core)
        _ = KeychainPrimitives(core: core)
        UIPrimitives(core: core, fs: fs)
        let notify = NotifyPrimitive(core: core)
        _ = notify
        core.settle = { [weak self] callId, ok, json in
            self?.runtimeThread.async { self?.settle(callId: callId, ok: ok, json: json) }
        }
        core.emit = { [weak self] json in
            self?.runtimeThread.async { self?.emitJSON(json) }
        }
    }

    /// Descriptor before eval (frozen bridge order), then bus sink, gateway
    /// dispatch, entry eval, first pump, watchdog. host.info waits for the
    /// mounted + connected Web Client.
    private func bindAndEval(_ host: OpaquePointer) {
        dsh_spike_set_descriptor(host, Self.descriptorJSON)
        dsh_spike_set_bus_sink(host, { ud, line in
            guard let ud, let line else { return }
            let session = Unmanaged<SessionRuntime>.fromOpaque(ud).takeUnretainedValue()
            session.busPosted(String(cString: line))
        }, Unmanaged.passUnretained(self).toOpaque())
        dsh_spike_set_gateway_dispatch(host, { ud, callId, name, argsJSON in
            guard let ud, let name, let argsJSON else { return }
            let session = Unmanaged<SessionRuntime>.fromOpaque(ud).takeUnretainedValue()
            session.core?.dispatch(
                callId: Int(callId), name: String(cString: name),
                argsJSON: String(cString: argsJSON))
        }, Unmanaged.passUnretained(self).toOpaque())
        let source = String(cString: dsh_spike_res_scenario_m2_session_js(nil))
        if dsh_spike_eval(host, Self.entryModule, source) != 0 {
            return finish(failOutcome("eval: \(String(cString: dsh_spike_error(host)))"))
        }
        if dsh_spike_pump(host) != 0 {
            return finish(failOutcome("pump: \(String(cString: dsh_spike_error(host)))"))
        }
        armWatchdog()
    }

    // ---- Web Client mount + connection --------------------------------------

    /// Server queue: a static file of the ACTIVE Web Client was served. The
    /// document request is the mount evidence.
    private func webClientServed(_ path: String) {
        guard !mountedLogged, path == "/" || path.hasSuffix("index.html") else { return }
        mountedLogged = true
        carrierEvent("webclient.mounted", ["client": Self.activeWebClient, "path": "/index.html"])
    }

    /// Server queue: the page's WS hello. Marks the connection live, greets,
    /// replays any projection buffered pre-connect, and starts the session —
    /// the scenario's host.info arrives only now, so deltas stream live.
    private func ingest(_ text: String) {
        guard let payload = Self.parse(text) else { return }
        runtimeThread.async { [weak self] in
            guard let self, !self.finished else { return }
            if payload["type"] as? String == "hello" {
                self.pageHello(protocol: payload["protocol"] as? String)
            }
        }
    }

    /// Runtime queue only.
    private func pageHello(protocol wsProtocol: String?) {
        server.send(Self.jsonLine([
            "type": "ws.hello",
            "protocol": wsProtocol ?? "",
            "served": server.servedList(),
        ]) ?? "{}")
        server.send(Self.jsonLine([
            "type": "replay", "events": replayArray(),
        ]) ?? "{}")
        guard !connectedLogged else { return }
        connectedLogged = true
        carrierEvent("ws.connected", ["protocol": wsProtocol ?? "none"])
        deliverHostInfo()
    }

    private func openOrigin() {
        let port = Int(server.port)
        DispatchQueue.main.async { [weak self] in
            self?.onOpenOrigin?(URL(string: "http://127.0.0.1:\(port)/")!)
        }
    }

    /// Runtime queue only (frozen bridge: gateway_event is RUNTIME THREAD ONLY).
    private func deliverHostInfo() {
        guard !hostInfoDelivered, host != nil, server.port != 0 else { return }
        hostInfoDelivered = true
        emitJSON(GatewayCore.jsonLine(
            ["event": "host.info", "port": Int(server.port)]) ?? "{}")
    }

    // ---- session projection (JS → bus → WS) ----------------------------------

    /// Runtime queue, called from C: shuttle projection lines to the page and
    /// keep the carrier-side token-delta evidence current.
    private func busPosted(_ line: String) {
        guard !finished, host != nil, let msg = Self.parse(line),
              msg["type"] as? String == "ws.send", let payload = msg["payload"]
        else { return }
        guard let text = GatewayCore.jsonLine(payload) else { return }
        projection.append(text)
        server.send(text) // CarrierServer.send hops to its own queue
        if let kind = (payload as? [String: Any])?["kind"] as? String,
           kind == "token-delta",
           let index = (payload as? [String: Any])?["index"] as? Int {
            observeDelta(index)
        }
    }

    private func observeDelta(_ index: Int) {
        if firstDelta == nil {
            firstDelta = index
            carrierEvent("ws.token-delta", ["first": true, "index": index])
        }
        lastDelta = index
    }

    /// The replay payload for a (re)connecting page: every projection line
    /// pushed so far, parsed back as JSON values.
    private func replayArray() -> [[String: Any]] {
        projection.compactMap { Self.parse($0) }
    }

    // ---- runtime-queue settle/emit + watchdog + finish ------------------------

    private func settle(callId: Int, ok: Bool, json: String) {
        guard let host, !finished else { return }
        if dsh_spike_gateway_settle(host, Int32(callId), ok ? 1 : 0, json) != 0 {
            return finish(failOutcome(
                "gateway settle: \(String(cString: dsh_spike_error(host)))"))
        }
        settleCheck("settle")
    }

    private func emitJSON(_ json: String) {
        guard let host, !finished else { return }
        if dsh_spike_gateway_event(host, json) != 0 {
            return finish(failOutcome(
                "gateway event: \(String(cString: dsh_spike_error(host)))"))
        }
        settleCheck("event")
    }

    private func settleCheck(_ what: String) {
        guard let host, !finished else { return }
        if dsh_spike_pump(host) != 0 {
            return finish(failOutcome(
                "pump after \(what): \(String(cString: dsh_spike_error(host)))"))
        }
        if dsh_spike_complete(host) != 0 {
            finish(SpikeOutcome(
                completed: true, passed: dsh_spike_pass(host) != 0,
                error: "", canonicalLines: sink.lines))
        }
    }

    private func armWatchdog() {
        let message = "session watchdog: scenario did not complete in "
            + "\(Self.watchdogSeconds)s"
        let item = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.runtimeThread.async { [weak self] in
                guard let self, !self.finished else { return }
                self.finish(self.failOutcome(message))
            }
        }
        watchdog = item
        DispatchQueue.global().asyncAfter(
            deadline: .now() + .seconds(Self.watchdogSeconds), execute: item)
    }

    private func finish(_ outcome: SpikeOutcome) {
        guard !finished else { return }
        finished = true
        watchdog?.cancel()
        if outcome.completed, outcome.passed {
            logSessionEvidence()
        }
        dsh_spike_free(host)
        host = nil
        server.stop()
        print("spike: session drive finished verdict=\(outcome.verdict)")
        fflush(stdout)
        runtimeThread.async { [weak self] in self?.runtimeThread.stop() }
        DispatchQueue.main.async { [weak self] in
            self?.completion?(outcome)
            self?.completion = nil
        }
    }

    private func failOutcome(_ message: String) -> SpikeOutcome {
        print("spike: session FAIL \(message)")
        fflush(stdout)
        NSLog("%@", "spike: session FAIL \(message)")
        return SpikeOutcome(
            completed: false, passed: false, error: message, canonicalLines: sink.lines)
    }

    /// Terminal carrier-side evidence: the last streamed delta and the
    /// session-complete marker (runtime queue, before the outcome settles).
    private func logSessionEvidence() {
        let lastIndex = lastDelta ?? -1
        carrierEvent("ws.token-delta",
                     ["first": false, "last": true, "index": lastIndex])
        carrierEvent("ws.session-complete", ["status": "pass"])
    }

    // ---- carrier-side canonical evidence --------------------------------------

    /// One E2E record in the canonical envelope (`dsh.spike.log:` prefix,
    /// unified-logger shape) so the carrier's own mount/connection events
    /// ride the same checker stream as the JS scenario's.
    private func carrierEvent(_ event: String, _ fields: [String: Any]) {
        var payload: [String: Any] = ["scenario": Self.scenario, "event": event]
        fields.forEach { payload[$0.key] = $0.value }
        guard let data = GatewayCore.jsonLine([
            "level": "info", "module": "dsh.carrier", "message": "e2e",
            "data": [payload],
        ]) else { return }
        print(SpikeLogSink.prefix + data)
        fflush(stdout)
    }

    /// RuntimeDescriptor pre-eval: the full nine-primitive surface.
    private static let descriptorJSON: String = {
        GatewayCore.jsonLine([
            "available": GatewayCore.primitives,
            "unavailable": [],
        ]) ?? "{}"
    }()

    private static func parse(_ text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private static func jsonLine(_ obj: Any) -> String? { GatewayCore.jsonLine(obj) }
}
