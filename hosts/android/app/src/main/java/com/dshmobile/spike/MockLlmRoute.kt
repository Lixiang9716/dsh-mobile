package com.dshmobile.spike

import java.io.OutputStream
import org.json.JSONArray
import org.json.JSONObject

/**
 * POST /mock-llm/chat/completions — the SCRIPTED model boundary of the
 * on-device session-live drive (android.session.live-read): a real loopback
 * HTTP + SSE endpoint on the carrier whose script mirrors the vendored
 * dsh-llm-mock-server's success stream byte-for-byte (successText
 * 'Hello from upstream', chunkSize 5, terminal chunk with finish_reason +
 * usage, [DONE]) and its fixed bearer check (401 JSON on a bad key). Real
 * transport, scripted model — logged as such by the scenario's llm/runtime
 * record. The drive chooses the success script unless a prompt marker
 * selects another (SLOW_TURN drip, CREATE_TURN tool calls); script
 * sequences (auth_error et al.) stay the CLI mock's territory. Kotlin
 * sibling of hosts/ios CarrierRoutes.swift's scripted-llm route.
 */
object MockLlmRoute {

    const val PATH = "/mock-llm/chat/completions"
    const val KEY = "mock-key-0001"

    private const val SUCCESS_TEXT = "Hello from upstream"
    private const val CHUNK_SIZE = 5

    /** The drip pacing for the slow script (the cancel leg's race window),
     * mirroring the iOS seat's slowDripInterval. */
    const val SLOW_DRIP_INTERVAL_MS = 220L

    /** The session workspace root the CREATE script writes into — set by the
     * serving seat at boot (the file must land inside the granted app scope
     * so the card's workspaceFiles/read fetch can serve it). */
    @Volatile var workspaceRoot: String = ""

    /** The parity script mirrors the node-side drive exactly
     * (ci/run-upstream-parity.sh): success, tool_call_success (todo_write
     * with schema-valid arguments, split mid-arguments like the vendored
     * mock), closing success, then auth_error forever. */
    private const val PARITY_TOOL_NAME = "todo_write"
    private const val PARITY_TOOL_ARGUMENTS =
        """{"todos":[{"content":"Track the parity check","status":"in_progress"}]}"""

    @Volatile private var parity = false
    private val parityCounter = java.util.concurrent.atomic.AtomicInteger()

    /** ONE create round per launch: a follow-up model call (the agent loop's
     * post-tool continuation) gets the plain success body, or the scripted
     * tool calls would loop forever (the iOS seat's one-shot latch). */
    @Volatile private var createScriptDone = false

    /** Arm the parity script (the upstream-parity drive does; every other
     * drive keeps the unconditional success stream). */
    fun enableParityScript() {
        parity = true
        parityCounter.set(0)
    }

    /** Carrier thread: one scripted chat-completions response, then close.
     * The nextweb drive's legs select scripts by prompt marker (every other
     * drive's prompts never carry them, so their wire stays byte-identical):
     * CREATE_TURN answers one round with the write+present tool calls;
     * SLOW_TURN drips the success body ~220ms per slice. */
    fun serve(request: CarrierRequest, out: OutputStream) {
        if (request.method != "POST") {
            CarrierHTTP.respond(out, 405, "text/plain", ByteArray(0))
            return
        }
        if (request.header("authorization") != "Bearer $KEY") {
            mockAuthError(out)
            return
        }
        val bodyText = String(request.body, Charsets.UTF_8)
        if (bodyText.contains("CREATE_TURN")) {
            if (createScriptDone) {
                CarrierHTTP.respond(
                    out, 200, SSE_TYPE, successStream().toByteArray(Charsets.UTF_8))
                return
            }
            createScriptDone = true
            CarrierHTTP.respond(
                out, 200, SSE_TYPE, createStream().toByteArray(Charsets.UTF_8))
            return
        }
        val body = if (parity) {
            when (parityCounter.incrementAndGet()) {
                1, 3 -> successStream()
                2 -> toolCallStream()
                else -> return mockAuthError(out)
            }
        } else {
            successStream()
        }
        if (bodyText.contains("SLOW_TURN")) {
            respondSlowDrip(out, body)
            return
        }
        // One Content-Length response: the transport consumes the SSE bytes
        // from the plain body (no chunked framing needed on loopback).
        CarrierHTTP.respond(out, 200, SSE_TYPE, body.toByteArray(Charsets.UTF_8))
    }

    private const val SSE_TYPE = "text/event-stream; charset=utf-8"

    /** The SLOW_TURN answer: HTTP-legal Content-Length announces the whole
     * body, then it goes out in ~8 slices ~220ms apart on the same
     * connection (the carrier's per-connection thread makes the blocking
     * pacing safe), so the turn is provably mid-stream when the probe
     * presses stop. */
    private fun respondSlowDrip(out: OutputStream, body: String) {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val head = "HTTP/1.1 200 OK\r\nContent-Type: $SSE_TYPE\r\n" +
            "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n"
        val slice = maxOf(1, bytes.size / 8)
        synchronized(out) {
            out.write(head.toByteArray(Charsets.UTF_8))
            out.flush()
            dripSlices(out, bytes, slice)
        }
    }

    /** One drip link: send the next slice, pace, continue from the tail. */
    private tailrec fun dripSlices(out: OutputStream, bytes: ByteArray, slice: Int, at: Int = 0) {
        if (at >= bytes.size) return
        val end = minOf(at + slice, bytes.size)
        out.write(bytes, at, end - at)
        out.flush()
        if (end < bytes.size) Thread.sleep(SLOW_DRIP_INTERVAL_MS)
        dripSlices(out, bytes, slice, end)
    }

    /** The CREATE script's assistant message: TWO tool calls in one turn —
     * `write` creates the deliverable on DISK inside the app scope (its
     * absolute path lands under the workspace the fs views grant), present
     * declares it (the runtime journals deliverables/presented; the client
     * renders the card). Kotlin sibling of the iOS seat's serveCreateScript. */
    private fun createStream(): String {
        val whalePath = "$workspaceRoot/creations/blue-whale.html"
        val writeArgs = JSONObject()
            .put("file_path", whalePath)
            .put("content", whaleHtml())
            .toString()
        val file = JSONObject().put("path", "creations/blue-whale.html")
            .put("description", "游动的蓝色鲸鱼 — 点按全屏查看")
        val presentArgs = JSONObject()
            .put("files", JSONArray().put(file))
            .toString()
        val write = toolCallAt(0, "call-create-1",
            callFunction("write", writeArgs))
        val present = toolCallAt(1, "call-present-1",
            callFunction("present", presentArgs))
        val delta = JSONObject()
            .put("tool_calls", JSONArray().put(write).put(present))
        val both = choices(choice(delta, JSONObject.NULL))
        val terminal = choices(choice(JSONObject().put("content", ""), "stop"))
            .put("usage", JSONObject().put("prompt_tokens", 3).put("completion_tokens", 12))
        return sse(both) + sse(terminal) + "data: [DONE]\n\n"
    }

    /** The deliverable's own content (the staged canary proves the viewer
     * served the file, not a placeholder). */
    private fun whaleHtml(): String =
        "<!doctype html><title>蓝色鲸鱼</title>" +
            "<style>body{margin:0;background:#0a2a52;overflow:hidden;height:100dvh}" +
            "#w{font-size:120px;position:absolute;top:38%;left:-140px;" +
            "animation:swim 8s linear infinite}" +
            "</style><!--BLUE-WHALE-CANARY--><div id=w>🐋</div>"

    /** The vendored mock's `tool_call_success` behavior, wire-for-wire: the
     * tool-call identity on the first delta, the arguments split at the
     * midpoint across two deltas, terminal chunk finish_reason=tool_calls
     * with usage, then [DONE]. */
    private fun toolCallStream(): String {
        val midpoint = maxOf(1, PARITY_TOOL_ARGUMENTS.length / 2)
        val firstFunction = callFunction(PARITY_TOOL_NAME, PARITY_TOOL_ARGUMENTS.substring(0, midpoint))
        val firstCall = toolCall(id = "mock-call-1", function = firstFunction)
        val first = choices(choice(deltaToolCalls(firstCall), JSONObject.NULL))
        val secondFunction = callFunction(null, PARITY_TOOL_ARGUMENTS.substring(midpoint))
        val secondCall = toolCall(id = null, function = secondFunction)
        val second = choices(choice(deltaToolCalls(secondCall), JSONObject.NULL))
        val terminalChoice = choice(JSONObject().put("content", ""), "tool_calls")
        val terminal = choices(terminalChoice)
            .put("usage", JSONObject().put("prompt_tokens", 3).put("completion_tokens", 2))
        return sse(first) + sse(second) + sse(terminal) + "data: [DONE]\n\n"
    }

    /** The `choices` array wrapper every wire chunk carries (one entry). */
    private fun choices(choice: JSONObject): JSONObject =
        JSONObject().put("choices", JSONArray().put(choice))

    /** One wire `function` object; the name rides only the first delta. */
    private fun callFunction(name: String?, arguments: String): JSONObject {
        val function = JSONObject().put("arguments", arguments)
        if (name != null) function.put("name", name)
        return function
    }

    /** One wire `tool_calls[<index>]` entry; the identity rides only the
     * first delta of that index. The INDEX is load-bearing when one delta
     * carries SEVERAL calls (the create script's write+present pair): the
     * streaming parser merges entries by it — two zero-indexed calls merge
     * into one misnamed call (measured: present executed with write's
     * arguments). */
    private fun toolCallAt(index: Int, id: String?, function: JSONObject): JSONObject {
        val call = JSONObject().put("index", index)
        if (id != null) {
            call.put("id", id)
            call.put("type", "function")
        }
        return call.put("function", function)
    }

    /** One wire `tool_calls[0]` entry (the parity script's single-call
     * shape; the identity rides only the first delta). */
    private fun toolCall(id: String?, function: JSONObject): JSONObject =
        toolCallAt(0, id, function)

    private fun deltaToolCalls(call: JSONObject): JSONObject =
        JSONObject().put("tool_calls", JSONArray().put(call))

    private fun choice(delta: JSONObject, finishReason: Any): JSONObject =
        JSONObject().put("index", 0).put("delta", delta).put("finish_reason", finishReason)

    /** The vendored mock's fixed 401 leg: JSON error body, provider shape. */
    private fun mockAuthError(out: OutputStream) {
        val body = JSONObject().put(
            "error",
            JSONObject()
                .put("message", "mock authentication failed")
                .put("type", "mock_error")
                .put("code", "invalid_api_key"),
        )
        CarrierHTTP.respond(
            out, 401, "application/json",
            body.toString().toByteArray(Charsets.UTF_8),
        )
    }

    /** The success script: 5-char content deltas, then the terminal chunk
     * with finish_reason + usage, then [DONE]. */
    private fun successStream(): String {
        val body = StringBuilder()
        var at = 0
        while (at < SUCCESS_TEXT.length) {
            val end = minOf(at + CHUNK_SIZE, SUCCESS_TEXT.length)
            body.append(sse(deltaChunk(SUCCESS_TEXT.substring(at, end))))
            at = end
        }
        body.append(sse(terminalChunk()))
        body.append("data: [DONE]\n\n")
        return body.toString()
    }

    /** One streaming choice: `delta.content` = [text], no finish reason. */
    private fun deltaChunk(text: String): JSONObject = JSONObject().put(
        "choices",
        JSONArray().put(
            JSONObject()
                .put("index", 0)
                .put("delta", JSONObject().put("content", text))
                .put("finish_reason", JSONObject.NULL),
        ),
    )

    /** The terminal choice: empty delta, finish_reason stop, fixed usage. */
    private fun terminalChunk(): JSONObject {
        val choice = JSONObject()
            .put("index", 0)
            .put("delta", JSONObject().put("content", ""))
            .put("finish_reason", "stop")
        val usage = JSONObject()
            .put("prompt_tokens", 3)
            .put("completion_tokens", SUCCESS_TEXT.length)
        return JSONObject().put("choices", JSONArray().put(choice)).put("usage", usage)
    }

    /** One `data: <json>\n\n` SSE record (compact, provider shape). */
    private fun sse(payload: JSONObject): String = "data: $payload\n\n"
}
