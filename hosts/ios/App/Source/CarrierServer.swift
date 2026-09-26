import CryptoKit
import Foundation
import Network

/// One loopback HTTP + WebSocket endpoint implementing the `ctx.webServer`
/// contract subset (docs/webserver-contract.md §1, §3): a route table with
/// exact + prefix named routes, one fallback seat, exact-path-only upgrade
/// dispatch with multiple concurrent WS seats, request-body reading, and the
/// legacy M1–M3 static/`/ws` wiring preserved on top. Transport only: the
/// wire is reduced to callbacks and `send`; this class never touches JS or
/// the runtime. All state is owned by its internal serial queue; `send` and
/// the registration APIs are safe from any queue (spec §1.6: a malformed
/// request can never kill the process).
final class CarrierServer {
    static let wsPath = "/ws"
    static let cookieName = "dsh.session"
    /// Body cap for page RPC (§3.5); upstream allows 300 MiB for uploads,
    /// which Phase B does not serve.
    static let maxBodyBytes = 256 * 1024

    /// Legacy M1/M2 seam: text frames from the `/ws` page, in arrival order.
    var onWSMessage: ((String) -> Void)?
    /// Path-aware seam: (text, seat path) for every WS text frame.
    var onWSFrame: ((String, String) -> Void)?
    /// Fired on the server queue whenever a static file is served with 200 —
    /// the carrier-side "the Web Client mounted" signal (legacy drives only).
    var onStaticServed: ((String) -> Void)?
    /// Fired on the server queue when a runtime-registered route is served —
    /// the carrier-side evidence that the bytes actually left over TCP.
    var onRouteServed: ((String, Int) -> Void)?
    private(set) var port: UInt16 = 0

    private let queue = DispatchQueue(label: "org.dsh.carrier.server")
    private var listener: NWListener?
    /// Named routes: exact table, prefix table, upgrade table, fallback slot
    /// (§1.2–§1.4). Duplicate `(kind, path)` / upgrade path is a fatal config
    /// error — registration throws, the drive fails loud (§3.2).
    private var exactRoutes: [String: CarrierHTTPHandler] = [:]
    private var prefixRoutes: [String: CarrierHTTPHandler] = [:]
    private var upgradeRoutes: [String: CarrierUpgradeHandler] = [:]
    private var fallbackHandler: CarrierHTTPHandler?
    /// Per-connection reassembly buffers for HTTP requests (heads + bodies).
    private var httpRx: [ObjectIdentifier: Data] = [:]
    /// The CREATE script's one-shot latch (see CarrierRoutes serveCreateScript):
    /// a follow-up model call in the same turn gets the plain success body, or
    /// the scripted tool calls would loop forever.
    var serveCreateScriptDone = false
    /// Open WebSocket seats keyed by connection; multiple seats compose (§3.3).
    private var wsSeats: [ObjectIdentifier: WSSeat] = [:]
    private var servedPaths: [String] = []

    private struct WSSeat {
        let conn: NWConnection
        let path: String
        var rx: Data
        var open: Bool
    }

    // ---- registration ------------------------------------------------------

    /// Registers one named HTTP route (§1.2). Throws on a duplicate
    /// `(kind, path)` — route patterns are a composition-level contract.
    func register(kind: CarrierRouteKind, path: String, handler: @escaping CarrierHTTPHandler) throws {
        try queue.sync {
            switch kind {
            case .exact:
                guard exactRoutes[path] == nil else { throw CarrierServerError.duplicateRoute(kind, path) }
                exactRoutes[path] = handler
            case .prefix:
                guard prefixRoutes[path] == nil else { throw CarrierServerError.duplicateRoute(kind, path) }
                prefixRoutes[path] = handler
            }
        }
    }

    /// Registers the fallback seat (§1.4). One owner only: a second
    /// registration throws — two fallbacks cannot compose.
    func registerFallback(handler: @escaping CarrierHTTPHandler) throws {
        try queue.sync {
            guard fallbackHandler == nil else { throw CarrierServerError.duplicateFallback }
            fallbackHandler = handler
        }
    }

    /// Registers one exact-path upgrade route (§1.3). Duplicate paths throw:
    /// one socket has one protocol owner.
    func registerUpgrade(path: String, handler: @escaping CarrierUpgradeHandler) throws {
        try queue.sync {
            guard upgradeRoutes[path] == nil else { throw CarrierServerError.duplicateRoute(.exact, path) }
            upgradeRoutes[path] = handler
        }
    }

    /// Legacy M1/M3 seam: registers (or replaces) one in-memory exact route.
    /// Safe from any queue — the write hops to the internal serial queue.
    func registerRoute(_ path: String, data: Data, contentType: String) {
        queue.async { [weak self] in
            guard let self else { return }
            self.exactRoutes[path] = { [weak self] request, conn in
                self?.serveRegisteredRoute(path, request: request, conn: conn)
            }
            self.routesContent[path] = (data, contentType)
        }
    }

    /// Content backing the legacy in-memory routes (queue-confined; the
    /// request always follows the registration on this serial queue).
    private var routesContent: [String: (data: Data, contentType: String)] = [:]

    private func serveRegisteredRoute(_ path: String, request: CarrierRequest, conn: NWConnection) {
        guard let route = routesContent[path] else { return }
        servedPaths.append(path)
        onRouteServed?(path, route.data.count)
        respond(status: 200, body: route.data, contentType: route.contentType, conn: conn)
    }

    // ---- lifecycle ---------------------------------------------------------

    /// Starts listening on 127.0.0.1 with an ephemeral port. `onReady` fires
    /// on the internal queue once the port is known. `installLegacyRoutes()`
    /// (CarrierRoutes.swift) is what wires the M1–M3 behavior on top.
    func start(onReady: @escaping () -> Void) throws {
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(
            host: NWEndpoint.Host("127.0.0.1"), port: NWEndpoint.Port.any)
        let listener = try NWListener(using: params)
        listener.stateUpdateHandler = { [weak self] state in
            if case .ready = state {
                self?.port = listener.port?.rawValue ?? 0
                onReady()
            }
            if case .failed(let error) = state {
                print("spike: carrier server failed: \(error)")
                fflush(stdout)
            }
        }
        listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
        self.listener = listener
        listener.start(queue: queue)
    }

    /// Stops the listener and destroys every upgraded socket explicitly —
    /// upgraded seats are not covered by closing the listener (§3.3).
    func stop() {
        queue.async { [weak self] in
            guard let self else { return }
            self.listener?.cancel()
            for seat in self.wsSeats.values { seat.conn.cancel() }
            self.wsSeats.removeAll()
        }
    }

    /// Sends one WS text frame to every seat on `path` (no-op while closed).
    func send(_ text: String, to path: String) {
        queue.async { [weak self] in
            guard let self else { return }
            for seat in self.wsSeats.values where seat.path == path && seat.open {
                self.sendFrame(seat.conn, opcode: 1, payload: Data(text.utf8))
            }
        }
    }

    /// Legacy M1/M2 seam: send to the `/ws` page.
    func send(_ text: String) {
        send(text, to: Self.wsPath)
    }

    /// Paths served with 200 so far, in serving order (guard: queue).
    func servedList() -> [String] { queue.sync { servedPaths } }

    /// Records one served path in serving order (route and fallback handlers
    /// run on the server queue).
    func recordServed(_ path: String) { servedPaths.append(path) }

    /// Schedules a block on the internal serial queue after `milliseconds`
    /// (the chunked-stream pacing leg).
    func schedule(afterMilliseconds ms: Int, _ block: @escaping () -> Void) {
        queue.asyncAfter(deadline: .now() + .milliseconds(ms), execute: block)
    }

    // ---- connection plumbing ----------------------------------------------

    private func accept(_ conn: NWConnection) {
        conn.stateUpdateHandler = { state in
            if case .failed = state { conn.cancel() }
        }
        conn.start(queue: queue)
        receive(conn)
    }

    private func receive(_ conn: NWConnection) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
            [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                if self.wsSeats[ObjectIdentifier(conn)] != nil {
                    self.drainWSFrames(conn, data)
                } else {
                    self.consumeHTTP(data, conn: conn)
                }
            }
            if error == nil, !isComplete { self.receive(conn) }
        }
    }

    /// Reassembles one HTTP request: head first, then a Content-Length body
    /// up to `maxBodyBytes` (§3.5). Dispatches exactly once per request.
    private func consumeHTTP(_ data: Data, conn: NWConnection) {
        let id = ObjectIdentifier(conn)
        httpRx[id, default: Data()].append(data)
        let text = String(data: httpRx[id] ?? Data(), encoding: .utf8) ?? ""
        guard let headerEnd = text.range(of: "\r\n\r\n") else { return }
        let head = String(text[..<headerEnd.lowerBound])
        let bodyText = String(text[headerEnd.upperBound...])
        guard let request = Self.parseRequest(head, buffered: text, from: headerEnd.upperBound)
        else {
            httpRx[id] = nil
            return respondError(400, "bad request", conn: conn)
        }
        if bodyText.utf8.count < request.declaredLength {
            return // body still arriving; keep buffering
        }
        httpRx[id] = nil
        if request.header("Sec-WebSocket-Key") != nil {
            return runUpgrade(request, conn: conn)
        }
        if request.declaredLength > Self.maxBodyBytes {
            return respondError(413, "body too large", conn: conn)
        }
        dispatch(request, conn: conn)
    }

    // ---- dispatch (§3.2: exact → longest prefix → fallback) -----------------

    private func dispatch(_ request: CarrierRequest, conn: NWConnection) {
        guard let path = request.path else {
            return respondError(400, "bad request path", conn: conn)
        }
        if let handler = exactRoutes[path] ?? longestPrefix(path) {
            return handler(request, conn)
        }
        guard let fallback = fallbackHandler else {
            return respondError(404, "not found", conn: conn)
        }
        fallback(request, conn)
    }

    /// Longest-prefix match: a prefix `p` matches `p` and `p/<anything>`.
    private func longestPrefix(_ path: String) -> CarrierHTTPHandler? {
        let matches = prefixRoutes.keys.filter { key in
            path == key || path.hasPrefix(key + "/")
        }
        guard let best = matches.max(by: { $0.count < $1.count }) else { return nil }
        return prefixRoutes[best]
    }

    // ---- responses -----------------------------------------------------------

    /// Sends one complete response and closes the connection (handlers own
    /// the lifecycle; `Connection: close` stays the carrier posture). With
    /// `bodyless` (HEAD) the headers keep the real length but no body follows.
    func respond(
        status: Int, body: Data, contentType: String, conn: NWConnection,
        headers: [String: String] = [:], bodyless: Bool = false
    ) {
        Self.respond(
            status: status, body: body, contentType: contentType, conn: conn,
            headers: headers, bodyless: bodyless
        )
    }

    /// The response writer, shared by the route seats (static: it touches
    /// only the connection).
    static func respond(
        status: Int, body: Data, contentType: String, conn: NWConnection,
        headers: [String: String] = [:], bodyless: Bool = false
    ) {
        var head = "HTTP/1.1 \(status) \(Self.reason(status))\r\n"
        head += "Content-Type: \(contentType)\r\nContent-Length: \(body.count)\r\n"
        for (name, value) in headers { head += "\(name): \(value)\r\n" }
        head += "Connection: close\r\n\r\n"
        var out = Data(head.utf8)
        if !bodyless { out.append(body) }
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }

    /// Plain-text non-200 response (the carrier's only error shape).
    func respondError(_ status: Int, _ message: String, conn: NWConnection) {
        respond(status: status, body: Data(message.utf8), contentType: "text/plain", conn: conn)
    }

    // ---- websocket upgrades (§1.3, §3.3) --------------------------------------

    /// Executes an upgrade handler's plan for one incoming upgrade request.
    /// Upgrades match by exact pathname only; an unmatched target destroys
    /// the socket — never a fall-through to static (§1.3, §3.3).
    private func runUpgrade(_ request: CarrierRequest, conn: NWConnection) {
        guard let path = request.path, let handler = upgradeRoutes[path] else {
            return conn.cancel()
        }
        guard let key = request.header("Sec-WebSocket-Key") else {
            return respondError(400, "missing WS key", conn: conn)
        }
        switch handler(request, key) {
        case .accept:
            acceptUpgrade(key: key, path: path, conn: conn)
        case let .reject(status, message):
            respondError(status, message, conn: conn)
        case .destroy:
            conn.cancel()
        }
    }

    private func acceptUpgrade(key: String, path: String, conn: NWConnection) {
        let head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
            + "Connection: Upgrade\r\n"
            + "Sec-WebSocket-Accept: \(Self.wsAccept(key: key))\r\n\r\n"
        wsSeats[ObjectIdentifier(conn)] = WSSeat(conn: conn, path: path, rx: Data(), open: true)
        conn.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
    }

    /// RFC6455 frames for one seat: text → callbacks (path-aware, plus the
    /// legacy `/ws` seam), ping → pong, close → echo + seat teardown.
    private func drainWSFrames(_ conn: NWConnection, _ data: Data) {
        let id = ObjectIdentifier(conn)
        wsSeats[id]?.rx.append(data)
        while let seat = wsSeats[id],
              let (opcode, payload, consumed) = Self.parseFrame(seat.rx) {
            wsSeats[id]?.rx.removeFirst(consumed)
            switch opcode {
            case 1:
                if let text = String(data: payload, encoding: .utf8) {
                    onWSFrame?(text, seat.path)
                    if seat.path == Self.wsPath { onWSMessage?(text) }
                }
            case 8:
                sendFrame(conn, opcode: 8, payload: Data())
                wsSeats[id] = nil
                conn.cancel()
            case 9:
                sendFrame(conn, opcode: 10, payload: payload) // ping → pong
            default:
                break
            }
        }
    }

    private func sendFrame(_ conn: NWConnection, opcode: Int, payload: Data) {
        var out = Data([UInt8(0x80 | opcode)])
        let n = payload.count
        if n < 126 {
            out.append(UInt8(n))
        } else if n < 65536 {
            out.append(contentsOf: [UInt8(126), UInt8(n >> 8), UInt8(n & 0xFF)])
        } else {
            out.append(UInt8(127))
            for shift in stride(from: 56, through: 0, by: -8) {
                out.append(UInt8((n >> shift) & 0xFF))
            }
        }
        out.append(payload)
        conn.send(content: out, completion: .contentProcessed { _ in })
    }

    // ---- wire helpers ---------------------------------------------------------

    /// RFC6455 server-side frame parse. Returns (opcode, payload, bytes
    /// consumed) or nil when the buffer holds an incomplete frame.
    static func parseFrame(_ buf: Data) -> (Int, Data, Int)? {
        let bytes = [UInt8](buf)
        guard bytes.count >= 2 else { return nil }
        let opcode = Int(bytes[0] & 0x0F)
        let masked = bytes[1] & 0x80 != 0
        var length = Int(bytes[1] & 0x7F)
        var offset = 2
        if length == 126 {
            guard bytes.count >= 4 else { return nil }
            length = Int(bytes[2]) << 8 | Int(bytes[3])
            offset = 4
        } else if length == 127 {
            guard bytes.count >= 10 else { return nil }
            length = bytes[2...9].reduce(0) { $0 << 8 | Int($1) }
            offset = 10
        }
        var mask = [UInt8](repeating: 0, count: 4)
        if masked {
            guard bytes.count >= offset + 4 else { return nil }
            mask = Array(bytes[offset..<offset + 4])
            offset += 4
        }
        guard bytes.count >= offset + length else { return nil }
        var payload = Array(bytes[offset..<offset + length])
        if masked {
            for i in 0..<length { payload[i] ^= mask[i % 4] }
        }
        return (opcode, Data(payload), offset + length)
    }

    private static func wsAccept(key: String) -> String {
        let magic = key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        return Data(Insecure.SHA1.hash(data: Data(magic.utf8))).base64EncodedString()
    }

    /// Parses the request head + any already-buffered body prefix into a
    /// `CarrierRequest`. Returns nil on a malformed request line.
    static func parseRequest(
        _ head: String, buffered: String, from bodyStart: String.Index
    ) -> CarrierRequest? {
        guard let requestLine = head.split(separator: "\r\n").first else { return nil }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else { return nil }
        let target = String(parts[1])
        let split = target.split(separator: "?", maxSplits: 1).map(String.init)
        var headers: [String: String] = [:]
        for line in head.split(separator: "\r\n").dropFirst() {
            let pair = line.split(separator: ":", maxSplits: 1)
            if pair.count == 2 {
                headers[pair[0].trimmingCharacters(in: .whitespaces).lowercased()] =
                    pair[1].trimmingCharacters(in: .whitespaces)
            }
        }
        let declared = Int(headers["content-length"] ?? "0") ?? 0
        let bufferedBody = String(buffered[bodyStart...])
        return CarrierRequest(
            method: String(parts[0]),
            path: decodedPath(split[0]),
            rawPath: split[0],
            query: split.count > 1 ? split[1] : nil,
            headers: headers,
            body: Data(bufferedBody.prefix(declared).utf8),
            declaredLength: declared
        )
    }

    /// One percent-decode of the pathname; nil on bad escapes (§3.2: 400, not
    /// a crash). Query handling stays with the raw target pieces.
    static func decodedPath(_ raw: String) -> String? {
        raw.removingPercentEncoding
    }

    static func headerValue(_ head: String, _ name: String) -> String? {
        for line in head.split(separator: "\r\n").dropFirst() {
            let pair = line.split(separator: ":", maxSplits: 1)
            if pair.count == 2, pair[0].trimmingCharacters(in: .whitespaces)
                .caseInsensitiveCompare(name) == .orderedSame {
                return pair[1].trimmingCharacters(in: .whitespaces)
            }
        }
        return nil
    }

    private static func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 204: return "No Content"
        case 303: return "See Other"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 405: return "Method Not Allowed"
        case 413: return "Payload Too Large"
        default: return "Error"
        }
    }
}

/// Registration-time config failures (§1.2–§1.4: duplicates are fatal config
/// errors — the drive surfaces them as loud outcomes, not precedence races).
enum CarrierServerError: Error {
    case duplicateRoute(CarrierRouteKind, String)
    case duplicateFallback
}

/// Handler typealiases: a handler owns the FULL response lifecycle.
typealias CarrierHTTPHandler = (CarrierRequest, NWConnection) -> Void
/// Upgrade handlers decide per §1.3; the server executes the plan.
typealias CarrierUpgradeHandler = (CarrierRequest, String) -> CarrierUpgradePlan
