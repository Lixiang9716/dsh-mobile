package com.dshmobile.host

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
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
        const val REQUEST_MEDIA = 4003
    }

    private val main = Handler(Looper.getMainLooper())

    /** The scripted-approval launch extra, or null (drives relaunch per
     * leg, so no caching). Surfaced through GET /api/state too. */
    fun scriptedApprovalFlag(): String? {
        val value = activity.intent?.getStringExtra("dsh.script.approval") ?: return null
        return value.takeIf { it in setOf("approve", "remember", "decline") }
    }

    private val PICKER_MODES = setOf("file", "directory", "media")
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
        approvalSettled = false
        builder.create().show()
        scriptAnswerIfAsked(remember, done)
    }

    /** The scripted-approver test seam (the launch extra
     * `dsh.script.approval approve|remember|decline`): the dialog still
     * presents — the native path is exercised — then settles exactly the
     * way the tapped button would, 350 ms later, so drives retire their UI
     * automation on the one dialog the API plane cannot answer by design.
     * Absent the extra the human answers; the product default is unchanged.
     * Exactly one settle per presentation (the seam and a live tap can
     * race — all settle paths run on main). */
    private var approvalSettled = false

    private fun scriptAnswerIfAsked(remember: Boolean, done: GatewayCore.Done) {
        val script = scriptedApprovalFlag() ?: return
        main.postDelayed({
            if (approvalSettled) return@postDelayed
            approvalSettled = true
            GatewayCore.uiMarker("approval", "script")
            android.util.Log.i("dsh.approval", "script answered $script")
            when (script) {
                "remember" -> settleApproval(done, approved = true, remember = remember)
                "decline" -> settleApproval(done, approved = false, remember = false)
                else -> settleApproval(done, approved = true, remember = false)
            }
        }, 350)
    }

    private fun settleApproval(done: GatewayCore.Done, approved: Boolean, remember: Boolean) {
        // Exactly one settle per presentation: the scripted seam and a live
        // tap can race (all settle paths run on main).
        if (approvalSettled) return
        approvalSettled = true
        GatewayCore.uiMarker("approval", "done")
        val result = JSONObject().put("approved", approved)
        if (remember) result.put("remember", true)
        done.settle(result, null)
    }

    // ---- presentPicker ----------------------------------------------------------

    private fun picker(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val mode = call.string("mode") ?: "file"
        if (mode !in PICKER_MODES) {
            return done.settle(
                null,
                GatewayCore.GatewayError(
                    "invalid", "presentPicker", "mode must be file | directory | media: $mode",
                ),
            )
        }
        main.post {
            GatewayCore.uiMarker("picker", "wait")
            if (claimPicker(done)) launchPicker(mode)
        }
    }

    private fun mediaIntent(): Intent =
        if (Build.VERSION.SDK_INT >= 33) {
            Intent(android.provider.MediaStore.ACTION_PICK_IMAGES)
        } else {
            // pre-33 fallback: the document browser over images (labeled rows)
            Intent(Intent.ACTION_GET_CONTENT).setType("image/*")
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

    private fun launchPicker(mode: String) {
        if (mode == "media") {
            activity.startActivityForResult(mediaIntent(), REQUEST_MEDIA)
            return
        }
        val intent = Intent(
            if (mode == "directory") Intent.ACTION_OPEN_DOCUMENT_TREE
            else Intent.ACTION_OPEN_DOCUMENT,
        ).addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION,
        )
        activity.startActivityForResult(intent, REQUEST_PICKER)
    }

    /** The v1.5.0 media pick: the picked image is COPIED into the app scope
     * (profiles/default/media-picks) and granted read-through the app scope
     * — read-through-scope over WHAT THE USER PICKED, never library access. */
    fun onMediaResult(resultCode: Int, data: Intent?) {
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
            val dir = java.io.File(activity.filesDir, "profiles/default/media-picks").apply { mkdirs() }
            val name = "media-%s.jpg".format(java.util.UUID.randomUUID().toString().substring(0, 8))
            activity.contentResolver.openInputStream(uri)?.use { input ->
                input.copyTo(java.io.File(dir, name).outputStream())
            } ?: throw IllegalStateException("empty media stream")
            done.settle(
                JSONObject().put("scope", "app").put("path", "media-picks/$name"),
                null,
            )
        } catch (e: Exception) {
            done.settle(
                null,
                GatewayCore.GatewayError("io", "presentPicker", "picked media could not be staged: ${e.message}"),
            )
        }
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
