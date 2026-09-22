package com.dshmobile.spike

import android.app.Activity
import android.os.Handler
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/**
 * Drives `android.officialweb.mount`: the carrier as a REAL implementation
 * of the upstream `ctx.webServer` contract, mounting the OFFICIAL web app
 * (vendored dist, zero upstream edits) in the Android WebView — with the
 * runtime live: a spike session running the android-officialweb-web-live scenario
 * composes the OFFICIAL boot wire with the vendored client-modules node half
 * and posts `web.boot` over the bus seam; the carrier swaps the delivered
 * rows into the index render pipeline, overrides the /plugins revs, and only
 * then opens the origin, so the page's facade `create()` materializes the
 * REAL upstream browser bundle and boots the real client module system. The
 * same-origin probe runs through the WebView's own fetch/WebSocket. The
 * rendered state is reported HONESTLY: with the boot wire live the page
 * passes the boot-failure screen into the loader progress state, then the
 * application tier mounts the real shell; the /api namespaces and mux
 * streams stay UNCLAIMED (the embedded closure carries no agent spine, so
 * there are no session services) and the carrier answers them structured-
 * unavailable — the next named gap, never faked. Kotlin sibling of hosts/ios
 * OfficialWebRuntime.swift; JS runs ONLY on SpikeRuntime's HandlerThread.
 */
class OfficialWebSession private constructor(
    private val activity: Activity,
    /** Harness: drive for evidence. Release: serve the client, assert nothing. */
    private val evidence: Boolean,
) {

    companion object {
        const val SCENARIO = "android.officialweb.mount"
        const val ENTRY = "scenario/android-officialweb-web-live.js"
        const val CLIENT_ID = "dsh-web-official"
        // Bound, not pacing: the drive's own stages carry their deadlines
        // (composition delivery ~50-110s on the emulator under load, page
        // boot ~40s, probe waits bounded below); 270s sits inside the
        // runner's 300s phase window with margin (the 150s first guess
        // fired mid-boot in the 2026-09-21 full-suite run).
        const val WATCHDOG_SECONDS = 270

        private const val TAG = "dsh.spike"
        private const val RESULT_TAG = "dsh.spike.result"
        private const val ENGINE_LABEL = "quickjs-ng 0.17.0"
        private const val BOOT_SOURCE = "runtime (vendored @deepseek-ai/dsh-client-modules)"
        private const val SERVICES_PENDING_REASON =
            "the first mux stream open was answered gateway/unimplemented; " +
                "the web-boot closure embeds no agent spine — the session API is " +
                "the next named gap"

        /** Compose-only closure: no capability gateway is wired, so nothing is
         * granted (the scenario never calls a primitive — fail loud if it does). */
        private val DESCRIPTOR: String = JSONObject()
            .put("available", JSONArray())
            .put("unavailable", JSONArray())
            .toString()

        @Volatile private var instance: OfficialWebSession? = null

        /** Creates and starts the session; [onFinished] gets the verdict text.
         * [evidence] false is the release SERVING mode: the same carrier +
         * web-boot runtime + official client served, with the probe, the
         * watchdog and every canonical record switched off — a user-facing
         * build runs no verification machinery. */
        fun start(
            activity: Activity,
            webView: WebView?,
            onFinished: (String) -> Unit,
            evidence: Boolean = true,
        ): OfficialWebSession {
            val session = OfficialWebSession(activity, evidence)
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

    private var onFinished: ((String) -> Unit)? = null
    private var handle: Long = 0
    private var finished = false
    private var token = ""
    private var webView: WebView? = null

    // once-guards for the single-emission hooks; `comboPending` holds an early
    // combo arrival until the asset event fixed the report order.
    private var assetLogged = false
    private var comboLogged = false
    private var comboPending: Pair<String, Int>? = null
    private var originLoaded = false

    // the runtime's `web.boot` facts, nil until received
    private var webBootRows: JSONArray? = null
    private var runtimeBootApplied = false
    private var defaultComboURL = ""
    private var comboURL = ""

    private fun start(onFinished: (String) -> Unit) {
        this.onFinished = onFinished
        SpikeRuntime.post {
            try {
                begin()
            } catch (e: Exception) {
                fail("official-web bootstrap: ${e::class.java.simpleName}: ${e.message}")
            }
        }
        // Serving mode has no outcome to wait for; the watchdog is harness-only.
        if (!evidence) return
        Handler(activity.mainLooper).postDelayed(
            {
                if (!finished) {
                    fail("official-web watchdog: drive did not complete in $WATCHDOG_SECONDS s")
                }
            },
            WATCHDOG_SECONDS * 1000L,
        )
    }

    /** Runtime thread: builds the route table per the contract, starts
     * listening, and boots the web-boot runtime half. The origin opens ONLY
     * after the runtime posted `web.boot`, so the page always loads the
     * runtime-composed boot wire. */
    private fun begin() {
        val files = activity.filesDir
        val pluginsRoot = File(files, "web-plugins")
        val staged = WebPluginsDelivery.build(pluginsRoot)
            ?: throw IllegalStateException(
                "web-plugins is not staged (the E2E runner stages it; " +
                    "a fresh install cannot boot the official app)",
            )
        token = randomToken()
        plugins = CarrierPlugins.staged(pluginsRoot)
        val config = CarrierBootConfig.default(plugins)
        defaultComboURL = batchURL(config.bootGraphJSON) ?: ""
        comboURL = defaultComboURL
        dist = CarrierWebDist(
            distRoot = File(files, "official-web/dist"),
            sessionToken = token,
            indexRows = { runtimeRows() },
        )
        // The bridge exists before the evidence wiring reads it (wireEvidence
        // hangs the once-guard hooks off all three route objects).
        bridge = CarrierAPIBridge(token)
        bridge.deliverToRuntime = { msg -> deliverRuntime(msg) }
        wireEvidence()
        carrier.registerFallback(dist.handler)
        carrier.register(CarrierRouteKind.PREFIX, "/plugins") { request, out ->
            plugins.handler(request, out)
        }
        bridge.install(carrier)
        // mux seats → the bridge (the bridge filters to its own path)
        carrier.onWSFrame = { text, path -> bridge.ingestFrame(text, path) }
        carrier.start(File(files, "spike/webclient/web")) { /* readiness below */ }
        eventLog.emit(
            "client.selected",
            JSONObject().put("client", CLIENT_ID).put("source", "launch"),
        )
        startWebBootRuntime(staged)
    }

    /** Wires the drive's evidence hooks (carrier conn threads). Each wire
     * event is SINGLE-EMISSION: with the application tier live the page
     * generates its own traffic (RPCs, mux opens) before the probe's, so the
     * once-guards pin the honest first observations in manifest order. */
    private fun wireEvidence() {
        if (!evidence) return
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
        bridge.onUpgradeAccepted = { path ->
            eventLog.emitOnce("upgrade.accepted", JSONObject().put("path", path))
        }
        bridge.onAPICall = { endpoint, answered ->
            eventLog.emitOnce(
                "rpc.observed",
                JSONObject().put("endpoint", endpoint).put("answered", answered),
            )
        }
        bridge.onMuxOpen = { streamId, endpoint ->
            eventLog.emitOnce(
                "session.attached",
                JSONObject().put("streamId", streamId).put("stream", endpoint),
            )
        }
        bridge.onMuxFrame = { direction, kind ->
            if (direction == "tx" && kind == "error") emitServicesPending()
        }
        bridge.onMuxErrorFrame = { endpoint -> recordMuxErrorLeg(endpoint) }
    }

    /** The honest services-gap leg, once: the first mux stream open was
     * answered gateway/unimplemented (the closure embeds no agent spine). */
    private fun emitServicesPending() {
        eventLog.emitOnce(
            "session.services.pending",
            JSONObject()
                .put("leg", firstMuxErrorLeg() ?: "unknown")
                .put("reason", SERVICES_PENDING_REASON),
        )
    }

    // ---- once-guard state (guarded by the eventLog lock's callers' contract:
    // these read/write from carrier threads; races only widen which FIRST
    // observation wins, never the emitted set — mirrored from the iOS drive.)

    private var firstMuxErrorLeg: String? = null
    private val muxLegLock = Object()

    private fun firstMuxErrorLeg(): String? = synchronized(muxLegLock) { firstMuxErrorLeg }

    private fun recordMuxErrorLeg(endpoint: String) {
        synchronized(muxLegLock) { if (firstMuxErrorLeg == null) firstMuxErrorLeg = endpoint }
    }

    /** The entry JS chunk is the deterministic first-fetch evidence (the
     * `.js` suffix is load-bearing: the dist also ships `index-*.css`, and
     * which of the two the page fetches first is a browser race — run 4 of
     * the 2026-09-21 soak caught the CSS winning). The other dist assets
     * stay unlogged. A combo that already arrived is reported here, keeping
     * the manifest's fixed report order. */
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

    /** Single-emission combo report; an early arrival (before the asset
     * event) waits in `comboPending` for the fixed report order. */
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

    // ---- the web-boot runtime half ------------------------------------------

    /** Evals the scenario through the frozen bridge and delivers the staged
     * `web.plugins` files. Runtime thread. */
    private fun startWebBootRuntime(pluginsDelivery: JSONArray) {
        val entry = File(activity.filesDir, "spike/$ENTRY")
        handle = SpikeRuntime.m4Begin(
            activity.filesDir.absolutePath, ENTRY, entry.readText(), DESCRIPTOR,
            "android-officialweb-mount", runtimeBridge,
        )
        if (handle == 0L) throw IllegalStateException("official-web begin: ${SpikeRuntime.m4LastError()}")
        deliverRuntime(
            JSONObject().put("type", "web.plugins").put("plugins", pluginsDelivery),
        )
    }

    /** The M4Bridge the C host calls back (runtime thread). The scenario
     * claims nothing: a gateway dispatch would be a bug (fail loud), and the
     * scenario's own completion is NOT the verdict — the probe's is. */
    private val runtimeBridge = object : SpikeRuntime.M4Bridge {
        override fun onGatewayCall(callId: Int, name: String, args: String) {
            fail("official-web: unexpected gateway call '$name' (compose-only closure)")
        }

        override fun onBusLine(line: String) {
            if (finished) return
            val msg = try {
                JSONObject(line)
            } catch (_: Exception) {
                return
            }
            when (msg.optString("type")) {
                "web.boot" -> applyWebBoot(msg)
                else -> {} // the compose-only scenario posts nothing else (no claims)
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
     * once received (plus the recovery global and the settings phone
     * adaptation), else none (the origin never opens before the runtime wire
     * lands). Runtime thread; called per render. The row mapping lives in
     * CarrierIndexRows — the one seat all three sessions share. */
    private fun runtimeRows(): List<CarrierIndexInjection> {
        val rows = webBootRows ?: return emptyList()
        return CarrierIndexRows.runtimeRows(rows)
    }

    /** Carrier → runtime: one bus delivery (any thread; hops onto the runtime
     * thread — the bridge hands over claimed api.request / mux.open frames
     * here). The scenario's own completion status is NOT the verdict. */
    private fun deliverRuntime(msg: JSONObject) {
        SpikeRuntime.post {
            if (finished || handle == 0L) return@post
            val status = SpikeRuntime.m4BusDeliver(handle, msg.toString())
            if (status < 0) fail("official-web bus deliver: ${SpikeRuntime.m4LastError()}")
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
        // Serving mode: the page is up, that IS the outcome — no probe, no
        // verdict, no canonical records (the release boot has nothing to assert).
        if (!evidence) return
        Thread({
            // rule 8: poll the arrival condition with a deadline, fail loud
            val deadline = System.currentTimeMillis() + 30_000
            while (!assetLogged && System.currentTimeMillis() < deadline) {
                Thread.sleep(100)
            }
            if (!assetLogged) {
                fail("official-web: the entry chunk never arrived")
                return@Thread
            }
            runProbe()
        }, "dsh-official-probe").start()
    }

    /** Runs the probe script in the page: combo fetch (plugins.served), WS
     * upgrade (upgrade.accepted), POST /api/session.list (rpc.observed),
     * mux journal open (session.attached + the unavailable frame), then the
     * rendered-state read with the live-module verdict. The async result
     * arrives via dispatchProbeResult. */
    private fun runProbe() {
        val view = webView
        if (view == null) {
            fail("official-web: no WebView attached")
            return
        }
        OfficialWebProbe.evaluate(view, OfficialWebProbe.probeScript(comboURL))
        OfficialWebProbe.evaluate(view, "window.__b1Run()")
    }

    /** JavaBridge thread: the probe's JSON result → verdict → settle. */
    private fun onProbeResult(json: String) {
        if (finished) return
        when (val outcome = OfficialWebProbe.verdict(json)) {
            is OfficialWebProbe.Verdict.Failure -> fail(outcome.message)
            is OfficialWebProbe.Verdict.Pass -> {
                for ((event, fields) in outcome.events) eventLog.emit(event, fields)
                finish(true, "")
            }
        }
    }

    // ---- settling ---------------------------------------------------------------

    private fun fail(message: String) {
        Log.i(TAG, "official FAIL $message")
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
