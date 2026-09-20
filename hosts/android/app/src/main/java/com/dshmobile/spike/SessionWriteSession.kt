package com.dshmobile.spike

import android.app.Activity
import android.os.Handler
import android.util.Log
import android.webkit.WebView
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

    /** Drives `b-android.write.live` (the Android D9 write leg, the sibling
     * of the iOS b4.write.live): the FULL upstream agent spine boots
     * ON-DEVICE and the official web boot wire is composed WITH THE WRITE
     * SURFACE (upstream/web-write.js) over the bus seam (SessionWriteSeam
     * folds the claims + answers into the carrier bridge). The probe drives
     * the REAL UI like a user: pick the seeded workspace, type into the real
     * composer, click send — the page's own composer message admits a REAL
     * upstream agent-loop turn (the scripted /mock-llm/chat/completions
     * carrier endpoint is the model boundary, E2E determinism, logged as
     * such) whose deltas stream live over the mux journal back into the
     * official UI. Endpoints the spine does not implement stay structured-
     * unavailable, never faked. Kotlin sibling of hosts/ios
     * SessionWriteRuntime.swift; JS runs ONLY on SpikeRuntime's
     * HandlerThread. The carrier/runtime plumbing is the session-live
     * drive's (SessionLiveSession); only the entry, the seam, and the probe
     * legs differ. */
class SessionWriteSession private constructor(private val activity: Activity) {

    companion object {
        const val SCENARIO = "b-android.write.live"
        const val ENTRY = "scenario/b-android-write-live.js"
        const val CLIENT_ID = "dsh-web-official"
        // Bound, not pacing: the drive's stages carry their own deadlines;
        // 270s sits inside the runner's 300s phase window (session-live's budget).
        const val WATCHDOG_SECONDS = 270

        private const val TAG = "dsh.spike"
        private const val RESULT_TAG = "dsh.spike.result"
        private const val ENGINE_LABEL = "quickjs-ng 0.17.0"
        private const val BOOT_SOURCE =
            "runtime (spine + vendored @deepseek-ai/dsh-client-modules)"

        /** The session-live drive's gateway descriptor (fs + httpFetch;
         * anything else settles denied — fail loud). */
        private val DESCRIPTOR = JSONObject()
            .put("available", JSONArray(GatewayCore.PRIMITIVES))
            .put("unavailable", JSONArray()).toString()

        @Volatile private var instance: SessionWriteSession? = null

        /** Creates and starts the session; [onFinished] gets the verdict text. */
        fun start(activity: Activity, webView: WebView?, onFinished: (String) -> Unit): SessionWriteSession {
            val session = SessionWriteSession(activity)
            session.webView = webView
            instance = session
            session.start(onFinished)
            return session
        }

        /** The WebView finished a document load (UI thread, from the client). */
        fun dispatchPageFinished() = instance?.pageDidFinish()

        /** The probe's async leg result (JavaBridge thread, from the interface). */
        fun dispatchProbeResult(json: String) = instance?.onProbeResult(json)
    }

    private val carrier = CarrierServer()
    private val eventLog = CarrierEventLog(SCENARIO)
    private lateinit var plugins: CarrierPlugins
    private lateinit var bridge: CarrierAPIBridge
    private lateinit var dist: CarrierWebDist
    private lateinit var core: GatewayCore
    private lateinit var seam: SessionWriteSeam

    private var onFinished: ((String) -> Unit)? = null
    private var handle: Long = 0
    private var finished = false
    private var token = ""
    private var webView: WebView? = null

    // once-guards for the page hooks; `comboPending` holds an early combo
    // arrival until the asset event fixed the report order (mirrored from
    // the session-live drive).
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
                fail("write-live bootstrap: ${e::class.java.simpleName}: ${e.message}")
            }
        }
        Handler(activity.mainLooper).postDelayed(
            {
                if (!finished) {
                    fail("write-live watchdog: drive did not complete in $WATCHDOG_SECONDS s")
                }
            },
            WATCHDOG_SECONDS * 1000L,
        )
    }

    /** Runtime thread: the session-live route table (official dist fallback
     * + /plugins + /api + the scripted llm endpoint), then the write half. */
    private fun begin() {
        val files = activity.filesDir
        val staged = WebPluginsDelivery.build(File(files, "web-plugins"))
            ?: throw IllegalStateException(
                "web-plugins is not staged (the E2E runner stages it)")
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
        seam = SessionWriteSeam(bridge)
        seam.onEvent = { event, fields -> eventLog.emit(event, fields) }
        wireEvidence()
        carrier.registerFallback(dist.handler)
        carrier.register(CarrierRouteKind.PREFIX, "/plugins") { req, out ->
            plugins.handler(req, out)
        }
        bridge.install(carrier)
        carrier.onWSFrame = { text, path -> bridge.ingestFrame(text, path) }
        carrier.register(CarrierRouteKind.EXACT, MockLlmRoute.PATH) { request, out ->
            MockLlmRoute.serve(request, out)
        }
        carrier.start(File(files, "spike/webclient/web")) { /* readiness below */ }
        eventLog.emit("client.selected",
            JSONObject().put("client", CLIENT_ID).put("source", "launch"))
        startWriteRuntime(staged)
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
        bridge.onMuxFrame = { direction, kind -> seam.observeMuxFrame(direction, kind) }
    }

    // ---- once-guarded asset/combo ordering (session-live's) ----

    /** The entry JS chunk is the deterministic first-fetch evidence (the
     * `.js` suffix is load-bearing; the css/js first fetch is a race). */
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

    // ---- the write-live runtime half ------------------------------------------

    /** Evals the scenario through the frozen bridge, wires the gateway
     * (fs + httpFetch for the llm transport), delivers runtime.config
     * (scripted llm endpoint + profile container) + `web.plugins`. */
    private fun startWriteRuntime(pluginsDelivery: JSONArray) {
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
            "b-android-write-live", runtimeBridge,
        )
        if (handle == 0L) throw IllegalStateException("write-live begin: ${SpikeRuntime.m4LastError()}")
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
                fail("write-live: unknown bus message '${msg.optString("type")}'")
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
     * render. Mirrors SessionLiveSession.runtimeRows. */
    private fun runtimeRows(): List<CarrierIndexInjection> =
        CarrierIndexRows.runtimeRows(webBootRows)

    /** Carrier → runtime: one bus delivery (any thread; hops onto the runtime
     * thread — the bridge hands over claimed api.request / mux.open frames
     * here). The scenario's own completion status is NOT the verdict. */
    private fun deliverRuntime(msg: JSONObject) {
        SpikeRuntime.post {
            if (finished || handle == 0L) return@post
            val status = SpikeRuntime.m4BusDeliver(handle, msg.toString())
            if (status < 0) fail("write-live bus deliver: ${SpikeRuntime.m4LastError()}")
        }
    }

    /** 0 = running, 1 = pass, 2 = fail, -1 = error. A scenario pass is
     * ignored on purpose (session-live's rule): the write scenario stays
     * RESIDENT on success and the verdict is the probe's. */
    private fun onRuntimeStatus(status: Int) {
        when (status) {
            0, 1 -> {}
            2 -> fail("write-live: scenario completed with pass=false")
            else -> fail("write-live runtime: ${SpikeRuntime.m4LastError()}")
        }
    }

    // ---- origin + page probe ---------------------------------------------------

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

    /** The document finished loading: wait for the entry-chunk evidence,
     * then run the write probe legs in order (pick → type → send). */
    private fun pageDidFinish() {
        if (finished) return
        Thread({
            // rule 8: poll the arrival condition with a deadline, fail loud
            val deadline = System.currentTimeMillis() + 30_000
            while (!assetLogged && System.currentTimeMillis() < deadline) {
                Thread.sleep(100)
            }
            if (!assetLogged) {
                fail("write-live: the entry chunk never arrived")
                return@Thread
            }
            runProbe()
        }, "dsh-write-probe").start()
    }

    /** Defines the three page functions, then runs the first leg; the async
     * results arrive via dispatchProbeResult (no awaitable Promise). */
    private fun runProbe() {
        val view = webView
        if (view == null) {
            fail("write-live: no WebView attached")
            return
        }
        SessionWriteProbe.evaluate(view, SessionWriteProbe.probeScript())
        SessionWriteProbe.evaluate(view, "window.__dshWritePick()")
    }

    /** JavaBridge thread: one probe leg's JSON result → its collector. */
    private fun onProbeResult(json: String) {
        if (finished) return
        val leg = try { JSONObject(json).optString("leg") } catch (_: Exception) { "" }
        val probe = SessionWriteProbe.parse(json, leg)
        if (probe == null) {
            fail("write probe leg '$leg' returned no parseable result: ${json.take(200)}")
            return
        }
        when (leg) {
            "pick" -> onPicked(probe)
            "type" -> onTyped(probe)
            // Pre-send snapshot: the composer still holds the message with
            // the notice dismissed (the typed-composer screenshot marker).
            "presend" -> {
                if (probe.optString("value") != SessionWriteProbe.MESSAGE_TEXT) {
                    fail("the composer lost the message before send")
                    return
                }
                eventLog.emit("composer.ready", JSONObject()
                    .put("found", probe.optString("found"))
                    .put("value", probe.optString("value")))
                // The typed-composer screenshot window: hold the send click
                // until the runner's screencap at the marker has landed
                // (bounded; the page resumes on the ack).
                Thread.sleep(2500)
                webView?.let { SessionWriteProbe.evaluate(it, "window.__b4wGo = true") }
            }
            "send" -> onSent(probe)
            else -> fail("write probe: unknown leg '$leg'")
        }
    }

    /** The pick leg's verdict: the picker opened, the composer reached. */
    private fun onPicked(probe: JSONObject) {
        if (probe.optBoolean("chip") != true || probe.optBoolean("composer") != true) {
            fail("the composer never appeared through the official picker (chip: " +
                "${probe.optBoolean("chip")}, composer: ${probe.optBoolean("composer")})")
            return
        }
        eventLog.emit("workspace.picked", JSONObject()
            .put("composer", true)
            .put("dismissed", probe.optInt("dismissed"))
            .put("notice", probe.optBoolean("notice"))
            .put("bodyText", probe.optString("bodyText")))
        val view = webView ?: return fail("write-live: no WebView attached")
        SessionWriteProbe.evaluate(view, "window.__dshWriteType()")
    }

    /** The type leg's verdict: the composer must carry the probe's text. */
    private fun onTyped(probe: JSONObject) {
        val found = probe.optString("found", "none")
        val value = probe.optString("value")
        if (found == "none" || value != SessionWriteProbe.MESSAGE_TEXT) {
            fail("the composer never took the message (found: $found, value: $value)")
            return
        }
        eventLog.emit("composer.typed", JSONObject()
            .put("found", found)
            .put("editable", probe.optBoolean("editable"))
            .put("value", value)
            .put("text", SessionWriteProbe.MESSAGE_TEXT)
            .put("active", probe.optString("active")))
        val view = webView ?: return fail("write-live: no WebView attached")
        SessionWriteProbe.evaluate(view, "window.__dshWriteSend()")
    }

    /** The send leg's verdict: the DOM must show the typed user message AND
     * the scripted assistant reply. */
    private fun onSent(probe: JSONObject) {
        if (probe.optBoolean("sent") != true) {
            fail("probe send never fired")
            return
        }
        val shapes = probe.optJSONArray("frameShapes")?.let { array ->
            (0 until array.length()).mapNotNull { runCatching { array.getString(it) }.getOrNull() }
        } ?: emptyList()
        if (probe.optString("mux") != "frames" || shapes.size != 1 ||
            !shapes[0].startsWith("snapshot:")) {
            fail("the diagnostic follow never settled: ${probe.optString("mux")}, $shapes")
            return
        }
        eventLog.emit(
            "write.follow.frames",
            JSONObject()
                .put("frames", probe.optInt("frames"))
                .put("shapes", JSONArray(shapes))
                .put("sessionId", probe.optString("sessionId")),
        )
        if (probe.optBoolean("reply") != true) {
            fail("the assistant reply never rendered (${shapes.size} frames)")
            return
        }
        eventLog.emit(
            "write.reply.rendered",
            JSONObject()
                .put("reply", SessionWriteProbe.EXPECTED_REPLY)
                .put("userText", SessionWriteProbe.MESSAGE_TEXT)
                .put("moduleMode", probe.optString("moduleMode", "none"))
                .put("bodyText", probe.optJSONObject("page")?.optString("bodyText").orEmpty()),
        )
        seam.flushRpcWitnesses()
        finish(true, "")
    }

    // ---- settling ---------------------------------------------------------------

    private fun fail(message: String) {
        Log.i(TAG, "write-live FAIL $message")
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

    private fun randomToken(): String = java.security.SecureRandom()
        .run { ByteArray(16).also { nextBytes(it) } }.joinToString("") { "%02x".format(it) }

    /** The application batch's combo URL from the injected graph JSON. */
    private fun batchURL(graphJSON: String): String? = try {
        JSONObject(graphJSON).optJSONArray("batches")?.getJSONObject(0)?.optString("url")
    } catch (_: Exception) { null }
}
