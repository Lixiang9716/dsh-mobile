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
 * record. The drive chooses the success script unconditionally; script
 * sequences (auth_error et al.) stay the CLI mock's territory. Kotlin
 * sibling of hosts/ios CarrierRoutes.swift's scripted-llm route.
 */
object MockLlmRoute {

    const val PATH = "/mock-llm/chat/completions"
    const val KEY = "mock-key-0001"

    private const val SUCCESS_TEXT = "Hello from upstream"
    private const val CHUNK_SIZE = 5

    /** The parity script mirrors the node-side drive exactly
     * (ci/run-upstream-parity.sh): success, tool_call_success (todo_write
     * with schema-valid arguments, split mid-arguments like the vendored
     * mock), closing success, then auth_error forever. */
    private const val PARITY_TOOL_NAME = "todo_write"
    private const val PARITY_TOOL_ARGUMENTS =
        """{"todos":[{"content":"Track the parity check","status":"in_progress"}]}"""

    @Volatile private var parity = false
    private val parityCounter = java.util.concurrent.atomic.AtomicInteger()

    /** Arm the parity script (the upstream-parity drive does; every other
     * drive keeps the unconditional success stream). */
    fun enableParityScript() {
        parity = true
        parityCounter.set(0)
    }

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
        val body = if (parity) {
            when (parityCounter.incrementAndGet()) {
                1, 3 -> successStream()
                2 -> toolCallStream()
                else -> return mockAuthError(out)
            }
        } else {
            successStream()
        }
        // One Content-Length response: the transport consumes the SSE bytes
        // from the plain body (no chunked framing needed on loopback).
        CarrierHTTP.respond(
            out, 200, "text/event-stream; charset=utf-8",
            body.toByteArray(Charsets.UTF_8),
        )
    }

    /** The vendored mock's `tool_call_success` behavior, wire-for-wire: the
     * tool-call identity on the first delta, the arguments split at the
     * midpoint across two deltas, terminal chunk finish_reason=tool_calls
     * with usage, then [DONE]. */
    private fun toolCallStream(): String {
        val midpoint = maxOf(1, PARITY_TOOL_ARGUMENTS.length / 2)
        val firstFunction = callFunction(PARITY_TOOL_NAME, PARITY_TOOL_ARGUMENTS.substring(0, midpoint))
        val firstCall = toolCall(id = "mock-call-1", function = firstFunction)
        val first = choice(deltaToolCalls(firstCall), JSONObject.NULL)
        val secondFunction = callFunction(null, PARITY_TOOL_ARGUMENTS.substring(midpoint))
        val secondCall = toolCall(id = null, function = secondFunction)
        val second = choice(deltaToolCalls(secondCall), JSONObject.NULL)
        val terminal = choice(JSONObject().put("content", ""), "tool_calls")
            .put("usage", JSONObject().put("prompt_tokens", 3).put("completion_tokens", 2))
        return sse(first) + sse(second) + sse(terminal) + "data: [DONE]\n\n"
    }

    /** One wire `function` object; the name rides only the first delta. */
    private fun callFunction(name: String?, arguments: String): JSONObject {
        val function = JSONObject().put("arguments", arguments)
        if (name != null) function.put("name", name)
        return function
    }

    /** One wire `tool_calls[0]` entry; the identity rides only the first delta. */
    private fun toolCall(id: String?, function: JSONObject): JSONObject {
        val call = JSONObject().put("index", 0)
        if (id != null) {
            call.put("id", id)
            call.put("type", "function")
        }
        return call.put("function", function)
    }

    private fun deltaToolCalls(call: JSONObject): JSONObject =
        JSONObject().put("tool_calls", JSONArray().put(call))

    private fun choice(delta: JSONObject, finishReason: Any): JSONObject =
        JSONObject().put("index", 0).put("delta", delta).put("finish_reason", finishReason)

    /** One `data: <json>\n\n` SSE record (compact, provider shape). */
    private fun sse(payload: JSONObject): String = "data: $payload\n\n"
}
