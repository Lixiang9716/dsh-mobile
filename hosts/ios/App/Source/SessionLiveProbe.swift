import Foundation
import WebKit

/// The b3 same-origin probe (platform-side, M3 rendered-state precedent):
/// the page is untouched upstream code — the probe defines `__b3Run`, posts
/// the REAL session.list RPC through the official envelope, attaches the
/// mux session/journal stream for the session the runtime reports, collects
/// the journal frames (baseline + the live turn-2 stream), and reads the
/// TRUE rendered state. Split from SessionLiveRuntime to keep the drive
/// under the file-size gate.
enum SessionLiveProbe {
    /// Expected journal shape (frozen from the observed on-device runs):
    /// the FIRST scripted turn's full log rides the baseline — header +
    /// context folds included — and the second turn streams LIVE after the
    /// attach with the shorter log (its header/context folds reuse the
    /// turn-1 state). 19 frames, contiguous seqs 0..18.
    static let baselineTypes = [
        "agent/inbox/spliced", "turn/start", "agent/inbox/spliced", "step/start",
        "system/message", "user/message", "request/header", "request/context",
        "assistant/message", "step/end", "turn/end",
    ]
    static let liveTypes = [
        "agent/inbox/spliced", "turn/start", "agent/inbox/spliced", "step/start",
        "user/message", "assistant/message", "step/end", "turn/end",
    ]

    /// Defines `__b3Run` on the page. Step order: real RPC (session.list),
    /// mux upgrade + journal attach for the reported session, frame
    /// collection until two assistant/message events quiet down, then the
    /// rendered read. The legs are separate constants (each stays under the
    /// function-size gate; interpolation assembles the one script).
    static func probeScript() -> String {
        """
        window.__b3Run = async () => {
          const out = {};
          \(postHelper)
          \(shellSettleLeg)
          \(sessionListLeg)
          \(journalLeg)
          \(renderedLeg)
          return JSON.stringify(out);
        };
        'defined';
        """
    }

    /// The official unary-RPC envelope poster (client-request/server-response).
    private static let postHelper = """
        const post = (endpoint, payload) => fetch('/api/' + endpoint, {
          method: 'POST', credentials: 'same-origin',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({type: 'client-request',
            rpcId: 'b3-probe-' + endpoint + '-' + Math.random().toString(36).slice(2, 8),
            method: endpoint, payload}),
        }).then((r) => r.json());
        """

    /// Leg 0: wait (bounded) for the official shell to reach its
    /// workspace-selection state, then pace ONE quiet window (3s) so the
    /// UI's boot-RPC burst is fully observed before the probe's own calls —
    /// the manifest's probe-after-UI order is deterministic by construction.
    private static let shellSettleLeg = """
        const shellSettle = async () => {
          const deadline = Date.now() + 20000;
          while (Date.now() < deadline) {
            const text = (document.body.innerText || '');
            if (text.includes('\u{9009}\u{62e9}\u{5de5}\u{4f5c}\u{533a}')) {
              await new Promise((r) => setTimeout(r, 3000));
              return 'shell';
            }
            await new Promise((r) => setTimeout(r, 100));
          }
          return 'shell-timeout';
        };
        out.shell = await shellSettle();
        """

    /// Leg 1: the REAL session.list answer + the reported session identity.
    private static let sessionListLeg = """
        const rpc = await post('session.list', {args: {}});
        out.rpc = rpc && rpc.type === 'server-response'
          ? (rpc.result.ok === true ? 'ok' : 'error:' + (rpc.result.error || {}).code)
          : 'malformed';
        const items = (rpc.result && rpc.result.ok && rpc.result.value && rpc.result.value.items) || [];
        out.sessions = items.length;
        out.blank = items.length > 0 ? !!items[0].blank : null;
        out.running = items.length > 0 ? !!items[0].running : null;
        const sessionId = items.length > 0 ? items[0].sessionId : null;
        out.sessionId = String(sessionId);
        """

    /// Leg 2: attach the session/journal stream and collect frames until the
    /// baseline AND the live turn-2 have both arrived (two assistant/message
    /// events, then a quiet window — never timing trust).
    private static let journalLeg = """
        const frames = [];
        out.mux = await new Promise((resolve) => {
          const ws = new WebSocket('ws://' + location.host + '/api/remote.mux');
          const done = (verdict) => { try { ws.close(); } catch (e) {} resolve(verdict); };
          const t = setTimeout(() => done('timeout'), 20000);
          ws.onopen = () => {
            ws.onmessage = (ev) => {
              const frame = JSON.parse(ev.data);
              if (frame.streamId !== 'b3-probe-journal') return;
              if (frame.type === 'item') frames.push(frame.value);
              if (frame.type === 'error') { clearTimeout(t); done('error:' + (frame.error || {}).code); }
            };
            ws.send(JSON.stringify({type: 'open', streamId: 'b3-probe-journal',
              endpoint: 'session/journal', payload: {args: {address: {sessionId}}}}));
            let lastArrival = Date.now();
            let seen = 0;
            const watch = setInterval(() => {
              const events = frames.filter((f) => f && f.event).map((f) => f.event);
              if (events.length > seen) { lastArrival = Date.now(); seen = events.length; }
              const turnsDone = events.filter((e) => e.type === 'assistant/message').length;
              if (turnsDone >= 2 && Date.now() - lastArrival > 1500) {
                clearInterval(watch); clearTimeout(t); done('frames');
              }
            }, 100);
          };
          ws.onerror = () => { clearTimeout(t); done('ws-error'); };
        });
        const events = frames.filter((f) => f && f.event).map((f) => f.event);
        out.journal = {
          frames: events.length,
          types: events.map((e) => e.type),
          firstSeq: events.length > 0 ? events[0].seq : null,
          lastSeq: events.length > 0 ? events[events.length - 1].seq : null,
        };
        """

    /// Leg 3: the rendered read — module-system liveness + the TRUE shell
    /// state (the upstream DOM, reported as-is).
    private static let renderedLeg = """
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline
            && (!window.__ModuleLoader__ || window.__ModuleLoader__.mode !== 'live')) {
          await new Promise((r) => setTimeout(r, 50));
        }
        out.moduleMode = window.__ModuleLoader__ ? String(window.__ModuleLoader__.mode) : 'none';
        const boot = document.querySelector('[data-dsh-boot]');
        out.page = {boot: boot !== null,
          bootText: boot ? boot.textContent.slice(0, 160) : '',
          rootHasChild: ((document.getElementById('root') || {}).childElementCount || 0) > 0,
          bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300)};
        """

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
        guard checkSessionList(probe) else {
            return .failure(journalError(probe))
        }
        guard let journal = checkJournal(probe) else {
            return .failure(journalError(probe))
        }
        // The official module system went live (REAL boot progression).
        let moduleMode = probe["moduleMode"] as? String ?? "none"
        guard moduleMode == "live" else {
            return .failure("the official module system never went live (mode: \(moduleMode))")
        }
        let types = journal["types"] as? [String] ?? []
        return .pass(events: [
            ("session.list.real", [
                "sessions": probe["sessions"] ?? -1,
                "blank": probe["blank"] ?? true,
                "running": probe["running"] ?? true,
                "sessionId": probe["sessionId"] ?? "",
            ]),
            ("session.journal.real", [
                "frames": types.count,
                "baseline": baselineTypes.count,
                "live": liveTypes.count,
                "lastType": types.last ?? "",
            ]),
            ("module.system.live", ["mode": moduleMode,
                "bootstrap": "@deepseek-ai/dsh-client-modules (vendored)"]),
            ("page.rendered", [
                "boot": (page["boot"] as? Bool) ?? false,
                "rootHasChild": (page["rootHasChild"] as? Bool) ?? false,
                "moduleMode": moduleMode,
                "bodyText": (page["bodyText"] as? String) ?? "",
            ]),
        ])
    }

    /// Leg 1 checks: the REAL session.list answer — ok, exactly the
    /// configured agent session, non-blank (the turn's log exists).
    private static func checkSessionList(_ probe: [String: Any]) -> Bool {
        probe["shell"] as? String == "shell"
            && probe["rpc"] as? String == "ok"
            && probe["sessions"] as? Int == 1
            && (probe["blank"] as? Bool) == false
    }

    /// Leg 2 checks: the REAL journal — the first turn's full log in the
    /// baseline, then turn 2 streamed live, contiguous seqs. Returns nil
    /// when a check failed (the reason is in journalError).
    private static func checkJournal(_ probe: [String: Any]) -> [String: Any]? {
        guard probe["mux"] as? String == "frames",
              let journal = probe["journal"] as? [String: Any],
              let types = journal["types"] as? [String],
              types == baselineTypes + liveTypes,
              journal["firstSeq"] as? Int == 0,
              journal["lastSeq"] as? Int == baselineTypes.count + liveTypes.count - 1
        else { return nil }
        return journal
    }

    /// The first failed leg's diagnosis, in manifest order.
    private static func journalError(_ probe: [String: Any]) -> String {
        if probe["shell"] as? String != "shell" {
            return "the official shell never reached its workspace state: "
                + "\(probe["shell"] ?? "nil")"
        }
        if probe["rpc"] as? String != "ok" {
            return "probe session.list outcome: \(probe["rpc"] ?? "nil")"
        }
        if probe["sessions"] as? Int != 1 {
            return "probe session.list sessions: \(probe["sessions"] ?? -1)"
        }
        if (probe["blank"] as? Bool) != false {
            return "the reported session is blank (no session log)"
        }
        if probe["mux"] as? String != "frames" {
            return "probe journal outcome: \(probe["mux"] ?? "nil")"
        }
        if let journal = probe["journal"] as? [String: Any],
           let types = journal["types"] as? [String] {
            if types != baselineTypes + liveTypes {
                return "journal frame types mismatch: \(types.count) frames, "
                    + "expected \((baselineTypes + liveTypes).count): \(types)"
            }
            return "journal seq range not contiguous: "
                + "\(journal["firstSeq"] ?? -1)..\(journal["lastSeq"] ?? -1)"
        }
        return "probe journal frames missing"
    }
}
