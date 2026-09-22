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
        if (intent.getBooleanExtra(EXTRA_LLM, false)) {
            startM4(savedInstanceState, llm = true)
        } else if (intent.getBooleanExtra(EXTRA_M4, false)) {
            startM4(savedInstanceState, llm = false)
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

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        SpikeHostM4.dispatchNotifyResponse(intent)
    }

    override fun onPause() {
        super.onPause()
        SpikeHostM4.dispatchPause()
    }

    override fun onResume() {
        super.onResume()
        SpikeHostM4.dispatchResume()
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        spikeHost?.onActivityResult(requestCode, resultCode, data)
    }

    private fun startM4(savedInstanceState: Bundle?, llm: Boolean) {
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
                spikeHost = startHost(llm, view)
            }
        }
        view.post { SpikeHostM4.dispatchNotifyResponse(intent) }
    }

    /** UI thread: constructs the drive — the real-LLM scenario (llm.live-stream) or
     * the M4 binding — with the same carrier + WebView flow. */
    private fun startHost(llm: Boolean, view: WebView): SpikeHostM4 {
        val onVerdict = { verdict: String -> verdictView.text = verdict }
        return if (llm) {
            SpikeHostM4.startLlm(this, view, onVerdict)
        } else {
            SpikeHostM4.start(this, view, onVerdict)
        }
    }

    companion object {
        const val EXTRA_M4 = "dsh.m4"
        const val EXTRA_LLM = "dsh.llm"
        const val EXTRA_WEB = "dsh.web"
        const val EXTRA_SESSION = "dsh.session"
        const val EXTRA_WRITE = "dsh.write"
    }

    /**
     * The official-web session (`android.officialweb.mount`): the loopback
     * carrier serves the vendored official dist with the runtime-composed
     * boot wire into a real WebView; the web-boot runtime composes the
     * official boot graph over the bus seam (OfficialWebSession).
     */
    private fun startOfficialWeb() {
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
                    OfficialWebSession.dispatchPageFinished()
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
    private var sessionLive: SessionLiveSession? = null
    private var sessionWrite: SessionWriteSession? = null

    /**
     * The user-facing boot: the official DSH Web Client, full screen, no
     * extras required. The vendored dist + client bundles are already in the
     * APK's assets (the Gradle staging), so a plain launch needs nothing
     * pushed from outside. No verification drive runs, no verdict panel
     * exists, and no per-event E2E record is produced — the "release" half of
     * AGENTS.md constraint 5 / rules.md rule L4. A launch that asks for an
     * E2E drive is refused LOUD (rule 5): this binary has no drives.
     */
    private fun bootRelease() {
        val requested = listOf(EXTRA_M4, EXTRA_LLM, EXTRA_WEB, EXTRA_SESSION, EXTRA_WRITE)
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
        // serve. No verdict callback — nothing asserts on a user-facing boot.
        SpikeRuntime.post {
            materializeBundle()
            copyAssetDir("official-web", File(filesDir, "official-web"))
            copyAssetDir("web-plugins", File(filesDir, "web-plugins"))
            runOnUiThread {
                // No verdict callback: a user-facing boot has nothing to assert.
                session = OfficialWebSession.start(
                    this, view, onFinished = { _ -> }, evidence = false,
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
                    SessionLiveSession.dispatchPageFinished()
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
                    SessionWriteSession.dispatchPageFinished()
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
