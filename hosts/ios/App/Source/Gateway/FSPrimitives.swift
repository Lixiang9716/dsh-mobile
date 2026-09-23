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

    /// The profile container the reserved "app" scope resolves to
    /// (data-protocols.md §1). Static so a host-side drive can name the SAME
    /// directory the gateway will use — the guest userland lives beside it
    /// (`<app root>/ish-rootfs`, IshPrimitive) and the spine has to be told
    /// about it before any primitive exists.
    static func defaultAppRoot() -> URL {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return documents.appendingPathComponent("profiles/default", isDirectory: true)
    }

    init() {
        appRoot = Self.defaultAppRoot()
        try? FileManager.default.createDirectory(at: appRoot, withIntermediateDirectories: true)
    }

    func register(on core: GatewayCore) {
        core.register(name: "fsRead") { call, done in self.read(call, done) }
        core.register(name: "fsWrite") { call, done in self.write(call, done) }
        core.register(name: "fsScope.persist") { call, done in self.persist(call, done) }
        core.register(name: "fsScope.resolve") { call, done in self.resolveRef(call, done) }
        // Contract v1.1.0 additions: what the upstream file service needs on
        // top of read/write (stat + list to resolve a target, mkdir + rename
        // for its atomic-write path, remove for cleanup). They reuse the
        // fsRead / fsWrite permission flags, so no new capability appears in
        // any manifest and an older host simply answers `unavailable`.
        core.register(name: "fsStat") { call, done in self.stat(call, done) }
        core.register(name: "fsList") { call, done in self.list(call, done) }
        core.register(name: "fsMkdir") { call, done in self.mkdir(call, done) }
        core.register(name: "fsRemove") { call, done in self.remove(call, done) }
        core.register(name: "fsRename") { call, done in self.rename(call, done) }
        // Contract v1.2.0: one export of one module, executed in-process.
        core.register(name: "wasmRun") { call, done in self.wasmRun(call, done) }
        // Contract v1.3.0: one program in the in-process Linux guest. It rides
        // the SAME scope registry (the scope root is what the guest mounts), so
        // it is registered here rather than by a driver — and this closure keeps
        // the primitive alive.
        let ish = IshPrimitive(fs: self)
        core.register(name: "ishRun") { call, done in ish.run(call, done) }
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
        // Reserved-scope URIs (`scope://app/`) resolve to the scope's root
        // the same way the CLI host answers them — the profile container IS
        // the scope root, and the parity drive (scenario upstream.parity,
        // the launch-env host-facts branch) pins the session cwd there. A
        // user-granted scope still resolves through its bookmark below.
        if let ref = call.string("ref"), ref.hasPrefix("scope://"), ref.hasSuffix("/") {
            let name = String(ref.dropFirst("scope://".count).dropLast())
            if let (root, _) = rootURL(for: name) {
                return done(.success(["scope": name, "path": root.path]))
            }
        }
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

    // ---- contract v1.1.0: stat / list / mkdir / remove / rename ------------
    //
    // Each handler is deliberately thin: it resolves the scope, then hands the
    // real work to a static helper that returns a Result. The bodies live one
    // level shallower that way, which keeps them inside this repository's
    // code-shape budget (indent <= 5) without hiding what they do.

    /// fsStat — `{ kind, size, mtime }`. A missing path is `io` (the contract
    /// has no separate "not found" code; callers read the message).
    private func stat(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let (scope, rel) = target(call, primitive: "fsStat", done) else { return }
        inScope(scope) { base in
            done(Self.statResult(at: base.appendingPathComponent(rel), rel: rel))
        } onDenied: {
            done(.failure(Self.denied("fsStat", scope)))
        }
    }

    private static func statResult(at url: URL, rel: String) -> Result<Any, GatewayError> {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path) else {
            return .failure(GatewayError(
                code: "io", primitive: "fsStat", message: "cannot stat \(rel)"))
        }
        let mtime = (attrs[.modificationDate] as? Date).map { GatewayCore.isoNow($0) } ?? ""
        return .success([
            "kind": kind(of: attrs),
            "size": (attrs[.size] as? NSNumber)?.intValue ?? 0,
            "mtime": mtime,
        ])
    }

    /// fsList — one level, hidden entries INCLUDED (the tools decide what to
    /// skip), sorted by name in byte order so a listing is deterministic
    /// across hosts (contract §4).
    private func list(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let (scope, rel) = target(call, primitive: "fsList", done) else { return }
        inScope(scope) { base in
            let dir = base.appendingPathComponent(rel)
            guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path)
            else {
                return done(.failure(GatewayError(
                    code: "io", primitive: "fsList", message: "cannot list \(rel)")))
            }
            done(.success(["entries": Self.entries(in: dir, names: names)]))
        } onDenied: {
            done(.failure(Self.denied("fsList", scope)))
        }
    }

    private static func entries(in dir: URL, names: [String]) -> [[String: Any]] {
        names.sorted { $0.utf8.lexicographicallyPrecedes($1.utf8) }.map { name in
            let path = dir.appendingPathComponent(name).path
            let attrs = try? FileManager.default.attributesOfItem(atPath: path)
            return ["name": name, "kind": attrs.map { kind(of: $0) } ?? "other"]
        }
    }

    /// fsMkdir — recursive by default; an existing directory only errors when
    /// the caller asked it to (`existing: "error"`).
    private func mkdir(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let (scope, rel) = target(call, primitive: "fsMkdir", done) else { return }
        let existing = call.string("existing") ?? "ok"
        inScope(scope) { base in
            let dir = base.appendingPathComponent(rel)
            done(Self.makeDirectory(at: dir, rel: rel, existing: existing))
        } onDenied: {
            done(.failure(Self.denied("fsMkdir", scope)))
        }
    }

    private static func makeDirectory(
        at dir: URL, rel: String, existing: String
    ) -> Result<Any, GatewayError> {
        var isDir: ObjCBool = false
        let present = FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir)
        if present, isDir.boolValue {
            guard existing != "error" else {
                return .failure(GatewayError(
                    code: "io", primitive: "fsMkdir", message: "\(rel) exists"))
            }
            return .success([:])
        }
        do {
            try FileManager.default.createDirectory(
                at: dir, withIntermediateDirectories: true)
            return .success([:])
        } catch {
            return .failure(GatewayError(
                code: "io", primitive: "fsMkdir", message: "\(error)"))
        }
    }

    /// fsRemove — recursive only when asked, and an absent path is a value
    /// unless `missing: "error"`.
    private func remove(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let (scope, rel) = target(call, primitive: "fsRemove", done) else { return }
        let opts = (recursive: (call.args["recursive"] as? Bool) ?? false,
                    missing: call.string("missing") ?? "ok")
        inScope(scope) { base in
            done(Self.removeItem(at: base.appendingPathComponent(rel), rel: rel, opts: opts))
        } onDenied: {
            done(.failure(Self.denied("fsRemove", scope)))
        }
    }

    private static func removeItem(
        at target: URL, rel: String, opts: (recursive: Bool, missing: String)
    ) -> Result<Any, GatewayError> {
        var isDir: ObjCBool = false
        let present = FileManager.default.fileExists(
            atPath: target.path, isDirectory: &isDir)
        guard present else {
            guard opts.missing != "error" else {
                return .failure(GatewayError(
                    code: "io", primitive: "fsRemove", message: "\(rel) is absent"))
            }
            return .success([:])
        }
        // A directory is never removed without an explicit `recursive`: an
        // unlink that silently deep-deletes is the wrong default.
        guard !isDir.boolValue || opts.recursive else {
            return .failure(invalid(
                "fsRemove", "\(rel) is a directory (pass recursive: true)"))
        }
        do {
            try FileManager.default.removeItem(at: target)
            return .success([:])
        } catch {
            return .failure(GatewayError(
                code: "io", primitive: "fsRemove", message: "\(error)"))
        }
    }

    /// fsRename — POSIX semantics: an existing destination is REPLACED. That
    /// is what the upstream atomic-write path depends on (write a sibling temp
    /// file, rename it over the target), so it is not an option here.
    private func rename(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let scope = call.string("scope"),
              let from = call.string("from"), let to = call.string("to"),
              let relFrom = Self.safeRelative(from), let relTo = Self.safeRelative(to)
        else {
            return done(.failure(Self.invalid("fsRename", "malformed scope/from/to")))
        }
        inScope(scope) { base in
            let source = base.appendingPathComponent(relFrom)
            let dest = base.appendingPathComponent(relTo)
            done(Self.moveItem(from: source, to: dest, relFrom: relFrom))
        } onDenied: {
            done(.failure(Self.denied("fsRename", scope)))
        }
    }

    private static func moveItem(
        from source: URL, to dest: URL, relFrom: String
    ) -> Result<Any, GatewayError> {
        guard FileManager.default.fileExists(atPath: source.path) else {
            return .failure(GatewayError(
                code: "io", primitive: "fsRename", message: "\(relFrom) is absent"))
        }
        do {
            try FileManager.default.createDirectory(
                at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: dest.path) {
                try FileManager.default.removeItem(at: dest)
            }
            try FileManager.default.moveItem(at: source, to: dest)
            return .success([:])
        } catch {
            return .failure(GatewayError(
                code: "io", primitive: "fsRename", message: "\(error)"))
        }
    }

    /// The contract's entry kinds from POSIX attributes.
    private static func kind(of attrs: [FileAttributeKey: Any]) -> String {
        switch (attrs[.type] as? FileAttributeType) {
        case .typeDirectory: return "dir"
        case .typeRegular: return "file"
        default: return "other"
        }
    }

    /// wasmRun (contract v1.2.0) — one export of one module, executed
    /// IN-PROCESS by the vendored interpreter. It lives here because it reads
    /// the module through the SAME scope registry the fs primitives use: the
    /// module is an ordinary file inside the scope, and executing one adds no
    /// filesystem capability of its own (`wasm` is the flag that gates it).
    private func wasmRun(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let (scope, rel) = target(call, primitive: "wasmRun", done),
              let function = call.string("func")
        else {
            return done(.failure(Self.invalid(
                "wasmRun", "malformed scope/path/func")))
        }
        let input = call.string("input") ?? ""
        inScope(scope) { base in
            let module = base.appendingPathComponent(rel)
            done(Self.runModule(at: module, function: function, input: input, rel: rel))
        } onDenied: {
            done(.failure(Self.denied("wasmRun", scope)))
        }
    }

    private static func runModule(
        at url: URL, function: String, input: String, rel: String
    ) -> Result<Any, GatewayError> {
        guard let module = FileManager.default.contents(atPath: url.path) else {
            return .failure(GatewayError(
                code: "io", primitive: "wasmRun", message: "cannot read \(rel)"))
        }
        var error: UnsafeMutablePointer<CChar>?
        let json = module.withUnsafeBytes { raw -> UnsafeMutablePointer<CChar>? in
            guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return nil }
            return dsh_wasm_run(base, module.count, function, input, &error)
        }
        guard let json else {
            let message = error.map { String(cString: $0) } ?? "wasm run failed"
            if let error { free(error) }
            return .failure(GatewayError(
                code: "io", primitive: "wasmRun", message: message))
        }
        defer { free(json) }
        guard let text = String(validatingUTF8: json),
              let payload = (try? JSONSerialization.jsonObject(with: Data(text.utf8)))
                as? [String: Any]
        else {
            return .failure(GatewayError(
                code: "io", primitive: "wasmRun", message: "unreadable result"))
        }
        return .success(payload)
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

    /// The scope's root directory plus whether it needs a security-scoped
    /// access bracket — for a primitive that hands the DIRECTORY to a host
    /// subsystem instead of operating on a file inside it (ishRun mounts it as
    /// the guest workspace). The caller owns the bracket: such a mount outlives
    /// the call, so the access is held for the process, not for the call.
    func scopeForMount(_ scope: String) -> (URL, Bool)? {
        rootURL(for: scope)
    }

    /// Validates (scope, path) args; settles `invalid` via `done` and returns
    /// nil on any malformed input. Paths must be POSIX-relative, no escape.
    /// Shared with the primitives that are not fs calls but still name their
    /// target the same way (wasmRun's module, ishRun's working directory).
    func target(
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
