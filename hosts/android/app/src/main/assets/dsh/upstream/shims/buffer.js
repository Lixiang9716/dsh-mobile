// dsh:logging-exempt (shim layer)
/**
 * buffer shim — the byte-string bridge the vendored closure needs once the
 * web-boot closure (@deepseek-ai/dsh-client-modules) joins the mounted graph.
 *
 * Covers (upstream usage → this module):
 *   - Buffer.from(string)      — client-modules prepares combo sources and
 *                                hashes the staged bundle bytes.
 *   - Buffer.concat            — combo body assembly.
 *   - Buffer.byteLength        — URL-length budgeting (partitionComboRecords).
 *   - buf.toString('hex')      — randomBytes nonce (client-modules
 *                                initialRevisionNonce), digest rendering.
 *   - buf.toString('utf8')     — package.json reads via readFileSync(p) and
 *                                explicit utf8 decodes.
 *   - buf.byteLength / length  — framedHash length framing.
 *   - Buffer.isBuffer          — vendored type guards.
 *
 * Uint8Array subclass: every upstream Buffer consumer in the mounted closure
 * treats it as a byte view; nothing reaches for Node-only members (writeInt32
 * & co.), and any unknown encoding fails loud (rule 5). Installed as the
 * `Buffer` global by web-shims.js; exported here so the node:crypto / node:fs
 * shims construct the SAME class.
 */

// The codec half lives in buffer-codecs.js (the file crossed the code-size
// budget; the base64/hex/latin1 codecs moved first, and W9 moved the UTF
// half — encodeUtf8/decodeUtf8, the utf16le pair, isUtf8, byteLengthUtf8,
// the toString ENCODINGS table, and the module-captured string intrinsics —
// beside them). Re-exported here so every existing import keeps its
// specifier; the codecs module imports NOTHING from this file (one-way; a
// shim-shim import cycle kills QuickJS at link). The intrinsic capture
// rationale lives in buffer-codecs.js's UTF-half header — its capture lands
// at that module's evaluation, before this body runs.
import {
  fromBase64, fromBase64Url, fromHex,
  intrinsicCharCodeAt, intrinsicFromCharCode,
  encodeUtf8, encodeCodePoint, byteLengthUtf8, isUtf8, decodeUtf8,
  encodeUtf16le, decodeUtf16le, ENCODINGS,
} from 'upstream/shims/buffer-codecs.js';
export {
  fromBase64, fromBase64Url, fromHex,
  intrinsicCharCodeAt, intrinsicFromCharCode,
  encodeUtf8, encodeCodePoint, byteLengthUtf8, isUtf8, decodeUtf8,
  encodeUtf16le, decodeUtf16le,
};
// The split loopback shims' free-variable helper fallback (W8): mounted
// here because every module that reaches those call sites already imports
// this one — see boot-tail-loopback-globals.js's header.
import 'upstream/shims/boot-tail-loopback-globals.js';
// The WHATWG URL hash-setter completion (W8) — same in-lease boot-chain
// mount, same rationale; see boot-tail-url-mutators.js's header.
import 'upstream/shims/boot-tail-url-mutators.js';

/** buffer.constants — the byte-cap bounds vendored code validates against
 * (fs-local's diff-basis ceiling). The VFS holds whole files in memory, so
 * the values are the theoretical maxima, not a real allocation limit. */
export const constants = {
  MAX_LENGTH: 4294967296,
  MAX_STRING_LENGTH: 536870888,
};

export class DshBuffer extends Uint8Array {
  static from(input, encoding = 'utf8') {
    if (typeof input === 'string') {
      if (encoding === 'utf8' || encoding === 'utf-8') {
        return DshBuffer.fromBytes(encodeUtf8(input));
      }
      if (encoding === 'base64') {
        return DshBuffer.fromBytes(fromBase64(input));
      }
      if (encoding === 'base64url') {
        return DshBuffer.fromBytes(fromBase64Url(input));
      }
      if (encoding === 'hex') {
        return DshBuffer.fromBytes(fromHex(input));
      }
      if (encoding === 'ascii' || encoding === 'latin1' || encoding === 'binary') {
        // latin1-family: one byte per code unit, truncated to 8 bits — the
        // single-byte encodings node maps onto the same lossy copy.
        const out = new DshBuffer(input.length);
        for (let i = 0; i < input.length; i++) out[i] = input.charCodeAt(i) & 0xff;
        return out;
      }
      if (encoding === 'utf16le' || encoding === 'utf-16le' || encoding === 'ucs2' || encoding === 'ucs-2') {
        return DshBuffer.fromBytes(encodeUtf16le(input));
      }
      throw new Error(`buffer: Buffer.from(string, '${encoding}') — only utf8, base64, the single-byte family (ascii/latin1/binary), and utf16le are supported`);
    }
    if (input instanceof Uint8Array || Array.isArray(input)) {
      const out = new DshBuffer(input.length);
      for (let i = 0; i < input.length; i++) out[i] = input[i] & 0xff;
      return out;
    }
    if (input instanceof ArrayBuffer) {
      // Buffer.from(arrayBuffer, byteOffset, length) — the node 3-arg face
      // (a VIEW over the same bytes, not a copy). The fetch-body capture in
      // the inspector closure re-views every chunk this way (measured
      // 2026-09-27, fetch-observer.host's rejected-reader-cancellation test).
      const byteOffset = typeof encoding === 'number' ? encoding : 0;
      const length = typeof arguments[2] === 'number' ? arguments[2] : input.byteLength - byteOffset;
      const bytes = new Uint8Array(input, byteOffset, length);
      return DshBuffer.fromBytes(bytes);
    }
    throw new TypeError(`buffer: Buffer.from(${typeof input}) is not supported`);
  }

  /** Buffer.alloc(size[, fill]) — zero-filled by default (node's contract;
   * a number fill is truncated to one byte). */
  static alloc(size, fill = 0) {
    const out = new DshBuffer(size);
    if (typeof fill === 'number') out.fill(fill & 0xff);
    else if (typeof fill === 'string') {
      const bytes = encodeUtf8(fill);
      for (let at = 0; at < size; at += bytes.length) out.set(bytes.subarray(0, Math.min(bytes.length, size - at)), at);
    } else if (fill instanceof Uint8Array && fill.length > 0) {
      for (let at = 0; at < size; at += fill.length) out.set(fill.subarray(0, Math.min(fill.length, size - at)), at);
    }
    return out;
  }

  /** Buffer.allocUnsafe(size) — node returns uninitialized memory for speed;
   * there is no uninitialized memory to hand out here, so this is alloc(0)
   * with the same signature (callers overwrite every byte they read back). */
  static allocUnsafe(size) {
    return new DshBuffer(size);
  }

  /** buf.copy(target[, targetStart[, sourceStart[, sourceEnd]]]) — the byte
   * mover the wire framings use (ssh readFrames, the ptc-runtime channel's
   * header/payload assembly). Returns the number of bytes copied, node's
   * contract; bounds clamp like node (no throw on over-long target). */
  copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
    if (!(target instanceof Uint8Array)) {
      throw new TypeError(`buffer.copy: target must be a Uint8Array, got ${typeof target}`);
    }
    const start = Math.max(0, sourceStart);
    const end = Math.min(this.length, sourceEnd);
    const count = Math.max(0, Math.min(end - start, target.length - targetStart));
    if (count > 0) target.set(this.subarray(start, start + count), targetStart);
    return count;
  }

  /** buf.write(string[, offset[, length]][, encoding]) — node's string
   * writer, the write-side sibling of copy (W8, 2026-09-29): the vendored
   * ws sender's close frame assembles its status reason through it
   * (sender.js close → buf.write(reason, 2)), and the missing face surfaced
   * as `TypeError: not a function` one hop inside the mux's 1003/1008
   * close paths (the gateway stream-server carrier suite). Writes the
   * encoded bytes at offset, clamped to length and the buffer end; returns
   * the bytes written (node's contract). Encodings follow the static
   * from() family's discipline: utf8 default, latin1/ascii/binary one byte
   * per code unit, everything else fails loud (rule 5). */
  write(input, offset = 0, length = this.length - offset, encoding = 'utf8') {
    if (typeof input !== 'string') {
      throw new TypeError(`buffer.write: input must be a string, got ${typeof input}`);
    }
    let bytes;
    if (encoding === 'utf8' || encoding === 'utf-8') bytes = encodeUtf8(input);
    else if (encoding === 'latin1' || encoding === 'ascii' || encoding === 'binary') {
      bytes = new Uint8Array(input.length);
      for (let at = 0; at < input.length; at++) bytes[at] = input.charCodeAt(at) & 0xff;
    } else {
      throw new TypeError(`buffer.write: unsupported encoding '${encoding}'`);
    }
    const start = Math.max(0, offset);
    const writable = Math.max(0, Math.min(length, this.length - start));
    const count = Math.min(bytes.length, writable);
    if (count > 0) this.set(bytes.subarray(0, count), start);
    return count;
  }

  static fromBytes(bytes) {
    const out = new DshBuffer(bytes.length);
    out.set(bytes);
    return out;
  }

  static isBuffer(value) {
    return value instanceof DshBuffer;
  }

  /** UTF-8 byte length of a string (the only string encoding counted). */
  static byteLength(input, encoding = 'utf8') {
    if (typeof input !== 'string') {
      if (input instanceof Uint8Array || Array.isArray(input)) return input.length;
      throw new TypeError(`buffer: Buffer.byteLength(${typeof input}) is not supported`);
    }
    if (encoding !== 'utf8' && encoding !== 'utf-8') {
      throw new Error(`buffer: Buffer.byteLength(string, '${encoding}') — only utf8 is supported`);
    }
    return byteLengthUtf8(input);
  }

  static concat(list) {
    if (!Array.isArray(list)) {
      throw new TypeError('buffer: Buffer.concat needs an array of buffers');
    }
    let total = 0;
    for (const item of list) total += item.length;
    const out = new DshBuffer(total);
    let at = 0;
    for (const item of list) { out.set(item, at); at += item.length; }
    return out;
  }

  /** Buffer.compare(a, b) — node's lexicographic byte ordering (-1/0/1);
   * the session-snapshot workspace spec sorts directory entries through it
   * (measured 2026-09-27, "not a function" inside .sort). */
  static compare(a, b) {
    if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) {
      throw new TypeError('buffer: Buffer.compare needs two Uint8Array arguments');
    }
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    if (a.length === b.length) return 0;
    return a.length < b.length ? -1 : 1;
  }

  /** buf.compare(target) — the instance face of the same ordering. */
  compare(target) { return DshBuffer.compare(this, target); }

  /** buf.equals(other) — byte-wise equality (same contract as compare===0). */
  equals(other) {
    if (!(other instanceof Uint8Array)) return false;
    return DshBuffer.compare(this, other) === 0;
  }

  toString(encoding = 'utf8', start = 0, end = this.length) {
    // node's (encoding, start, end) slice-decode face — the lsp-stdio
    // MessageDecoder parses its header with toString('ascii', 0, separator)
    // (R3-D, 2026-09-27). The window copies byte-wise into the requested
    // encoding's renderer (a slice of utf-8 bytes decodes as utf-8).
    const render = ENCODINGS[encoding];
    if (render === undefined) {
      throw new Error(`buffer: toString('${encoding}') — supported encodings: utf8, hex, base64`);
    }
    if (start === 0 && end === this.length) return render(this);
    const slice = new DshBuffer(Math.max(0, end - start));
    for (let i = 0; i < slice.length; i++) slice[i] = this[start + i];
    return render(slice);
  }

  /** node Buffer.indexOf(value[, byteOffset]) over a STRING needle (a
   * byte-sequence search — the lsp-stdio decoder scans for the
   * '\r\n\r\n' header terminator) or a number. ByteOffset bounds the
   * scan start; -1 on miss, exactly like node. */
  indexOf(value, byteOffset = 0) {
    const from = Math.max(0, Number(byteOffset) || 0);
    if (typeof value === 'number') {
      for (let i = from; i < this.length; i++) if (this[i] === (value & 0xff)) return i;
      return -1;
    }
    const needle = typeof value === 'string' ? encodeUtf8(value) : value;
    if (needle.length === 0) return from <= this.length ? from : -1;
    outer: for (let i = from; i + needle.length <= this.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (this[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  get byteLength() { return this.length; }

  // ---- node Buffer's numeric byte accessors -----------------------------
  // The vendored session-persistence family binary-parses its Zstandard
  // container with these (scanZstdFrames: readUInt32LE/readUInt8/readUIntLE;
  // the tarball/webworker faces: the wider read*/write* set below). Each is
  // little/big-endian fixed-width with node's bounds semantics (RangeError
  // past the end), implemented over DataView views of the same bytes.

  /** Shared bounds check (node throws RangeError beyond the buffer). */
  #viewAt(offset, bytes, op) {
    if (!Number.isInteger(offset) || offset < 0 || offset + bytes > this.length) {
      throw new RangeError(`buffer.${op}: offset ${offset} (+${bytes} bytes) is outside the buffer (length ${this.length})`);
    }
    return new DataView(this.buffer, this.byteOffset, this.byteLength);
  }

  readUInt8(offset = 0) { return this.#viewAt(offset, 1, 'readUInt8').getUint8(offset); }
  readInt8(offset = 0) { return this.#viewAt(offset, 1, 'readInt8').getInt8(offset); }
  readUInt16LE(offset = 0) { return this.#viewAt(offset, 2, 'readUInt16LE').getUint16(offset, true); }
  readUInt16BE(offset = 0) { return this.#viewAt(offset, 2, 'readUInt16BE').getUint16(offset, false); }
  readInt16LE(offset = 0) { return this.#viewAt(offset, 2, 'readInt16LE').getInt16(offset, true); }
  readInt16BE(offset = 0) { return this.#viewAt(offset, 2, 'readInt16BE').getInt16(offset, false); }
  readUInt32LE(offset = 0) { return this.#viewAt(offset, 4, 'readUInt32LE').getUint32(offset, true); }
  readUInt32BE(offset = 0) { return this.#viewAt(offset, 4, 'readUInt32BE').getUint32(offset, false); }
  readInt32LE(offset = 0) { return this.#viewAt(offset, 4, 'readInt32LE').getInt32(offset, true); }
  readInt32BE(offset = 0) { return this.#viewAt(offset, 4, 'readInt32BE').getInt32(offset, false); }
  readBigUInt64LE(offset = 0) { return this.#viewAt(offset, 8, 'readBigUInt64LE').getBigUint64(offset, true); }
  readBigUInt64BE(offset = 0) { return this.#viewAt(offset, 8, 'readBigUInt64BE').getBigUint64(offset, false); }
  readBigInt64LE(offset = 0) { return this.#viewAt(offset, 8, 'readBigInt64LE').getBigInt64(offset, true); }
  readBigInt64BE(offset = 0) { return this.#viewAt(offset, 8, 'readBigInt64BE').getBigInt64(offset, false); }

  /** readUIntLE/readIntLE(offset, byteLength) — node's variable-width forms
   * (the zstd frame scanner reads 3-byte block headers with readUIntLE). */
  readUIntLE(offset, byteLength) {
    if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > 6) {
      throw new TypeError(`buffer.readUIntLE: byteLength must be an integer in [1, 6], got ${String(byteLength)}`);
    }
    this.#viewAt(offset, byteLength, 'readUIntLE');
    let value = 0;
    for (let at = byteLength - 1; at >= 0; at--) value = value * 256 + this[offset + at];
    return value;
  }

  readIntLE(offset, byteLength) {
    const value = this.readUIntLE(offset, byteLength);
    const signBit = 2 ** (byteLength * 8 - 1);
    return value >= signBit ? value - signBit * 2 : value;
  }

  writeUInt8(value, offset = 0) { this.#viewAt(offset, 1, 'writeUInt8').setUint8(offset, value); return offset + 1; }
  writeInt8(value, offset = 0) { this.#viewAt(offset, 1, 'writeInt8').setInt8(offset, value); return offset + 1; }
  writeUInt16LE(value, offset = 0) { this.#viewAt(offset, 2, 'writeUInt16LE').setUint16(offset, value, true); return offset + 2; }
  writeUInt16BE(value, offset = 0) { this.#viewAt(offset, 2, 'writeUInt16BE').setUint16(offset, value, false); return offset + 2; }
  writeInt16LE(value, offset = 0) { this.#viewAt(offset, 2, 'writeInt16LE').setInt16(offset, value, true); return offset + 2; }
  writeInt16BE(value, offset = 0) { this.#viewAt(offset, 2, 'writeInt16BE').setInt16(offset, value, false); return offset + 2; }
  writeUInt32LE(value, offset = 0) { this.#viewAt(offset, 4, 'writeUInt32LE').setUint32(offset, value, true); return offset + 4; }
  writeUInt32BE(value, offset = 0) { this.#viewAt(offset, 4, 'writeUInt32BE').setUint32(offset, value, false); return offset + 4; }
  writeInt32LE(value, offset = 0) { this.#viewAt(offset, 4, 'writeInt32LE').setInt32(offset, value, true); return offset + 4; }
  writeInt32BE(value, offset = 0) { this.#viewAt(offset, 4, 'writeInt32BE').setInt32(offset, value, false); return offset + 4; }
  writeBigUInt64LE(value, offset = 0) { this.#viewAt(offset, 8, 'writeBigUInt64LE').setBigUint64(offset, value, true); return offset + 8; }
  writeBigUInt64BE(value, offset = 0) { this.#viewAt(offset, 8, 'writeBigUInt64BE').setBigUint64(offset, value, false); return offset + 8; }
  writeBigInt64LE(value, offset = 0) { this.#viewAt(offset, 8, 'writeBigInt64LE').setBigInt64(offset, value, true); return offset + 8; }
  writeBigInt64BE(value, offset = 0) { this.#viewAt(offset, 8, 'writeBigInt64BE').setBigInt64(offset, value, false); return offset + 8; }

  writeUIntLE(value, offset, byteLength) {
    if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > 6) {
      throw new TypeError(`buffer.writeUIntLE: byteLength must be an integer in [1, 6], got ${String(byteLength)}`);
    }
    this.#viewAt(offset, byteLength, 'writeUIntLE');
    let v = typeof value === 'bigint' ? value : BigInt(Math.floor(value));
    for (let at = 0; at < byteLength; at++) {
      this[offset + at] = Number(v & 0xffn);
      v >>= 8n;
    }
    return offset + byteLength;
  }

  writeIntLE(value, offset, byteLength) {
    return this.writeUIntLE(value < 0 ? value + 2 ** (byteLength * 8) : value, offset, byteLength);
  }
}

/** The module face: node:buffer exports the Buffer binding itself (the
 * vendored dsh-attachment imports `{ Buffer } from 'node:buffer'`), and it
 * is the SAME class web-shims.js installs as the global. */
export { DshBuffer as Buffer };
