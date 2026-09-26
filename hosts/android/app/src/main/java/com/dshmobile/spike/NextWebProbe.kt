package com.dshmobile.spike

import android.webkit.WebView
import org.json.JSONObject

/**
 * The nextweb.mount same-origin probe (platform-side; Kotlin sibling of
 * hosts/ios NextWebProbe.swift): the page is untouched self-hosted code —
 * the probe defines `__next` legs that drive OUR UI like a user. Unlike the
 * iOS probe (stateless one-shot legs + drive-side polling, because a driven
 * WKWebView throttles page timers to near-zero), the Android WebView keeps
 * page timers live — every leg is an async page function with its own
 * bounded waits that posts its JSON result through the `dshProbe`
 * JavascriptInterface with a `leg` tag (the SessionWriteProbe channel).
 */
object NextWebProbe {
    /** The typed messages and the reply fragment the drive waits for — the
     * carrier's scripted-loopback pair. The second message carries SLOW_TURN
     * (the drip-script marker the cancel leg streams against); the third
     * carries CREATE_TURN (the scripted write+present tool round). */
    const val MESSAGE_TEXT = "Say hello from the next client"
    const val CANCEL_MESSAGE_TEXT = "SLOW_TURN keep going"
    const val CREATE_MESSAGE_TEXT = "CREATE_TURN 请创建一只游动的蓝色鲸鱼"
    const val EXPECTED_REPLY = "Hello from upstream"
    const val CARD_TITLE = "游动的蓝色鲸鱼 — 点按全屏查看"
    const val CANARY = "BLUE-WHALE-CANARY"
    /** The GAME leg's prompt + card title + canary (the scripted model's
     * second create turn — the canvas game). */
    const val GAME_MESSAGE_TEXT = "GAME_TURN 请做一个Canvas弹球小游戏"
    const val GAME_CARD_TITLE = "弹球小游戏 — 点按全屏查看"
    const val GAME_CANARY = "DSH-GAME-CANARY"

    /** Installs the `__next` legs (each leg its own constant so every
     * function stays small). */
    fun probeScript(): String = """
        window.__next = {};
        $openLeg
        $typeLeg
        $sendLeg
        $replyLeg
        $cancelLeg
        $cardLeg
        $viewerLeg
        $gameCloseLeg
        $gameCardLeg
        $gameViewerLeg;
        'defined';
    """.trimIndent()

    private const val WAIT_HELPER = """
        window.__next.wait = async (condition, deadlineMs) => {
          const deadline = Date.now() + deadlineMs;
          while (Date.now() < deadline && !condition()) {
            await new Promise((r) => setTimeout(r, 100));
          }
          return condition();
        };
    """

    /** Leg 1: home → the new-session card → the chat view (the page's module
     * may register its listener one tick after the DOM paint, so re-tap
     * until the view flips — the runtime's createOrAdopt absorbs extras). */
    private val openLeg = """
        $WAIT_HELPER
        window.__next.open = async () => {
          const out = {leg: 'open'};
          out.chatVisible = await window.__next.wait(() => {
            const chat = document.getElementById('view-chat');
            if (chat && !chat.hidden) return true;
            const button = document.getElementById('new-session');
            if (button) button.click();
            return false;
          }, 15000);
          dshProbe.post(JSON.stringify(out));
        };
    """.trimIndent()

    /** Leg 2: type into the REAL composer (value + input event — the
     * composer's own listener owns the send-button enablement). */
    private val typeLeg = """
        window.__next.type = async (text) => {
          const out = {leg: 'type'};
          const send = document.getElementById('composer-send');
          const input = document.getElementById('composer-input');
          if (!input) {
            out.found = false;
            dshProbe.post(JSON.stringify(out));
            return;
          }
          out.found = true;
          out.sendEnabled = await window.__next.wait(() => {
            input.value = text;
            input.dispatchEvent(new Event('input', {bubbles: true}));
            return !!send && !send.disabled;
          }, 10000);
          out.value = input.value.slice(0, 80);
          dshProbe.post(JSON.stringify(out));
        };
    """.trimIndent()

    /** Leg 3: one press of the send/stop button (which shape it is, the
     * cancel leg reads separately). */
    private val sendLeg = """
        window.__next.send = async () => {
          const send = document.getElementById('composer-send');
          const out = {leg: 'sent', pressed: !!send};
          if (send) {
            send.click();
            out.stopShown = send.classList.contains('stop');
          }
          dshProbe.post(JSON.stringify(out));
        };
    """.trimIndent()

    /** Leg 4: the TRUE rendered transcript — the user bubble, the streamed
     * assistant markdown, the streaming tail gone (the durable message
     * promoted the text). */
    private val replyLeg = """
        window.__next.reply = async (expect) => {
          const out = {leg: 'reply'};
          const read = () => {
            const host = document.getElementById('transcript');
            const assistant = host.querySelector('.item-assistant .md');
            return {
              userShown: host.querySelector('.user-bubble') !== null,
              tailPresent: host.querySelector('.tail-state') !== null,
              assistant: assistant ? assistant.textContent : '',
              items: host.querySelectorAll('.item').length,
              title: document.getElementById('chat-title').textContent,
            };
          };
          const settled = await window.__next.wait(() => {
            const state = read();
            return state.userShown && !state.tailPresent
              && state.assistant.includes(expect);
          }, 45000);
          const state = read();
          Object.assign(out, state, {settled});
          dshProbe.post(JSON.stringify(out));
        };
    """.trimIndent()

    /** Leg 5: the cancel choreography page-side — type the slow-marker
     * prompt, send, wait until the button morphs into a stop (mid-drip),
     * press it, then settle on the 已请求停止 toast (the composer toasts it
     * only on an ok:true answer — never a faked success). */
    private val cancelLeg = """
        window.__next.cancel = async (text) => {
          const out = {leg: 'cancel'};
          const send = document.getElementById('composer-send');
          const input = document.getElementById('composer-input');
          const toast = () => (document.getElementById('toast')?.textContent || '');
          const typed = await window.__next.wait(() => {
            input.value = text;
            input.dispatchEvent(new Event('input', {bubbles: true}));
            return !!send && !send.disabled;
          }, 10000);
          if (!typed) {
            out.fail = 'the composer never took the slow prompt';
            dshProbe.post(JSON.stringify(out));
            return;
          }
          send.click();
          out.stopShown = await window.__next.wait(
            () => send.classList.contains('stop'), 20000);
          if (out.stopShown) send.click();
          out.stopPressed = out.stopShown;
          out.toast = await window.__next.wait(
            () => toast() === '已请求停止', 30000) ? '已请求停止' : toast();
          dshProbe.post(JSON.stringify(out));
        };
    """.trimIndent()

    /** Leg 6: the creation round — WAIT for quiescence first (the previous
     * leg's stop press leaves the optimistic stop state until the aborted
     * turn's events land; sending during that window would read as ANOTHER
     * cancel — a human simply cannot click this fast), then type the
     * create-marker prompt (inline — legs never nest, each posts exactly
     * one result), send, and wait for the rendered creation card. */
    private val cardLeg = """
        window.__next.cancelState = () => {
          const send = document.getElementById('composer-send');
          const dbg = window.__dshComposerDebug ? window.__dshComposerDebug() : {};
          return {stop: !!send && send.classList.contains('stop'),
            optimistic: dbg.optimistic === true};
        };
        window.__next.card = async (text) => {
          const out = {leg: 'card'};
          const send = document.getElementById('composer-send');
          const input = document.getElementById('composer-input');
          const quiet = await window.__next.wait(() => {
            const s = window.__next.cancelState();
            return !s.stop && !s.optimistic;
          }, 30000);
          if (!quiet) {
            out.fail = 'the composer never left its stop state';
            dshProbe.post(JSON.stringify(out));
            return;
          }
          const typed = await window.__next.wait(() => {
            input.value = text;
            input.dispatchEvent(new Event('input', {bubbles: true}));
            return !!send && !send.disabled;
          }, 10000);
          if (!typed) {
            out.fail = 'the composer never took the create prompt';
            dshProbe.post(JSON.stringify(out));
            return;
          }
          send.click();
          out.creationCard = await window.__next.wait(
            () => document.querySelector('.creation-card') !== null, 60000);
          const card = document.querySelector('.creation-card');
          out.title = card ? card.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
          if (!out.creationCard) {
            const host = document.getElementById('transcript');
            out.dump = [...host.querySelectorAll('.item, .group, .tool-row, .md')]
              .map((n) => (n.className.split(' ')[0] || 'div') + ':' +
                n.textContent.replace(/\s+/g, ' ').slice(0, 60)).join(' | ').slice(0, 600);
          }
          dshProbe.post(JSON.stringify(out));
        };
    """.trimIndent()

    /** Leg 7: tap the creation card and wait for the fullscreen viewer's
     * frame to carry the file's own CONTENT (the staged canary). */
    private val viewerLeg = """
        window.__next.viewer = async () => {
          const out = {leg: 'viewer'};
          const card = document.querySelector('.creation-card');
          if (card) card.click();
          const read = () => {
            const frame = document.getElementById('creation-frame');
            const view = document.getElementById('creation-view');
            return {open: !!view && !view.hidden,
              srcdoc: frame ? frame.srcdoc : ''};
          };
          await window.__next.wait(
            () => { const s = read(); return s.open && s.srcdoc.length > 0; }, 30000);
          const state = read();
          Object.assign(out, state);
          dshProbe.post(JSON.stringify(out));
        };
    """.trimIndent()

    /** Game leg A: close the fullscreen viewer (the product page's own
     * close control — it hides the overlay and clears the frame's srcdoc).
     * Posts once per call: the drive invokes it twice (after the whale
     * viewer and after the game viewer) and counts. */
    private val gameCloseLeg = """
        window.__next.gameClose = async () => {
          const out = {leg: 'gameClose'};
          const close = document.getElementById('creation-close');
          if (close) close.click();
          const open = () => {
            const view = document.getElementById('creation-view');
            return !!view && !view.hidden;
          };
          await window.__next.wait(() => !open(), 15000);
          out.closed = !open();
          const frame = document.getElementById('creation-frame');
          out.srcdocCleared = !frame || frame.srcdoc.length === 0;
          dshProbe.post(JSON.stringify(out));
        };
    """.trimIndent()

    /** Game leg B: the game creation round — wait quiescence, type the
     * game-marker prompt, send, and wait for a creation card whose title is
     * the GAME's (the whale's card is already in the transcript — the game
     * card is identified BY TITLE, never by position alone). */
    private val gameCardLeg = """
        window.__next.gameCard = async (text, title) => {
          const out = {leg: 'gameCard'};
          const send = document.getElementById('composer-send');
          const input = document.getElementById('composer-input');
          const quiet = await window.__next.wait(() => {
            const s = window.__next.cancelState
              ? window.__next.cancelState() : {stop: false, optimistic: false};
            return !s.stop && !s.optimistic;
          }, 30000);
          if (!quiet) {
            out.fail = 'the composer never left its stop state';
            dshProbe.post(JSON.stringify(out));
            return;
          }
          const typed = await window.__next.wait(() => {
            input.value = text;
            input.dispatchEvent(new Event('input', {bubbles: true}));
            return !!send && !send.disabled;
          }, 10000);
          if (!typed) {
            out.fail = 'the composer never took the game prompt';
            dshProbe.post(JSON.stringify(out));
            return;
          }
          send.click();
          out.creationCard = await window.__next.wait(() => {
            const cards = document.querySelectorAll('.creation-card');
            for (let i = 0; i < cards.length; i++) {
              if (cards[i].textContent.indexOf(title) !== -1) return true;
            }
            return false;
          }, 60000);
          out.title = title;
          out.items = document.querySelectorAll('#transcript .item').length;
          if (!out.creationCard) {
            out.dump = [...document.querySelectorAll('#transcript .item, #transcript .group')]
              .map((n) => (n.className.split(' ')[0] || 'div') + ':' +
                n.textContent.replace(/\s+/g, ' ').slice(0, 60)).join(' | ').slice(0, 600);
          }
          dshProbe.post(JSON.stringify(out));
        };
    """.trimIndent()

    /** Game leg C: install the heartbeat listener, tap the LAST creation
     * card (the game's), wait for the viewer to carry the game canary, then
     * take TWO heartbeat samples and require the second strictly larger —
     * the game RUNS. The fixture posts its counters to the parent (the
     * sandbox="allow-scripts" iframe is otherwise opaque to us); the
     * listener is probe infrastructure, not product code. */
    private val gameViewerLeg = """
        window.__next.gameViewer = async () => {
          const out = {leg: 'gameViewer'};
          window.__gameFrames = 0; window.__gameBeats = 0;
          window.addEventListener('message', (e) => {
            const d = e.data;
            if (d && d.__dshGame) {
              window.__gameFrames = d.frames || window.__gameFrames;
              window.__gameBeats = d.beats || window.__gameBeats;
            }
          });
          const cards = document.querySelectorAll('.creation-card');
          if (!cards.length) {
            out.fail = 'no creation card';
            dshProbe.post(JSON.stringify(out));
            return;
          }
          cards[cards.length - 1].click();
          const read = () => {
            const frame = document.getElementById('creation-frame');
            const view = document.getElementById('creation-view');
            return {open: !!view && !view.hidden, srcdoc: frame ? frame.srcdoc : ''};
          };
          await window.__next.wait(
            () => { const s = read(); return s.open && s.srcdoc.indexOf('DSH-GAME-CANARY') !== -1; },
            30000);
          const s = read();
          out.open = s.open;
          out.srcdoc = s.srcdoc.slice(0, 200);
          if (!s.open || s.srcdoc.indexOf('DSH-GAME-CANARY') === -1) {
            dshProbe.post(JSON.stringify(out));
            return;
          }
          const total = () => (window.__gameFrames || 0) + (window.__gameBeats || 0);
          await window.__next.wait(() => total() >= 1, 15000);
          const first = total();
          out.advancing = await window.__next.wait(() => total() > first, 15000);
          out.frames = window.__gameFrames || 0;
          out.beats = window.__gameBeats || 0;
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
