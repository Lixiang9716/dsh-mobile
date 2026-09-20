package com.dshmobile.spike

import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject

/**
 * The b-android session-live same-origin probe (platform-side; Kotlin
 * sibling of hosts/ios SessionLiveProbe.swift): the page is untouched
 * upstream code — the probe defines `__dshSessionRun`, posts the REAL
 * session.list RPC through the official envelope, attaches the mux
 * session/journal stream for the session the runtime reports, collects the
 * journal frames (baseline + the live turn-2 stream), and reads the TRUE
 * rendered state. The Android WebView cannot await a Promise from
 * evaluateJavascript, so the run posts its JSON result through the
 * `dshProbe` JavascriptInterface (event-driven, no polling).
 */
object SessionLiveProbe {

    /** Expected journal shape (frozen from the observed on-device runs, the
     * iOS sibling included): the FIRST scripted turn's full log rides the
     * baseline — header + context folds included — and the second turn
     * streams LIVE after the attach with the shorter log. 19 frames,
     * contiguous seqs 0..18. */
    val baselineTypes = listOf(
        "agent/inbox/spliced", "turn/start", "agent/inbox/spliced", "step/start",
        "system/message", "user/message", "request/header", "request/context",
        "assistant/message", "step/end", "turn/end",
    )
    val liveTypes = listOf(
        "agent/inbox/spliced", "turn/start", "agent/inbox/spliced", "step/start",
        "user/message", "assistant/message", "step/end", "turn/end",
    )

    private const val STREAM_ID = "bandroid-probe-journal"
    private const val SHELL_MARK = "\u9009\u62e9\u5de5\u4f5c\u533a"

    /** Defines `__dshSessionRun` on the page. Step order: the official shell
     * settle, the real RPC (session.list), mux upgrade + journal attach for
     * the reported session, frame collection until two assistant/message
     * events quiet down, then the rendered read. The result JSON lands via
     * dshProbe.post. Each leg is a separate constant (each stays under the
     * function-size gate; interpolation assembles the one script). */
    fun probeScript(): String = """
        window.__dshSessionRun = async () => {
          const out = {};
          $postHelper
          $shellSettleLeg
          $sessionListLeg
          $journalLeg
          $renderedLeg
          dshProbe.post(JSON.stringify(out));
        };
        'defined';
    """.trimIndent()

    /** The official unary-RPC envelope poster (client-request/server-response). */
    private val postHelper = """
        const post = (endpoint, payload) => fetch('/api/' + endpoint, {
          method: 'POST', credentials: 'same-origin',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify({type: 'client-request',
            rpcId: 'bandroid-probe-' + endpoint + '-' + Math.random().toString(36).slice(2, 8),
            method: endpoint, payload}),
        }).then((r) => r.json());
    """.trimIndent()

    /** Leg 0: wait (bounded) for the official shell to reach its
     * workspace-selection state, then pace ONE quiet window (3s) so the
     * UI's boot-RPC burst is fully observed before the probe's own calls —
     * the manifest's probe-after-UI order is deterministic by construction.
     * The marker matches BOTH upstream locales (the shell's text follows the
     * WebView locale: zh 选择工作区 / en Choose workspace — the iOS sibling
     * only needed the zh row on a zh simulator). The bound is 60s (the iOS
     * sibling's 20s assumed a device-class WebView; the emulator's recovery
     * backoff retries measurably slower — bound, never pace). */
    private val shellSettleLeg = """
        const shellSettle = async () => {
          const deadline = Date.now() + 60000;
          while (Date.now() < deadline) {
            const text = (document.body.innerText || '');
            if (text.includes('$SHELL_MARK') || text.includes('Choose workspace')) {
              await new Promise((r) => setTimeout(r, 3000));
              return 'shell';
            }
            await new Promise((r) => setTimeout(r, 100));
          }
          return 'shell-timeout';
        };
        out.shell = await shellSettle();
    """.trimIndent()

    /** Leg 1: the REAL session.list answer + the reported session identity. */
    private val sessionListLeg = """
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
    """.trimIndent()

    /** Leg 2: attach the session/journal stream and collect frames until the
     * baseline AND the live turn-2 have both arrived (two assistant/message
     * events, then a quiet window — never timing trust). */
    private val journalLeg = """
        const frames = [];
        out.mux = await new Promise((resolve) => {
          const ws = new WebSocket('ws://' + location.host + '/api/remote.mux');
          const done = (verdict) => { try { ws.close(); } catch (e) {} resolve(verdict); };
          const t = setTimeout(() => done('timeout'), 20000);
          ws.onopen = () => {
            ws.onmessage = (ev) => {
              const frame = JSON.parse(ev.data);
              if (frame.streamId !== '$STREAM_ID') return;
              if (frame.type === 'item') frames.push(frame.value);
              if (frame.type === 'error') { clearTimeout(t); done('error:' + (frame.error || {}).code); }
            };
            ws.send(JSON.stringify({type: 'open', streamId: '$STREAM_ID',
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
    """.trimIndent()

    /** Leg 3: the rendered read — module-system liveness + the TRUE shell
     * state (the upstream DOM, reported as-is). */
    private val renderedLeg = """
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
          bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300)};
    """.trimIndent()

    /** Evaluates one script on the page (UI thread required by the WebView). */
    fun evaluate(webView: WebView, script: String) {
        webView.post { webView.evaluateJavascript(script, null) }
    }

    // ---- probe verdict -------------------------------------------------------

    /** The verdict-relevant read of one probe result: either a drive-fatal
     * failure message, or the ordered events to emit plus a pass. */
    sealed class Verdict {
        data class Failure(val message: String) : Verdict()
        data class Pass(val events: List<Pair<String, JSONObject>>) : Verdict()
    }

    fun verdict(json: String): Verdict {
        val probe = try {
            JSONObject(json)
        } catch (_: Exception) {
            return Verdict.Failure("probe returned no parseable result: ${json.take(200)}")
        }
        val page = probe.optJSONObject("page")
            ?: return Verdict.Failure("probe returned no parseable result: ${json.take(200)}")
        failureCause(probe)?.let { return Verdict.Failure(it) }
        val journal = probe.optJSONObject("journal") ?: JSONObject()
        val types = toStringList(journal.optJSONArray("types"))
        return Verdict.Pass(
            listOf(
                "session.list.real" to JSONObject()
                    .put("sessions", probe.optInt("sessions", -1))
                    .put("blank", probe.optBoolean("blank", true))
                    .put("running", probe.optBoolean("running", true))
                    .put("sessionId", probe.optString("sessionId")),
                "session.journal.real" to JSONObject()
                    .put("frames", types.size)
                    .put("baseline", baselineTypes.size)
                    .put("live", liveTypes.size)
                    .put("lastType", types.lastOrNull() ?: ""),
                "module.system.live" to JSONObject()
                    .put("mode", probe.optString("moduleMode"))
                    .put("bootstrap", "@deepseek-ai/dsh-client-modules (vendored)"),
                "page.rendered" to JSONObject()
                    .put("boot", page.optBoolean("boot", true))
                    .put("rootHasChild", page.optBoolean("rootHasChild"))
                    .put("moduleMode", probe.optString("moduleMode"))
                    .put("bodyText", page.optString("bodyText")),
            ),
        )
    }

    /** The ordered hard checks over one probe result; null = all pass. */
    private fun failureCause(probe: JSONObject): String? {
        if (probe.optString("shell") != "shell") {
            return "the official shell never reached its workspace state: " +
                probe.optString("shell", "nil")
        }
        if (probe.optString("rpc") != "ok") {
            return "probe session.list outcome: ${probe.optString("rpc", "nil")}"
        }
        if (probe.optInt("sessions", -1) != 1) {
            return "probe session.list sessions: ${probe.optInt("sessions", -1)}"
        }
        if (probe.optBoolean("blank", true)) {
            return "the reported session is blank (no session log)"
        }
        if (probe.optString("mux") != "frames") {
            return "probe journal outcome: ${probe.optString("mux", "nil")}"
        }
        val journal = probe.optJSONObject("journal") ?: JSONObject()
        val types = toStringList(journal.optJSONArray("types"))
        val expected = baselineTypes + liveTypes
        if (types != expected) {
            return "journal frame types mismatch: ${types.size} frames, " +
                "expected ${expected.size}: $types"
        }
        if (journal.optInt("firstSeq", -1) != 0 ||
            journal.optInt("lastSeq", -1) != expected.size - 1
        ) {
            return "journal seq range not contiguous: " +
                "${journal.optInt("firstSeq", -1)}..${journal.optInt("lastSeq", -1)}"
        }
        val moduleMode = probe.optString("moduleMode", "none")
        if (moduleMode != "live") {
            return "the official module system never went live (mode: $moduleMode)"
        }
        return null
    }

    private fun toStringList(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        return (0 until array.length()).mapNotNull { runCatching { array.getString(it) }.getOrNull() }
    }
}
