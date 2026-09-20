package com.dshmobile.spike

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import org.json.JSONObject

/**
 * notify (contract/primitives.md §5) plus both frozen event channels —
 * Kotlin sibling of hosts/ios Gateway/NotifyPrimitive.swift. Scheduling
 * answers `{id: "n:<uuid>"}` on the NotificationManager (channel "dsh");
 * the POST_NOTIFICATIONS grant is checked per contract's permission model
 * (the E2E pre-grants via `adb shell pm grant`; refusal rejects `denied`).
 * The contentIntent lands back in the host activity with the id, which
 * delivers `notify.response` — and, frozen order, THEN `app.state
 * foreground`. app.state edges also flow from the activity lifecycle while
 * the session is live (deduped to state changes).
 */
class NotifyPrimitive(private val context: Context) {

    companion object {
        const val CHANNEL_ID = "dsh"
        private fun invalid(msg: String) =
            GatewayCore.GatewayError("invalid", "notify", msg)
    }

    private val manager =
        context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    private var channelReady = false
    private val stateLock = Object()
    private var lastState: String? = null

    /** Wired by the host session: delivers one bridge event (runtime hop). */
    var emitFn: ((json: String) -> Unit)? = null

    fun register(on: GatewayCore) {
        on.register("notify") { call, done -> schedule(call, done) }
    }

    private fun schedule(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val title = call.string("title")
            ?: return done.settle(null, invalid("missing title"))
        val granted = if (Build.VERSION.SDK_INT >= 33) {
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
                PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
        if (!granted) {
            return done.settle(
                null,
                GatewayCore.GatewayError(
                    "denied", "notify", "POST_NOTIFICATIONS refused by user policy",
                ),
            )
        }
        ensureChannel()
        val id = "n:${java.util.UUID.randomUUID()}"
        val intent = PendingIntent.getActivity(
            context,
            0,
            android.content.Intent(context, MainActivity::class.java).apply {
                setFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or
                    android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra(SpikeHostM4.EXTRA_NOTIFY_RESPONSE, id)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(title)
            .apply { call.string("body")?.let { setContentText(it) } }
            .setContentIntent(intent)
            .build()
        try {
            manager.notify(id.hashCode(), notification)
        } catch (e: Exception) {
            return done.settle(
                null,
                GatewayCore.GatewayError("io", "notify", "${e.message}"),
            )
        }
        done.settle(JSONObject().put("id", id), null)
    }

    private fun ensureChannel() {
        if (channelReady) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "DSH", NotificationManager.IMPORTANCE_DEFAULT),
        )
        channelReady = true
    }

    // ---- app.state channel -----------------------------------------------------

    /** Activity lifecycle forwards edges here (deduped to state changes). */
    fun appState(state: String) {
        synchronized(stateLock) {
            if (lastState == state) return
            lastState = state
        }
        emitFn?.invoke(
            JSONObject().put("event", "app.state").put("state", state).toString(),
        )
    }

    /** The user tapped the notification: notify.response first, then —
     * frozen order — app.state foreground. */
    fun notifyResponse(id: String) {
        emitFn?.invoke(JSONObject().put("event", "notify.response").put("id", id).toString())
        appState("foreground")
    }
}
