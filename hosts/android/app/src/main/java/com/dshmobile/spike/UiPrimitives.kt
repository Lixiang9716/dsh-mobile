package com.dshmobile.spike

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import org.json.JSONObject

/**
 * The native UI primitives (contract/primitives.md §4) — Kotlin sibling of
 * hosts/ios Gateway/UIPrimitives.swift. presentApproval is an AlertDialog
 * (Approve / Decline, plus "Approve & Remember" when allowRemember);
 * presentPicker is the SAF documents UI — ACTION_OPEN_DOCUMENT (file) or
 * ACTION_OPEN_DOCUMENT_TREE (directory). A pick grants a fresh user scope
 * (fs.grantUserScope) with the persistable URI permission taken; user
 * dismissal resolves null and grants nothing (a value, never an error).
 * Results arrive on the activity's onActivityResult, hop back through the
 * handler `done`s on any thread (the core routes the settle onto the
 * runtime queue). Every automatable surface emits the frozen
 * ui-wait/ui-done markers for the E2E driver.
 */
class UiPrimitives(
    private val activity: Activity,
    private val fs: FsPrimitives,
) {

    companion object {
        const val REQUEST_APPROVAL = 4001
        const val REQUEST_PICKER = 4002
    }

    private val main = Handler(Looper.getMainLooper())
    private val stateLock = Object()
    private var pendingPicker: GatewayCore.Done? = null

    fun register(on: GatewayCore) {
        on.register("presentApproval") { call, done -> approval(call, done) }
        on.register("presentPicker") { call, done -> picker(call, done) }
    }

    // ---- presentApproval --------------------------------------------------------

    private fun approval(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val title = call.string("title") ?: ""
        val detail = call.string("detail")
        val remember = call.args.optBoolean("allowRemember", false)
        main.post { showDialog(title, detail, remember, done) }
    }

    private fun showDialog(
        title: String,
        detail: String?,
        remember: Boolean,
        done: GatewayCore.Done,
    ) {
        GatewayCore.uiMarker("approval", "wait")
        val builder = android.app.AlertDialog.Builder(activity).setTitle(title)
        if (detail != null) builder.setMessage(detail)
        builder.setPositiveButton("Approve") { _, _ ->
            settleApproval(done, approved = true, remember = false)
        }
        builder.setNegativeButton("Decline") { _, _ ->
            settleApproval(done, approved = false, remember = false)
        }
        if (remember) {
            builder.setNeutralButton("Approve & Remember") { _, _ ->
                settleApproval(done, approved = true, remember = true)
            }
        }
        builder.create().show()
    }

    private fun settleApproval(done: GatewayCore.Done, approved: Boolean, remember: Boolean) {
        GatewayCore.uiMarker("approval", "done")
        val result = JSONObject().put("approved", approved)
        if (remember) result.put("remember", true)
        done.settle(result, null)
    }

    // ---- presentPicker ----------------------------------------------------------

    private fun picker(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val directory = call.string("mode") == "directory"
        main.post {
            GatewayCore.uiMarker("picker", "wait")
            if (claimPicker(done)) launchPicker(directory)
        }
    }

    /** Claims the single pending-picker slot; settles `invalid` when one is
     * already in flight. */
    private fun claimPicker(done: GatewayCore.Done): Boolean = synchronized(stateLock) {
        if (pendingPicker != null) {
            done.settle(
                null,
                GatewayCore.GatewayError(
                    "invalid", "presentPicker", "picker already pending",
                ),
            )
            false
        } else {
            pendingPicker = done
            true
        }
    }

    private fun launchPicker(directory: Boolean) {
        val intent = Intent(
            if (directory) Intent.ACTION_OPEN_DOCUMENT_TREE
            else Intent.ACTION_OPEN_DOCUMENT,
        ).addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
        )
        activity.startActivityForResult(intent, REQUEST_PICKER)
    }

    /** Activity callback (UI thread): grant or dismiss. */
    fun onPickerResult(resultCode: Int, data: Intent?) {
        val done = synchronized(stateLock) {
            val d = pendingPicker
            pendingPicker = null
            d
        } ?: return
        GatewayCore.uiMarker("picker", "done")
        val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null) {
            return done.settle(null, null) // user dismissal is a value
        }
        try {
            activity.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
        } catch (_: Exception) {
            // read-only trees still grant a readable scope
        }
        done.settle(
            JSONObject().put("scope", fs.grantUserScope(uri)).put("path", JSONObject.NULL),
            null,
        )
    }
}
