// dsh:logging-exempt (shim layer)
/**
 * shims/fs-writes.js — node:fs's synchronous workspace write faces and the
 * descriptor table (the 2026-09-27 write face), split out of fs.js when that
 * file crossed the code-size budget. The fd table is shared with
 * fs-write-stream.js (one store, three spellings — unchanged); references
 * back into fs.js are call-time only (ESM-cycle safe).
 */
import {
  workspace,
  lexical,
  wsChmod,
  wsEexist,
  wsFileAt,
  wsIsDirAt,
  wsMkdir,
  wsRename,
  wsRm,
  wsSymlink,
  wsUtimes,
  wsWriteFile,
} from 'upstream/shims/fs-workspace.js';
import { workspaceSymlinkTarget } from 'upstream/shims/fs-paths.js';
import { DshBuffer, encodeUtf8 } from 'upstream/shims/buffer.js';
import { enoent, refuse, constants, readAnyBytes, existsSync, statSync, readFileSync, readdirSync } from 'upstream/shims/fs.js';

/* ---- the synchronous workspace writes + fd face (2026-09-27) ------------
 * The old wall ("sync writes refuse; the promise face owns writes") came
 * down when the suite's sync-write consumers (spill-local staging, the
 * subprocess-local spill collector, the settings/spill chmod+utimes aging)
 * linked against these names and then CALLED them: the store is the same
 * workspace VFS the promise face serves, so the sync twins are real
 * operations over it — one store, two spellings. Anything outside the
 * writable workspace root still refuses exactly as before. */

export const writeFileSync = (path, data, options) => {
  const bytes = typeof data === 'string' ? encodeUtf8(data) : data;
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`node:fs.writeFileSync: data must be a string or Uint8Array, got ${typeof data}`);
  }
  if (typeof options === 'object' && options !== null && options.flag !== undefined
      && typeof options.flag === 'string' && options.flag.includes('x')
      && existsSync(path)) {
    throw wsEexist('open', path);
  }
  const mode = typeof options === 'object' && options !== null ? options.mode : undefined;
  // The real-disk write-through lives INSIDE wsWriteFile (fs-workspace.js):
  // every write face (sync + promises + copyFile/cp/appendFile/fd write)
  // funnels there, so the mirror cannot be bypassed (W6-U, 2026-09-28).
  return wsWriteFile(path, bytes, mode);
};

export const mkdirSync = (path, options) => {
  if (options === true || options?.recursive === true) {
    return wsMkdir(path, { recursive: true });
  }
  return wsMkdir(path, {});
};

export const rmSync = (path, options = {}) => {
  // The real-disk removal mirror lives inside wsRm (fs-workspace.js), same
  // funneling argument as the write-through above.
  return wsRm(path, options);
};

/** mkdtemp — node's unique-suffix temp dir over the workspace. Node appends
 * exactly SIX alphanumeric characters per call; the corpus's consumers match
 * the produced NAME against shapes that assume that breadth (spill-local's
 * DEFAULT_ROOT_RE is `^dsh-spill-[A-Za-z0-9]{6}$` — discovery found nothing
 * under the old time+counter suffix, W4-N 2026-09-28). A zero-padded base-36
 * counter keeps the six-char shape, uniqueness within the process, and
 * determinism the logs can follow. */
let mkdtempSyncCounter = 0;
export const mkdtempSync = (prefix) => {
  if (typeof prefix !== 'string' || prefix.length === 0) {
    throw new TypeError('node:fs.mkdtempSync: prefix must be a non-empty string');
  }
  const path = `${prefix}${(mkdtempSyncCounter += 1).toString(36).padStart(6, '0')}`;
  wsMkdir(path, {});
  return path;
};

export const chmodSync = (path, mode) => wsChmod(path, mode);

/** utimes(path, atime, mtime) — seconds (floats) like node; the mtime is
 * what the sweep/spill aging reads back through stat. */
export const utimesSync = (path, atime, mtime) => wsUtimes(path, atime, mtime);

/** symlink(target, path) — a stored raw target, resolved one hop by the
 * readers (stat/read); readlink returns it verbatim. Replaces the old loud
 * stub: the workspace CAN express a path alias (fs-workspace symlinks map),
 * so the honest operation is the real one. */
export const symlinkSync = (target, path) => wsSymlink(target, path);

export const readlinkSync = (path) => {
  const canonical = typeof path === 'string' && path.startsWith('/') ? lexical(path) : path;
  const target = workspaceSymlinkTarget(canonical);
  if (target === undefined) {
    if (existsSync(canonical)) {
      const error = new Error(`EINVAL: invalid argument, readlink '${canonical}'`);
      error.code = 'EINVAL';
      error.syscall = 'readlink';
      error.path = canonical;
      throw error;
    }
    throw enoent('readlink', canonical);
  }
  return target;
};

/* The descriptor face: subprocess-local's output collector opens its spill
 * file, writes chunks, closes (openSync/writeSync/closeSync). The VFS has
 * no real fds — a monotonic descriptor over a {path, append, cursor} record
 * on the GLOBAL (the multi-instance rule: module state would fork). */
export const fdTable = () => {
  if (typeof globalThis.__DSH_FS_FDS__ === 'undefined') globalThis.__DSH_FS_FDS__ = new Map();
  return globalThis.__DSH_FS_FDS__;
};
let nextFdSync = 16;

const ebadf = (call, fd) => {
  const error = new Error(`EBADF: bad file descriptor, ${call} ${fd}`);
  error.code = 'EBADF';
  error.errno = -9;
  error.syscall = call;
  return error;
};

export const openSync = (path, flags = 'r', mode) => {
  const flag = typeof flags === 'string' ? flags : 'r';
  const exists = existsSync(path);
  if (flag === 'r' || flag === 'r+') {
    if (!exists) throw enoent('open', path);
  } else if (flag === 'w' || flag === 'wx' || flag === 'ax' || flag === 'a' || flag.includes('x')) {
    if (flag.includes('x') && exists) throw wsEexist('open', path);
    if (!exists || flag === 'w' || flag === 'wx') wsWriteFile(path, new Uint8Array(0), mode);
  } else {
    throw new Error(`node:fs.openSync: flag '${flag}' — supported: r, r+, w, wx, a, ax (the closure's sync faces)`);
  }
  const fd = nextFdSync++;
  fdTable().set(fd, {
    path,
    append: flag === 'a' || flag === 'ax',
    cursor: 0,
  });
  return fd;
};

export const writeSync = (fd, data, ...rest) => {
  const record = fdTable().get(fd);
  if (record === undefined) throw ebadf('write', fd);
  const bytes = typeof data === 'string' ? encodeUtf8(data) : data;
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`node:fs.writeSync: data must be a string or Uint8Array, got ${typeof data}`);
  }
  const current = (() => {
    try {
      return readAnyBytes(record.path);
    } catch {
      return DshBuffer.fromBytes(new Uint8Array(0));
    }
  })();
  // An append descriptor always lands at EOF; the rest honor the cursor
  // (or the explicit position argument, node's 4th form — unused here).
  const at = record.append ? current.length : Math.min(record.cursor, current.length);
  const merged = new Uint8Array(Math.max(current.length, at + bytes.length));
  merged.set(current, 0);
  merged.set(bytes, at);
  wsWriteFile(record.path, merged, undefined);
  if (!record.append) record.cursor = at + bytes.length;
  return bytes.length;
};

export const readSync = (fd, buffer, offset = 0, length = buffer.byteLength - offset, position = null) => {
  const record = fdTable().get(fd);
  if (record === undefined) throw ebadf('read', fd);
  if (!(buffer instanceof Uint8Array)) {
    throw new TypeError(`node:fs.readSync: buffer must be a Uint8Array, got ${typeof buffer}`);
  }
  const whole = readAnyBytes(record.path);
  // position null = the descriptor cursor (node semantics); an explicit
  // position reads there and leaves the cursor alone.
  const at = position === null || position === undefined
    ? Math.min(record.cursor, whole.length)
    : position;
  const count = Math.max(0, Math.min(length, whole.length - at));
  if (count > 0) buffer.set(whole.subarray(at, at + count), offset);
  if (position === null || position === undefined) record.cursor = at + count;
  return count;
};

export const closeSync = (fd) => {
  if (!fdTable().delete(fd)) throw ebadf('close', fd);
};

/** copyFile(src, dest) — bytes of src written to dest (COPYFILE_EXCL in
 * flags makes an existing dest an EEXIST, node's one flag). The workspace
 * store is the same one the promise face serves. */
export const copyFileSync = (src, dest, flags = 0) => {
  const bytes = readAnyBytes(typeof src === 'string' ? lexical(src) : src);
  if ((flags & constants.COPYFILE_EXCL) !== 0 && existsSync(dest)) {
    throw wsEexist('copyfile', dest);
  }
  wsWriteFile(dest, bytes, undefined);
  return undefined;
};

/** renameSync — the workspace rename (files and directory subtrees; the
 * same store the promise face's rename serves). */
export const renameSync = (from, to) => wsRename(from, to);

/** cpSync(src, dest[, options]) — the SYNC face of the promise shim's cp
 * (node:fs/promises.cp, wave 1): a real recursive copy between the seeded
 * read-only views and the writable workspace. Options follow node:
 * `recursive` walks directories (without it a directory source throws
 * EISDIR); `force:false` refuses an occupied destination with EEXIST
 * (node's spelling); `dereference` rides statSync/readFileSync's one-hop
 * symlink resolution exactly as the promise face's does. The walk is
 * naturally synchronous — the promise face wraps the same semantics in
 * async — so the two faces stay one contract. Demanded at link time by the
 * subagent-codex real-product spec. */
const cpSyncEntry = (from, to, options) => {
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
    if (destInfo !== null && !destInfo.isDirectory()) throw wsEexist('cp', to);
    if (destInfo === null) wsMkdir(to, { recursive: true });
    const prefix = from.endsWith('/') ? from : `${from}/`;
    for (const name of readdirSync(from)) {
      cpSyncEntry(`${prefix}${name}`, `${to}/${name}`, options);
    }
    return;
  }
  if (existsSync(to) && options?.force !== true) throw wsEexist('cp', to);
  wsWriteFile(to, readFileSync(from), info.mode & 0o777);
};
export const cpSync = (source, destination, options) => {
  cpSyncEntry(source, destination, options ?? {});
};

/** unlink: files and symlink entries only (node unlinks a directory with
 * EPERM); rmdir: the ENOTEMPTY-enforcing removal (wsRm non-recursive). */
export const unlinkSync = (path) => {
  const canonical = typeof path === 'string' && path.startsWith('/') ? lexical(path) : path;
  if (workspaceSymlinkTarget(canonical) !== undefined) {
    workspace().symlinks.delete(canonical);
    return;
  }
  if (wsIsDirAt(canonical) && !wsFileAt(canonical)) {
    const error = new Error(`EPERM: operation not permitted, unlink '${canonical}'`);
    error.code = 'EPERM';
    error.syscall = 'unlink';
    error.path = canonical;
    throw error;
  }
  wsRm(canonical, { force: false });
};

export const rmdirSync = (path) => wsRm(path, {});
