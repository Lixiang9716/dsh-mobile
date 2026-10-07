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
 * back via JsRuntime.post (ARCHITECTURE.md §6 thread rules); carrier-side
 * evidence rides the canonical envelope under its scenario id. */
class BindingHost private constructor(
    private val activity: Activity,
    /** Carrier-side evidence scenario id + JS entry + capture label for this
     * drive. The default is the M4 binding; the real-LLM drive (`llm.live-stream`)
     * overrides them — same host flow, different scenario. */
    private val scenarioId: String = SCENARIO,
    private val entryPath: String = ENTRY,
    private val captureLabel: String = "android-capability-binding",
    /** The v0-plane Web Client this drive serves (client id + staged dir):
     * the default v0 client, or the whale creation client whose web dir
     * rides the same assets staging (the iOS drive selects it through
     * -dsh-web-client; the Android launch extras select the drive). The
     * whale flag switches the readiness seam: its entry (session-mock-llm)
     * never posts bus.ready — see deliverHostHello. */
    private val clientId: String = "dsh-web-client",
    private val webRootDir: String = "webclient/web",
    private val whaleLeg: Boolean = false,
    /** The BLE face's radio choice (the launch extras decide). */
    private val mockRadio: Boolean = false,
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
        const val WHALE_SCENARIO = "android.whale.mount"
        const val WHALE_ENTRY = "scenario/session-mock-llm.js"
        const val DEVICE_PLANE_SCENARIO = "android.device-plane"
        const val DEVICE_PLANE_ENTRY = "scenario/device-plane.js"
        const val CAMERA_PLANE_SCENARIO = "android.camera-plane"
        const val CAMERA_PLANE_ENTRY = "scenario/camera-plane.js"
        const val BLE_SCENARIO = "android.ble-plane"
        const val BLE_ENTRY = "scenario/ble-plane.js"
        const val MIC_PLANE_SCENARIO = "android.mic-plane"
        const val MIC_PLANE_ENTRY = "scenario/mic-plane.js"
        const val WHALE_CLIENT_ID = "dsh-web-client-whale"
        const val WATCHDOG_SECONDS = 180
        const val EXTRA_NOTIFY_RESPONSE = "dsh.notify.response"

        private const val TAG = "dsh.rt"
        private const val RESULT_TAG = "dsh.rt.result"
        private const val ENGINE_LABEL = "quickjs-ng 0.17.0"

        /** RuntimeDescriptor pre-eval: the full table available, the
         * capability plane's phased rows unavailable — conformance §7
         * (Android Keystore + SAF + camera2 make the surface real). */
        private val DESCRIPTOR: String = JSONObject()
            .put("available", JSONArray(GatewayCore.PRIMITIVES))
            .put("unavailable", JSONArray(GatewayCore.PHASED_ROWS))
            .toString()

        @Volatile private var instance: BindingHost? = null

        /** Creates and starts the session; [onFinished] gets the verdict text. */
        fun start(
            activity: Activity,
            webView: WebView?,
            onFinished: (String) -> Unit,
        ): BindingHost {
            val host = BindingHost(activity)
            host.pump.attach(webView)
            instance = host
            host.start(onFinished)
            return host
        }

        /** The M2 real-LLM drive (scenario `llm.live-stream`): same carrier + WebView
         * + gateway flow, but the JS entry streams one real chat completion
         * through the gateway httpFetch. Credentials ride fs scope "app"
         * (files/profiles/default/llm-live-stream/config.json), staged by the E2E
         * runner before launch. */
        fun startLlm(activity: Activity, webView: WebView?, onFinished: (String) -> Unit): BindingHost =
            drive("llm-live-stream", LLM_SCENARIO, LLM_ENTRY, activity, webView, onFinished)

        /** The v1.5.0 device-plane drive (scenario `android.device-plane`):
         * the six SDK primitives + the media picker, driven marker-by-marker
         * from the runner. */
        fun startDevicePlane(activity: Activity, webView: WebView?, onFinished: (String) -> Unit): BindingHost =
            drive("device-plane", DEVICE_PLANE_SCENARIO, DEVICE_PLANE_ENTRY, activity, webView, onFinished)
        /** The capability plane's BLE drive (scenario `android.ble-plane`):
         * the real radio by default (an emulator answers `unavailable` honestly
         * — the CI skip leg), the deterministic mock on the mock extra. */
        fun startBle(activity: Activity, webView: WebView?, onFinished: (String) -> Unit, mockRadio: Boolean): BindingHost =
            drive("ble-plane", BLE_SCENARIO, BLE_ENTRY, activity, webView, onFinished, mockRadio)

        /** One scenario drive factory: the binding machinery with the leg's scenario
         * id, entry and capture label. The whale/parity/suite legs keep their own factories. */
        private fun drive(
            captureLabel: String,
            scenarioId: String,
            entryPath: String,
            activity: Activity,
            webView: WebView?,
            onFinished: (String) -> Unit,
            mockRadio: Boolean = false,
        ): BindingHost {
            val host = BindingHost(
                activity,
                scenarioId = scenarioId,
                entryPath = entryPath,
                captureLabel = captureLabel,
                mockRadio = mockRadio,
            )
            host.pump.attach(webView)
            instance = host
            host.start(onFinished)
            return host
        }
        /** The mic drive (`android.mic-plane`): micStart/micStop + the mic.frame channel; the OS prompt pre-granted in automation. */
        fun startMicPlane(activity: Activity, webView: WebView?, onFinished: (String) -> Unit): BindingHost =
            drive("mic-plane", MIC_PLANE_SCENARIO, MIC_PLANE_ENTRY, activity, webView, onFinished)

        /** The camera drive (`android.camera-plane`, v1.10.0): the capture burst
         * against the emulator's virtual camera, the phased rows' honest `unavailable`. */
        fun startCameraPlane(activity: Activity, webView: WebView?, onFinished: (String) -> Unit): BindingHost =
            drive("camera-plane", CAMERA_PLANE_SCENARIO, CAMERA_PLANE_ENTRY, activity, webView, onFinished)

        /** The upstream-suite drive (scenario `upstream.suite`): ONE transpiled
         * upstream spec executed by the quickjs-shaped harness inside our
         * runtime — per-test verdicts stream as scenario records; the spec
         * name rides the runtime.config bus delivery. */
        fun startSuite(activity: Activity, webView: WebView?, onFinished: (String) -> Unit, spec: String): BindingHost = spawn(
            activity, webView, onFinished,
            scenarioId = SUITE_SCENARIO,
            entryPath = SUITE_ENTRY,
            captureLabel = "upstream-suite",
        ).also { it.suiteSpec = spec }

        /** The upstream-parity drive (scenario `upstream.parity`): the port leg against the committed golden. */
        fun startParity(activity: Activity, webView: WebView?, onFinished: (String) -> Unit): BindingHost = spawn(
            activity, webView, onFinished,
                scenarioId = PARITY_SCENARIO,
                entryPath = PARITY_ENTRY,
                captureLabel = "upstream-parity",
                parityMode = true,
        )

        /** The whale creation-client drive (scenario `android.whale.mount`). */
        fun startWhale(activity: Activity, webView: WebView?, onFinished: (String) -> Unit): BindingHost = spawn(
            activity, webView, onFinished,
                scenarioId = WHALE_SCENARIO,
                entryPath = WHALE_ENTRY,
                captureLabel = "android-whale-mount",
                clientId = WHALE_CLIENT_ID,
                webRootDir = "webclient-whale/web",
                whaleLeg = true,
        )

        /** The shared factory tail of the scenario-swap drives (the
         * device/camera/BLE siblings): construct, attach, park, start. */
        private fun spawn(
            activity: Activity,
            webView: WebView?,
            onFinished: (String) -> Unit,
            scenarioId: String,
            entryPath: String,
            captureLabel: String,
            mockRadio: Boolean = false,
            clientId: String = "dsh-web-client",
            webRootDir: String = "webclient/web",
            whaleLeg: Boolean = false,
            parityMode: Boolean = false,
        ): BindingHost {
            val host = BindingHost(
                activity,
                scenarioId = scenarioId,
                entryPath = entryPath,
                captureLabel = captureLabel,
                clientId = clientId,
                webRootDir = webRootDir,
                whaleLeg = whaleLeg,
                mockRadio = mockRadio,
            )
            if (parityMode) host.parityMode = true
            host.pump.attach(webView)
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
    private val core = GatewayCore.create(File(activity.filesDir, "dsh"))
    private val fs = FsPrimitives(activity)
    private val http = HttpPrimitive()
    private val keychain = KeychainPrimitives(activity)
    val notify = NotifyPrimitive(activity)
    val timer = TimerPrimitive()
    private val ui = UiPrimitives(activity, fs)
    private val device = DevicePlanePrimitives(activity, fs)
    private val clipboard = ClipboardPrimitives(activity)
    private val camera = CameraPrimitives(activity, fs)
    private val ble = BlePrimitives(activity, core, if (mockRadio) MockBleRadio() else SystemBleRadio(activity))
    val mic = MicPrimitives(activity)
    private val wasm = WasmPrimitive(fs)

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

    /** The /ws page pump (projection replay + the hello/slot.ack protocol +
     * the ws.* records + the host.info gate + the origin load) — extracted
     * to keep this file under the size gate; the records still ride this
     * drive's scenario id through carrierLog. */
    private val pump = PagePump(
        activity, carrier,
        log = { event, fields -> carrierLog(event, fields) },
        onEvent = { json -> event(json) },
        runtimeReady = { handle != 0L && carrier.port != 0 },
    )

    private fun start(onFinished: (String) -> Unit) {
        this.onFinished = onFinished
        JsRuntime.post {
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
        carrierLog("client.selected", JSONObject().put("client", clientId))
        val bundle = File(activity.filesDir, "dsh")
        wireCore()
        carrier.onWSMessage = { text -> pump.ingest(text) }
        carrier.onStaticServed = { path ->
            if (!mountedLogged && (path == "/" || path.endsWith("index.html"))) {
                mountedLogged = true
                carrierLog(
                    "webclient.mounted",
                    JSONObject().put("client", clientId).put("path", "/index.html"),
                )
            }
        }
        val webRoot = File(bundle, webRootDir)
        if (parityMode) {
            MockLlmRoute.enableParityScript()
            carrier.register(CarrierRouteKind.EXACT, MockLlmRoute.PATH) { request, out ->
                MockLlmRoute.serve(request, out)
            }
        }
        carrier.start(webRoot) { /* readiness consumed below */ }
        val entry = File(bundle, entryPath)
        handle = JsRuntime.m4Begin(
            activity.filesDir.absolutePath, entryPath, entry.readText(), DESCRIPTOR,
            captureLabel, bridge,
        )
        if (handle == 0L) fail("m4 begin: ${JsRuntime.bindingLastError()}")
        if (parityMode) {
            // Same handoff shape as the session-live drives: the scenario's
            // bus subscription is installed during eval, so the delivery
            // lands whenever it is posted after m4Begin returns.
            val config = JSONObject()
                .put("type", "runtime.config")
                .put("mockLlmUrl", "http://127.0.0.1:${carrier.port}/mock-llm")
                .put("apiKey", MockLlmRoute.KEY)
                .put("containerRoot", bundle.absolutePath)
            onRuntimeStatus(JsRuntime.m4BusDeliver(handle, config.toString()))
        }
        suiteSpec?.let { spec ->
            val config = JSONObject()
                .put("type", "runtime.config")
                .put("spec", "upstream-tests/$spec")
                .put("containerRoot", bundle.absolutePath)
            onRuntimeStatus(JsRuntime.m4BusDeliver(handle, config.toString()))
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
        device.register(core)
        clipboard.register(core)
        camera.register(core)
        ble.register(core)

        mic.register(core)
        wasm.register(core)
        core.settleFn = { callId, ok, json ->
            JsRuntime.post {
                if (finished) return@post
                onRuntimeStatus(JsRuntime.m4Settle(handle, callId, ok, json))
            }
        }
        http.eventFn = { json -> event(json) }
        notify.emitFn = { json -> event(json) }
        timer.emitFn = { json -> event(json) }
        ble.emitFn = { json -> event(json) }
        mic.emitFn = { json -> event(json) }
        timer.register(core)
    }

    private val bridge = object : JsRuntime.BindingBridge {
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
                pump.record(payload.toString())
                carrier.send(payload.toString()) // CarrierServer.send is thread-safe
            }
        }
    }

    /** host.hello → the page load starts (mount evidence follows). The
     * scenario announces the bus subscription DURING eval (inside m4Begin,
     * before the handle field is assigned) and after the carrier is up —
     * so delivery happens at the later of: begin() returning, bus.ready,
     * carrier listening. Never reentrant into eval. The whale leg's entry
     * (scenario/session-mock-llm.js, the iOS drive's shape) never posts
     * bus.ready — it parks on the host.info EVENT until the page connects —
     * so that leg opens the origin on handle + port alone. */
    private fun deliverHostHello() {
        if (hostHelloDelivered || handle == 0L || carrier.port == 0) return
        if (!whaleLeg && !busReady) return
        hostHelloDelivered = true
        val hello = JSONObject().put("type", "host.hello").put("port", carrier.port)
        onRuntimeStatus(JsRuntime.m4BusDeliver(handle, hello.toString()))
        val port = carrier.port
        activity.runOnUiThread { pump.loadOrigin(port) }
    }

    // ---- runtime-queue settle/event + settling --------------------------------

    private fun event(json: String) {
        JsRuntime.post {
            if (finished) return@post
            onRuntimeStatus(JsRuntime.m4Event(handle, json))
        }
    }

    /** 0 = running, 1 = pass, 2 = fail, -1 = error. */
    private fun onRuntimeStatus(status: Int) {
        when (status) {
            0 -> {}
            1 -> pass()
            2 -> fail("scenario completed with pass=false")
            else -> fail("m4 runtime: ${JsRuntime.bindingLastError()}")
        }
    }

    // ---- lifecycle + notification crossings ------------------------------------

    private fun lifecycle(state: String) {
        if (handle == 0L || finished) return
        notify.appState(state)
    }

    fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == UiPrimitives.REQUEST_PICKER) ui.onPickerResult(resultCode, data)
        if (requestCode == UiPrimitives.REQUEST_MEDIA) ui.onMediaResult(resultCode, data)
        if (requestCode == DevicePlanePrimitives.REQUEST_SHARE) device.onShareResult(resultCode)
    }

    /** The capability planes' OS permission answers (mic + camera). */
    fun onRequestPermissionsResult(requestCode: Int, grantResults: IntArray) {
        mic.onPermissionResult(requestCode, grantResults)
        if (requestCode == CameraPrimitives.REQUEST_CAMERA) {
            camera.onPermissionResult(
                grantResults.isNotEmpty()
                    && grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED,
            )
        }
        if (requestCode == BleConsentLayer.REQUEST_BLE) {
            // the scan/connect pair: every entry must be granted to proceed
            ble.onPermissionResult(grantResults.isNotEmpty()
                && grantResults.all { it == android.content.pm.PackageManager.PERMISSION_GRANTED })
        }
        mic.onPermissionResult(requestCode, grantResults)
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
        if (handle != 0L) JsRuntime.m4End(handle)
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

private const val MIC_PLANE_SCENARIO = "android.mic-plane"
private const val MIC_PLANE_ENTRY = "scenario/mic-plane.js"
