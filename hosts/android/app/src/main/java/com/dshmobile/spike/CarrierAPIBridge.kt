package com.dshmobile.spike

import java.io.OutputStream
import org.json.JSONArray
import org.json.JSONObject

/**
 * The `/api` prefix route and the `/api/remote.mux` upgrade — the RPC
 * transport of docs/webserver-contract.md §2.3/§2.4 with the Phase-B
 * bridging of §3.5. The carrier parses the frozen `client-request`
 * envelope, forwards CLAIMED endpoints onto the runtime over the bus seam,
 * and answers every UNCLAIMED endpoint with a structured unavailable
 * envelope — fail loud, logged (never a silent hang). The mux is the single
 * multiplexed push socket: `open`/`cancel` frames arrive from the page,
 * `item`/`error`/`end` frames leave toward it, all bridged over the same
 * seam. Kotlin sibling of hosts/ios CarrierAPIBridge.swift; handler state
 * is guarded by [lock] (the server's per-connection threads are the callers).
 */
class CarrierAPIBridge(private val sessionToken: String) {

    /** Evidence hooks — the owning drive logs them; the bridge never logs. */
    var onAPICall: ((String, String) -> Unit)? = null
    var onUpgradeAccepted: ((String) -> Unit)? = null
    var onMuxOpen: ((String, String) -> Unit)? = null
    var onMuxFrame: ((String, String) -> Unit)? = null
    /** One tx ERROR frame with the stream endpoint that produced it (the
     * honest services-gap leg for the official-app evidence). */
    var onMuxErrorFrame: ((String) -> Unit)? = null

    /** Seam out: carrier → runtime deliveries (the runtime hops queues). */
    var deliverToRuntime: ((JSONObject) -> Unit)? = null

    private val lock = Object()
    /** Endpoints the runtime claimed over the bus seam (v0: none). */
    private val claimedEndpoints = HashSet<String>()
    /** Whether the runtime claimed the mux streams (v0: false). */
    private var muxClaimed = false
    /** Forwarded RPCs awaiting the runtime's answer, by rpcId. */
    private val pendingRPC = HashMap<String, RpcWaiter>()
    /** The stream endpoint behind the first tx error frame (once-only). */
    private var firstMuxErrorLeg: String? = null

    /** One parked api.request: the connection thread awaits the runtime's
     * answer with a deadline; the runtime thread supplies it (never blocks,
     * never touches sockets). Wait/notify over a single result slot. */
    private class RpcWaiter {
        private var result: JSONObject? = null

        /** The runtime's answer, or null when [timeoutMs] passed (rule 8:
         * poll the arrival condition with a deadline — never a blind wait). */
        fun await(timeoutMs: Long): JSONObject? {
            val deadline = System.currentTimeMillis() + timeoutMs
            synchronized(this) {
                while (result == null) {
                    val remaining = deadline - System.currentTimeMillis()
                    if (remaining <= 0) return null
                    @Suppress("PLATFORM_CLASS_MAPPED_TO_KOTLIN")
                    (this as Object).wait(remaining)
                }
                return result
            }
        }

        /** Runtime thread: hand the answer to the parked connection. */
        fun supply(value: JSONObject) {
            synchronized(this) {
                result = value
                (this as Object).notifyAll()
            }
        }
    }

    /** Binds to the server: registers the `/api` prefix route and the
     * `/api/remote.mux` exact upgrade (§2.3, §2.4). */
    fun install(on: CarrierServer) {
        serverRef = on
        on.register(CarrierRouteKind.PREFIX, "/api") { request, out -> handleAPI(request, out) }
        on.registerUpgrade(MUX_PATH) { request -> upgradePlan(request) }
    }

    // ---- POST /api/<endpoint> (§2.3) -------------------------------------------

    private fun handleAPI(request: CarrierRequest, out: OutputStream) {
        val path = request.path
        if (path == null) {
            return answer(out, 400, "bad request".toByteArray(), "text/plain")
        }
        if (request.method != "POST") return answer(out, 405, ByteArray(0), "text/plain")
        if (!request.isAuthed(sessionToken)) return answer(out, 401, ByteArray(0), "text/plain")
        val endpoint = path.removePrefix("/api/")
        if (!validEndpoint(endpoint)) {
            onAPICall?.invoke(endpoint, "malformed")
            return answer(out, 400, "malformed envelope".toByteArray(), "text/plain")
        }
        val envelope = parseEnvelope(request.body, endpoint)
        if (envelope == null) {
            onAPICall?.invoke(endpoint, "malformed")
            return answer(out, 400, "malformed envelope".toByteArray(), "text/plain")
        }
        val (rpcId, payload) = envelope
        if (tryForward(rpcId, endpoint, payload, out)) {
            onAPICall?.invoke(endpoint, "forwarded")
        } else {
            onAPICall?.invoke(endpoint, "unavailable")
        }
    }

    /** Registers one claimed RPC for the runtime and delivers it over the
     * seam; false when the endpoint is unclaimed — the structured
     * unavailable answer is sent here, atomically with the claim check.
     * The claim answer is ASYNCHRONOUS (the runtime hops queues), so the
     * connection thread parks here until the runtime's response arrives
     * (bounded — rule 8): the carrier's connection-per-request lifecycle
     * would otherwise close the socket before the response exists. On
     * deadline exhaustion the structured unavailable envelope answers
     * instead — loud, never a hang. */
    private fun tryForward(
        rpcId: String,
        endpoint: String,
        payload: Any,
        out: OutputStream,
    ): Boolean {
        val request = JSONObject()
            .put("type", "api.request")
            .put("rpcId", rpcId)
            .put("endpoint", endpoint)
            .put("payload", payload)
        val waiter = RpcWaiter()
        synchronized(lock) {
            if (!claimedEndpoints.contains(endpoint)) {
                answerUnavailable(rpcId, endpoint, out)
                return false
            }
            pendingRPC[rpcId] = waiter
        }
        deliverToRuntime?.invoke(request)
        val result = waiter.await(RESPOND_TIMEOUT_MS)
        if (result != null) {
            answerEnvelope(rpcId, result, out)
        } else {
            synchronized(lock) { pendingRPC.remove(rpcId) }
            answerUnavailable(rpcId, endpoint, out)
        }
        return true
    }

    /** Answers one unclaimed (or unanswered) endpoint with the structured
     * unavailable envelope (200: the envelope is the response, the error
     * rides inside). */
    private fun answerUnavailable(rpcId: String, endpoint: String, out: OutputStream) {
        val body = envelope(rpcId, endpoint)
        answer(out, 200, body.toByteArray(Charsets.UTF_8), "application/json")
    }

    /** The frozen result envelope for one runtime answer (conn thread). */
    private fun answerEnvelope(rpcId: String, result: JSONObject, out: OutputStream) {
        val data = JSONObject()
            .put("type", "server-response")
            .put("rpcId", rpcId)
            .put("result", result)
        answer(out, 200, data.toString().toByteArray(Charsets.UTF_8), "application/json")
    }

    /** Runtime → carrier: settle one claimed RPC. HANDOFF ONLY — the socket
     * write belongs to the parked connection thread (this runs on the
     * runtime thread; a write here would race the connection lifecycle and
     * could never throw into it). Unknown rpcIds (abandoned waiters) drop. */
    fun respondAPI(rpcId: String, result: JSONObject) {
        synchronized(lock) {
            val waiter = pendingRPC.remove(rpcId) ?: return
            waiter.supply(result)
        }
    }

    /** Bus-seam claim: the runtime answers these endpoints from now on. */
    fun claim(endpoints: List<String>) {
        synchronized(lock) { claimedEndpoints.addAll(endpoints) }
    }

    // ---- WS /api/remote.mux (§2.4) ------------------------------------------------

    private fun upgradePlan(request: CarrierRequest): CarrierUpgradePlan {
        if (!request.isAuthed(sessionToken)) return CarrierUpgradePlan.Destroy
        onUpgradeAccepted?.invoke(MUX_PATH)
        return CarrierUpgradePlan.Accept
    }

    /** Wired to `server.onWSFrame` by the drive: mux seats only; unknown or
     * malformed frames fail the seat loudly (socket-level, per §1.6). */
    fun ingestFrame(text: String, path: String) {
        if (path != MUX_PATH) return
        val frame = try {
            JSONObject(text)
        } catch (_: Exception) {
            return
        }
        when (frame.optString("type")) {
            "open" -> {
                val streamId = frame.optString("streamId")
                val endpoint = frame.optString("endpoint")
                if (streamId.isEmpty() || endpoint.isEmpty()) return
                onMuxOpen?.invoke(streamId, endpoint)
                onMuxFrame?.invoke("rx", "open")
                val payload = frame.optJSONObject("payload") ?: JSONObject()
                routeMuxOpen(streamId, endpoint, payload)
            }
            "cancel" -> {
                onMuxFrame?.invoke("rx", "cancel")
                forwardCancel(frame.optString("streamId"))
            }
            else -> {} // unknown client frame types are ignored (upstream parse would reject)
        }
    }

    /** Dispatches one accepted mux open: forward to a claiming runtime, or
     * answer the structured unavailable error frame (v0 default). */
    private fun routeMuxOpen(streamId: String, endpoint: String, payload: JSONObject) {
        val claimed = synchronized(lock) { muxClaimed }
        if (!claimed) return answerUnimplementedStream(streamId, endpoint)
        deliverToRuntime?.invoke(
            JSONObject()
                .put("type", "mux.open")
                .put("streamId", streamId)
                .put("endpoint", endpoint)
                .put("payload", payload),
        )
    }

    /** The structured unavailable error frame for one unclaimed stream. */
    private fun answerUnimplementedStream(streamId: String, endpoint: String) {
        val message = "stream endpoint $endpoint is not implemented " +
            "by the Phase-B carrier"
        // Record the leg BEFORE the frame hook fires (the evidence observer
        // reads it synchronously inside the frame callback).
        synchronized(lock) { if (firstMuxErrorLeg == null) firstMuxErrorLeg = endpoint }
        onMuxErrorFrame?.invoke(endpoint)
        muxError(streamId, UNAVAILABLE_CODE, message, JSONObject().put("endpoint", endpoint))
    }

    /** Bus seam: the runtime owns mux streams from now on. */
    fun claimMux() {
        synchronized(lock) { muxClaimed = true }
    }

    /** One page `cancel` frame: forward only while the runtime owns the
     * streams (pre-claim cancels are no-ops — the open was answered
     * unavailable and the seat already terminated the stream). */
    private fun forwardCancel(streamId: String) {
        val claimed = synchronized(lock) { muxClaimed }
        if (!claimed) return
        deliverToRuntime?.invoke(
            JSONObject()
                .put("type", "mux.cancel")
                .put("streamId", streamId),
        )
    }

    /** Runtime → page: one stream item (value is an already-decoded JSON
     * value; the frame stays lossless through org.json). */
    fun muxItem(streamId: String, value: Any) {
        sendMux(JSONObject().put("type", "item").put("streamId", streamId).put("value", value))
        onMuxFrame?.invoke("tx", "item")
    }

    /** Runtime → page: one terminal stream error (§2.4 carrier-safe failure). */
    fun muxError(streamId: String, code: String, message: String, details: JSONObject) {
        val error = JSONObject().put("code", code).put("message", message).put("details", details)
        sendMux(JSONObject().put("type", "error").put("streamId", streamId).put("error", error))
        onMuxFrame?.invoke("tx", "error")
    }

    /** Runtime → page: stream completion. */
    fun muxEnd(streamId: String) {
        sendMux(JSONObject().put("type", "end").put("streamId", streamId))
        onMuxFrame?.invoke("tx", "end")
    }

    private fun sendMux(frame: JSONObject) {
        val server = serverRef ?: return
        server.send(frame.toString(), MUX_PATH)
    }

    /** The owning server, set at install (send targets the mux seat). */
    private var serverRef: CarrierServer? = null

    // ---- envelope helpers ------------------------------------------------------------

    private fun answer(out: OutputStream, status: Int, body: ByteArray, mime: String) {
        CarrierHTTP.respond(out, status, mime, body)
    }

    companion object {
        const val MUX_PATH = "/api/remote.mux"

        /** How long a forwarded RPC's connection may wait for the runtime's
         * answer. The runtime answers claimed endpoints in milliseconds; the
         * bound only bites when the runtime half is gone — the structured
         * unavailable envelope answers then (fail loud, never a hang). */
        const val RESPOND_TIMEOUT_MS = 30_000L

        /** Code answered for endpoints no runtime has claimed (Phase-B v0: all). */
        const val UNAVAILABLE_CODE = "gateway/unimplemented"

        /** Upstream RPC namespaces enumerated from source (§2.3). v0 answers
         * every one of them `gateway/unimplemented` until claimed. */
        val upstreamNamespaces = listOf(
            "session", "settings", "credentials", "workspace", "terminal",
            "goals", "skills", "fileReferences", "directoryPicker", "archive",
            "typert",
        )

        /** The structured unavailable envelope for one unclaimed endpoint. */
        fun envelope(rpcId: String, endpoint: String): String {
            val error = JSONObject()
                .put("code", UNAVAILABLE_CODE)
                .put("message", "endpoint $endpoint is not implemented by the Phase-B carrier")
                .put("details", JSONObject().put("endpoint", endpoint).put(
                    "namespaces", JSONArray(upstreamNamespaces),
                ))
            val result = JSONObject().put("ok", false).put("error", error)
            return JSONObject()
                .put("type", "server-response")
                .put("rpcId", rpcId)
                .put("result", result)
                .toString()
        }

        /** Endpoint segment pattern (upstream `ENDPOINT_SEGMENT_PATTERN`,
         * applied per '/' segment: the official client calls namespaced
         * endpoints like `settings/describe`; empty, ".", and ".." segments
         * are invalid). */
        fun validEndpoint(endpoint: String): Boolean {
            if (endpoint.isEmpty()) return false
            for (segment in endpoint.split("/")) {
                if (segment.isEmpty() || segment == "." || segment == "..") return false
                if (!segment.matches(Regex("^[A-Za-z0-9_.$-]+$"))) return false
            }
            return true
        }

        /** Validates the frozen client-request envelope (§2.3): type, non-empty
         * rpcId, method equal to the posted endpoint, any payload. */
        fun parseEnvelope(body: ByteArray, endpoint: String): Pair<String, Any>? {
            val json = try {
                JSONObject(String(body, Charsets.UTF_8))
            } catch (_: Exception) {
                return null
            }
            if (json.optString("type") != "client-request") return null
            val rpcId = json.optString("rpcId")
            if (rpcId.isEmpty() || json.optString("method") != endpoint) return null
            if (!json.has("payload")) return null
            return rpcId to json.get("payload")
        }
    }
}
