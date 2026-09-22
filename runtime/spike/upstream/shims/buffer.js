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

const HEX = '0123456789abcdef';
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** UTF-8 encode a string (the only string encoding the closure writes). */
export const encodeUtf8 = (text) => {
  const bytes = new Uint8Array(byteLengthUtf8(text));
  let wrote = 0;
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    wrote += encodeCodePoint(bytes, wrote, code);
  }
  if (wrote !== bytes.length) {
    throw new Error('buffer: utf8 length mismatch (surrogate walk diverged)');
  }
  return bytes;
};

const encodeCodePoint = (bytes, at, code) => {
  if (code <= 0x7f) {
    bytes[at] = code;
    return 1;
  }
  if (code <= 0x7ff) {
    bytes[at] = 0xc0 | (code >> 6);
    bytes[at + 1] = 0x80 | (code & 0x3f);
    return 2;
  }
  if (code <= 0xffff) {
    bytes[at] = 0xe0 | (code >> 12);
    bytes[at + 1] = 0x80 | ((code >> 6) & 0x3f);
    bytes[at + 2] = 0x80 | (code & 0x3f);
    return 3;
  }
  bytes[at] = 0xf0 | (code >> 18);
  bytes[at + 1] = 0x80 | ((code >> 12) & 0x3f);
  bytes[at + 2] = 0x80 | ((code >> 6) & 0x3f);
  bytes[at + 3] = 0x80 | (code & 0x3f);
  return 4;
};

/** UTF-8 byte length of a string (surrogate pairs count once). */
export const byteLengthUtf8 = (text) => {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        i++;
        continue;
      }
    }
    length += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
  }
  return length;
};

/** UTF-8 decode a byte range (lone truncation bytes become U+FFFD). */
export const decodeUtf8 = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b0 = bytes[i];
    if (b0 <= 0x7f) {
      out += String.fromCharCode(b0);
      i += 1;
      continue;
    }
    let length = b0 >= 0xf0 ? 4 : b0 >= 0xe0 ? 3 : b0 >= 0xc0 ? 2 : 0;
    if (length === 0 || i + length > bytes.length) {
      out += '\uFFFD';
      i += 1;
      continue;
    }
    let code = b0 & (0x7f >> length);
    let valid = true;
    for (let k = 1; k < length; k++) {
      const bk = bytes[i + k];
      if ((bk & 0xc0) !== 0x80) { valid = false; break; }
      code = (code << 6) | (bk & 0x3f);
    }
    if (!valid || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      out += '\uFFFD';
      i += 1;
      continue;
    }
    if (code <= 0xffff) out += String.fromCharCode(code);
    else {
      code -= 0x10000;
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    }
    i += length;
  }
  return out;
};

const toStringHex = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0xf];
  }
  return out;
};

const B64_INDEX = new Map([...B64].map((ch, i) => [ch, i]));

const fromBase64 = (text) => {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4) - pad);
  let at = 0;
  let bits = 0;
  let acc = 0;
  for (const ch of clean) {
    acc = (acc << 6) | B64_INDEX.get(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  if (at !== out.length) {
    throw new Error('buffer: base64 decode length mismatch');
  }
  return out;
};

const toStringBase64 = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const rem = bytes.length - i;
    const b0 = bytes[i];
    const b1 = rem > 1 ? bytes[i + 1] : 0;
    const b2 = rem > 2 ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += rem > 1 ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += rem > 2 ? B64[b2 & 63] : '=';
  }
  return out;
};

const ENCODINGS = { utf8: decodeUtf8, 'utf-8': decodeUtf8, hex: toStringHex, base64: toStringBase64 };

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
      throw new Error(`buffer: Buffer.from(string, '${encoding}') — only utf8 and base64 are supported`);
    }
    if (input instanceof Uint8Array || Array.isArray(input)) {
      const out = new DshBuffer(input.length);
      for (let i = 0; i < input.length; i++) out[i] = input[i] & 0xff;
      return out;
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

  toString(encoding = 'utf8') {
    const render = ENCODINGS[encoding];
    if (render === undefined) {
      throw new Error(`buffer: toString('${encoding}') — supported encodings: utf8, hex, base64`);
    }
    return render(this);
  }

  get byteLength() { return this.length; }
}

/** The module face: node:buffer exports the Buffer binding itself (the
 * vendored dsh-attachment imports `{ Buffer } from 'node:buffer'`), and it
 * is the SAME class web-shims.js installs as the global. */
export { DshBuffer as Buffer };
