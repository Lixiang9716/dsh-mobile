package com.dshmobile.host

import android.os.Handler
import android.os.HandlerThread

/**
 * Owns the single serial thread the JS runtime lives on (AGENTS.md rule 2: JS
 * executes on one serial thread only — no rt exception). The HandlerThread
 * is started once per process; bundle materialization and every
 * eval/pump/complete cycle run posted on its looper, never on the UI thread.
 */
object JsRuntime {

    init {
        System.loadLibrary("dsh_runtime")
    }

    private val thread = HandlerThread("dsh-rt-js").also { it.start() }
    private val handler = Handler(thread.looper)

    /** Posts work onto the runtime thread; results come back via callbacks. */
    fun post(block: () -> Unit) {
        handler.post(block)
    }

    /**
     * Runs the full rt lifecycle on the CALLING thread (the runtime
     * thread): one dsh_spike runtime per scenario inside nativeRunScenario —
     * boot.verification (regression) then gateway.bridge-smoke + session.mock-llm.
     * Returns the combined multi-line verdict.
     */
    fun runOnce(contextDir: String): String = nativeRunScenario(contextDir)

    // ---- M4 completion session (carrier + WebView + real gateway binding) ---
    // The driver (BindingHost) keeps the handle and hops every settle/event/
    // bus delivery back onto THIS thread via post {} — the frozen bridge's
    // runtime-thread-only law. See dsh_runtime_m4.c for the C side.

    /** Object every m4 crossing is delivered to (runtime thread only). */
    interface BindingBridge {
        fun onGatewayCall(callId: Int, name: String, args: String)
        fun onBusLine(line: String)
    }

    /** Creates the m4 runtime: descriptor + dispatch + bus sink + eval +
     * first pump. [captureLabel] names the capture file
     * (rt-capture-<label>.log). Returns 0 on failure (details via
     * bindingLastError()). */
    fun m4Begin(
        contextDir: String,
        entryName: String,
        source: String,
        descriptor: String,
        captureLabel: String,
        bridge: BindingBridge,
    ): Long = nativeBindingBegin(contextDir, entryName, source, descriptor, captureLabel, bridge)

    fun m4Settle(handle: Long, callId: Int, ok: Boolean, payload: String): Int =
        nativeBindingSettle(handle, callId, ok, payload)

    fun m4Event(handle: Long, json: String): Int = nativeBindingEvent(handle, json)

    fun m4BusDeliver(handle: Long, line: String): Int =
        nativeBindingBusDeliver(handle, line)

    fun bindingLastError(): String = nativeBindingLast()

    fun m4End(handle: Long) = nativeBindingEnd(handle)

    // ---- the WebAssembly seam (contract v1.2.0 wasmRun) -------------------
    // The module bytes run IN-PROCESS through the vendored wasm3 (dsh_wasm.c
    // in libdsh_spike); no runtime handle is involved. WasmPrimitive calls
    // this ON the runtime thread (every gateway handler runs there), which is
    // also why the C sink needs no lock: one run at a time is the thread
    // rule. Returns the JSON payload {"result","output"}, or null with the
    // reason in wasmLastError() (the bindingLastError pattern).

    /** Runs one module export; [moduleBytes] is the raw .wasm image. */
    fun wasmRun(moduleBytes: ByteArray, func: String, input: String): String? =
        nativeWasmRun(moduleBytes, func, input)

    fun wasmLastError(): String = nativeWasmLast()

    private external fun nativeWasmRun(
        moduleBytes: ByteArray,
        func: String,
        input: String,
    ): String?

    private external fun nativeWasmLast(): String

    private external fun nativeRunScenario(contextDir: String): String

    private external fun nativeBindingBegin(
        contextDir: String,
        entryName: String,
        source: String,
        descriptor: String,
        captureLabel: String,
        bridge: BindingBridge,
    ): Long

    private external fun nativeBindingSettle(
        handle: Long,
        callId: Int,
        ok: Boolean,
        payload: String,
    ): Int

    private external fun nativeBindingEvent(handle: Long, json: String): Int

    private external fun nativeBindingBusDeliver(handle: Long, line: String): Int

    private external fun nativeBindingLast(): String

    private external fun nativeBindingEnd(handle: Long)
}
