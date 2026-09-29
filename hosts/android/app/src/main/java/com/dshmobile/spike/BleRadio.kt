package com.dshmobile.spike

import android.os.Handler
import android.os.Looper
import java.util.concurrent.ConcurrentHashMap

/**
 * The radio abstraction under the BLE primitives (the system capability
 * plane, BLE face): [SystemBleRadio] wraps android.bluetooth.le for
 * hardware, [MockBleRadio] is the deterministic in-process radio the E2E
 * legs run against — the SAME gateway enforcement and audit trail over
 * BOTH, so CI verifies the envelope without pretending an emulator has a
 * radio. The mock's device names carry the "DSH Mock BLE" prefix, and the
 * mock manifests pin those names, so evidence can never pass against a
 * radio that is not the named mock.
 *
 * All completions fire on the main looper; the primitives' settles hop onto
 * the runtime queue via SpikeRuntime.post (ARCHITECTURE.md §6).
 */
sealed class BleRadioFailure {
    /** The radio layer cannot serve the call (contract §3 `unavailable`). */
    data class Unsupported(val reason: String) : BleRadioFailure()

    /** The OS consent layer refused (contract `denied`, audit layer "os"). */
    data class OsDenied(val reason: String) : BleRadioFailure()
}

/** The two-sided completion Kotlin's one-parameter [Result] cannot carry
 * (the failure side is a radio failure, not a Throwable). */
sealed class BleResult<out T> {
    data class Ok<T>(val value: T) : BleResult<T>()
    data class Err(val failure: BleRadioFailure) : BleResult<Nothing>()

    companion object {
        fun <T> ok(value: T): BleResult<T> = Ok(value)
        fun err(failure: BleRadioFailure): BleResult<Nothing> = Err(failure)
    }
}

/** One advertisement batch record (proposal §7 `kind: "device"` shape). */
data class BleRadioDevice(
    val deviceId: String,
    val name: String?,
    val rssi: Int,
    val serviceUuids: List<String>,
)

interface BleRadio {
    /** The OS consent verdict BEFORE any call (prompt-free read). */
    fun consent(): BleRadioFailure?

    /** The queue-serial advertisement tap — wired by [BlePrimitives]. */
    var deviceSink: ((BleRadioDevice) -> Unit)?

    /** Arms a scan; resolves the scanId WHEN ARMED (the micStart posture). */
    fun scanStart(
        filter: List<String>, timeoutMs: Int,
        completion: (BleResult<String>) -> Unit,
    )
    /** Idempotent: false for an unknown or already-ended scanId. */
    fun scanStop(scanId: String): Boolean

    /** `.success(null)` = the device walked away (a value, not an error). */
    fun connect(
        deviceId: String,
        onDisconnect: (String) -> Unit,
        completion: (BleResult<String?>) -> Unit,
    )
    /** Idempotent: false for an unknown or already-closed connectionId. */
    fun disconnect(connectionId: String): Boolean

    fun read(
        connectionId: String, service: String, characteristic: String,
        completion: (BleResult<ByteArray>) -> Unit,
    )
    fun write(
        connectionId: String, service: String, characteristic: String,
        data: ByteArray, response: Boolean,
        completion: (BleResult<Boolean>) -> Unit,
    )
    /** Arms notifications; values arrive through onNotify (never polled). */
    fun subscribe(
        connectionId: String, service: String, characteristic: String,
        onNotify: (ByteArray) -> Unit,
        completion: (BleResult<Boolean>) -> Unit,
    )
    fun unsubscribe(
        connectionId: String, service: String, characteristic: String,
        completion: (BleResult<Boolean>) -> Unit,
    )
}

/** The host-side clamp every radio honors (the rejection names the range —
 * never a silent truncation, rule 5). */
fun bleScanTimeoutClamp(ms: Int): Int = ms.coerceIn(100, 30_000)

/** The deterministic mock radio (the CI-verifiable mock layer). Its closed
 * GATT db: battery-like 180f/2a19 (read answers one byte, notify capable)
 * and the unassigned vendor-test write space fe00/fe01. Two devices
 * advertise per scan, in order. No OS layer exists to ask — the consent
 * verdict is null (granted), and the audit trail simply never carries an
 * OS refusal on a mock run. */
class MockBleRadio : BleRadio {

    companion object {
        const val NAME_PREFIX = "DSH Mock BLE"
        const val TUPLE_180F = "180f"
        const val CHAR_2A19 = "2a19"
        const val TUPLE_FE00 = "fe00"
        const val CHAR_FE01 = "fe01"
        private fun noSuchTuple(service: String, characteristic: String) =
            BleRadioFailure.Unsupported(
                "tuple ($service,$characteristic) is not in the mock GATT db")
    }

    private val handler = Handler(Looper.getMainLooper())
    private val liveScans = ConcurrentHashMap<String, Runnable>()
    private val connections = java.util.Collections.synchronizedSet(HashSet<String>())
    private val notifying = java.util.Collections.synchronizedSet(HashSet<String>())
    private var nextScan = 0

    override var deviceSink: ((BleRadioDevice) -> Unit)? = null

    override fun consent(): BleRadioFailure? = null

    override fun scanStart(
        filter: List<String>, timeoutMs: Int,
        completion: (BleResult<String>) -> Unit,
    ) {
        nextScan += 1
        val scanId = "scan:mock-$nextScan"
        val end = Runnable { liveScans.remove(scanId) }
        liveScans[scanId] = end
        completion(BleResult.ok(scanId))
        deliverBatch(scanId, filter)
        handler.postDelayed(end, bleScanTimeoutClamp(timeoutMs).toLong())
    }

    /** The two-device batch, one bridge hop per advertisement (the
     * proposal's "one advertisement batch per event"), honoring the filter. */
    private fun deliverBatch(scanId: String, filter: List<String>) {
        val devices = listOf(
            BleRadioDevice(
                "device:mock-1", "$NAME_PREFIX Sensor", -42, listOf(TUPLE_180F)),
            BleRadioDevice(
                "device:mock-2", "$NAME_PREFIX Beacon", -66, emptyList()),
        )
        devices.forEachIndexed { index, device ->
            if (filter.isNotEmpty() && device.serviceUuids.none(filter::contains)) return
            handler.postDelayed({
                if (liveScans.containsKey(scanId)) deviceSink?.invoke(device)
            }, 20L * (index + 1))
        }
    }

    override fun scanStop(scanId: String): Boolean {
        val end = liveScans.remove(scanId) ?: return false
        handler.removeCallbacks(end)
        return true
    }

    override fun connect(
        deviceId: String,
        onDisconnect: (String) -> Unit,
        completion: (BleResult<String?>) -> Unit,
    ) {
        if (!deviceId.startsWith("device:mock-")) {
            completion(BleResult.ok(null)) // walked away: a value, not an error
            return
        }
        val connectionId = "conn:$deviceId"
        connections.add(connectionId)
        completion(BleResult.ok(connectionId))
    }

    override fun disconnect(connectionId: String): Boolean =
        connections.remove(connectionId)

    override fun read(
        connectionId: String, service: String, characteristic: String,
        completion: (BleResult<ByteArray>) -> Unit,
    ) {
        if (!connections.contains(connectionId)) {
            completion(BleResult.err(BleRadioFailure.Unsupported("connection is not live")))
        } else if (service == TUPLE_180F && characteristic == CHAR_2A19) {
            completion(BleResult.ok(byteArrayOf(0x5a)))
        } else {
            completion(BleResult.err(noSuchTuple(service, characteristic)))
        }
    }

    override fun write(
        connectionId: String, service: String, characteristic: String,
        data: ByteArray, response: Boolean,
        completion: (BleResult<Boolean>) -> Unit,
    ) {
        if (!connections.contains(connectionId)) {
            completion(BleResult.err(BleRadioFailure.Unsupported("connection is not live")))
        } else if (service == TUPLE_FE00 && characteristic == CHAR_FE01) {
            completion(BleResult.ok(true))
        } else {
            completion(BleResult.err(noSuchTuple(service, characteristic)))
        }
    }

    override fun subscribe(
        connectionId: String, service: String, characteristic: String,
        onNotify: (ByteArray) -> Unit,
        completion: (BleResult<Boolean>) -> Unit,
    ) {
        if (!connections.contains(connectionId)) {
            completion(BleResult.err(BleRadioFailure.Unsupported("connection is not live")))
            return
        }
        if (service != TUPLE_180F || characteristic != CHAR_2A19) {
            completion(BleResult.err(noSuchTuple(service, characteristic)))
            return
        }
        val key = "$connectionId|$service|$characteristic"
        notifying.add(key)
        completion(BleResult.ok(true))
        for (seq in 1..2) {
            handler.postDelayed({
                if (notifying.contains(key)) onNotify(byteArrayOf(0x5a, seq.toByte()))
            }, 30L * seq)
        }
    }

    override fun unsubscribe(
        connectionId: String, service: String, characteristic: String,
        completion: (BleResult<Boolean>) -> Unit,
    ) {
        notifying.remove("$connectionId|$service|$characteristic")
        // the POST state (disarmed) — idempotent, never a lie about what the
        // call changed
        completion(BleResult.ok(false))
    }
}
