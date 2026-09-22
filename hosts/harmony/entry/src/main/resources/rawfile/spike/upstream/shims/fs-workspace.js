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
 * @param root - absolute POSIX path prefix, e.g. `/workspace`.
 */
export const mountWorkspace = (root) => {
  if (typeof root !== 'string' || !root.startsWith('/') || root === '/' || root.endsWith('/')) {
    throw new Error(`node:fs: mountWorkspace needs an absolute POSIX root without a trailing slash, got ${JSON.stringify(root)}`);
  }
  globalThis.__DSH_WORKSPACE_FS__ = {
    root,
    files: new Map(), // path → { bytes: Uint8Array, mode, ino, mtimeNs: bigint, ctimeNs: bigint }
    dirs: new Set(), // explicit directory paths (the root itself included)
    dirIno: new Map(), // path → stable inode
    nextIno: 1,
    clock: 0,
  };
  ws().dirs.add(root);
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

/** The workspace state for an absolute path inside the pinned root, else null.
 * Relative paths never reach the workspace: every fs-local caller resolves
 * against its config cwd (absolute) before touching the seam. */
const wsAt = (path) => {
  const state = workspace();
  if (state === null || typeof path !== 'string' || !path.startsWith('/')) return null;
  const canonical = lexical(path);
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
      mtimeMs: Number(file.mtimeNs) / 1e6,
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
  return {
    isFile: () => false,
    isDirectory: () => true,
    isSymbolicLink: () => false,
    size: bigint ? 0n : 0,
    mtimeMs: 0,
    ...(bigint ? {
      dev: 1n,
      ino: BigInt(dirIno),
      mode: BigInt(DIR_MODE),
      mtimeNs: 0n,
      ctimeNs: 0n,
    } : {}),
  };
};

/** One level of workspace directory names, sorted; null when the path is not
 * a workspace directory. */
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
 * entry is EEXIST. Returns the first directory created, or undefined. */
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
  const segs = canonical === state.root
    ? [canonical]
    : canonical.slice(state.root.length).split('/').filter(Boolean)
        .map((seg, index, all) => `${state.root}${'/' + all.slice(0, index + 1).join('/')}`);
  let first;
  for (const dir of segs) {
    if (state.files.has(dir)) throw wsEnotdir('mkdir', dir);
    if (!state.dirs.has(dir)) {
      state.dirIno.set(dir, state.nextIno++);
      state.dirs.add(dir);
      first = first ?? dir;
    }
  }
  return first;
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
  const existing = state.files.get(canonical);
  if (existing !== undefined) {
    existing.bytes = bytes;
    existing.mtimeNs = bumpClock(state);
    if (typeof mode === 'number') existing.mode = mode;
    return canonical;
  }
  wsCreateFile(state, canonical, bytes, mode);
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
    return;
  }
  if (state.dirs.has(canonical)) {
    if (options.recursive !== true) {
      const error = new Error(`ENOTEMPTY: directory not empty, rm '${canonical}'`);
      error.code = 'ENOTEMPTY';
      error.syscall = 'rm';
      error.path = canonical;
      throw error;
    }
    const prefix = `${canonical}/`;
    for (const key of [...state.files.keys()]) {
      if (key.startsWith(prefix)) state.files.delete(key);
    }
    for (const dir of [...state.dirs]) {
      if (dir.startsWith(prefix)) {
        state.dirs.delete(dir);
        state.dirIno.delete(dir);
      }
    }
    if (canonical !== state.root) {
      state.dirs.delete(canonical);
      state.dirIno.delete(canonical);
    }
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
  if (state.files.has(source.path)) {
    const entry = state.files.get(source.path);
    state.files.delete(source.path);
    entry.mtimeNs = bumpClock(state);
    entry.ctimeNs = entry.mtimeNs;
    state.files.set(dest, entry);
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

/** Hard-link create-if-absent: bytes shared by copy (the VFS has no inodes to
 * share), destination must not exist. */
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
  // Directory modes are tracked but unenforced (the VFS has no permission
  // gate; contract/primitives.md — paths are paths).
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
};
