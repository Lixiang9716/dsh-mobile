package com.dshmobile.spike

import android.app.Activity
import org.json.JSONObject

/**
 * The BLE face's consent collaborator (the system capability plane, grant
 * family `ble`) — split from [BlePrimitives] so the gateway-prompt ladder
 * and the OS runtime-permission layer live in one file:
 *
 * - the GATEWAY layer (rule 2, first): an ungranted capability row the
 *   dispatch prompter hands over raises the SAME dialog presentApproval
 *   uses — approve / approve & remember / decline; the grant is
 *   session-scoped, "remember" persists app-scoped (the clipboardRead
 *   posture; revocation = deleting the app until a settings face exists).
 * - the OS layer (rule 2, second): the first radio-touching call on an
 *   API 31+ device whose runtime permissions are not granted raises the
 *   platform request; a refusal settles `denied` naming the layer — the
 *   audit carries the layer that refused, never payload bytes.
 */
class BleConsentLayer(
    private val activity: Activity,
    private val core: GatewayCore,
) {

    companion object {
        /** The standing-grant key ("Approve & Remember" persists app-scoped
         * SharedPreferences — the clipboardRead posture). */
        const val STANDING_GRANT_KEY = "dsh.ble.granted"

        /** The OS runtime-permission request code (MainActivity routes the
         * result back through SpikeHostM4 → onPermissionResult). */
        const val REQUEST_BLE = 4102
    }

    /** The session-scoped gateway grant (dies with the session). */
    private var sessionGrant = false
    /** The OS prompt layer's in-flight state (rule 2's second layer): the
     * body to run on grant, the settle on refusal — one at a time (the
     * caller is serial, D2). */
    private var permissionRequested = false
    private var pendingOsPrompt: Pair<String, Pair<GatewayCore.Done, () -> Unit>>? = null

    /** The prompt layer's own gate: the session/standing grants answer
     * without UI; otherwise the alert asks (main thread, per the UI rule). */
    fun ensurePrompt(grant: () -> Unit, deny: () -> Unit) {
        if (holdsGrant()) {
            grant()
            return
        }
        GatewayCore.uiMarker("ble-consent", "wait")
        activity.runOnUiThread {
            buildConsentDialog(grant, deny).show()
        }
    }

    /** The gateway consent surface — the three answers are the approval
     * ladder; each handler is a named method so the builder chain stays
     * inside the indent budget. */
    private fun buildConsentDialog(
        grant: () -> Unit, deny: () -> Unit,
    ): android.app.AlertDialog {
        val approve = { _: android.content.DialogInterface, _: Int ->
            GatewayCore.uiMarker("ble-consent", "done")
            sessionGrant = true
            grant()
        }
        val remember = { _: android.content.DialogInterface, _: Int ->
            GatewayCore.uiMarker("ble-consent", "done")
            rememberGrant()
            grant()
        }
        val decline = { _: android.content.DialogInterface, _: Int ->
            GatewayCore.uiMarker("ble-consent", "done")
            deny()
        }
        return android.app.AlertDialog.Builder(activity)
            .setTitle("Allow Bluetooth access?")
            .setMessage(
                "The agent wants to reach nearby BLE devices (scan, connect, "
                    + "GATT). Approve once, always, or decline.")
            .setPositiveButton("Approve", approve)
            .setNeutralButton("Approve & Remember", remember)
            .setNegativeButton("Decline", decline)
            .create()
    }

    /** The session grant dies with the session; "remember" persists the
     * app-scoped standing grant (the clipboardRead posture). */
    private fun rememberGrant() {
        activity.getSharedPreferences("dsh", 0).edit()
            .putBoolean(STANDING_GRANT_KEY, true).apply()
        sessionGrant = true
    }

    /** The standing/session grant (the manifest grant is checked by the
     * core before the prompter is ever consulted). */
    fun holdsGrant(): Boolean =
        sessionGrant
            || activity.getSharedPreferences("dsh", 0)
                .getBoolean(STANDING_GRANT_KEY, false)

    /** rule 2's OS prompt layer: the FIRST refused call on an API 31+
     * device raises the runtime request instead of a flat denial (the
     * radio is there — ask); a refusal after the request, or the legacy
     * floor, settles denied. */
    fun osPromptPossible(): Boolean =
        android.os.Build.VERSION.SDK_INT >= 31 && !permissionRequested

    fun requestOsPermission(
        primitive: String, done: GatewayCore.Done, body: () -> Unit,
    ) {
        permissionRequested = true
        pendingOsPrompt = primitive to (done to body)
        GatewayCore.uiMarker("ble-permission", "wait")
        activity.requestPermissions(
            arrayOf(
                android.Manifest.permission.BLUETOOTH_SCAN,
                android.Manifest.permission.BLUETOOTH_CONNECT,
            ),
            REQUEST_BLE,
        )
    }

    fun denyOs(primitive: String, reason: String, done: GatewayCore.Done) {
        core.stageAuditDetail(
            JSONObject().put("layer", "os").put("family", "ble"))
        done.settle(null, GatewayCore.GatewayError(
            "denied", primitive, reason))
    }

    /** MainActivity → SpikeHostM4 route the OS prompt's verdict here: the
     * pending call proceeds on grant; a refusal settles denied (layer os). */
    fun onPermissionResult(granted: Boolean) {
        val pending = pendingOsPrompt
        pendingOsPrompt = null
        if (pending == null) return
        val (primitive, pair) = pending
        val (done, body) = pair
        GatewayCore.uiMarker("ble-permission", "done")
        if (granted) {
            body()
        } else {
            denyOs(primitive,
                "bluetooth runtime permissions refused by the OS prompt", done)
        }
    }
}
