// dsh:logging-exempt (shim layer; state plumbing, no logging surface)
/**
 * upstream/shims/fs-workspace.js — the WRITABLE WORKSPACE VFS half of the
 * node:fs shim (split from fs.js at the 2026-09-22 file-size gate): one
 * pinned in-memory root, file entries + explicit directories, a monotonic
 * version clock, and the mutating/read operations over them. fs.js keeps
 * the node:fs API surface and the seeded read-only view; this module owns
 * the world fs-local mounts (mountWorkspace).
 */

/* ---------------------------------------------------------------------- *
 * The WRITABLE WORKSPACE VFS (the FILE-TOOLS row's world).
 *
 * One pinned root; a Map of file entries and a Set of directory paths, all
 * on the global (see the multi-instance note above). Every mutation bumps a
 * monotonic clock so file versions (dev:ino:size:mtimeNs:ctimeNs — what the
 * vendored fs-local hashes into its stale-write guards) change on write and
 * hold steady across reads.
 * ---------------------------------------------------------------------- */

/** The ENOENT shape (mirrors fs.js's — this module cannot import from it
 * without a cycle: fs.js imports this module for the workspace faces). */
const enoent = (name, path) => {
  const error = new Error(`ENOENT: no such file or directory, ${name} '${path}'`);
  error.code = 'ENOENT';
  error.errno = -2;
  error.syscall = name;
  error.path = path;
  return error;
};

const workspace = () => {
  if (typeof globalThis.__DSH_WORKSPACE_FS__ === 'undefined') {
    globalThis.__DSH_WORKSPACE_FS__ = null;
  }
  return globalThis.__DSH_WORKSPACE_FS__;
};

/**
 * Pin the writable workspace root. Called by the composition that mounts the
 * vendored fs-local backend (its `Config.cwd` names the same root); every
 * workspace op before the pin fails loud — a write without a world is a
 * defect, not an empty result.
 *
 * When the requested root is the PROFILE CONTAINER's tmp (`<cwd>/tmp` with
 * `<cwd>` pinned as __dshProfileCwd — the suite driver's spelling), the
 * CONTAINER is pinned instead: the container is the unit of writability on
 * this host, and its home subtree (the derived harness-home preset root
 * `<cwd>/home/.dsh/.agent-presets`) must be traversable too — the upstream
 * user-root suite discovers presets there. mkdtemp/tmpdir-derived paths stay
 * in-root either way.
 * @param root - absolute POSIX path prefix, e.g. `/workspace`.
 */
export const mountWorkspace = (root) => {
  if (typeof root !== 'string' || !root.startsWith('/') || root === '/' || root.endsWith('/')) {
    throw new Error(`node:fs: mountWorkspace needs an absolute POSIX root without a trailing slash, got ${JSON.stringify(root)}`);
  }
  const profileCwd = globalThis.__dshProfileCwd;
  const effective = typeof profileCwd === 'string' && profileCwd.length > 1
    && root === `${profileCwd.replace(/\/$/, '')}/tmp`
    ? profileCwd.replace(/\/$/, '')
    : root;
  globalThis.__DSH_WORKSPACE_FS__ = {
    root: effective,
    files: new Map(), // path → { bytes: Uint8Array, mode, ino, mtimeNs: bigint, ctimeNs: bigint }
    dirs: new Set(), // explicit directory paths (the root itself included)
    dirIno: new Map(), // path → stable inode
    // path → tracked directory mode: chmod on a directory is stored (the
    // agent-presets copy tightens a copied tree to 0700 and stats it back),
    // though still unenforced — the VFS has no permission gate.
    dirModes: new Map(),
    symlinks: new Map(), // path → raw target string (readlink returns it verbatim)
    nextIno: 1,
    clock: 0,
  };
  // The EFFECTIVE root enters the explicit dir set: when the profile pin
  // widens the caller's tmp spelling to the container, the container itself
  // must stat() as a directory (the subagent cwd gate stats the profile
  // root; with the caller's spelling in the set, statSync(root) ENOENTed —
  // R3-G1 2026-09-28).
  ws().dirs.add(effective);
  return root;
};

/** Lexically resolve `.`/`..` segments of an absolute path (no disk). */
const lexical = (path) => {
  const out = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return `/${out.join('/')}`;
};

/** The SYSTEM-TMP translation (2026-09-27 suite round): upstream code — and
 * its tests — spell staging dirs with the bare desktop '/tmp/...' spelling
 * (the ssh/llm families literally hardcode `/tmp/dsh-<name>-`). On this host
 * the system tmp IS the profile container's tmp (os.tmpdir() =
 * <container>/tmp), so a bare '/tmp'-rooted path resolves onto it and both
 * spellings land in the SAME writable place, instead of the hardcoded one
 * failing the root gate. Guarded: only when the workspace root is the
 * profile container (the suite driver's mount spelling) and only the exact
 * '/tmp' or '/tmp/' prefix maps (never '/tmpfoo'). */
const systemTmp = (path) => {
  if (typeof path !== 'string' || !path.startsWith('/tmp')) return path;
  const profileCwd = globalThis.__dshProfileCwd;
  if (typeof profileCwd !== 'string' || profileCwd.length <= 1) return path;
  const state = workspace();
  if (state === null || state.root !== profileCwd.replace(/\/$/, '')) return path;
  // Already inside the container: the container itself lives under /tmp on
  // the desktop CLI, and naively translating its OWN prefix doubled it
  // (root/tmp/root — statSync(root) ENOENTed, R3-G1 2026-09-28).
  if (path === profileCwd || path.startsWith(`${profileCwd}/`)) return path;
  const real = `${profileCwd.replace(/\/$/, '')}/tmp`;
  if (path === '/tmp') return real;
  if (path.startsWith('/tmp/')) return `${real}${path.slice(4)}`;
  return path;
};

/** The workspace state for an absolute path inside the pinned root, else null.
 * Relative paths never reach the workspace: every fs-local caller resolves
 * against its config cwd (absolute) before touching the seam.
 * A NUL byte in a path is the OS boundary no string survives — node throws
 * TypeError ERR_INVALID_ARG_VALUE at the syscall gate BEFORE any lookup
 * (measured 2026-09-28: credentials-local "propagates a permission check
 * rejected before the OS lookup" boots a `name\0` path and expects the
 * rejection). This is the one choke point every workspace op flows through. */
const wsAt = (path) => {
  if (typeof path === 'string' && path.includes('\0')) {
    const error = new TypeError(`The argument 'path' must be a string or Uint8Array without null bytes. Received type string ('${path}')`);
    error.code = 'ERR_INVALID_ARG_VALUE';
    throw error;
  }
  const state = workspace();
  // Relative paths resolve against the pinned profile cwd, exactly like
  // node resolves them against process.cwd() (W3-K, 2026-09-28: the typert
  // generator joins `import.meta.dirname` — 'upstream-tests', the
  // bundle-relative module directory — with its scratch dir and the join
  // stays relative; refusing relative paths there killed the whole spec).
  let absolute = path;
  if (typeof absolute === 'string' && !absolute.startsWith('/') && !absolute.startsWith('\\')
    && !/^[A-Za-z][A-Za-z0-9+.\-]*:/.test(absolute)) {
    const cwd = globalThis.__dshProfileCwd;
    if (typeof cwd === 'string' && cwd.startsWith('/')) {
      absolute = `${cwd.replace(/\/$/, '')}/${absolute}`;
    }
  }
  if (state === null || typeof absolute !== 'string' || !absolute.startsWith('/')) return null;
  const canonical = lexical(systemTmp(absolute));
  if (canonical !== state.root && !canonical.startsWith(`${state.root}/`)) return null;
  return { state, path: canonical };
};

const ws = () => {
  const state = workspace();
  if (state === null) {
    throw new Error('node:fs: the writable workspace is not mounted — call mountWorkspace(root) before file operations (see runtime/spike/upstream/README.md, FILE-TOOLS row)');
  }
  return state;
};

const bumpClock = (state) => {
  state.clock += 1;
  return BigInt(state.clock) * 1000000n; // a distinct nanosecond stamp per mutation
};

/* ---- watch registry (the chokidar shim's event source) -------------------
 * The workspace VFS is in-memory, so an fs watcher needs no OS seam: every
 * mutation funnels through wsWriteFile/wsRm/wsRename, and those notify the
 * registered watchers whose watched path matches the canonical mutated path.
 * Event-driven (D8): a write IS the event — no polling, no timers. */
const watchRegistry = new Set(); // { path, notify }

/** Register a mutation watcher for one canonical workspace path. Returns the
 * unwatch function. Consumer: the chokidar linkage shim (npm-bridges.js)
 * serving settings-file's document watcher. */
export const wsWatch = (path, notify) => {
  const entry = { path, notify };
  watchRegistry.add(entry);
  return () => watchRegistry.delete(entry);
};

const notifyWatches = (path) => {
  if (watchRegistry.size === 0) return;
  for (const entry of [...watchRegistry]) {
    if (entry.path !== path) continue;
    try { entry.notify(path); } catch { /* a throwing watcher must not corrupt the mutation */ }
  }
};


const wsCreateFile = (state, path, bytes, mode) => {
  const now = bumpClock(state);
  state.files.set(path, {
    bytes,
    mode: typeof mode === 'number' ? mode : 0o100644 & 0o777,
    ino: state.nextIno++,
    mtimeNs: now,
    ctimeNs: now,
  });
};

/** The workspace file entry at an absolute in-root path, else undefined. */
const wsFileAt = (path) => {
  const at = wsAt(path);
  if (at === null) return undefined;
  return at.state.files.get(at.path);
};

/** Whether the path is an explicit workspace directory (or an implied one —
 * any prefix of a stored file). */
const wsIsDirAt = (path) => {
  const at = wsAt(path);
  if (at === null) return false;
  if (at.state.dirs.has(at.path)) return true;
  const prefix = `${at.path}/`;
  for (const key of at.state.files.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
};

const DIR_MODE = 0o40755 & 0o777;

/** Stat shape for one workspace path; null when absent. `bigint` asks for the
 * node bigint face (dev/ino/mode/mtimeNs/ctimeNs as BigInt — what the
 * vendored fs-local probes with `{bigint: true}`). */
const wsStatAt = (path, bigint) => {
  const at = wsAt(path);
  if (at === null) return null;
  const file = at.state.files.get(at.path);
  if (file !== undefined) {
    return {
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      size: bigint ? BigInt(file.bytes.length) : file.bytes.length,
      // The number face carries the permission bits too (the spill/aging
      // walks stat().mode and compare against the 0700/0644 constants), and
      // dev/ino like node's non-bigint stat (the v2 migration asserts a
      // rename preserved the predecessor's identity, measured 2026-09-27).
      dev: 1,
      ino: file.ino,
      mode: file.mode,
      uid: 0,
      gid: 0,
      mtimeMs: Number(file.mtimeNs) / 1e6,
      ctimeMs: Number(file.ctimeNs) / 1e6,
      ...(bigint ? {
        dev: 1n,
        ino: BigInt(file.ino),
        mode: BigInt(file.mode),
        mtimeNs: file.mtimeNs,
        ctimeNs: file.ctimeNs,
      } : {}),
    };
  }
  if (!wsIsDirAt(path)) return null;
  const dirIno = at.state.dirIno.get(at.path) ?? 0;
  // The tracked chmod (see dirModes in mountWorkspace), else the default.
  const dirMode = at.state.dirModes?.get(at.path) ?? DIR_MODE;
  return {
    isFile: () => false,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    size: bigint ? 0n : 0,
    dev: 1,
    ino: dirIno,
    mode: dirMode,
    uid: 0,
    gid: 0,
    mtimeMs: 0,
    ...(bigint ? {
      dev: 1n,
      ino: BigInt(dirIno),
      mode: BigInt(dirMode),
      mtimeNs: 0n,
      ctimeNs: 0n,
    } : {}),
  };
};

/** One level of workspace directory names, sorted; null when the path is not
 * a workspace directory. Symlink entries list alongside files (they are
 * directory members; the walk classifies them through dirent/lstat). */
const wsReaddirAt = (path) => {
  const at = wsAt(path);
  if (at === null) return null;
  const prefix = `${at.path}/`;
  if (!wsIsDirAt(path)) return null;
  const names = new Set();
  for (const key of at.state.files.keys()) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf('/');
    names.add(slash === -1 ? rest : rest.slice(0, slash));
  }
  for (const key of at.state.symlinks.keys()) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf('/');
    names.add(slash === -1 ? rest : rest.slice(0, slash));
  }
  for (const dir of at.state.dirs.keys()) {
    if (dir === at.path || !dir.startsWith(prefix)) continue;
    const rest = dir.slice(prefix.length);
    if (rest.length === 0) continue;
    const slash = rest.indexOf('/');
    names.add(slash === -1 ? rest : rest.slice(0, slash));
  }
  return names.size > 0 ? [...names].sort() : [];
};

const wsEnoent = (call, path) => enoent(call, path);

const wsEexist = (call, path) => {
  const error = new Error(`EEXIST: file already exists, ${call} '${path}'`);
  error.code = 'EEXIST';
  error.syscall = call;
  error.path = path;
  return error;
};

const wsEnotdir = (call, path) => {
  const error = new Error(`ENOTDIR: not a directory, ${call} '${path}'`);
  error.code = 'ENOTDIR';
  error.syscall = call;
  error.path = path;
  return error;
};

/** Create a directory. `{recursive: true}` creates missing parents and never
 * errors on an existing directory (node's contract); without it, an existing
 * entry is EEXIST. `options.mode` tracks on the FINAL created directory
 * through dirModes (node: intermediates of a recursive mkdir keep the
 * default; the caller's bits land on the leaf) — the atomic-write
 * credentials contract creates its document directory owner-only (0o700) and
 * the review-fixes spec stats it back (R3-G1, 2026-09-28). Returns the first
 * directory created, or undefined. */
const wsMkdir = (path, options = {}) => {
  const at = wsAt(path);
  if (at === null) {
    throw new Error(`node:fs.mkdir: path outside the writable workspace root: ${path}`);
  }
  const { state, path: canonical } = at;
  if (state.files.has(canonical)) {
    if (options.recursive === true) return undefined;
    throw wsEexist('mkdir', canonical);
  }
  if (options.recursive !== true && (state.dirs.has(canonical) || wsIsDirAt(canonical))) {
    throw wsEexist('mkdir', canonical);
  }
  // node: WITHOUT recursive, mkdir creates exactly ONE segment and the
  // PARENT must already exist (missing parent = ENOENT — the browse picker's
  // createDirectory maps that to directory-create-failed; the VFS's implied
  // parents made it silently succeed, R3-G1 2026-09-28). Recursive walks the
  // missing chain like node's mkdirp.
  const parent = canonical.slice(0, canonical.lastIndexOf('/'));
  const parentOk = parent === state.root || state.dirs.has(parent) || wsIsDirAt(parent);
  if (options.recursive !== true && !parentOk) throw wsEnoent('mkdir', canonical);
  const segs = options.recursive === true
    ? (canonical === state.root
      ? [canonical]
      : canonical.slice(state.root.length).split('/').filter(Boolean)
          .map((seg, index, all) => `${state.root}${'/' + all.slice(0, index + 1).join('/')}`))
    : [canonical];
  let first;
  for (const dir of segs) {
    if (state.files.has(dir)) {
      if (options.recursive === true) continue;
      throw wsEexist('mkdir', dir);
    }
    if (!state.dirs.has(dir)) {
      state.dirIno.set(dir, state.nextIno++);
      state.dirs.add(dir);
      if (typeof options.mode === 'number' && dir === canonical) state.dirModes.set(dir, options.mode);
      first = first ?? dir;
    }
  }
  return first;
};

/** A written `.js`/`.mjs` registers as a runtime-defined module under its
 * `file:` URL — the __dshModuleDefine seam the host loader consults FIRST
 * (R3-G1, 2026-09-28). The vendored cordis loader chain imports composition
 * rows by dynamic `import('file:///…')` (boot__cmdline's spec, the bundle
 * startup specs, and cordis-plugin-include all write a plugin file into the
 * workspace at test time and hand its pathToFileURL to the loader); without
 * this registration the host has no such module and every entry fails
 * "cannot load module 'file:///…'". Mirrors fs.js defineSeededModule for the
 * WRITABLE half (that one serves the seeded read-only view). Both spellings
 * register: the caller's lexical spelling (a hardcoded `/tmp/...` maps onto
 * the container tmp via systemTmp, so the importer's URL keeps the `/tmp`
 * prefix) and the workspace-canonical one. Idempotent: define() replaces. */
const defineWrittenModule = (callerPath, canonical, bytes) => {
  if (!/\.(js|mjs)$/.test(canonical)) return;
  const define = globalThis.__dshModuleDefine;
  if (typeof define !== 'function') return;
  let text;
  try {
    text = new TextDecoder().decode(bytes);
  } catch {
    return; // non-UTF-8 bytes are never a servable module
  }
  const lexicalCaller = lexical(callerPath);
  define.call(globalThis, `file://${canonical}`, text);
  if (lexicalCaller !== canonical) define.call(globalThis, `file://${lexicalCaller}`, text);
};

/** Write file bytes (create or replace). Parents must already exist — the
 * fs-local write path always mkdirs them first, and node's writeFile would
 * ENOENT too. */
const wsWriteFile = (path, bytes, mode) => {
  const at = wsAt(path);
  if (at === null) {
    throw new Error(`node:fs.writeFile: path outside the writable workspace root: ${path}`);
  }
  const { state, path: canonical } = at;
  // A FILE occupying an ancestor segment is ENOTDIR, like node's open(2)
  // (measured 2026-09-28: identity's anonymous-user-id writes INTO a
  // file-path home and expects the write refused so nothing persists). Every
  // PROPER ancestor prefix checks — including the parent (the final slash's
  // slice) — while the full path itself never does, so overwriting an
  // existing file stays the replace flow.
  let ancestorEnd = canonical.indexOf('/', state.root.length + 1);
  while (ancestorEnd > 0) {
    if (state.files.has(canonical.slice(0, ancestorEnd))) throw wsEnotdir('open', canonical);
    const next = canonical.indexOf('/', ancestorEnd + 1);
    if (next <= 0) break;
    ancestorEnd = next;
  }
  // A directory occupying the path is EISDIR, like node's writeFile
  // (measured 2026-09-27: storage-json makes the publish target a directory
  // to force the atomic-replacement failure its rollback test needs).
  if (state.dirs.has(canonical) || (state.files.has(canonical) === false && wsIsDirAt(canonical))) {
    const error = new Error(`EISDIR: illegal operation on a directory, open '${canonical}'`);
    error.code = 'EISDIR';
    error.errno = -21;
    error.syscall = 'open';
    error.path = canonical;
    throw error;
  }
  const existing = state.files.get(canonical);
  if (existing !== undefined) {
    existing.bytes = bytes;
    existing.mtimeNs = bumpClock(state);
    if (typeof mode === 'number') existing.mode = mode;
    defineWrittenModule(path, canonical, bytes);
    notifyWatches(canonical);
    return canonical;
  }
  wsCreateFile(state, canonical, bytes, mode);
  defineWrittenModule(path, canonical, bytes);
  notifyWatches(canonical);
  return canonical;
};

/** Remove a file or a directory subtree. `force` swallows ENOENT (node). */
const wsRm = (path, options = {}) => {
  const at = wsAt(path);
  if (at === null) {
    throw new Error(`node:fs.rm: path outside the writable workspace root: ${path}`);
  }
  const { state, path: canonical } = at;
  if (state.files.has(canonical)) {
    state.files.delete(canonical);
    notifyWatches(canonical);
    return;
  }
  if (state.dirs.has(canonical)) {
    if (options.recursive !== true) {
      // Plain rmdir (node): succeeds ONLY on an empty directory — any
      // tracked file or subdir below it is ENOTEMPTY (W3-K, 2026-09-28: the
      // spill-local sweep rmdirs emptied session dirs; demanding recursive
      // here made every plain rmdir throw and left the dir entry alive, so
      // the prune assertions saw existsSync true).
      const prefix = `${canonical}/`;
      const hasChildren = [...state.files.keys()].some((k) => k.startsWith(prefix))
        || [...state.dirs].some((k) => k.startsWith(prefix));
      if (hasChildren) {
        const error = new Error(`ENOTEMPTY: directory not empty, rmdir '${canonical}'`);
        error.code = 'ENOTEMPTY';
        error.syscall = 'rmdir';
        error.path = canonical;
        throw error;
      }
      if (canonical !== state.root) {
        state.dirs.delete(canonical);
        state.dirIno.delete(canonical);
        state.dirModes?.delete(canonical);
        notifyWatches(canonical);
      }
      return;
    }
    const prefix = `${canonical}/`;
    for (const key of [...state.files.keys()]) {
      if (key.startsWith(prefix)) state.files.delete(key);
    }
    for (const dir of [...state.dirs]) {
      if (dir.startsWith(prefix)) {
        state.dirs.delete(dir);
        state.dirIno.delete(dir);
        state.dirModes?.delete(dir);
      }
    }
    if (canonical !== state.root) {
      state.dirs.delete(canonical);
      state.dirIno.delete(canonical);
      state.dirModes?.delete(canonical);
    }
    notifyWatches(canonical);
    return;
  }
  if (wsIsDirAt(canonical) && options.force === true) {
    // An implicit directory (children-only existence) can only vanish by
    // removing its children; force swallows that impossibility (node rm -f).
    return;
  }
  if (options.force !== true) throw wsEnoent('rm', canonical);
};

/** Rename within the workspace (files; a directory rename moves its subtree). */
const wsRename = (from, to) => {
  const source = wsAt(from);
  const target = wsAt(to);
  if (source === null || target === null) {
    throw new Error(`node:fs.rename: path outside the writable workspace root: ${from} -> ${to}`);
  }
  const { state } = source;
  const dest = target.path;
  // node's rename cross-checks: file onto an existing directory is EISDIR;
  // directory onto an existing non-directory is ENOTDIR.
  if (state.files.has(source.path) && (state.dirs.has(dest) || wsIsDirAt(dest))) {
    const error = new Error(`EISDIR: illegal operation on a directory, rename '${source.path}' -> '${dest}'`);
    error.code = 'EISDIR';
    error.errno = -21;
    error.syscall = 'rename';
    error.path = dest;
    throw error;
  }
  if (state.dirs.has(source.path) && state.files.has(dest)) {
    const error = new Error(`ENOTDIR: not a directory, rename '${source.path}' -> '${dest}'`);
    error.code = 'ENOTDIR';
    error.errno = -20;
    error.syscall = 'rename';
    error.path = dest;
    throw error;
  }
  if (state.files.has(source.path)) {
    const entry = state.files.get(source.path);
    state.files.delete(source.path);
    entry.mtimeNs = bumpClock(state);
    entry.ctimeNs = entry.mtimeNs;
    state.files.set(dest, entry);
    notifyWatches(source.path);
    notifyWatches(dest);
    return;
  }
  if (state.dirs.has(source.path)) {
    const prefix = `${source.path}/`;
    const moved = [];
    for (const [key, entry] of state.files) {
      if (key.startsWith(prefix)) moved.push([key, entry]);
    }
    for (const [key] of moved) state.files.delete(key);
    for (const [key, entry] of moved) state.files.set(dest + key.slice(source.path.length), entry);
    for (const dir of [...state.dirs]) {
      if (!dir.startsWith(prefix)) continue;
      state.dirs.delete(dir);
      const ino = state.dirIno.get(dir);
      state.dirIno.delete(dir);
      if (ino !== undefined) state.dirIno.set(dest + dir.slice(source.path.length), ino);
      const trackedMode = state.dirModes?.get(dir);
      if (trackedMode !== undefined) {
        state.dirModes.delete(dir);
        state.dirModes.set(dest + dir.slice(source.path.length), trackedMode);
      }
    }
    state.dirs.delete(source.path);
    const sourceIno = state.dirIno.get(source.path);
    state.dirIno.delete(source.path);
    if (sourceIno !== undefined) state.dirIno.set(dest, sourceIno);
    state.dirs.add(dest);
    return;
  }
  throw wsEnoent('rename', source.path);
};

/** Hard-link create-if-absent: bytes shared by copy, destination must not
 * exist. The LINK SHARES IDENTITY: node reports one dev+ino pair for every
 * name of a hard-linked object, and attachment-local's dedup contract
 * asserts the alias stat()s to the OBJECT's ino (measured 2026-09-28: two
 * distinct inos failed the identity assert, R3-G1). */
const wsLink = (sourcePath, destPath) => {
  const source = wsAt(sourcePath);
  const target = wsAt(destPath);
  if (source === null || target === null) {
    throw new Error(`node:fs.link: path outside the writable workspace root: ${sourcePath} -> ${destPath}`);
  }
  const { state } = source;
  const entry = state.files.get(source.path);
  if (entry === undefined) throw wsEnoent('link', source.path);
  if (state.files.has(target.path) || state.dirs.has(target.path)) throw wsEexist('link', target.path);
  wsCreateFile(state, target.path, entry.bytes.slice(), entry.mode);
  state.files.get(target.path).ino = entry.ino;
};

/** chmod on a workspace file or directory. */
const wsChmod = (path, mode) => {
  const at = wsAt(path);
  if (at === null) {
    throw new Error(`node:fs.chmod: path outside the writable workspace root: ${path}`);
  }
  const file = at.state.files.get(at.path);
  if (file !== undefined) {
    file.mode = typeof mode === 'number' ? mode : file.mode;
    return;
  }
  if (!at.state.dirs.has(at.path) && !wsIsDirAt(path)) throw wsEnoent('chmod', at.path);
  // Directory modes are tracked (tightenModes stats the 0700 back) but
  // unenforced — the VFS has no permission gate (contract/primitives.md §3).
  if (typeof mode === 'number') at.state.dirModes.set(at.path, mode);
};

/* ---- utimes + symlink faces (the 2026-09-27 suite round) ---------------- */

/** utimes on a workspace file: the seconds-since-epoch floats node accepts
 * become the entry's mtime (the mtime-based sweeps and spill aging read it
 * back through stat). Atime is accepted and not stored — nothing in the
 * closure reads atime. */
const wsUtimes = (path, atimeSeconds, mtimeSeconds) => {
  const at = wsAt(path);
  if (at === null) {
    throw new Error(`node:fs.utimes: path outside the writable workspace root: ${path}`);
  }
  const { state, path: canonical } = at;
  const entry = state.files.get(canonical);
  if (entry === undefined) {
    if (state.dirs.has(canonical) || state.symlinks?.has(canonical)) return;
    throw wsEnoent('utimes', canonical);
  }
  const ms = Number(mtimeSeconds);
  if (!Number.isFinite(ms)) {
    throw new TypeError(`node:fs.utimes: mtime must be a finite number, got ${String(mtimeSeconds)}`);
  }
  entry.mtimeNs = BigInt(Math.round(ms * 1000)) * 1000000n;
  entry.ctimeNs = entry.mtimeNs;
};

/** symlink(target, path) — store the raw target string; readers resolve one
 * hop through resolveSymlinkAt (fs.js). Node validates the parent directory;
 * the link itself may dangle. */
const wsSymlink = (target, path) => {
  const at = wsAt(path);
  if (at === null) {
    throw new Error(`node:fs.symlink: path outside the writable workspace root: ${path}`);
  }
  const { state, path: canonical } = at;
  if (state.files.has(canonical) || state.dirs.has(canonical)
      || state.symlinks.has(canonical) || wsIsDirAt(canonical)) {
    throw wsEexist('symlink', canonical);
  }
  if (typeof target !== 'string') {
    throw new TypeError(`node:fs.symlink: target must be a string, got ${typeof target}`);
  }
  state.symlinks.set(canonical, target);
  return undefined;
};

/** The stored target for a symlink path, or undefined when the path is not a
 * symlink (readlink turns that into EINVAL, node's spelling). */
const wsReadlinkAt = (path) => {
  const at = wsAt(path);
  if (at === null) return undefined;
  return at.state.symlinks?.get(at.path);
};

/** Resolve ONE symlink hop for readers (stat/read): a relative target joins
 * the link's directory; absolute targets stand alone. Undefined when the
 * path is not a symlink. */
const resolveSymlinkAt = (path) => {
  const target = wsReadlinkAt(path);
  if (target === undefined) return undefined;
  if (target.startsWith('/')) return lexical(target);
  const at = wsAt(path);
  const slash = at.path.lastIndexOf('/');
  const dir = slash <= 0 ? '/' : at.path.slice(0, slash);
  return lexical(`${dir}/${target}`);
};

export {
  workspace,
  wsAt,
  ws,
  lexical,
  DIR_MODE,
  bumpClock,
  wsCreateFile,
  wsFileAt,
  wsIsDirAt,
  wsStatAt,
  wsReaddirAt,
  wsEnoent,
  wsEexist,
  wsEnotdir,
  wsMkdir,
  wsWriteFile,
  wsRm,
  wsRename,
  wsLink,
  wsChmod,
  wsUtimes,
  wsSymlink,
  wsReadlinkAt,
  resolveSymlinkAt,
};
