// dsh:logging-exempt (shim layer: pure codecs, no logging surface of its own)
'use strict';
/**
 * Byte helpers for the sharp face's codecs (CJS — this package loads through
 * the userland cjs-loader on the dsh and plain node elsewhere, so it must
 * carry no ESM imports). Everything is plain Uint8Array arithmetic over the
 * runtime's Buffer global (DshBuffer on the dsh — a Uint8Array subclass).
 */

/** u16 big-endian read. */
exports.u16be = (b, o) => (b[o] << 8) | b[o + 1];
/** u16 little-endian read. */
exports.u16le = (b, o) => b[o] | (b[o + 1] << 8);
/** u32 big-endian read. */
exports.u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
/** u32 little-endian read. */
exports.u32le = (b, o) => ((b[o + 3] << 24) | (b[o + 2] << 16) | (b[o + 1] << 8) | b[o]) >>> 0;

/** ascii match at offset (no allocations on the probe paths). */
exports.asciiAt = (b, o, s) => {
  if (b.length < o + s.length) return false;
  for (let i = 0; i < s.length; i += 1) {
    if (b[o + i] !== s.charCodeAt(i)) return false;
  }
  return true;
};

/** CRC32 (PNG chunk / general): table-driven, spec polynomial 0xEDB88320. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
exports.crc32 = (bytes, start = 0, end = bytes.length) => {
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};

/** Concatenate byte arrays into one Uint8Array. */
exports.concat = (parts, total) => {
  let length = total;
  if (typeof length !== 'number') {
    length = 0;
    for (const p of parts) length += p.length;
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p.subarray ? p.subarray(0, Math.min(p.length, length - at)) : p, at);
    at += p.length;
    if (at >= length) break;
  }
  return out;
};

/** Case-insensitive ASCII lower compare helper for FourCC chunks. */
exports.fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
