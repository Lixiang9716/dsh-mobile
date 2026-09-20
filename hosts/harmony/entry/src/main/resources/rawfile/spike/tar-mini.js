/**
 * tar-mini — a minimal POSIX ustar writer + reader for the M3 install
 * pipeline (the spike package format). Uncompressed tar, on purpose: a
 * package "tgz" is gzip+tar and the frozen gateway has no inflate primitive
 * — the digest/verify/unpack semantics under test are the tar layer, so the
 * spike ships an uncompressed archive and the gzip transport coding lands
 * with the real fetch-based installer. Everything is deterministic
 * (mtime 0, uid/gid 0, empty uname/gname) so fixture bytes — and therefore
 * digests — are reproducible run to run.
 *
 * Reader rejects (fail loud): bad magic/checksum, non-file entry types, and
 * any member path that is absolute or carries a `..` segment (a package is
 * data, but it is hostile-until-verified data).
 */
import { createLogger } from 'logger.js';

const log = createLogger('dsh.tar-mini');
const BLOCK = 512;

const octal = (value, width) => {
  log.debug('tar octal field', { value });
  const digits = value.toString(8).padStart(width - 1, '0');
  if (digits.length > width - 1) throw new Error(`tar: field overflow (${value})`);
  return digits + '\0';
};

const asciiBytes = (text, len) => {
  log.debug('tar ascii field', { chars: Math.min(text.length, len) });
  const out = new Uint8Array(len);
  for (let i = 0; i < Math.min(text.length, len); i++) out[i] = text.charCodeAt(i);
  return out;
};

const pad2 = (bytes) => {
  log.debug('tar pad block', { bytes: bytes.length });
  const rest = bytes.length % BLOCK;
  if (rest === 0) return bytes;
  const out = new Uint8Array(bytes.length + (BLOCK - rest));
  out.set(bytes);
  return out;
};

/** Member path guard, shared by writer and reader (fail loud per rule 5). */
const assertMemberPath = (path) => {
  log.debug('member path check', { path });
  const bad = typeof path !== 'string' || path.length === 0 || path.startsWith('/')
    || path.split('/').some((seg) => seg === '' || seg === '..');
  if (bad) throw new Error(`tar: unsafe member path: ${path}`);
};

/** Serialize {path, bytes} members into one ustar archive (two zero blocks
 * terminate it). */
export const tarWrite = (members) => {
  log.debug('tar write', { members: members.length });
  const chunks = [];
  for (const { path, bytes } of members) {
    assertMemberPath(path);
    const head = new Uint8Array(BLOCK);
    const put = (field, value) => head.set(asciiBytes(value, field.len), field.at);
    put({ at: 0, len: 100 }, path);
    put({ at: 100, len: 8 }, octal(0o644, 8)); // mode
    put({ at: 108, len: 8 }, octal(0, 8)); // uid
    put({ at: 116, len: 8 }, octal(0, 8)); // gid
    put({ at: 124, len: 12 }, octal(bytes.length, 12)); // size
    put({ at: 136, len: 12 }, octal(0, 12)); // mtime 0 — deterministic
    head[156] = '0'.charCodeAt(0); // typeflag: regular file
    put({ at: 257, len: 6 }, 'ustar\0'); // magic (POSIX ustar, not GNU)
    put({ at: 263, len: 2 }, '00'); // version
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i < 148 || i >= 156 ? head[i] : 32;
    const chk = sum.toString(8).padStart(6, '0');
    head.set(asciiBytes(chk + '\0 ', 8), 148);
    chunks.push(head, pad2(bytes));
  }
  chunks.push(new Uint8Array(BLOCK * 2)); // archive terminator
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};

/** Parse a ustar archive back into [{path, bytes}] (regular files only). */
export const tarRead = (bytes) => {
  log.debug('tar read', { bytes: bytes.length });
  if (bytes.length % BLOCK !== 0) throw new Error('tar: size is not block-aligned');
  const members = [];
  let at = 0;
  while (at + BLOCK <= bytes.length) {
    const head = bytes.subarray(at, at + BLOCK);
    if (head.every((b) => b === 0)) break; // terminator block
    let stored = 0;
    for (let i = 0; i < BLOCK; i++) stored += i < 148 || i >= 156 ? head[i] : 32;
    const claimed = parseInt(String.fromCharCode(...head.subarray(148, 154)), 8);
    if (stored !== claimed) throw new Error(`tar: checksum drift at offset ${at}`);
    if (String.fromCharCode(...head.subarray(257, 262)) !== 'ustar') {
      throw new Error('tar: not a ustar archive');
    }
    const type = String.fromCharCode(head[156]);
    if (type !== '0' && type !== '\0') {
      throw new Error(`tar: unsupported member type: ${type}`);
    }
    let path = '';
    for (let i = 0; i < 100 && head[i] !== 0; i++) path += String.fromCharCode(head[i]);
    const size = parseInt(String.fromCharCode(...head.subarray(124, 136)).replace(/\0.*$/, ''), 8);
    assertMemberPath(path);
    const data = bytes.subarray(at + BLOCK, at + BLOCK + size);
    members.push({ path, bytes: new Uint8Array(data) });
    at += BLOCK + pad2(new Uint8Array(size)).length;
  }
  if (members.length === 0) throw new Error('tar: archive has no members');
  return members;
};
