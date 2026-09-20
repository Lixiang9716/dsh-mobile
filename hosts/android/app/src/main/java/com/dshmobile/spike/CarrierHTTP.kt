package com.dshmobile.spike

import java.io.OutputStream

/**
 * Response-writing helpers shared by the carrier's route handlers — the
 * transport face of hosts/ios CarrierServer.respond, hoisted so the seat
 * objects never need a server instance (transport only, no state).
 */
object CarrierHTTP {
    /** One Content-Length response with optional extra headers, then close. */
    fun respond(
        out: OutputStream,
        status: Int,
        type: String,
        body: ByteArray,
        headers: Map<String, String> = emptyMap(),
        bodyless: Boolean = false,
    ) {
        val head = StringBuilder("HTTP/1.1 $status ${reason(status)}\r\nContent-Type: $type\r\n")
            .append("Content-Length: ${body.size}\r\n")
        for ((name, value) in headers) head.append("$name: $value\r\n")
        head.append("Connection: close\r\n\r\n")
        synchronized(out) {
            out.write(head.toString().toByteArray(Charsets.UTF_8))
            if (!bodyless) out.write(body)
            out.flush()
        }
    }

    fun reason(status: Int) = when (status) {
        200 -> "OK"
        303 -> "See Other"
        400 -> "Bad Request"
        401 -> "Unauthorized"
        403 -> "Forbidden"
        404 -> "Not Found"
        405 -> "Method Not Allowed"
        else -> "Error"
    }
}
