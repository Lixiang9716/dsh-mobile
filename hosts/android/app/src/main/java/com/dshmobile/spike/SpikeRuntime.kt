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
     * thread): dsh_spike_new/eval/pump/complete inside nativeRunSpike.
     * Returns the verdict line, e.g. "PASS | quickjs-ng 0.17.0".
     */
    fun runOnce(contextDir: String): String = nativeRunSpike(contextDir)

    private external fun nativeRunSpike(contextDir: String): String
}
