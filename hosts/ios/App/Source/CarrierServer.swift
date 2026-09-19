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

    private func route(_ head: String, conn: NWConnection) {
        guard let requestLine = head.split(separator: "\r\n").first else {
            return respond(status: 400, body: Data("bad request".utf8),
                           contentType: "text/plain", conn: conn)
        }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2, parts[0] == "GET" else {
            return respond(status: 405, body: Data("GET only".utf8),
                           contentType: "text/plain", conn: conn)
        }
        let path = String(parts[1]).split(separator: "?").first.map(String.init) ?? ""
        if path == Self.wsPath {
            if let key = Self.headerValue(head, "Sec-WebSocket-Key") {
                upgrade(key: key, conn: conn)
            } else {
                respond(status: 400, body: Data("missing WS key".utf8),
                        contentType: "text/plain", conn: conn)
            }
            return
        }
        serveStatic(path: path, conn: conn)
    }

    // ---- static files -----------------------------------------------------

    private func serveStatic(path: String, conn: NWConnection) {
        guard !path.contains(".."), var rel = URLComponents(string: path)?.path else {
            return respond(status: 404, body: Data("not found".utf8),
                           contentType: "text/plain", conn: conn)
        }
        if rel == "/" { rel = "/index.html" }
        let file = webRoot.appendingPathComponent(String(rel.dropFirst()))
        guard let data = try? Data(contentsOf: file) else {
            return respond(status: 404, body: Data("not found".utf8),
                           contentType: "text/plain", conn: conn)
        }
        let isHTML = rel.hasSuffix(".html")
        guard isHTML || rel.hasSuffix(".js") else {
            return respond(status: 404, body: Data("not found".utf8),
                           contentType: "text/plain", conn: conn)
        }
        // record the REQUEST path ("/" for the document), which is what the
        // scenario's static-serving evidence asserts on
        servedPaths.append(path)
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
