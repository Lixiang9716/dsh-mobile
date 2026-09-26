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

    // ---- scripted llm endpoint (session.live-read; W-SESS) ---------------------

    /// POST /mock-llm/chat/completions — the SCRIPTED model boundary of the
    /// on-device session-live drive: a real loopback HTTP + SSE endpoint on
    /// the carrier whose scripts mirror the vendored dsh-llm-mock-server's
    /// success stream byte-for-byte and use its fixed bearer check (401 JSON
    /// on a bad key). Real transport, scripted model. The nextweb drive's
    /// legs select scripts by prompt marker (every existing drive's prompts
    /// never carry these, so their wire stays byte-identical to before):
    ///   (none)       — the success script: "Hello from upstream" in
    ///                  5-char chunks + finish + usage + [DONE].
    ///   SLOW_TURN    — the cancel leg: the same reply body drips in slices
    ///                  ~220 ms apart, so the turn is provably mid-stream
    ///                  when the probe presses stop.
    ///   CREATE_TURN  — the creation leg: the assistant message carries TWO
    ///                  tool calls — str_replace_editor creates
    ///                  creations/blue-whale.html, present declares it a
    ///                  deliverable (journaled deliverables/presented).
    static let mockLlmPath = "/mock-llm/chat/completions"
    static let mockLlmKey = "mock-key-0001"

    /// The drip pacing for the slow script (the cancel leg's race window).
    static let slowDripInterval = 220

    func serveSuccess(_ respond: @escaping (Int, Data, String, NWConnection) -> Void,
        conn: NWConnection) {
        respond(200, scriptedSuccessBody(), "text/event-stream; charset=utf-8", conn)
    }

    func registerScriptedLlm() throws {
        try register(kind: .exact, path: Self.mockLlmPath) { [weak self] request, conn in
            self?.serveScriptedLlm(request, conn: conn)
        }
    }

    private func serveScriptedLlm(_ request: CarrierRequest, conn: NWConnection) {
        guard request.method == "POST" else {
            return respondError(405, "method not allowed", conn: conn)
        }
        guard request.header("authorization") == "Bearer \(Self.mockLlmKey)" else {
            // The vendored mock's fixed 401 leg: JSON error body, provider shape.
            let body: [String: Any] = ["error": [
                "message": "mock authentication failed",
                "type": "mock_error",
                "code": "invalid_api_key",
            ]]
            let data = (try? JSONSerialization.data(withJSONObject: body)) ?? Data()
            respond(status: 401, body: data, contentType: "application/json", conn: conn)
            return
        }
        if request.body.contains(Data("CREATE_TURN".utf8)) {
            // ONE create round per launch: a follow-up model call (the agent
            // loop's post-tool continuation) gets the plain success body, or
            // the scripted tool calls would loop forever.
            if serveCreateScriptDone {
                return serveSuccess({ self.respond(status: $0, body: $1, contentType: $2, conn: $3) },
                    conn: conn)
            }
            serveCreateScriptDone = true
            return serveCreateScript(respond: { self.respond(status: $0, body: $1, contentType: $2, conn: $3) },
                conn: conn)
        }
        let body = scriptedSuccessBody()
        if request.body.contains(Data("SLOW_TURN".utf8)) {
            Self.respondSlowDrip(
                body: body, contentType: "text/event-stream; charset=utf-8",
                interval: Self.slowDripInterval, conn: conn)
        } else {
            respond(status: 200, body: body,
                contentType: "text/event-stream; charset=utf-8", conn: conn)
        }
    }

    /// The success script's canned SSE body.
    private func scriptedSuccessBody() -> Data {
        let successText = "Hello from upstream"
        var body = Data()
        func sse(_ payload: @autoclosure () -> Any) {
            guard let data = try? JSONSerialization.data(withJSONObject: payload()),
                  let text = String(data: data, encoding: .utf8) else { return }
            body.append(Data("data: \(text)\n\n".utf8))
        }
        for chunk in stride(from: 0, to: successText.count, by: 5).map({
            String(Array(successText)[$0..<min($0 + 5, successText.count)])
        }) {
            sse(["choices": [["index": 0, "delta": ["content": chunk],
                "finish_reason": NSNull()]]])
        }
        sse(["choices": [["index": 0, "delta": ["content": ""],
            "finish_reason": "stop"]],
            "usage": ["prompt_tokens": 3, "completion_tokens": successText.count]])
        body.append(Data("data: [DONE]\n\n".utf8))
        return body
    }

    /// The CREATE script's assistant message: TWO tool calls in one turn —
    /// str_replace_editor creates the deliverable, present declares it (the
    /// runtime journals deliverables/presented; the client renders the card).
    private func serveCreateScript(
        respond: @escaping (Int, Data, String, NWConnection) -> Void,
        conn: NWConnection) {
        var body = Data()
        func sse(_ payload: @autoclosure () -> Any) {
            guard let data = try? JSONSerialization.data(withJSONObject: payload()),
                  let text = String(data: data, encoding: .utf8) else { return }
            body.append(Data("data: \(text)\n\n".utf8))
        }
        let createArgs = "{\"command\":\"create\",\"path\":\"creations/blue-whale.html\","
            + "\"file_text\":\"<!doctype html><title>蓝色鲸鱼</title>"
            + "<style>body{margin:0;background:#0a2a52;overflow:hidden;height:100dvh}"
            + "#w{font-size:120px;position:absolute;top:38%;left:-140px;"
            + "animation:swim 8s linear infinite}"
            + "</style><!--BLUE-WHALE-CANARY--><div id=w>🐋</div>\"}"
        let presentArgs = "{\"files\":[{\"path\":\"creations/blue-whale.html\","
            + "\"description\":\"游动的蓝色鲸鱼 — 点按全屏查看\"}]}"
        sse(["choices": [["index": 0, "delta": ["tool_calls": [
            ["index": 0, "id": "call-create-1", "type": "function",
             "function": ["name": "str_replace_editor", "arguments": createArgs]],
            ["index": 1, "id": "call-present-1", "type": "function",
             "function": ["name": "present", "arguments": presentArgs]],
        ]], "finish_reason": NSNull()]]])
        sse(["choices": [["index": 0, "delta": ["content": ""],
            "finish_reason": "stop"]],
            "usage": ["prompt_tokens": 3, "completion_tokens": 12]])
        body.append(Data("data: [DONE]\n\n".utf8))
        respond(200, body, "text/event-stream; charset=utf-8", conn)
    }

}

extension CarrierServer {
    /// Sends the head + body in `interval` ms-spaced slices on ONE connection:
    /// HTTP-legal (Content-Length announces the full body; slices are plain
    /// sends; the connection closes with the final slice).
    static func respondSlowDrip(body: Data, contentType: String,
        interval: Int, conn: NWConnection) {
        var head = "HTTP/1.1 200 OK\r\n"
        head += "Content-Type: \(contentType)\r\nContent-Length: \(body.count)\r\n"
        head += "Connection: close\r\n\r\n"
        conn.send(content: Data(head.utf8), completion: .contentProcessed { _ in })
        let slice = max(1, body.count / 8)
        var slices: [Data] = []
        var offset = body.startIndex
        while offset < body.endIndex {
            let end = body.index(offset, offsetBy: slice, limitedBy: body.endIndex)
                ?? body.endIndex
            slices.append(body[offset..<end])
            offset = end
        }
        sendDrip(slices, at: 0, interval: interval, conn: conn)
    }

    /// One drip link: send slice `index`, schedule the next.
    private static func sendDrip(_ slices: [Data], at index: Int,
        interval: Int, conn: NWConnection) {
        guard index < slices.count else {
            conn.cancel()
            return
        }
        conn.send(content: slices[index], completion: .contentProcessed { _ in
            DispatchQueue.global().asyncAfter(
                deadline: .now() + .milliseconds(interval)) {
                sendDrip(slices, at: index + 1, interval: interval, conn: conn)
            }
        })
    }
}
