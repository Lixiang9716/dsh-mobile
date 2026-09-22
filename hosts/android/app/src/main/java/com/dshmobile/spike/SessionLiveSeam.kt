package com.dshmobile.spike

import org.json.JSONArray
import org.json.JSONObject

/**
 * The claims seam of the session-live drive (android.session.live-read): the
 * bus protocol's runtime→carrier half folded into CarrierAPIBridge, plus
 * the once-guarded wire observers. The runtime CLAIMS `/api/session.list`
 * and the mux `session/journal` streams over the bus seam
 * (api.claim/mux.claim → bridge; api.request → ctx.sessions → api.respond;
 * mux.open → REAL journal attach → mux.item|error|end), so the official UI
 * gets REAL session data. Everything the spine does not implement stays
 * structured-unavailable — fail loud, never faked.
 *
 * Evidence discipline: the page generates its own traffic before (and
 * alongside) the probe's, so every hook is SINGLE-EMISSION — the manifest
 * pins the honest FIRST observations. The unavailable witnesses are held
 * and flushed SORTED at the first claimed (forwarded) call: the page fires
 * its boot-RPC burst in parallel, so the arrival ORDER races across runs
 * while the SET is stable — the sorted flush keeps the one-to-one manifest
 * order deterministic without losing a witness. Kotlin sibling of the bus
 * folding in hosts/ios SessionLiveRuntime.swift.
 */
class SessionLiveSeam(private val bridge: CarrierAPIBridge) {

    /** One canonical E2E record (event + fields), in emission order. */
    var onEvent: ((String, JSONObject) -> Unit)? = null

    private val lock = Object()
    private val rpcLogged = HashSet<String>()
    private val unavailableWitnesses = sortedSetOf<String>()
    private var upgradeLogged = false
    private var attachLogged = false
    private var frameLogged = false
    private var respondLogged = false

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
            observeRespond(result)
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
     * the same way without another evidence line). */
    fun observeRPC(endpoint: String, answered: String) {
        synchronized(lock) {
            if (!rpcLogged.add(endpoint)) return
        }
        if (answered == "unavailable") {
            synchronized(lock) { unavailableWitnesses.add(endpoint) }
            return
        }
        flushUnavailableWitnesses()
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

    /** The first mux seat accept of the journal stream (whoever opens it —
     * the UI's own attach or the probe's). */
    fun observeMuxOpen(streamId: String, endpoint: String) {
        if (endpoint != "session/journal") return
        synchronized(lock) {
            if (attachLogged) return
            attachLogged = true
        }
        emit(
            "session.attached",
            JSONObject().put("streamId", streamId).put("stream", endpoint),
        )
    }

    /** One tx item frame line for the journal leg (once; the probe reports
     * the full frame facts). */
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
                .put("source", "REAL session log records (baseline + live turn)"),
        )
    }

    /** The first REAL session.list answer through the seam (from the
     * already-shaped ok envelope the runtime posted). */
    private fun observeRespond(result: JSONObject) {
        if (result.optBoolean("ok") != true) return
        val items = result.optJSONObject("value")?.optJSONArray("items") ?: return
        synchronized(lock) {
            if (respondLogged) return
            respondLogged = true
        }
        emit(
            "session.list.responded",
            JSONObject()
                .put("ok", true)
                .put("sessions", items.length())
                .put("source", "the on-device spine (ctx.sessions)"),
        )
    }

    /** Emits the held unavailable witnesses in sorted (deterministic) order. */
    private fun flushUnavailableWitnesses() {
        val flushed = synchronized(lock) {
            val out = unavailableWitnesses.toList()
            unavailableWitnesses.clear()
            out
        }
        for (endpoint in flushed) {
            emit(
                "rpc.observed",
                JSONObject().put("endpoint", endpoint).put("answered", "unavailable"),
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
