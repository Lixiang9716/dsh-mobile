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
  _mountWorkspace,
  _wsMkdir,
  _wsWriteFile,
  _wsRm,
  _wsRename,
  _wsLink,
  _wsChmod,
} from 'node:fs';
import { encodeUtf8 } from 'upstream/shims/buffer.js';

/** Re-exported so the composition that mounts fs-local pins the workspace
 * through the same seam the sync face serves. */
export const mountWorkspace = _mountWorkspace;

const enoent = (call, path) => {
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
    throw enoent('open', path);
  }
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return readFileSync(path, encoding ?? 'buffer');
};

/** Dirent-shaped entry ({name, isDirectory(), isFile(), isSymbolicLink()}) —
 * what the presets walk iterates and what fs-local's `readdir({
 * withFileTypes: true })` classifies through. Neither view has symlinks. */
const direntFor = (name, path) => {
  let info;
  try {
    info = statSync(path);
  } catch {
    info = { isFile: () => true, isDirectory: () => false };
  }
  return {
    name,
    isDirectory: info.isDirectory,
    isFile: info.isFile,
    isSymbolicLink: () => false,
  };
};

/** readdir(path[, {withFileTypes}]) — one level, sorted. */
export const readdir = async (path, options) => {
  const names = readdirSync(path);
  if (options?.withFileTypes !== true) return names;
  const prefix = path.endsWith('/') ? path : `${path}/`;
  return names.map((name) => direntFor(name, `${prefix}${name}`));
};

/** stat(path[, options]) — the sync shim's answer; `{bigint: true}` asks for
 * the bigint face (dev/ino/mode/mtimeNs/ctimeNs) fs-local versions files
 * with. */
export const stat = async (path, options) => statSync(path, options);

/** lstat(path[, options]) — neither view has symlinks, so lstat == stat. */
export const lstat = async (path, options) => lstatSync(path, options);

/** mkdir(path[, options]) — the workspace face (seeded views are read-only). */
export const mkdir = async (path, options) => _wsMkdir(path, options);

/** rm(path[, options]) — the workspace face. */
export const rm = async (path, options) => _wsRm(path, options);

/** rename(from, to) — the workspace face. */
export const rename = async (from, to) => _wsRename(from, to);

/** link(src, dest) — hard-link create-if-absent, the workspace face. */
export const link = async (sourcePath, destPath) => _wsLink(sourcePath, destPath);

/** chmod(path, mode) — the workspace face (tracked, unenforced: the VFS has
 * no permission gate). */
export const chmod = async (path, mode) => _wsChmod(path, mode);

/** writeFile(path, data[, options]) — the workspace face (create or
 * replace; parents must exist, matching node). */
export const writeFile = async (path, data, options) => {
  const bytes = typeof data === 'string' ? encodeUtf8(data) : data;
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`node:fs/promises.writeFile: data must be a string or Uint8Array, got ${typeof data}`);
  }
  const encoding = typeof options === 'string' ? options : options?.encoding;
  if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'utf-8' && encoding !== 'buffer') {
    throw new Error(`node:fs/promises: writeFile encoding '${encoding}' — supported: utf8, buffer`);
  }
  return _wsWriteFile(path, bytes, options?.mode);
};

/** The write-side names below are EXPORTED because the vendored closure's
 * imports link against them (a missing ESM export is a link error, not a
 * lazy one) — and they REFUSE at call time: seed data is read-only, and the
 * honest error names the boundary instead of corrupting the staged view. */
const refuseAsync = (name) => async () => {
  throw new Error(
    `node:fs/promises.${name}: the staged fs view is read-only — `
    + 'seed data cannot be mutated inside the spike runtime');
};
export const cp = refuseAsync('cp');
export const appendFile = refuseAsync('appendFile');
export const unlink = refuseAsync('unlink');

/** access() succeeds for existence checks on readable staged paths — the one
 * write-side name whose SEMANTICS are read-shaped. Mode bits are ignored: the
 * VFS has no permission model (contract/primitives.md §3 — paths are paths). */
export const access = async (path) => {
  if (!existsSync(path) && readdirSync(path) === null) {
    throw enoent('access', path);
  }
};

/** constants: the O_* flags access/write paths pass; the VFS has no real
 * permission model, so the values are node's and semantics are existence. */
export const constants = {
  F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2,
  COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4,
};

/** realpath(): the staged keys ARE canonical (no symlinks in either view), so
 * this is identity for known paths and ENOENT otherwise. */
export const realpath = async (path) => {
  if (!existsSync(path) && readdirSync(path) === null) {
    throw enoent('realpath', path);
  }
  return path;
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

/** The FileHandle face fs-local's atomic write path drives: open a staging
 * file `wx` (must NOT exist), writeFile + chmod + sync + close it; open `r`
 * for the diff-basis read (stat + read + close). */
class FileHandle {
  #path;
  #flags;
  #position = 0; // advancing read cursor (node's null-position semantics)

  constructor(path, flags) {
    this.#path = path;
    this.#flags = flags;
  }

  /** writeFile(data[, options]) — replace the whole file (the only use the
   * closure makes of a handle write). */
  async writeFile(data, options) {
    const bytes = typeof data === 'string' ? encodeUtf8(data) : data;
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError(`FileHandle.writeFile: data must be a string or Uint8Array, got ${typeof data}`);
    }
    const encoding = typeof options === 'string' ? options : options?.encoding;
    if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'utf-8' && encoding !== 'buffer') {
      throw new Error(`FileHandle.writeFile: encoding '${encoding}' — supported: utf8, buffer`);
    }
    return _wsWriteFile(this.#path, bytes, undefined);
  }

  /** read(buffer, offset, length[, position]) — bytes of the file as stored,
   * copied into `buffer` at `offset`; resolves {bytesRead}. A `null`/
   * `undefined` position reads from the handle's advancing cursor (node's
   * sequential-read semantics — what fs-local's chunked diff-basis loop
   * relies on); a numeric position reads absolutely and does not move the
   * cursor. */
  async read(buffer, offset, length, position) {
    if (!(buffer instanceof Uint8Array)) {
      throw new TypeError('FileHandle.read: buffer must be a Uint8Array');
    }
    const current = await readFile(this.#path);
    const start = typeof position === 'number' ? position : this.#position;
    const readable = Math.max(0, Math.min(length, current.length - Math.max(0, start)));
    for (let index = 0; index < readable; index += 1) {
      buffer[offset + index] = current[start + index];
    }
    if (typeof position !== 'number') {
      this.#position = start + readable;
    }
    return { bytesRead: readable, buffer };
  }

  /** stat() — the non-bigint shape (isFile + size is what the diff-basis
   * reader consumes). */
  async stat() {
    return statSync(this.#path);
  }

  async chmod(mode) {
    return _wsChmod(this.#path, mode);
  }

  /** sync() — nothing to flush: the store is memory. */
  async sync() { /* the VFS is memory; nothing to flush */ }

  async datasync() { /* the VFS is memory; nothing to flush */ }

  async close() { /* no descriptor held */ }
}

/** open(path, flags[, mode]) — 'r' requires an existing regular file; the
 * exclusive-create flags ('wx'/'xw'/'ax') require absence (EEXIST otherwise),
 * which is exactly the staging-file contract fs-local's atomic publication
 * relies on. */
export const open = async (path, flags = 'r', mode) => {
  if (flags === 'r') {
    if (!existsSync(path)) throw enoent('open', path);
    if (!statSync(path).isFile()) {
      const error = new Error(`EISDIR: illegal operation on a directory, open '${path}'`);
      error.code = 'EISDIR';
      throw error;
    }
    return new FileHandle(path, flags);
  }
  if (flags.includes('x')) {
    if (existsSync(path)) {
      const error = new Error(`EEXIST: file already exists, open '${path}'`);
      error.code = 'EEXIST';
      error.errno = -17;
      error.syscall = 'open';
      error.path = path;
      throw error;
    }
    // node's exclusive open CREATES the (empty) file; the handle's writes
    // then fill it. The staging-file contract fs-local relies on.
    await writeFile(path, new Uint8Array(0), { mode });
    return new FileHandle(path, flags);
  }
  throw new Error(`node:fs/promises: open flag '${flags}' — supported: r, x-flags (the closure's atomic write path)`);
};

export default {
  mountWorkspace,
  readFile, readdir, stat, lstat, mkdir, rm, rename, link, chmod, writeFile, open,
  cp, appendFile, unlink, access,
  constants, realpath, opendir,
};
