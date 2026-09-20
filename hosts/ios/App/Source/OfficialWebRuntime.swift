import Foundation
import WebKit

/// Canonical E2E emitter for carrier-only drives: the same envelope as the
/// runtimes' carrierEvent (`dsh.spike.log:` prefix, unified-logger shape),
/// with retention for the outcome's canonicalLines. Serial queue: emission
/// order = call order across all caller queues.
final class CarrierEventLog {
    static let prefix = SpikeLogSink.prefix
    private(set) var lines: [String] = []
    private let queue = DispatchQueue(label: "org.dsh.carrier.eventlog")
    private let scenario: String

    init(scenario: String) {
        self.scenario = scenario
    }

    func emit(_ event: String, _ fields: [String: Any]) {
        queue.sync { [self] in
            guard let line = Self.envelope(scenario: scenario, event: event, fields: fields)
            else { return }
            lines.append(line)
            print(CarrierEventLog.prefix + line)
            fflush(stdout)
        }
    }

    /// The unified-logger envelope for one E2E record.
    private static func envelope(
        scenario: String, event: String, fields: [String: Any]
    ) -> String? {
        var payload: [String: Any] = ["scenario": scenario, "event": event]
        fields.forEach { payload[$0.key] = $0.value }
        let record: [String: Any] = [
            "level": "info", "module": "dsh.carrier", "message": "e2e", "data": [payload],
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: record) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

/// Drives `b1.official-web.mount`: the carrier as a REAL implementation of
/// the upstream `ctx.webServer` contract, mounting the OFFICIAL web app
/// (vendored dist, zero upstream edits) in the WebView — now with the
/// runtime live (W-INTEG): a spike session running the b1-web-live scenario
/// composes the OFFICIAL boot wire with the vendored client-modules node
/// half and posts `web.boot` over the bus seam; the carrier swaps the
/// delivered rows into the index render pipeline, overrides the /plugins
/// revs, and only then opens the origin, so the page's facade `create()`
/// materializes the REAL upstream browser bundle and boots the real client
/// module system. Wire evidence is carrier-side observation plus the
/// scenario's own structured records; the same-origin probe runs through
/// the WebView's own fetch/WebSocket. The rendered state is reported
/// HONESTLY: with the boot wire live the page passes the boot-failure
/// screen into the loader progress state; the /api namespaces and mux
/// streams stay UNCLAIMED (the embedded closure carries no agent spine, so
/// there are no session services) and the carrier answers them structured-
/// unavailable — the next named gap, never faked.
final class OfficialWebRuntime {
    static let scenario = "b1.official-web.mount"
    static let clientID = "dsh-web-official"
    static let watchdogSeconds = 90

    private let server = CarrierServer()
    private let eventLog = CarrierEventLog(scenario: OfficialWebRuntime.scenario)
    private var bridge: CarrierAPIBridge?
    private var dist: CarrierWebDist?
    /// Strong refs: the route handlers capture these weakly (the server's
    /// closures would otherwise be the only retainers mid-flight).
    private var plugins: CarrierPlugins?
    private weak var webView: WKWebView?
    private var completion: ((SpikeOutcome) -> Void)?
    private var watchdog: DispatchWorkItem?
    private var finished = false
    private var token = ""
    private var origin: URL?

    // ---- the web-boot runtime half (W-INTEG) --------------------------------

    private var webBoot: WebBootRuntimeDrive?
    private var runtimeBootApplied = false

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
            finish(failOutcome("official-web bootstrap: \(error)"))
            return
        }
    }

    /// Wires the drive's evidence hooks (all server-queue callbacks; the
    /// once-guards make each wire event single-emission in manifest order).
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
            self?.eventLog.emit("upgrade.accepted", ["path": path])
        }
        bridge.onAPICall = { [weak self] endpoint, answered in
            self?.eventLog.emit("rpc.observed", ["endpoint": endpoint, "answered": answered])
        }
        bridge.onMuxOpen = { [weak self] streamId, endpoint in
            self?.eventLog.emit("session.attached", ["streamId": streamId, "stream": endpoint])
        }
        bridge.onMuxFrame = { [weak self] direction, kind in
            self?.observeMuxFrame(direction, kind)
        }
    }

    /// The entry chunk is the deterministic first-fetch evidence; the other
    /// dist assets stay unlogged. A combo that already arrived is reported
    /// here, keeping the manifest's fixed report order.
    private func observeAsset(_ path: String) {
        guard path.hasPrefix("/assets/index-"), !assetLogged else { return }
        assetLogged = true
        eventLog.emit("asset.served", ["path": path])
        guard let combo = comboPending, !comboLogged else { return }
        comboLogged = true
        eventLog.emit("plugins.served", ["path": combo.0, "bytes": combo.1])
    }

    /// Single-emission combo report; an early arrival (before the asset
    /// event) waits in `comboPending` for the fixed report order.
    private func observeCombo(_ url: String, bytes: Int) {
        guard !comboLogged else { return }
        guard assetLogged else {
            comboPending = (url, bytes)
            return
        }
        comboLogged = true
        eventLog.emit("plugins.served", ["path": url, "bytes": bytes])
    }

    /// The v0 drive claims no /api namespaces or mux streams (the embedded
    /// web-boot closure carries no agent spine), so a journal open still
    /// answers the structured unavailable error — real frames, real
    /// envelope, honestly named gap. The runtime itself is LIVE (web.boot
    /// applied); only the session services are pending.
    private func observeMuxFrame(_ direction: String, _ kind: String) {
        guard direction == "tx", kind == "error" else { return }
        eventLog.emit("session.services.pending", [
            "leg": "session.journal",
            "reason": "mux journal stream answered gateway/unimplemented; "
                + "the web-boot closure embeds no agent spine — session services "
                + "are the next named gap",
        ])
    }

    /// Builds the route table per the contract, starts listening, and boots
    /// the web-boot runtime half. The origin opens ONLY after the runtime
    /// posted `web.boot` (its rows replace the carrier defaults and its
    /// plugin revs override the /plugins route), so the page always loads
    /// the runtime-composed boot wire.
    private func startCarrier() throws {
        let root = try SpikeBundleStager.stage()
        let distRoot = try Self.locateDist()
        token = Self.randomToken()
        // Fallback rows/entries while the runtime boots: the staged M2
        // plugin bundles through the upstream /plugins combo shapes (§3.4).
        // The runtime's `web.boot` replaces both (rows + revs) before the
        // origin opens. The staged vendored client-modules browser bundle
        // (Documents/web-plugins, staged by run-ios-b1.sh) is served here
        // too — its rev comes from the runtime graph (placeholder nonce),
        // applied by applyRuntimeRevs.
        var bundleFiles: [(String, URL)] = [
            ("dsh-web-client", root.appendingPathComponent("webclient/web/main.js")),
            ("dsh-web-client-mini", root.appendingPathComponent("webclient-mini/web/main.js")),
        ]
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let stagedClientBundle = docs.appendingPathComponent(
            "web-plugins/npm/@deepseek-ai/dsh-client-modules@0.1.6-alpha.2/lib/client.js")
        if FileManager.default.fileExists(atPath: stagedClientBundle.path) {
            bundleFiles.append(("@deepseek-ai/dsh-client-modules", stagedClientBundle))
        }
        let plugins = CarrierPlugins(bundles: bundleFiles)
        let config = CarrierBootConfig.default(plugins: plugins)
        defaultComboURL = Self.batchURL(graphJSON: config.bootGraphJSON)
        comboURL = defaultComboURL
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
        // mux seats → the bridge (the bridge filters to its own path)
        server.onWSFrame = { [weak bridge] text, path in
            bridge?.ingestFrame(text, path: path)
        }
        self.dist = dist
        self.bridge = bridge
        self.plugins = plugins
        try server.start { [weak self] in
            guard let self, self.server.port != 0 else { return }
            // Origin open is gated on the runtime's web.boot (the page load
            // must never race the boot-wire composition).
            self.maybeOpenOrigin()
        }
        startWebBootRuntime(bundleRoot: root)
    }

    // ---- the web-boot runtime half ------------------------------------------

    /// Boot rows received from the runtime (`web.boot`), nil until then.
    private var webBootRows: [[String: Any]]?
    /// The runtime graph's application batch URL (the probe fetches it).
    private var defaultComboURL = ""

    /// The injection rows the index renders: the runtime's `web.boot` rows
    /// once received (plus the recovery global), else the carrier defaults.
    private func runtimeRows() -> [CarrierIndexInjection] {
        guard let rows = webBootRows else { return [] }
        var out = rows.compactMap { Self.injectionRow($0) }
        out.append(CarrierIndexInjection(kind: .global(
            name: "__DSH_CONNECTION_RECOVERY__",
            value: CarrierIndexInjection.jsonGlobalValue(
                "{\"backoffBaseMs\":500,\"backoffFactor\":2,\"backoffMaxMs\":10000,"
                    + "\"generationReadyWarnMs\":3000,\"generationReadyTimeoutMs\":15000}"))))
        return out
    }

    /// One upstream row shape → the carrier's typed injection row.
    static func injectionRow(_ row: [String: Any]) -> CarrierIndexInjection? {
        switch row["kind"] as? String {
        case "script":
            guard let text = row["text"] as? String else { return nil }
            return CarrierIndexInjection(kind: .script(placement: .head, text: text))
        case "script-src":
            guard let src = row["src"] as? String else { return nil }
            return CarrierIndexInjection(kind: .scriptSrc(placement: .head, src: src))
        case "script-preload":
            guard let src = row["src"] as? String else { return nil }
            return CarrierIndexInjection(kind: .scriptPreload(src: src))
        case "global":
            guard let name = row["name"] as? String, let value = row["value"] as? String
            else { return nil }
            return CarrierIndexInjection(kind: .global(name: name, value: value))
        default:
            return nil
        }
    }

    /// Starts the b1-web-live scenario through the drive and delivers the
    /// staged `web.plugins` files (Documents/web-plugins, put there by
    /// tools/e2e/run-ios-b1.sh from the pinned vendor tree).
    private func startWebBootRuntime(bundleRoot: URL) {
        let drive = WebBootRuntimeDrive()
        drive.onBusPost = { [weak self] msg in
            self?.runtimeBusPosted(msg)
        }
        drive.onFailure = { [weak self] message in
            self?.finish(self?.failOutcome(message) ?? SpikeOutcome(
                completed: false, passed: false, error: message, canonicalLines: []))
        }
        webBoot = drive
        drive.start(bundleRoot: bundleRoot, plugins: WebBootRuntimeDrive.webPluginsDelivery())
    }

    /// Called from the drive (runtime thread) per JS → host bus message.
    private func runtimeBusPosted(_ msg: [String: Any]) {
        guard !finished else { return }
        switch msg["type"] as? String {
        case "web.boot":
            guard let rows = msg["rows"] as? [[String: Any]] else { return }
            webBootRows = rows
            if let graph = msg["graph"] as? [String: Any] {
                comboURL = Self.batchURL(graph: graph) ?? defaultComboURL
            }
            if let pluginRows = msg["plugins"] as? [[String: Any]] {
                plugins?.applyRuntimeRevs(pluginRows)
            }
            runtimeBootApplied = true
            eventLog.emit("web.boot.applied", [
                "rows": runtimeRows().count,
                "source": "runtime (vendored @deepseek-ai/dsh-client-modules)",
            ])
            maybeOpenOrigin()
        default:
            break // the compose-only scenario posts nothing else (no claims)
        }
    }

    /// Opens the origin once BOTH the port is bound and the runtime's
    /// `web.boot` has been applied (main thread, once).
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

    /// once-guards for the single-emission hooks (server-queue-confined);
    /// `comboPending` holds an early combo arrival until the asset event
    /// fixed the report order.
    private var assetLogged = false
    private var comboLogged = false
    private var comboPending: (String, Int)?
    /// The batch combo URL from the injected graph, fetched by the probe.
    private var comboURL = ""

    /// The document finished loading: the head subresources (entry chunk,
    /// styles) have arrived; wait for the entry-chunk evidence, then run the
    /// same-origin probe and read the TRUE rendered state.
    func pageDidFinish() {
        guard !finished else { return }
        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            // rule 8: poll the arrival condition with a deadline, fail loud
            let deadline = Date().addingTimeInterval(30)
            while !self.assetLogged && Date() < deadline {
                Thread.sleep(forTimeInterval: 0.1)
            }
            guard self.assetLogged else {
                return self.finish(self.failOutcome(
                    "official-web: the entry chunk never arrived"))
            }
            self.runProbe()
        }
    }

    // ---- same-origin probe (WebView fetch + WebSocket) ------------------------

    /// Runs the probe script in the page: combo fetch (plugins.served), WS
    /// upgrade (upgrade.accepted), POST /api/session.list (rpc.observed),
    /// mux journal open (session.attached + the unavailable frame), then the
    /// rendered-state read with the live-module verdict.
    private func runProbe() {
        guard let webView else {
            return finish(failOutcome("official-web: no WebView attached"))
        }
        OfficialWebProbe.evaluate(
            webView, OfficialWebProbe.probeScript(comboURL: comboURL)
        ) { [weak self] _, error in
            guard let self else { return }
            if let error {
                return self.finish(self.failOutcome("probe setup: \(error)"))
            }
            OfficialWebProbe.awaitPromise(webView, "window.__b1Run()") { [weak self] result, error in
                guard let self else { return }
                if let error {
                    return self.finish(self.failOutcome("probe run: \(error)"))
                }
                self.consumeProbe(result as? String ?? "null")
            }
        }
    }

    private func consumeProbe(_ json: String) {
        switch OfficialWebProbe.verdict(json) {
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
                "official-web watchdog: drive did not complete in \(Self.watchdogSeconds)s"))
        }
        watchdog = item
        DispatchQueue.global().asyncAfter(
            deadline: .now() + .seconds(Self.watchdogSeconds), execute: item)
    }

    private func failOutcome(_ message: String) -> SpikeOutcome {
        print("spike: official FAIL \(message)")
        fflush(stdout)
        NSLog("%@", "spike: official FAIL \(message)")
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
        print("spike: official drive finished verdict=\(outcome.verdict)")
        fflush(stdout)
        webBoot?.stop()
        DispatchQueue.main.async { [weak self] in
            self?.completion?(outcome)
            self?.completion = nil
        }
    }

    // ---- helpers -------------------------------------------------------------------

    /// The vendored official dist, staged into the app container by the E2E
    /// runner (`ensure-official-dist.sh`); fail loud when absent.
    static func locateDist() throws -> URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dist = docs.appendingPathComponent("official-web/dist", isDirectory: true)
        guard FileManager.default.fileExists(
            atPath: dist.appendingPathComponent("index.html").path) else {
            throw SpikeBundleError.emptyResource("Documents/official-web/dist/index.html")
        }
        return dist
    }

    /// The application batch's combo URL from the injected graph JSON.
    static func batchURL(graphJSON: String) -> String {
        guard let data = graphJSON.data(using: .utf8),
              let graph = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let url = batchURL(graph: graph) else { return "" }
        return url
    }

    /// The application batch's combo URL from a decoded graph object.
    static func batchURL(graph: [String: Any]) -> String? {
        guard let batches = graph["batches"] as? [[String: Any]] else { return nil }
        return batches.first?["url"] as? String
    }

    static func randomToken() -> String {
        let bytes = (0..<16).map { _ in UInt8.random(in: 0...255) }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
