import Foundation

/// ishRun (contract v1.3.0) — one program in the host's in-process Linux
/// guest. The engine is the vendored iSH-arm64 userland emulator
/// (runtime/spike/host/dsh_ish.{h,c}, built by runtime/spike/host/ish and
/// linked into this app): a real aarch64 Alpine tree runs as emulated tasks
/// inside this process, so "run a command" needs neither a subprocess (D2) nor
/// a shell binary iOS does not have. It lives beside the fs primitives because
/// it reads its target through the SAME scope registry: the scope root is what
/// the guest gets mounted as its workspace, and a call's cwd is that mount plus
/// the scope-relative path (`ish` is the flag that gates it; the primitive adds
/// no filesystem reach of its own — the guest sees exactly the mounted scope).
///
/// One guest per process, booted lazily on first use: the engine's kernel is
/// process-global (one mount table, one pid table), so a second boot is neither
/// possible nor wanted and the mount outlives the call that established it.
/// Boot and every run therefore serialize on this primitive's own queue — a
/// background thread that is NOT the runtime thread (ARCHITECTURE.md §6) and
/// deliberately not the gateway's shared work queue either, because a boot
/// takes seconds and would otherwise stall every other primitive behind it.
final class IshPrimitive {
    /// Where the scope root is mounted inside the guest (dsh_ish_boot's mount
    /// point): the guest's view of the authorized directory.
    static let guestWorkspace = "/mnt/workspace"

    /// The staged userland, named as the sibling of the scope registry's
    /// reserved "app" root — `<Documents>/profiles/default/` (data-protocols.md
    /// §1), so the rootfs is `<app root>/ish-rootfs`. The Alpine tree is staged
    /// from OUTSIDE the app (the E2E runner copies it in), so a missing tree is
    /// a value the caller sees (`unavailable`), never a crash.
    static let rootfsName = "ish-rootfs"

    private let fs: FSPrimitives
    private let queue = DispatchQueue(label: "org.dsh.gateway.ish")
    /// queue-only: the boot happened, and the scopes whose security-scoped
    /// access this process holds (see `mountedRoot`).
    private var booted = false
    private var heldScopes: Set<String> = []

    init(fs: FSPrimitives) {
        self.fs = fs
    }

    // ---- handler -------------------------------------------------------------

    /// ishRun(scope, path, argv, opts?) — `argv` is the program plus its
    /// arguments, resolved INSIDE the guest userland; a command LINE goes
    /// through the guest's own /bin/sh -c, because the host does not parse
    /// shell syntax (contract v1.3.0). A guest that exits non-zero is a
    /// SUCCESSFUL call — the status is data; only a guest that cannot be
    /// started at all is a rejection.
    func run(_ call: GatewayCall, _ done: @escaping GatewayDone) {
        guard let (scope, rel) = Self.target(call, done) else { return }
        guard let argv = Self.argv(call) else {
            return done(.failure(Self.invalid(
                "argv must be a non-empty array of strings")))
        }
        guard let timeoutMs = Self.timeout(call) else {
            return done(.failure(Self.invalid("timeoutMs must be a number")))
        }
        queue.async {
            self.execute(
                scope: scope, rel: rel, argv: argv, timeoutMs: timeoutMs, done)
        }
    }

    /// The (scope, path) pair of a call. Same rule as the fs primitives — a
    /// scope-relative POSIX path, no leading "/", no "." or ".." — with ONE
    /// deliberate difference: the EMPTY path is the scope root, and here it is
    /// legitimate. The `path` of `ishRun` is the directory a command starts in,
    /// and the model's default working directory IS the workspace root; on this
    /// host the workspace root is the scope root, so the plugin's mapping
    /// produces "" for every ordinary call. The fs primitives refuse "" because
    /// they address *files* and the root is not a file — a *working directory*
    /// is a directory, and this one is inside the granted scope by construction
    /// (the host mounted it). Measured: the desktop e2e never saw this, because
    /// its scenario pins a workspace BELOW the scope root, so every call there
    /// carried a non-empty prefix; on iOS the prefix is empty and every call
    /// came back `invalid` before the shell ran.
    private static func target(
        _ call: GatewayCall, _ done: @escaping GatewayDone
    ) -> (String, String)? {
        guard let scope = call.string("scope"), let path = call.string("path") else {
            done(.failure(Self.invalid("malformed scope/path")))
            return nil
        }
        if path.isEmpty { return (scope, "") }
        guard let rel = FSPrimitives.safeRelative(path) else {
            done(.failure(Self.invalid("malformed scope/path")))
            return nil
        }
        return (scope, rel)
    }

    /// The guest half of the call, on `queue`: mount, boot once, run.
    private func execute(
        scope: String, rel: String, argv: [String], timeoutMs: Int,
        _ done: @escaping GatewayDone
    ) {
        guard let mount = mountedRoot(scope) else {
            return done(.failure(Self.denied(scope)))
        }
        if let failure = ensureBoot(container: mount) { return done(.failure(failure)) }
        done(Self.invoke(workdir: Self.guestCwd(rel), argv: argv, timeoutMs: timeoutMs))
    }

    // ---- the mount + the boot ------------------------------------------------

    /// The scope root the guest mounts, resolved through the fs registry's own
    /// rule, with its security-scoped access held for the life of the process:
    /// the guest keeps that directory mounted after this call returns, so the
    /// bracket cannot close when the call ends (a bookmark-scoped URL carries
    /// no access otherwise). The reserved "app" scope is the app's own
    /// container and needs no bracket. Nil = the scope was never granted.
    private func mountedRoot(_ scope: String) -> URL? {
        guard let (root, security) = fs.scopeForMount(scope) else { return nil }
        if security, heldScopes.insert(scope).inserted {
            _ = root.startAccessingSecurityScopedResource()
        }
        return root
    }

    /// Boots the guest on first use. `nil` = up (or already up); otherwise the
    /// rejection: a missing userland is `unavailable` — the platform CAN run a
    /// guest, this build simply has none staged — with the path named so the
    /// operator knows what to stage; anything else the engine reports is `io`.
    /// A failed boot leaves `booted` false, so the next call tries again.
    private func ensureBoot(container: URL) -> GatewayError? {
        if booted { return nil }
        let rootfs = container.appendingPathComponent(Self.rootfsName, isDirectory: true)
        if !Self.isDirectory(rootfs.path) {
            // A build that shipped the pinned userland materializes it now; a
            // build that shipped none keeps the honest `unavailable` below.
            if let staging = stageFromBundle(into: rootfs) { return staging }
        }
        guard Self.isDirectory(rootfs.path) else {
            return GatewayError(
                code: "unavailable", primitive: "ishRun",
                message: "guest userland \(rootfs.path) is missing")
        }
        var error: UnsafeMutablePointer<CChar>?
        let status = dsh_ish_boot(
            rootfs.path, container.path, Self.guestWorkspace, &error)
        guard status == 0 else {
            let why = Self.message(error, "guest boot failed")
            return Self.failure(why)
        }
        booted = true
        return nil
    }

    /// Materializes the bundled userland into the container on first use.
    ///
    /// The guest root cannot ride in the app bundle as a TREE: the Alpine
    /// userland's 335 symlinks are mostly absolute (`/usr/bin/top ->
    /// /bin/busybox`) and installd refuses such an app outright. The pinned
    /// minirootfs therefore ships as `ish-rootfs.tar.gz` — a plain data file —
    /// and the seam extracts it HERE, into the app container, where symlinks are
    /// ordinary filesystem entries again. Nil = there is nothing bundled to
    /// stage (a build without a userland), which is not an error: the caller's
    /// `unavailable` is then the truth.
    private func stageFromBundle(into rootfs: URL) -> GatewayError? {
        guard let tarball = Bundle.main.url(forResource: "ish-rootfs", withExtension: "tar.gz")
        else { return nil }
        var error: UnsafeMutablePointer<CChar>?
        let status = dsh_ish_stage(tarball.path, rootfs.path, &error)
        guard status == 0 else {
            return Self.failure(Self.message(error, "guest userland staging failed"))
        }
        return nil
    }

    /// The guest root THIS BUILD can serve, or nil when it cannot — the host's
    /// declaration for the spine's launch env (`DSH_ISH_ROOTFS`), which is what
    /// makes the shell plugin offer its tool (contract v1.3.0: a host declares
    /// the capability it has). It is a declaration, not a promise that the tree
    /// is already on disk: with the pinned userland bundled, `ensureBoot`
    /// materializes it on the first call. No bundled tarball and no staged tree
    /// = nil, and then no tool is offered.
    static func declaredGuestRoot() -> String? {
        let rootfs = FSPrimitives.defaultAppRoot()
            .appendingPathComponent(rootfsName, isDirectory: true)
        if isDirectory(rootfs.path) { return rootfs.path }
        guard Bundle.main.url(forResource: rootfsName, withExtension: "tar.gz") != nil else {
            return nil
        }
        return rootfs.path
    }

    private static func isDirectory(_ path: String) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && isDir.boolValue
    }

    // ---- args ----------------------------------------------------------------

    /// The argv array (contract v1.3.0: the program plus its arguments). An
    /// empty array, a non-string element, or an empty element is `invalid`: the
    /// guest resolves argv[0] as a path, so "" would surface as a
    /// program-not-found deep inside the engine instead of a rejected call.
    private static func argv(_ call: GatewayCall) -> [String]? {
        guard let items = call.args["argv"] as? [Any], !items.isEmpty else { return nil }
        var out: [String] = []
        for item in items {
            guard let text = item as? String, !text.isEmpty else { return nil }
            out.append(text)
        }
        return out
    }

    /// opts.timeoutMs. The gateway shim flattens options onto the args' top
    /// level (the fsWrite precedent); the nested `opts` object is accepted
    /// tolerantly. Absent (or null) is 0 — the engine's own default, clipped to
    /// its bounds there; a value that is not a number is rejected rather than
    /// silently defaulted.
    private static func timeout(_ call: GatewayCall) -> Int? {
        let raw = call.args["timeoutMs"] ?? call.dict("opts")["timeoutMs"]
        guard let raw, !(raw is NSNull) else { return 0 }
        guard let number = raw as? NSNumber else { return nil }
        // A JSON boolean is not a timeout. The obvious guard — `!(raw is Bool)` —
        // cannot tell them apart on Darwin: `NSNumber(0) is Bool` and
        // `NSNumber(1) is Bool` are BOTH true (the small integers bridge to
        // Bool), so it rejected the number 0, which is exactly the default the
        // shell plugin sends for "no timeout". Every `ish` call therefore came
        // back `invalid: timeoutMs must be a number` while the same shape worked
        // for wasmRun, whose primitive has no such guard. CoreFoundation answers
        // the question the guard meant to ask: only CFBoolean's type ID is a
        // boolean, and small numbers are not it. (Measured: 0/1 → `is Bool` true,
        // CFBoolean false; 60000 → false/false; JSON true → true/true.)
        if CFGetTypeID(number) == CFBooleanGetTypeID() { return nil }
        return number.intValue
    }

    /// The guest working directory of a call: the mount point plus the
    /// scope-relative path. `safeRelative` already rejected ".", "..", a leading
    /// "/" and empty paths, so the join cannot escape the mount — and the scope
    /// root itself is not addressable, which is the same rule every fs
    /// primitive obeys.
    private static func guestCwd(_ rel: String) -> String {
        if rel.isEmpty { return guestWorkspace }   // the scope root is the mount point
        return guestWorkspace + "/" + rel
    }

    // ---- the run -------------------------------------------------------------

    /// One program in the booted guest. Blocks `queue` until the guest exits or
    /// the deadline kills it. The JSON the seam returns already IS the
    /// contract's result object ({exitCode, stdout, stderr, timedOut,
    /// truncated}), so it is decoded, not re-modelled: the host does not have a
    /// second opinion about what the engine reported.
    private static func invoke(
        workdir: String, argv: [String], timeoutMs: Int
    ) -> Result<Any, GatewayError> {
        let owned: [UnsafeMutablePointer<CChar>?] = argv.map { strdup($0) }
        defer { for pointer in owned { if let pointer { free(pointer) } } }
        var pointers: [UnsafePointer<CChar>?] = owned.map { UnsafePointer($0) }
        pointers.append(nil)
        var error: UnsafeMutablePointer<CChar>?
        let json = pointers.withUnsafeBufferPointer { buffer in
            dsh_ish_run(workdir, buffer.baseAddress, Int32(clamping: timeoutMs), &error)
        }
        guard let json else {
            return .failure(Self.failure(message(error, "guest run failed")))
        }
        defer { free(json) }
        guard let text = String(validatingUTF8: json),
              let payload = (try? JSONSerialization.jsonObject(with: Data(text.utf8)))
                as? [String: Any]
        else {
            return .failure(Self.failure("unreadable result"))
        }
        return .success(payload)
    }

    /// The engine's malloc'd error message, freed here; its NULL means "no
    /// message" (the C seam's shape).
    private static func message(
        _ error: UnsafeMutablePointer<CChar>?, _ fallback: String
    ) -> String {
        guard let error else { return fallback }
        defer { free(error) }
        return String(cString: error)
    }

    private static func invalid(_ message: String) -> GatewayError {
        GatewayError(code: "invalid", primitive: "ishRun", message: message)
    }

    /// The engine could not be made to run the program (or was never up): its
    /// own message, or the fallback when it had none to give.
    private static func failure(_ message: String) -> GatewayError {
        GatewayError(code: "io", primitive: "ishRun", message: message)
    }

    private static func denied(_ scope: String) -> GatewayError {
        GatewayError(code: "denied", primitive: "ishRun",
                     message: "scope not granted: \(scope)")
    }
}
