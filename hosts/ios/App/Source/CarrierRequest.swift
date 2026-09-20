import Foundation

/// One parsed HTTP request handed to route handlers — transport facts only
/// (the carrier carries no harness concepts, docs/webserver-contract.md §1).
/// The receiving handler owns the FULL response lifecycle for its connection.
struct CarrierRequest {
    let method: String
    /// Percent-decoded pathname (query stripped, one decode); nil on bad
    /// escapes — a nil path dispatches to the 400 leg, never a crash.
    let path: String?
    /// Raw (still-encoded) request path, query stripped.
    let rawPath: String
    /// Raw query string (no leading `?`), nil when absent.
    let query: String?
    /// Header names lowercased; the first value of each name wins.
    let headers: [String: String]
    /// Body bytes read up to the carrier cap (only when Content-Length said so).
    let body: Data
    /// The request's declared Content-Length (body-completeness facts).
    let declaredLength: Int

    func header(_ name: String) -> String? { headers[name.lowercased()] }

    /// Value of the carrier session cookie when the request carries it (the
    /// auth-lite posture of docs/webserver-contract.md §3.4).
    var sessionCookie: String? {
        guard let raw = headers["cookie"] else { return nil }
        for pair in raw.split(separator: ";") {
            let kv = pair.split(separator: "=", maxSplits: 1)
            if kv.count == 2, kv[0].trimmingCharacters(in: .whitespaces)
                == CarrierServer.cookieName {
                return kv[1].trimmingCharacters(in: .whitespaces)
            }
        }
        return nil
    }

    /// Whether the request carries the valid session token (cookie first,
    /// token query parameter second — the WebView hands the token once).
    func isAuthed(token: String) -> Bool {
        if sessionCookie == token { return true }
        return query?.contains("token=\(token)") ?? false
    }
}

/// Route kind per the webServer contract: `exact` matches one pathname,
/// `prefix` matches `p` and `p/<anything>` (§1.2).
enum CarrierRouteKind: String {
    case exact
    case prefix
}

/// What an upgrade handler decided for one WebSocket attempt (§1.3). The
/// server executes the plan so handlers never touch the raw connection.
enum CarrierUpgradePlan {
    /// Complete the RFC6455 handshake and open a seat on the matched path.
    case accept
    /// Answer a plain HTTP rejection, then close.
    case reject(status: Int, message: String)
    /// Destroy the socket without a response (unmatched/bad handshake).
    case destroy
}

/// One structured index-injection row (upstream `IndexInjection`,
/// docs/webserver-contract.md §1.5). Values are pre-rendered wire text:
/// `global` values carry their JSON encoding from the producer.
struct CarrierIndexInjection {
    enum Placement: String {
        case head
        case body
    }

    enum Kind {
        /// `globalThis[name] = <value>`; `value` is JSON-encoded text.
        case global(name: String, value: String)
        /// Inline classic script.
        case script(placement: Placement, text: String)
        /// External classic script tag.
        case scriptSrc(placement: Placement, src: String)
        /// Advisory preload for an external classic script (head).
        case scriptPreload(src: String)
        /// A `<style>` element in the head.
        case style(text: String)
        /// Raw markup fragment.
        case html(placement: Placement, html: String)
    }

    let kind: Kind

    /// The row's markup and the region it lands in (upstream `renderRow`).
    var rendered: (placement: Placement, markup: String) {
        switch kind {
        case let .global(name, value):
            let quoted = Self.htmlAttribute(name)
            return (.head, "<script>globalThis[\(quoted)] = \(value)</script>")
        case let .script(placement, text):
            return (placement, "<script>\(text)</script>")
        case let .scriptSrc(placement, src):
            return (placement, "<script src=\"\(Self.htmlAttribute(src))\"></script>")
        case let .scriptPreload(src):
            return (.head, "<link rel=\"preload\" as=\"script\" href=\"\(Self.htmlAttribute(src))\">")
        case let .style(text):
            return (.head, "<style>\(text)</style>")
        case let .html(placement, html):
            return (placement, html)
        }
    }

    /// Escape one value before placing it in a quoted HTML attribute
    /// (upstream `escapeHtmlAttribute`).
    static func htmlAttribute(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    /// JSON-encode one value for a `global` row, `<`-escaped so a
    /// row-controlled string cannot break out of the script element.
    static func jsonGlobalValue(_ value: String) -> String {
        value.replacingOccurrences(of: "<", with: "\\u003c")
    }
}
