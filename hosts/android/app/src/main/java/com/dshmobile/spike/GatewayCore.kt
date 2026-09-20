package com.dshmobile.spike

import android.util.Log
import org.json.JSONObject

/**
 * The capability gateway core — Kotlin sibling of hosts/ios Gateway/-
 * GatewayCore.swift. Dispatch table name→handler, permission enforcement
 * against the caller's bundle manifest (data-protocols.md §2), and the
 * mandatory structured audit of contract/primitives.md §6 — one record per
 * call, never payload contents. Audit rides its own logcat tag
 * ("dsh.spike.audit") with the flat "dsh.gateway.audit: " prefix so the
 * canonical "dsh.spike.log: " E2E stream stays one-to-one. Handlers run on
 * the dispatching (runtime) thread and call done OFF it — every settle hop
 * back via SpikeRuntime.post (ARCHITECTURE.md §6 thread rules).
 */
class GatewayCore private constructor(val manifest: GatewayManifest) {

    companion object {
        /** The caller identity of the spike bundle (manifest.json id). */
        const val CALLER = "dsh.spike.scenario"

        /** The nine frozen primitives (contract/primitives.md §2). */
        val PRIMITIVES = listOf(
            "fsRead", "fsWrite", "fsScope", "httpFetch", "notify",
            "presentApproval", "presentPicker", "keychainGet", "keychainSet",
        )
        const val AUDIT_PREFIX = "dsh.gateway.audit: "
        private const val AUDIT_TAG = "dsh.spike.audit"
        private const val UI_TAG = "dsh.spike.ui"

        /** Fails loud (rules.md rule 5): bundle_root/manifest.json must exist. */
        fun create(bundleRoot: java.io.File): GatewayCore {
            val file = java.io.File(bundleRoot, "manifest.json")
            val obj = JSONObject(file.readText())
            val id = obj.getString("id")
            if (id != CALLER) {
                error("unexpected caller identity $id")
            }
            val required = obj.getJSONObject("capabilities").getJSONArray("required")
                .let { arr -> List(arr.length()) { arr.getString(it) } }
            return GatewayCore(GatewayManifest(id, required))
        }

        /** Canonical JSON line for a GatewayError-shaped rejection. */
        fun errorJSON(code: String, primitive: String, message: String): String =
            JSONObject().put("code", code).put("primitive", primitive)
                .put("message", message).toString()

        /** E2E driver marker (NOT the canonical stream): ui-wait / ui-done. */
        fun uiMarker(name: String, phase: String) {
            Log.i(UI_TAG, "ui-$phase $name")
        }
    }

    class GatewayError(
        val code: String,
        val primitive: String,
        message: String,
    ) : Exception(message)

    /** The caller identity + its required capability strings. */
    class GatewayManifest(val id: String, val required: List<String>) {
        /** `<name>` or `<name>@<major>` grammar (contract §6). */
        fun grants(primitive: String): Boolean =
            required.any { it == primitive || it.startsWith("$primitive@") }
    }

    /** One settled primitive call; args is the bridge's parsed JSON object. */
    class GatewayCall(val callId: Int, val args: JSONObject) {
        fun string(key: String): String? =
            if (args.has(key) && !args.isNull(key)) args.getString(key) else null

        fun optLong(key: String): Long? =
            if (args.has(key) && !args.isNull(key)) args.getLong(key) else null
    }

    fun interface Done {
        /** Payload = JSON value (JSONObject/Boolean/String/number/null). */
        fun settle(result: Any?, error: GatewayError?)
    }

    private val handlers = HashMap<String, (GatewayCall, Done) -> Unit>()

    /** Wired by the session; hops onto the runtime thread (JNI). */
    var settleFn: ((callId: Int, ok: Boolean, json: String) -> Unit)? = null

    fun register(name: String, handler: (GatewayCall, Done) -> Unit) {
        handlers[name] = handler
    }

    /** Entry point of the frozen bridge's on_call — RUNTIME THREAD. Unknown
     * or ungranted primitives settle denied with a "denied" audit verdict;
     * granted calls run their handler (which settles off-thread). */
    fun dispatch(callId: Int, name: String, argsJSON: String) {
        if (name == "httpFetch.abort") return dispatchAbort(name, argsJSON)
        val base = name.substringBefore('.')
        val handler = handlers[name]
        if (handler == null || !manifest.grants(base)) {
            audit(name, "denied", "denied")
            settleFn?.invoke(
                callId, false,
                errorJSON("denied", name, "primitive not granted to ${manifest.id}"),
            )
            return
        }
        val args = try {
            JSONObject(if (argsJSON.isBlank()) "{}" else argsJSON)
        } catch (e: Exception) {
            audit(name, "granted", "invalid")
            settleFn?.invoke(callId, false, errorJSON("invalid", name, "args JSON unparseable"))
            return
        }
        val done = Done { result, error ->
            if (error != null) {
                audit(name, "granted", error.code)
                settleFn?.invoke(callId, false, errorJSON(error.code, name, error.message ?: ""))
            } else {
                audit(name, "granted", "ok")
                val json = when (result) {
                    null -> "null"
                    is JSONObject -> result.toString()
                    is String -> JSONObject.quote(result)
                    is Boolean, is Int, is Long -> result.toString()
                    else -> error("unsupported settle payload ${result::class.java}")
                }
                settleFn?.invoke(callId, true, json)
            }
        }
        try {
            handler(GatewayCall(callId, args), done)
        } catch (e: Exception) {
            done.settle(
                null,
                GatewayError("io", name, "${e::class.java.simpleName}: ${e.message ?: ""}"),
            )
        }
    }

    /** Control-plane abort (frozen bridge): audited, never settled. */
    private fun dispatchAbort(name: String, argsJSON: String) {
        val call = GatewayCall(-1, try {
            JSONObject(if (argsJSON.isBlank()) "{}" else argsJSON)
        } catch (_: Exception) {
            JSONObject()
        })
        handlers[name]?.invoke(call) { _, _ -> }
        audit(name, "granted", "ok")
    }

    /** Mandatory structured audit (contract §6): never payload contents. */
    private fun audit(primitive: String, verdict: String, outcome: String) {
        val record = JSONObject()
            .put("ts", java.time.Instant.now().toString())
            .put("primitive", primitive)
            .put("caller", manifest.id)
            .put("verdict", verdict)
            .put("outcome", outcome)
        Log.i(AUDIT_TAG, AUDIT_PREFIX + record)
    }
}
