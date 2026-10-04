// dsh:logging-exempt (shim layer; state plumbing, no logging surface)
/**
 * upstream/shims/fs-workspace.js — the WRITABLE WORKSPACE VFS half of the
 * node:fs shim (split from fs.js at the 2026-09-22 file-size gate): one
 * pinned in-memory root, file entries + explicit directories, a monotonic
 * version clock, and the mutating/read ops; fs.js keeps the node:fs API
 * surface, this module the world fs-local mounts.
 */

/* The WRITABLE WORKSPACE VFS (the FILE-TOOLS row's world): one pinned root;
 * file entries + explicit directories on the global (multi-instance note
 * above). Every mutation bumps a monotonic clock so file versions
 * (dev:ino:size:mtimeNs:ctimeNs — fs-local's stale-write-guard hash) change
 * on write and hold steady. */

/** The ENOENT shape (mirrors fs.js's — importing it here would cycle). */
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
 * Pin the writable workspace root (the composition mounting fs-local passes
 * its `Config.cwd`); every workspace op before the pin fails loud — a write
 * without a world is a defect, not an empty result.
 *
 * When the requested root is the PROFILE CONTAINER's tmp (`<cwd>/tmp`,
 * `<cwd>` pinned as __dshProfileCwd — the suite driver's spelling), the
 * CONTAINER is pinned instead: it is the unit of writability on this host,
 * and its home subtree (`<cwd>/home/.dsh/.agent-presets`) must be traversable
 * — the upstream user-root suite discovers presets there.
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
    // path → tracked directory mode (the agent-presets copy stats a
    // tightened tree back to 0700); stored, unenforced — no permission gate.
    dirModes: new Map(),
    symlinks: new Map(), // path → raw target string (readlink returns it verbatim)
    nextIno: 1,
    clock: 0,
  };
  // The EFFECTIVE root joins the explicit dir set: when the profile pin
  // widens the caller's tmp spelling to the container, the container itself
  // must stat() as a directory (subagent cwd gate; else ENOENT — R3-G1).
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
 * '/tmp' or '/tmp/' prefix maps (never '/tmpfoo').
 *
 * The REVERSE half (W8): on darwin /tmp symlinks to /private/tmp, so
 * answers crossing BACK from the real-disk side (a child's getcwd/git
 * rev-parse, a C-seam error path) spell the container `/private/tmp/<c>`.
 * The translation holds END-TO-END only if the VFS re-accepts that
 * OS-resolved spelling, so exactly the `/private<container>` prefix maps
 * back onto the container — nothing else is ours to rename. */
export const systemTmp = (path) => {
  if (typeof path !== 'string') return path;
  const profileCwd = globalThis.__dshProfileCwd;
  if (typeof profileCwd !== 'string' || profileCwd.length <= 1) return path;
  const container = profileCwd.replace(/\/$/, '');
  const state = workspace();
  if (state === null || state.root !== container) return path;
  // Already inside: translating its OWN /tmp prefix doubled it (root/tmp/root
  // — statSync ENOENTed, R3-G1).
  if (path === container || path.startsWith(`${container}/`)) return path;
  // The darwin OS-resolved spelling of the container itself (see above).
  const realContainer = `/private${container}`;
  if (path === realContainer) return container;
  if (path.startsWith(`${realContainer}/`)) return `${container}${path.slice(realContainer.length)}`;
  const real = `${container}/tmp`;
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
  // Relative paths resolve against the pinned profile cwd, like node's
  // process.cwd() (W3-K: the typert generator's relative join — refusing
  // relative paths killed the spec).
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

/** The refusal suffix that teaches the anchor (loop-h). Lives HERE, not
 * fs-paths.js: that import edge re-orders the shim cycle (TDZ at boot).
 * loop-w: DEGRADES to '' when no workspace is mounted — a refusal never
 * masks itself with the mount error; every caller shares the rule. */
export const wsRootHint = (path) => {
  const state = workspace();
  if (state === null) return '';
  const root = state.root;
  const anchored = typeof path === 'string' && path.startsWith('/')
    ? `${root}${path.replace(/\/+$/, '')}`
    : `${root}/file.txt`;
  return ` — the writable workspace root is '${root}'; file paths must be absolute under it (maybe you meant '${anchored}'?)`;
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

export const notifyWatches = (path) => {
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

/** Build one stat/dirent-shaped object: the classifier methods live on a
 * PER-CALL PROTOTYPE (node puts Stats/Dirent methods on the class
 * prototype), so the object's OWN keys are data only. This is load-bearing
 * for the worker-threads structured clone (W4-N): node's clone serializes
 * own properties, and the vendored migration verifier posts a stat
 * `identity` back from the worker — own-function members would throw the
 * clone while node's real face never could. */
const statFace = (kind, data) => (
  Object.assign(Object.create({
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => kind === 'symlink',
  }), data));

/** Stat shape for one workspace path; null when absent. `bigint` asks for the
 * node bigint face (dev/ino/mode/mtimeNs/ctimeNs as BigInt — what the
 * vendored fs-local probes with `{bigint: true}`). */
const wsStatAt = (path, bigint) => {
  const at = wsAt(path);
  if (at === null) return null;
  const file = at.state.files.get(at.path);
  if (file !== undefined) {
    return statFace('file', {
      size: bigint ? BigInt(file.bytes.length) : file.bytes.length,
      // The number face carries the permission bits (spill/aging stat().mode
      // vs the 0700/0644 constants) and dev/ino (the v2 rename-identity assert).
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
    });
  }
  if (!wsIsDirAt(path)) return null;
  const dirIno = at.state.dirIno.get(at.path) ?? 0;
  // The tracked chmod (see dirModes in mountWorkspace), else the default.
  const dirMode = at.state.dirModes?.get(at.path) ?? DIR_MODE;
  return statFace('dir', {
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
  });
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

// The mutation faces live in fs-workspace-write.js (the file crossed the
// size budget); re-exported here so every existing import — fs.js's and
// fs-promises's whole surface — keeps its specifier.
import { wsMkdir as wsMkdirCore, wsWriteFile, wsRm, wsResolveSymlinkChain } from 'upstream/shims/fs-workspace-write.js';
import { wsRename as wsRenameCore, wsLink, wsChmod, wsUtimes } from 'upstream/shims/fs-workspace-rename.js';
import { wsSymlink } from 'upstream/shims/fs-workspace-write.js';

/** Real-disk rename mirror (W8 cwd/tmp-fidelity). The VFS rename re-keys its
 * maps only — the workspace-write round mirrored write/rm/mkdir/chmod but
 * left rename's real side unmoved, so a moved file lingered under the old
 * name on the disk the seam's children read and never appeared at the new
 * one (measured: workspace-changes' turn diff lost the same.txt → moved.txt
 * rename entirely — real git saw the file unchanged). After the core
 * re-key, whatever the VFS now holds at the DESTINATION (one file or a
 * subtree) is the rename's payload: the real source is removed and the
 * destination re-materialized from the moved entries. Best-effort like the
 * sibling mirrors — the VFS stays the world of record. */
const writeRealFile = (path, bytes) => {
  if (typeof path !== 'string' || !path.startsWith('/') || !(bytes instanceof Uint8Array)
      || bytes.length > 8 * 1024 * 1024) return;
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  globalThis.__dshProcWriteFileReal?.(path, btoa(bin));
};

const mirrorRenameReal = (state, sourcePath, destPath) => {
  try {
    const destFile = state.files.get(destPath);
    if (destFile !== undefined) {
      globalThis.__dshProcRmReal?.(sourcePath, false);
      writeRealFile(destPath, destFile.bytes);
      return;
    }
    if (state.dirs.has(destPath)) {
      globalThis.__dshProcRmReal?.(sourcePath, true);
      globalThis.__dshProcMkdirReal?.(destPath);
      const prefix = `${destPath}/`;
      for (const [key, entry] of state.files) {
        if (key.startsWith(prefix)) writeRealFile(key, entry.bytes);
      }
    }
  } catch { /* structural mirror is best-effort */ }
};

export const wsRename = (from, to) => {
  const source = wsAt(from);
  const dest = wsAt(to);
  const result = wsRenameCore(from, to);
  if (source !== null && dest !== null) {
    mirrorRenameReal(source.state, source.path, dest.path);
  }
  return result;
};

/** The mkdir faces' real-disk awareness (W8 cwd/tmp-fidelity). The
 * workspace-write round's core mkdir is VFS-blind in two ways the real-disk
 * mirror exposes: (1) an ancestor directory only the REAL side has (real git
 * children's .git) makes the parent-exists gate ENOENT; (2) a FILE occupying
 * an ancestor segment is skipped silently under recursive instead of node's
 * ENOTDIR (measured: workspace-changes git.spec's bad-index mkdir ENOENTed
 * and its store-file scratch resolved instead of rejecting). The wrapper
 * materializes real-only ancestors as tracked dirs and refuses file-occupied
 * prefixes BEFORE the core runs — every consumer imports through this
 * specifier, so the wrap covers the sync, promises, and mkdirSync faces. */
const realStat = (path) => {
  try {
    return globalThis.__dshProcStatReal?.(path) ?? null;
  } catch { return null; }
};

export const wsMkdir = (path, options = {}) => {
  const at = wsAt(path);
  if (at !== null) {
    const { state } = at;
    const canonical = wsResolveSymlinkChain(state, at.path);
    let end = canonical.indexOf('/', state.root.length + 1);
    while (end > 0) {
      const dir = canonical.slice(0, end);
      if (state.files.has(dir)) {
        const error = new Error(`ENOTDIR: not a directory, mkdir '${canonical}'`);
        error.code = 'ENOTDIR';
        error.errno = -20;
        error.syscall = 'mkdir';
        error.path = canonical;
        throw error;
      }
      if (!state.dirs.has(dir) && !wsIsDirAt(dir) && realStat(dir)?.isDirectory === true) {
        state.dirs.add(dir);
        state.dirIno.set(dir, state.nextIno++);
      }
      const next = canonical.indexOf('/', end + 1);
      if (next <= 0) break;
      end = next;
    }
  }
  return wsMkdirCore(path, options);
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
  statFace,
  wsReaddirAt,
  wsEnoent,
  wsEexist,
  wsEnotdir,
  wsWriteFile,
  wsRm,
  wsLink,
  wsChmod,
  wsUtimes,
  wsSymlink,
  wsReadlinkAt,
  resolveSymlinkAt,
};
