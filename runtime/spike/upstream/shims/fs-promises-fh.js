// dsh:logging-exempt (shim layer)
/**
 * shims/fs-promises-fh.js — node:fs/promises's open()/FileHandle face, split
 * out of fs-promises.js when that file crossed the code-size budget. The
 * handle identity counter rides the class; write/read members go through the
 * fs-promises faces (an ESM cycle by construction — call-time access only).
 */
import { encodeUtf8 } from 'upstream/shims/buffer.js';
import { existsSync, statSync } from 'upstream/shims/fs.js';
// The bare row (not the bundle path) keeps ONE fs-promises instance
// under both entries — a bundle-path import would dual-instance the
// module and read its `open` binding mid-cycle (measured: 'open is not
// initialized' at boot).
import { enoent, writeFile, readFile, realFileExists, constants, _wsChmod, _wsWriteFile, _wsAt } from 'node:fs/promises';

/** The FileHandle face the closure's write paths drive: fs-local's atomic
 * write (staging `wx` + diff-basis `r`) and the session-persistence-jsonl
 * spine (lease `w` + append `a` + repair `r+` + dir fsync `r`). */
/** Handle-descriptor identity: the VFS has no real fds, but node-shaped
 * callers read `handle.fd` (the jsonl lease hands it to the flock shim) —
 * a monotonic counter is honest identity in a single-process store. */
let nextFd = 16;
class FileHandle {
  #path;
  #flags;
  #append;
  #position = 0; // advancing read cursor (node's null-position semantics)

  constructor(path, flags, append = false) {
    this.fd = nextFd++;
    this.#path = path;
    this.#flags = flags;
    this.#append = append;
  }

  /** writeFile(data[, options]) — node semantics: writes AT the handle's
   * current file position and advances it, so sequential writeFile calls on
   * one handle ACCUMULATE (node: filehandle.writeFile uses the position,
   * which starts at 0 for the O_CREAT-staged handles the closure opens).
   * Append-mode handles ('a'/'ax') append at EOF regardless (the jsonl
   * spine's appendLines relies on it). The cursor-tracking upgrade fixes
   * attachment-local's staging loop, which writeFile()s every chunk into one
   * fresh O_CREAT|O_EXCL handle — with whole-file replacement only the LAST
   * chunk survived (measured 2026-09-28, R3-G1). */
  async writeFile(data, options) {
    const bytes = typeof data === 'string' ? encodeUtf8(data) : data;
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError(`FileHandle.writeFile: data must be a string or Uint8Array, got ${typeof data}`);
    }
    const encoding = typeof options === 'string' ? options : options?.encoding;
    if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'utf-8' && encoding !== 'buffer') {
      throw new Error(`FileHandle.writeFile: encoding '${encoding}' — supported: utf8, buffer`);
    }
    if (this.#append || this.#position > 0) {
      let current = new Uint8Array(0);
      try {
        current = await readFile(this.#path);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      const at = this.#append ? current.length : Math.min(this.#position, current.length);
      const merged = new Uint8Array(at + bytes.length);
      merged.set(current.subarray(0, at), 0);
      merged.set(bytes, at);
      const out = _wsWriteFile(this.#path, merged, undefined);
      if (!this.#append) this.#position = at + bytes.length;
      return out;
    }
    this.#position = bytes.length;
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

  /** stat([options]) — options pass through (`{bigint: true}` is what the
   * jsonl lease's inode-identity check compares across handle and path). */
  async stat(options) {
    return statSync(this.#path, options);
  }

  /** truncate(len) — the jsonl repair/rollback path ('r+' handles). */
  async truncate(len) {
    if (!Number.isInteger(len) || len < 0) {
      throw new TypeError(`FileHandle.truncate: non-negative integer len, got ${String(len)}`);
    }
    const data = await readFile(this.#path);
    if (data.byteLength <= len) return undefined;
    return _wsWriteFile(this.#path, data.subarray(0, len), undefined);
  }

  async chmod(mode) {
    return _wsChmod(this.#path, mode);
  }

  /** sync() — nothing to flush: the store is memory. */
  async sync() { /* the VFS is memory; nothing to flush */ }

  async datasync() { /* the VFS is memory; nothing to flush */ }

  async close() { /* no descriptor held */ }
}

/** open(path, flags[, mode]) — node's common flag set over the two VFS
 * views. 'r' requires an existing file OR a directory (POSIX lets you open
 * a directory read-only — the jsonl spine fsyncs session dirs that way;
 * the dir handle reads back EISDIR). The exclusive-create flags
 * ('wx'/'xw'/'ax') require absence (EEXIST otherwise) — fs-local's atomic
 * staging contract. 'w' truncates-or-creates (the jsonl write-lease lock
 * file), 'a' appends-or-creates (the jsonl durable append), 'r+' requires
 * existence and rewrites in place (repair/rollback). */
/** Numeric O_* flags (attachment-local's directory fsync passes
 * constants.O_RDONLY): fold the access mode + behavior bits onto the
 * string faces the body below serves. 'wx'/'ax' keep their exclusivity
 * through the x-bit, matching node's O_CREAT|O_EXCL compositions. */
const foldNumericOpenFlags = (flags) => {
  const O = constants;
  const access = flags & 3;
  let text = access === 2 ? 'r+' : access === 1 ? 'w' : 'r';
  if (flags & O.O_APPEND) text = 'a' + (text === 'r+' ? '+' : '');
  if (flags & O.O_EXCL) text += 'x';
  return text;
};

/** The exclusive ('x' flag) open arm: node creates the (empty) file and
 * fails EEXIST when it exists — the staging-file contract fs-local relies
 * on; the handle's writes then fill it. */
const openExclusive = async (path, flags, mode) => {
  if (existsSync(path) || realFileExists(path)) {
    const error = new Error(`EEXIST: file already exists, open '${path}'`);
    error.code = 'EEXIST';
    error.errno = -17;
    error.syscall = 'open';
    error.path = path;
    throw error;
  }
  await writeFile(path, new Uint8Array(0), { mode });
  return new FileHandle(path, flags, flags.includes('a'));
};

export const open = async (path, flags = 'r', mode) => {
  if (typeof flags === 'number') flags = foldNumericOpenFlags(flags);
  if (flags === 'r') {
    if (!existsSync(path)) {
      // The durability walk (attachment-local's syncDirectory) opens every
      // ancestor up to the filesystem root; this VFS serves ONE pinned
      // workspace, so ancestors ABOVE it come back as anonymous empty
      // directory handles (sync/close no-ops) instead of ENOENT — node
      // answers those opens on a real host (R3-D, 2026-09-27).
      const wsRoot = globalThis.__dshProfileTmpdir;
      if (typeof wsRoot === 'string' && path !== undefined && wsRoot.startsWith(path)) {
        return { sync: async () => {}, close: async () => {} };
      }
      throw enoent('open', path);
    }
    return new FileHandle(path, flags);
  }
  if (flags === 'r+') {
    if (!existsSync(path)) throw enoent('open', path);
    return new FileHandle(path, flags);
  }
  if (flags === 'w') {
    // node's 'w': create-or-TRUNCATE at open time; the identity check the
    // jsonl lease runs right after (stat the handle vs the path) needs the
    // file to exist from this point on.
    await writeFile(path, new Uint8Array(0), { mode });
    return new FileHandle(path, flags);
  }
  if (flags === 'a') {
    if (!existsSync(path)) {
      await writeFile(path, new Uint8Array(0), { mode });
    }
    return new FileHandle(path, flags, true);
  }
  if (flags.includes('x')) return openExclusive(path, flags, mode);
  throw new Error(`node:fs/promises: open flag '${flags}' — supported: r, w, a, r+, x-flags (the closure's write paths)`);
};