package com.dshmobile.spike

import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.widget.TextView
import java.io.File

/**
 * M1 spike boot activity: copies the spike bundle from assets into
 * filesDir/spike (the C host fopen()s real paths), runs scenario
 * m1.spike.boot on the serial runtime thread, then shows the verdict
 * (PASS/FAIL + engine version). The E2E assertion is the captured log, never
 * this screen — the TextView is human evidence only.
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
            text = "dsh M1 spike: booting quickjs-ng..."
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
