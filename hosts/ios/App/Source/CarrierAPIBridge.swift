import Foundation
import Network

/// The `/api` prefix route and the `/api/remote.mux` upgrade — the RPC
/// transport of docs/webserver-contract.md §2.3/§2.4 with the Phase-B
/// bridging of §3.5. The carrier parses the frozen `client-request`
/// envelope, forwards CLAIMED endpoints onto the runtime over the bus seam,
/// and answers every UNCLAIMED endpoint with a structured unavailable
/// envelope — fail loud, logged (never a silent hang). The mux is the single
/// multiplexed push socket: `open`/`cancel` frames arrive from the page,
/// `item`/`error`/`end` frames leave toward it, all bridged over the same
/// seam. Handlers run on the server queue; runtime-facing calls are safe
/// from any queue (they hop to the bridge's serial queue).
final class CarrierAPIBridge {
    static let muxPath = "/api/remote.mux"
    /// Code answered for endpoints no runtime has claimed (Phase-B v0: all).
    static let unavailableCode = "gateway/unimplemented"
    /// Upstream RPC namespaces enumerated from source (§2.3). v0 answers
    /// every one of them `gateway/unimplemented` until claimed.
    static let upstreamNamespaces = [
        "session", "settings", "credentials", "workspace", "terminal",
        "goals", "skills", "fileReferences", "directoryPicker", "archive",
        "typert",
    ]

    /// Evidence hooks — the owning drive logs them; the bridge never logs.
    var onAPICall: ((String, String) -> Void)?
    var onUpgradeAccepted: ((String) -> Void)?
    var onMuxOpen: ((String, String) -> Void)?
    var onMuxFrame: ((String, String) -> Void)?
    /// One tx ERROR frame with the stream endpoint that produced it (the
    /// honest services-gap leg for the official-app evidence).
    var onMuxErrorFrame: ((String) -> Void)?

    /// Seam out: carrier → runtime deliveries (the runtime hops queues).
    var deliverToRuntime: (([String: Any]) -> Void)?

    /// Auth-lite session token (§3.4 parity for /api + mux).
    let sessionToken: String
    /// The carrier server (weak: the server's handler closures own us).
    private weak var server: CarrierServer?
    /// Serial queue owning the bridge state; handlers hop onto it.
    private let queue = DispatchQueue(label: "org.dsh.carrier.api")
    /// Endpoints the runtime claimed over the bus seam (v0: none).
    private var claimedEndpoints: Set<String> = []
    /// Whether the runtime claimed the mux streams (v0: false).
    private var muxClaimed = false
    /// Responses awaiting the runtime, by rpcId (bridge queue only).
    private var pendingRPC: [String: NWConnection] = [:]

    init(sessionToken: String) {
        self.sessionToken = sessionToken
    }

    /// Binds to the server: registers the `/api` prefix route and the
    /// `/api/remote.mux` exact upgrade (§2.3, §2.4).
    func install(on server: CarrierServer) throws {
        self.server = server
        try server.register(kind: .prefix, path: "/api") { [weak self] request, conn in
            self?.handleAPI(request, conn: conn)
        }
        try server.registerUpgrade(path: Self.muxPath) { [weak self] request, _ in
            self?.upgradePlan(request) ?? .destroy
        }
    }

    // ---- POST /api/<endpoint> (§2.3) -------------------------------------------

    private func handleAPI(_ request: CarrierRequest, conn: NWConnection) {
        guard let path = request.path else {
            return answer(conn, status: 400, body: Data("bad request".utf8), mime: "text/plain")
        }
        guard request.method == "POST" else {
            return answer(conn, status: 405, body: Data(), mime: "text/plain")
        }
        guard request.isAuthed(token: sessionToken) else {
            return answer(conn, status: 401, body: Data(), mime: "text/plain")
        }
        let endpoint = String(path.dropFirst("/api/".count))
        guard Self.validEndpoint(endpoint), let envelope = Self.parseEnvelope(request.body, endpoint: endpoint) else {
            onAPICall?(endpoint, "malformed")
            return answer(conn, status: 400, body: Data("malformed envelope".utf8), mime: "text/plain")
        }
        queue.async { [weak self] in
            guard let self else { return }
            if self.claimedEndpoints.contains(endpoint) {
                self.pendingRPC[envelope.rpcId] = conn
                self.deliverToRuntime?([
                    "type": "api.request", "rpcId": envelope.rpcId,
                    "endpoint": endpoint, "payload": envelope.payload,
                ])
                self.onAPICall?(endpoint, "forwarded")
                return
            }
            self.onAPICall?(endpoint, "unavailable")
            self.answerUnavailable(envelope.rpcId, endpoint, conn)
        }
    }

    /// Answers one unclaimed endpoint with the structured unavailable
    /// envelope (200: the envelope is the response, the error rides inside).
    private func answerUnavailable(_ rpcId: String, _ endpoint: String, _ conn: NWConnection) {
        let body = Self.envelope(rpcId: rpcId, endpoint: endpoint)
        answer(conn, status: 200, body: Data(body.utf8), mime: "application/json")
    }

    /// Runtime → carrier: settle one claimed RPC with the frozen result
    /// envelope (`result` = the already-shaped ok/error JSON object).
    func respondAPI(rpcId: String, result: [String: Any]) {
        queue.async { [weak self] in
            guard let self, let conn = self.pendingRPC.removeValue(forKey: rpcId) else { return }
            let envelope: [String: Any] = ["type": "server-response", "rpcId": rpcId, "result": result]
            guard let data = try? JSONSerialization.data(withJSONObject: envelope) else { return }
            self.answer(conn, status: 200, body: data, mime: "application/json")
        }
    }

    /// Bus-seam claim: the runtime answers these endpoints from now on.
    func claim(endpoints: [String]) {
        queue.async { [weak self] in
            self?.claimedEndpoints.formUnion(endpoints)
        }
    }

    // ---- WS /api/remote.mux (§2.4) ------------------------------------------------

    private func upgradePlan(_ request: CarrierRequest) -> CarrierUpgradePlan {
        guard request.isAuthed(token: sessionToken) else { return .destroy }
        onUpgradeAccepted?(Self.muxPath)
        return .accept
    }

    /// Wired to `server.onWSFrame` by the drive: mux seats only; unknown or
    /// malformed frames fail the seat loudly (socket-level, per §1.6).
    func ingestFrame(_ text: String, path: String) {
        guard path == Self.muxPath,
              let frame = (try? JSONSerialization.jsonObject(with: Data(text.utf8)))
                  as? [String: Any],
              let type = frame["type"] as? String else { return }
        switch type {
        case "open":
            let streamId = frame["streamId"] as? String ?? ""
            let endpoint = frame["endpoint"] as? String ?? ""
            guard !streamId.isEmpty, !endpoint.isEmpty else { return }
            onMuxOpen?(streamId, endpoint)
            onMuxFrame?("rx", "open")
            let payload = frame["payload"] as? [String: Any] ?? [:]
            queue.async { [weak self] in
                self?.routeMuxOpen(streamId, endpoint, payload)
            }
        case "cancel":
            onMuxFrame?("rx", "cancel")
            queue.async { [weak self] in
                guard let self, self.muxClaimed else { return }
                let streamId = frame["streamId"] as? String ?? ""
                self.deliverToRuntime?(["type": "mux.cancel", "streamId": streamId])
            }
        default:
            break // unknown client frame types are ignored (upstream parse would reject)
        }
    }

    /// Dispatches one accepted mux open: forward to a claiming runtime, or
    /// answer the structured unavailable error frame (v0 default).
    private func routeMuxOpen(_ streamId: String, _ endpoint: String, _ payload: [String: Any]) {
        guard muxClaimed else {
            answerUnimplementedStream(streamId, endpoint)
            return
        }
        deliverToRuntime?([
            "type": "mux.open", "streamId": streamId,
            "endpoint": endpoint, "payload": payload,
        ])
    }

    /// The structured unavailable error frame for one unclaimed stream.
    private func answerUnimplementedStream(_ streamId: String, _ endpoint: String) {
        let message = "stream endpoint \(endpoint) is not implemented "
            + "by the Phase-B carrier"
        // Record the leg BEFORE the frame hook fires (the evidence observer
        // reads it synchronously inside the frame callback).
        onMuxErrorFrame?(endpoint)
        muxError(streamId: streamId, code: Self.unavailableCode,
                 message: message, details: ["endpoint": endpoint])
    }

    /// Bus seam: the runtime owns mux streams from now on.
    func claimMux() {
        queue.async { [weak self] in self?.muxClaimed = true }
    }

    /// Runtime → page: one stream item (value is an already-decoded JSON
    /// object; the frame stays lossless through JSONSerialization).
    func muxItem(streamId: String, value: Any) {
        sendMux(["type": "item", "streamId": streamId, "value": value])
        onMuxFrame?("tx", "item")
    }

    /// Runtime → page: one terminal stream error (§2.4 carrier-safe failure).
    func muxError(streamId: String, code: String, message: String, details: [String: Any]) {
        let error: [String: Any] = ["code": code, "message": message, "details": details]
        sendMux(["type": "error", "streamId": streamId, "error": error])
        onMuxFrame?("tx", "error")
    }

    /// Runtime → page: stream completion.
    func muxEnd(streamId: String) {
        sendMux(["type": "end", "streamId": streamId])
        onMuxFrame?("tx", "end")
    }

    private func sendMux(_ frame: [String: Any]) {
        queue.async { [weak self] in
            guard let self, let server = self.server,
                  let data = try? JSONSerialization.data(withJSONObject: frame),
                  let text = String(data: data, encoding: .utf8) else { return }
            server.send(text, to: Self.muxPath)
        }
    }

    // ---- envelope helpers ------------------------------------------------------------

    private func answer(_ conn: NWConnection, status: Int, body: Data, mime: String) {
        var head = "HTTP/1.1 \(status) \(Self.reason(status))\r\n"
        head += "Content-Type: \(mime)\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        var out = Data(head.utf8)
        out.append(body)
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }

    private static func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 405: return "Method Not Allowed"
        default: return "Error"
        }
    }

    /// The structured unavailable envelope for one unclaimed endpoint.
    static func envelope(rpcId: String, endpoint: String) -> String {
        let result: [String: Any] = ["ok": false, "error": [
            "code": unavailableCode,
            "message": "endpoint " + endpoint + " is not implemented by the Phase-B carrier",
            "details": ["endpoint": endpoint, "namespaces": upstreamNamespaces],
        ]]
        let envelope: [String: Any] = ["type": "server-response", "rpcId": rpcId, "result": result]
        guard let data = try? JSONSerialization.data(withJSONObject: envelope),
              let text = String(data: data, encoding: .utf8) else { return "{}" }
        return text
    }

    /// Endpoint segment pattern (upstream `ENDPOINT_SEGMENT_PATTERN`, applied
    /// per '/' segment: the official client calls namespaced endpoints like
    /// `settings/describe`; empty, ".", and ".." segments are invalid).
    static func validEndpoint(_ endpoint: String) -> Bool {
        for segment in endpoint.split(separator: "/", omittingEmptySubsequences: false) {
            let piece = String(segment)
            if piece.isEmpty || piece == "." || piece == ".." { return false }
            if piece.range(of: "^[A-Za-z0-9_.$-]+$", options: .regularExpression) == nil {
                return false
            }
        }
        return !endpoint.isEmpty
    }

    /// Validates the frozen client-request envelope (§2.3): type, non-empty
    /// rpcId, method equal to the posted endpoint, any payload.
    static func parseEnvelope(
        _ body: Data, endpoint: String
    ) -> (rpcId: String, payload: Any)? {
        guard let json = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              json["type"] as? String == "client-request",
              let rpcId = json["rpcId"] as? String, !rpcId.isEmpty,
              let method = json["method"] as? String, method == endpoint,
              json.keys.contains("payload") else { return nil }
        return (rpcId, json["payload"] ?? [:])
    }
}
