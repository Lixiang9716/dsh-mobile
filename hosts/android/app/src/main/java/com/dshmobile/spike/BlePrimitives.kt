package com.dshmobile.spike

import android.app.Activity
import org.json.JSONObject

/**
 * The BLE face (the system capability plane, grant family `ble`): eight
 * primitives over one radio ([SystemBleRadio] on hardware, [MockBleRadio]
 * on the E2E legs — same enforcement, same audit). Consent is TWO layers:
 * the gateway grant first (the caller manifest's family flag; a caller
 * without it gets the SAME dialog presentApproval uses — approve once /
 * approve & remember / decline), the OS runtime permission second. The
 * audit record names the layer that refused; byte counts ride the records,
 * never payload bytes. `ble.event` records (device batches, GATT
 * notifications, disconnects) ride the emit seam — never polled (D8).
 */
class BlePrimitives(
    private val activity: Activity,
    private val core: GatewayCore,
    radio: BleRadio,
) {

    companion object {
        /** The standing-grant key ("Approve & Remember" persists app-scoped
         * SharedPreferences — the clipboardRead posture). */
        const val STANDING_GRANT_KEY = "dsh.ble.granted"

        private fun gattDetail(
            direction: String, connectionId: String,
            service: String, characteristic: String, bytes: Int,
        ): JSONObject {
            val detail = JSONObject()
                .put("direction", direction)
                .put("connectionId", connectionId)
                .put("service", service)
                .put("characteristic", characteristic)
            if (direction == "read" || direction == "write") {
                detail.put("bytes", bytes)
            } else {
                detail.put("subscribed", direction == "subscribe")
            }
            return detail
        }
    }

    private val radio: BleRadio = radio
    /** The session-scoped gateway grant (dies with the session). */
    private var sessionGrant = false
    private val armedScans = HashMap<String, Long>()
    /** Wired by the host session: delivers one bridge event (the emit seam
     * already hops onto the serial runtime queue). */
    var emitFn: ((json: String) -> Unit)? = null

    fun register(on: GatewayCore) {
        on.register("bleScanStart") { call, done -> scanStart(call, done) }
        on.register("bleScanStop") { call, done -> scanStop(call, done) }
        on.register("bleConnect") { call, done -> connect(call, done) }
        on.register("bleDisconnect") { call, done -> disconnect(call, done) }
        on.register("bleRead") { call, done -> read(call, done) }
        on.register("bleWrite") { call, done -> write(call, done) }
        on.register("bleSubscribe") { call, done -> subscribe(call, done) }
        on.register("bleUnsubscribe") { call, done -> unsubscribe(call, done) }
        radio.deviceSink = { device -> deviceArrived(device) }
    }

    // ---- the gateway consent layer ------------------------------------------

    /** The family grant: manifest-declared, session-granted (this session's
     * prompt approval), or the standing grant. Missing ⇒ the runtime prompt
     * (rule 2) — refusal settles `denied` with audit layer "gateway". */
    private fun ensureGrant(
        primitive: String, call: GatewayCore.GatewayCall,
        done: GatewayCore.Done, body: () -> Unit,
    ) {
        if (core.manifest.grants(primitive) || sessionGrant
            || activity.getSharedPreferences("dsh", 0)
                .getBoolean(STANDING_GRANT_KEY, false)
        ) {
            body()
            return
        }
        requestPrompt(primitive, done, body)
    }

    private fun requestPrompt(
        primitive: String, done: GatewayCore.Done, body: () -> Unit,
    ) {
        GatewayCore.uiMarker("ble-consent", "wait")
        activity.runOnUiThread {
            val dialog = android.app.AlertDialog.Builder(activity)
                .setTitle("Allow Bluetooth access?")
                .setMessage(
                    "The agent wants to reach nearby BLE devices (scan, connect, "
                        + "GATT). Approve once, always, or decline.")
                .setPositiveButton("Approve") { _, _ ->
                    GatewayCore.uiMarker("ble-consent", "done")
                    sessionGrant = true
                    body()
                }
                .setNeutralButton("Approve & Remember") { _, _ ->
                    GatewayCore.uiMarker("ble-consent", "done")
                    activity.getSharedPreferences("dsh", 0).edit()
                        .putBoolean(STANDING_GRANT_KEY, true).apply()
                    sessionGrant = true
                    body()
                }
                .setNegativeButton("Decline") { _, _ ->
                    GatewayCore.uiMarker("ble-consent", "done")
                    done.settle(
                        null,
                        GatewayCore.GatewayError(
                            "denied", primitive,
                            "the gateway consent layer refused"),
                    )
                }
                .create()
            dialog.show()
        }
    }

    // ---- the OS consent + capability gate ------------------------------------

    /** The radio's consent verdict → the call proceeds, or the honest
     * rejection (`unavailable` for a missing radio, `denied` naming the OS
     * layer). Runs before every radio-touching call. */
    private fun ensureRadio(
        primitive: String, done: GatewayCore.Done, body: () -> Unit,
    ) {
        when (val refusal = radio.consent()) {
            null -> body()
            is BleRadioFailure.OsDenied -> {
                core.stageAuditDetail(
                    JSONObject().put("layer", "os").put("family", "ble"))
                done.settle(null, GatewayCore.GatewayError(
                    "denied", primitive, refusal.reason))
            }
            is BleRadioFailure.Unsupported -> {
                done.settle(null, GatewayCore.GatewayError(
                    "unavailable", primitive, refusal.reason))
            }
        }
    }

    // ---- scan -----------------------------------------------------------------

    private fun scanStart(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        ensureGrant("bleScanStart", call, done) {
            ensureRadio("bleScanStart", done) {
                val filter = call.args.optJSONArray("serviceUuids")
                    ?.let { arr -> List(arr.length()) { arr.getString(it) } } ?: emptyList()
                val asked = call.args.optInt("timeoutMs", 5_000)
                radio.scanStart(filter, asked) { result ->
                    when (result) {
                        is BleResult.Ok -> {
                            val scanId = result.value
                            synchronized(armedScans) { armedScans[scanId] = System.nanoTime() }
                            val detail = JSONObject()
                                .put("scanId", scanId)
                                .put("filters", filter.size)
                                .put("timeoutMs", bleScanTimeoutClamp(asked))
                            val tag = call.args.optString("tag", "")
                            if (tag.isNotEmpty()) detail.put("tag", tag)
                            core.stageAuditDetail(detail)
                            done.settle(JSONObject().put("scanId", scanId), null)
                        }
                        is BleResult.Err -> doneRadioFailure("bleScanStart", result.failure, done)
                    }
                }
            }
        }
    }

    private fun scanStop(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val scanId = call.string("scanId")
        if (scanId == null) {
            done.settle(null, GatewayCore.GatewayError(
                "invalid", "bleScanStop", "scanId missing"))
            return
        }
        val stopped = radio.scanStop(scanId)
        var sinceNanos = 0L
        synchronized(armedScans) {
            val armed = armedScans.remove(scanId)
            if (stopped && armed != null) sinceNanos = System.nanoTime() - armed
        }
        val detail = JSONObject()
            .put("scanId", scanId)
            .put("stopped", stopped)
        if (sinceNanos > 0) detail.put("durationMs", sinceNanos / 1_000_000)
        core.stageAuditDetail(detail)
        done.settle(JSONObject().put("stopped", stopped), null)
    }

    /** The radio's device tap fans out to every armed scan (the proposal's
     * one channel per session object). */
    private fun deviceArrived(device: BleRadioDevice) {
        val ids = synchronized(armedScans) { armedScans.keys.toList() }
        for (scanId in ids) {
            val record = JSONObject()
                .put("event", "ble.event")
                .put("scanId", scanId)
                .put("kind", "device")
                .put("deviceId", device.deviceId)
                .put("name", device.name ?: JSONObject.NULL)
                .put("rssi", device.rssi)
                .put("serviceUuids", org.json.JSONArray(device.serviceUuids))
            emitFn?.invoke(record.toString())
        }
    }

    // ---- connect / disconnect ---------------------------------------------------

    private fun connect(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val deviceId = call.string("deviceId")
        if (deviceId == null) {
            done.settle(null, GatewayCore.GatewayError(
                "invalid", "bleConnect", "deviceId missing"))
            return
        }
        ensureGrant("bleConnect", call, done) {
            ensureRadio("bleConnect", done) {
                radio.connect(deviceId, onDisconnect = { connectionId ->
                    val record = JSONObject()
                        .put("event", "ble.event")
                        .put("kind", "disconnect")
                        .put("connectionId", connectionId)
                        .put("reason", "link-lost")
                    emitFn?.invoke(record.toString())
                }, completion = { result ->
                    when (result) {
                        is BleResult.Ok -> {
                            val connectionId = result.value
                            core.stageAuditDetail(
                                JSONObject().put("deviceId", deviceId)
                                    .put("connected", connectionId != null))
                            val payload = if (connectionId != null) {
                                JSONObject().put("connectionId", connectionId)
                            } else {
                                null
                            }
                            done.settle(payload, null)
                        }
                        is BleResult.Err -> doneRadioFailure("bleConnect", result.failure, done)
                    }
                })
            }
        }
    }

    private fun disconnect(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val connectionId = call.string("connectionId")
        if (connectionId == null) {
            done.settle(null, GatewayCore.GatewayError(
                "invalid", "bleDisconnect", "connectionId missing"))
            return
        }
        val closed = radio.disconnect(connectionId)
        core.stageAuditDetail(
            JSONObject().put("connectionId", connectionId).put("closed", closed))
        done.settle(JSONObject().put("closed", closed), null)
    }

    // ---- GATT ---------------------------------------------------------------------

    private fun read(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        tupleCall("bleRead", call, done) { connectionId, service, characteristic ->
            radio.read(connectionId, service, characteristic) { result ->
                when (result) {
                    is BleResult.Ok -> {
                        val bytes = result.value
                        core.stageAuditDetail(gattDetail(
                            "read", connectionId, service, characteristic, bytes.size))
                        done.settle(
                            JSONObject().put(
                                "bytesB64",
                                android.util.Base64.encodeToString(
                                    bytes, android.util.Base64.NO_WRAP)),
                            null)
                    }
                    is BleResult.Err -> doneRadioFailure("bleRead", result.failure, done)
                }
            }
        }
    }

    private fun write(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val b64 = call.args.optString("bytesB64", "")
        val bytes = if (b64.isEmpty()) {
            null
        } else {
            try {
                android.util.Base64.decode(b64, android.util.Base64.NO_WRAP)
            } catch (e: IllegalArgumentException) {
                null
            }
        }
        if (bytes == null) {
            done.settle(null, GatewayCore.GatewayError(
                "invalid", "bleWrite", "bytesB64 missing or malformed"))
            return
        }
        val withResponse = call.args.optBoolean("response", true)
        tupleCall("bleWrite", call, done) { connectionId, service, characteristic ->
            radio.write(connectionId, service, characteristic, bytes, withResponse) { result ->
                when (result) {
                    is BleResult.Ok -> {
                        core.stageAuditDetail(gattDetail(
                            "write", connectionId, service, characteristic, bytes.size))
                        done.settle(JSONObject().put("written", true), null)
                    }
                    is BleResult.Err -> doneRadioFailure("bleWrite", result.failure, done)
                }
            }
        }
    }

    private fun subscribe(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        tupleCall("bleSubscribe", call, done) { connectionId, service, characteristic ->
            radio.subscribe(connectionId, service, characteristic, onNotify = { data ->
                val record = JSONObject()
                    .put("event", "ble.event")
                    .put("kind", "notify")
                    .put("connectionId", connectionId)
                    .put("service", service)
                    .put("characteristic", characteristic)
                    .put("bytesB64", android.util.Base64.encodeToString(
                        data, android.util.Base64.NO_WRAP))
                emitFn?.invoke(record.toString())
            }, completion = { result ->
                when (result) {
                    is BleResult.Ok -> {
                        core.stageAuditDetail(gattDetail(
                            "subscribe", connectionId, service, characteristic, 0))
                        done.settle(JSONObject().put("subscribed", result.value), null)
                    }
                    is BleResult.Err -> doneRadioFailure("bleSubscribe", result.failure, done)
                }
            })
        }
    }

    private fun unsubscribe(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        tupleCall("bleUnsubscribe", call, done) { connectionId, service, characteristic ->
            radio.unsubscribe(connectionId, service, characteristic) { result ->
                when (result) {
                    is BleResult.Ok -> {
                        core.stageAuditDetail(gattDetail(
                            "unsubscribe", connectionId, service, characteristic, 0))
                        done.settle(JSONObject().put("subscribed", result.value), null)
                    }
                    is BleResult.Err -> doneRadioFailure("bleUnsubscribe", result.failure, done)
                }
            }
        }
    }

    /** The shared shape of the four GATT calls: validate the tuple, ride the
     * consent ladder, then run body with the parsed parts. */
    private fun tupleCall(
        primitive: String, call: GatewayCore.GatewayCall, done: GatewayCore.Done,
        body: (String, String, String) -> Unit,
    ) {
        val connectionId = call.string("connectionId")
        val service = call.string("service")
        val characteristic = call.string("characteristic")
        if (connectionId == null || service == null || characteristic == null) {
            done.settle(null, GatewayCore.GatewayError(
                "invalid", primitive,
                "connectionId, service and characteristic are required"))
            return
        }
        ensureGrant(primitive, call, done) {
            ensureRadio(primitive, done) {
                body(connectionId, service, characteristic)
            }
        }
    }

    private fun doneRadioFailure(
        primitive: String, failure: BleRadioFailure, done: GatewayCore.Done,
    ) {
        when (failure) {
            is BleRadioFailure.OsDenied -> {
                core.stageAuditDetail(
                    JSONObject().put("layer", "os").put("family", "ble"))
                done.settle(null, GatewayCore.GatewayError(
                    "denied", primitive, failure.reason))
            }
            is BleRadioFailure.Unsupported -> {
                done.settle(null, GatewayCore.GatewayError(
                    "unavailable", primitive, failure.reason))
            }
        }
    }
}
