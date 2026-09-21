import Foundation
import WebKit

/// The b4 same-origin probe (b3 precedent): the page stays untouched
/// upstream code — the probe defines `__b4Pick` / `__b4Type` / `__b4Send`,
/// which drive the OFFICIAL UI like a user: pick the seeded workspace,
/// type into the real composer, click send, and then read the TRUE rendered
/// state (the user bubble + the streamed assistant reply). Split from
/// SessionWriteRuntime to keep both under the file-size gate.
enum SessionWriteProbe {
    /// The typed message and the scripted reply it must render.
    static let messageText = "Say hello from the composer"
    static let expectedReply = "Hello from upstream"
    /// The seeded workspace's title: the profile container's basename
    /// (the staged spike bundle directory).
    static let workspaceTitle = "spike"

    /// Defines the three page functions (each leg its own constant so every
    /// function stays small; the one script installs all of them).
    static func probeScript() -> String {
        """
        window.__b4 = {};
        window.__b4.consoleErrors = [];
        window.addEventListener('unhandledrejection', (e) => {
          window.__b4.consoleErrors.push('unhandled: ' + String(e.reason).slice(0, 300));
        });
        for (const level of ['error', 'warn']) {
          const orig = console[level].bind(console);
          console[level] = (...args) => {
            window.__b4.consoleErrors.push(level + ': '
              + args.map((a) => String(a?.message ?? a)).join(' ').slice(0, 300));
            orig(...args);
          };
        }
        \(clickHelper)
        \(pickLeg)
        \(typeLeg)
        \(sendLeg);
        'defined';
        """
    }

    /// A user-like press: the full pointer sequence, not just click (the
    /// official components bind pointerdown/up handlers).
    static let clickHelper = """
        window.__b4.press = (el) => {
          const r = el.getBoundingClientRect();
          const o = {bubbles: true, cancelable: true, view: window,
            clientX: r.x + r.width / 2, clientY: r.y + r.height / 2};
          for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(t, {...o, pointerType: 'mouse'}));
          }
        };
        window.__b4.dismiss = async () => {
          for (let i = 0; i < 6; i++) {
            const cont = [...document.querySelectorAll('button')].find((b) =>
              b.getClientRects().length > 0
                && (b.innerText || '').trim() === '继续');
            if (cont === undefined) break;
            window.__b4.press(cont);
            await new Promise((r) => setTimeout(r, 600));
          }
        };
        window.__b4.composer = () => {
          const visible = (sel) => [...document.querySelectorAll(sel)]
            .filter((el) => el.getClientRects().length > 0);
          return visible('textarea')[0] || visible('[contenteditable="true"]')[0]
            || visible('input[type="text"]')[0];
        };
        """

    /// Leg 1: reach the chat view — the official picker is a CHIP
    /// (`aria-label` = "Choose workspace"/选择工作区) that opens a MENU of
    /// workspace rows: click the chip, then the seeded workspace's row, then
    /// wait (bounded) for the composer.
    static let pickLeg = """
        window.__b4.pick = async () => {
          const out = {};
          // The one-time welcome notice (welcomeContinue "继续") cannot
          // persist its confirmation on the read-only mobile settings — it
          // reappears every boot and blocks input. Dismiss it every time.
          await window.__b4.dismiss();
          out.notice = (document.body.innerText || '').includes('内测声明');
          const chip = document.querySelector(
            'button[aria-label="选择工作区"], button[aria-label="Choose workspace"]');
          out.chip = chip !== null;
          if (chip) window.__b4.press(chip);
          await new Promise((r) => setTimeout(r, 600));
          const deadline = Date.now() + 20000;
          while (Date.now() < deadline && !window.__b4.composer()) {
            const rows = [...document.querySelectorAll('div,button,li,a')].filter((el) => {
              const t = (el.innerText || '').trim();
              return t === '\(workspaceTitle)' && el.getClientRects().length > 0;
            });
            const row = rows[rows.length - 1];
            if (row) { window.__b4.press(row); break; }
            await new Promise((r) => setTimeout(r, 150));
          }
          while (Date.now() < deadline && !window.__b4.composer()) {
            await new Promise((r) => setTimeout(r, 150));
          }
          out.composer = window.__b4.composer() !== undefined;
          out.bodyText = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 240);
          return JSON.stringify(out);
        };
        """

    /// Leg 2: type the message into the REAL composer. The editor is a
    /// rich contenteditable — place the caret explicitly and insert via
    /// execCommand, verifying the applied value, with bounded retries.
    static let typeLeg = """
        window.__b4.type = async (text) => {
          const read = (el) => String(el.value ?? el.innerText ?? '').trim();
          await window.__b4.dismiss();
          let el = window.__b4.composer();
          if (el === undefined) return JSON.stringify({found: 'none',
            bodyText: (document.body.innerText || '').slice(0, 240)});
          for (let attempt = 0; attempt < 10 && read(el) !== text; attempt++) {
            await window.__b4.dismiss();
            window.__b4.press(el);
            el.focus();
            const sel = window.getSelection();
            sel.removeAllRanges();
            const range = document.createRange();
            range.selectNodeContents(el);
            range.collapse(false);
            sel.addRange(range);
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
              const proto = el.tagName === 'TEXTAREA'
                ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
              el.dispatchEvent(new Event('input', {bubbles: true}));
            } else if (el.isContentEditable) {
              document.execCommand('insertText', false, text);
            } else { continue; } // editor not enabled yet — retry
            await new Promise((r) => setTimeout(r, 250));
            el = window.__b4.composer() ?? el;
          }
          return JSON.stringify({found: el.tagName.toLowerCase(),
            className: String(el.className || '').slice(0, 80),
            editable: el.isContentEditable,
            value: read(el).slice(0, 120),
            buttons: [...document.querySelectorAll('button')].map((b) => ({
              t: (b.innerText || '').trim().slice(0, 16),
              cls: String(b.className || '').slice(0, 40),
              dis: b.disabled,
              vis: b.getClientRects().length > 0,
            })).filter((b) => b.t).slice(0, 14),
            active: document.activeElement ? document.activeElement.tagName : 'none',
          });
        };
        """

    /// Leg 3: send (the composer's send button, falling back to Enter), then
    /// wait for the REAL rendered reply — the user bubble and the assistant
    /// text both visible in the official DOM. Diagnostics: a parallel raw
    /// mux subscriber records every `session/follow` frame the runtime fans
    /// out, so a rendering gap is attributable to wire vs page.
    static let sendLeg = """
        window.__b4.send = async () => {
          const out = {};
          const frames = [];
          await window.__b4.dismiss();
          const el = window.__b4.composer();
          const buttons = [...document.querySelectorAll('button')].filter((b) =>
            b.getClientRects().length > 0 && !b.disabled);
          const target = buttons.find((b) =>
            /send|发送/i.test((b.innerText || '').trim()
              + (b.getAttribute('aria-label') || b.title || '')));
          if (el !== undefined && target) {
            window.__b4.press(target);
          } else if (el !== undefined) {
            el.focus();
            el.dispatchEvent(new KeyboardEvent('keydown',
              {bubbles: true, cancelable: true, key: 'Enter', code: 'Enter'}));
          }
          out.sent = el !== undefined;
          // The session is CREATED by the send: wait for its id, then attach
          // the diagnostic follow (a pre-send attach would carry no session).
          let sessionId = '';
          const idDeadline = Date.now() + 10000;
          while (Date.now() < idDeadline && sessionId === '') {
            sessionId = (document.body.innerText.match(/session-[0-9a-f-]{30,40}/) || [''])[0];
            await new Promise((r) => setTimeout(r, 100));
          }
          out.sessionId = sessionId;
          const ws2 = new WebSocket('ws://' + location.host + '/api/remote.mux');
          ws2.onopen = () => {
            ws2.send(JSON.stringify({type: 'open', streamId: 'b4-probe-follow',
              endpoint: 'session/follow',
              payload: {args: {request: {address: {kind: 'session', sessionId},
                assistantStream: true}}}}));
            ws2.onmessage = (ev) => {
              const f = JSON.parse(ev.data);
              if (f.streamId === 'b4-probe-follow' && f.type === 'item') frames.push(f.value);
            };
          };
          const deadline = Date.now() + 40000;
          while (Date.now() < deadline) {
            const text = document.body.innerText || '';
            if (text.includes('\(expectedReply)')) {
              await new Promise((r) => setTimeout(r, 1200));
              break;
            }
            await new Promise((r) => setTimeout(r, 120));
          }
          try { ws2.close(); } catch (e) {}
          try { el.blur(); } catch (e) {} // drop the keyboard so the reply shot shows the transcript
          out.reply = (document.body.innerText || '').includes('\(expectedReply)');
          out.frames = frames.length;
          out.errors = window.__b4.consoleErrors.slice(0, 8);
          out.frameShapes = frames.map((f) => f.type === 'event' ? 'event:' + f.event.type
            : f.type === 'assistant-stream' ? 'as:' + f.frame.type + ':' + f.frame.revision
            : f.type + (f.type === 'snapshot' ? ':' + f.assistantStream.revision : ''));
          const boot = document.querySelector('[data-dsh-boot]');
          out.page = {boot: boot !== null,
            rootHasChild: ((document.getElementById('root') || {}).childElementCount || 0) > 0,
            bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 400)};
          return JSON.stringify(out);
        };
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

    /// Runs one async page expression and AWAITS its promise (b3 precedent:
    /// plain evaluateJavaScript would return the Promise object itself).
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

    /// Parses one leg's JSON result (nil → the leg returned no parseable
    /// state; the caller fails the drive with the raw prefix).
    static func parse(_ raw: Any?) -> [String: Any]? {
        guard let text = raw as? String,
              let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return json
    }
}
