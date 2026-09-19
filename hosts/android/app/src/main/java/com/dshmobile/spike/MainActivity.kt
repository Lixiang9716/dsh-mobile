package com.dshmobile.spike

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.widget.TextView
import java.io.File

/**
 * M4 spike host activity: copies the spike bundle from assets into
 * filesDir/spike (the C host fopen()s real paths), then drives BOTH
 * scenarios (m1.spike.boot regression + m2.bridge.smoke gateway bridge) on
 * the serial runtime thread and shows the combined verdict. The E2E
 * assertion is the captured log, never this screen — the TextView is human
 * evidence only.
 */
class MainActivity : Activity() {

    private lateinit var verdictView: TextView

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
        setContentView(verdictView)
        SpikeRuntime.post {
            materializeBundle()
            val verdict = SpikeRuntime.runOnce(filesDir.absolutePath)
            runOnUiThread { verdictView.text = verdict }
        }
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
