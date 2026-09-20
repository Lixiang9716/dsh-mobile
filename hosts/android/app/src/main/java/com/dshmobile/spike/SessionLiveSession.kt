package com.dshmobile.spike

import android.app.Activity
import android.os.Handler
import android.util.Log
import android.webkit.WebView
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/**
 * Drives `b-android.session.live` (the Android D9 session leg): the FULL
 * upstream agent spine boots ON-DEVICE (upstream/boot.js over the staged
 * vendor closure — ctx.sessions / agents / agentLoop / tools / systemPrompt
 * / projections / settings + the vendored dsh-llm LlmRuntime whose transport
 * is the REAL gateway httpFetch against the carrier's SCRIPTED
 * chat-completions endpoint), and the official web boot wire is composed on
 * the SAME runtime context. The runtime CLAIMS `/api/session.list` and the
 * mux `session/journal` streams over the bus seam (SessionLiveSeam folds the
 * claims + answers into the carrier bridge), so the official UI's boot
 * passes the session attach leg with REAL data: one real scripted-llm turn
 * BEFORE the page loads (the journal baseline) and one streamed LIVE into
 * the attached page after it. The probe drives the read path through the
 * official envelope; endpoints the spine does not implement stay
 * structured-unavailable, never faked. Kotlin sibling of hosts/ios
 * SessionLiveRuntime.swift; JS runs ONLY on SpikeRuntime's HandlerThread.
 */
class SessionLiveSession private constructor(private val activity: Activity) {

    companion object {
        const val SCENARIO = "b-android.session.live"
        const val ENTRY = "scenario/b-android-session-live.js"
        const val CLIENT_ID = "dsh-web-official"
        // Bound, not pacing: the drive's stages carry their own deadlines
        // (spine boot + two turns before the page, composition + page boot +
        // probe bounded below); 270s sits inside the runner's 300s phase
        // window (the official-web drive measured the same budget).
        const val WATCHDOG_SECONDS = 270

        private const val TAG = "dsh.spike"
        private const val RESULT_TAG = "dsh.spike.result"
        private const val ENGINE_LABEL = "quickjs-ng 0.17.0"
        private const val BOOT_SOURCE =
            "runtime (spine + vendored @deepseek-ai/dsh-client-modules)"

        /** The gateway descriptor of the session-live runtime: the spine
         * exercises the gateway (httpFetch for the llm transport), mirroring
         * the iOS drive's gateway wiring; the registered handler set is
         * fs + httpFetch — anything else settles denied (fail loud). */
        private val DESCRIPTOR: String = JSONObject()
            .put("available", JSONArray(GatewayCore.PRIMITIVES))
            .put("unavailable", JSONArray())
            .toString()

        @Volatile private var instance: SessionLiveSession? = null

        /** Creates and starts the session; [onFinished] gets the verdict text. */
        fun start(activity: Activity, webView: WebView?, onFinished: (String) -> Unit): SessionLiveSession {
            val session = SessionLiveSession(activity)
            session.webView = webView
            instance = session
            session.start(onFinished)
            return session
        }

        /** The WebView finished a document load (UI thread, from the client). */
        fun dispatchPageFinished() = instance?.pageDidFinish()

        /** The probe's async result (JavaBridge thread, from the interface). */
        fun dispatchProbeResult(json: String) = instance?.onProbeResult(json)
    }

    private val carrier = CarrierServer()
    private val eventLog = CarrierEventLog(SCENARIO)
    private lateinit var plugins: CarrierPlugins
    private lateinit var bridge: CarrierAPIBridge
    private lateinit var dist: CarrierWebDist
    private lateinit var core: GatewayCore
    private lateinit var seam: SessionLiveSeam

    private var onFinished: ((String) -> Unit)? = null
    private var handle: Long = 0
    private var finished = false
    private var token = ""
    private var webView: WebView? = null

    // once-guards for the page hooks; `comboPending` holds an early combo
    // arrival until the asset event fixed the report order (mirrored from
    // the official-web drive).
    private var assetLogged = false
    private var comboLogged = false
    private var comboPending: Pair<String, Int>? = null
    private var originLoaded = false

    // the runtime's `web.boot` facts, nil until received
    private var webBootRows: JSONArray? = null
    private var runtimeBootApplied = false
    private var comboURL = ""

    private fun start(onFinished: (String) -> Unit) {
        this.onFinished = onFinished
        SpikeRuntime.post {
            try {
                begin()
            } catch (e: Exception) {
                fail("session-live bootstrap: ${e::class.java.simpleName}: ${e.message}")
            }
        }
        Handler(activity.mainLooper).postDelayed(
            {
                if (!finished) {
                    fail("session-live watchdog: drive did not complete in $WATCHDOG_SECONDS s")
                }
            },
            WATCHDOG_SECONDS * 1000L,
        )
    }

    /** Runtime thread: builds the route table per the contract (official dist
     * fallback + /plugins + /api + the scripted llm endpoint), starts
     * listening, and boots the session-live runtime half. */
    private fun begin() {
        val files = activity.filesDir
        val staged = WebPluginsDelivery.build(File(files, "web-plugins"))
            ?: throw IllegalStateException(
                "web-plugins is not staged (the E2E runner stages it; " +
                    "a fresh install cannot boot the official app)",
            )
        token = randomToken()
        plugins = CarrierPlugins.staged(File(files, "web-plugins"))
        val config = CarrierBootConfig.default(plugins)
        comboURL = batchURL(config.bootGraphJSON) ?: ""
        dist = CarrierWebDist(
            distRoot = File(files, "official-web/dist"),
            sessionToken = token,
            indexRows = { runtimeRows() },
        )
        bridge = CarrierAPIBridge(token)
        bridge.deliverToRuntime = { msg -> deliverRuntime(msg) }
        seam = SessionLiveSeam(bridge)
        seam.onEvent = { event, fields -> eventLog.emit(event, fields) }
        wireEvidence()
        carrier.registerFallback(dist.handler)
        carrier.register(CarrierRouteKind.PREFIX, "/plugins") { request, out ->
            plugins.handler(request, out)
        }
        bridge.install(carrier)
        carrier.onWSFrame = { text, path -> bridge.ingestFrame(text, path) }
        carrier.register(CarrierRouteKind.EXACT, MockLlmRoute.PATH) { request, out ->
            MockLlmRoute.serve(request, out)
        }
        carrier.start(File(files, "spike/webclient/web")) { /* readiness below */ }
        eventLog.emit(
            "client.selected",
            JSONObject().put("client", CLIENT_ID).put("source", "launch"),
        )
        startSessionLiveRuntime(staged)
    }

    /** Wires the drive's evidence hooks (carrier conn threads) onto the seam
     * and the page hooks this drive owns directly. */
    private fun wireEvidence() {
        dist.onIndexRendered = { rows, bytes ->
            eventLog.emit(
                "index.rendered",
                JSONObject().put("rows", rows).put("bytes", bytes),
            )
        }
        dist.onIndexServed = {
            eventLog.emit("index.served", JSONObject().put("path", "/").put("status", 200))
        }
        dist.onAssetServed = { path -> observeAsset(path) }
        plugins.onComboServed = { url, bytes -> observeCombo(url, bytes) }
        bridge.onUpgradeAccepted = { path -> seam.observeUpgrade(path) }
        bridge.onAPICall = { endpoint, answered -> seam.observeRPC(endpoint, answered) }
        bridge.onMuxOpen = { streamId, endpoint -> seam.observeMuxOpen(streamId, endpoint) }
        bridge.onMuxFrame = { direction, kind -> seam.observeMuxFrame(direction, kind) }
    }

    // ---- once-guarded asset/combo ordering (mirrored from official-web) ----

    /** The entry JS chunk is the deterministic first-fetch evidence (the
     * `.js` suffix is load-bearing: which of the dist's index-*.css/js the
     * page fetches first is a browser race). */
    @Synchronized
    private fun observeAsset(path: String) {
        if (!path.startsWith("/assets/index-") || !path.endsWith(".js")) return
        if (assetLogged) return
        assetLogged = true
        eventLog.emit("asset.served", JSONObject().put("path", path))
        val combo = comboPending ?: return
        if (comboLogged) return
        comboLogged = true
        eventLog.emit(
            "plugins.served",
            JSONObject().put("path", combo.first).put("bytes", combo.second),
        )
    }

    /** Single-emission combo report; an early arrival waits in `comboPending`
     * for the fixed report order. */
    @Synchronized
    private fun observeCombo(url: String, bytes: Int) {
        if (comboLogged) return
        if (!assetLogged) {
            comboPending = url to bytes
            return
        }
        comboLogged = true
        eventLog.emit("plugins.served", JSONObject().put("path", url).put("bytes", bytes))
    }

    // ---- the session-live runtime half ---------------------------------------

    /** Evals the scenario through the frozen bridge, wires the gateway
     * (fs scope + httpFetch for the llm transport), and delivers
     * runtime.config (scripted llm endpoint + profile container) followed by
     * the staged `web.plugins` files. Runtime thread. */
    private fun startSessionLiveRuntime(pluginsDelivery: JSONArray) {
        val bundle = File(activity.filesDir, "spike")
        core = GatewayCore.create(bundle)
        val fs = FsPrimitives(activity)
        fs.register(core)
        val http = HttpPrimitive()
        http.register(core)
        core.settleFn = { callId, ok, json ->
            SpikeRuntime.post {
                if (finished) return@post
                onRuntimeStatus(SpikeRuntime.m4Settle(handle, callId, ok, json))
            }
        }
        http.eventFn = { json ->
            SpikeRuntime.post {
                if (finished) return@post
                onRuntimeStatus(SpikeRuntime.m4Event(handle, json))
            }
        }
        val entry = File(bundle, ENTRY)
        handle = SpikeRuntime.m4Begin(
            activity.filesDir.absolutePath, ENTRY, entry.readText(), DESCRIPTOR,
            "b-android-session-live", runtimeBridge,
        )
        if (handle == 0L) throw IllegalStateException("session-live begin: ${SpikeRuntime.m4LastError()}")
        deliverRuntime(
            JSONObject()
                .put("type", "runtime.config")
                .put("mockLlmUrl", "http://127.0.0.1:${carrier.port}/mock-llm")
                .put("apiKey", MockLlmRoute.KEY)
                .put("containerRoot", bundle.absolutePath),
        )
        deliverRuntime(
            JSONObject().put("type", "web.plugins").put("plugins", pluginsDelivery),
        )
    }

    /** The M4Bridge the C host calls back (runtime thread): gateway calls
     * dispatch into the core; bus messages fold into the web-boot row
     * application (web.boot) or the claims seam (everything else). The
     * scenario's own completion is NOT the verdict — the probe's is. */
    private val runtimeBridge = object : SpikeRuntime.M4Bridge {
        override fun onGatewayCall(callId: Int, name: String, args: String) {
            if (finished) return
            core.dispatch(callId, name, args)
        }

        override fun onBusLine(line: String) {
            if (finished) return
            val msg = try {
                JSONObject(line)
            } catch (_: Exception) {
                return
            }
            if (msg.optString("type") == "web.boot") {
                applyWebBoot(msg)
            } else if (!seam.onBusMessage(msg)) {
                fail("session-live: unknown bus message '${msg.optString("type")}'")
            }
        }
    }

    /** Runtime thread: the runtime's `web.boot` rows replace the carrier
     * defaults and its plugin revs override the /plugins route. */
    private fun applyWebBoot(msg: JSONObject) {
        val rows = msg.optJSONArray("rows") ?: return
        webBootRows = rows
        msg.optJSONObject("graph")?.let { graph ->
            batchURL(graph.toString())?.let { comboURL = it }
        }
        msg.optJSONArray("plugins")?.let { pluginRows ->
            val list = ArrayList<Map<String, Any>>()
            for (i in 0 until pluginRows.length()) {
                val row = pluginRows.getJSONObject(i)
                val map = HashMap<String, Any>()
                for (key in row.keys()) map[key] = row.get(key)
                list.add(map)
            }
            plugins.applyRuntimeRevs(list)
        }
        runtimeBootApplied = true
        eventLog.emit(
            "web.boot.applied",
            JSONObject().put("rows", runtimeRows().size).put("source", BOOT_SOURCE),
        )
        maybeOpenOrigin()
    }

    /** The injection rows the index renders: the runtime's `web.boot` rows
     * once received (plus the recovery global), else none (the origin never
     * opens before the runtime wire lands). Runtime thread; called per
     * render. Mirrors OfficialWebSession.runtimeRows. */
    private fun runtimeRows(): List<CarrierIndexInjection> {
        val rows = webBootRows ?: return emptyList()
        val out = ArrayList<CarrierIndexInjection>()
        for (i in 0 until rows.length()) {
            injectionRow(rows.getJSONObject(i))?.let { out.add(it) }
        }
        out.add(
            CarrierIndexInjection.global(
                "__DSH_CONNECTION_RECOVERY__",
                CarrierIndexInjection.jsonGlobalValue(CarrierBootConfig.recoveryDefaults),
            ),
        )
        return out
    }

    /** One upstream row shape → the carrier's typed injection row. */
    private fun injectionRow(row: JSONObject): CarrierIndexInjection? = when (row.optString("kind")) {
        "script" -> row.optString("text").takeIf { it.isNotEmpty() }
            ?.let { CarrierIndexInjection.script(it) }
        "script-src" -> row.optString("src").takeIf { it.isNotEmpty() }
            ?.let { CarrierIndexInjection.scriptSrc(it) }
        "script-preload" -> row.optString("src").takeIf { it.isNotEmpty() }
            ?.let { CarrierIndexInjection.scriptPreload(it) }
        "global" -> {
            val name = row.optString("name")
            val value = row.optString("value")
            if (name.isEmpty() || value.isEmpty()) null
            else CarrierIndexInjection.global(name, value)
        }
        else -> null
    }

    /** Carrier → runtime: one bus delivery (any thread; hops onto the runtime
     * thread — the bridge hands over claimed api.request / mux.open frames
     * here). The scenario's own completion status is NOT the verdict. */
    private fun deliverRuntime(msg: JSONObject) {
        SpikeRuntime.post {
            if (finished || handle == 0L) return@post
            val status = SpikeRuntime.m4BusDeliver(handle, msg.toString())
            if (status < 0) fail("session-live bus deliver: ${SpikeRuntime.m4LastError()}")
        }
    }

    /** 0 = running, 1 = pass, 2 = fail, -1 = error (gateway settle/event).
     * A scenario pass is ignored on purpose (the iOS sibling's owner does the
     * same): the session-live scenario stays RESIDENT on success and the
     * verdict is the probe's, never the scenario's completion. */
    private fun onRuntimeStatus(status: Int) {
        when (status) {
            0, 1 -> {}
            2 -> fail("session-live: scenario completed with pass=false")
            else -> fail("session-live runtime: ${SpikeRuntime.m4LastError()}")
        }
    }

    // ---- origin + page evidence -------------------------------------------------

    /** Opens the origin once BOTH the port is bound and the runtime's
     * `web.boot` has been applied (UI thread, once). */
    @Synchronized
    private fun maybeOpenOrigin() {
        if (!runtimeBootApplied || carrier.port == 0 || originLoaded || finished) return
        originLoaded = true
        val port = carrier.port
        activity.runOnUiThread {
            webView?.loadUrl("http://127.0.0.1:$port/?token=$token")
        }
    }

    /** The document finished loading: the head subresources (entry chunk,
     * styles) have arrived; wait for the entry-chunk evidence, then run the
     * same-origin probe and read the TRUE rendered state. UI thread. */
    private fun pageDidFinish() {
        if (finished) return
        Thread({
            // rule 8: poll the arrival condition with a deadline, fail loud
            val deadline = System.currentTimeMillis() + 30_000
            while (!assetLogged && System.currentTimeMillis() < deadline) {
                Thread.sleep(100)
            }
            if (!assetLogged) {
                fail("session-live: the entry chunk never arrived")
                return@Thread
            }
            runProbe()
        }, "dsh-session-probe").start()
    }

    /** Runs the probe script in the page: the REAL session.list RPC, the mux
     * journal attach for the reported session, frame collection (baseline +
     * live turn), then the rendered-state read. The async result arrives via
     * dispatchProbeResult (the WebView cannot await a Promise). */
    private fun runProbe() {
        val view = webView
        if (view == null) {
            fail("session-live: no WebView attached")
            return
        }
        SessionLiveProbe.evaluate(view, SessionLiveProbe.probeScript())
        SessionLiveProbe.evaluate(view, "window.__dshSessionRun()")
    }

    /** JavaBridge thread: the probe's JSON result → verdict → settle. */
    private fun onProbeResult(json: String) {
        if (finished) return
        when (val outcome = SessionLiveProbe.verdict(json)) {
            is SessionLiveProbe.Verdict.Failure -> fail(outcome.message)
            is SessionLiveProbe.Verdict.Pass -> {
                for ((event, fields) in outcome.events) eventLog.emit(event, fields)
                finish(true, "")
            }
        }
    }

    // ---- settling ---------------------------------------------------------------

    private fun fail(message: String) {
        Log.i(TAG, "session-live FAIL $message")
        finish(false, message)
    }

    private fun finish(passed: Boolean, error: String) {
        if (finished) return
        finished = true
        val line = "$SCENARIO ${if (passed) "PASS" else "FAIL"} | $ENGINE_LABEL" +
            (if (error.isEmpty()) "" else " | error: $error")
        Log.i(RESULT_TAG, line)
        Log.i(RESULT_TAG, "ALL ${if (passed) "PASS" else "FAIL"}")
        if (handle != 0L) SpikeRuntime.m4End(handle)
        handle = 0
        carrier.stop()
        instance = null
        val verdict = line
        activity.runOnUiThread { onFinished?.invoke(verdict) }
    }

    private fun randomToken(): String {
        val bytes = ByteArray(16)
        java.security.SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { "%02x".format(it) }
    }

    /** The application batch's combo URL from the injected graph JSON. */
    private fun batchURL(graphJSON: String): String? = try {
        JSONObject(graphJSON).optJSONArray("batches")?.getJSONObject(0)?.optString("url")
    } catch (_: Exception) {
        null
    }
}
