package com.dshmobile.spike

import android.app.Activity
import android.util.Log
import android.webkit.WebView
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

/**
 * The SERVING seat behind the official Web Client on the loopback carrier:
 * the carrier (`CarrierServer`), the official dist seat (`CarrierWebDist`),
 * the `/plugins` delivery (`CarrierPlugins`), the `/api` + mux bridge
 * (`CarrierAPIBridge` + `SessionWriteSeam` folding the runtime's claims),
 * the scripted chat-completions endpoint (`MockLlmRoute`), and the runtime
 * half — the FULL upstream spine booted through scenario/composer-web-live.js,
 * which claims the write surface, the settings describe and the mux streams
 * and then goes RESIDENT: the page's own composer drives real turns, nothing
 * here pre-plays them.
 *
 * The user-facing boot composes the INTERACTIVE surfaces behind the
 * `interactive` flag (the commands registry + the skill plane the composer's
 * "/" menu reads — boot.js mounts them only when the config carries the
 * rows), and takes the user's model endpoint from the credential file when
 * one is staged (else the scripted route answers, and the whole UI still
 * works). Kotlin sibling of hosts/ios SessionServe.swift, which holds the
 * same seam contract: a serving seat reports FACTS (here, Log.i lines — a
 * release build strips debug/info from the canonical logger), and which
 * E2E record a fact becomes is the drive's business. The `composer.live-write`
 * evidence drive keeps its own class (`SessionWriteSession`) so its
 * manifest-pinned boot stays byte-identical; this seat shares every carrier
 * piece with it and adds no E2E machinery at all. JS runs ONLY on
 * SpikeRuntime's HandlerThread.
 */
class SessionServe private constructor(
    private val activity: Activity,
    private val credential: Credential?,
    private val interactive: Boolean,
) {

    companion object {
        private const val TAG = "SessionServe"
        private const val ENTRY = "scenario/composer-web-live.js"
        private const val CLIENT_ID = "dsh-web-official"

        /** The reserved app scope's root (`FsPrimitives`: what scope "app"
         * means). The credential file and the workspace live inside it. */
        fun appScopeRoot(activity: Activity): File =
            File(activity.filesDir, "profiles/default")

        /** The one workspace the mobile profile seeds: a real directory inside
         * the app scope, so the agent always has somewhere to work and what it
         * writes survives relaunches (the staged bundle root would be neither).
         * The custom skills dir lives INSIDE it for the same reason — the fs
         * views refuse anything outside the granted scope. */
        fun workspaceRoot(activity: Activity): File =
            File(appScopeRoot(activity), "spike").apply { mkdirs() }

        @Volatile private var instance: SessionServe? = null

        /** Creates and starts the seat; the WebView loads the origin when the
         * runtime's composed boot wire + the settings probes are in. */
        fun start(
            activity: Activity,
            webView: WebView?,
            credential: Credential?,
            interactive: Boolean = true,
        ): SessionServe {
            val seat = SessionServe(activity, credential, interactive)
            seat.webView = webView
            instance = seat
            SpikeRuntime.post {
                try {
                    seat.begin()
                } catch (e: Exception) {
                    seat.fail("serve bootstrap: ${e::class.java.simpleName}: ${e.message}")
                }
            }
            return seat
        }

        /** The WebView finished a document load (no-op for the seat — there is
         * no probe; kept so MainActivity's client can dispatch uniformly). */
        fun dispatchPageFinished() = Unit

        /** The user-supplied model endpoint from
         * `<filesDir>/profiles/default/llm/config.json` — the reserved app
         * scope, the same shape and location the `llm.live-stream` runner
         * stages credentials at. A malformed or partial file yields null
         * rather than a half-configured transport. Nothing here logs the key:
         * a credential that never reaches a record cannot leak into one. */
        fun loadCredential(activity: Activity): Credential? {
            val file = File(appScopeRoot(activity), "llm/config.json")
            val obj = try {
                JSONObject(file.readText())
            } catch (_: Exception) {
                return null
            }
            val baseUrl = obj.optString("baseUrl")
            val apiKey = obj.optString("apiKey")
            val model = obj.optString("model")
            if (baseUrl.isEmpty() || apiKey.isEmpty() || model.isEmpty()) return null
            val provider = obj.optString("provider").ifEmpty { "openai-compatible" }
            return Credential(baseUrl, apiKey, model, provider)
        }
    }

    /** One user-supplied model endpoint: an OpenAI-compatible base URL, its
     * key and the model id. */
    data class Credential(val baseUrl: String, val apiKey: String, val model: String, val provider: String)

    private val carrier = CarrierServer()
    private lateinit var plugins: CarrierPlugins
    private lateinit var bridge: CarrierAPIBridge
    private lateinit var dist: CarrierWebDist
    private lateinit var core: GatewayCore
    private lateinit var seam: SessionWriteSeam
    private lateinit var ui: UiPrimitives

    /** The picker's activity result (MainActivity routes it here — the
     * composer's attachment flow presents the SAF picker). */
    fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
        if (requestCode == UiPrimitives.REQUEST_PICKER) ui.onPickerResult(resultCode, data)
    }

    private var handle: Long = 0
    private var token = ""
    private var webView: WebView? = null

    private var webBootRows: JSONArray? = null
    private var runtimeBootApplied = false
    private var probesDone = false
    private var runtimeFailed = false
    private var comboURL = ""
    private var originOpened = false

    /** Runtime thread: the route table (official dist fallback + /plugins +
     * /api + the scripted llm endpoint), then the spine. */
    private fun begin() {
        val files = activity.filesDir
        val staged = WebPluginsDelivery.build(File(files, "web-plugins"))
            ?: throw IllegalStateException(
                "web-plugins is not staged (bootRelease copies it from assets)",
            )
        token = randomToken()
        plugins = CarrierPlugins.staged(File(files, "web-plugins"))
        val config = CarrierBootConfig.default(plugins)
        comboURL = batchURL(config.bootGraphJSON) ?: ""
        dist = CarrierWebDist(
            distRoot = File(files, "official-web/dist"),
            sessionToken = token,
            indexRows = { CarrierIndexRows.runtimeRows(webBootRows) },
        )
        bridge = CarrierAPIBridge(token)
        bridge.deliverToRuntime = { msg -> deliverRuntime(msg) }
        seam = SessionWriteSeam(bridge)
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
        Log.i(TAG, "serving $CLIENT_ID on 127.0.0.1:${carrier.port}")
        startSpine(staged)
    }

    /** Evals the resident spine scenario through the frozen bridge, wires the
     * gateway (the full primitive table), and delivers runtime.config (the
     * model route, the workspace, the interactive rows) + `web.plugins` +
     * the preset seed. */
    private fun startSpine(pluginsDelivery: JSONArray) {
        val bundle = File(activity.filesDir, "spike")
        core = GatewayCore.create(bundle)
        val fs = FsPrimitives(activity)
        fs.register(core)
        val http = HttpPrimitive()
        http.register(core)
        KeychainPrimitives(activity).register(core)
        NotifyPrimitive(activity).register(core)
        ui = UiPrimitives(activity, fs)
        ui.register(core)
        TimerPrimitive().register(core)
        core.settleFn = { callId, ok, json ->
            SpikeRuntime.post {
                if (handle == 0L) return@post
                onRuntimeStatus(SpikeRuntime.m4Settle(handle, callId, ok, json))
            }
        }
        http.eventFn = { json ->
            SpikeRuntime.post {
                if (handle == 0L) return@post
                onRuntimeStatus(SpikeRuntime.m4Event(handle, json))
            }
        }
        val entry = File(bundle, ENTRY)
        handle = SpikeRuntime.m4Begin(
            activity.filesDir.absolutePath, ENTRY, entry.readText(), DESCRIPTOR,
            "session-serve", runtimeBridge,
        )
        if (handle == 0L) throw IllegalStateException("serve begin: ${SpikeRuntime.m4LastError()}")
        deliverRuntime(runtimeConfig())
        deliverRuntime(
            JSONObject().put("type", "web.plugins").put("plugins", pluginsDelivery),
        )
        AgentPresetsSeed.build(bundle)?.let { deliverRuntime(it) }
    }

    /** The runtime.config delivery. `llmBaseUrl` is present exactly when the
     * user staged a credential, which is what makes turns hit a REAL model
     * instead of the carrier's scripted one. `commands`/`skills` ride only
     * the interactive seat (the "/" surfaces read them). */
    private fun runtimeConfig(): JSONObject {
        val workspace = workspaceRoot(activity)
        val config = JSONObject()
            .put("type", "runtime.config")
            .put("mockLlmUrl", "http://127.0.0.1:${carrier.port}/mock-llm")
            .put("apiKey", MockLlmRoute.KEY)
            .put("containerRoot", workspace.absolutePath)
            .put("fsScopeRoot", appScopeRoot(activity).absolutePath)
        if (credential != null) {
            config
                .put("llmBaseUrl", credential.baseUrl)
                .put("llmApiKey", credential.apiKey)
                .put("llmModel", credential.model)
                .put("llmProvider", credential.provider)
        }
        if (interactive) {
            config
                .put("commands", true)
                .put("fullCoverage", true)
                .put("goals", true)
                .put("fileReferences", true)
                .put("skills", skillsConfig(workspace))
        }
        return config
    }

    /** The skill-plane rows (boot.js `mountSkillPlane` reads them): the
     * dsh home, the agents home, and the user's custom skills dir — all
     * INSIDE the pinned workspace (the fs views refuse anything outside). */
    private fun skillsConfig(workspace: File): JSONObject = JSONObject()
        .put("dshHome", "${workspace.absolutePath}/home")
        .put("agentsHome", "${workspace.absolutePath}/home/agents")
        .put("customSkillDirs", JSONArray().put("${workspace.absolutePath}/skills"))

    /** The full primitive table — the spine and its tools use the real
     * gateway (fs scopes, httpFetch for the llm transport, timers). */
    private val DESCRIPTOR: String = JSONObject()
        .put("available", JSONArray(GatewayCore.PRIMITIVES))
        .put("unavailable", JSONArray()).toString()

    /** The M4Bridge the C host calls back (runtime thread): gateway calls
     * dispatch into the core; bus messages fold into the web-boot row
     * application, the page-open gate, or the claims seam. An unknown bus
     * type is a Log line, never a death — serving mode stays up. */
    private val runtimeBridge = object : SpikeRuntime.M4Bridge {
        override fun onGatewayCall(callId: Int, name: String, args: String) {
            core.dispatch(callId, name, args)
        }

        override fun onBusLine(line: String) {
            val msg = try {
                JSONObject(line)
            } catch (_: Exception) {
                return
            }
            when (msg.optString("type")) {
                "web.boot" -> applyWebBoot(msg)
                "settings.probes.done" -> {
                    probesDone = true
                    maybeOpenOrigin()
                }
                else -> {
                    val handled = seam.onBusMessage(msg)
                    if (!handled) Log.i(TAG, "bus: unhandled '${msg.optString("type")}'")
                }
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
        maybeOpenOrigin()
    }

    /** Carrier → runtime: one bus delivery (any thread; hops onto the runtime
     * thread — the bridge hands over claimed api.request / mux.open frames). */
    private fun deliverRuntime(msg: JSONObject) {
        SpikeRuntime.post {
            if (handle == 0L) return@post
            val status = SpikeRuntime.m4BusDeliver(handle, msg.toString())
            if (status < 0) fail("serve bus deliver: ${SpikeRuntime.m4LastError()}")
        }
    }

    /** 0 = running, 1 = pass, 2 = fail, -1 = error. The scenario stays
     * RESIDENT on success (1 is normal life); a failure still opens the
     * origin so the page renders its own honest state instead of a dead
     * screen, next to the failure line in the log. */
    private fun onRuntimeStatus(status: Int) {
        when (status) {
            0, 1 -> {}
            2 -> fail("the spine scenario failed")
            else -> fail("serve runtime: ${SpikeRuntime.m4LastError()}")
        }
    }

    private fun fail(message: String) {
        runtimeFailed = true
        Log.i(TAG, "FAIL $message")
        maybeOpenOrigin()
    }

    /** Opens the origin once the port is bound AND (the composed boot wire +
     * the settings probes are in, OR the runtime failed — the page shows its
     * own boot state, never a blank WebView). */
    @Synchronized
    private fun maybeOpenOrigin() {
        if (carrier.port == 0 || originOpened) return
        val ready = runtimeBootApplied && probesDone
        if (!ready && !runtimeFailed) return
        originOpened = true
        val port = carrier.port
        activity.runOnUiThread {
            webView?.loadUrl("http://127.0.0.1:$port/?token=$token")
        }
    }

    private fun randomToken(): String = java.security.SecureRandom()
        .run { ByteArray(16).also { nextBytes(it) } }.joinToString("") { "%02x".format(it) }

    /** The application batch's combo URL from the injected graph JSON. */
    private fun batchURL(graphJSON: String): String? = try {
        JSONObject(graphJSON).optJSONArray("batches")?.getJSONObject(0)?.optString("url")
    } catch (_: Exception) {
        null
    }
}
