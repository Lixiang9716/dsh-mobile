package com.dshmobile.spike

/**
 * One parsed HTTP request handed to route handlers — transport facts only
 * (the carrier carries no harness concepts, docs/webserver-contract.md §1).
 * The receiving handler owns the FULL response lifecycle for its connection.
 * Kotlin sibling of hosts/ios CarrierRequest.swift.
 */
class CarrierRequest(
    val method: String,
    /** Percent-decoded pathname (query stripped, one decode); null on bad
     * escapes — a null path dispatches to the 400 leg, never a crash. */
    val path: String?,
    /** Raw (still-encoded) request path, query stripped. */
    val rawPath: String,
    /** Raw query string (no leading `?`), null when absent. */
    val query: String?,
    /** Header names lowercased; the first value of each name wins. */
    val headers: Map<String, String>,
    /** Body bytes read up to the carrier cap (only when Content-Length said so). */
    val body: ByteArray,
) {
    fun header(name: String): String? = headers[name.lowercase()]

    /** Value of the carrier session cookie when the request carries it (the
     * auth-lite posture of docs/webserver-contract.md §3.4). */
    val sessionCookie: String?
        get() {
            val raw = headers["cookie"] ?: return null
            for (pair in raw.split(";")) {
                val kv = pair.split("=", limit = 2)
                if (kv.size == 2 && kv[0].trim() == CarrierServer.COOKIE_NAME) {
                    return kv[1].trim()
                }
            }
            return null
        }

    /** Whether the request carries the valid session token (cookie first,
     * token query parameter second — the WebView hands the token once). */
    fun isAuthed(token: String): Boolean {
        if (sessionCookie == token) return true
        return query?.contains("token=$token") ?: false
    }

    companion object {
        /** One percent decode for the pathname (%XX only — `+` stays plus,
         * matching URLComponents' path semantics on the iOS sibling). */
        fun percentDecode(value: String): String? {
            if (!value.contains('%')) return value
            val out = StringBuilder(value.length)
            var i = 0
            while (i < value.length) {
                val c = value[i]
                if (c == '%') {
                    if (i + 2 >= value.length) return null
                    val hex = value.substring(i + 1, i + 3)
                    val code = hex.toIntOrNull(16) ?: return null
                    out.append(code.toChar())
                    i += 3
                } else {
                    out.append(c)
                    i += 1
                }
            }
            return out.toString()
        }
    }
}

/** Route kind per the webServer contract: `exact` matches one pathname,
 * `prefix` matches `p` and `p/<anything>` (§1.2). */
enum class CarrierRouteKind { EXACT, PREFIX }

/** What an upgrade handler decided for one WebSocket attempt (§1.3). The
 * server executes the plan so handlers never touch the raw connection. */
sealed class CarrierUpgradePlan {
    object Accept : CarrierUpgradePlan()
    data class Reject(val status: Int, val message: String) : CarrierUpgradePlan()
    object Destroy : CarrierUpgradePlan()
}

/** One structured index-injection row (upstream `IndexInjection`,
 * docs/webserver-contract.md §1.5). Values are pre-rendered wire text:
 * `global` values carry their JSON encoding from the producer. */
class CarrierIndexInjection private constructor(private val kind: Kind) {

    enum class Placement { HEAD, BODY }

    sealed class Kind {
        data class Global(val name: String, val value: String) : Kind()
        data class Script(val placement: Placement, val text: String) : Kind()
        data class ScriptSrc(val placement: Placement, val src: String) : Kind()
        data class ScriptPreload(val src: String) : Kind()
        data class Style(val text: String) : Kind()
    }

    /** The row's markup and the region it lands in (upstream `renderRow`). */
    val rendered: Pair<Placement, String>
        get() = when (val k = kind) {
            is Kind.Global -> {
                // The name rides a JS member expression: it must be a QUOTED
                // string (globalThis["__DSH_BOOT__"]) — an HTML-escaped bare
                // identifier reads as a variable reference and throws before
                // the assignment (latent until a row executed in-page).
                val quoted = jsonString(k.name)
                Placement.HEAD to "<script>globalThis[$quoted] = ${k.value}</script>"
            }
            is Kind.Script -> k.placement to "<script>${k.text}</script>"
            is Kind.ScriptSrc ->
                k.placement to "<script src=\"${htmlAttribute(k.src)}\"></script>"
            is Kind.ScriptPreload ->
                Placement.HEAD to
                    "<link rel=\"preload\" as=\"script\" href=\"${htmlAttribute(k.src)}\">"
            is Kind.Style -> Placement.HEAD to "<style>${k.text}</style>"
        }

    companion object {
        fun global(name: String, value: String) = CarrierIndexInjection(Kind.Global(name, value))
        fun script(text: String) =
            CarrierIndexInjection(Kind.Script(Placement.HEAD, text))
        fun scriptSrc(src: String) =
            CarrierIndexInjection(Kind.ScriptSrc(Placement.HEAD, src))
        fun scriptPreload(src: String) = CarrierIndexInjection(Kind.ScriptPreload(src))
        fun style(text: String) = CarrierIndexInjection(Kind.Style(text))

        /** JSON-encode one string (the member-expression face of a `global`
         * row's name). */
        fun jsonString(value: String): String =
            "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

        /** Escape one value before placing it in a quoted HTML attribute
         * (upstream `escapeHtmlAttribute`). */
        fun htmlAttribute(value: String): String = value
            .replace("&", "&amp;")
            .replace("\"", "&quot;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")

        /** JSON-encode one value for a `global` row, `<`-escaped so a
         * row-controlled string cannot break out of the script element. */
        fun jsonGlobalValue(value: String): String = value.replace("<", "\\u003c")
    }
}
