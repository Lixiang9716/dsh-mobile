package com.dshmobile.spike

import android.os.Handler
import android.os.HandlerThread

/**
 * Owns the single serial thread the JS runtime lives on (AGENTS.md rule 2: JS
 * executes on one serial thread only — no spike exception). The HandlerThread
 * is started once per process; bundle materialization and every
 * eval/pump/complete cycle run posted on its looper, never on the UI thread.
 */
object SpikeRuntime {

    init {
        System.loadLibrary("dsh_spike")
    }

    private val thread = HandlerThread("dsh-spike-js").also { it.start() }
    private val handler = Handler(thread.looper)

    /** Posts work onto the runtime thread; results come back via callbacks. */
    fun post(block: () -> Unit) {
        handler.post(block)
    }

    /**
     * Runs the full spike lifecycle on the CALLING thread (the runtime
     * thread): one dsh_spike runtime per scenario inside nativeRunSpike —
     * m1.spike.boot (regression) then m2.bridge.smoke (gateway bridge).
     * Returns the combined multi-line verdict.
     */
    fun runOnce(contextDir: String): String = nativeRunSpike(contextDir)

    private external fun nativeRunSpike(contextDir: String): String
}
