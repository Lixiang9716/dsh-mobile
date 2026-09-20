package com.dshmobile.spike

import android.util.Log
import java.io.BufferedOutputStream
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
 * of NWListener; SHA-1 accept via MessageDigest instead of CryptoKit).
 * Transport + route dispatch only, never JS — crossings hop through the
 * callbacks. Routes: registered exact/prefix handlers, one fallback seat
 * (official dist when the web session registers it, the legacy static root
 * otherwise), and per-path WS upgrades (`/ws` legacy, `/api/remote.mux`).
 * All state is guarded by [lock]; `send` is safe from any thread. Accept +
 * per-connection threads never touch the JS runtime (AGENTS.md rule 2: only
 * SpikeRuntime's HandlerThread does).
 */
class CarrierServer {
    companion object {
        const val WS_PATH = "/ws"
        const val COOKIE_NAME = "dsh.session"
        private const val WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        private const val TAG = "dsh.spike"
        private const val MAX_BODY = 2 * 1024 * 1024
    }

    /** Legacy single-seat hooks (the m2/m4 wiring; `/ws` seats only). */
    var onWSMessage: ((String) -> Unit)? = null
    var onStaticServed: ((String) -> Unit)? = null
    var onWSClosed: (() -> Unit)? = null
    /** Per-seat frame hook (the API bridge filters to its own mux path). */
    var onWSFrame: ((String, String) -> Unit)? = null

    @Volatile var port: Int = 0
        private set

    private val lock = Object()
    private var webRoot: File = File("/nonexistent")
    private val servedPaths = ArrayList<String>()
    private val seats = HashMap<String, OutputStream>()
    private val exactRoutes = HashMap<String, (CarrierRequest, OutputStream) -> Unit>()
    private val prefixRoutes = HashMap<String, (CarrierRequest, OutputStream) -> Unit>()
    private var fallback: ((CarrierRequest, OutputStream) -> Unit)? = null
    private val upgrades = HashMap<String, (CarrierRequest) -> CarrierUpgradePlan>()
    private val running = AtomicBoolean(false)
    private val acceptThread = Thread({ acceptLoop() }, "dsh-carrier-accept")

    /** Binds 127.0.0.1 on an ephemeral port; [onReady] fires once it is known. */
    fun start(webRoot: File, onReady: () -> Unit) {
        this.webRoot = webRoot
        // The legacy `/ws` page seat is always available (the m2/m4 wiring);
        // a session may override it with its own handler before start.
        synchronized(lock) { upgrades.putIfAbsent(WS_PATH) { CarrierUpgradePlan.Accept } }
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

    /** Registers an HTTP handler before [start]; duplicates fail loud. */
    fun register(kind: CarrierRouteKind, path: String, handler: (CarrierRequest, OutputStream) -> Unit) {
        synchronized(lock) {
            val table = if (kind == CarrierRouteKind.EXACT) exactRoutes else prefixRoutes
            check(table.put(path, handler) == null) { "route already registered: $path" }
        }
    }

    /** Registers the fallback seat (must be set before [start]). */
    fun registerFallback(handler: (CarrierRequest, OutputStream) -> Unit) {
        synchronized(lock) { check(fallback == null) { "fallback already registered" } }
        fallback = handler
    }

    /** Registers a WebSocket upgrade handler for one exact path. */
    fun registerUpgrade(path: String, handler: (CarrierRequest) -> CarrierUpgradePlan) {
        synchronized(lock) { check(upgrades.put(path, handler) == null) { "upgrade registered twice: $path" } }
    }

    fun stop() {
        running.set(false)
        try {
            acceptThread.interrupt()
        } catch (_: Exception) {}
        synchronized(lock) {
            for (seat in seats.values) try { seat.close() } catch (_: Exception) {}
            seats.clear()
        }
    }

    /** Sends one WS text frame to the seat opened on [path] (no-op when closed). */
    fun send(text: String, path: String) {
        val out = synchronized(lock) { seats[path] } ?: return
        synchronized(out) {
            try {
                out.write(frame(0x1, text.toByteArray(Charsets.UTF_8)))
                out.flush()
            } catch (e: Exception) {
                Log.i(TAG, "carrier ws send failed: ${e.message}")
            }
        }
    }

    /** Legacy single-seat send (the m2/m4 `/ws` page). */
    fun send(text: String) = send(text, WS_PATH)

    /** Paths served with 200 so far, in serving order (legacy evidence). */
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
                val lines = head.split("\r\n")
                val parts = lines.first().split(" ")
                if (parts.size < 2) error("malformed request line")
                val target = parts[1]
                val rawPath = target.substringBefore('?')
                val query = if (target.contains('?')) target.substringAfter('?') else null
                val request = buildRequest(parts[0], rawPath, query, lines.drop(1), input)
                dispatch(request, input, conn.getOutputStream())
            }
        } catch (_: Exception) {}
        try {
            conn.close()
        } catch (_: Exception) {}
    }

    /** Parses headers + a Content-Length body into the request facts. */
    private fun buildRequest(
        method: String,
        rawPath: String,
        query: String?,
        headerLines: List<String>,
        input: InputStream,
    ): CarrierRequest {
        val headers = HashMap<String, String>()
        for (line in headerLines) {
            val at = line.indexOf(':')
            if (at <= 0) continue
            headers.putIfAbsent(line.substring(0, at).trim().lowercase(), line.substring(at + 1).trim())
        }
        val length = headers["content-length"]?.toIntOrNull() ?: 0
        var body = ByteArray(0)
        if (length > 0) {
            check(length <= MAX_BODY) { "request body exceeds carrier cap" }
            body = ByteArray(length)
            var read = 0
            while (read < length) {
                val n = input.read(body, read, length - read)
                if (n < 0) error("peer closed during request body")
                read += n
            }
        }
        return CarrierRequest(
            method = method,
            path = CarrierRequest.percentDecode(rawPath),
            rawPath = rawPath,
            query = query,
            headers = headers,
            body = body,
        )
    }

    /** Upgrades first (exact path), then exact → prefix (longest first) →
     * fallback (registered seat, else the legacy static root). */
    private fun dispatch(request: CarrierRequest, input: InputStream, out: OutputStream) {
        val upgrade = synchronized(lock) { upgrades[request.rawPath] }
        if (upgrade != null && request.header("upgrade")?.lowercase() == "websocket") {
            when (val plan = upgrade(request)) {
                is CarrierUpgradePlan.Accept -> upgradeSeat(request.rawPath, request, input, out)
                is CarrierUpgradePlan.Reject -> respond(out, plan.status, "text/plain", ByteArray(0))
                CarrierUpgradePlan.Destroy -> {}
            }
            return
        }
        val handler = synchronized(lock) {
            exactRoutes[request.rawPath] ?: longestPrefix(request.rawPath)
        }
        if (handler != null) return handler(request, out)
        val seat = synchronized(lock) { fallback }
        if (seat != null) return seat(request, out)
        serveLegacy(request, out)
    }

    /** The longest registered prefix route covering [path] (§1.2: `p` and
     * `p/<anything>`); callers hold [lock] (it reads the route table). */
    private fun longestPrefix(path: String): ((CarrierRequest, OutputStream) -> Unit)? {
        val key = prefixRoutes.keys
            .filter { path == it || path.startsWith("$it/") }
            .maxByOrNull { it.length } ?: return null
        return prefixRoutes[key]
    }

    /** The pre-official static behavior, byte-compatible with the m2/m3
     * manifests: `..`-checked root-relative `.html`/`.js` files, `/` →
     * `/index.html`, the /gateway-e2e chunked streams, 404 otherwise. */
    private fun serveLegacy(request: CarrierRequest, out: OutputStream) {
        val path = request.rawPath
        if (path == "/gateway-e2e/bytes") {
            recordServed(path)
            return chunked(out, 32, 2, 40)
        }
        if (path == "/gateway-e2e/slow") {
            recordServed(path)
            return chunked(out, 16, 6, 300)
        }
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

    // ---- responses ------------------------------------------------------------

    /** One Content-Length response with optional extra headers, then close. */
    fun respond(
        out: OutputStream,
        status: Int,
        type: String,
        body: ByteArray,
        headers: Map<String, String> = emptyMap(),
        bodyless: Boolean = false,
    ) = CarrierHTTP.respond(out, status, type, body, headers, bodyless)

    private fun recordServed(path: String) = synchronized(lock) { servedPaths.add(path) }

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

    // ---- websocket (RFC6455, text frames, masked client side) ---------------

    /** Completes the handshake and opens a named seat for [path]. */
    private fun upgradeSeat(
        path: String,
        request: CarrierRequest,
        input: InputStream,
        rawOut: OutputStream,
    ) {
        val accept = wsAccept(request.header("sec-websocket-key") ?: error("missing Sec-WebSocket-Key"))
        val head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
            "Connection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n"
        val buffered = BufferedOutputStream(rawOut)
        synchronized(lock) {
            seats[path]?.let { try { it.close() } catch (_: Exception) {} } // one seat per path
            seats[path] = buffered
        }
        buffered.write(head.toByteArray(Charsets.UTF_8))
        buffered.flush()
        drainWsFrames(path, input, buffered)
        synchronized(lock) {
            if (seats[path] === buffered) seats.remove(path)
        }
        onWSClosed?.invoke()
    }

    private fun wsAccept(key: String): String {
        val digest = MessageDigest.getInstance("SHA-1")
            .digest((key + WS_MAGIC).toByteArray(Charsets.UTF_8))
        return Base64.getEncoder().encodeToString(digest)
    }

    private fun drainWsFrames(path: String, input: InputStream, out: OutputStream) {
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
                if (handleFrame(path, next, out)) return
            }
        }
    }

    /** Handles one parsed frame; returns true when the connection ends. */
    private fun handleFrame(path: String, frame: WsFrame, out: OutputStream): Boolean {
        when (frame.opcode) {
            1 -> {
                val text = String(frame.payload, Charsets.UTF_8)
                onWSFrame?.invoke(text, path)
                if (path == WS_PATH) onWSMessage?.invoke(text)
            }
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
