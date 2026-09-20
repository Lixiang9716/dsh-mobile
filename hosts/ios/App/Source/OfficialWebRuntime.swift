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
/// (vendored dist, zero upstream edits) in the WebView. Wire evidence is
/// carrier-side observation only (the page cannot emit our log envelope);
/// the same-origin probe runs through the WebView's own fetch/WebSocket so
/// cookies and the upgrade path are the page's real stack. The rendered
/// state is reported HONESTLY: the upstream boot screen renders before any
/// runtime bundle is needed, so `page.rendered` proves the mount, while the
/// `token.delta.forwarded` leg awaits the upstream runtime (W-PORT2) and is
/// marked `runtime.pending` — never faked.
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

    /// The v0 mux answers the probe's journal open with the structured
    /// unavailable error — real frames, real envelope, runtime leg open.
    private func observeMuxFrame(_ direction: String, _ kind: String) {
        guard direction == "tx", kind == "error" else { return }
        eventLog.emit("runtime.pending", [
            "leg": "token.delta.forwarded",
            "reason": "mux journal stream answered gateway/unimplemented; "
                + "the upstream runtime (vendor + boot graph) is a sibling PR",
        ])
    }

    /// Builds the route table per the contract and starts listening.
    private func startCarrier() throws {
        let root = try SpikeBundleStager.stage()
        let distRoot = try Self.locateDist()
        token = Self.randomToken()
        // The staged scenario assets double as the staged client-module
        // bundles: the default boot graph references the EXISTING M2 plugin
        // bundles through the upstream /plugins combo shapes (§3.4) — two
        // entries, so the served combo proves the aggregate combine form.
        let plugins = CarrierPlugins(bundles: [
            ("dsh-web-client", root.appendingPathComponent("webclient/web/main.js")),
            ("dsh-web-client-mini", root.appendingPathComponent("webclient-mini/web/main.js")),
        ])
        let config = CarrierBootConfig.default(plugins: plugins)
        comboURL = Self.batchURL(graphJSON: config.bootGraphJSON)
        let dist = CarrierWebDist(
            distRoot: distRoot, sessionToken: token,
            indexRows: { config.rows() }
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
            let origin = URL(string: "http://127.0.0.1:\(self.server.port)/?token=\(self.token)")
            self.origin = origin
            DispatchQueue.main.async { [weak self] in
                guard let self, let origin = self.origin else { return }
                self.onOpenOrigin?(origin)
            }
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

    /// Runs the probe script in the page: WS upgrade (upgrade.accepted),
    /// POST /api/session.list (rpc.observed), mux journal open
    /// (session.attached + the unavailable frame), then the rendered-state
    /// read. Verdicts come back as one JSON string.
    private func runProbe() {
        guard let webView else {
            return finish(failOutcome("official-web: no WebView attached"))
        }
        Self.evaluate(webView, Self.probeSetup(comboURL: comboURL)) { [weak self] _, error in
            guard let self else { return }
            if let error {
                return self.finish(self.failOutcome("probe setup: \(error)"))
            }
            Self.awaitPromise(webView, "window.__b1Run()") { [weak self] result, error in
                guard let self else { return }
                if let error {
                    return self.finish(self.failOutcome("probe run: \(error)"))
                }
                self.consumeProbe(result as? String ?? "null")
            }
        }
    }

    private func consumeProbe(_ json: String) {
        guard let data = json.data(using: .utf8),
              let probe = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let page = probe["page"] as? [String: Any] else {
            return finish(failOutcome("probe returned no parseable result: \(json.prefix(200))"))
        }
        if let combo = probe["combo"] as? String, !combo.hasPrefix("text/javascript") {
            return finish(failOutcome("probe combo outcome: \(combo)"))
        }
        if let rpc = probe["rpc"] as? String, rpc != "error:gateway/unimplemented" {
            // the probe observes the envelope outcome; anything but the
            // structured unavailable answer means the wire shape regressed
            return finish(failOutcome("probe rpc outcome: \(rpc)"))
        }
        eventLog.emit("page.rendered", [
            "boot": (page["boot"] as? Bool) ?? false,
            "rootHasChild": (page["rootHasChild"] as? Bool) ?? false,
            "bootText": (page["bootText"] as? String) ?? "",
        ])
        finish(SpikeOutcome(
            completed: true, passed: true, error: "",
            canonicalLines: eventLog.lines
        ))
    }

    private static func evaluate(
        _ webView: WKWebView, _ script: String,
        completion: @escaping (Any?, Error?) -> Void
    ) {
        DispatchQueue.main.async {
            webView.evaluateJavaScript(script) { result, error in
                completion(result, error)
            }
        }
    }

    /// Runs one async page expression and AWAITS its promise (plain
    /// evaluateJavaScript would return the Promise object itself, which the
    /// bridge refuses — WKError 5 "unsupported type").
    private static func awaitPromise(
        _ webView: WKWebView, _ expression: String,
        completion: @escaping (Any?, Error?) -> Void
    ) {
        DispatchQueue.main.async {
            webView.callAsyncJavaScript(
                "return await (\(expression));",
                arguments: [:], in: nil, in: .page
            ) { result in
                switch result {
                case .success(let value): completion(value, nil)
                case .failure(let error): completion(nil, error)
                }
            }
        }
    }

    /// Defines `__b1Run` on the page (the page itself is untouched upstream
    /// code; the probe is platform-side, per the M3 rendered-state precedent).
    /// Step order = manifest order: combo fetch (plugins.served), WS upgrade
    /// (upgrade.accepted), unary RPC (rpc.observed), mux journal open
    /// (session.attached + the unavailable frame), then the rendered read.
    static func probeSetup(comboURL: String) -> String {
        """
        window.__b1Run = async () => {
          const out = {};
          const combo = await fetch('\(comboURL)', {credentials: 'same-origin'});
          out.combo = combo.ok ? (combo.headers.get('content-type') || 'no-type') : 'http-' + combo.status;
          const ws = await new Promise((resolve, reject) => {
            const ws = new WebSocket('ws://' + location.host + '/api/remote.mux');
            const t = setTimeout(() => reject(new Error('ws-timeout')), 8000);
            ws.onopen = () => { clearTimeout(t); resolve(ws); };
            ws.onerror = () => { clearTimeout(t); reject(new Error('ws-error')); };
          });
          const rpc = await fetch('/api/session.list', {
            method: 'POST', credentials: 'same-origin',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({type:'client-request', rpcId:'b1-probe-rpc-1',
              method:'session.list', payload:{args:{}}}),
          }).then((r) => r.json());
          out.rpc = rpc && rpc.type === 'server-response'
            ? (rpc.result.ok === true ? 'ok' : 'error:' + (rpc.result.error || {}).code)
            : 'malformed';
          out.mux = await new Promise((resolve) => {
            const t = setTimeout(() => resolve('timeout'), 8000);
            ws.onmessage = (ev) => { clearTimeout(t); out.muxFrame = String(ev.data); resolve('frame'); };
            ws.send(JSON.stringify({type:'open', streamId:'b1-probe-journal',
              endpoint:'session/journal', payload:{args:{}}}));
          });
          try { ws.close(); } catch (e) {}
          const boot = document.querySelector('[data-dsh-boot]');
          out.page = {boot: boot !== null,
            bootText: boot ? boot.textContent.slice(0, 160) : '',
            rootHasChild: ((document.getElementById('root') || {}).childElementCount || 0) > 0};
          return JSON.stringify(out);
        };
        'defined';
        """
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
              let batches = graph["batches"] as? [[String: Any]],
              let url = batches.first?["url"] as? String else { return "" }
        return url
    }

    static func randomToken() -> String {
        let bytes = (0..<16).map { _ in UInt8.random(in: 0...255) }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
