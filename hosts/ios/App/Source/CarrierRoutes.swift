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
    /// on a bad key). Real transport, scripted model. The v2web drive's
    /// legs select scripts by prompt marker (every existing drive's prompts
    /// never carry these, so their wire stays byte-identical to before):
    ///   (none)       — the success script: "Hello from upstream" in
    ///                  5-char chunks + finish + usage + [DONE].
    ///   SLOW_TURN    — the cancel leg: the same reply body drips in slices
    ///                  ~220 ms apart, so the turn is provably mid-stream
    ///                  when the probe presses stop.
    ///   CREATE_TURN  — the creation leg: the assistant message carries TWO
    ///                  tool calls — write creates
    ///                  creations/blue-compact.html, present declares it a
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
            return respondError(401, "mock authentication failed", conn: conn)
        }
        NSLog("dsh.mock: body len=%d plugin=%d create=%d",
              request.body.count,
              request.body.range(of: Data("PLUGIN_CREATE_TURN".utf8)) != nil ? 1 : 0,
              request.body.range(of: Data("CREATE_TURN".utf8)) != nil ? 1 : 0)
        // The scripted-turn dispatch: MOST-SPECIFIC marker first —
        // PLUGIN_CREATE_TURN contains the CREATE_TURN substring.
        if dispatchScriptedTurn(request, "PLUGIN_CREATE_TURN",
            done: \.servePluginCreateScriptDone, serve: servePluginCreateScript, conn: conn) { return }
        if dispatchScriptedTurn(request, "CREATE_TURN",
            done: \.serveCreateScriptDone, serve: serveCreateScript, conn: conn) { return }
        if dispatchScriptedTurn(request, "GAME_TURN",
            done: \.serveGameScriptDone, serve: serveGameScript, conn: conn) { return }
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

    /// One scripted turn's marker check + one-shot latch + script handoff
    /// (a follow-up model call gets the plain success body — the latch — or
    /// the scripted tool calls would loop forever). Returns true when the
    /// request was served.
    @discardableResult
    private func dispatchScriptedTurn(
        _ request: CarrierRequest, _ marker: String,
        done: ReferenceWritableKeyPath<CarrierServer, Bool>,
        serve: @escaping ( @escaping (Int, Data, String, NWConnection) -> Void, NWConnection) -> Void,
        conn: NWConnection
    ) -> Bool {
        guard request.body.contains(Data(marker.utf8)) else { return false }
        let respond: (Int, Data, String, NWConnection) -> Void = {
            self.respond(status: $0, body: $1, contentType: $2, conn: $3)
        }
        if self[keyPath: done] {
            serveSuccess(respond, conn: conn)
        } else {
            self[keyPath: done] = true
            serve(respond, conn)
        }
        return true
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
    /// `write` creates the deliverable, present declares it (the
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
        // The scripted "model" writes the way the real one does: the `write`
        // tool over the fs service (the system prompt's own guidance), which
        // lands the file on DISK inside the app scope so the card's
        // workspaceFiles/read fetch can serve it. (str_replace_editor's
        // world is in-memory only — its files are invisible to the gateway,
        // which is exactly the gap this leg caught.) `write` demands an
        // absolute path; `present` keeps the relative form — its contract
        // resolves against the session cwd, which this leg also covers.
        let whalePath = SessionServe.workspaceRoot
            .appendingPathComponent("creations/blue-compact.html").path
        let writeArgs = "{\"file_path\":\"\(whalePath)\","
            + "\"content\":\"<!doctype html><title>蓝色鲸鱼</title>"
            + "<style>body{margin:0;background:#0a2a52;overflow:hidden;height:100dvh}"
            + "#w{font-size:120px;position:absolute;top:38%;left:-140px;"
            + "animation:swim 8s linear infinite}"
            + "</style><!--BLUE-V2-CANARY--><div id=w>🐋</div>\"}"
        let presentArgs = "{\"files\":[{\"path\":\"creations/blue-compact.html\","
            + "\"description\":\"游动的蓝色鲸鱼 — 点按全屏查看\"}]}"
        sse(["choices": [["index": 0, "delta": ["tool_calls": [
            ["index": 0, "id": "call-create-1", "type": "function",
             "function": ["name": "write", "arguments": writeArgs]],
            ["index": 1, "id": "call-present-1", "type": "function",
             "function": ["name": "present", "arguments": presentArgs]],
        ]], "finish_reason": NSNull()]]])
        sse(["choices": [["index": 0, "delta": ["content": ""],
            "finish_reason": "stop"]],
            "usage": ["prompt_tokens": 3, "completion_tokens": 12]])
        body.append(Data("data: [DONE]\n\n".utf8))
        respond(200, body, "text/event-stream; charset=utf-8", conn)
    }

    /// The GAME script: the same TWO tool-call shape as the compact (distinct
    /// wire indices), creating the canvas-game deliverable the game leg
    /// drives. The write arguments are JSON-serialized rather than
    /// hand-escaped — the game HTML carries quotes and newlines, and hand
    /// escaping that is exactly how broken fixtures happen.
    private func serveGameScript(
        respond: @escaping (Int, Data, String, NWConnection) -> Void,
        conn: NWConnection) {
        var body = Data()
        func sse(_ payload: @autoclosure () -> Any) {
            guard let data = try? JSONSerialization.data(withJSONObject: payload()),
                  let text = String(data: data, encoding: .utf8) else { return }
            body.append(Data("data: \(text)\n\n".utf8))
        }
        let gamePath = SessionServe.workspaceRoot
            .appendingPathComponent("creations/dsh-game.html").path
        let writeArgs = String(data: try! JSONSerialization.data(
            withJSONObject: ["file_path": gamePath, "content": Self.gameHtml]),
            encoding: .utf8) ?? "{}"
        let presentArgs = "{\"files\":[{\"path\":\"creations/dsh-game.html\","
            + "\"description\":\"弹球小游戏 — 点按全屏查看\"}]}"
        sse(["choices": [["index": 0, "delta": ["tool_calls": [
            ["index": 0, "id": "call-write-game", "type": "function",
             "function": ["name": "write", "arguments": writeArgs]],
            ["index": 1, "id": "call-present-game", "type": "function",
             "function": ["name": "present", "arguments": presentArgs]],
        ]], "finish_reason": NSNull()]]])
        sse(["choices": [["index": 0, "delta": ["content": ""],
            "finish_reason": "stop"]],
            "usage": ["prompt_tokens": 3, "completion_tokens": 12]])
        body.append(Data("data: [DONE]\n\n".utf8))
        respond(200, body, "text/event-stream; charset=utf-8", conn)
    }

    /// The PLUGIN_CREATE script (the create-approve-hotmount full-chain
    /// leg): the scripted model answers "生成番茄时钟插件" with ONE
    /// plugin_create call — the dsh-create system plugin then writes the
    /// package, presents the NATIVE approval, installs the registry row,
    /// and starts the live card. The duration is deliberately short (the
    /// leg's evidence window; the real chat passes 1500000 for 25 minutes).
    private func servePluginCreateScript(
        respond: @escaping (Int, Data, String, NWConnection) -> Void,
        conn: NWConnection) {
        NSLog("%@", "dsh.mock: PLUGIN_CREATE script served (marker matched)")
        var body = Data()
        func sse(_ payload: @autoclosure () -> Any) {
            guard let data = try? JSONSerialization.data(withJSONObject: payload()),
                  let text = String(data: data, encoding: .utf8) else { return }
            body.append(Data("data: \(text)\n\n".utf8))
        }
        let createArgs = String(data: try! JSONSerialization.data(
            withJSONObject: [
                "name": "pomodoro-create",
                "title": "番茄时钟 · 创作",
                "kind": "timer",
                "durationMs": 20000,
            ] as [String: Any]), encoding: .utf8) ?? "{}"
        sse(["choices": [["index": 0, "delta": ["tool_calls": [
            ["index": 0, "id": "call-plugin-create", "type": "function",
             "function": ["name": "plugin_create", "arguments": createArgs]],
        ]], "finish_reason": NSNull()]]])
        sse(["choices": [["index": 0, "delta": ["content": ""],
            "finish_reason": "stop"]],
            "usage": ["prompt_tokens": 3, "completion_tokens": 12]])
        body.append(Data("data: [DONE]\n\n".utf8))
        respond(200, body, "text/event-stream; charset=utf-8", conn)
    }

    /// The game fixture the scripted model "writes": a dependency-free canvas
    /// game. The heartbeat line posts frame/beat counters to the PARENT — the
    /// viewer's iframe is sandbox="allow-scripts" with no allow-same-origin,
    /// so the drive cannot read inside it; the heartbeat is the game leg's
    /// canary twin (fixture evidence, not product code), counted by the
    /// probe-side listener (V2WebProbe.installGameListenerLeg).
    static let gameHtml = #"""
<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>弹球小游戏</title>
<style>html,body{margin:0;height:100%;background:#0b1020;overflow:hidden}
canvas{display:block;width:100vw;height:98vh;touch-action:none}</style>
</head><body>
<canvas id="g"></canvas>
<script>
/* DSH-GAME-CANARY */
window.__game = { frames: 0, beats: 0 };
const cv = document.getElementById('g'), cx = cv.getContext('2d');
let W, H; const fit = () => { W = cv.width = innerWidth; H = cv.height = innerHeight; };
fit(); addEventListener('resize', fit);
const ball = { x: 80, y: 80, vx: 2.6, vy: 2.0, r: 10 };
const pad = { w: 92, h: 10, x: 20, y: 0 };
const move = (e) => { const px = (e.touches ? e.touches[0].clientX : e.clientX);
  pad.x = Math.max(0, Math.min(W - pad.w, px - pad.w / 2)); };
addEventListener('pointermove', move); addEventListener('pointerdown', move);
const beat = () => { window.__game.beats++;
  try { parent.postMessage({ __dshGame: 1, frames: window.__game.frames,
    beats: window.__game.beats }, '*'); } catch (e) {} };
setInterval(beat, 50);
const step = () => {
  window.__game.frames++;
  ball.x += ball.vx; ball.y += ball.vy;
  if (ball.x < ball.r || ball.x > W - ball.r) { ball.vx = -ball.vx;
    ball.x = Math.max(ball.r, Math.min(W - ball.r, ball.x)); }
  if (ball.y < ball.r) ball.vy = Math.abs(ball.vy);
  pad.y = H - 26;
  if (ball.y > pad.y - ball.r && ball.y < pad.y + pad.h &&
      ball.x > pad.x - ball.r && ball.x < pad.x + pad.w + ball.r) {
    ball.vy = -Math.abs(ball.vy); }
  if (ball.y > H + ball.r) { ball.y = H / 3; ball.x = W / 3;
    ball.vy = -Math.abs(ball.vy); }
  cx.fillStyle = '#0b1020'; cx.fillRect(0, 0, W, H);
  cx.fillStyle = '#7fd1ff'; cx.beginPath();
  cx.arc(ball.x, ball.y, ball.r, 0, 6.3); cx.fill();
  cx.fillStyle = '#e8f1ff'; cx.fillRect(pad.x, pad.y, pad.w, pad.h);
  cx.fillStyle = '#5a6b8c'; cx.font = '14px sans-serif';
  cx.fillText('弹球 — 拖动挡板', 12, 22);
  requestAnimationFrame(step);
};
requestAnimationFrame(step);
</script></body></html>
"""#

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
