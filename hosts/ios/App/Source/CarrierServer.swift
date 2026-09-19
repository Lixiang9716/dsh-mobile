import CryptoKit
import Foundation
import Network

/// One loopback HTTP + WebSocket endpoint (RFC6455, text frames only).
/// Serves the staged `web/` directory as static files and upgrades
/// `GET /ws` to a raw WS connection. Transport only: the wire is reduced
/// to `onWSMessage(String)` outbound via `send(_:)` — this class never
/// touches JS or the runtime. All state is owned by its internal serial
/// queue; `send` is safe from any queue.
final class CarrierServer {
    static let wsPath = "/ws"
    var onWSMessage: ((String) -> Void)?
    /// Fired on the server queue whenever a static file is served with 200 —
    /// the carrier-side "the Web Client mounted" signal (optional: sessions
    /// that don't care leave it nil; the m1 drive is unaffected).
    var onStaticServed: ((String) -> Void)?
    private(set) var port: UInt16 = 0

    private let queue = DispatchQueue(label: "org.dsh.carrier.server")
    private var listener: NWListener?
    private var webRoot = URL(fileURLWithPath: "/nonexistent")
    private var servedPaths: [String] = []
    private var httpRx: [ObjectIdentifier: Data] = [:]
    private var wsConnection: NWConnection?
    private var wsRx = Data()
    private var wsOpen = false

    /// Starts listening on 127.0.0.1 with an ephemeral port. `onReady` fires
    /// on the internal queue once the port is known.
    func start(webRoot: URL, onReady: @escaping () -> Void) throws {
        self.webRoot = webRoot
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

    func stop() {
        queue.async { [weak self] in
            self?.listener?.cancel()
            self?.wsConnection?.cancel()
            self?.wsOpen = false
        }
    }

    /// Sends one WS text frame to the connected page (no-op while closed).
    func send(_ text: String) {
        queue.async { [weak self] in
            guard let self, self.wsOpen else { return }
            self.sendFrame(opcode: 1, payload: Data(text.utf8))
        }
    }

    /// Paths served with 200 so far, in serving order (guard: queue).
    func servedList() -> [String] { queue.sync { servedPaths } }

    // ---- connection plumbing --------------------------------------------

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
                if conn === self.wsConnection {
                    self.wsRx.append(data)
                    self.drainWSFrames()
                } else {
                    self.consumeHTTP(data, conn: conn)
                }
            }
            if error == nil, !isComplete { self.receive(conn) }
        }
    }

    private func consumeHTTP(_ data: Data, conn: NWConnection) {
        let id = ObjectIdentifier(conn)
        httpRx[id, default: Data()].append(data)
        let text = httpRx[id].flatMap { String(data: $0, encoding: .utf8) } ?? ""
        guard let headerEnd = text.range(of: "\r\n\r\n") else { return }
        let head = String(text[..<headerEnd.lowerBound])
        httpRx[id] = nil
        route(head, conn: conn)
    }

    /// Plain-text non-200 response (the static path's only error shape).
    private func respondError(_ status: Int, _ message: String, conn: NWConnection) {
        respond(
            status: status,
            body: Data(message.utf8),
            contentType: "text/plain",
            conn: conn
        )
    }

    private func route(_ head: String, conn: NWConnection) {
        guard let requestLine = head.split(separator: "\r\n").first else {
            return respondError(400, "bad request", conn: conn)
        }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2, parts[0] == "GET" else {
            return respondError(405, "GET only", conn: conn)
        }
        let path = String(parts[1]).split(separator: "?").first.map(String.init) ?? ""
        if path == Self.wsPath {
            if let key = Self.headerValue(head, "Sec-WebSocket-Key") {
                upgrade(key: key, conn: conn)
            } else {
                respondError(400, "missing WS key", conn: conn)
            }
            return
        }
        if serveGatewayE2E(path: path, conn: conn) { return }
        serveStatic(path: path, conn: conn)
    }

    // ---- m2 gateway-e2e endpoints (chunked streams) -------------------------

    /// GET /gateway-e2e/bytes → 64 bytes as exactly 2 chunks of 32 (small
    /// delay between writes so the JS side sees 2 body events).
    /// GET /gateway-e2e/slow → 6 chunks × 16 bytes, ~300ms apart (abort test).
    /// Added after the m1 carrier phase completes — m1 manifests are frozen
    /// and their assertions never see these paths.
    private func serveGatewayE2E(path: String, conn: NWConnection) -> Bool {
        switch path {
        case "/gateway-e2e/bytes":
            streamChunks(chunkBytes: 32, chunkCount: 2, intervalMs: 40, conn: conn)
        case "/gateway-e2e/slow":
            streamChunks(chunkBytes: 16, chunkCount: 6, intervalMs: 300, conn: conn)
        default:
            return false
        }
        servedPaths.append(path)
        return true
    }

    /// HTTP/1.1 chunked stream of deterministic ASCII ("0123456789abcdef"
    /// repeated); the terminal zero chunk closes the connection.
    private func streamChunks(
        chunkBytes: Int, chunkCount: Int, intervalMs: Int, conn: NWConnection
    ) {
        let head = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n"
            + "Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
        conn.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
        let unit = Data("0123456789abcdef".utf8)
        var chunk = Data()
        while chunk.count < chunkBytes { chunk.append(unit) }
        chunk = chunk.prefix(chunkBytes)
        for index in 0..<chunkCount {
            queue.asyncAfter(deadline: .now() + .milliseconds(intervalMs * (index + 1))) {
                [weak self] in
                self?.sendChunk(chunk, final: index == chunkCount - 1, conn: conn)
            }
        }
    }

    private func sendChunk(_ chunk: Data, final: Bool, conn: NWConnection) {
        var frame = Data(String(format: "%zx\r\n", chunk.count).utf8)
        frame.append(chunk)
        frame.append(Data("\r\n".utf8))
        if final { frame.append(Data("0\r\n\r\n".utf8)) }
        conn.send(content: frame, completion: .contentProcessed { _ in
            if final { conn.cancel() }
        })
    }

    // ---- static files -----------------------------------------------------

    private func serveStatic(path: String, conn: NWConnection) {
        guard !path.contains(".."), var rel = URLComponents(string: path)?.path else {
            return respondError(404, "not found", conn: conn)
        }
        if rel == "/" { rel = "/index.html" }
        let file = webRoot.appendingPathComponent(String(rel.dropFirst()))
        guard let data = try? Data(contentsOf: file) else {
            return respondError(404, "not found", conn: conn)
        }
        let isHTML = rel.hasSuffix(".html")
        guard isHTML || rel.hasSuffix(".js") else {
            return respondError(404, "not found", conn: conn)
        }
        // record the REQUEST path ("/" for the document), which is what the
        // scenario's static-serving evidence asserts on
        servedPaths.append(path)
        onStaticServed?(path)
        respond(status: 200, body: data,
                contentType: isHTML ? "text/html" : "text/javascript", conn: conn)
    }

    private func respond(status: Int, body: Data, contentType: String, conn: NWConnection) {
        let head = "HTTP/1.1 \(status) \(Self.reason(status))\r\n"
            + "Content-Type: \(contentType)\r\nContent-Length: \(body.count)\r\n"
            + "Connection: close\r\n\r\n"
        var out = Data(head.utf8)
        out.append(body)
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }

    // ---- websocket --------------------------------------------------------

    private func upgrade(key: String, conn: NWConnection) {
        let head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
            + "Connection: Upgrade\r\n"
            + "Sec-WebSocket-Accept: \(Self.wsAccept(key: key))\r\n\r\n"
        wsConnection?.cancel()
        wsConnection = conn
        wsRx = Data()
        wsOpen = true
        conn.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
    }

    private func drainWSFrames() {
        while let (opcode, payload, consumed) = Self.parseFrame(wsRx) {
            wsRx.removeFirst(consumed)
            switch opcode {
            case 1:
                if let text = String(data: payload, encoding: .utf8) { onWSMessage?(text) }
            case 8:
                wsOpen = false
                sendFrame(opcode: 8, payload: Data())
                wsConnection?.cancel()
            case 9:
                sendFrame(opcode: 10, payload: payload) // ping → pong
            default:
                break
            }
        }
    }

    private func sendFrame(opcode: Int, payload: Data) {
        guard let conn = wsConnection else { return }
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

    // ---- wire helpers -----------------------------------------------------

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

    private static func headerValue(_ head: String, _ name: String) -> String? {
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
        case 400: return "Bad Request"
        case 404: return "Not Found"
        case 405: return "Method Not Allowed"
        default: return "Error"
        }
    }
}
