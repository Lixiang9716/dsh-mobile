package com.dshmobile.spike

import android.util.Log
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.atomic.AtomicBoolean

/**
 * One loopback HTTP + WebSocket endpoint (RFC6455, text frames only) — the
 * Kotlin sibling of hosts/ios CarrierServer.swift (raw ServerSocket instead
 * of NWListener; SHA-1 accept via MessageDigest instead of CryptoKit). Serves
 * a static web root and upgrades GET /ws to a raw WS connection; transport
 * only, never touches JS — crossings hop through the callbacks. All state is
 * guarded by [lock]; `send` is safe from any thread. Accept + per-connection
 * threads never touch the JS runtime (AGENTS.md rule 2: only SpikeRuntime's
 * HandlerThread does).
 */
class CarrierServer {
    companion object {
        const val WS_PATH = "/ws"
        private const val WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        private const val TAG = "dsh.spike"
    }

    var onWSMessage: ((String) -> Unit)? = null
    var onStaticServed: ((String) -> Unit)? = null
    var onWSClosed: (() -> Unit)? = null

    @Volatile var port: Int = 0
        private set

    private val lock = Object()
    private var webRoot: File = File("/nonexistent")
    private val servedPaths = ArrayList<String>()
    private var wsOut: OutputStream? = null
    private val running = AtomicBoolean(false)
    private val acceptThread = Thread({ acceptLoop() }, "dsh-carrier-accept")

    /** Binds 127.0.0.1 on an ephemeral port; [onReady] fires once it is known. */
    fun start(webRoot: File, onReady: () -> Unit) {
        this.webRoot = webRoot
        running.set(true)
        acceptThread.isDaemon = true
        acceptThread.start()
        // The accept loop binds before its first accept; poll the port with a
        // deadline instead of sleeping (rules.md rule 8).
        val deadline = System.currentTimeMillis() + 5000
        while (port == 0) {
            if (System.currentTimeMillis() > deadline || !running.get()) {
                error("carrier server did not bind within 5s")
            }
            Thread.sleep(5)
        }
        onReady()
    }

    fun stop() {
        running.set(false)
        try {
            acceptThread.interrupt()
        } catch (_: Exception) {}
        synchronized(lock) {
            try {
                wsOut?.close()
            } catch (_: Exception) {}
            wsOut = null
        }
    }

    /** Sends one WS text frame to the connected page (no-op while closed). */
    fun send(text: String) {
        val out = synchronized(lock) { wsOut } ?: return
        synchronized(out) {
            try {
                out.write(frame(0x1, text.toByteArray(Charsets.UTF_8)))
                out.flush()
            } catch (e: Exception) {
                Log.i(TAG, "carrier ws send failed: ${e.message}")
            }
        }
    }

    /** Paths served with 200 so far, in serving order. */
    fun servedList(): List<String> = synchronized(lock) { servedPaths.toList() }

    // ---- accept / connection plumbing --------------------------------------

    private fun acceptLoop() {
        val server = try {
            ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"))
        } catch (e: Exception) {
            Log.i(TAG, "carrier bind failed: $e")
            return
        }
        port = server.localPort
        while (running.get()) {
            val conn = try {
                server.accept()
            } catch (_: Exception) {
                break
            }
            Thread({ serve(conn) }, "dsh-carrier-conn").apply {
                isDaemon = true
                start()
            }
        }
        try {
            server.close()
        } catch (_: Exception) {}
    }

    private fun serve(conn: Socket) {
        conn.tcpNoDelay = true
        try {
            conn.getInputStream().use { input ->
                val head = readHead(input)
                val parts = head.split("\r\n").first().split(" ")
                if (parts.size < 2 || parts[0] != "GET") error("GET only")
                val path = parts[1].substringBefore('?')
                if (path == WS_PATH) {
                    upgrade(headerValue(head, "Sec-WebSocket-Key"), input, conn.getOutputStream())
                } else {
                    serveGet(path, input, conn.getOutputStream())
                }
            }
        } catch (_: Exception) {}
        try {
            conn.close()
        } catch (_: Exception) {}
    }

    /** Reads one request head (through the blank line). */
    private fun readHead(input: InputStream): String {
        val head = StringBuilder()
        val buf = ByteArray(1)
        while (!(head.length >= 4 && head.endsWith("\r\n\r\n"))) {
            val n = input.read(buf)
            if (n < 0) error("peer closed during request head")
            head.append(String(buf, 0, n, Charsets.UTF_8))
        }
        return head.toString()
    }

    private fun headerValue(head: String, name: String): String? =
        head.split("\r\n")
            .filter { it.contains(':') }
            .filter { it.split(":", limit = 2)[0].trim().equals(name, true) }
            .map { it.split(":", limit = 2)[1].trim() }
            .firstOrNull()

    // ---- static files + gateway-e2e chunked streams -------------------------

    private fun serveGet(path: String, input: InputStream, out: OutputStream) {
        if (path == "/gateway-e2e/bytes") return chunked(out, 32, 2, 40)
        if (path == "/gateway-e2e/slow") return chunked(out, 16, 6, 300)
        val rel = if (path == "/") "/index.html" else path
        if (rel.contains("..") || !(rel.endsWith(".html") || rel.endsWith(".js"))) {
            return respond(out, 404, "text/plain", "not found".toByteArray())
        }
        val file = File(webRoot, rel.removePrefix("/"))
        if (!file.isFile) return respond(out, 404, "text/plain", "not found".toByteArray())
        recordServed(path)
        onStaticServed?.invoke(path)
        val type = if (rel.endsWith(".html")) "text/html" else "text/javascript"
        respond(out, 200, type, file.readBytes())
    }

    /** HTTP/1.1 chunked stream of deterministic ASCII, Connection: close. */
    private fun chunked(out: OutputStream, chunkBytes: Int, count: Int, intervalMs: Long) {
        val head = "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n" +
            "Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
        out.write(head.toByteArray(Charsets.UTF_8))
        out.flush()
        val unit = "0123456789abcdef".toByteArray()
        val chunk = ByteArray(chunkBytes) { unit[it % unit.size] }
        for (i in 0 until count) {
            if (i > 0) Thread.sleep(intervalMs) // paces real chunk physics
            out.write("%x\r\n".format(chunk.size).toByteArray())
            out.write(chunk)
            out.write("\r\n".toByteArray())
            out.flush()
        }
        out.write("0\r\n\r\n".toByteArray())
        out.flush()
    }

    private fun respond(out: OutputStream, status: Int, type: String, body: ByteArray) {
        val reason = if (status == 200) "OK" else "Error"
        val head = "HTTP/1.1 $status $reason\r\nContent-Type: $type\r\n" +
            "Content-Length: ${body.size}\r\nConnection: close\r\n\r\n"
        out.write(head.toByteArray(Charsets.UTF_8))
        out.write(body)
        out.flush()
    }

    private fun recordServed(path: String) = synchronized(lock) { servedPaths.add(path) }

    // ---- websocket (RFC6455, text frames, masked client side) ---------------

    private fun upgrade(key: String?, input: InputStream, out: OutputStream) {
        val accept = wsAccept(key ?: error("missing Sec-WebSocket-Key"))
        val head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
            "Connection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n"
        val buffered = java.io.BufferedOutputStream(out)
        synchronized(lock) {
            wsOut?.let { try { it.close() } catch (_: Exception) {} } // one page at a time
            wsOut = buffered
        }
        buffered.write(head.toByteArray(Charsets.UTF_8))
        buffered.flush()
        drainWsFrames(input, buffered)
        synchronized(lock) {
            if (wsOut === buffered) wsOut = null
        }
        onWSClosed?.invoke()
    }

    private fun wsAccept(key: String): String {
        val digest = MessageDigest.getInstance("SHA-1")
            .digest((key + WS_MAGIC).toByteArray(Charsets.UTF_8))
        return Base64.getEncoder().encodeToString(digest)
    }

    private fun drainWsFrames(input: InputStream, out: OutputStream) {
        val rx = ArrayList<Byte>()
        val buf = ByteArray(4096)
        while (running.get()) {
            val n = try {
                input.read(buf)
            } catch (_: Exception) {
                return
            }
            if (n < 0) return
            for (i in 0 until n) rx.add(buf[i])
            while (true) {
                val next = parseFrame(rx) ?: break
                repeat(next.consumed) { rx.removeAt(0) }
                if (handleFrame(next, out)) return
            }
        }
    }

    /** Handles one parsed frame; returns true when the connection ends. */
    private fun handleFrame(frame: WsFrame, out: OutputStream): Boolean {
        when (frame.opcode) {
            1 -> onWSMessage?.invoke(String(frame.payload, Charsets.UTF_8))
            8 -> { // close → echo close, then end this connection
                sendAll(out, frame(0x8, ByteArray(0)))
                return true
            }
            9 -> sendAll(out, frame(0xA, frame.payload)) // ping → pong
        }
        return false
    }

    private fun sendAll(out: OutputStream, bytes: ByteArray) {
        synchronized(out) {
            try {
                out.write(bytes)
                out.flush()
            } catch (_: Exception) {}
        }
    }

    /** RFC6455 server-side frame parse (client frames are masked). */
    private fun parseFrame(buf: List<Byte>): WsFrame? {
        if (buf.size < 2) return null
        val opcode = buf[0].toInt() and 0x0F
        val masked = buf[1].toInt() and 0x80 != 0
        var length = buf[1].toInt() and 0x7F
        var offset = 2
        if (length == 126) {
            if (buf.size < 4) return null
            length = (buf[2].toInt() and 0xFF) shl 8 or (buf[3].toInt() and 0xFF)
            offset = 4
        } else if (length == 127) {
            if (buf.size < 10) return null
            length = 0
            for (i in 2..9) length = length shl 8 or (buf[i].toInt() and 0xFF)
            offset = 10
        }
        var mask = IntArray(0)
        if (masked) {
            if (buf.size < offset + 4) return null
            mask = IntArray(4) { buf[offset + it].toInt() and 0xFF }
            offset += 4
        }
        if (buf.size < offset + length) return null
        val payload = ByteArray(length)
        for (i in 0 until length) {
            val raw = buf[offset + i].toInt() and 0xFF
            payload[i] = (if (masked) raw xor mask[i % 4] else raw).toByte()
        }
        return WsFrame(opcode, payload, offset + length)
    }

    private fun frame(opcode: Int, payload: ByteArray): ByteArray {
        val out = ArrayList<Byte>()
        out.add((0x80 or opcode).toByte())
        if (payload.size < 126) {
            out.add(payload.size.toByte())
        } else {
            out.add(126.toByte())
            out.add((payload.size shr 8).toByte())
            out.add((payload.size and 0xFF).toByte())
        }
        for (b in payload) out.add(b)
        return out.toByteArray()
    }

    private data class WsFrame(val opcode: Int, val payload: ByteArray, val consumed: Int)
}
