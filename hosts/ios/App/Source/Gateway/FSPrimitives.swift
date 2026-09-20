import Foundation

/// The filesystem primitives (fsRead / fsWrite / fsScope) over a scope
/// registry (contract/primitives.md §4). The reserved scope "app" maps to
/// the host's own profile container per data-protocols.md §1 —
/// `<Documents>/profiles/default/` (under Documents so it is backed up and,
/// with UIFileSharingEnabled, browsable in Files). User-granted scopes are
/// handles "user:<uuid>" bound to security-scoped URLs (from presentPicker
/// or a resolved bookmark); every operation on them brackets the access.
/// Paths are POSIX-relative; anything absolute, dotted, or empty is
/// rejected as `invalid`; an ungranted/unknown scope as `denied`.
final class FSPrimitives {
    /// Host-declared maximum file size for fsRead (primitives.md §4).
    static let maxReadBytes = 8 * 1024 * 1024
    static let bookmarkPrefix = "bkm:"

    private let lock = NSLock()
    private var userScopes: [String: URL] = [:]
    private let appRoot: URL

    init() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        appRoot = documents.appendingPathComponent("profiles/default", isDirectory: true)
        try? FileManager.default.createDirectory(at: appRoot, withIntermediateDirectories: true)
    }

    func register(on core: GatewayCore) {
        core.register(name: "fsRead") { call, done in self.read(call, done) }
        core.register(name: "fsWrite") { call, done in self.write(call, done) }
        core.register(name: "fsScope.persist") { call, done in self.persist(call, done) }
        core.register(name: "fsScope.resolve") { call, done in self.resolveRef(call, done) }
    }

    /// Binds a fresh user scope handle to a security-scoped URL (picker
    /// grants, bookmark resolution).
    func grantUserScope(_ url: URL) -> String {
        let handle = "user:\(UUID().uuidString)"
        lock.lock()
        userScopes[handle] = url
        lock.unlock()
        return handle
    }

    // ---- handlers -----------------------------------------------------------

    private func read(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let (scope, rel) = target(call, primitive: "fsRead", done) else { return }
        inScope(scope) { base in
            let file = base.appendingPathComponent(rel)
            guard let attrs = try? FileManager.default.attributesOfItem(atPath: file.path),
                  let data = FileManager.default.contents(atPath: file.path)
            else {
                return done(.failure(GatewayError(
                    code: "io", primitive: "fsRead", message: "cannot read \(rel)")))
            }
            guard data.count <= Self.maxReadBytes else {
                return done(.failure(Self.invalid(
                    "fsRead", "file exceeds the \(Self.maxReadBytes)-byte cap")))
            }
            let mtime = (attrs[.modificationDate] as? Date).map { GatewayCore.isoNow($0) }
            done(.success(["bytesB64": data.base64EncodedString(), "mtime": mtime ?? ""]))
        } onDenied: {
            done(.failure(Self.denied("fsRead", scope)))
        }
    }

    private func write(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let (scope, rel) = target(call, primitive: "fsWrite", done) else { return }
        // opts ride flattened at the top level of the args JSON (the gateway
        // shim's encoding of the contract's fsWrite(scope, path, bytes, opts));
        // the nested form is accepted tolerantly. Reading ONLY a nested opts
        // object silently dropped append/create — caught by the M3 receipt
        // journal, the first append caller (see .gov/surprises.jsonl).
        let opts = call.dict("opts")
        let append = (call.args["append"] as? Bool) ?? (opts["append"] as? Bool) ?? false
        let create = (call.args["create"] as? Bool) ?? (opts["create"] as? Bool) ?? true
        guard let bytes = call.b64("bytesB64") else {
            return done(.failure(Self.invalid("fsWrite", "missing bytesB64")))
        }
        inScope(scope) { base in
            let file = base.appendingPathComponent(rel)
            let exists = FileManager.default.fileExists(atPath: file.path)
            if !exists, !create {
                return done(.failure(GatewayError(
                    code: "io", primitive: "fsWrite", message: "\(rel) does not exist")))
            }
            Self.writeFile(file, bytes: bytes, append: append && exists) {
                done($0.map { _ in ["written": bytes.count] })
            }
        } onDenied: {
            done(.failure(Self.denied("fsWrite", scope)))
        }
    }

    /// fsScope.persist — security-scoped bookmark data, ref prefix "bkm:".
    private func persist(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let scope = call.string("scope") else {
            return done(.failure(Self.invalid("fsScope.persist", "missing scope")))
        }
        guard scope != "app" else {
            return done(.failure(Self.invalid(
                "fsScope.persist", "the reserved app scope is host-fixed")))
        }
        inScope(scope) { base in
            do {
                let bookmark = try base.bookmarkData()
                let ref = Self.bookmarkPrefix + bookmark.base64EncodedString()
                done(.success(["ref": ref]))
            } catch {
                done(.failure(GatewayError(
                    code: "io", primitive: "fsScope.persist", message: "\(error)")))
            }
        } onDenied: {
            done(.failure(Self.denied("fsScope.persist", scope)))
        }
    }

    /// fsScope.resolve — restores a persisted ref into a fresh user handle.
    private func resolveRef(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let ref = call.string("ref"), ref.hasPrefix(Self.bookmarkPrefix),
              let data = Data(base64Encoded: String(ref.dropFirst(Self.bookmarkPrefix.count)))
        else {
            return done(.failure(Self.invalid("fsScope.resolve", "malformed ref")))
        }
        var stale = false
        let resolved = try? URL(
            resolvingBookmarkData: data, options: [],
            relativeTo: nil, bookmarkDataIsStale: &stale)
        guard let url = resolved else {
            let message = "ref no longer resolves"
            return done(.failure(GatewayError(
                code: "io", primitive: "fsScope.resolve", message: message)))
        }
        done(.success(["scope": grantUserScope(url)]))
    }

    // ---- scope plumbing -----------------------------------------------------

    /// Resolves the scope handle and runs `body` with its root URL while the
    /// security-scoped access (if any) is held; `onDenied` for ungranted.
    private func inScope(
        _ scope: String,
        _ body: @escaping (URL) -> Void, onDenied: @escaping () -> Void
    ) {
        guard let (root, security) = rootURL(for: scope) else { return onDenied() }
        let accessed = security ? root.startAccessingSecurityScopedResource() : false
        body(root)
        if accessed { root.stopAccessingSecurityScopedResource() }
    }

    private func rootURL(for scope: String) -> (URL, Bool)? {
        if scope == "app" { return (appRoot, false) }
        lock.lock()
        defer { lock.unlock() }
        guard let url = userScopes[scope] else { return nil }
        return (url, true)
    }

    /// Validates (scope, path) args; settles `invalid` via `done` and returns
    /// nil on any malformed input. Paths must be POSIX-relative, no escape.
    private func target(
        _ call: GatewayCall, primitive: String, _ done: @escaping GatewayDone
    ) -> (String, String)? {
        guard let scope = call.string("scope"), let path = call.string("path"),
              let rel = Self.safeRelative(path)
        else {
            done(.failure(Self.invalid(primitive, "malformed scope/path")))
            return nil
        }
        return (scope, rel)
    }

    static func safeRelative(_ path: String) -> String? {
        guard !path.isEmpty, !path.hasPrefix("/") else { return nil }
        let comps = path.split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)
        guard !comps.isEmpty, !comps.contains(".."), !comps.contains(".") else { return nil }
        return comps.joined(separator: "/")
    }

    private static func writeFile(
        _ file: URL, bytes: Data, append: Bool, _ done: @escaping GatewayDone
    ) {
        do {
            try FileManager.default.createDirectory(
                at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            if append, let handle = FileHandle(forWritingAtPath: file.path) {
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: bytes)
            } else {
                try bytes.write(to: file)
            }
            done(.success(()))
        } catch {
            done(.failure(GatewayError(
                code: "io", primitive: "fsWrite", message: "\(error)")))
        }
    }

    private static func invalid(_ primitive: String, _ message: String) -> GatewayError {
        GatewayError(code: "invalid", primitive: primitive, message: message)
    }

    private static func denied(_ primitive: String, _ scope: String) -> GatewayError {
        GatewayError(code: "denied", primitive: primitive,
                     message: "scope not granted: \(scope)")
    }
}
