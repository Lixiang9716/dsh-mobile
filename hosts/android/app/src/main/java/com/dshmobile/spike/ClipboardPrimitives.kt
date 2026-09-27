package com.dshmobile.spike

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import org.json.JSONObject

/**
 * The v1.5.0 clipboard pair (permission `clipboard`) — Kotlin sibling of
 * hosts/ios Gateway/ClipboardPrimitives.swift. The read direction is the
 * exfiltration direction, so clipboardRead is approval-gated by default:
 * the call surfaces the SAME AlertDialog presentApproval uses (Approve /
 * Approve & Remember / Decline) unless the user already granted a standing
 * one ("Approve & Remember" persists in SharedPreferences). The audit
 * record for a read carries the call only — never the text; the write
 * audits kind + length (contract §6).
 */
class ClipboardPrimitives(
    private val activity: Activity,
) {

    private lateinit var core: GatewayCore

    companion object {
        const val PREFS = "dsh-device-plane"
        const val STANDING_GRANT_KEY = "clipboard.read.granted"
    }

    private val prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun register(on: GatewayCore) {
        core = on
        on.register("clipboardRead") { call, done -> read(call, done) }
        on.register("clipboardWrite") { call, done -> write(call, done) }
    }

    // ---- clipboardRead (approval-gated by default) ----------------------------

    private fun read(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        if (prefs.getBoolean(STANDING_GRANT_KEY, false)) return settleRead(done)
        requestApproval(call, done)
    }

    /** The approval surface (same dialog as presentApproval); approval
     * settles the read, decline settles null WITHOUT touching the
     * pasteboard — the user refused, and a refusal is a value. */
    private fun requestApproval(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        GatewayCore.uiMarker("clipboard-read", "wait")
        val builder = android.app.AlertDialog.Builder(activity)
            .setTitle(call.string("title") ?: "Allow clipboard read?")
            .setMessage(
                call.string("detail")
                    ?: "The agent wants to read the clipboard. Approve once, always, or decline.",
            )
            .setPositiveButton("Approve") { _, _ ->
                core.stageAuditDetail(null)
                settleRead(done)
            }
            .setNeutralButton("Approve & Remember") { _, _ ->
                prefs.edit().putBoolean(STANDING_GRANT_KEY, true).apply()
                core.stageAuditDetail(null)
                settleRead(done)
            }
            .setNegativeButton("Decline") { _, _ ->
                GatewayCore.uiMarker("clipboard-read", "done")
                done.settle(null, null)
            }
        activity.runOnUiThread { builder.show() }
    }

    /** The pasteboard read + settle, after consent. Empty/non-text is null. */
    private fun settleRead(done: GatewayCore.Done) {
        GatewayCore.uiMarker("clipboard-read", "done")
        val manager = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        val text = manager?.primaryClip?.getItemAt(0)?.coerceToText(activity)?.toString()
        if (text != null) {
            done.settle(JSONObject().put("kind", "text").put("text", text), null)
        } else {
            done.settle(null, null)
        }
    }

    // ---- clipboardWrite --------------------------------------------------------

    private fun write(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val text = call.string("text")
            ?: return done.settle(
                null,
                GatewayCore.GatewayError("invalid", "clipboardWrite", "text missing"),
            )
        val manager = activity.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            ?: return done.settle(
                null,
                GatewayCore.GatewayError("unavailable", "clipboardWrite", "no clipboard service"),
            )
        manager.setPrimaryClip(ClipData.newPlainText("dsh", text))
        core.stageAuditDetail(JSONObject().put("kind", "text").put("length", text.length))
        done.settle(null, null)
    }
}
