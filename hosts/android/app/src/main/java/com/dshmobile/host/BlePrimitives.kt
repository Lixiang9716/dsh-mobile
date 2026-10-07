package com.dshmobile.host

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
    /** The consent collaborator (gateway prompt + OS prompt — BleConsent.kt):
     * the primitives ask it before every radio-touching call. */
    private val consent = BleConsentLayer(activity, core)
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
        if (core.manifest.grants(primitive) || consent.holdsGrant()) {
            body()
            return
        }
        // unreachable while the dispatch prompter is installed (it owns the
        // ungranted path) — belt-and-braces
        done.settle(null, GatewayCore.GatewayError(
            "denied", primitive, "the gateway consent layer refused"))
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
                if (consent.osPromptPossible()) {
                    consent.requestOsPermission(primitive, done, body)
                } else {
                    consent.denyOs(primitive, refusal.reason, done)
                }
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
                val filter = scanFilterOf(call)
                val asked = call.args.optInt("timeoutMs", 5_000)
                radio.scanStart(filter, asked) { result ->
                    onScanArmed(result, filter.size, asked, call, done)
                }
            }
        }
    }

    /** The scan request's service-uuid filter (absent = all). */
    private fun scanFilterOf(call: GatewayCore.GatewayCall): List<String> {
        val arr = call.args.optJSONArray("serviceUuids") ?: return emptyList()
        return List(arr.length()) { arr.getString(it) }
    }

    /** The scan arm's completion — named so the ladder nesting stays flat. */
    private fun onScanArmed(
        result: BleResult<String>, filters: Int, asked: Int,
        call: GatewayCore.GatewayCall, done: GatewayCore.Done,
    ) {
        when (result) {
            is BleResult.Err -> return doneRadioFailure("bleScanStart", result.failure, done)
            is BleResult.Ok -> {
                val scanId = result.value
                synchronized(armedScans) { armedScans[scanId] = System.nanoTime() }
                core.stageAuditDetail(scanStartDetail(scanId, filters, asked, call))
                done.settle(JSONObject().put("scanId", scanId), null)
            }
        }
    }

    /** The scan record's closed-vocabulary detail (the timer tag precedent). */
    private fun scanStartDetail(
        scanId: String, filters: Int, asked: Int, call: GatewayCore.GatewayCall,
    ): JSONObject {
        val detail = JSONObject()
            .put("scanId", scanId)
            .put("filters", filters)
            .put("timeoutMs", bleScanTimeoutClamp(asked))
        val tag = call.args.optString("tag", "")
        if (tag.isNotEmpty()) detail.put("tag", tag)
        return detail
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

    /** MainActivity → BindingHost route the OS prompt's verdict here. */
    fun onPermissionResult(granted: Boolean) {
        consent.onPermissionResult(granted)
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
                radio.connect(deviceId,
                    onDisconnect = { connectionId -> emitDrop(connectionId) },
                    completion = { result -> onConnected(result, deviceId, done) })
            }
        }
    }

    /** The drop event: exactly one `disconnect` record per connection. */
    private fun emitDrop(connectionId: String) {
        val record = JSONObject()
            .put("event", "ble.event")
            .put("kind", "disconnect")
            .put("connectionId", connectionId)
            .put("reason", "link-lost")
        emitFn?.invoke(record.toString())
    }

    /** The connect completion — walked away resolves null (a value, not an
     * error); the audit record carries the device token and the outcome. */
    private fun onConnected(
        result: BleResult<String?>, deviceId: String, done: GatewayCore.Done,
    ) {
        when (result) {
            is BleResult.Err -> return doneRadioFailure("bleConnect", result.failure, done)
            is BleResult.Ok -> {
                val connectionId = result.value
                val audit = JSONObject()
                audit.put("deviceId", deviceId)
                audit.put("connected", connectionId != null)
                core.stageAuditDetail(audit)
                val payload = if (connectionId != null) {
                    JSONObject().put("connectionId", connectionId)
                } else {
                    null
                }
                done.settle(payload, null)
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
                onRead(result, connectionId, service, characteristic, done)
            }
        }
    }

    /** The read completion — one byte-count detail line, base64 payload. */
    private fun onRead(
        result: BleResult<ByteArray>, connectionId: String,
        service: String, characteristic: String, done: GatewayCore.Done,
    ) {
        when (result) {
            is BleResult.Err -> return doneRadioFailure("bleRead", result.failure, done)
            is BleResult.Ok -> {
                val bytes = result.value
                core.stageAuditDetail(gattDetail(
                    "read", connectionId, service, characteristic, bytes.size))
                val payload = JSONObject()
                payload.put("bytesB64", android.util.Base64.encodeToString(
                    bytes, android.util.Base64.NO_WRAP))
                done.settle(payload, null)
            }
        }
    }

    private fun write(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val bytes = writePayloadOf(call)
        if (bytes == null) {
            done.settle(null, GatewayCore.GatewayError(
                "invalid", "bleWrite", "bytesB64 missing or malformed"))
            return
        }
        val withResponse = call.args.optBoolean("response", true)
        tupleCall("bleWrite", call, done) { connectionId, service, characteristic ->
            radio.write(connectionId, service, characteristic, bytes, withResponse) { result ->
                onWritten(result, connectionId, service, characteristic, bytes.size, done)
            }
        }
    }

    /** The write payload: base64 in, bytes out; malformed is null (invalid). */
    private fun writePayloadOf(call: GatewayCore.GatewayCall): ByteArray? {
        val b64 = call.args.optString("bytesB64", "")
        if (b64.isEmpty()) return null
        return try {
            android.util.Base64.decode(b64, android.util.Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    /** The write completion — direction "write" + byte count in the record. */
    private fun onWritten(
        result: BleResult<Boolean>, connectionId: String,
        service: String, characteristic: String, size: Int, done: GatewayCore.Done,
    ) {
        when (result) {
            is BleResult.Err -> return doneRadioFailure("bleWrite", result.failure, done)
            is BleResult.Ok -> {
                core.stageAuditDetail(gattDetail(
                    "write", connectionId, service, characteristic, size))
                done.settle(JSONObject().put("written", true), null)
            }
        }
    }

    private fun subscribe(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        tupleCall("bleSubscribe", call, done) { connectionId, service, characteristic ->
            radio.subscribe(connectionId, service, characteristic,
                onNotify = { data -> emitNotify(connectionId, service, characteristic, data) },
                completion = { result ->
                    onArmed(result, "bleSubscribe", connectionId, service, characteristic, done)
                })
        }
    }

    /** The notify event: the value rides base64 (the bridge's convention). */
    private fun emitNotify(
        connectionId: String, service: String, characteristic: String, data: ByteArray,
    ) {
        val record = JSONObject()
            .put("event", "ble.event")
            .put("kind", "notify")
            .put("connectionId", connectionId)
            .put("service", service)
            .put("characteristic", characteristic)
            .put("bytesB64", android.util.Base64.encodeToString(
                data, android.util.Base64.NO_WRAP))
        emitFn?.invoke(record.toString())
    }

    /** Subscribe/unsubscribe share the tuple-record + boolean settle. */
    private fun onArmed(
        result: BleResult<Boolean>, primitive: String, connectionId: String,
        service: String, characteristic: String, done: GatewayCore.Done,
    ) {
        when (result) {
            is BleResult.Err -> return doneRadioFailure(primitive, result.failure, done)
            is BleResult.Ok -> {
                val direction = if (primitive == "bleSubscribe") "subscribe" else "unsubscribe"
                core.stageAuditDetail(gattDetail(
                    direction, connectionId, service, characteristic, 0))
                done.settle(JSONObject().put("subscribed", result.value), null)
            }
        }
    }

    private fun unsubscribe(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        tupleCall("bleUnsubscribe", call, done) { connectionId, service, characteristic ->
            radio.unsubscribe(connectionId, service, characteristic) { result ->
                onArmed(result, "bleUnsubscribe", connectionId, service, characteristic, done)
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
