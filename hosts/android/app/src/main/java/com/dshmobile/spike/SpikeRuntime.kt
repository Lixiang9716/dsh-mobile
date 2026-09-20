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
     * m1.spike.boot (regression) then m2.bridge.smoke + m2.session.
     * Returns the combined multi-line verdict.
     */
    fun runOnce(contextDir: String): String = nativeRunSpike(contextDir)

    // ---- M4 completion session (carrier + WebView + real gateway binding) ---
    // The driver (SpikeHostM4) keeps the handle and hops every settle/event/
    // bus delivery back onto THIS thread via post {} — the frozen bridge's
    // runtime-thread-only law. See dsh_spike_m4.c for the C side.

    /** Object every m4 crossing is delivered to (runtime thread only). */
    interface M4Bridge {
        fun onGatewayCall(callId: Int, name: String, args: String)
        fun onBusLine(line: String)
    }

    /** Creates the m4 runtime: descriptor + dispatch + bus sink + eval +
     * first pump. Returns 0 on failure (details via m4LastError()). */
    fun m4Begin(
        contextDir: String,
        entryName: String,
        source: String,
        descriptor: String,
        bridge: M4Bridge,
    ): Long = nativeM4Begin(contextDir, entryName, source, descriptor, bridge)

    fun m4Settle(handle: Long, callId: Int, ok: Boolean, payload: String): Int =
        nativeM4Settle(handle, callId, ok, payload)

    fun m4Event(handle: Long, json: String): Int = nativeM4Event(handle, json)

    fun m4BusDeliver(handle: Long, line: String): Int =
        nativeM4BusDeliver(handle, line)

    fun m4LastError(): String = nativeM4Last()

    fun m4End(handle: Long) = nativeM4End(handle)

    private external fun nativeRunSpike(contextDir: String): String

    private external fun nativeM4Begin(
        contextDir: String,
        entryName: String,
        source: String,
        descriptor: String,
        bridge: M4Bridge,
    ): Long

    private external fun nativeM4Settle(
        handle: Long,
        callId: Int,
        ok: Boolean,
        payload: String,
    ): Int

    private external fun nativeM4Event(handle: Long, json: String): Int

    private external fun nativeM4BusDeliver(handle: Long, line: String): Int

    private external fun nativeM4Last(): String

    private external fun nativeM4End(handle: Long)
}
