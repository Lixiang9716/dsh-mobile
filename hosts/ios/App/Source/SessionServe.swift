import Foundation

/// The SERVING seat behind the official Web Client on the loopback carrier:
/// the carrier (`CarrierServer`), the official dist seat (`CarrierWebDist`),
/// the `/plugins` delivery (`CarrierPlugins`), the `/api` + mux bridge
/// (`CarrierAPIBridge`), the scripted chat-completions endpoint, and the
/// web-boot runtime half — the upstream spine that composes `web.boot`,
/// claims the WRITE surface (`session/create`, prompt admission, the
/// `session/follow` + `workspace/follow` streams, the settings describe) and
/// then goes RESIDENT: the page's own composer drives the turn, nothing here
/// pre-plays it.
///
/// It runs in BOTH configurations. A user-facing launch constructs it with NO
/// hooks assigned and no launch parameter (`AppDelegate.bootRelease`) — the
/// user drives the page. The `composer.live-write` evidence drive
/// (`SessionWriteRuntime`) holds an instance, assigns the hooks below and
/// verifies it. The seam is the hook block, and its defaults are no-ops: the
/// seat reports serving FACTS, and which `dsh.spike.log:` record a fact
/// becomes — under which scenario id, once or every time — is the drive's
/// business. This is the shape the harmony precedent
/// (`OfficialServe.ets` / `OfficialPhase.ets`) settled on after rejecting the
/// single-class-plus-`isRelease` alternative: a file boundary is checkable by
/// reading, a flag only by testing.
///
/// Nothing here emits an E2E record itself, so a release launch — which
/// assigns no hooks — cannot produce one even by accident. (The bell it does
/// not need: `CarrierEventLog` drops every debug/info line in a release
/// build.)
final class SessionServe {
    /// The Web Client plugin this seat serves. The official client is not
    /// reachable through the `-dsh-web-client` staging path (the harness
    /// selects between the in-house clients); the release boot and the b4
    /// drive both serve this one.
    static let clientID = "dsh-web-official"

    /// The self-hosted client (presentation/web-client-next) this seat can
    /// serve when the launch configuration selects it — same /api + mux
    /// surface, our page instead of the vendored dist.
    static let nextClientID = "dsh-web-client-next"

    // ---- the hook block (a drive assigns these; defaults are no-ops) -------

    /// The port is bound and the runtime half is about to start.
    var onCarrierUp: ((UInt16) -> Void)?
    var onIndexRendered: ((_ rows: Int, _ bytes: Int) -> Void)?
    var onIndexServed: (() -> Void)?
    var onAssetServed: ((String) -> Void)?
    var onComboServed: ((_ url: String, _ bytes: Int) -> Void)?
    var onUpgradeAccepted: ((String) -> Void)?
    var onAPICall: ((_ endpoint: String, _ answered: String) -> Void)?
    var onMuxFrame: ((_ direction: String, _ kind: String) -> Void)?
    /// The runtime's `web.boot` replaced the carrier's default rows and the
    /// plugin revs — the fact `web.boot.applied` records.
    var onWebBootApplied: ((_ rows: Int, _ source: String) -> Void)?
    /// The serving OUTPUT: the loopback origin is ready to open. Always
    /// delivered on the main thread; the host loads it in its WebView.
    var onOrigin: ((URL) -> Void)?
    /// The runtime half failed to boot or died. A user-facing build has no
    /// verdict to fail, but the page cannot function either, so the host is
    /// told rather than left with a silently dead UI.
    var onRuntimeFailure: ((String) -> Void)?
    /// The runtime half reported its scenario settled (it stays resident: the
    /// b4 entry completes its boot, not its session).
    var onRuntimeSettled: ((_ passed: Bool, _ message: String) -> Void)?

    // ---- the seats ---------------------------------------------------------

    /// The reserved app scope's root (`FSPrimitives`: what scope "app" means).
    static var appScopeRoot: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("profiles/default", isDirectory: true)
    }

    /// The one workspace the mobile profile seeds: a real directory inside the
    /// app scope, created on first use so the agent always has somewhere to
    /// work (see `runtimeConfig` for why it is not the staged bundle root).
    static var workspaceRoot: URL {
        let url = appScopeRoot.appendingPathComponent("spike", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// The user-supplied model endpoint, or nil for the carrier's scripted
    /// one. INJECTED, never read from the environment here: the E2E drive
    /// constructs a seat with nil and therefore always runs the scripted
    /// route its manifest pins, while the user-facing boot passes whatever
    /// the app's credential file holds. A seat that read the file itself
    /// would silently make the drive hit a real endpoint the moment a
    /// developer staged a key — the determinism boundary is a dependency,
    /// not an ambient fact.
    private let credential: LlmCredential?

    /// The user-facing boot composes the INTERACTIVE surfaces (the commands
    /// registry + the skill plane the composer's "/" menu reads). The
    /// `composer.live-write` drive keeps the default (false) so its boot stays
    /// byte-identical to what the manifest pins.
    private let interactive: Bool

    private let server = CarrierServer()
    private var bridge: CarrierAPIBridge?
    private var dist: CarrierWebDist?
    private var plugins: CarrierPlugins?
    private var runtime: WebBootRuntimeDrive?
    private var token = ""
    private var origin: URL?
    private var stopped = false

    init(credential: LlmCredential? = nil, interactive: Bool = false) {
        self.credential = credential
        self.interactive = interactive
    }

    /// Boot rows received from the runtime (`web.boot`), nil until then.
    private var webBootRows: [[String: Any]]?
    private var runtimeBootApplied = false
    /// The runtime's settings probes finished (bus line `settings.probes.done`):
    /// the page open gates on this so the drive's record order is deterministic.
    private var settingsProbesDone = false
    /// The runtime graph's application batch URL.
    private var comboURL = ""

    /// The bound loopback port (0 until `start()` succeeds).
    var port: UInt16 { server.port }

    var runtimeStarted: Bool { runtime != nil }

    // ---- lifecycle ---------------------------------------------------------

    /// Builds the route table (official dist fallback + /plugins + /api + the
    /// scripted llm endpoint), starts listening, and boots the runtime half
    /// once the port is bound (its runtime.config needs the port).
    func start() throws {
        let root = try SpikeBundleStager.stage()
        // The client flavor: when the launch configuration selects OUR client
        // (dsh-web-client-next) the seat serves the staged plugin's web dir
        // with NO injection rows — the page owns its whole boot, and the
        // facade/boot-graph/phone-CSS rows are the official page's. Every
        // other selection serves the vendored official dist exactly as
        // before, so every existing scenario's boot bytes stay untouched.
        let servesNext = SessionLaunchConfig.activeWebClient == Self.nextClientID
        let distRoot = try servesNext
            ? root.appendingPathComponent("webclient-next/web", isDirectory: true)
            : OfficialWebRuntime.locateDist()
        token = OfficialWebRuntime.randomToken()
        let plugins = CarrierPlugins.staged(spikeRoot: root)
        let config = CarrierBootConfig.default(plugins: plugins)
        comboURL = OfficialWebRuntime.batchURL(graphJSON: config.bootGraphJSON)
        let dist = CarrierWebDist(
            distRoot: distRoot, sessionToken: token,
            indexRows: { [weak self] in
                if servesNext { return [] }
                return self?.runtimeRows() ?? config.rows()
            }
        )
        let bridge = CarrierAPIBridge(sessionToken: token)
        wireHooks(dist: dist, plugins: plugins, bridge: bridge)
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
            self?.deliverRuntime(msg)
        }
        try server.start { [weak self] in
            guard let self, self.server.port != 0 else { return }
            self.onCarrierUp?(self.server.port)
            self.startRuntime(bundleRoot: root)
        }
    }

    /// Stops serving. Called by a drive at its terminal step; a user-facing
    /// launch stops only when the app leaves the screen.
    func stop() {
        guard !stopped else { return }
        stopped = true
        runtime?.stop()
        runtime = nil
        server.stop()
    }

    /// The carrier reports its seats' facts as hooks (defaults are no-ops, so
    /// a hook-free launch passes every one of them through untouched).
    private func wireHooks(
        dist: CarrierWebDist, plugins: CarrierPlugins, bridge: CarrierAPIBridge
    ) {
        dist.onIndexRendered = { [weak self] rows, bytes in
            self?.onIndexRendered?(rows, bytes)
        }
        dist.onIndexServed = { [weak self] in
            self?.onIndexServed?()
        }
        dist.onAssetServed = { [weak self] path in
            self?.onAssetServed?(path)
        }
        plugins.onComboServed = { [weak self] url, bytes in
            self?.onComboServed?(url, bytes)
        }
        bridge.onUpgradeAccepted = { [weak self] path in
            self?.onUpgradeAccepted?(path)
        }
        bridge.onAPICall = { [weak self] endpoint, answered in
            self?.onAPICall?(endpoint, answered)
        }
        bridge.onMuxFrame = { [weak self] direction, kind in
            self?.onMuxFrame?(direction, kind)
        }
    }

    // ---- the runtime half (the upstream spine) ------------------------------

    /// Starts the b4 runtime half: gateway wired (fs scope + httpFetch), the
    /// model endpoint facts ride runtime.config (the port is bound). The
    /// entry is the SAME runtime half the `composer.live-write` manifest verifies —
    /// one implementation of the serving path, never a second copy that
    /// drifts from the one the manifests prove.
    private func startRuntime(bundleRoot: URL) {
        let drive = WebBootRuntimeDrive()
        drive.onBusPost = { [weak self] msg in
            self?.runtimeBusPosted(msg)
        }
        drive.onFailure = { [weak self] message in
            self?.onRuntimeFailure?(message)
        }
        drive.onComplete = { [weak self] passed, message in
            self?.onRuntimeSettled?(passed, message)
        }
        runtime = drive
        drive.start(
            bundleRoot: bundleRoot,
            plugins: WebBootRuntimeDrive.webPluginsDelivery(),
            config: runtimeConfig(port: server.port, bundleRoot: bundleRoot),
            scenario: dsh_spike_res_scenario_b4_web_live_js,
            scenarioPath: "scenario/composer-web-live.js",
            gateway: true)
    }

    /// The runtime.config delivery. `llmBaseUrl` is present exactly when the
    /// user supplied an endpoint, which is what makes the runtime call a REAL
    /// model instead of the carrier's scripted one; without it the scripted
    /// loopback endpoint is the route (a launch with no credentials still
    /// serves the whole UI, it just cannot answer a turn with a real model).
    func runtimeConfig(port: UInt16, bundleRoot: URL) -> [String: Any] {
        var config: [String: Any] = [
            "type": "runtime.config",
            "mockLlmUrl": "http://127.0.0.1:\(port)/mock-llm",
            "apiKey": CarrierServer.mockLlmKey,
            // The agent's workspace and the scope its file tools may touch.
            // NOT the staged JS bundle (`bundleRoot`): that tree is the app's
            // own runtime, deleted and rewritten on every launch, and it sits
            // outside every granted scope — an agent working there could not
            // be allowed to write, and anything it wrote would vanish. The
            // workspace is a REAL directory inside the app scope instead, so
            // the file tools' absolute paths map onto (scope "app", rel) and
            // survive relaunches.
            "containerRoot": Self.workspaceRoot.path,
            "fsScopeRoot": Self.appScopeRoot.path,
        ]
        if let credential {
            config["llmBaseUrl"] = credential.baseUrl
            config["llmApiKey"] = credential.apiKey
            config["llmModel"] = credential.model
            config["llmProvider"] = credential.provider
        }
        if interactive {
            // The "/" surfaces (client-ui-commands + client-ui-skill read
            // these): the commands registry + the skill plane under the
            // profile container. The custom skills dir must live INSIDE the
            // pinned workspace (the fs backends refuse anything outside it —
            // measured: Documents/skills was skipped by the discovery
            // provider), so the user stages skills at workspace/skills via
            // Files.app.
            config["commands"] = true
            config["fullCoverage"] = true
            config["goals"] = true
            config["fileReferences"] = true
            config["skills"] = [
                "dshHome": "\(Self.workspaceRoot.path)/home",
                "agentsHome": "\(Self.workspaceRoot.path)/home/agents",
                "customSkillDirs": ["\(Self.workspaceRoot.path)/skills"],
            ]
        }
        return config
    }

    /// One user-supplied model endpoint: an OpenAI-compatible base URL, its
    /// key and the model id.
    struct LlmCredential {
        var baseUrl: String
        var apiKey: String
        var model: String
        var provider: String
    }

    /// Where the credential comes from: `<Documents>/profiles/default/llm/
    /// config.json` — the reserved app scope (`FSPrimitives`), the same shape
    /// and location the `llm.live-stream` runner stages credentials at, mode 0600.
    /// The file is the app's own Documents directory, which this build
    /// exposes in Files.app (`UIFileSharingEnabled`), so a user can drop the
    /// endpoint in without a runner. A malformed or partial file yields nil
    /// rather than a half-configured transport.
    ///
    /// Nothing here logs the key: a credential that never reaches a record
    /// cannot leak into one.
    ///
    /// Only the user-facing boot calls this — the E2E drive injects nil on
    /// purpose (see `init(credential:)`).
    static func loadCredential() -> LlmCredential? {
        let documents = FileManager.default.urls(
            for: .documentDirectory, in: .userDomainMask)[0]
        let file = documents.appendingPathComponent(
            "profiles/default/llm/config.json", isDirectory: false)
        guard let data = try? Data(contentsOf: file),
              let object = try? JSONSerialization.jsonObject(with: data),
              let fields = object as? [String: Any],
              let baseUrl = fields["baseUrl"] as? String, !baseUrl.isEmpty,
              let apiKey = fields["apiKey"] as? String, !apiKey.isEmpty,
              let model = fields["model"] as? String, !model.isEmpty
        else { return nil }
        let provider = (fields["provider"] as? String).flatMap {
            $0.isEmpty ? nil : $0
        } ?? "openai-compatible"
        return LlmCredential(
            baseUrl: baseUrl, apiKey: apiKey, model: model, provider: provider)
    }

    // ---- bus seam (runtime → carrier claims + answers) ------------------------

    /// One JS → host bus message: folds the runtime's claims and answers into
    /// the bridge. This is serving, not evidence — the page's calls are
    /// answered the same way whether or not a drive is attached.
    private func runtimeBusPosted(_ msg: [String: Any]) {
        guard !stopped else { return }
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
            onWebBootApplied?(
                runtimeRows().count,
                "runtime (spine + vendored @deepseek-ai/dsh-client-modules)")
            maybeOpenOrigin()
        case "settings.probes.done":
            // The runtime's settings-surface probes (预设 roster + 插件
            // inventory) finished: the page may open. Gating here makes the
            // probe records strictly precede the page-serve records in the
            // captured log — the E2E manifest order is deterministic (the
            // two orderings otherwise alternate between runs; measured).
            settingsProbesDone = true
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

    /// Page → runtime (the /api bridge's outbound direction).
    private func deliverRuntime(_ msg: [String: Any]) {
        runtime?.deliverRuntime(msg)
    }

    // ---- index injection + origin -------------------------------------------

    /// The injection rows the index renders: the runtime's `web.boot` rows
    /// once received (plus the recovery global and the settings phone
    /// adaptation), else the carrier defaults.
    private func runtimeRows() -> [CarrierIndexInjection] {
        guard let rows = webBootRows else { return [] }
        var out = rows.compactMap { OfficialWebRuntime.injectionRow($0) }
        out.append(CarrierIndexInjection(kind: .global(
            name: "__DSH_CONNECTION_RECOVERY__",
            value: CarrierIndexInjection.jsonGlobalValue(
                "{\"backoffBaseMs\":500,\"backoffFactor\":2,\"backoffMaxMs\":10000,"
                    + "\"generationReadyWarnMs\":3000,\"generationReadyTimeoutMs\":15000}"))))
        out.append(CarrierBootConfig.settingsPhoneAdaptation)
        return out
    }

    /// The composition is complete: open the origin. Guarded on the applied
    /// boot (the composed rows must replace the defaults before the page
    /// reads them) and on a bound port, and hopped to the main thread because
    /// the load has to happen there.
    private func maybeOpenOrigin() {
        guard runtimeBootApplied, settingsProbesDone, server.port != 0 else { return }
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.stopped, self.origin == nil,
                  self.runtimeBootApplied, self.settingsProbesDone, self.server.port != 0,
                  let origin = URL(string: "http://127.0.0.1:\(self.server.port)/?token=\(self.token)")
            else { return }
            self.origin = origin
            self.onOrigin?(origin)
        }
    }
}
