package com.dshmobile.spike

import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

/**
 * httpFetch (contract/primitives.md §4) over HttpURLConnection — Kotlin
 * sibling of hosts/ios Gateway/HTTPPrimitive.swift. The call settles
 * `{status, headers, bodyId: "body:<callId>"}` when response HEADERS arrive;
 * the body then streams as gateway events — `http.body` chunks (≤16 KB
 * base64) and a final `http.end` — never a blocking whole-result (D8).
 * Failures after the settle ride `http.error` with a GatewayError code
 * (cancelled / network); failures before headers settle the call itself.
 * Abort closes the connection → stream error code `cancelled`. Each fetch
 * runs on its own worker thread (never the JS runtime thread).
 */
class HttpPrimitive {

    companion object {
        const val CHUNK_LIMIT = 16 * 1024
        const val BODY_PREFIX = "body:"
        private const val TAG = "dsh.spike"
    }

    private val tasks = ConcurrentHashMap<Int, HttpURLConnection>()
    private val aborted = java.util.concurrent.ConcurrentHashMap.newKeySet<Long>()
    private val coreTag = TAG

    fun register(on: GatewayCore) {
        on.register("httpFetch") { call, done -> fetch(call, done) }
        on.register("httpFetch.abort") { call, _ -> abort(call) }
    }

    private fun fetch(call: GatewayCore.GatewayCall, done: GatewayCore.Done) {
        val urlText = call.string("url")
            ?: return done.settle(null, err("invalid", "malformed url"))
        val callId = call.callId
        Thread({ openAndStream(callId, call, done) }, "dsh-httpfetch-$callId").apply {
            isDaemon = true
            start()
        }
    }

    /** Worker thread: open → settle at headers → stream the body. */
    private fun openAndStream(
        callId: Int,
        call: GatewayCore.GatewayCall,
        done: GatewayCore.Done,
    ) {
        val conn = open(callId, call, done) ?: return
        tasks[callId] = conn
        try {
            settleHeaders(callId, conn, done)
            streamBody(callId, conn)
        } catch (e: Exception) {
            finishFailed(callId, conn, done, e)
        }
    }

    /** Connects and configures the request; settles `network` on failure. */
    private fun open(
        callId: Int,
        call: GatewayCore.GatewayCall,
        done: GatewayCore.Done,
    ): HttpURLConnection? {
        return try {
            configure(URL(call.string("url")), call)
        } catch (e: Exception) {
            Log.i(coreTag, "httpFetch connect failed: ${e.message}")
            aborted.remove(callId.toLong())
            done.settle(null, err("network", "${e.message}"))
            null
        }
    }

    private fun configure(url: URL, call: GatewayCore.GatewayCall): HttpURLConnection {
        val conn = url.openConnection() as HttpURLConnection
        conn.requestMethod = call.string("method") ?: "GET"
        requestHeaders(call, conn)
        val bodyB64 = call.args.optString("bodyB64", "")
        if (bodyB64.isNotEmpty()) {
            conn.doOutput = true
            conn.getOutputStream().use {
                it.write(Base64.getDecoder().decode(bodyB64))
            }
        }
        conn.connectTimeout = 10_000
        conn.readTimeout = 15_000
        return conn
    }

    private fun requestHeaders(call: GatewayCore.GatewayCall, conn: HttpURLConnection) {
        call.args.optJSONObject("headers")?.let { headers ->
            headers.keys().forEach { key ->
                conn.setRequestProperty(key, headers.getString(key))
            }
        }
    }

    /** The fetch settles at headers; the body streams as events. */
    private fun settleHeaders(
        callId: Int,
        conn: HttpURLConnection,
        done: GatewayCore.Done,
    ) {
        val status = conn.responseCode
        val headers = responseHeaders(conn)
        done.settle(
            JSONObject()
                .put("status", status)
                .put("headers", headers)
                .put("bodyId", BODY_PREFIX + callId),
            null,
        )
    }

    private fun responseHeaders(conn: HttpURLConnection): JSONObject {
        val headers = JSONObject()
        for ((field, values) in conn.headerFields) {
            if (field == null) continue
            val first = values?.firstOrNull() ?: continue
            headers.put(field, first)
        }
        return headers
    }

    /** Streams the body as http.body/http.end events (post-settle). Error
     * statuses carry their body on the ERROR stream — HttpURLConnection
     * throws on `inputStream` for >=400, which would drop provider error
     * bodies entirely (the upstream LLM adapter diagnoses from them:
     * contract §4, the body is readable on any settled response). */
    private fun streamBody(callId: Int, conn: HttpURLConnection) {
        try {
            val status = conn.responseCode
            val source = if (status >= 400) conn.errorStream else conn.inputStream
            if (source != null) pumpChunks(callId, source)
            emit(JSONObject().put("event", "http.end").put("callId", callId))
        } catch (e: Exception) {
            emit(streamError(callId, e))
        } finally {
            tasks.remove(callId)
            conn.disconnect()
        }
    }

    private fun streamError(callId: Int, e: Exception): JSONObject {
        val code = if (aborted.remove(callId.toLong())) "cancelled" else "network"
        return JSONObject().put("event", "http.error").put("callId", callId)
            .put("code", code)
            .put("message", "${e.message}")
    }

    private fun pumpChunks(callId: Int, input: java.io.InputStream) {
        val chunk = ByteArray(CHUNK_LIMIT)
        while (true) {
            val n = input.read(chunk)
            if (n < 0) break
            val slice = chunk.copyOf(n)
            emit(
                JSONObject()
                    .put("event", "http.body")
                    .put("callId", callId)
                    .put("chunkB64", Base64.getEncoder().encodeToString(slice)),
            )
        }
    }

    /** Pre-headers failure: settle the call itself with the mapped code. */
    private fun finishFailed(
        callId: Int,
        conn: HttpURLConnection,
        done: GatewayCore.Done,
        e: Exception,
    ) {
        tasks.remove(callId)
        conn.disconnect()
        val code = if (aborted.remove(callId.toLong())) "cancelled" else "network"
        done.settle(null, err(code, "${e.message}"))
    }

    /** Control-plane abort of the frozen bridge: closes the connection;
     * idempotent (no connection → nothing to cancel). */
    private fun abort(call: GatewayCore.GatewayCall) {
        val target = call.args.optLong("callId", call.callId.toLong())
        aborted.add(target)
        tasks[target.toInt()]?.disconnect()
    }

    private fun err(code: String, message: String) =
        GatewayCore.GatewayError(code, "httpFetch", message)

    private fun emit(obj: JSONObject) {
        // gateway events hop through the same runtime-thread door as settles,
        // via the dedicated event channel wired by the host session.
        eventFn?.invoke(obj.toString())
    }

    /** Wired by the host session; hops onto the runtime thread (JNI). */
    var eventFn: ((json: String) -> Unit)? = null
}
