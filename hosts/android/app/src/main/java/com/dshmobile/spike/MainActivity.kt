package com.dshmobile.spike

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.TextView
import java.io.File

/**
 * M4 spike host activity. Two launch modes:
 * - default (no extras): copies the spike bundle from assets into
 *   filesDir/spike (the C host fopen()s real paths), then drives ALL THREE
 *   regression scenarios (boot.verification + gateway.bridge-smoke + session.mock-llm) on
 *   the serial runtime thread and shows the combined verdict.
 * - `--ez dsh.m4 true`: the M4 completion session — the loopback carrier
 *   serves the embedded Web Client into a real WebView and the full
 *   nine-primitive gateway binding runs UI-driven (SpikeHostM4).
 * The E2E assertion is the captured log, never the screen — views are human
 * evidence only.
 */
class MainActivity : Activity() {

    private lateinit var verdictView: TextView
    private var spikeHost: SpikeHostM4? = null
    private var webView: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (BuildFlavor.isRelease) {
            bootRelease()
            return
        }
        verdictView = TextView(this).apply {
            setBackgroundColor(Color.BLACK)
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setPadding(64, 64, 64, 64)
            textSize = 16f
            text = "dsh spike host: booting quickjs-ng..."
        }
        if (intent.getBooleanExtra(EXTRA_SUITE, false)) {
            startM4(savedInstanceState, parity = true, suite = intent.getStringExtra(EXTRA_SPEC))
        } else if (intent.getBooleanExtra(EXTRA_PARITY, false)) {
            startM4(savedInstanceState, parity = true)
        } else if (intent.getBooleanExtra(EXTRA_LLM, false)) {
            startM4(savedInstanceState, llm = true)
        } else if (intent.getBooleanExtra(EXTRA_M4, false)) {
            startM4(savedInstanceState, llm = false)
        } else if (intent.getBooleanExtra(EXTRA_WHALE, false)) {
            startM4(savedInstanceState, whale = true)
        } else if (intent.getBooleanExtra(EXTRA_NEXT, false)) {
            startNextWeb()
        } else if (intent.getBooleanExtra(EXTRA_WEB, false)) {
            startOfficialWeb()
        } else if (intent.getBooleanExtra(EXTRA_SESSION, false)) {
            startSessionLive()
        } else if (intent.getBooleanExtra(EXTRA_WRITE, false)) {
            startWriteLive()
        } else {
            setContentView(verdictView)
            SpikeRuntime.post {
                materializeBundle()
                val verdict = SpikeRuntime.runOnce(filesDir.absolutePath)
                runOnUiThread { verdictView.text = verdict }
            }
        }
    }

    /**
     * The theme is NoActionBar (issue #179): the window is edge-to-edge on the
     * enforced-API-35 look, so the WEBVIEW owns the top of the screen — and
     * the system status-bar / cutout region swallowed touches to whatever the
     * page put there (the settings dialog's whole tab strip, its Close
     * button, the sidebar's New-session icon). Inset the content by the
     * system bars so every page element lands at a touchable coordinate; the
     * page viewport simply starts below them. Registered here — after the
     * content view exists — and re-dispatched, because an insets listener
     * attached before setContentView() never sees the first dispatch.
     */
    override fun onResume() {
        super.onResume()
        val content = findViewById<android.view.ViewGroup>(android.R.id.content) ?: return
        content.setOnApplyWindowInsetsListener { view, insets ->
            view.setPadding(0, statusBarInsetTop(insets), 0, 0)
            insets
        }
        content.requestApplyInsets()
        SpikeHostM4.dispatchResume()
    }

    /** Top inset of the system bars + display cutout, in pixels (issue #179). */
    private fun statusBarInsetTop(insets: android.view.WindowInsets): Int =
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            insets.getInsets(
                android.view.WindowInsets.Type.statusBars()
                    or android.view.WindowInsets.Type.displayCutout(),
            ).top
        } else {
            @Suppress("DEPRECATION")
            insets.systemWindowInsetTop
        }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        SpikeHostM4.dispatchNotifyResponse(intent)
    }

    override fun onPause() {
        super.onPause()
        SpikeHostM4.dispatchPause()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        spikeHost?.onActivityResult(requestCode, resultCode, data)
        serve?.onActivityResult(requestCode, resultCode, data)
    }

    private fun startM4(savedInstanceState: Bundle?, llm: Boolean = false, parity: Boolean = false, suite: String? = null, whale: Boolean = false) {
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        layout.addView(
            verdictView,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
        val view = WebView(this).apply {
            settings.javaScriptEnabled = true
            webViewClient = WebViewClient()
        }
        layout.addView(
            view,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f,
            ),
        )
        setContentView(layout)
        webView = view
        // The gateway core reads filesDir/spike at construction: materialize
        // the bundle FIRST (runtime thread), then construct the host.
        SpikeRuntime.post {
            materializeBundle()
            runOnUiThread {
                spikeHost = startHost(llm, view, parity, suite, whale)
            }
        }
        view.post { SpikeHostM4.dispatchNotifyResponse(intent) }
    }

    /** UI thread: constructs the drive — the real-LLM scenario (llm.live-stream),
     * the whale creation-client mount, or the M4 binding — with the same
     * carrier + WebView flow. */
    private fun startHost(llm: Boolean, view: WebView, parity: Boolean = false, suite: String? = null, whale: Boolean = false): SpikeHostM4 {
        val onVerdict = { verdict: String -> verdictView.text = verdict }
        return when {
            suite != null -> SpikeHostM4.startSuite(this, view, onVerdict, suite)
            parity -> SpikeHostM4.startParity(this, view, onVerdict)
            whale -> SpikeHostM4.startWhale(this, view, onVerdict)
            llm -> SpikeHostM4.startLlm(this, view, onVerdict)
            else -> SpikeHostM4.start(this, view, onVerdict)
        }
    }

    companion object {
        const val EXTRA_M4 = "dsh.m4"
        const val EXTRA_LLM = "dsh.llm"
        const val EXTRA_WEB = "dsh.web"
        const val EXTRA_SESSION = "dsh.session"
        const val EXTRA_WRITE = "dsh.write"
        const val EXTRA_PARITY = "dsh.parity"
        const val EXTRA_SUITE = "dsh.suite"
        const val EXTRA_SPEC = "dsh.spec"
        const val EXTRA_WHALE = "dsh.whale"
        const val EXTRA_NEXT = "dsh.next"
        /** The Web Client the release boot serves (string extra; the iOS
         * launch arg -dsh-web-client's sibling — a client selection, not a
         * drive, so the release build accepts it). */
        const val EXTRA_WEB_CLIENT = "dsh.web.client"
    }

    /**
     * The official-web session (`android.officialweb.mount`): the loopback
     * carrier serves the vendored official dist with the runtime-composed
     * boot wire into a real WebView; the web-boot runtime composes the
     * official boot graph over the bus seam (OfficialWebSession).
     */
    private fun startOfficialWeb() {
        val view = drivenWebView { OfficialWebSession.dispatchPageFinished() }
        webView = view
        // The carrier + drive read filesDir trees: materialize FIRST (runtime
        // thread: spike bundle + official dist + web-plugins), then start.
        SpikeRuntime.post {
            materializeBundle()
            copyAssetDir("official-web", File(filesDir, "official-web"))
            copyAssetDir("web-plugins", File(filesDir, "web-plugins"))
            runOnUiThread {
                session = OfficialWebSession.start(this, view, onFinished = { verdict ->
                    verdictView.text = verdict
                })
            }
        }
    }

    private var session: OfficialWebSession? = null
    private var serve: SessionServe? = null
    private var sessionLive: SessionLiveSession? = null
    private var sessionWrite: SessionWriteSession? = null
    private var nextWeb: NextWebSession? = null

    /**
     * The nextweb.mount drive (`android.nextweb.mount`): the SELF-HOSTED web
     * client on the SessionServe seat the user-facing launch runs — selected
     * by client id (dsh-web-client-next), zero injection rows, the same
     * /api + remote.mux surface. The probe drives OUR page like a user
     * (new session → type → send → stop → create) through real agent-loop
     * turns over the carrier's scripted SSE endpoint; the creation row (the
     * present tool) rides the interactive config. Kotlin sibling of hosts/ios
     * NextWebRuntime (the drive class holds the probe chain).
     */
    private fun startNextWeb() {
        val view = drivenWebView { NextWebSession.dispatchPageFinished() }
        webView = view
        // The seat reads filesDir trees: materialize FIRST (runtime thread:
        // spike bundle incl. webclient-next + web-plugins), then drive.
        SpikeRuntime.post {
            materializeBundle()
            copyAssetDir("web-plugins", File(filesDir, "web-plugins"))
            runOnUiThread {
                nextWeb = NextWebSession.start(this, view) { verdict ->
                    verdictView.text = verdict
                }
            }
        }
    }

    /** The driven-mode chrome: the verdict strip over a full-bleed WebView
     * wired to the shared `dshProbe` bridge and the given page-finished
     * dispatcher (the four page-driving modes' identical construction). */
    private fun drivenWebView(onPageFinished: () -> Unit): WebView {
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        layout.addView(
            verdictView,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ),
        )
        val view = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            addJavascriptInterface(PROBE_BRIDGE, "dshProbe")
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    onPageFinished()
                }
            }
        }
        layout.addView(
            view,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f,
            ),
        )
        setContentView(layout)
        return view
    }

    /**
     * The user-facing boot: the official DSH Web Client over the FULL DSH
     * runtime — the SessionServe seat (the sibling of hosts/ios
     * SessionServe.swift). The spine (scenario/composer-web-live.js) boots
     * the vendored DSH packages with the INTERACTIVE surfaces (the commands
     * registry + the skill plane), claims the write/settings surfaces and
     * the mux streams over the bus seam, and goes resident: the page's own
     * composer drives real agent turns. The model route is the staged
     * credential file when present, else the carrier's scripted endpoint
     * (the whole UI works either way). No verification drive, no verdict
     * panel, no per-event E2E record — the "release" half of AGENTS.md
     * constraint 5 / rules.md rule L4. A launch that asks for an E2E drive
     * is refused LOUD (rule 5): this binary has no drives.
     */
    private fun bootRelease() {
        val requested = listOf(EXTRA_M4, EXTRA_LLM, EXTRA_WEB, EXTRA_SESSION, EXTRA_WRITE, EXTRA_PARITY, EXTRA_SUITE, EXTRA_SPEC)
            .firstOrNull { intent.getBooleanExtra(it, false) }
        if (requested != null) {
            error(
                "DSHSpike release build: refusing '$requested'. This is the " +
                    "user-facing distribution build — the verification drives, the " +
                    "verdict panel and the per-event E2E log stream are compiled out " +
                    "(AGENTS.md constraint 5, rules.md rule L4). Install the harness " +
                    "variant (dsh-android-harness) to drive E2E legs.",
            )
        }
        val view = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            addJavascriptInterface(PROBE_BRIDGE, "dshProbe")
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    OfficialWebSession.dispatchPageFinished()
                }
            }
        }
        setContentView(view)
        webView = view
        // The carrier + runtime read filesDir trees: materialize FIRST, then
        // serve. No verdict callback — a user-facing boot has nothing to assert.
        SpikeRuntime.post {
            materializeBundle()
            copyAssetDir("official-web", File(filesDir, "official-web"))
            copyAssetDir("web-plugins", File(filesDir, "web-plugins"))
            runOnUiThread {
                val client = intent.getStringExtra(EXTRA_WEB_CLIENT)
                    ?: SessionServe.CLIENT_ID
                serve = SessionServe.start(
                    this, view,
                    credential = SessionServe.loadCredential(this),
                    clientID = client,
                )
            }
        }
    }

    /** The probe's page-side result sink (JavaBridge thread → session). The
     * drives are addressed; each dispatcher no-ops when its session is not
     * the live one (the modes never run concurrently). */
    private val PROBE_BRIDGE = object : Any() {
        @JavascriptInterface
        fun post(json: String) {
            OfficialWebSession.dispatchProbeResult(json)
            SessionLiveSession.dispatchProbeResult(json)
            SessionWriteSession.dispatchProbeResult(json)
            NextWebSession.dispatchProbeResult(json)
        }
    }

    /** Copies the asset spike bundle to filesDir/spike preserving the layout. */
    private fun materializeBundle() {
        copyAssetDir("spike", File(filesDir, "spike"))
    }

    /**
     * The session-live session (`android.session.live-read`): the FULL upstream
     * agent spine boots on-device and claims `/api/session.list` + the mux
     * `session/journal` streams over the bus seam, so the official page gets
     * REAL session data (SessionLiveSession). Same WebView + carrier shape
     * as the official-web mode; the scripted mock-llm route is the model
     * boundary (E2E determinism, logged as such).
     */
    private fun startSessionLive() {
        val view = drivenWebView { SessionLiveSession.dispatchPageFinished() }
        webView = view
        // The carrier + drive read filesDir trees: materialize FIRST (runtime
        // thread: spike bundle + official dist + web-plugins), then start.
        SpikeRuntime.post {
            materializeBundle()
            copyAssetDir("official-web", File(filesDir, "official-web"))
            copyAssetDir("web-plugins", File(filesDir, "web-plugins"))
            runOnUiThread {
                sessionLive = SessionLiveSession.start(this, view) { verdict ->
                    verdictView.text = verdict
                }
            }
        }
    }

    /**
     * The write-live session (`android.composer.live-write`): the spine + the
     * official write surface over the bus seam (SessionWriteSession); the
     * probe drives the REAL composer (pick the workspace, type, send) and
     * the page's own message produces a real upstream turn rendered back
     * into the official UI. Same WebView + carrier shape as the
     * session-live mode.
     */
    private fun startWriteLive() {
        val view = drivenWebView { SessionWriteSession.dispatchPageFinished() }
        webView = view
        // The carrier + drive read filesDir trees: materialize FIRST (runtime
        // thread: spike bundle + official dist + web-plugins), then start.
        SpikeRuntime.post {
            materializeBundle()
            copyAssetDir("official-web", File(filesDir, "official-web"))
            copyAssetDir("web-plugins", File(filesDir, "web-plugins"))
            runOnUiThread {
                sessionWrite = SessionWriteSession.start(this, view) { verdict ->
                    verdictView.text = verdict
                }
            }
        }
    }

    private fun copyAssetDir(assetPath: String, target: File) {
        val children = assets.list(assetPath).orEmpty()
        if (children.isEmpty()) {
            copyAssetFile(assetPath, target)
            return
        }
        target.mkdirs()
        for (child in children) {
            copyAssetDir("$assetPath/$child", File(target, child))
        }
    }

    private fun copyAssetFile(assetPath: String, target: File) {
        assets.open(assetPath).use { input ->
            target.outputStream().use { output -> input.copyTo(output) }
        }
    }
}
