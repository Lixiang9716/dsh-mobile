package com.dshmobile.spike

import android.util.Log
import org.json.JSONObject

/**
 * The capability gateway core — Kotlin sibling of hosts/ios Gateway/-
 * GatewayCore.swift. Dispatch table name→handler, permission enforcement
 * against the caller's bundle manifest (data-protocols.md §2), and the
 * mandatory structured audit of contract/primitives.md §6 — one record per
 * call, never payload contents. Audit rides its own logcat tag
 * ("dsh.rt.audit") with the flat "dsh.gateway.audit: " prefix so the
 * canonical "dsh.spike.log: " E2E stream stays one-to-one. Handlers run on
 * the dispatching (runtime) thread and call done OFF it — every settle hop
 * back via JsRuntime.post (ARCHITECTURE.md §6 thread rules).
 */
class GatewayCore private constructor(val manifest: GatewayManifest) {

    companion object {
        /** The caller identity of the rt bundle (manifest.json id). */
        const val CALLER = "dsh.rt.scenario"

        /** The frozen primitive table (contract v1.4.0: nine + fs additions
         * + wasmRun + ishRun-unavailable-on-android + the timer seam; the
         * capability plane adds the mic pair + cameraCapture, v1.10.0). */
        val PRIMITIVES = listOf(
            "fsRead", "fsWrite", "fsScope", "httpFetch", "notify",
            "presentApproval", "presentPicker", "keychainGet", "keychainSet",
            "fsStat", "fsList", "fsMkdir", "fsRemove", "fsRename",
            "wasmRun", "timerSchedule", "timerCancel",
            "deviceInfo", "haptic", "clipboardRead", "clipboardWrite",
            "presentShare", "keepAwake",
            "cameraCapture",
            "bleScanStart", "bleScanStop", "bleConnect", "bleDisconnect",
            "bleRead", "bleWrite", "bleSubscribe", "bleUnsubscribe",
            "micStart", "micStop",        )

        /** The capability plane's PHASED rows (proposal v1.10.0): shapes on
         * record, implementations follow as their own changes — declared
         * unavailable in the descriptor, and their handlers answer
         * `unavailable`. */
        val PHASED_ROWS = listOf("cameraRecordStart", "cameraRecordStop")
        const val AUDIT_PREFIX = "dsh.gateway.audit: "
        private const val AUDIT_TAG = "dsh.rt.audit"
        private const val UI_TAG = "dsh.rt.ui"

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

        /** E2E driver marker (NOT the canonical stream): ui-wait / ui-done.
         * Harness-only — a release build runs no UI-driven verification. */
        fun uiMarker(name: String, phase: String) {
            if (BuildFlavor.isRelease) return
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
        /** v1.5.0: one flag may gate two primitives — `clipboard` gates both
         * clipboard rows (contract/primitives.md §2, v1.5.0 additions); the
         * capability plane's `microphone` gates the mic pair and its
         * `camera` family gates the three camera rows (v1.10.0). */
        private val familyFlags = mapOf(
            "clipboardRead" to "clipboard",
            "clipboardWrite" to "clipboard",
            "presentShare" to "share",
            "keepAwake" to "screen",
            "cameraCapture" to "camera",
            "cameraRecordStart" to "camera",
            "cameraRecordStop" to "camera",
            "bleScanStart" to "ble",
            "bleScanStop" to "ble",
            "bleConnect" to "ble",
            "bleDisconnect" to "ble",
            "bleRead" to "ble",
            "bleWrite" to "ble",
            "bleSubscribe" to "ble",
            "bleUnsubscribe" to "ble",
            "micStart" to "microphone",
            "micStop" to "microphone",        )

        /** True when the primitive belongs to a capability FAMILY row (the
         * capability plane's promptable surface). */
        fun isCapabilityRow(primitive: String): Boolean =
            familyFlags[primitive] != null

        fun grants(primitive: String): Boolean {
            val names = listOfNotNull(primitive, familyFlags[primitive])
            return required.any { grant ->
                names.any { it == grant || grant.startsWith("$it@") }
            }
        }

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

    /** The capability plane's prompt layer (the socket seam's "--prompt"
     * posture, the proposal's rule 2): a REGISTERED capability-family row
     * the caller lacks the grant for raises the runtime prompt instead of
     * the flat denial. Installed by the capability primitives; nil keeps
     * the v1.5.0 flat-denial behavior byte-for-byte. */
    var capabilityPrompter: ((primitive: String, grant: () -> Unit, deny: () -> Unit) -> Unit)? = null

    /** Entry point of the frozen bridge's on_call — RUNTIME THREAD. Unknown
     * or ungranted primitives settle denied with a "denied" audit verdict;
     * granted calls run their handler (which settles off-thread). */
    fun dispatch(callId: Int, name: String, argsJSON: String) {
        if (name == "httpFetch.abort") return dispatchAbort(name, argsJSON)
        val base = name.substringBefore('.')
        val handler = handlers[name]
        if (handler != null && !manifest.grants(base)
            && capabilityPrompter != null && manifest.isCapabilityRow(base)
        ) {
            // ungranted capability row + a prompter: raise the prompt; the
            // grant path re-enters with the check bypassed (the prompt
            // layer's session grant substitutes for the manifest flag)
            capabilityPrompter?.invoke(name,
                { dispatchKnown(callId, name, argsJSON, enforceGrant = false) },
                { denyFlat(name, callId) })
            return
        }
        dispatchKnown(callId, name, argsJSON, enforceGrant = !manifest.grants(base))
    }

    /** The flat denial the prompt layer's decline settles through. */
    private fun denyFlat(name: String, callId: Int) {
        audit(name, "denied", "denied")
        settleFn?.invoke(
            callId, false,
            errorJSON("denied", name, "primitive not granted to ${manifest.id}"),
        )
    }

    /** The known-primitive continuation of dispatch; `enforceGrant` is
     * false only on the prompt layer's grant path (the runtime approval
     * substitutes for the manifest flag). */
    private fun dispatchKnown(
        callId: Int, name: String, argsJSON: String, enforceGrant: Boolean,
    ) {
        val handler = handlers[name]
        if (handler == null || (enforceGrant && !manifest.grants(name.substringBefore('.')))) {
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

    /** Mandatory structured audit (contract §6): never payload contents.
     * The audit line rides the `dsh.gateway.audit:` E2E stream — debug-only
     * by construction, so a release build emits none. */
    private fun audit(primitive: String, verdict: String, outcome: String) {
        audit(primitive, verdict, outcome, pendingDetail.getAndSet(null))
    }

    private fun audit(primitive: String, verdict: String, outcome: String, detail: JSONObject?) {
        if (BuildFlavor.isRelease) return
        val record = JSONObject()
            .put("ts", java.time.Instant.now().toString())
            .put("primitive", primitive)
            .put("caller", manifest.id)
            .put("verdict", verdict)
            .put("outcome", outcome)
        if (detail != null) record.put("detail", detail)
        Log.i(AUDIT_TAG, AUDIT_PREFIX + record)
    }

    /** The v1.5.0 audit-detail seam: a handler stages the closed-vocabulary
     * facts the §6 table names for the device plane (pattern / hold / share
     * kind / clipboard kind + length — still never payload contents) and the
     * Done wrapper folds them into the call's ONE audit line. Handlers must
     * stage before settling; the runtime's serial dispatch keeps slots from
     * interleaving in practice. */
    fun stageAuditDetail(detail: JSONObject?) {
        pendingDetail.set(detail)
    }

    private val pendingDetail = java.util.concurrent.atomic.AtomicReference<JSONObject?>(null)
}
