import Foundation
import WebKit

/// The b1 same-origin probe (platform-side per the M3 rendered-state
/// precedent): the page is untouched upstream code — the probe defines
/// `__b1Run`, which fetches the runtime graph's combo URL, opens the mux
/// journal, posts one unary RPC, waits for the official facade to go live,
/// then waits (bounded) for the APPLICATION MOUNT — the boot page disposing
/// means the UI renderer service mounted the real shell. The TRUE rendered
/// state (boot page text incl. any failure report, root structure, a text
/// sample) is reported as-is. Split from OfficialWebRuntime to keep the
/// drive under the file-size gate.
enum OfficialWebProbe {
    /// Bounds for the two-phase wait: facade live (bootstrap bundle
    /// materialized), then the application mount (all entries activated).
    static let liveWaitMs = 5000
    static let mountWaitMs = 45000
    static let textSampleLimit = 200

    /// The rendered-state half of the probe (appended into `__b1Run`): wait
    /// for the official facade to go live, then wait for the APPLICATION
    /// MOUNT — the boot page (`[data-dsh-boot]`) disposing with a populated
    /// root is exactly the UI renderer mounting the real shell. The TRUE
    /// rendered state (boot text incl. any failure report, root structure,
    /// a text sample) is reported as-is.
    private static let renderedStateScript: String = """
        const waitFor = async (condition, deadlineMs) => {
          const deadline = Date.now() + deadlineMs;
          while (Date.now() < deadline && !condition()) {
            await new Promise((r) => setTimeout(r, 50));
          }
          return condition();
        };
        out.moduleMode = window.__ModuleLoader__ ? String(window.__ModuleLoader__.mode) : 'none';
        out.live = await waitFor(
          () => window.__ModuleLoader__ && window.__ModuleLoader__.mode === 'live', \(liveWaitMs));
        const readBoot = () => {
          const boot = document.querySelector('[data-dsh-boot]');
          return {boot: boot !== null,
            bootText: boot ? boot.textContent.slice(0, \(textSampleLimit)) : '',
            rootHasChild: ((document.getElementById('root') || {}).childElementCount || 0) > 0};
        };
        out.page = readBoot();
        out.appMounted = await waitFor(() => {
          const state = readBoot();
          return !state.boot && state.rootHasChild;
        }, \(mountWaitMs));
        out.page = readBoot();
        const root = document.getElementById('root') || {};
        out.rootChildCount = root.childElementCount || 0;
        out.rootTextSample = String(root.innerText || '').slice(0, \(textSampleLimit));
        """

    /// Defines `__b1Run` on the page. Step order = manifest order: combo
    /// fetch (plugins.served), WS upgrade (upgrade.accepted), unary RPC
    /// (rpc.observed), mux journal open (session.attached + the unavailable
    /// frame), then the rendered reads — facade live first, then the app
    /// mount, the REAL boot-progression facts beyond "Loading plugins…".
    static func probeScript(comboURL: String) -> String {
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
          \(renderedStateScript)
          return JSON.stringify(out);
        };
        'defined';
        """
    }

    /// Evaluates one script on the page (main thread).
    static func evaluate(
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
    static func awaitPromise(
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

    // ---- probe verdict -------------------------------------------------------

    /// The verdict-relevant read of one probe result: either a drive-fatal
    /// failure message, or the ordered events to emit plus a pass.
    enum Verdict {
        case failure(String)
        case pass(events: [(String, [String: Any])])
    }

    static func verdict(_ json: String) -> Verdict {
        guard let data = json.data(using: .utf8),
              let probe = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let page = probe["page"] as? [String: Any] else {
            return .failure("probe returned no parseable result: \(json.prefix(200))")
        }
        if let combo = probe["combo"] as? String, !combo.hasPrefix("text/javascript") {
            return .failure("probe combo outcome: \(combo)")
        }
        if let rpc = probe["rpc"] as? String, rpc != "error:gateway/unimplemented" {
            // the probe observes the envelope outcome; anything but the
            // structured unavailable answer means the wire shape regressed
            return .failure("probe rpc outcome: \(rpc)")
        }
        // Phase 1: the upstream facade materialized the vendored
        // client-modules bundle and switched to live mode.
        let moduleMode = probe["moduleMode"] as? String ?? "none"
        guard moduleMode == "live" else {
            return .failure("the official module system never went live (mode: \(moduleMode))")
        }
        // Phase 2 (the W-SHELL milestone): the application tier — the boot
        // page disposes exactly when the UI renderer mounts the real shell.
        // A failed activation would keep the boot page visible with the
        // failure report in bootText (surfaced honestly below).
        let appMounted = (probe["appMounted"] as? Bool) ?? false
        guard appMounted else {
            return .failure("the application tier never mounted — boot page still visible, "
                + "bootText: \(page["bootText"] as? String ?? "")")
        }
        return .pass(events: [
            ("module.system.live", ["mode": moduleMode,
                "bootstrap": "@deepseek-ai/dsh-client-modules (vendored)"]),
            ("app.shell.rendered", [
                "mounted": appMounted,
                "rootHasChild": (page["rootHasChild"] as? Bool) ?? false,
                "bootPageDisposed": (page["boot"] as? Bool) == false,
            ]),
            ("page.rendered", [
                "boot": (page["boot"] as? Bool) ?? false,
                "rootHasChild": (page["rootHasChild"] as? Bool) ?? false,
                "bootText": (page["bootText"] as? String) ?? "",
                "moduleMode": moduleMode,
            ]),
        ])
    }
}
