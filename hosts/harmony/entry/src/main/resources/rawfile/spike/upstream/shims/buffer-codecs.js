// dsh:logging-exempt (shim layer)
/**
 * shims/buffer-codecs.js — the base64/base64url/hex/latin1 codec half of the
 * buffer shim, split out of buffer.js when that file crossed the code-size
 * budget. One-way dependency: this module imports nothing from buffer.js;
 * buffer.js re-exports the decoders so every existing import keeps its
 * specifier.
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
