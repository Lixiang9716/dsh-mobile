import Foundation
import Network

/// The fallback seat for the official upstream dist — the frontend-static
/// behavior of docs/webserver-contract.md §2.1 with the Phase-B adaptations
/// of §3.4/§3.6: GET/HEAD only (405 otherwise), traversal → 403, fixed MIME
/// table (+ fonts/png), empty 404s, the auth-lite token→cookie exchange
/// gating index responses only, and the index render pipeline (§1.5):
/// head rows after `<head…>`, body rows after `<body…>`, the
/// `__DSH_BOOT_READY__` tail last, then `<base href="/">`.
final class CarrierWebDist {
    /// Evidence hooks — the owning drive logs them; the seat never logs.
    var onIndexRendered: ((Int, Int) -> Void)?
    var onIndexServed: (() -> Void)?
    var onAssetServed: ((String) -> Void)?

    /// Boot rows, read fresh per render (§1.5: live rows per render).
    var indexRows: () -> [CarrierIndexInjection]
    /// Per-session auth-lite token (§3.4: the reduction of §2.2).
    let sessionToken: String
    private let distRoot: URL
    private let distIndex: URL

    init(distRoot: URL, sessionToken: String, indexRows: @escaping () -> [CarrierIndexInjection]) {
        self.distRoot = distRoot
        self.distIndex = distRoot.appendingPathComponent("index.html")
        self.sessionToken = sessionToken
        self.indexRows = indexRows
    }

    /// The fallback handler to register on the carrier server.
    var handler: CarrierHTTPHandler { { [weak self] request, conn in
        self?.serve(request, conn: conn)
    } }

    private func serve(_ request: CarrierRequest, conn: NWConnection) {
        guard request.method == "GET" || request.method == "HEAD" else {
            return respondEmpty(405, conn: conn) // named routes own their methods
        }
        guard let path = request.path else {
            return respondEmpty(400, conn: conn)
        }
        let rel = String(path.dropFirst())
        guard !rel.contains("..") else { return respondEmpty(403, conn: conn) }
        if path == "/" || distRoot.appendingPathComponent(rel).standardizedFileURL
            == distIndex.standardizedFileURL {
            return serveIndex(request, conn: conn)
        }
        serveAsset(path, method: request.method, conn: conn)
    }

    // ---- index (auth-lite + render pipeline) --------------------------------

    private func serveIndex(_ request: CarrierRequest, conn: NWConnection) {
        let token = sessionToken
        if request.query?.contains("token=\(token)") == true, request.method == "GET" {
            // mint the session cookie, then bounce to the clean URL (§2.2)
            let cookie = "\(Self.cookieHeaderPrefix)\(token); Path=/; HttpOnly"
            CarrierServer.respond(status: 303, body: Data(), contentType: "text/plain", conn: conn,
                    headers: ["Set-Cookie": cookie, "Location": "/"])
            return
        }
        guard request.isAuthed(token: token) else {
            return respondEmpty(401, conn: conn)
        }
        guard let raw = try? String(contentsOf: distIndex, encoding: .utf8) else {
            return respondEmpty(404, conn: conn)
        }
        let rows = indexRows()
        let rendered = Self.renderIndex(raw, rows: rows)
        let body = Data(rendered.utf8)
        onIndexRendered?(rows.count, body.count)
        onIndexServed?()
        CarrierServer.respond(status: 200, body: body, contentType: Self.htmlMIME, conn: conn,
                bodyless: request.method == "HEAD")
    }

    /// Renders rows into the raw index body: head rows after the opening head
    /// tag, body rows after the opening body tag, the boot-readiness tail
    /// after the last body row (upstream `renderIndexInjections`), then the
    /// `<base href="/">` transform immediately after `<head…>` (upstream
    /// frontend-static: base lands before the spliced row markup).
    static func renderIndex(_ html: String, rows: [CarrierIndexInjection]) -> String {
        var head = ""
        var body = ""
        for row in rows {
            let rendered = row.rendered
            if rendered.placement == .head { head += rendered.markup }
            else { body += rendered.markup }
        }
        body += readyMarkup
        var out = html
        out = spliceAfter(out, pattern: "<head", markup: "<base href=\"/\">" + head)
        out = spliceAfter(out, pattern: "<body", markup: body)
        return out
    }

    /// The tail script settling `__DSH_BOOT_READY__` (upstream READY_MARKUP).
    static let readyMarkup =
        "<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>"

    static let cookieHeaderPrefix = "\(CarrierServer.cookieName)="

    /// Inserts `markup` after the opening tag that starts with `pattern`
    /// (`<head…>` / `<body…>`); prepend when the document lacks the tag.
    static func spliceAfter(_ html: String, pattern: String, markup: String) -> String {
        guard let range = html.range(of: pattern + ">", options: [.caseInsensitive])
            ?? html.range(of: pattern, options: [.caseInsensitive]) else {
            return markup + html
        }
        // Both slices convert explicitly: used directly in `+`, the
        // PartialRangeFrom<String.Index> overload resolves to the
        // Int-bounded subscript on the Xcode 16.4 SDK and fails to compile.
        return String(html[..<range.upperBound]) + markup + String(html[range.upperBound...])
    }

    // ---- assets (§2.1 fixed MIME table + §3.6 fonts/png) ----------------------

    private func serveAsset(_ path: String, method: String, conn: NWConnection) {
        let ext = (path as NSString).pathExtension.lowercased()
        let contentType = Self.mime[ext] ?? "application/octet-stream"
        let file = distRoot.appendingPathComponent(String(path.dropFirst()))
        guard FileManager.default.fileExists(atPath: file.path),
              let data = try? Data(contentsOf: file) else {
            return respondEmpty(404, conn: conn) // absent or non-file: empty 404
        }
        onAssetServed?(path)
        recordAndServe(path, data: data, contentType: contentType,
                       method: method, conn: conn)
    }

    private func recordAndServe(
        _ path: String, data: Data, contentType: String,
        method: String, conn: NWConnection
    ) {
        CarrierServer.respond(status: 200, body: data, contentType: contentType, conn: conn,
                bodyless: method == "HEAD")
    }

    private func respondEmpty(_ status: Int, conn: NWConnection) {
        CarrierServer.respond(status: status, body: Data(), contentType: "text/plain", conn: conn)
    }

    static let htmlMIME = "text/html; charset=utf-8"

    /// Upstream's table, extended per §3.6 with fonts and webmanifest icons.
    static let mime: [String: String] = [
        "html": htmlMIME,
        "js": "text/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "svg": "image/svg+xml",
        "json": "application/json",
        "map": "application/json",
        "webmanifest": "application/manifest+json",
        "gz": "application/gzip",
        "woff2": "font/woff2",
        "woff": "font/woff",
        "ttf": "font/ttf",
        "png": "image/png",
    ]
}
