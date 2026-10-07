package com.dshmobile.host

import org.json.JSONObject

/**
 * The WebAssembly primitive (contract v1.2.0 `wasmRun`) — the Kotlin sibling
 * of the wasmRun leg in hosts/ios Gateway/FSPrimitives.swift. One export of
 * one module, executed IN-PROCESS: the module bytes run through the vendored
 * wasm3 interpreter (dsh_wasm.c, compiled into libdsh_spike beside the
 * quickjs engine — no JIT, no child process, D2). The module is an ordinary
 * file inside an authorized scope and is read through the SAME scope
 * registry the fs primitives use (FsPrimitives.readFor), so executing one
 * adds no filesystem capability of its own. The gateway decides what gets
 * SERVED; this class only answers for the row (until #335 B4 the release
 * seat carried the wasmRun grant and no handler — every shell run settled
 * as a gateway denial).
 *
 * Rejections follow the iOS handler's shapes byte for byte: malformed args
 * are `invalid`, a missing module is `io "cannot read <path>"` (the shape
 * system-plugins/dsh-shell-wasm's not-found branch matches on), and an
 * interpreter failure keeps dsh_wasm.c's own message under `io`.
 *
 * Threading: wasm3 has no interruption API in the pinned 0.9.0 (the #323
 * note's honest limit), and the handler runs on the runtime thread by the
 * gateway's dispatch rules — one synchronous run, one run at a time.
 */
class WasmPrimitive(private val fs: FsPrimitives) {

    fun register(on: GatewayCore) {
        on.register("wasmRun") { call, done -> run(call, done) }
    }

    private fun run(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val scope = call.string("scope")
        val rel = call.string("path")?.let { FsPrimitives.safeRelative(it) }
        val func = call.string("func")
        if (scope == null || rel == null || func == null) {
            return done.settle(
                null,
                GatewayCore.GatewayError(
                    "invalid", "wasmRun", "malformed scope/path/func",
                ),
            )
        }
        val moduleBytes = try {
            fs.readFor(scope, rel, "wasmRun")
        } catch (e: GatewayCore.GatewayError) {
            return done.settle(null, e)
        } catch (e: Exception) {
            return done.settle(
                null,
                GatewayCore.GatewayError(
                    "io", "wasmRun", "cannot read $rel",
                ),
            )
        }
        val input = call.string("input") ?: ""
        val json = JsRuntime.wasmRun(moduleBytes, func, input)
        if (json == null) {
            return done.settle(
                null,
                GatewayCore.GatewayError("io", "wasmRun", JsRuntime.wasmLastError()),
            )
        }
        val payload = try {
            JSONObject(json)
        } catch (_: Exception) {
            return done.settle(
                null,
                GatewayCore.GatewayError("io", "wasmRun", "unreadable result"),
            )
        }
        done.settle(payload, null)
    }
}
