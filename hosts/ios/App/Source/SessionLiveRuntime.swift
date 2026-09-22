import Foundation
import WebKit

/// Drives `session.live-read` (the W-SESS leg, decision D9): the FULL upstream
/// agent spine boots ON-DEVICE (upstream/boot.js over the vendored closure —
/// ctx.sessions / agents / agentLoop / tools / systemPrompt / projections /
/// settings + the vendored dsh-llm LlmRuntime whose transport is the REAL
/// gateway httpFetch against the carrier's SCRIPTED chat-completions
/// endpoint), and the official web boot wire is composed on the SAME
/// runtime context. The runtime CLAIMS `/api/session.list` and the mux
/// `session/journal` streams over the bus seam (api.claim → bridge →
/// api.request → ctx.sessions → api.respond; mux.open → REAL journal
/// attach), so the official UI's boot passes the session attach leg with
/// REAL data: one real scripted-llm turn BEFORE the page loads (the journal
/// baseline) and one streamed LIVE into the attached page after it. The
/// probe drives the read path through the official envelope; the honest
/// surface boundary is frozen in the manifest — endpoints the spine does
/// not implement stay structured-unavailable, never faked.
final class SessionLiveRuntime {
    static let scenario = "session.live-read"
    static let clientID = "dsh-web-official"
    static let watchdogSeconds = 150

    private let server = CarrierServer()
    private let eventLog = CarrierEventLog(scenario: SessionLiveRuntime.scenario)
    private var bridge: CarrierAPIBridge?
    private var dist: CarrierWebDist?
    private var plugins: CarrierPlugins?
    private weak var webView: WKWebView?
    private var completion: ((SpikeOutcome) -> Void)?
    private var watchdog: DispatchWorkItem?
    private var finished = false
    private var token = ""
    private var origin: URL?
    private var sessionLive: WebBootRuntimeDrive?

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
            finish(failOutcome("session-live bootstrap: \(error)"))
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
        // The claimed-surface seam: forwarded api.request / mux.open frames
        // hop onto the runtime thread (§3.5 of the webserver contract).
        bridge.deliverToRuntime = { [weak self] msg in
            self?.sessionLive?.deliverRuntime(msg)
        }
        try server.start { [weak self] in
            guard let self, self.server.port != 0 else { return }
            self.startRuntime(bundleRoot: root)
        }
    }

    /// Evidence hooks. Unlike b1 the runtime CLAIMS endpoints, so every
    /// hook carries a once-guard: the manifest pins the FIRST event of each
    /// kind (the UI's own later calls are wire traffic, not scenario
    /// evidence — they are served, not logged).
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
        bridge.onMuxOpen = { [weak self] streamId, endpoint in
            self?.observeMuxOpen(streamId, endpoint)
        }
        bridge.onMuxFrame = { [weak self] direction, kind in
            self?.observeMuxFrame(direction, kind)
        }
    }

    // ---- bus seam (runtime → carrier claims + answers) ------------------------

    /// Called from the drive (runtime thread) per JS → host bus message:
    /// the b3 protocol folds the runtime's claims and answers straight into
    /// the bridge (all bridge mutators hop to their own serial queue).
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
            observeRespond(result)
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

    /// The first REAL session.list answer through the seam (from the
    /// already-shaped ok envelope the runtime posted).
    private func observeRespond(_ result: [String: Any]) {
        guard (result["ok"] as? Bool) == true, !respondLogged,
              let value = result["value"] as? [String: Any],
              let items = value["items"] as? [[String: Any]] else { return }
        respondLogged = true
        eventLog.emit("session.list.responded", [
            "ok": true, "sessions": items.count,
            "source": "the on-device spine (ctx.sessions)",
        ])
    }

    /// rpc.observed: the FIRST call of each distinct endpoint (the UI and
    /// the probe both call the claimed surface; every later call is served
    /// the same way without another evidence line).
    private func observeRPC(_ endpoint: String, _ answered: String) {
        guard !rpcLogged.contains(endpoint) else { return }
        rpcLogged.insert(endpoint)
        eventLog.emit("rpc.observed", ["endpoint": endpoint, "answered": answered])
    }

    /// The first mux seat accept + the first journal open (whoever opens
    /// it — the UI's own attach or the probe's).
    private func observeMuxOpen(_ streamId: String, _ endpoint: String) {
        guard endpoint == "session/journal", !attachLogged else { return }
        attachLogged = true
        eventLog.emit("session.attached", ["streamId": streamId, "stream": endpoint])
    }

    /// One tx item frame line for the journal leg (once; the probe reports
    /// the full frame facts).
    private func observeMuxFrame(_ direction: String, _ kind: String) {
        guard direction == "tx", kind == "item", !frameLogged else { return }
        frameLogged = true
        eventLog.emit("journal.frame.forwarded", [
            "direction": "tx", "first": true,
            "source": "REAL session log records (baseline + live turn)",
        ])
    }

    // ---- page lifecycle + probe -----------------------------------------------

    /// once-guards for the single-emission hooks (server-queue-confined);
    /// `comboPending` holds an early combo arrival until the asset event
    /// fixed the report order.
    private var assetLogged = false
    private var comboLogged = false
    private var comboPending: (String, Int)?
    private var upgradeLogged = false
    private var attachLogged = false
    private var frameLogged = false
    private var respondLogged = false
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

    /// Starts the b3 runtime half: gateway wired (fs scope + httpFetch),
    /// the scripted llm endpoint facts ride runtime.config (the port is
    /// bound — called from the server's onReady).
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
        sessionLive = drive
        drive.start(
            bundleRoot: bundleRoot,
            plugins: WebBootRuntimeDrive.webPluginsDelivery(),
            config: ["type": "runtime.config",
                     "mockLlmUrl": "http://127.0.0.1:\(server.port)/mock-llm",
                     "apiKey": CarrierServer.mockLlmKey,
                     "containerRoot": bundleRoot.path],
            scenario: dsh_spike_res_scenario_b3_web_live_js,
            scenarioPath: "scenario/session-web-live.js",
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
    /// then run the same-origin probe and read the TRUE rendered state.
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
                    "session-live: the entry chunk never arrived"))
            }
            self.runProbe()
        }
    }

    private func runProbe() {
        guard let webView else {
            return finish(failOutcome("session-live: no WebView attached"))
        }
        SessionLiveProbe.evaluate(webView, SessionLiveProbe.probeScript()) { [weak self] _, error in
            guard let self else { return }
            if let error {
                return self.finish(self.failOutcome("probe setup: \(error)"))
            }
            SessionLiveProbe.awaitPromise(webView, "window.__b3Run()") { [weak self] result, error in
                guard let self else { return }
                if let error {
                    return self.finish(self.failOutcome("probe run: \(error)"))
                }
                self.consumeProbe(result as? String ?? "null")
            }
        }
    }

    private func consumeProbe(_ json: String) {
        switch SessionLiveProbe.verdict(json) {
        case .failure(let message):
            finish(failOutcome(message))
        case .pass(let events):
            for (event, fields) in events { eventLog.emit(event, fields) }
            finish(SpikeOutcome(
                completed: true, passed: true, error: "",
                canonicalLines: eventLog.lines
            ))
        }
    }

    // ---- settling ---------------------------------------------------------------

    private func armWatchdog() {
        let item = DispatchWorkItem { [weak self] in
            guard let self, !self.finished else { return }
            self.finish(self.failOutcome(
                "session-live watchdog: drive did not complete in \(Self.watchdogSeconds)s"))
        }
        watchdog = item
        DispatchQueue.global().asyncAfter(
            deadline: .now() + .seconds(Self.watchdogSeconds), execute: item)
    }

    private func failOutcome(_ message: String) -> SpikeOutcome {
        print("spike: session-live FAIL \(message)")
        fflush(stdout)
        NSLog("%@", "spike: session-live FAIL \(message)")
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
        print("spike: session-live drive finished verdict=\(outcome.verdict)")
        fflush(stdout)
        sessionLive?.stop()
        DispatchQueue.main.async { [weak self] in
            self?.completion?(outcome)
            self?.completion = nil
        }
    }
}
