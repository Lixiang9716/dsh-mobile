package com.dshmobile.spike

import java.io.File
import java.io.OutputStream

/**
 * The fallback seat for the official upstream dist — the frontend-static
 * behavior of docs/webserver-contract.md §2.1 with the Phase-B adaptations
 * of §3.4/§3.6: GET/HEAD only (405 otherwise), traversal → 403, fixed MIME
 * table (+ fonts/png), empty 404s, the auth-lite token→cookie exchange
 * gating index responses only, and the index render pipeline (§1.5):
 * head rows after `<head…>`, body rows after `<body…>`, the
 * `__DSH_BOOT_READY__` tail last, then `<base href="/">`. Kotlin sibling of
 * hosts/ios CarrierWebDist.swift.
 */
class CarrierWebDist(
    private val distRoot: File,
    private val sessionToken: String,
    /** Boot rows, read fresh per render (§1.5: live rows per render). */
    private val indexRows: () -> List<CarrierIndexInjection>,
) {
    /** Evidence hooks — the owning drive logs them; the seat never logs. */
    var onIndexRendered: ((Int, Int) -> Unit)? = null
    var onIndexServed: (() -> Unit)? = null
    var onAssetServed: ((String) -> Unit)? = null

    /** The fallback handler to register on the carrier server. */
    val handler: (CarrierRequest, OutputStream) -> Unit = { request, out -> serve(request, out) }

    private fun serve(request: CarrierRequest, out: OutputStream) {
        if (request.method != "GET" && request.method != "HEAD") {
            return respondEmpty(out, 405) // named routes own their methods
        }
        val path = request.path ?: return respondEmpty(out, 400)
        if (path.contains("..")) return respondEmpty(out, 403)
        if (path == "/" || File(distRoot, path.removePrefix("/")).canonicalPath ==
            File(distRoot, "index.html").canonicalPath
        ) {
            return serveIndex(request, out)
        }
        serveAsset(path, request.method, out)
    }

    // ---- index (auth-lite + render pipeline) --------------------------------

    private fun serveIndex(request: CarrierRequest, out: OutputStream) {
        val token = sessionToken
        if (request.query?.contains("token=$token") == true && request.method == "GET") {
            // mint the session cookie, then bounce to the clean URL (§2.2)
            CarrierHTTP.respond(
                out, 303, "text/plain", ByteArray(0),
                headers = mapOf(
                    "Set-Cookie" to "$COOKIE_HEADER_PREFIX$token; Path=/; HttpOnly",
                    "Location" to "/",
                ),
            )
            return
        }
        if (!request.isAuthed(token)) return respondEmpty(out, 401)
        val index = File(distRoot, "index.html")
        val raw = try {
            index.readText(Charsets.UTF_8)
        } catch (_: Exception) {
            return respondEmpty(out, 404)
        }
        val rows = indexRows()
        val rendered = renderIndex(raw, rows)
        val body = rendered.toByteArray(Charsets.UTF_8)
        onIndexRendered?.invoke(rows.size, body.size)
        onIndexServed?.invoke()
        CarrierHTTP.respond(out, 200, HTML_MIME, body, bodyless = request.method == "HEAD")
    }

    /** Renders rows into the raw index body: head rows after the opening head
     * tag, body rows after the opening body tag, the boot-readiness tail
     * after the last body row (upstream `renderIndexInjections`), then the
     * `<base href="/">` transform immediately after `<head…>` (upstream
     * frontend-static: base lands before the spliced row markup). */
    fun renderIndex(html: String, rows: List<CarrierIndexInjection>): String {
        var head = ""
        var body = ""
        for (row in rows) {
            val (placement, markup) = row.rendered
            if (placement == CarrierIndexInjection.Placement.HEAD) head += markup else body += markup
        }
        body += READY_MARKUP
        var out = html
        out = spliceAfter(out, "<head", "<base href=\"/\">" + head)
        out = spliceAfter(out, "<body", body)
        return out
    }

    companion object {
        val HTML_MIME = "text/html; charset=utf-8"
        const val COOKIE_HEADER_PREFIX = "${CarrierServer.COOKIE_NAME}="

        /** The tail script settling `__DSH_BOOT_READY__` (upstream READY_MARKUP). */
        const val READY_MARKUP =
            "<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>"

        /** Inserts `markup` after the opening tag that starts with `pattern`
         * (`<head…>` / `<body…>`); prepend when the document lacks the tag. */
        fun spliceAfter(html: String, pattern: String, markup: String): String {
            val upper = html.lowercase()
            val withBracket = upper.indexOf("$pattern>")
            val at = if (withBracket >= 0) withBracket + pattern.length + 1
            else upper.indexOf(pattern).let { if (it >= 0) it + pattern.length else -1 }
            if (at < 0) return markup + html
            return html.substring(0, at) + markup + html.substring(at)
        }

        /** Upstream's table, extended per §3.6 with fonts and webmanifest icons. */
        val mime = mapOf(
            "html" to HTML_MIME,
            "js" to "text/javascript; charset=utf-8",
            "css" to "text/css; charset=utf-8",
            "svg" to "image/svg+xml",
            "json" to "application/json",
            "map" to "application/json",
            "webmanifest" to "application/manifest+json",
            "gz" to "application/gzip",
            "woff2" to "font/woff2",
            "woff" to "font/woff",
            "ttf" to "font/ttf",
            "png" to "image/png",
        )
    }

    // ---- assets (§2.1 fixed MIME table + §3.6 fonts/png) ----------------------

    private fun serveAsset(path: String, method: String, out: OutputStream) {
        val ext = path.substringAfterLast('.', "").lowercase()
        val contentType = mime[ext] ?: "application/octet-stream"
        val file = File(distRoot, path.removePrefix("/"))
        val data = try {
            if (file.isFile) file.readBytes() else null
        } catch (_: Exception) {
            null
        } ?: return respondEmpty(out, 404) // absent or non-file: empty 404
        onAssetServed?.invoke(path)
        CarrierHTTP.respond(out, 200, contentType, data, bodyless = method == "HEAD")
    }

    private fun respondEmpty(out: OutputStream, status: Int) {
        CarrierHTTP.respond(out, status, "text/plain", ByteArray(0))
    }
}
