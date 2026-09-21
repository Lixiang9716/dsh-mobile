package com.dshmobile.spike

import java.io.OutputStream
import org.json.JSONArray
import org.json.JSONObject

/**
 * POST /mock-llm/chat/completions — the SCRIPTED model boundary of the
 * on-device session-live drive (b-android.session.live): a real loopback
 * HTTP + SSE endpoint on the carrier whose script mirrors the vendored
 * dsh-llm-mock-server's success stream byte-for-byte (successText
 * 'Hello from upstream', chunkSize 5, terminal chunk with finish_reason +
 * usage, [DONE]) and its fixed bearer check (401 JSON on a bad key). Real
 * transport, scripted model — logged as such by the scenario's llm/runtime
 * record. The drive chooses the success script unconditionally; script
 * sequences (auth_error et al.) stay the CLI mock's territory. Kotlin
 * sibling of hosts/ios CarrierRoutes.swift's scripted-llm route.
 */
object MockLlmRoute {

    const val PATH = "/mock-llm/chat/completions"
    const val KEY = "mock-key-0001"

    private const val SUCCESS_TEXT = "Hello from upstream"
    private const val CHUNK_SIZE = 5

    /** Carrier thread: one scripted chat-completions response, then close. */
    fun serve(request: CarrierRequest, out: OutputStream) {
        if (request.method != "POST") {
            CarrierHTTP.respond(out, 405, "text/plain", ByteArray(0))
            return
        }
        if (request.header("authorization") != "Bearer $KEY") {
            mockAuthError(out)
            return
        }
        // One Content-Length response: the transport consumes the SSE bytes
        // from the plain body (no chunked framing needed on loopback).
        CarrierHTTP.respond(
            out, 200, "text/event-stream; charset=utf-8",
            successStream().toByteArray(Charsets.UTF_8),
        )
    }

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
