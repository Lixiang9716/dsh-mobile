import Foundation
import Network

/// The legacy M1–M3 carrier wiring, expressed on the Phase-B route table
/// (docs/webserver-contract.md §3.2 "migrate the existing wiring"): the
/// static fallback seat over the staged web root, the `/ws` exact upgrade,
/// and the `/gateway-e2e` prefix streams. Behavior is byte-compatible with
/// the pre-Phase-B server — the m1/m2/m3 manifests are frozen and stay green
/// unchanged.
extension CarrierServer {
    /// Installs the legacy routes. Call before `start(onReady:)`; duplicate
    /// registration across drives throws (one server per drive process).
    func installLegacyRoutes(webRoot: URL) throws {
        try registerFallback { [weak self] request, conn in
            self?.serveLegacyStatic(request, webRoot: webRoot, conn: conn)
        }
        try registerUpgrade(path: Self.wsPath) { _, _ in .accept }
        try register(kind: .prefix, path: "/gateway-e2e") { [weak self] request, conn in
            self?.serveGatewayE2E(request, conn: conn)
        }
    }

    /// Legacy static seat: `..`-checked, root-relative files restricted to
    /// `.html`/`.js`, `/` → `/index.html`, 404 otherwise — the exact pre-B
    /// serving shape the M2/M3 mount evidence asserts on.
    private func serveLegacyStatic(
        _ request: CarrierRequest, webRoot: URL, conn: NWConnection
    ) {
        guard let rel = Self.legacyRelativePath(request) else {
            return respondError(404, "not found", conn: conn)
        }
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
        recordServed(request.rawPath)
        onStaticServed?(request.rawPath)
        respond(status: 200, body: data,
                contentType: isHTML ? "text/html" : "text/javascript", conn: conn)
    }

    /// The legacy path check, verbatim: no `..` anywhere in the request
    /// target, then URLComponents' one decode for the root-relative form.
    static func legacyRelativePath(_ request: CarrierRequest) -> String? {
        guard !request.rawPath.contains(".."),
              var rel = URLComponents(string: request.rawPath)?.path else {
            return nil
        }
        if rel == "/" { rel = "/index.html" }
        return rel
    }

    // ---- m2 gateway-e2e endpoints (chunked streams) -------------------------

    /// GET /gateway-e2e/bytes → 64 bytes as exactly 2 chunks of 32 (small
    /// delay between writes so the JS side sees 2 body events).
    /// GET /gateway-e2e/slow → 6 chunks × 16 bytes, ~300ms apart (abort test).
    private func serveGatewayE2E(_ request: CarrierRequest, conn: NWConnection) {
        switch request.path {
        case "/gateway-e2e/bytes":
            streamChunks(chunkBytes: 32, chunkCount: 2, intervalMs: 40, conn: conn)
        case "/gateway-e2e/slow":
            streamChunks(chunkBytes: 16, chunkCount: 6, intervalMs: 300, conn: conn)
        default:
            return respondError(404, "not found", conn: conn)
        }
        recordServed(request.rawPath)
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
            schedule(afterMilliseconds: intervalMs * (index + 1)) { [weak self] in
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
}
