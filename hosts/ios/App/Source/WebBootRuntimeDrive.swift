import Foundation

/// The web-boot runtime half of the b1/b3 drives: runs a web-live scenario on
/// a dedicated serial runtime thread, hands it the staged `web.plugins`
/// delivery over the bus seam, and forwards every JS → host bus line to the
/// owner. The scenario composes the OFFICIAL boot wire with the vendored
/// client-modules node half; in the b3 shape it also boots the FULL upstream
/// spine and stays resident to serve the claimed /api + mux surface.
///
/// Threading: the whole JS lifetime lives on ONE thread (ARCHITECTURE.md §6);
/// `handleBusLine` is the C host's callback (runtime thread) and hops the
/// parsed message to `onBusPost` (owner decides the queue). Gateway
/// settle/event hop BACK onto the runtime thread before re-entering C.
/// Failures surface once through `onFailure` (drive-owned verdict); the
/// drive never logs — the spike sink already carries the canonical lines.
final class WebBootRuntimeDrive {
    private let thread = RuntimeThread(name: "org.dsh.spike.webboot")
    private let sink = SpikeLogSink()
    private var host: OpaquePointer?
    /// The capability gateway the scenario's spine exercises (fs scope for
    /// the profile container, httpFetch for the llm transport). Nil for the
    /// compose-only b1 shape — which never calls a primitive.
    private var core: GatewayCore?

    /// JS → host: one parsed bus line (runtime thread).
    var onBusPost: (([String: Any]) -> Void)?
    /// Drive-fatal failure (any thread; the owner settles the verdict).
    var onFailure: ((String) -> Void)?
    /// The scenario completed (`__dshComplete`): pass flag + its message
    /// (runtime thread; b1's owner ignores it — its verdict is the probe's).
    var onComplete: ((Bool, String) -> Void)?

    /// Boots the scenario and delivers the staged plugin files. `plugins`
    /// nil means the staging is missing — a loud drive failure (the runner
    /// stages it; a fresh install without run-ios-official-web-mount.sh cannot boot).
    /// `config` (b3) rides in BEFORE the plugins: the runtime.config facts
    /// (scripted llm endpoint) the spine boot needs. `scenario` selects the
    /// embedded entry (default: the b1 compose-only scenario).
    func start(
        bundleRoot: URL, plugins: [[String: Any]]?, config: [String: Any]? = nil,
        scenario: @escaping (UnsafeMutablePointer<Int>?) -> UnsafePointer<CChar>? =
            dsh_spike_res_scenario_b1_web_live_js,
        scenarioPath: String = "scenario/officialweb-web-live.js",
        gateway: Bool = false
    ) {
        thread.start()
        thread.async { [self] in
            guard let host = bootHost(bundleRoot: bundleRoot) else { return }
            if gateway && !wireGateway(bundleRoot: bundleRoot, host: host) { return }
            wireSinks(host: host)
            guard evalScenario(host: host, scenario: scenario, path: scenarioPath) else { return }
            guard deliverStaging(plugins, config, bundleRoot.path) else { return }
            if dsh_spike_pump(host) != 0 {
                onFailure?("web-boot pump: \(String(cString: dsh_spike_error(host)))")
            }
        }
    }

    /// Creates the runtime for this drive and keeps its handle; nil means the
    /// failure has already been reported through `onFailure`.
    private func bootHost(bundleRoot: URL) -> OpaquePointer? {
        var cSink = sink.cSink
        guard let host = dsh_spike_new_declaring(bundleRoot.path, &cSink) else {
            onFailure?("web-boot runtime: dsh_spike_new returned NULL")
            return nil
        }
        self.host = host
        return host
    }

    /// The capability gateway half (b3/b4): open the core over the staged
    /// manifest, register the primitives the spine exercises, and hand C the
    /// descriptor. The settle/emit closures hop BACK onto this runtime thread
    /// before re-entering C (ARCHITECTURE.md §6).
    private func wireGateway(bundleRoot: URL, host: OpaquePointer) -> Bool {
        core = try? GatewayCore(bundleRoot: bundleRoot)
        guard let core else {
            onFailure?("web-boot gateway: manifest.json missing or unparseable")
            return false
        }
        let fs = FSPrimitives()
        fs.register(on: core)
        _ = HTTPPrimitive(core: core)
        core.settle = { [weak self] callId, ok, json in
            self?.thread.async { self?.settle(callId: Int(callId), ok: ok, json: json) }
        }
        core.emit = { [weak self] json in
            self?.thread.async { self?.emitEvent(json) }
        }
        dsh_spike_set_descriptor(host, GatewayCore.jsonLine([
            "available": GatewayCore.primitives, "unavailable": [],
        ]) ?? "{}")
        return true
    }

    /// The two C → drive seams: bus lines (every JS → host post) and gateway
    /// dispatch (a claimed primitive call).
    private func wireSinks(host: OpaquePointer) {
        dsh_spike_set_bus_sink(host, { ud, line in
            guard let ud, let line else { return }
            let drive = Unmanaged<WebBootRuntimeDrive>.fromOpaque(ud).takeUnretainedValue()
            drive.handleBusLine(String(cString: line))
        }, Unmanaged.passUnretained(self).toOpaque())
        dsh_spike_set_gateway_dispatch(host, { ud, callId, name, argsJSON in
            guard let ud, let name, let argsJSON else { return }
            let drive = Unmanaged<WebBootRuntimeDrive>.fromOpaque(ud).takeUnretainedValue()
            drive.core?.dispatch(
                callId: Int(callId), name: String(cString: name),
                argsJSON: String(cString: argsJSON))
        }, Unmanaged.passUnretained(self).toOpaque())
    }

    /// Resolves and evaluates the scenario resource. The entry point is a
    /// parameter (b1/b3 select different ones), so a missing resource is a
    /// drive failure naming the path, not a crash.
    private func evalScenario(
        host: OpaquePointer,
        scenario: (UnsafeMutablePointer<Int>?) -> UnsafePointer<CChar>?,
        path: String
    ) -> Bool {
        guard let src = scenario(nil) else {
            onFailure?("web-boot scenario resource missing: \(path)")
            return false
        }
        let source = String(cString: src)
        if dsh_spike_eval(host, path, source) != 0 {
            onFailure?("web-boot eval: \(String(cString: dsh_spike_error(host)))")
            return false
        }
        return true
    }

    /// Delivers the staged plugin files (and the b3 config first — the
    /// runtime.config facts the spine boot needs). `plugins` nil means the
    /// staging is missing: a loud drive failure, because the runner stages it
    /// and a fresh install without run-ios-official-web-mount.sh cannot boot.
    private func deliverStaging(_ plugins: [[String: Any]]?, _ config: [String: Any]?, _ stagedRoot: String) -> Bool {
        guard let plugins else {
            onFailure?("web-boot: no client bundles staged — neither the "
                + "embedded official-web/plugins resource nor "
                + "Documents/web-plugins (harness: run tools/e2e/run-ios-official-web-mount.sh; "
                + "release: tools/e2e/ensure-client-bundles.sh before the build)")
            return false
        }
        if let config { deliver(config) }
        deliver(["type": "web.plugins", "plugins": plugins])
        // The Agent 预设 panel's data source: the vendored presets tree the
        // bundle staged on disk. Delivered as seed bytes because the runtime's
        // fs view is the in-memory VFS, not the staged disk (the same reason
        // web.plugins exists). Nil/absent = this build staged no tree; the
        // panel then shows an empty roster rather than an error.
        if let seed = agentPresetsSeedDelivery(stagedRoot: stagedRoot) { deliver(seed) }
        return true
    }

    /// The staged presets tree (vendor/dsh/agent-presets@…/presets/**, written
    /// by SpikeBundleStager from the embedded spine tree) as an
    /// `agentPresets.seed` delivery: every file base64 under its VFS path,
    /// plus one node_modules resolution marker per staged dsh package — the
    /// same rule runtime/spike/ci/gen-presets-seed.py generates for the CLI.
    /// A preset row naming a package that is NOT staged stays honestly
    /// `broken` (no speculative markers); a row naming a staged package
    /// resolves through its marker onto the bare map's vendored tree.
    private func agentPresetsSeedDelivery(stagedRoot: String) -> [String: Any]? {
        // `stagedRoot` is the spike bundle root (SpikeBundleStager.stage()'s
        // return) — the vendored tree is staged beneath it verbatim.
        let vendorRoot = stagedRoot + "/vendor/dsh"
        let rootPath = vendorRoot + "/agent-presets@0.1.6-alpha.2/presets"
        let root = URL(fileURLWithPath: rootPath, isDirectory: true)
        guard FileManager.default.fileExists(atPath: root.path) else { return nil }
        var files: [String: Any] = [:]
        let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)
        while let file = enumerator?.nextObject() as? URL {
            guard file.isFileURL, let b64 = Self.stagedFileB64(file) else { continue }
            let filePath = file.path
            guard filePath.hasPrefix(root.path) else { continue }
            let suffixIndex = filePath.index(filePath.startIndex, offsetBy: root.path.count)
            let rel = String(filePath[suffixIndex...])
            files["/vendor/dsh/agent-presets@0.1.6-alpha.2/presets\(rel)"] =
                ["b64": b64, "mtimeMs": 0]
        }
        // Resolution markers: one per staged dsh package, name+version read
        // from the package's own staged package.json.
        let markerData = "resolution marker (the bare map vendors this package)"
        if let dirs = try? FileManager.default.contentsOfDirectory(atPath: vendorRoot) {
            for dir in dirs.sorted() where dir.contains("@") {
                let manifestPath = vendorRoot + "/" + dir + "/package.json"
                guard let raw = FileManager.default.contents(atPath: manifestPath),
                      let manifest = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
                      let name = manifest["name"] as? String,
                      let version = manifest["version"] as? String else { continue }
                let marker: [String: Any] = [
                    "name": name, "version": version, "_spike": markerData,
                ]
                guard let json = try? JSONSerialization.data(withJSONObject: marker),
                      !json.isEmpty else { continue }
                let b64 = json.base64EncodedString()
                files["/vendor/dsh/agent-presets@0.1.6-alpha.2/node_modules/\(name)/package.json"] =
                    ["b64": b64, "mtimeMs": 0]
            }
        }
        return files.isEmpty ? nil : ["type": "agentPresets.seed", "files": files]
    }

    /// Carrier → runtime: one bus delivery (any queue; hops onto the
    /// runtime thread — the bridge hands over claimed api.request /
    /// mux.open frames here).
    func deliverRuntime(_ obj: [String: Any]) {
        thread.async { [self] in
            deliver(obj)
            pumpAndCheck()
        }
    }

    /// Runtime-queue only: delivers one bus line into the scenario.
    private func deliver(_ obj: [String: Any]) {
        guard let host, let text = try? JSONSerialization.data(withJSONObject: obj),
              let line = String(data: text, encoding: .utf8) else { return }
        if dsh_spike_bus_deliver(host, line) != 0 {
            onFailure?("web-boot bus deliver: \(String(cString: dsh_spike_error(host)))")
        }
    }

    /// Called from the C host (runtime thread) per JS → host bus line.
    private func handleBusLine(_ line: String) {
        guard let data = line.data(using: .utf8),
              let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return }
        onBusPost?(msg)
    }

    /// Runtime thread: one settled gateway primitive call.
    private func settle(callId: Int, ok: Bool, json: String) {
        guard let host else { return }
        if dsh_spike_gateway_settle(host, Int32(callId), ok ? 1 : 0, json) != 0 {
            onFailure?("web-boot gateway settle: \(String(cString: dsh_spike_error(host)))")
            return
        }
        pumpAndCheck()
    }

    /// Runtime thread: one gateway event into the scenario.
    private func emitEvent(_ json: String) {
        guard let host else { return }
        if dsh_spike_gateway_event(host, json) != 0 {
            onFailure?("web-boot gateway event: \(String(cString: dsh_spike_error(host)))")
            return
        }
        pumpAndCheck()
    }

    /// Quiescence re-check after a settle/event: pump, then surface a
    /// completed scenario once (b3's failure leg rides this).
    private func pumpAndCheck() {
        guard let host else { return }
        if dsh_spike_pump(host) != 0 {
            onFailure?("web-boot pump after gateway: \(String(cString: dsh_spike_error(host)))")
            return
        }
        if dsh_spike_complete(host) != 0 {
            onComplete?(dsh_spike_pass(host) != 0, String(cString: dsh_spike_error(host)))
        }
    }

    /// Frees the host and stops the thread (call from the owner's finish).
    func stop() {
        thread.async { [self] in
            if let host { dsh_spike_free(host) }
            self.host = nil
            thread.stop()
        }
    }
}

// ---- staged web-plugin delivery ----------------------------------------------

extension WebBootRuntimeDrive {
    /// One package's delivered files: the manifest + the `./client` bundle
    /// (+ any staged package-local chunks), base64, fixed stamp. Nil when a
    /// required file is missing (the runner did not stage it).
    private static func stagedFiles(pkg: URL, lib: URL, vfsRoot: String) -> [String: Any]? {
        guard let b64 = stagedFileB64(pkg.appendingPathComponent("package.json")) else { return nil }
        guard let bundleB64 = stagedFileB64(lib.appendingPathComponent("client.js")) else { return nil }
        var files: [String: Any] = [
            "\(vfsRoot)/package.json": ["b64": b64, "mtimeMs": 0],
            "\(vfsRoot)/lib/client.js": ["b64": bundleB64, "mtimeMs": 0],
        ]
        guard let staged = try? FileManager.default.contentsOfDirectory(
            at: lib, includingPropertiesForKeys: nil, options: []) else { return files }
        for chunk in staged.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            let fileName = chunk.lastPathComponent
            guard fileName != "client.js", fileName.hasPrefix("client."),
                  fileName.hasSuffix(".js"), !fileName.hasSuffix(".map"),
                  let chunkB64 = stagedFileB64(chunk) else { continue }
            files["\(vfsRoot)/lib/\(fileName)"] = ["b64": chunkB64, "mtimeMs": 0]
        }
        return files
    }

    /// One staged file → base64 (nil when the runner did not stage it).
    private static func stagedFileB64(_ url: URL) -> String? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return data.base64EncodedString()
    }

    /// The staged web-plugin delivery from Documents/web-plugins: every package
    /// directory under `npm/@deepseek-ai/` (the W-SHELL application-tier staging
    /// plus the pinned vendored bootstrap package), base64, with the fixed
    /// generation stamp (`mtimeMs: 0` — the same stamp the CLI runner pins).
    /// Packages are listed in SORTED name order: the registry's scan order (= the
    /// loader entry order) is the module-graph tie-break, so the composed
    /// `__DSH_BOOT__` entry order is deterministic across runs and devices.
    /// Staged files per package: the manifest + the `./client` bundle (+ any
    /// staged package-local chunks); the graph's revs come from the runtime.
    static func webPluginsDelivery() -> [[String: Any]]? {
        // The embedded bundle scope in a user-facing build, else the
        // Documents tree the E2E runners stage (SpikeBundleStager decides).
        guard let scope = SpikeBundleStager.stagedPluginScope(),
              let packageDirs = try? FileManager.default.contentsOfDirectory(
                  at: scope, includingPropertiesForKeys: nil, options: []) else { return nil }
        var plugins: [[String: Any]] = []
        for pkg in packageDirs.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            guard pkg.hasDirectoryPath else { continue }
            let dirName = pkg.lastPathComponent
            guard let at = dirName.lastIndex(of: "@") else { continue }
            let name = "@deepseek-ai/" + dirName[dirName.startIndex..<at]
            let lib = pkg.appendingPathComponent("lib", isDirectory: true)
            let vfsRoot = "/web-plugins/npm/@deepseek-ai/\(pkg.lastPathComponent)"
            guard let files = stagedFiles(pkg: pkg, lib: lib, vfsRoot: vfsRoot) else { return nil }
            plugins.append([
                "loaderName": String(name),
                "pkgJsonPath": "\(vfsRoot)/package.json",
                "entryPath": "\(vfsRoot)/lib/client.js",
                "files": files,
            ])
        }
        return plugins.isEmpty ? nil : plugins
    }
}
