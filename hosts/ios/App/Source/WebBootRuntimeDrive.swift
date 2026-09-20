import Foundation

/// The web-boot runtime half of the b1.official-web.mount drive (W-INTEG):
/// runs the b1-web-live scenario on a dedicated serial runtime thread, hands
/// it the staged `web.plugins` delivery over the bus seam, and forwards every
/// JS → host bus line to the owner. The scenario composes the OFFICIAL boot
/// wire with the vendored client-modules node half and completes once
/// `web.boot` is posted; the carrier keeps serving independently.
///
/// Threading: the whole JS lifetime lives on ONE thread (ARCHITECTURE.md §6);
/// `handleBusLine` is the C host's callback (runtime thread) and hops the
/// parsed message to `onBusPost` (owner decides the queue). Failures surface
/// once through `onFailure` (drive-owned verdict); the drive never logs —
/// the spike sink already carries the canonical lines.
final class WebBootRuntimeDrive {
    private let thread = RuntimeThread(name: "org.dsh.spike.webboot")
    private let sink = SpikeLogSink()
    private var host: OpaquePointer?

    /// JS → host: one parsed bus line (runtime thread).
    var onBusPost: (([String: Any]) -> Void)?
    /// Drive-fatal failure (any thread; the owner settles the verdict).
    var onFailure: ((String) -> Void)?

    /// Boots the scenario and delivers the staged plugin files. `plugins`
    /// nil means the staging is missing — a loud drive failure (the runner
    /// stages it; a fresh install without run-ios-b1.sh cannot boot).
    func start(bundleRoot: URL, plugins: [[String: Any]]?) {
        thread.start()
        thread.async { [self] in
            var cSink = sink.cSink
            guard let host = dsh_spike_new(bundleRoot.path, &cSink) else {
                onFailure?("web-boot runtime: dsh_spike_new returned NULL")
                return
            }
            self.host = host
            dsh_spike_set_bus_sink(host, { ud, line in
                guard let ud, let line else { return }
                let drive = Unmanaged<WebBootRuntimeDrive>.fromOpaque(ud).takeUnretainedValue()
                drive.handleBusLine(String(cString: line))
            }, Unmanaged.passUnretained(self).toOpaque())
            let source = String(cString: dsh_spike_res_scenario_b1_web_live_js(nil))
            if dsh_spike_eval(host, "scenario/b1-web-live.js", source) != 0 {
                onFailure?("web-boot eval: \(String(cString: dsh_spike_error(host)))")
                return
            }
            guard let plugins else {
                onFailure?("web-boot: Documents/web-plugins is not staged "
                    + "(run tools/e2e/run-ios-b1.sh)")
                return
            }
            deliver(["type": "web.plugins", "plugins": plugins])
            if dsh_spike_pump(host) != 0 {
                onFailure?("web-boot pump: \(String(cString: dsh_spike_error(host)))")
            }
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
/// One staged file → base64 (nil when the runner did not stage it).
private static func stagedFileB64(_ url: URL) -> String? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return data.base64EncodedString()
}

/// The staged web-plugin delivery from Documents/web-plugins: the pinned
/// vendored package files, base64, with the fixed generation stamp
/// (`mtimeMs: 0` — the same stamp the CLI runner pins).
static func webPluginsDelivery() -> [[String: Any]]? {
    let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    let pkg = docs.appendingPathComponent(
        "web-plugins/npm/@deepseek-ai/dsh-client-modules@0.1.6-alpha.2",
        isDirectory: true)
    let vfsRoot = "/web-plugins/npm/@deepseek-ai/dsh-client-modules@0.1.6-alpha.2"
    var files: [String: Any] = [:]
    let staged = [("package.json", "\(vfsRoot)/package.json"),
        ("lib/client.js", "\(vfsRoot)/lib/client.js")]
    for (rel, vfsPath) in staged {
        guard let b64 = stagedFileB64(pkg.appendingPathComponent(rel)) else { return nil }
        files[vfsPath] = ["b64": b64, "mtimeMs": 0]
    }
    return [[
        "loaderName": "@deepseek-ai/dsh-client-modules",
        "pkgJsonPath": "\(vfsRoot)/package.json",
        "entryPath": "\(vfsRoot)/lib/index.js",
        "files": files,
    ]]
}
}
