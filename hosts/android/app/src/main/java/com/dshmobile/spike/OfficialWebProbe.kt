package com.dshmobile.spike

import android.webkit.WebView
import org.json.JSONObject

/**
 * The official-web same-origin probe (platform-side per the M3 rendered-state
 * precedent): the page is untouched upstream code — the probe defines
 * `__b1Run`, which fetches the runtime graph's combo URL, opens the mux
 * journal, posts one unary RPC, waits for the official facade to go live,
 * then waits (bounded) for the APPLICATION MOUNT — the boot page disposing
 * means the UI renderer service mounted the real shell. The TRUE rendered
 * state (boot page text incl. any failure report, root structure, a text
 * sample) is reported as-is. The Android WebView cannot await a Promise from
 * evaluateJavascript, so the run posts its JSON result through the
 * `dshProbe` JavascriptInterface (event-driven, no polling). Kotlin sibling
 * of hosts/ios OfficialWebProbe.swift.
 */
object OfficialWebProbe {
    /** Bounds for the two-phase wait: facade live (bootstrap bundle
     * materialized), then the application mount (all entries activated). */
    const val liveWaitMs = 5000
    const val mountWaitMs = 45000
    const val textSampleLimit = 200

    /** Defines `__b1Run` on the page. Step order = manifest order: combo
     * fetch (plugins.served), WS upgrade (upgrade.accepted), unary RPC
     * (rpc.observed), mux journal open (session.attached + the unavailable
     * frame), then the rendered reads — facade live first, then the app
     * mount, the REAL boot-progression facts beyond "Loading plugins…". The
     * result JSON lands via dshProbe.post (the JS interface below). */
    fun probeScript(comboURL: String): String = """
        window.__b1Run = async () => {
          const out = {};
          const waitFor = async (condition, deadlineMs) => {
            const deadline = Date.now() + deadlineMs;
            while (Date.now() < deadline && !condition()) {
              await new Promise((r) => setTimeout(r, 50));
            }
            return condition();
          };
          const combo = await fetch('$comboURL', {credentials: 'same-origin'});
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
          out.moduleMode = window.__ModuleLoader__ ? String(window.__ModuleLoader__.mode) : 'none';
          out.live = await waitFor(
            () => window.__ModuleLoader__ && window.__ModuleLoader__.mode === 'live', $liveWaitMs);
          const readBoot = () => {
            const boot = document.querySelector('[data-dsh-boot]');
            return {boot: boot !== null,
              bootText: boot ? boot.textContent.slice(0, $textSampleLimit) : '',
              rootHasChild: ((document.getElementById('root') || {}).childElementCount || 0) > 0};
          };
          out.page = readBoot();
          out.appMounted = await waitFor(() => {
            const state = readBoot();
            return !state.boot && state.rootHasChild;
          }, $mountWaitMs);
          out.page = readBoot();
          const root = document.getElementById('root') || {};
          out.rootChildCount = root.childElementCount || 0;
          out.rootTextSample = String(root.innerText || '').slice(0, $textSampleLimit);
          dshProbe.post(JSON.stringify(out));
        };
        'defined';
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
        failureCause(probe, page)?.let { return Verdict.Failure(it) }
        return Verdict.Pass(passEvents(probe, page))
    }

    /** The ordered hard checks over one probe result (combo content type,
     * rpc envelope shape, facade live, application mount); null = all pass. */
    private fun failureCause(probe: JSONObject, page: JSONObject): String? {
        val combo = probe.optString("combo", "")
        if (combo.isNotEmpty() && !combo.startsWith("text/javascript")) {
            return "probe combo outcome: $combo"
        }
        val rpc = probe.optString("rpc", "")
        if (rpc.isNotEmpty() && rpc != "error:gateway/unimplemented") {
            // the probe observes the envelope outcome; anything but the
            // structured unavailable answer means the wire shape regressed
            return "probe rpc outcome: $rpc"
        }
        // Phase 1: the upstream facade materialized the vendored
        // client-modules bundle and switched to live mode.
        val moduleMode = probe.optString("moduleMode", "none")
        if (moduleMode != "live") {
            return "the official module system never went live (mode: $moduleMode)"
        }
        // Phase 2 (the W-SHELL milestone): the application tier — the boot
        // page disposes exactly when the UI renderer mounts the real shell.
        // A failed activation would keep the boot page visible with the
        // failure report in bootText (surfaced honestly below).
        val appMounted = probe.optBoolean("appMounted", false)
        if (!appMounted) {
            return "the application tier never mounted — boot page still visible, " +
                "bootText: ${page.optString("bootText")}"
        }
        return null
    }

    /** The ordered evidence events for a passing probe (the boot-progression
     * facts beyond "Loading plugins…"). */
    private fun passEvents(probe: JSONObject, page: JSONObject): List<Pair<String, JSONObject>> {
        val moduleMode = probe.optString("moduleMode", "none")
        val appMounted = probe.optBoolean("appMounted", false)
        return listOf(
            "module.system.live" to JSONObject()
                .put("mode", moduleMode)
                .put("bootstrap", "@deepseek-ai/dsh-client-modules (vendored)"),
            "app.shell.rendered" to JSONObject()
                .put("mounted", appMounted)
                .put("rootHasChild", page.optBoolean("rootHasChild"))
                .put("bootPageDisposed", !page.optBoolean("boot", true)),
            "page.rendered" to JSONObject()
                .put("boot", page.optBoolean("boot", true))
                .put("rootHasChild", page.optBoolean("rootHasChild"))
                .put("bootText", page.optString("bootText"))
                .put("moduleMode", moduleMode),
        )
    }
}
