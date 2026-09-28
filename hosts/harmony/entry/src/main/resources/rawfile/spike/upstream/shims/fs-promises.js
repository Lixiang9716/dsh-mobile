import { fromBase64 as fromBase64Shim } from 'upstream/shims/buffer.js';
// dsh:logging-exempt (shim layer)
/**
 * node:fs/promises — the ASYNC face of the staged in-memory file views.
 *
 * Why this exists: the vendored agent-presets service walks its presets tree
 * with async readFile/readdir/stat. The sync fs shim's VFS already holds
 * seeded staged files (web-plugins, and — since the VFS roots were widened —
 * the /vendor tree a driver seeds); this module is the same view behind
 * promises.
 *
 * FILE-TOOLS row: the vendored @deepseek-ai/dsh-fs-local backend is built on
 * THIS face. The writable WORKSPACE VFS (mounted with
 * `node:fs`'s mountWorkspace) is served here for real — stat (incl. the
 * `{bigint: true}` shape fs-local probes with), mkdir/rm/rename/link/chmod,
 * and an `open()` FileHandle with the members fs-local's atomic write path
 * uses (writeFile/chmod/sync/stat/read/close). Operations on the seeded
 * read-only views stay honest refusals: seed data cannot be mutated inside
 * the spike runtime, and pretending otherwise would corrupt nothing but
 * trust. Reads serve both views.
 *
 * The async shape is not decoration: importing the package failed outright
 * until this module existed (`no spike shim for node:fs/promises`), because
 * an ESM named import from a missing module is a link error, not a lazy one.
 * The same logic pins every name fs-local imports at its lib entrypoint — a
 * missing export is a link error even if the call site is never reached.
 */
import {
  existsSync,
  readFileSync,
  statSync,
  lstatSync,
  readdirSync,
  realpath as realpathCallback,
  readlinkSync,
  utimesSync,
  symlinkSync,
  _mountWorkspace,
  _wsMkdir,
  _wsWriteFile,
  _wsRm,
  _wsRename,
  _wsLink,
  _wsChmod,
  _wsWatch,
  _wsAt,
} from 'node:fs';
import { encodeUtf8 } from 'upstream/shims/buffer.js';
// The FileHandle + open face lives in fs-promises-fh.js (the file crossed
// the size budget); the default namespace below re-exports the faces.
import { open } from 'upstream/shims/fs-promises-fh.js';
export { open };
// The FileHandle module's handle-member faces (an ESM cycle: fh imports
// this module; call-time reads only).
export { _wsChmod, _wsWriteFile, _wsAt };

/** Re-exported so the composition that mounts fs-local pins the workspace
 * through the same seam the sync face serves. */
export const mountWorkspace = _mountWorkspace;

// Six-alphanumeric unique-suffix counter for mkdtemp (node-shaped naming).
let mkdtempCounter = 0;

export const enoent = (call, path) => {
  const error = new Error(`ENOENT: no such file or directory, ${call} '${path}'`);
  error.code = 'ENOENT';
  error.errno = -2;
  error.syscall = call;
  error.path = path;
  return error;
};

/** readFile(path[, options]) — utf8 string or Buffer, like node. The VFS has
 * no read latency to cancel, so the `signal` member of the options object is
 * accepted and (being pre-aborted or not at call time) not polled. */
export const readFile = async (path, options) => {
  if (options?.signal?.aborted === true) {
    const error = new Error('read aborted');
    error.name = 'AbortError';
    throw error;
  }
  if (!existsSync(path)) {
    // Real-disk fallback (W5-R, 2026-09-28): REAL children (the subprocess
    // seam) write marker/exit files onto the real disk paths the parent's
    // VFS models; when the VFS face misses and the real disk has the file,
    // read it through the host (base64 bridge, same channel the spawn
    // pumps). VFS-first precedence is preserved — staged bytes win.
    // Read-as-existence (W6-V): __dshProcStatReal declines INTERMEDIATE-
    // symlink paths ('<skills>/linked-dir/SKILL.md' through a real dir
    // symlink: stat null, read serves the bytes — measured), so the read
    // intrinsic itself is the existence check; the ENOENT below stays the
    // answer for genuinely absent paths.
    if (typeof path === 'string' && path.startsWith('/')) {
      const b64 = globalThis.__dshProcReadReal?.(path);
      if (b64 !== undefined && b64 !== null) {
        const encoding2 = typeof options === 'string' ? options : options?.encoding;
        const bytes = Buffer.from(fromBase64Shim(b64));
        return encoding2 && encoding2 !== 'buffer' ? bytes.toString(encoding2) : bytes;
      }
    }
    throw enoent('open', path);
  }
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return readFileSync(path, encoding ?? 'buffer');
};

/** Dirent-shaped entry ({name, isDirectory(), isFile(), isSymbolicLink()}) —
 * what the presets walk iterates and what fs-local's `readdir({
 * withFileTypes: true })` classifies through. Lstat semantics: a workspace
 * symlink entry reports itself (the snapshot walks branch on it). */
const direntFor = (name, path) => {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    info = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
  }
  return {
    name,
    isDirectory: info.isDirectory,
    isFile: info.isFile,
    isSymbolicLink: info.isSymbolicLink,
  };
};

/** readdir(path[, options]) — one level, or a RECURSIVE walk when
 * `options.recursive` is true (node's shape: relative paths of every file
 * AND directory below the root, children after their parent; measured
 * 2026-09-23 against node 24 — resume.spec's torn-tail scan walks the
 * session tree this way). */
export const readdir = async (path, options) => {
  if (options?.recursive === true) {
    const out = [];
    const walk = (dir, rel) => {
      for (const name of readdirSync(dir)) {
        const child = rel === undefined ? name : `${rel}/${name}`;
        const full = `${dir.endsWith('/') ? dir : `${dir}/`}${name}`;
        let isDir = false;
        try { isDir = statSync(full)?.isDirectory() === true; } catch { /* file-like */ }
        out.push(child);
        if (isDir) walk(full, child);
      }
    };
    walk(path, undefined);
    return out;
  }
  const names = readdirSync(path);
  if (options?.withFileTypes !== true) return names;
  const prefix = path.endsWith('/') ? path : `${path}/`;
  return names.map((name) => direntFor(name, `${prefix}${name}`));
};

/** stat(path[, options]) — the sync shim's answer (symlinks followed one
 * hop); `{bigint: true}` asks for the bigint face (dev/ino/mode/mtimeNs/
 * ctimeNs) fs-local versions files with. */
export const stat = async (path, options) => statSync(path, options);

/** lstat(path[, options]) — the lstat face: a workspace symlink entry
 * reports itself instead of its target; everything else stats the same. */
export const lstat = async (path, options) => lstatSync(path, options);

/** utimes(path, atime, mtime) — the workspace face: seconds floats become
 * the entry's mtime (the sweeps and spill aging read it through stat). */
export const utimes = async (path, atime, mtime) => utimesSync(path, atime, mtime);

/** symlink(target, path) — the workspace face (note node's argument order):
 * a stored raw target, resolved one hop by the readers, returned verbatim
 * by readlink. */
export const symlink = async (target, path) => symlinkSync(target, path);

/** readlink(path) — the raw target string; ENOENT for missing paths and
 * EINVAL for non-symlinks, node's spellings (the sync face owns them). */
export const readlink = async (path) => readlinkSync(path);

/** mkdir(path[, options]) — the workspace face (seeded views are read-only). */
export const mkdir = async (path, options) => {
  const res = await _wsMkdir(path, options);
  // Write-through (W5-R, 2026-09-28): directories under the profile
  // container exist for REAL on the desktop spike — a spawned child reads
  // the real disk, so the VFS mkdir mirrors onto it (idempotent).
  try {
    if (typeof path === 'string' && path.startsWith('/') && res !== undefined) {
      globalThis.__dshProcMkdirReal?.(path);
    }
  } catch { /* structural mirror is best-effort */ }
  return res;
};

/** rm(path[, options]) — the workspace face. */
export const rm = async (path, options) => _wsRm(path, options);

/** rename(from, to) — the workspace face. */
export const rename = async (from, to) => _wsRename(from, to);

/** link(src, dest) — hard-link create-if-absent, the workspace face. */
export const link = async (sourcePath, destPath) => _wsLink(sourcePath, destPath);

/** chmod(path, mode) — the workspace face (tracked, unenforced: the VFS has
 * no permission gate). */
export const chmod = async (path, mode) => _wsChmod(path, mode);

/** watchPath(path, notify) — register a mutation watcher on one workspace
 * file; notify(canonicalPath) fires synchronously when a write/rm/rename
 * lands on it. Consumer: the chokidar linkage shim (npm-bridges.js), which
 * fronts this as settings-file's document watcher. The watched path is
 * canonicalized the same way mutations canonicalize theirs, so string
 * equality is exact. */
export const watchPath = async (path, notify) => {
  const at = _wsAt(path);
  if (at === null) {
    throw new Error(`node:fs.watch: path outside the writable workspace root: ${path}`);
  }
  return _wsWatch(at.path, notify);
};

/** writeFile(path, data[, options]) — the workspace face (create or
 * replace; parents must exist, matching node). flags: the vendored
 * atomic-write writer lock creates its `<file>.lock` sibling with
 * { flag: 'wx' } — the exclusive create IS the lock (measured 2026-09-27:
 * with the flag ignored the lock never contended and settings-file's
 * cross-instance tests resolved instead of timing out). 'x' faces refuse an
 * existing target with EEXIST; 'a' faces append; read flags on a write call
 * are EBADF like node. */
export const writeFile = async (path, data, options) => {
  const bytes = typeof data === 'string' ? encodeUtf8(data) : data;
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`node:fs/promises.writeFile: data must be a string or Uint8Array, got ${typeof data}`);
  }
  const encoding = typeof options === 'string' ? options : options?.encoding;
  if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'utf-8' && encoding !== 'buffer') {
    throw new Error(`node:fs/promises: writeFile encoding '${encoding}' — supported: utf8, buffer`);
  }
  const flag = typeof options === 'string' ? 'w' : (options?.flag ?? 'w');
  if (flag === 'r' || flag === 'r+') {
    const error = new Error(`EBADF: bad file descriptor, write '${path}'`);
    error.code = 'EBADF';
    error.errno = -9;
    error.syscall = 'write';
    error.path = String(path);
    throw error;
  }
  if (flag.includes('x')) {
    let exists = false;
    try { exists = existsSync(path) || realFileExists(path); } catch { exists = false; }
    if (exists) {
      const error = new Error(`EEXIST: file already exists, open '${path}'`);
      error.code = 'EEXIST';
      error.errno = -17;
      error.syscall = 'open';
      error.path = String(path);
      throw error;
    }
    if (flag.startsWith('a')) return appendFile(path, bytes);
    return _wsWriteFile(path, bytes, options?.mode);
  }
  if (flag.startsWith('a')) return appendFile(path, bytes);
  // The real-disk write-through lives inside _wsWriteFile (fs-workspace.js)
  // so this face and the sync/copy/append/fd faces mirror identically.
  return _wsWriteFile(path, bytes, options?.mode);
};

/** The write-side names below are EXPORTED because the vendored closure's
 * imports link against them (a missing ESM export is a link error, not a
 * lazy one). appendFile is a real workspace append (read + concat + write):
 * the resume-torn-tail recovery appends closers to a persisted log in its
 * own tmpdir; the workspace root's own boundary still refuses anything
 * outside it (seeded views are not writable there, so the honest refusal
 * survives for them). */
const refuseAsync = (name) => async () => {
  throw new Error(
    `node:fs/promises.${name}: the staged fs view is read-only — `
    + 'seed data cannot be mutated inside the spike runtime');
};
/** cp(src, dest[, options]) — a REAL recursive copy between the two staged
 * views: reads go through the sync face (which serves the seeded read-only
 * views AND the workspace), writes land in the workspace only (the seeded
 * views stay read-only). Consumer: the agent-presets authoring copy
 * (copyComposition) calls cp with {recursive, dereference, force:false,
 * errorOnExist:true} to copy a preset directory — shipped (seeded view) or
 * locally authored (workspace) — into the user root. Options follow node:
 * `recursive` walks directories (a non-recursive cp of a directory throws
 * EISDIR); `force:false` + `errorOnExist:true` refuse an occupied
 * destination with EEXIST (node's spelling); `dereference` is honored in
 * effect — statSync/readFileSync already resolve one symlink hop, and the
 * seeded views carry no symlinks. Modes travel with the files (the source
 * stat's permission bits); the caller (tightenModes) re-tightens after. */
const cpEexist = (call, path) => {
  const error = new Error(`EEXIST: file already exists, ${call} '${path}'`);
  error.code = 'EEXIST';
  error.errno = -17;
  error.syscall = call;
  error.path = path;
  return error;
};
const cpEntry = async (from, to, options) => {
  // statSync (not lstat): dereference semantics — a symlinked entry copies
  // as its target, which is what the authoring copy asks for.
  const info = statSync(from);
  if (info.isDirectory()) {
    if (options?.recursive !== true) {
      const error = new Error(`EISDIR: illegal operation on a directory, cp '${from}' -> '${to}'`);
      error.code = 'EISDIR';
      error.syscall = 'cp';
      error.path = from;
      throw error;
    }
    const destInfo = existsSync(to) ? statSync(to) : null;
    if (destInfo !== null && !destInfo.isDirectory()) throw cpEexist('cp', to);
    if (destInfo === null) _wsMkdir(to, { recursive: true });
    const prefix = from.endsWith('/') ? from : `${from}/`;
    for (const name of readdirSync(from)) {
      await cpEntry(`${prefix}${name}`, `${to}/${name}`, options);
    }
    return;
  }
  if (existsSync(to) && options?.force !== true) throw cpEexist('cp', to);
  // readFileSync serves both views and resolves the one symlink hop; the
  // Buffer face is a Uint8Array, the shape _wsWriteFile stores.
  const bytes = readFileSync(from);
  _wsWriteFile(to, bytes, info.mode & 0o777);
};
export const cp = async (source, destination, options) => {
  await cpEntry(source, destination, options ?? {});
};
/** copyFile(src, dest, mode) — the single-file copy (cp's file case without
 * the directory walk); COPYFILE_EXCL makes an existing dest an EEXIST.
 * Demanded at link time by ptc-runtime-node's process spec. */
export const copyFile = async (src, dest, mode = 0) => {
  const bytes = readFileSync(src);
  if ((mode & constants.COPYFILE_EXCL) !== 0 && existsSync(dest)) {
    throw cpEexist('copyfile', dest);
  }
  return _wsWriteFile(dest, bytes, undefined);
};
export const appendFile = async (path, data, options) => {
  const bytes = typeof data === 'string' ? encodeUtf8(data) : data;
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`node:fs/promises.appendFile: data must be a string or Uint8Array, got ${typeof data}`);
  }
  const encoding = typeof options === 'string' ? options : options?.encoding;
  if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'utf-8' && encoding !== 'buffer') {
    throw new Error(`node:fs/promises: appendFile encoding '${encoding}' — supported: utf8, buffer`);
  }
  let current = new Uint8Array(0);
  try {
    current = await readFile(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const merged = new Uint8Array(current.length + bytes.length);
  merged.set(current, 0);
  merged.set(bytes, current.length);
  return _wsWriteFile(path, merged, options?.mode);
};
export const unlink = async (path) => _wsRm(path, { force: false });

/** realFileExists(path) — the real-disk existence face the exclusivity checks
 * ('wx'/O_EXCL) must consult BEFORE creating: node's O_EXCL fails when the
 * file exists for ANY reason, including files created behind the VFS by real
 * children (the subprocess seam's sqlite databases — W6-V, 2026-09-28: the
 * 'wx' create in storage-sqlite's createDatabaseFile truncated a live
 * database the VFS could not see, silently resetting PRAGMA user_version).
 * VFS-first semantics are preserved: existsSync answers first, this only
 * decides the exclusive-create refusal. */
export const realFileExists = (path) => {
  if (typeof path !== 'string' || !path.startsWith('/')) return false;
  try {
    return globalThis.__dshProcStatReal?.(path)?.isFile === true;
  } catch {
    return false;
  }
};

// rmdir delegates to the same workspace removal unlink uses — the workspace
// view has no empty-dir bookkeeping, so the POSIX empty-dir restriction is
// not expressible here; demanded at link time by the upstream specs.
export const rmdir = async (path, options) => _wsRm(path, options);

/** access() succeeds for existence checks on readable staged paths — the one
 * write-side name whose SEMANTICS are read-shaped. Mode bits are ignored: the
 * VFS has no permission model (contract/primitives.md §3 — paths are paths).
 * Real-disk fallback (W5-R, 2026-09-28): the subprocess seam's pre-spawn
 * executability check access(X_OK)s REAL binaries (the node running the
 * fixture servers); a mode-carrying probe consults the host's access(2)
 * when every VFS face missed. VFS-first precedence is preserved. */
export const access = async (path, mode) => {
  let staged = true;
  try {
    staged = existsSync(path) || readdirSync(path) !== null;
  } catch {
    staged = false; // the VFS faces throw ENOENT on unknown roots — the fallback decides below
  }
  if (!staged) {
    if (typeof path === 'string' && path.startsWith('/') && mode !== undefined) {
      if (globalThis.__dshProcAccessReal?.(path, mode) === true) return;
    }
    throw enoent('access', path);
  }
};

/** constants: the O_* flags access/write paths pass; the VFS has no real
 * permission model, so the values are node's and semantics are existence. */
export const constants = {
  F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2,
  // node's numeric O_* values — the attachment-local durable-store calls
  // open(path, constants.O_RDONLY) and friends with NUMBERS (R3-D,
  // 2026-09-27); the string-face mapping below consumes them.
  O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024,
  COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4,
};

/** realpath(): canonicalizes through the workspace symlink chain (the sync
 * face's vfsRealpath — one link-hop per segment) and stays identity for the
 * seeded views (their keys are canonical). ENOENT for missing in-view paths.
 * Measured 2026-09-27: the home-paths watcher test realpaths an alias
 * symlink and asserts the TARGET spelling. */
export const realpath = async (path) => {
  if (!existsSync(path) && readdirSync(path) === null) {
    throw enoent('realpath', path);
  }
  return new Promise((resolve, reject) => {
    realpathCallback(path, (error, resolved) => (error ? reject(error) : resolve(resolved)));
  });
};

/** opendir(): the async iterator face of readdir, one level. The presets
 * walk uses it (home-paths' user-root scan). */
export const opendir = async (path) => {
  const names = readdirSync(path);
  let index = 0;
  return {
    async read() {
      if (index >= names.length) return null;
      const name = names[index++];
      const full = `${path.endsWith('/') ? path : `${path}/`}${name}`;
      return direntFor(name, full);
    },
    async close() { /* nothing held */ },
    [Symbol.asyncIterator]() { return this; },
  };
};

export const truncate = async (path, len) => {
  if (typeof path !== 'string' || !Number.isInteger(len) || len < 0) {
    throw new TypeError('truncate: (path, len) with a non-negative integer len');
  }
  const data = await readFile(path);
  if (data.byteLength <= len) return undefined;
  await writeFile(path, data.subarray(0, len));
  return undefined;
};

export const mkdtemp = async (prefix) => {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new TypeError('mkdtemp: prefix must be a non-empty string');
  }
  // Six alphanumeric chars like node's suffix — name-shape-sensitive
  // consumers (spill-local's DEFAULT_ROOT_RE) match on it (see fs.js).
  const path = `${prefix}${(mkdtempCounter += 1).toString(36).padStart(6, '0')}`;
  await mkdir(path, { recursive: true });
  return path;
};

export default {
  mountWorkspace,
  readFile, readdir, stat, lstat, mkdir, rm, rename, link, chmod, writeFile, open,
  cp, appendFile, unlink, access,
  constants, realpath, opendir, mkdtemp, truncate,
  utimes, symlink, readlink,
};
