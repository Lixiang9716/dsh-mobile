package com.dshmobile.spike

import java.util.TreeMap
import org.json.JSONArray
import org.json.JSONObject

/**
 * The claims seam of the write-live drive (b-android.write.live): the bus
 * protocol's runtime→carrier half folded into CarrierAPIBridge, plus the
 * once-guarded wire observers. The runtime CLAIMS the write surface
 * (session/list + session/create + session/prompt + the settings legs, and
 * the mux session/follow + workspace/follow + session/control + $events
 * streams) over the bus seam (api.claim/mux.claim → bridge; api.request →
 * the spine ctx → api.respond; mux.open → REAL follow streams →
 * mux.item|error|end), so the official UI's composer send produces a REAL
 * upstream turn. Everything the spine does not implement stays structured-
 * unavailable — fail loud, never faked.
 *
 * Evidence discipline (the session-live seam's, tuned for the write burst):
 * EVERY first call of a distinct endpoint is HELD — forwarded and
 * unavailable alike — and flushed SORTED at the drive's finish marker: the
 * page fires its boot + view bursts in parallel across stages and even the
 * forwarded pair session.list/session/create races (observed both orders),
 * so inline order would flip run to run while the SET (and each endpoint's
 * answered value) is stable. Witnesses arriving after the flush emit
 * individually (never silently dropped). Kotlin sibling of the bus folding
 * in hosts/ios SessionWriteRuntime.swift.
 */
class SessionWriteSeam(private val bridge: CarrierAPIBridge) {

    /** One canonical E2E record (event + fields), in emission order. */
    var onEvent: ((String, JSONObject) -> Unit)? = null

    private val lock = Object()
    private val rpcWitnesses = TreeMap<String, String>()
    private var upgradeLogged = false
    private var frameLogged = false
    private var flushed = false

    private fun emit(event: String, fields: JSONObject) {
        onEvent?.invoke(event, fields)
    }

    /** Runtime thread: one bus message that is NOT `web.boot`. Returns false
     * for unknown types (the caller fails its drive loudly). */
    fun onBusMessage(msg: JSONObject): Boolean = when (msg.optString("type")) {
        "api.claim" -> {
            bridge.claim(toStringList(msg.optJSONArray("endpoints")))
            true
        }
        "mux.claim" -> {
            bridge.claimMux()
            true
        }
        "api.respond" -> {
            val result = msg.optJSONObject("result") ?: return true
            bridge.respondAPI(msg.optString("rpcId"), result)
            true
        }
        "mux.item", "mux.error", "mux.end" -> {
            deliverMuxFrame(msg)
            true
        }
        else -> false
    }

    /** rpc.observed: the FIRST call of each distinct endpoint (the UI and
     * the probe both call the claimed surface; every later call is served
     * the same way without another evidence line). Held for the sorted
     * finish flush — except after the flush, where it emits at arrival
     * (honest, visible — never silently dropped). */
    fun observeRPC(endpoint: String, answered: String) {
        var postFlush = false
        synchronized(lock) {
            if (rpcWitnesses.containsKey(endpoint)) return
            if (flushed) postFlush = true else rpcWitnesses[endpoint] = answered
        }
        if (!postFlush) return
        emit(
            "rpc.observed",
            JSONObject().put("endpoint", endpoint).put("answered", answered),
        )
    }

    /** The first mux upgrade accept. */
    fun observeUpgrade(path: String) {
        synchronized(lock) {
            if (upgradeLogged) return
            upgradeLogged = true
        }
        emit("upgrade.accepted", JSONObject().put("path", path))
    }

    /** One tx item frame line for the follow-stream leg (once; the probe
     * reports the full frame facts). */
    fun observeMuxFrame(direction: String, kind: String) {
        if (direction != "tx" || kind != "item") return
        synchronized(lock) {
            if (frameLogged) return
            frameLogged = true
        }
        emit(
            "journal.frame.forwarded",
            JSONObject()
                .put("direction", "tx")
                .put("first", true)
                .put("source", "REAL session log records + assistant-stream frames"),
        )
    }

    /** Emits every held RPC witness (forwarded + unavailable) in sorted
     * (deterministic) endpoint order at the drive's finish marker;
     * post-flush stragglers emit individually (honest, visible — never
     * dropped). */
    fun flushRpcWitnesses() {
        val flushedNow = synchronized(lock) {
            val out = LinkedHashMap(rpcWitnesses)
            rpcWitnesses.clear()
            flushed = true
            out
        }
        for ((endpoint, answered) in flushedNow) {
            emit(
                "rpc.observed",
                JSONObject().put("endpoint", endpoint).put("answered", answered),
            )
        }
    }

    /** One mux frame from the runtime → the bridge toward the page. */
    private fun deliverMuxFrame(msg: JSONObject) {
        val streamId = msg.optString("streamId")
        if (streamId.isEmpty()) return
        when (msg.optString("type")) {
            "mux.item" -> {
                val value = msg.opt("value") ?: return
                bridge.muxItem(streamId, value)
            }
            "mux.error" -> bridge.muxError(
                streamId,
                msg.optString("code", "gateway/unavailable"),
                msg.optString("message"),
                msg.optJSONObject("details") ?: JSONObject(),
            )
            else -> bridge.muxEnd(streamId)
        }
    }

    private fun toStringList(array: JSONArray?): List<String> {
        if (array == null) return emptyList()
        return (0 until array.length()).mapNotNull {
            runCatching { array.getString(it) }.getOrNull()
        }
    }
}
