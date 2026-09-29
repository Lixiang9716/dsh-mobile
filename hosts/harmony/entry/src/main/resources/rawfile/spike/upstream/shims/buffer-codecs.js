// dsh:logging-exempt (shim layer)
/**
 * shims/buffer-codecs.js — the codec half of the buffer shim: the
 * base64/base64url/hex/latin1 codecs (split out of buffer.js when that file
 * first crossed the code-size budget) and, since the W9 round, the UTF codec
 * half (encodeUtf8/decodeUtf8, the utf16le pair, isUtf8, byteLengthUtf8, the
 * toString ENCODINGS table, and the module-captured string intrinsics the
 * UTF walks use). One-way dependency: this module imports nothing from
 * buffer.js; buffer.js re-exports the moved names so every existing import
 * keeps its specifier.
 */

const HEX = '0123456789abcdef';
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export const toStringHex = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0xf];
  }
  return out;
};

const B64_INDEX = new Map([...B64].map((ch, i) => [ch, i]));

export const fromBase64 = (text) => {
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

export const toStringBase64 = (bytes) => {
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

/** base64url — the RFC 4648 §5 alphabet (-_ for +/, no padding). Decode maps
 * back onto the standard alphabet and rides fromBase64. */
export const fromBase64Url = (text) => fromBase64(text.replace(/-/g, '+').replace(/_/g, '/'));

export const toStringBase64Url = (bytes) => toStringBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** hex decode — byte-at-a-time base16; odd length or a non-hex pair throws
 * (node's behavior). */
export const fromHex = (text) => {
  if (text.length % 2 !== 0) {
    throw new Error('buffer: hex decode: odd-length string');
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < text.length; i += 2) {
    const hi = Number.parseInt(text.slice(i, i + 2), 16);
    if (Number.isNaN(hi)) {
      throw new Error(`buffer: hex decode: invalid byte '${text.slice(i, i + 2)}'`);
    }
    out[i / 2] = hi;
  }
  return out;
};

export const toStringAscii = (buffer) => {
  // latin1 family: one byte per code unit (node's 'ascii' masks the high bit
  // only for non-ASCII input bytes; the corpus's headers are pure ASCII).
  let text = '';
  for (let i = 0; i < buffer.length; i++) text += String.fromCharCode(buffer[i] & 0xff);
  return text;
};

// ---- UTF codec half (moved from buffer.js, W9) ---------------------------
//
// Module-captured string intrinsics: the UTF-8 walks below MUST NOT consult
// String.prototype live — the ptc-runtime output-json suite mutates
// model-visible globals (charCodeAt/codePointAt) and its contract is that
// module-captured intrinsics keep working (measured 2026-09-27). The same
// capture discipline the vendored output-json module models. The capture now
// happens at THIS module's evaluation: buffer.js imports it, and imports are
// evaluated before the importing module's body, so the capture lands even
// earlier in the boot graph than when it lived in buffer.js.

export const intrinsicCharCodeAt = String.prototype.charCodeAt;
export const intrinsicFromCharCode = String.fromCharCode;

/** UTF-8 encode a string (the only string encoding the closure writes). */
export const encodeUtf8 = (text) => {
  const bytes = new Uint8Array(byteLengthUtf8(text));
  let wrote = 0;
  for (let i = 0; i < text.length; i++) {
    let code = intrinsicCharCodeAt.call(text, i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = intrinsicCharCodeAt.call(text, i + 1);
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
export { encodeCodePoint };

/** UTF-8 byte length of a string (surrogate pairs count once). */
export const byteLengthUtf8 = (text) => {
  let length = 0;
  for (let i = 0; i < text.length; i++) {
    const code = intrinsicCharCodeAt.call(text, i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = intrinsicCharCodeAt.call(text, i + 1);
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

/** buffer.isUtf8 — node's pure-JS-face UTF-8 validity check (added for the
 * vendored ws receiver's text-frame validation, W5-Q 2026-09-28). A strict
 * structural scan: lead-byte/continuation shape, no overlong encodings, no
 * surrogates, no values above U+10FFFF. */
export const isUtf8 = (bytes) => {
  if (bytes === null || typeof bytes !== 'object') return false;
  const view = bytes instanceof Uint8Array
    ? bytes
    : new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? 0);
  for (let i = 0; i < view.length;) {
    const b0 = view[i];
    if (b0 <= 0x7f) { i += 1; continue; }
    let length;
    if (b0 >= 0xc2 && b0 <= 0xdf) length = 2;
    else if (b0 >= 0xe0 && b0 <= 0xef) length = 3;
    else if (b0 >= 0xf0 && b0 <= 0xf4) length = 4;
    else return false;
    if (i + length > view.length) return false;
    for (let k = 1; k < length; k++) {
      if ((view[i + k] & 0xc0) !== 0x80) return false;
    }
    const code = length === 2
      ? ((b0 & 0x1f) << 6) | (view[i + 1] & 0x3f)
      : length === 3
        ? ((b0 & 0x0f) << 12) | ((view[i + 1] & 0x3f) << 6) | (view[i + 2] & 0x3f)
        : ((b0 & 0x07) << 18) | ((view[i + 1] & 0x3f) << 12) | ((view[i + 2] & 0x3f) << 6) | (view[i + 3] & 0x3f);
    if (code >= 0xd800 && code <= 0xdfff) return false;
    if (length === 3 && code < 0x800) return false;
    if (length === 4 && code < 0x10000) return false;
    i += length;
  }
  return true;
};

/** UTF-8 decode a byte range (lone truncation bytes become U+FFFD). */
export const decodeUtf8 = (bytes) => {  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b0 = bytes[i];
    if (b0 <= 0x7f) {
      out += intrinsicFromCharCode(b0);
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
    if (code <= 0xffff) out += intrinsicFromCharCode(code);
    else {
      code -= 0x10000;
      out += intrinsicFromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
    }
    i += length;
  }
  return out;
};

/** UTF-16LE encode: code units as 2-byte LE pairs — the raw code-unit copy
 * node's encoder does (a lone surrogate writes as-is). W7-X1: the vendored
 * terminal-bash BoundedTextBuffer normalizes every chunk through the
 * `Buffer.from(text, 'utf16le').toString('utf16le')` round-trip. */
export const encodeUtf16le = (text) => {
  const bytes = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = intrinsicCharCodeAt.call(text, i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = code >>> 8;
  }
  return bytes;
};

/** UTF-16LE decode: LE pairs back into code units. node's
 * Buffer.toString('utf16le') is a RAW code-unit copy — lone surrogates are
 * valid UTF-16 content and SURVIVE the round-trip, and an odd trailing byte
 * drops silently (measured on node 24: '\ud83d' round-trips byte-exact;
 * [0x61,0x00,0x41] decodes to 'a'). The vendored terminal-bash scrollback
 * normalizes every chunk through exactly this round-trip and its reference
 * semantics keep lone surrogates — the earlier FFFD-for-any-surrogate
 * spelling turned every split surrogate into U+FFFD (W8: the
 * session-buffer suite's lone-and-split-surrogate faces). */
export const decodeUtf16le = (bytes) => {
  let out = '';
  const units = bytes.length - (bytes.length % 2);
  for (let i = 0; i < units; i += 2) {
    out += intrinsicFromCharCode(bytes[i] | (bytes[i + 1] << 8));
  }
  return out;
};

/** The toString(encoding) dispatch table — decode face per label. Lives
 * beside the codecs it dispatches to (W9 split); buffer.js imports it for
 * DshBuffer.prototype.toString. Declared after the decoders it references
 * (const TDZ discipline). */
export const ENCODINGS = {
  utf8: decodeUtf8, 'utf-8': decodeUtf8, hex: toStringHex, base64: toStringBase64, base64url: toStringBase64Url,
  ascii: toStringAscii, latin1: toStringAscii, binary: toStringAscii,
  utf16le: decodeUtf16le, 'utf-16le': decodeUtf16le, ucs2: decodeUtf16le, 'ucs-2': decodeUtf16le,
};
