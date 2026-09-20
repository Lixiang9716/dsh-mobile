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
    /** Responses awaiting the runtime, by rpcId. */
    private val pendingRPC = HashMap<String, OutputStream>()
    /** The stream endpoint behind the first tx error frame (once-only). */
    private var firstMuxErrorLeg: String? = null

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
     * unavailable answer is sent here, atomically with the claim check. */
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
        synchronized(lock) {
            if (!claimedEndpoints.contains(endpoint)) {
                answerUnavailable(rpcId, endpoint, out)
                return false
            }
            pendingRPC[rpcId] = out
        }
        deliverToRuntime?.invoke(request)
        return true
    }

    /** Answers one unclaimed endpoint with the structured unavailable
     * envelope (200: the envelope is the response, the error rides inside). */
    private fun answerUnavailable(rpcId: String, endpoint: String, out: OutputStream) {
        val body = envelope(rpcId, endpoint)
        answer(out, 200, body.toByteArray(Charsets.UTF_8), "application/json")
    }

    /** Runtime → carrier: settle one claimed RPC with the frozen result
     * envelope (`result` = the already-shaped ok/error JSON object). */
    fun respondAPI(rpcId: String, result: JSONObject) {
        synchronized(lock) {
            val out = pendingRPC.remove(rpcId) ?: return
            val data = JSONObject()
                .put("type", "server-response")
                .put("rpcId", rpcId)
                .put("result", result)
            answer(out, 200, data.toString().toByteArray(Charsets.UTF_8), "application/json")
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
