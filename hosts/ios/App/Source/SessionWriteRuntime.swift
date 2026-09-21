import Foundation
import WebKit

/// Drives `b4.write.live` (the W-RPC leg, decision D9): the upstream spine
/// answers the OFFICIAL app's WRITE surface. The web-boot producer is
/// composed WITH the write surface (upstream/web-write.js — real
/// session/create, prompt admission, the session/follow + workspace/follow
/// streams, the settings describe), and the page's own composer message —
/// typed through the real UI by the probe — drives a REAL upstream
/// agent-loop turn: user/message → agent-loop events → assistant deltas →
/// turn/end, streamed live over the mux journal and rendered in the
/// official UI. The llm transport stays the carrier's SCRIPTED
/// chat-completions endpoint (real HTTP + SSE; the model output is the only
/// scripted part, logged as such). Endpoints the spine does not implement
/// stay structured-unavailable, never faked.
final class SessionWriteRuntime {
    static let scenario = "b4.write.live"
    static let clientID = "dsh-web-official"
    static let watchdogSeconds = 180

    private let server = CarrierServer()
    private let eventLog = CarrierEventLog(scenario: SessionWriteRuntime.scenario)
    private var bridge: CarrierAPIBridge?
    private var dist: CarrierWebDist?
    private var plugins: CarrierPlugins?
    private weak var webView: WKWebView?
    private var completion: ((SpikeOutcome) -> Void)?
    private var watchdog: DispatchWorkItem?
    private var finished = false
    private var token = ""
    private var origin: URL?
    private var sessionWrite: WebBootRuntimeDrive?

    /// Main-thread callback carrying the loopback origin (token included).
    var onOpenOrigin: ((URL) -> Void)?

    func attach(webView: WKWebView) {
        self.webView = webView
    }

    func run(completion: @escaping (SpikeOutcome) -> Void) {
        self.completion = completion
        armWatchdog()
        do {
            try startCarrier()
        } catch {
            finish(failOutcome("session-write bootstrap: \(error)"))
        }
    }

    // ---- carrier + runtime composition ---------------------------------------

    /// Builds the route table (official dist fallback + /plugins + /api +
    /// the scripted llm endpoint), starts listening, and boots the runtime
    /// half once the port is bound (its runtime.config needs the port).
    private func startCarrier() throws {
        let root = try SpikeBundleStager.stage()
        let distRoot = try OfficialWebRuntime.locateDist()
        token = OfficialWebRuntime.randomToken()
        let plugins = CarrierPlugins.staged(spikeRoot: root)
        let config = CarrierBootConfig.default(plugins: plugins)
        comboURL = OfficialWebRuntime.batchURL(graphJSON: config.bootGraphJSON)
        let dist = CarrierWebDist(
            distRoot: distRoot, sessionToken: token,
            indexRows: { [weak self] in self?.runtimeRows() ?? config.rows() }
        )
        let bridge = CarrierAPIBridge(sessionToken: token)
        eventLog.emit("client.selected", ["client": Self.clientID, "source": "launch"])
        wireEvidence(dist: dist, plugins: plugins, bridge: bridge)
        try server.registerFallback(handler: dist.handler)
        try server.register(kind: .prefix, path: "/plugins", handler: plugins.handler)
        try bridge.install(on: server)
        try server.registerScriptedLlm()
        server.onWSFrame = { [weak bridge] text, path in
            bridge?.ingestFrame(text, path: path)
        }
        self.dist = dist
        self.bridge = bridge
        self.plugins = plugins
        bridge.deliverToRuntime = { [weak self] msg in
            self?.sessionWrite?.deliverRuntime(msg)
        }
        try server.start { [weak self] in
            guard let self, self.server.port != 0 else { return }
            self.startRuntime(bundleRoot: root)
        }
    }

    /// Evidence hooks (once-guards: the UI's later calls are wire traffic,
    /// served the same way without another evidence line).
    private func wireEvidence(
        dist: CarrierWebDist, plugins: CarrierPlugins, bridge: CarrierAPIBridge
    ) {
        dist.onIndexRendered = { [weak self] rows, bytes in
            self?.eventLog.emit("index.rendered", ["rows": rows, "bytes": bytes])
        }
        dist.onIndexServed = { [weak self] in
            self?.eventLog.emit("index.served", ["path": "/", "status": 200])
        }
        dist.onAssetServed = { [weak self] path in
            self?.observeAsset(path)
        }
        plugins.onComboServed = { [weak self] url, bytes in
            self?.observeCombo(url, bytes: bytes)
        }
        bridge.onUpgradeAccepted = { [weak self] path in
            guard let self, !self.upgradeLogged else { return }
            self.upgradeLogged = true
            self.eventLog.emit("upgrade.accepted", ["path": path])
        }
        bridge.onAPICall = { [weak self] endpoint, answered in
            self?.observeRPC(endpoint, answered)
        }
        bridge.onMuxFrame = { [weak self] direction, kind in
            self?.observeMuxFrame(direction, kind)
        }
    }

    // ---- bus seam (runtime → carrier claims + answers) ------------------------

    /// Called from the drive (runtime thread) per JS → host bus message:
    /// folds the runtime's claims and answers into the bridge.
    private func runtimeBusPosted(_ msg: [String: Any]) {
        guard !finished else { return }
        switch msg["type"] as? String {
        case "web.boot":
            guard let rows = msg["rows"] as? [[String: Any]] else { return }
            webBootRows = rows
            if let graph = msg["graph"] as? [String: Any] {
                comboURL = OfficialWebRuntime.batchURL(graph: graph) ?? comboURL
            }
            if let pluginRows = msg["plugins"] as? [[String: Any]] {
                plugins?.applyRuntimeRevs(pluginRows)
            }
            runtimeBootApplied = true
            eventLog.emit("web.boot.applied", [
                "rows": runtimeRows().count,
                "source": "runtime (spine + vendored @deepseek-ai/dsh-client-modules)",
            ])
            maybeOpenOrigin()
        case "api.claim":
            bridge?.claim(endpoints: msg["endpoints"] as? [String] ?? [])
        case "mux.claim":
            bridge?.claimMux()
        case "api.respond":
            guard let rpcId = msg["rpcId"] as? String,
                  let result = msg["result"] as? [String: Any] else { return }
            bridge?.respondAPI(rpcId: rpcId, result: result)
        case "mux.item", "mux.error", "mux.end":
            deliverMuxFrame(msg)
        default:
            break
        }
    }

    /// One mux frame from the runtime → the bridge toward the page.
    private func deliverMuxFrame(_ msg: [String: Any]) {
        guard let streamId = msg["streamId"] as? String else { return }
        switch msg["type"] as? String {
        case "mux.item":
            guard let value = msg["value"] as? [String: Any] else { return }
            bridge?.muxItem(streamId: streamId, value: value)
        case "mux.error":
            let code = msg["code"] as? String ?? "gateway/unavailable"
            let details = msg["details"] as? [String: Any] ?? [:]
            let message = msg["message"] as? String ?? ""
            bridge?.muxError(streamId: streamId, code: code, message: message, details: details)
        default:
            bridge?.muxEnd(streamId: streamId)
        }
    }

    /// rpc.observed: the FIRST call of each distinct endpoint.
    private func observeRPC(_ endpoint: String, _ answered: String) {
        guard !rpcLogged.contains(endpoint) else { return }
        rpcLogged.insert(endpoint)
        eventLog.emit("rpc.observed", ["endpoint": endpoint, "answered": answered])
    }

    /// The first tx item frame line for the journal leg.
    private func observeMuxFrame(_ direction: String, _ kind: String) {
        guard direction == "tx", kind == "item", !frameLogged else { return }
        frameLogged = true
        eventLog.emit("journal.frame.forwarded", [
            "direction": "tx", "first": true,
            "source": "REAL session log records + assistant-stream frames",
        ])
    }

    // ---- page lifecycle + probe -----------------------------------------------

    private var assetLogged = false
    private var comboLogged = false
    private var comboPending: (String, Int)?
    private var upgradeLogged = false
    private var frameLogged = false
    private var rpcLogged: Set<String> = []
    /// The runtime graph's application batch URL (the probe fetches it).
    private var comboURL = ""
    /// Boot rows received from the runtime (`web.boot`), nil until then.
    private var webBootRows: [[String: Any]]?
    private var runtimeBootApplied = false

    /// The injection rows the index renders: the runtime's `web.boot` rows
    /// once received (plus the recovery global), else the carrier defaults.
    private func runtimeRows() -> [CarrierIndexInjection] {
        guard let rows = webBootRows else { return [] }
        var out = rows.compactMap { OfficialWebRuntime.injectionRow($0) }
        out.append(CarrierIndexInjection(kind: .global(
            name: "__DSH_CONNECTION_RECOVERY__",
            value: CarrierIndexInjection.jsonGlobalValue(
                "{\"backoffBaseMs\":500,\"backoffFactor\":2,\"backoffMaxMs\":10000,"
                    + "\"generationReadyWarnMs\":3000,\"generationReadyTimeoutMs\":15000}"))))
        return out
    }

    private func observeAsset(_ path: String) {
        guard path.hasPrefix("/assets/index-"), !assetLogged else { return }
        assetLogged = true
        eventLog.emit("asset.served", ["path": path])
        guard let combo = comboPending, !comboLogged else { return }
        comboLogged = true
        eventLog.emit("plugins.served", ["path": combo.0, "bytes": combo.1])
    }

    private func observeCombo(_ url: String, bytes: Int) {
        guard !comboLogged else { return }
        guard assetLogged else {
            comboPending = (url, bytes)
            return
        }
        comboLogged = true
        eventLog.emit("plugins.served", ["path": url, "bytes": bytes])
    }

    /// Starts the b4 runtime half: gateway wired (fs scope + httpFetch), the
    /// scripted llm endpoint facts ride runtime.config (the port is bound).
    private func startRuntime(bundleRoot: URL) {
        let drive = WebBootRuntimeDrive()
        drive.onBusPost = { [weak self] msg in
            self?.runtimeBusPosted(msg)
        }
        drive.onFailure = { [weak self] message in
            self?.finish(self?.failOutcome(message) ?? SpikeOutcome(
                completed: false, passed: false, error: message, canonicalLines: []))
        }
        drive.onComplete = { [weak self] passed, message in
            guard let self, !passed else { return }
            self.finish(self.failOutcome("runtime scenario failed: \(message)"))
        }
        sessionWrite = drive
        drive.start(
            bundleRoot: bundleRoot,
            plugins: WebBootRuntimeDrive.webPluginsDelivery(),
            config: ["type": "runtime.config",
                     "mockLlmUrl": "http://127.0.0.1:\(server.port)/mock-llm",
                     "apiKey": CarrierServer.mockLlmKey,
                     "containerRoot": bundleRoot.path],
            scenario: dsh_spike_res_scenario_b4_web_live_js,
            scenarioPath: "scenario/b4-web-live.js",
            gateway: true)
    }

    private func maybeOpenOrigin() {
        guard runtimeBootApplied, server.port != 0 else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.finished, self.origin == nil,
                  self.runtimeBootApplied, self.server.port != 0,
                  let origin = URL(string: "http://127.0.0.1:\(self.server.port)/?token=\(self.token)")
            else { return }
            self.origin = origin
            self.onOpenOrigin?(origin)
        }
    }

    /// The document finished loading: wait for the entry-chunk evidence,
    /// then run the write probe phases in order (pick → type → send).
    func pageDidFinish() {
        guard !finished else { return }
        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            let deadline = Date().addingTimeInterval(30)
            while !self.assetLogged && Date() < deadline {
                Thread.sleep(forTimeInterval: 0.1)
            }
            guard self.assetLogged else {
                return self.finish(self.failOutcome(
                    "session-write: the entry chunk never arrived"))
            }
            self.runProbe()
        }
    }

    private func runProbe() {
        guard let webView else {
            return finish(failOutcome("session-write: no WebView attached"))
        }
        SessionWriteProbe.evaluate(webView, SessionWriteProbe.probeScript()) { [weak self] _, error in
            guard let self else { return }
            if let error {
                return self.finish(self.failOutcome("probe setup: \(error)"))
            }
            self.runSteps(Self.probeSteps(self))
        }
    }

    /// The ordered write-path steps: pick the workspace, type into the
    /// composer, send — each collector emits its evidence event.
    private static func probeSteps(_ owner: SessionWriteRuntime)
        -> [(expr: String, collect: ([String: Any]) -> Void)] {
        let message = SessionWriteProbe.messageText
        return [
            ("window.__b4.pick()", { probe in
                owner.eventLog.emit("workspace.picked", [
                    "composer": probe["composer"] ?? false,
                    "dismissed": probe["dismissed"] ?? 0,
                    "notice": probe["notice"] ?? false,
                    "buttons": probe["buttonTexts"] ?? [],
                    "bodyText": probe["bodyText"] as? String ?? "",
                ])
            }),
            ("window.__b4.type('\(message)')", { probe in
                owner.eventLog.emit("composer.typed", [
                    "found": probe["found"] ?? "none",
                    "className": probe["className"] ?? "",
                    "editable": probe["editable"] ?? false,
                    "value": probe["value"] ?? "",
                    "text": message,
                    "buttons": probe["buttons"] ?? [],
                    "active": probe["active"] ?? "none",
                ])
            }),
            ("window.__b4.send()", { probe in
                owner.consumeSend(probe)
            }),
        ]
    }

    /// Await the head step's page function, parse its JSON, emit its event,
    /// advance — fail-loud on any unparseable leg (never a silent skip).
    private func runSteps(_ steps: [(expr: String, collect: ([String: Any]) -> Void)]) {
        guard let step = steps.first else {
            return finish(failOutcome("probe steps ran out without a verdict"))
        }
        guard let webView else {
            return finish(failOutcome("session-write: no WebView attached"))
        }
        SessionWriteProbe.awaitPromise(webView, step.expr) { [weak self] result, error in
            guard let self else { return }
            if let error {
                return self.finish(self.failOutcome("probe \(step.expr): \(error)"))
            }
            guard let probe = SessionWriteProbe.parse(result) else {
                let raw = result as? String ?? "nil"
                return self.finish(self.failOutcome(
                    "probe \(step.expr) returned no parseable result: \(raw)"))
            }
            step.collect(probe)
            guard steps.count > 1 else { return }
            self.runSteps(Array(steps.dropFirst()))
        }
    }

    /// The send leg's verdict: the official DOM must show the typed user
    /// message AND the scripted assistant reply.
    private func consumeSend(_ probe: [String: Any]) {
        guard (probe["sent"] as? Bool) == true else {
            return finish(failOutcome("probe send never fired"))
        }
        let page = probe["page"] as? [String: Any] ?? [:]
        let shapes = probe["frameShapes"] as? [String] ?? []
        eventLog.emit("write.follow.frames", [
            "frames": probe["frames"] ?? 0,
            "shapes": shapes,
            "sessionId": probe["sessionId"] ?? "",
        ])
        guard (probe["reply"] as? Bool) == true else {
            return finish(failOutcome(
                "the assistant reply never rendered; frames: \(shapes.count); bodyText: "
                    + "\((page["bodyText"] as? String ?? "").prefix(200))"))
        }
        eventLog.emit("write.reply.rendered", [
            "reply": SessionWriteProbe.expectedReply,
            "userText": SessionWriteProbe.messageText,
            "moduleMode": "live",
            "bodyText": (page["bodyText"] as? String ?? "")
                .replacingOccurrences(of: "\n", with: " "),
        ])
        finish(SpikeOutcome(
            completed: true, passed: true, error: "",
            canonicalLines: eventLog.lines
        ))
    }

    // ---- settling ---------------------------------------------------------------

    private func armWatchdog() {
        let item = DispatchWorkItem { [weak self] in
            guard let self, !self.finished else { return }
            self.finish(self.failOutcome(
                "session-write watchdog: drive did not complete in \(Self.watchdogSeconds)s"))
        }
        watchdog = item
        DispatchQueue.global().asyncAfter(
            deadline: .now() + .seconds(Self.watchdogSeconds), execute: item)
    }

    private func failOutcome(_ message: String) -> SpikeOutcome {
        print("spike: session-write FAIL \(message)")
        fflush(stdout)
        NSLog("%@", "spike: session-write FAIL \(message)")
        return SpikeOutcome(
            completed: false, passed: false, error: message,
            canonicalLines: eventLog.lines
        )
    }

    private func finish(_ outcome: SpikeOutcome) {
        guard !finished else { return }
        finished = true
        watchdog?.cancel()
        server.stop()
        print("spike: session-write drive finished verdict=\(outcome.verdict)")
        fflush(stdout)
        sessionWrite?.stop()
        DispatchQueue.main.async { [weak self] in
            self?.completion?(outcome)
            self?.completion = nil
        }
    }
}
