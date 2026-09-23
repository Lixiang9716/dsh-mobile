package com.dshmobile.spike

import android.app.Activity
import android.content.Intent
import android.util.Log
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/**
 * Drives the M4 completion session (`android.capability-binding`) — the Android
 * sibling of hosts/ios SessionRuntime.swift + GatewaySession.swift combined:
 * one C runtime on the single serial HandlerThread, the loopback carrier
 * ([CarrierServer]) serving the embedded Web Client in front of it, the
 * REAL nine-primitive gateway bound through the frozen bridge, and the
 * session projection pushed JS → bus → WS → WebView. The outcome settles
 * exactly once: scenario completion or watchdog (180 s — the UI
 * choreography takes time). JS runs ONLY on the runtime thread; primitive
 * handlers run off it (UI thread / fetch threads); every settle/event hops
 * back via SpikeRuntime.post (ARCHITECTURE.md §6 thread rules). Carrier-side
 * evidence rides the canonical `dsh.spike.log: ` envelope as scenario
 * `android.capability-binding` so one checker manifest covers the whole flow.
 */
class SpikeHostM4 private constructor(
    private val activity: Activity,
    /** Carrier-side evidence scenario id + JS entry + capture label for this
     * drive. The default is the M4 binding; the real-LLM drive (`llm.live-stream`)
     * overrides them — same host flow, different scenario. */
    private val scenarioId: String = SCENARIO,
    private val entryPath: String = ENTRY,
    private val captureLabel: String = "android-capability-binding",
) {

    companion object {
        const val SCENARIO = "android.capability-binding"
        const val ENTRY = "scenario/android-capability-binding.js"
        const val LLM_SCENARIO = "llm.live-stream.carrier"
        const val LLM_ENTRY = "scenario/llm-live-stream.js"
        const val PARITY_SCENARIO = "upstream.parity"
        const val PARITY_ENTRY = "scenario/upstream-parity.js"
        const val SUITE_SCENARIO = "upstream.suite"
        const val SUITE_ENTRY = "scenario/upstream-suite-leg.js"
        const val WATCHDOG_SECONDS = 180
        const val EXTRA_NOTIFY_RESPONSE = "dsh.notify.response"

        private const val TAG = "dsh.spike"
        private const val RESULT_TAG = "dsh.spike.result"
        private const val ENGINE_LABEL = "quickjs-ng 0.17.0"

        /** RuntimeDescriptor pre-eval: all nine available, zero unavailable
         * — conformance §7 (Android Keystore + SAF make the surface real). */
        private val DESCRIPTOR: String = JSONObject()
            .put("available", JSONArray(GatewayCore.PRIMITIVES))
            .put("unavailable", JSONArray())
            .toString()

        @Volatile private var instance: SpikeHostM4? = null

        /** Creates and starts the session; [onFinished] gets the verdict text. */
        fun start(
            activity: Activity,
            webView: WebView?,
            onFinished: (String) -> Unit,
        ): SpikeHostM4 {
            val host = SpikeHostM4(activity)
            host.webView = webView
            instance = host
            host.start(onFinished)
            return host
        }

        /** The M2 real-LLM drive (scenario `llm.live-stream`): same carrier + WebView
         * + gateway flow, but the JS entry streams one real chat completion
         * through the gateway httpFetch. Credentials ride fs scope "app"
         * (files/profiles/default/llm-live-stream/config.json), staged by the E2E
         * runner before launch. */
        fun startLlm(
            activity: Activity,
            webView: WebView?,
            onFinished: (String) -> Unit,
        ): SpikeHostM4 {
            val host = SpikeHostM4(
                activity,
                scenarioId = LLM_SCENARIO,
                entryPath = LLM_ENTRY,
                captureLabel = "llm-live-stream",
            )
            host.webView = webView
            instance = host
            host.start(onFinished)
            return host
        }

        /** The upstream-suite drive (scenario `upstream.suite`): ONE transpiled
         * upstream spec (the runner stages the corpus under
         * filesDir/spike/upstream-tests/) executed by the quickjs-shaped
         * harness inside our runtime — per-test verdicts stream as
         * scenario records. The spec name rides the launch extras into the
         * runtime.config bus delivery. */
        fun startSuite(
            activity: Activity,
            webView: WebView?,
            onFinished: (String) -> Unit,
            spec: String,
        ): SpikeHostM4 {
            val host = SpikeHostM4(
                activity,
                scenarioId = SUITE_SCENARIO,
                entryPath = SUITE_ENTRY,
                captureLabel = "upstream-suite",
            )
            host.suiteSpec = spec
            host.webView = webView
            instance = host
            host.start(onFinished)
            return host
        }

        /** The upstream-parity drive (scenario `upstream.parity`): the port leg
         * of the differential consistency check — the same vendored upstream
         * spine, the same scripted turns (success → todo_write tool round →
         * closing success → 401) the Node reference leg runs, compared
         * against the committed golden. The mock route is armed with the
         * parity script and the endpoint facts ride the runtime.config bus
         * delivery (the session-live handoff shape). */
        fun startParity(
            activity: Activity,
            webView: WebView?,
            onFinished: (String) -> Unit,
        ): SpikeHostM4 {
            val host = SpikeHostM4(
                activity,
                scenarioId = PARITY_SCENARIO,
                entryPath = PARITY_ENTRY,
                captureLabel = "upstream-parity",
            )
            host.parityMode = true
            host.webView = webView
            instance = host
            host.start(onFinished)
            return host
        }

        /** Lifecycle entry points (null until the session is live). */
        fun dispatchPause() = instance?.lifecycle("background")
        fun dispatchResume() = instance?.lifecycle("foreground")

        /** Notification tap lands here (onNewIntent / cold onCreate). */
        fun dispatchNotifyResponse(intent: Intent?) {
            val id = intent?.getStringExtra(EXTRA_NOTIFY_RESPONSE) ?: return
            instance?.notify?.notifyResponse(id)
        }
    }

    private val carrier = CarrierServer()
    private val core = GatewayCore.create(File(activity.filesDir, "spike"))
    private val fs = FsPrimitives(activity)
    private val http = HttpPrimitive()
    private val keychain = KeychainPrimitives(activity)
    val notify = NotifyPrimitive(activity)
    private val ui = UiPrimitives(activity, fs)

    private var handle: Long = 0

    /** The upstream-parity drive: arms the mock route's parity script and
     * hands the endpoint facts to the scenario over the runtime.config bus
     * delivery (set by startParity before start). */
    internal var parityMode = false

    /** The upstream-suite drive: the spec module path delivered in
     * runtime.config (set by startSuite before start). */
    internal var suiteSpec: String? = null
    private var finished = false
    private var busReady = false
    private var hostHelloDelivered = false
    private var mountedLogged = false
    private var connectedLogged = false
    private var slotAcked = false
    private var hostInfoDelivered = false
    private var firstDeltaSeen = false
    private val projection = ArrayList<String>()

    private fun start(onFinished: (String) -> Unit) {
        this.onFinished = onFinished
        SpikeRuntime.post {
            try {
                begin()
            } catch (e: Exception) {
                fail("m4 bootstrap: ${e::class.java.simpleName}: ${e.message}")
            }
        }
        android.os.Handler(activity.mainLooper).postDelayed(
            {
                if (!finished) fail("m4 watchdog: scenario did not complete in $WATCHDOG_SECONDS s")
            },
            WATCHDOG_SECONDS * 1000L,
        )
    }

    private var onFinished: ((String) -> Unit)? = null

    /** Runtime thread. */
    private fun begin() {
        carrierLog("client.selected", JSONObject().put("client", "dsh-web-client"))
        val bundle = File(activity.filesDir, "spike")
        wireCore()
        carrier.onWSMessage = { text -> ingest(text) }
        carrier.onStaticServed = { path ->
            if (!mountedLogged && (path == "/" || path.endsWith("index.html"))) {
                mountedLogged = true
                carrierLog(
                    "webclient.mounted",
                    JSONObject().put("client", "dsh-web-client").put("path", "/index.html"),
                )
            }
        }
        val webRoot = File(bundle, "webclient/web")
        if (parityMode) {
            MockLlmRoute.enableParityScript()
            carrier.register(CarrierRouteKind.EXACT, MockLlmRoute.PATH) { request, out ->
                MockLlmRoute.serve(request, out)
            }
        }
        carrier.start(webRoot) { /* readiness consumed below */ }
        val entry = File(bundle, entryPath)
        handle = SpikeRuntime.m4Begin(
            activity.filesDir.absolutePath, entryPath, entry.readText(), DESCRIPTOR,
            captureLabel, bridge,
        )
        if (handle == 0L) fail("m4 begin: ${SpikeRuntime.m4LastError()}")
        if (parityMode) {
            // Same handoff shape as the session-live drives: the scenario's
            // bus subscription is installed during eval, so the delivery
            // lands whenever it is posted after m4Begin returns.
            val config = JSONObject()
                .put("type", "runtime.config")
                .put("mockLlmUrl", "http://127.0.0.1:${carrier.port}/mock-llm")
                .put("apiKey", MockLlmRoute.KEY)
                .put("containerRoot", bundle.absolutePath)
            onRuntimeStatus(SpikeRuntime.m4BusDeliver(handle, config.toString()))
        }
        suiteSpec?.let { spec ->
            val config = JSONObject()
                .put("type", "runtime.config")
                .put("spec", "upstream-tests/$spec")
                .put("containerRoot", bundle.absolutePath)
            onRuntimeStatus(SpikeRuntime.m4BusDeliver(handle, config.toString()))
        }
        deliverHostHello() // in case bus.ready arrived during eval
    }

    /** Full capability surface: all nine primitives real. */
    private fun wireCore() {
        fs.register(core)
        http.register(core)
        keychain.register(core)
        notify.register(core)
        ui.register(core)
        core.settleFn = { callId, ok, json ->
            SpikeRuntime.post {
                if (finished) return@post
                onRuntimeStatus(SpikeRuntime.m4Settle(handle, callId, ok, json))
            }
        }
        http.eventFn = { json -> event(json) }
        notify.emitFn = { json -> event(json) }
    }

    private val bridge = object : SpikeRuntime.M4Bridge {
        override fun onGatewayCall(callId: Int, name: String, args: String) {
            if (finished) return
            core.dispatch(callId, name, args)
        }

        override fun onBusLine(line: String) {
            if (finished) return
            busPosted(line)
        }
    }

    // ---- bus (runtime thread, called from C) --------------------------------

    private fun busPosted(line: String) {
        val msg = try {
            JSONObject(line)
        } catch (_: Exception) {
            return
        }
        when (msg.optString("type")) {
            "bus.ready" -> {
                busReady = true
                deliverHostHello()
            }
            "ws.send" -> {
                val payload = msg.optJSONObject("payload") ?: return
                val text = payload.toString()
                synchronized(projection) { projection.add(text) }
                observeProjection(payload)
                carrier.send(text) // CarrierServer.send is thread-safe
            }
        }
    }

    /** host.hello → the page load starts (mount evidence follows). The
     * scenario announces the bus subscription DURING eval (inside m4Begin,
     * before the handle field is assigned) and after the carrier is up —
     * so delivery happens at the later of: begin() returning, bus.ready,
     * carrier listening. Never reentrant into eval. */
    private fun deliverHostHello() {
        if (hostHelloDelivered || !busReady || handle == 0L || carrier.port == 0) return
        hostHelloDelivered = true
        val hello = JSONObject().put("type", "host.hello").put("port", carrier.port)
        onRuntimeStatus(SpikeRuntime.m4BusDeliver(handle, hello.toString()))
        val port = carrier.port
        activity.runOnUiThread { loadOrigin(port) }
    }

    private fun observeProjection(payload: JSONObject) {
        when (payload.optString("kind")) {
            "token-delta" -> if (!firstDeltaSeen) {
                firstDeltaSeen = true
                carrierLog(
                    "ws.token-delta",
                    JSONObject().put("first", true).put("index", payload.optInt("index")),
                )
            }
            "complete" -> {
                carrierLog("ws.token-delta", lastDeltaFields(payload))
                carrierLog("ws.session-complete", JSONObject().put("status", "pass"))
            }
        }
    }

    private fun lastDeltaFields(payload: JSONObject): JSONObject = JSONObject()
        .put("first", false)
        .put("last", true)
        .put("index", payload.optInt("deltas", 1) - 1)

    // ---- WS page pump ---------------------------------------------------------

    /** Carrier thread; hops onto the runtime thread. */
    private fun ingest(text: String) {
        val payload = try {
            JSONObject(text)
        } catch (_: Exception) {
            return
        }
        SpikeRuntime.post {
            if (finished) return@post
            when (payload.optString("type")) {
                "hello" -> pageHello(payload.optString("protocol"))
                "slot.ack" -> slotAck(payload)
            }
        }
    }

    /** Runtime thread. */
    private fun pageHello(protocol: String) {
        carrier.send(
            JSONObject()
                .put("type", "ws.hello")
                .put("protocol", protocol)
                .put("served", JSONArray(carrier.servedList()))
                .toString(),
        )
        carrier.send(replayLine())
        if (connectedLogged) return
        connectedLogged = true
        carrierLog("ws.connected", JSONObject().put("protocol", protocol))
        deliverHostInfo()
    }

    /** The replay payload for a (re)connecting page: every projection line
     * pushed so far, parsed back as JSON values. */
    private fun replayLine(): String = JSONObject()
        .put("type", "replay")
        .put("events", JSONArray(replayEvents()))
        .toString()

    private fun replayEvents(): List<JSONObject> = synchronized(projection) {
        projection.mapNotNull { runCatching { JSONObject(it) }.getOrNull() }
    }

    /** Runtime thread: rendered-state evidence + host.info half-gate. */
    private fun slotAck(payload: JSONObject) {
        if (slotAcked) return
        slotAcked = true
        carrierLog(
            "slot.registered",
            JSONObject()
                .put("id", payload.optString("id"))
                .put("label", payload.optString("label"))
                .put("by", payload.optString("by")),
        )
        deliverHostInfo()
    }

    /** Runtime thread: fires once the page is connected AND acked the slot. */
    private fun deliverHostInfo() {
        if (hostInfoDelivered || handle == 0L || carrier.port == 0 ||
            !connectedLogged || !slotAcked
        ) {
            return
        }
        hostInfoDelivered = true
        event(
            JSONObject().put("event", "host.info").put("port", carrier.port).toString(),
        )
    }

    /** UI thread: mount the Web Client (Presentation surface). */
    private fun loadOrigin(port: Int) {
        webView?.loadUrl("http://127.0.0.1:$port/")
    }

    private var webView: WebView? = null

    // ---- runtime-queue settle/event + settling --------------------------------

    private fun event(json: String) {
        SpikeRuntime.post {
            if (finished) return@post
            onRuntimeStatus(SpikeRuntime.m4Event(handle, json))
        }
    }

    /** 0 = running, 1 = pass, 2 = fail, -1 = error. */
    private fun onRuntimeStatus(status: Int) {
        when (status) {
            0 -> {}
            1 -> pass()
            2 -> fail("scenario completed with pass=false")
            else -> fail("m4 runtime: ${SpikeRuntime.m4LastError()}")
        }
    }

    // ---- lifecycle + notification crossings ------------------------------------

    private fun lifecycle(state: String) {
        if (handle == 0L || finished) return
        notify.appState(state)
    }

    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == UiPrimitives.REQUEST_PICKER) ui.onPickerResult(resultCode, data)
    }

    // ---- settling ---------------------------------------------------------------

    private fun pass() = finish(true, "")

    private fun fail(message: String) {
        Log.i(TAG, "m4 FAIL $message")
        finish(false, message)
    }

    private fun finish(passed: Boolean, error: String) {
        if (finished) return
        finished = true
        val line = "$scenarioId ${if (passed) "PASS" else "FAIL"} | $ENGINE_LABEL" +
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

    /** One E2E record in the canonical envelope (`dsh.spike.log:` prefix,
     * unified-logger shape) so the carrier's own events ride the same
     * checker stream as the JS scenario's. */
    private fun carrierLog(event: String, fields: JSONObject) {
        val payload = JSONObject().put("scenario", scenarioId).put("event", event)
        fields.keys().forEach { key -> payload.put(key, fields.get(key)) }
        val record = JSONObject()
            .put("level", "info")
            .put("module", "dsh.carrier")
            .put("message", "e2e")
            .put("data", JSONArray().put(payload))
        if (!BuildFlavor.keeps(record.toString())) return
        Log.i(TAG, "dsh.spike.log: $record")
    }
}
