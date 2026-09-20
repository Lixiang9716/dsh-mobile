package com.dshmobile.spike

import android.webkit.WebView
import org.json.JSONObject

/**
 * The b-android write-live same-origin probe (platform-side; Kotlin sibling
 * of hosts/ios SessionWriteProbe.swift and of SessionLiveProbe): the page is
 * untouched upstream code — the probe defines `__dshWritePick` /
 * `__dshWriteType` / `__dshWriteSend`, which drive the OFFICIAL UI like a
 * user: pick the seeded workspace from the official picker, type into the
 * real composer, click send, and then read the TRUE rendered state (the
 * user bubble + the streamed assistant reply). The Android WebView cannot
 * await a Promise from evaluateJavascript, so each leg posts its JSON
 * result through the `dshProbe` JavascriptInterface with a `leg` tag
 * (event-driven, no polling); SessionWriteSession runs the legs in order.
 */
object SessionWriteProbe {

    /** The typed message and the scripted reply it must render. */
    const val MESSAGE_TEXT = "Say hello from the composer"
    const val EXPECTED_REPLY = "Hello from upstream"

    /** The seeded workspace's title: the profile container's basename (the
     * staged spike bundle directory). */
    const val WORKSPACE_TITLE = "spike"

    private const val FOLLOW_STREAM_ID = "bandroid-probe-follow"

    /** Defines the three page functions (each leg its own constant so every
     * function stays small; the one script installs all of them). */
    fun probeScript(): String = """
        window.__b4w = {};
        window.__b4w.consoleErrors = [];
        window.addEventListener('unhandledrejection', (e) => {
          window.__b4w.consoleErrors.push('unhandled: ' + String(e.reason).slice(0, 300));
        });
        $clickHelper
        $pickLeg
        $typeLeg
        $sendLeg;
        'defined';
    """.trimIndent()

    /** A user-like press: the full pointer sequence, not just click (the
     * official components bind pointerdown/up handlers). */
    private val clickHelper = """
        window.__b4w.press = (el) => {
          const r = el.getBoundingClientRect();
          const o = {bubbles: true, cancelable: true, view: window,
            clientX: r.x + r.width / 2, clientY: r.y + r.height / 2};
          for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(t, {...o, pointerType: 'mouse'}));
          }
        };
        window.__b4w.dismiss = async () => {
          let hits = 0;
          for (let i = 0; i < 6; i++) {
            const cont = [...document.querySelectorAll('button')].find((b) =>
              b.getClientRects().length > 0
                && /^(继续|Continue)$/.test((b.innerText || '').trim()));
            if (cont === undefined) break;
            window.__b4w.press(cont);
            hits++;
            await new Promise((r) => setTimeout(r, 600));
          }
          return hits;
        };
        window.__b4w.composer = () => {
          const visible = (sel) => [...document.querySelectorAll(sel)]
            .filter((el) => el.getClientRects().length > 0);
          return visible('textarea')[0] || visible('[contenteditable="true"]')[0]
            || visible('input[type="text"]')[0];
        };
    """.trimIndent()

    /** Leg 1: reach the chat view — the official picker is a CHIP
     * (`aria-label` = "Choose workspace"/选择工作区) that opens a MENU of
     * workspace rows: dismiss the welcome notice, click the chip, then the
     * seeded workspace's row, then wait (bounded) for the composer. */
    private val pickLeg = """
        window.__dshWritePick = async () => {
          const out = {leg: 'pick'};
          out.dismissed = await window.__b4w.dismiss();
          out.notice = (document.body.innerText || '').includes('内测声明');
          const chip = document.querySelector(
            'button[aria-label="选择工作区"], button[aria-label="Choose workspace"]');
          out.chip = chip !== null;
          if (chip) window.__b4w.press(chip);
          await new Promise((r) => setTimeout(r, 600));
          const deadline = Date.now() + 20000;
          while (Date.now() < deadline && !window.__b4w.composer()) {
            const rows = [...document.querySelectorAll('div,button,li,a')].filter((el) => {
              const t = (el.innerText || '').trim();
              return t === '$WORKSPACE_TITLE' && el.getClientRects().length > 0;
            });
            const row = rows[rows.length - 1];
            if (row) { window.__b4w.press(row); break; }
            await new Promise((r) => setTimeout(r, 150));
          }
          while (Date.now() < deadline && !window.__b4w.composer()) {
            await new Promise((r) => setTimeout(r, 150));
          }
          out.composer = window.__b4w.composer() !== undefined;
          out.bodyText = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 240);
          dshProbe.post(JSON.stringify(out));
        };
    """.trimIndent()

    /** Leg 2: type the message into the REAL composer. The editor is a rich
     * contenteditable — place the caret explicitly and insert via
     * execCommand, verifying the applied value, with bounded retries. */
    private val typeLeg = """
        window.__dshWriteType = async () => {
          const out = {leg: 'type'};
          const text = '$MESSAGE_TEXT';
          const read = (el) => String(el.value ?? el.innerText ?? '').trim();
          await window.__b4w.dismiss();
          let el = window.__b4w.composer();
          if (el === undefined) {
            dshProbe.post(JSON.stringify({leg: 'type', found: 'none',
              bodyText: (document.body.innerText || '').slice(0, 240)}));
            return;
          }
          for (let attempt = 0; attempt < 10 && read(el) !== text; attempt++) {
            window.__b4w.press(el);
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
            } else {
              await new Promise((r) => setTimeout(r, 250));
              continue;
            }
            await new Promise((r) => setTimeout(r, 250));
            el = window.__b4w.composer() ?? el;
          }
          out.found = el.tagName.toLowerCase();
          out.editable = el.isContentEditable;
          out.value = read(el).slice(0, 120);
          out.active = document.activeElement ? document.activeElement.tagName : 'none';
          dshProbe.post(JSON.stringify(out));
        };
    """.trimIndent()

    /** Leg 3: send (the composer's send button, falling back to Enter), then
     * wait for the REAL rendered reply — the user bubble and the assistant
     * text both visible in the official DOM. Diagnostics: a raw mux
     * subscriber attaches the page session's `session/follow` AFTER the
     * reply settles, so the frame evidence is timing-independent (the
     * settled snapshot carries the turn's final assistant-stream revision;
     * liveness itself is proven by the runtime's turn events, not this
     * subscriber). */
    private val sendLeg = """
        window.__dshWriteSend = async () => {
          const out = {leg: 'send'};
          const frames = [];
          await window.__b4w.dismiss();
          // The welcome notice re-renders a few cycles while its settings
          // write settles; require it continuously gone for 5s (pressing
          // any re-appearance away) so the pre-send snapshot shows the
          // composer, not the modal.
          let goneFor = 0;
          const settleDeadline = Date.now() + 30000;
          while (Date.now() < settleDeadline && goneFor < 5000) {
            const text = document.body.innerText || '';
            const cont = [...document.querySelectorAll('button')].find((b) =>
              b.getClientRects().length > 0
                && /^(继续|Continue)$/.test((b.innerText || '').trim()));
            if (!text.includes('Internal Testing') && !text.includes('内测声明')
              && cont === undefined) {
              goneFor += 250;
            } else {
              goneFor = 0;
              if (cont !== undefined) window.__b4w.press(cont);
            }
            await new Promise((r) => setTimeout(r, 250));
          }
          const el = window.__b4w.composer();
          // Pre-send snapshot marker: the composer still holds the typed
          // message with the notice dismissed — the typed-composer shot.
          // The host acks via __b4wGo once its screenshot has landed.
          dshProbe.post(JSON.stringify({leg: 'presend',
            found: el !== undefined ? el.tagName.toLowerCase() : 'none',
            value: el !== undefined ? String(el.value ?? el.innerText ?? '').trim().slice(0, 120) : ''}));
          const goDeadline = Date.now() + 15000;
          while (window.__b4wGo !== true && Date.now() < goDeadline) {
            const cont = [...document.querySelectorAll('button')].find((b) =>
              b.getClientRects().length > 0
                && /^(继续|Continue)$/.test((b.innerText || '').trim()));
            if (cont !== undefined) window.__b4w.press(cont);
            await new Promise((r) => setTimeout(r, 200));
          }
          const buttons = [...document.querySelectorAll('button')].filter((b) =>
            b.getClientRects().length > 0 && !b.disabled);
          const target = buttons.find((b) =>
            /send|发送/i.test((b.innerText || '').trim()
              + (b.getAttribute('aria-label') || b.title || '')));
          if (el !== undefined && target) {
            window.__b4w.press(target);
          } else if (el !== undefined) {
            el.focus();
            el.dispatchEvent(new KeyboardEvent('keydown',
              {bubbles: true, cancelable: true, key: 'Enter', code: 'Enter'}));
          }
          out.sent = el !== undefined;
          const replyDeadline = Date.now() + 40000;
          while (Date.now() < replyDeadline) {
            if ((document.body.innerText || '').includes('$EXPECTED_REPLY')) {
              await new Promise((r) => setTimeout(r, 1200));
              break;
            }
            await new Promise((r) => setTimeout(r, 120));
          }
          // Resolve the page session's id from the REAL session.list answer
          // (the minted identity is the `session-<uuid>` shape; the runtime
          // agent's configured id is not), with the DOM text as fallback.
          let sessionId = '';
          const idDeadline = Date.now() + 10000;
          while (Date.now() < idDeadline && sessionId === '') {
            try {
              const rpc = await fetch('/api/session.list', {
                method: 'POST', credentials: 'same-origin',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({type: 'client-request',
                  rpcId: 'bandroid-probe-id-' + Math.random().toString(36).slice(2, 8),
                  method: 'session.list', payload: {args: {}}}),
              }).then((r) => r.json());
              const items = (rpc.result && rpc.result.ok && rpc.result.value &&
                rpc.result.value.items) || [];
              const hit = items.map((i) => String(i.sessionId || ''))
                .find((id) => /^session-[0-9a-f-]{30,40}$/.test(id));
              if (hit !== undefined) sessionId = hit;
            } catch (e) {}
            if (sessionId === '') {
              sessionId = (document.body.innerText.match(/session-[0-9a-f-]{30,40}/) || [''])[0];
            }
            if (sessionId === '') await new Promise((r) => setTimeout(r, 200));
          }
          out.sessionId = sessionId;
          out.mux = await new Promise((resolve) => {
            const ws2 = new WebSocket('ws://' + location.host + '/api/remote.mux');
            const done = (verdict) => { try { ws2.close(); } catch (e) {} resolve(verdict); };
            const t = setTimeout(() => done('timeout'), 10000);
            ws2.onopen = () => {
              ws2.onmessage = (ev) => {
                const f = JSON.parse(ev.data);
                if (f.streamId !== '$FOLLOW_STREAM_ID') return;
                if (f.type === 'item') frames.push(f.value);
                if (f.type === 'error') { clearTimeout(t); done('error'); }
              };
              ws2.send(JSON.stringify({type: 'open', streamId: '$FOLLOW_STREAM_ID',
                endpoint: 'session/follow',
                payload: {args: {request: {address: {kind: 'session', sessionId},
                  assistantStream: true}}}}));
            };
            ws2.onerror = () => { clearTimeout(t); done('ws-error'); };
            const watch = setInterval(() => {
              if (frames.length >= 1) { clearInterval(watch); clearTimeout(t); done('frames'); }
            }, 100);
          });
          try { el.blur(); } catch (e) {}
          const bootDeadline = Date.now() + 5000;
          while (Date.now() < bootDeadline
              && (!window.__ModuleLoader__ || window.__ModuleLoader__.mode !== 'live')) {
            await new Promise((r) => setTimeout(r, 50));
          }
          out.moduleMode = window.__ModuleLoader__ ? String(window.__ModuleLoader__.mode) : 'none';
          out.reply = (document.body.innerText || '').includes('$EXPECTED_REPLY');
          out.frames = frames.length;
          out.errors = window.__b4w.consoleErrors.slice(0, 8);
          out.frameShapes = frames.map((f) => f.type === 'event' ? 'event:' + f.event.type
            : f.type === 'assistant-stream' ? 'as:' + f.frame.type + ':' + f.frame.revision
            : f.type + (f.type === 'snapshot' ? ':' + f.assistantStream.revision : ''));
          const boot = document.querySelector('[data-dsh-boot]');
          out.page = {boot: boot !== null,
            rootHasChild: ((document.getElementById('root') || {}).childElementCount || 0) > 0,
            bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400)};
          dshProbe.post(JSON.stringify(out));
        };
    """.trimIndent()

    /** Evaluates one script on the page (UI thread required by the WebView). */
    fun evaluate(webView: WebView, script: String) {
        webView.post { webView.evaluateJavascript(script, null) }
    }

    /** One parsed probe leg result, or null (the caller fails the drive
     * with the raw prefix). */
    fun parse(json: String, leg: String): JSONObject? {
        val probe = try {
            JSONObject(json)
        } catch (_: Exception) {
            return null
        }
        return if (probe.optString("leg") == leg) probe else null
    }
}
