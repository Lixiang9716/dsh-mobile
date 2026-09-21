package com.dshmobile.spike

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import android.widget.TextView
import java.io.File

/**
 * M4 spike host activity. Three launch modes:
 * - default (no extras): copies the spike bundle from assets into
 *   filesDir/spike (the C host fopen()s real paths), then drives ALL THREE
 *   regression scenarios (m1.spike.boot + m2.bridge.smoke + m2.session) on
 *   the serial runtime thread and shows the combined verdict.
 * - `--ez dsh.m4 true`: the M4 completion session — the loopback carrier
 *   serves the embedded Web Client into a real WebView and the full
 *   nine-primitive gateway binding runs UI-driven (SpikeHostM4).
 * - `--ez dsh.llm true`: the M2 real-LLM session (scenario `m2.llm`) — the
 *   same carrier flow, but the JS entry streams one real chat completion
 *   through the gateway httpFetch (credentials in
 *   files/profiles/default/m2-llm/config.json, staged by the E2E runner).
 * The E2E assertion is the captured log, never the screen — views are human
 * evidence only.
 */
class MainActivity : Activity() {

    private lateinit var verdictView: TextView
    private var spikeHost: SpikeHostM4? = null
    private var webView: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        verdictView = TextView(this).apply {
            setBackgroundColor(Color.BLACK)
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            setPadding(64, 64, 64, 64)
            textSize = 16f
            text = "dsh spike host: booting quickjs-ng..."
        }
        when {
            intent.getBooleanExtra(EXTRA_LLM, false) -> startM4(savedInstanceState, llm = true)
            intent.getBooleanExtra(EXTRA_M4, false) -> startM4(savedInstanceState, llm = false)
            else -> {
                setContentView(verdictView)
                SpikeRuntime.post {
                    materializeBundle()
                    val verdict = SpikeRuntime.runOnce(filesDir.absolutePath)
                    runOnUiThread { verdictView.text = verdict }
                }
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
                spikeHost = if (llm) {
                    SpikeHostM4.startLlm(this, view) { verdict -> verdictView.text = verdict }
                } else {
                    SpikeHostM4.start(this, view) { verdict -> verdictView.text = verdict }
                }
            }
        }
        view.post { SpikeHostM4.dispatchNotifyResponse(intent) }
    }

    companion object {
        const val EXTRA_M4 = "dsh.m4"
        const val EXTRA_LLM = "dsh.llm"
    }

    /** Copies the asset spike bundle to filesDir/spike preserving the layout. */
    private fun materializeBundle() {
        copyAssetDir("spike", File(filesDir, "spike"))
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
