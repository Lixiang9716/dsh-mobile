// dsh:logging-exempt (shim layer)
/**
 * node:fs shim — LOUD by default: the dsh runtime has no synchronous
 * filesystem; the gateway fs primitives are async and scope-confined per
 * contract/.
 *
 * Covers (upstream usage → this module):
 *   - dsh-sandbox (`accessSync`, `constants`, `realpathSync`, `statSync`) —
 *     the desktop sandbox's disk gate; mobile boundary = gateway fs scope
 *     (see runtime/dsh/upstream/README.md, mapping table). The names exist
 *     so the vendored module links; any CALL outside the staged views fails
 *     loud naming the seam.
 *
 * W-INTEG exception — the STAGED WEB-PLUGIN VFS. Composing the official web
 * boot requires @deepseek-ai/dsh-client-modules' node half, whose incremental
 * `dsh.client` scan reads package manifests and client bundles synchronously
 * (`existsSync` / `readFileSync` / `statSync`). The host stages that
 * scan-scoped file set and delivers it over the bus seam (`web.plugins`);
 * `seedWebPlugins` (fs-seeded.js — the seeded-view half, split 2026-09-29)
 * mounts it read-only under /web-plugins. Outside the seeded view the shim
 * stays loud exactly as before, with one boundary decision:
 * `existsSync` ANSWERS a question (never moves bytes), so it returns false
 * outside the VFS instead of throwing — upstream's nearest-package walk relies
 * on false to keep scanning. `readFileSync` / `statSync` still refuse loudly
 * outside the VFS roots; inside it, a missing file throws ENOENT (upstream
 * classifies failures by `error.code`).
 *
 * FILE-TOOLS exception — the WRITABLE WORKSPACE VFS. The vendored
 * @deepseek-ai/dsh-fs-local backend (the `ctx.fs` service the fs tool family
 * mounts over) is built on the node:fs promise APIs; its world here is a
 * fully in-memory tree rooted at ONE pinned workspace root (`mountWorkspace`,
 * called by the composition that mounts fs-local — the probe, then boot.js).
 * Every write op (mkdir/rename/link/rm/chmod/write) serves THAT root only and
 * refuses the seeded read-only views; reads serve seeded view + workspace.
 * The store lives on the GLOBAL, not module state: quickjs compiles the
 * node:fs-mapped shim and any bundle-relative import of this file as TWO
 * module instances, and a module-local store would silently fork (the same
 * reasoning as the seeded VFS above).
 *
 * Intentionally NOT supported: `accessSync`/`realpathSync` (the sandbox's
 * disk-gate calls — still loud: the workspace answers existence questions
 * through `existsSync` and `realpath`), the seeded views as write targets
 * (they stay read-only; the workspace is the one writable root), and the
 * fs-EVENT seam (`watch()` notify stays the wsWatch workspace face). The
 * stat-POLL face (`watchFile`/`unwatchFile`, loader-faces-fs-watch.js) is
 * REAL since the W8 round — a pure poll loop over the stat face, no event
 * seam claimed. The sync writes (writeFileSync/mkdirSync/rmSync/
 * mkdtempSync/symlinkSync/chmodSync/utimesSync) and the descriptor face
 * (openSync/writeSync/closeSync/unlinkSync/rmdirSync) are REAL workspace
 * operations since the 2026-09-27 suite round — same store as the promise
 * face, see the block comment at their definitions.
 */
import { DshBuffer, decodeUtf8, encodeUtf8, fromBase64 as fromBase64Real } from 'upstream/shims/buffer.js';
// The seeded-view half (split 2026-09-29, this file crossed the size budget):
// the staged read-only VFS's root facts (WEB_PLUGINS_ROOT, VFS_ROOTS), the
// global store accessor (vfs) and the three seed writers live in fs-seeded.js,
// which imports NOTHING from this file — a static import cycle between two
// runtime/shims files kills quickjs at link (measured). This side imports the
// names and re-exports them, so both the bare 'node:fs' map row and every
// bundle-path import keep their specifier.
import {
  WEB_PLUGINS_ROOT,
  VFS_ROOTS,
  seedWebPlugins,
  mergeWebPlugins,
  seedStagedFiles,
  vfs,
} from 'upstream/shims/fs-seeded.js';
export { WEB_PLUGINS_ROOT, seedWebPlugins, mergeWebPlugins, seedStagedFiles, vfs };

export const constants = {
  F_OK: 0,
  R_OK: 4,
  W_OK: 2,
  X_OK: 1,
  COPYFILE_EXCL: 1,
  COPYFILE_FICLONE: 2,
  COPYFILE_FICLONE_FORCE: 4,
  O_RDONLY: 0,
  O_WRONLY: 1,
  O_RDWR: 2,
  S_IFDIR: 0x4000,
  S_IFREG: 0x8000,
};

/** Normalize a path argument that node's fs accepts but our string-keyed
 * views cannot: a URL object (what `new URL('fixtures/x', import.meta.url)`
 * produces in the transpiled specs — measured 2026-09-28, the cordis.yml
 * fixture reads) stringifies to its plain in-world path. Strings pass
 * through untouched. */
export const asFsPath = (path) => {
  if (path !== null && typeof path === 'object' && typeof path.href === 'string') return String(path);
  return path;
};

export const underVFS = (path) => typeof path === 'string' && VFS_ROOTS.some((root) => path.startsWith(root));

export const refuse = (name) => (path) => {
  throw new Error(
    `node:fs.${name}: no synchronous filesystem in the dsh runtime — `
    + 'this path is a desktop host capability; on mobile the same boundary is the '
    + `gateway fs scope (see runtime/dsh/upstream/README.md)${path === undefined ? '' : ` [path: ${String(path)}]`}`);
};

export const enoent = (name, path) => {
  const error = new Error(`ENOENT: no such file or directory, ${name} '${path}'`);
  error.code = 'ENOENT';
  error.errno = -2;
  error.syscall = name;
  error.path = path;
  return error;
};

/* The writable workspace VFS lives in fs-workspace.js (split 2026-09-22):
 * the world mountWorkspace pins, its entries/clock, and the operations
 * over them. */
import {
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
  wsWatch,
  wsSymlink,
  wsReadlinkAt,
  resolveSymlinkAt,
  statFace,
} from 'upstream/shims/fs-workspace.js';
// loop-r: the real-disk seam's containment gate + the #358 read refusal it
// throws outside-root (split from fs-workspace.js at the code-size gate;
// call-time functions only — no new cycle risk, see the module's header).
import { realSeamInsideRoot, wsOutsideRootError } from 'upstream/shims/fs-seam-gate.js';
import { mountWorkspace } from 'upstream/shims/fs-workspace.js';
// The fs split (the file crossed the size budget): paths/realpath machinery
// in fs-paths.js, stat faces in fs-stat.js, the write faces + descriptor
// table in fs-writes.js, the write stream in fs-write-stream.js, readdir in
// fs-readdir.js. Every public face is re-exported here, so both the bare
// 'node:fs' map row and every bundle-path import keep their specifier; the
// siblings' references back into this module are call-time only (ESM-cycle
// safe), like the fs-workspace split before it.
import { resolveWorkspaceSymlink, realpathCallback } from 'upstream/shims/fs-paths.js';
import { createWriteStream, createReadStream } from 'upstream/shims/fs-write-stream.js';
import { statSync, lstatSync, accessSync, existsSync, realpathSync } from 'upstream/shims/fs-stat.js';
import {
  writeFileSync, mkdirSync, rmSync, mkdtempSync, chmodSync, utimesSync,
  symlinkSync, readlinkSync, openSync, writeSync, readSync, closeSync,
  copyFileSync, renameSync, cpSync, unlinkSync, rmdirSync,
} from 'upstream/shims/fs-writes.js';
import { readdirSync } from 'upstream/shims/fs-readdir.js';
// The stat-watcher face (W8, 2026-09-29): watchFile/unwatchFile are real
// poll loops over the stat face (loader-faces-fs-watch.js) — the vendored
// dsh-skill-filesystem lib imports them at link time, and the
// webworker-runtime fs-watch-stream spec diffs its own StatWatcher against
// these native faces. Without the exports the modules fail the LINK
// ("Could not find export 'unwatchFile' in module 'node:fs'").
import { watchFile, unwatchFile } from 'upstream/shims/loader-faces-fs-watch.js';
export { watchFile, unwatchFile };
// LAZY on purpose: this module is reachable under TWO names (the bare
// 'node:fs' map row and the bundle path the split siblings import). Under
// the bare entry the sibling cycle can still be mid-evaluation when this
// body runs — a direct initialization would read realpathCallback in its
// temporal dead zone (measured: 'realpathCallback is not initialized' at
// boot). Call-time resolution keeps the cycle safe; the arrow preserves the
// call signature (realpath(path, callback)).
// A function DECLARATION (not a const arrow): hoisted bindings initialize
// at module instantiation, so this stays safe under the bare/bundle dual
// instance even when the sibling cycle is still mid-evaluation (a const
// initializer read realpathCallback in its dead zone — measured at boot).
// realpathCallback carries `.native` (= itself, set in fs-paths.js); the
// closure promisifies realpath.native at module load (fs-local), and specs
// reassign it (chokidar's realpath.native = realpath) — both faces ride
// through the accessor (defineProperty, not Object.assign: assign would
// RUN the source's getter).
export function realpath(path, callback) { return realpathCallback(path, callback); }
Object.defineProperty(realpath, 'native', {
  get() { return realpathCallback.native ?? realpath; },
  set(v) { realpathCallback.native = v; },
  configurable: true,
});
export {
  createWriteStream, createReadStream,
  statSync, lstatSync, accessSync, existsSync, realpathSync,
  writeFileSync, mkdirSync, rmSync, mkdtempSync, chmodSync, utimesSync,
  symlinkSync, readlinkSync, openSync, writeSync, readSync, closeSync,
  copyFileSync, renameSync, cpSync, unlinkSync, rmdirSync,
  readdirSync,
};
import { EventEmitter } from 'upstream/shims/events.js';
// fs.js has no ambient timers import; the loopback's local nextTick shape
// (a 0-delay arm, or the microtask before the gateway timer globals exist).
export const nextTick = (fn) => {
  if (typeof globalThis.setTimeout === 'function') setTimeout(fn, 0);
  else Promise.resolve().then(fn);
};
export { mountWorkspace };

/** Read bytes: workspace file, or the seeded read-only view. A workspace
 * symlink resolves ONE hop before the lookup (a dangling link ENOENTs).
 * Throws ENOENT outside both views. */
export const readAnyBytes = (path) => {
  const resolved = resolveWorkspaceSymlink(path);
  const file = wsFileAt(resolved);
  if (file !== undefined) {
    // File-level read permission: the workspace tracks a mode per file, and
    // a 0-bit mode is unreadable — EACCES like node (settings-file's
    // fails-loud-at-boot test chmods the document to 0o000). Directory modes
    // stay tracked-but-unenforced (the §3 note above): only FILE reads gate.
    if (((file.mode ?? 0o644) & 0o444) === 0) {
      const error = new Error(`EACCES: permission denied, open '${resolved}'`);
      error.code = 'EACCES';
      error.errno = -13;
      error.syscall = 'open';
      error.path = resolved;
      throw error;
    }
    return DshBuffer.fromBytes(file.bytes);
  }
  // Reading a DIRECTORY is EISDIR, like node's open(2) gate (measured
  // 2026-09-28: credentials-local mkdirs the document path and expects the
  // boot read to reject /EISDIR/, not to treat it as an absent document).
  if (wsIsDirAt(resolved)) {
    const error = new Error(`EISDIR: illegal operation on a directory, read '${resolved}'`);
    error.code = 'EISDIR';
    error.errno = -21;
    error.syscall = 'read';
    error.path = resolved;
    throw error;
  }
  const files = vfs();
  if (files !== null && underVFS(path)) {
    const seeded = files.get(path);
    if (seeded !== undefined) return DshBuffer.fromBytes(seeded.bytes);
    throw enoent('open', path);
  }
  if (wsAt(resolved) !== null || underVFS(path)) throw enoent('open', resolved);
  // loop-r: the outside answer is the #358 anchor refusal (was the generic
  // desktop-host refuse — the model seat never took that arm meaningfully,
  // the real seam answered first).
  throw wsOutsideRootError('readFile', resolved);
};

/** One-hop symlink resolution for workspace paths (identity elsewhere);
 * resolveSymlinkAt joins relative targets against the link's directory and
 * returns undefined for non-symlinks. The seeded views have no symlinks. */
/** The readFileSync encoding gate + result shaping (module level for size):
 * one gate, one bytes→result arm shared by every read face above. */
const assertReadEncoding = (encoding) => {
  if (typeof encoding === 'string'
      && encoding !== 'utf8' && encoding !== 'utf-8' && encoding !== 'buffer') {
    throw new Error(`node:fs: readFileSync encoding '${encoding}' — supported: utf8, buffer`);
  }
};

const decodeReadBytes = (bytes, encoding) => {
  if (encoding === undefined || encoding === null || encoding === 'buffer') {
    return DshBuffer.fromBytes(bytes);
  }
  return decodeUtf8(bytes);
};

/** The real-disk read fallback (module level for size). Real-disk fallback
 * (W6-U, 2026-09-28) — the read twin of statSync's fallback: REAL children
 * (the subprocess seam) write files the parent's VFS cannot see, and the
 * flat transpiled specs re-derive vendored-tree paths no VFS face stages.
 * VFS-first precedence is preserved: callers run this only after every
 * workspace/seeded face missed, and only for absolute paths that stat as
 * REAL files. The flat-path map (spec→vendored origin) is consulted first so
 * bundle-relative-derived paths re-root there. Read-as-existence:
 * __dshProcStatReal declines INTERMEDIATE-symlink paths (measured W6-V:
 * '<skills>/linked-dir/SKILL.md' through a real dir symlink — stat null,
 * read serves the bytes), so the read intrinsic itself is the existence
 * check here; a null b64 answer falls through to the caller's error arms. */
const readRealBytes = (path, encoding) => {
  if (typeof path !== 'string' || path.length === 0) return undefined;
  // W8 (2026-09-29): RELATIVE bundle spellings read through a flat-map row
  // only. `import.meta.resolve` of a specifier outside both vendored
  // staging families answers with the SPECIFIER VERBATIM (the loader's
  // legacy bundle-relative arm), and the sdk-launch/subagent-dsh-sdk launch
  // resolution then reads the manifest through that literal spelling —
  // '@deepseek-ai/dsh/package.json'. The leg's flat map re-roots it at the
  // pinned submodule's verbatim product tree; a relative path with NO map
  // row has no checkout twin (the runtime's cwd is the run workspace, not
  // the checkout) and stays refused. Absolute paths keep the raw fallback
  // below (read-as-existence).
  const absolute = path.startsWith('/');
  if (!absolute && !path.includes('/')) return undefined;
  const map = globalThis.__dshFlatPathMap;
  const mapped = typeof map === 'function' ? map(path) : undefined;
  if (!absolute && typeof mapped !== 'string') return undefined;
  // loop-r: the RAW absolute arm answers the mirrored workspace only — an
  // outside-root path declines (the caller refuses with the #358 anchor).
  // The leg's flat-map rows keep flowing: a mapped path is the suite's own
  // declared staging re-root, not a model-reachable spelling.
  if (absolute && typeof mapped !== 'string' && !realSeamInsideRoot(lexical(path))) return undefined;
  const realPath = typeof mapped === 'string' ? mapped : path;
  const b64 = globalThis.__dshProcReadReal?.(realPath);
  if (b64 === undefined || b64 === null) return undefined;
  assertReadEncoding(encoding);
  return decodeReadBytes(fromBase64Real(b64), encoding);
};

export const readFileSync = (rawPath, encoding) => {
  const path = asFsPath(rawPath);
  const canonical = typeof path === 'string' && path.startsWith('/') ? lexical(path) : path;
  // Reads follow one symlink hop (stat/read resolve links, node's shape).
  const workspacePath = resolveWorkspaceSymlink(canonical);
  const file = wsFileAt(workspacePath);
  if (file !== undefined || (wsIsDirAt(workspacePath) && wsAt(workspacePath) !== null)) {
    if (file === undefined) {
      const error = new Error(`EISDIR: illegal operation on a directory, read '${canonical}'`);
      error.code = 'EISDIR';
      throw error;
    }
    // File-level read permission (see readAnyBytes): a 0-read-bit mode is
    // EACCES, like node's open gate (settings-file fails-loud-at-boot).
    if (((file.mode ?? 0o644) & 0o444) === 0) {
      const error = new Error(`EACCES: permission denied, open '${canonical}'`);
      error.code = 'EACCES';
      error.errno = -13;
      error.syscall = 'open';
      error.path = canonical;
      throw error;
    }
    assertReadEncoding(encoding);
    return decodeReadBytes(file.bytes, encoding);
  }
  const files = vfs();
  if (files !== null && underVFS(path)) {
    const seeded = files.get(path);
    if (seeded === undefined) throw enoent('open', path);
    assertReadEncoding(encoding);
    return decodeReadBytes(seeded.bytes, encoding);
  }
  // Inside the workspace root a miss is node-ENOENT — but only AFTER the
  // real-disk twin declines: the leg stages real fixture trees UNDER the
  // pinned profile root (the workspace root since W6-U's root pin), so the
  // old pre-real ENOENT hid every staged real file from sync reads (W6-V:
  // typert analyzer's tsconfig reads — stat saw the file, read ENOENT'd).
  const insideWorkspace = wsAt(canonical) !== null;
  const real = readRealBytes(path, encoding);
  if (real !== undefined) return real;
  if (insideWorkspace) throw enoent('open', workspacePath);
  // loop-r: the outside answer is the #358 anchor refusal (was the generic
  // desktop-host refuse — the real seam used to answer first, so the model
  // seat never saw this arm at all). loop-w: the LEXICAL spelling rides the
  // refusal (readdir's rule) — a raw '../..' spelling would anchor the
  // maybe-you-meant hint at a path that doesn't mean what it spells.
  throw wsOutsideRootError('readFileSync', canonical);
};

/** The seeded-VFS stat arm (module level for size): a seeded FILE answers
 * with its bytes' size; a seeded DIRECTORY (a VFS prefix) answers DIR_MODE.
 * A seeded-path miss is node-ENOENT. */

export {
  // The writable-workspace internals the node:fs/promises shim is built on.
  mountWorkspace as _mountWorkspace,
  wsMkdir as _wsMkdir,
  wsWriteFile as _wsWriteFile,
  wsRm as _wsRm,
  wsRename as _wsRename,
  wsLink as _wsLink,
  wsChmod as _wsChmod,
  wsWatch as _wsWatch,
  wsAt as _wsAt,
  wsStatAt as _wsStatAt,
  wsReaddirAt as _wsReaddirAt,
  wsFileAt as _wsFileAt,
};

/** Directory names derivable from the seeded file keys: one level, sorted —
 * the same contract readdir(3) has and the presets walk expects. */
export default {
  constants,
  WEB_PLUGINS_ROOT,
  seedWebPlugins,
  mergeWebPlugins,
  mountWorkspace,
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  statSync,
  lstatSync,
  readdirSync,
  realpath,
  accessSync,
  realpathSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  mkdtempSync,
  chmodSync,
  utimesSync,
  symlinkSync,
  readlinkSync,
  renameSync,
  openSync,
  writeSync,
  readSync,
  closeSync,
  copyFileSync,
  cpSync,
  unlinkSync,
  rmdirSync,
  watchFile,
  unwatchFile,
};
