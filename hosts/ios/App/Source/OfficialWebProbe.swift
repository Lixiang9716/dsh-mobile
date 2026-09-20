import Foundation
import WebKit

/// The b1 same-origin probe (platform-side per the M3 rendered-state
/// precedent): the page is untouched upstream code — the probe defines
/// `__b1Run`, which fetches the runtime graph's combo URL, opens the mux
/// journal, posts one unary RPC, waits for the official facade to go live,
/// and reads the TRUE rendered state. Split from OfficialWebRuntime to keep
/// the drive under the file-size gate.
enum OfficialWebProbe {
    /// Defines `__b1Run` on the page. Step order = manifest order: combo
    /// fetch (plugins.served), WS upgrade (upgrade.accepted), unary RPC
    /// (rpc.observed), mux journal open (session.attached + the unavailable
    /// frame), then the rendered read — which waits (bounded) for the
    /// official facade to switch from the injected queue to the live module
    /// system, the REAL boot-progression fact beyond the failure screen.
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
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline
              && (!window.__ModuleLoader__ || window.__ModuleLoader__.mode !== 'live')) {
            await new Promise((r) => setTimeout(r, 50));
          }
          out.moduleMode = window.__ModuleLoader__ ? String(window.__ModuleLoader__.mode) : 'none';
          const boot = document.querySelector('[data-dsh-boot]');
          out.page = {boot: boot !== null,
            bootText: boot ? boot.textContent.slice(0, 160) : '',
            rootHasChild: ((document.getElementById('root') || {}).childElementCount || 0) > 0};
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
        // The REAL boot-progression fact: the upstream facade materialized
        // the vendored client-modules bundle and switched to live mode (the
        // client module system is up; the app shell state is reported as-is).
        let moduleMode = probe["moduleMode"] as? String ?? "none"
        guard moduleMode == "live" else {
            return .failure("the official module system never went live (mode: \(moduleMode))")
        }
        return .pass(events: [
            ("module.system.live", ["mode": moduleMode,
                "bootstrap": "@deepseek-ai/dsh-client-modules (vendored)"]),
            ("page.rendered", [
                "boot": (page["boot"] as? Bool) ?? false,
                "rootHasChild": (page["rootHasChild"] as? Bool) ?? false,
                "bootText": (page["bootText"] as? String) ?? "",
                "moduleMode": moduleMode,
            ]),
        ])
    }
}
