// dsh:logging-exempt (shim layer)
/**
 * node:crypto shim — the members the vendored closure imports.
 *
 * Covers (upstream usage → this module):
 *   - dsh-agent-loop, dsh-sdk-protocol (`randomUUID`) — message/attempt
 *     identity; built on the spike host's `crypto.getRandomValues` (the same
 *     platform RNG seam the M1 spike proved).
 *   - dsh-client-modules (`createHash('sha1')`) — the web-boot revision
 *     scheme: shortHash/framedHash over entry graphs, combo records, and
 *     staged bundle bytes (W-INTEG leg). Pure-JS SHA-1: 12-hex truncated
 *     content revisions, not security.
 *   - dsh-client-modules (`randomBytes(8)`) — the per-boot initial-row
 *     revision nonce; rendered through DshBuffer.toString('hex').
 *   - dsh-tool-skill (`createHash('sha256')`) — the session skill-catalog
 *     digest (agent-flow leg): content identity over the durable catalog
 *     entries, hex digested. Pure-JS SHA-256 through the spike's own
 *     sha256.js (the install pipeline's primitive — one implementation, no
 *     second hand-rolled copy).
 *
 * Intentionally NOT supported: everything else (ciphers, HMAC, other digests —
 * content addressing elsewhere in the spike stays sha256.js). An import or
 * algorithm name outside this table is loud (rule 5).
 */
import { DshBuffer, encodeUtf8 } from 'upstream/shims/buffer.js';
// sha512 + HMAC ride the VERBATIM vendored @noble/hashes tree (the same
// pinned 2.3.0 the crypto-globals limbs use; sha1/sha256 keep the in-file
// implementations below). Noble digests bytes->bytes, matching the face.
import { sha512 as nobleSha512 } from '@noble/hashes/sha2.js';
import { hmac as nobleHmac } from '@noble/hashes/hmac.js';
import { sha256Hex } from 'sha256.js';

const randomUUID = () => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Pure-JS SHA-1 over byte arrays (FIPS 180-1). 32-bit ops via Math.floor
 * arithmetic: quickjs has no Int32 overflow semantics to lean on beyond
 * `|0`, so every add re-truncates — correct, and irrelevant at staged-bundle
 * sizes. */
const sha1Digest = (bytes) => {
  const ml = bytes.length;
  const withPadding = ((ml + 8) >> 6) + 1; // 64-byte blocks incl. length tail
  const words = new Int32Array(withPadding * 16);
  for (let i = 0; i < ml; i++) {
    words[i >> 2] |= bytes[i] << ((3 - (i & 3)) * 8);
  }
  words[ml >> 2] |= 0x80 << ((3 - (ml & 3)) * 8);
  // message length in bits, 64-bit big-endian tail (high 32 bits: 0 — no
  // staged bundle reaches 512 MiB)
  words[words.length - 1] = (ml * 8) | 0;

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);
  const rol = (x, n) => (x << n) | (x >>> (32 - n));
  for (let block = 0; block < withPadding; block++) {
    const off = block * 16;
    for (let i = 0; i < 16; i++) w[i] = words[off + i];
    for (let i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const temp = (rol(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rol(b, 30); b = a; a = temp;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  const out = new Uint8Array(20);
  [h0, h1, h2, h3, h4].forEach((h, i) => {
    out[i * 4] = (h >>> 24) & 0xff;
    out[i * 4 + 1] = (h >>> 16) & 0xff;
    out[i * 4 + 2] = (h >>> 8) & 0xff;
    out[i * 4 + 3] = h & 0xff;
  });
  return out;
};

/** sha256.js digests to lowercase hex; the createHash face digests to bytes
 * and lets digest() render. Hex → bytes keeps one SHA-256 implementation. */
const sha256Digest = (bytes) => {
  const hex = sha256Hex(bytes);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

const SUPPORTED_ALGOS = { sha1: sha1Digest, sha256: sha256Digest, sha512: nobleSha512 };

/** createHmac(algorithm, key) — HMAC over the same digest set, built on the
 * vendored noble hmac combinator (block sizes and ipad/opad handling stay
 * noble's problem; node's `hmac.update()`/`digest()` shapes are kept). */
const createHmac = (algorithm, key) => {
  const nobleHash = { sha1: sha1Digest, sha256: sha256Digest, sha512: nobleSha512 }[algorithm];
  if (nobleHash === undefined) {
    throw new Error(`node:crypto: createHmac('${algorithm}') is not supported `
      + `by the spike runtime (supported: sha1, sha256, sha512)`);
  }
  let keyBytes;
  if (typeof key === 'string') keyBytes = encodeUtf8(key);
  else if (key instanceof Uint8Array || Array.isArray(key)) keyBytes = Uint8Array.from(key);
  else throw new TypeError(`node:crypto: createHmac key (${typeof key}) is not supported`);
  let fed = new Uint8Array(0);
  const h = {
    update(data, encoding = 'utf8') {
      let chunk;
      if (typeof data === 'string') chunk = encodeUtf8(data);
      else if (data instanceof Uint8Array || Array.isArray(data)) chunk = Uint8Array.from(data);
      else throw new TypeError(`node:crypto: hmac.update(${typeof data}) is not supported`);
      const merged = new Uint8Array(fed.length + chunk.length);
      merged.set(fed);
      merged.set(chunk, fed.length);
      fed = merged;
      return h;
    },
    digest(encoding = 'buffer') {
      const bytes = nobleHmac(nobleHash, keyBytes, fed);
      if (encoding === 'buffer' || encoding === undefined) return DshBuffer.fromBytes(bytes);
      if (encoding === 'hex') return DshBuffer.fromBytes(bytes).toString('hex');
      if (encoding === 'base64') return DshBuffer.fromBytes(bytes).toString('base64');
      throw new Error(`node:crypto: hmac.digest('${encoding}') — supported: buffer, hex, base64`);
    },
  };
  return h;
};

const createHash = (algorithm) => {
  const digestOf = SUPPORTED_ALGOS[algorithm];
  if (digestOf === undefined) {
    throw new Error(`node:crypto: createHash('${algorithm}') is not supported `
      + `by the spike runtime (supported: ${Object.keys(SUPPORTED_ALGOS).join(', ')})`);
  }
  let fed = new Uint8Array(0);
  const hash = {
    update(data, encoding = 'utf8') {
      let chunk;
      if (typeof data === 'string') {
        if (encoding !== 'utf8' && encoding !== 'utf-8') {
          throw new Error(`node:crypto: hash.update(string, '${encoding}') — only utf8 is supported`);
        }
        chunk = encodeUtf8(data);
      } else if (data instanceof Uint8Array || Array.isArray(data)) {
        chunk = Uint8Array.from(data);
      } else {
        throw new TypeError(`node:crypto: hash.update(${typeof data}) is not supported`);
      }
      const merged = new Uint8Array(fed.length + chunk.length);
      merged.set(fed);
      merged.set(chunk, fed.length);
      fed = merged;
      return hash;
    },
    digest(encoding = 'buffer') {
      const bytes = digestOf(fed);
      if (encoding === 'buffer' || encoding === undefined) return DshBuffer.fromBytes(bytes);
      if (encoding === 'hex') return DshBuffer.fromBytes(bytes).toString('hex');
      if (encoding === 'base64') return DshBuffer.fromBytes(bytes).toString('base64');
      throw new Error(`node:crypto: hash.digest('${encoding}') — supported: buffer, hex, base64`);
    },
  };
  return hash;
};

/** timingSafeEqual(a, b) — node's constant-time byte comparison: lengths
 * must match (TypeError otherwise), result is a boolean. The comparison
 * walks every byte regardless of early mismatch. */
const timingSafeEqual = (a, b) => {
  const da = a instanceof Uint8Array ? a : Uint8Array.from(a);
  const db = b instanceof Uint8Array ? b : Uint8Array.from(b);
  if (da.length !== db.length) {
    throw new TypeError(`node:crypto: timingSafeEqual needs equal-length buffers (got ${da.length} vs ${db.length})`);
  }
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
};

const randomBytes = (size) => {
  if (!Number.isInteger(size) || size < 0) {
    throw new TypeError(`node:crypto: randomBytes(${size}) needs a non-negative integer`);
  }
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return DshBuffer.fromBytes(bytes);
};

export { randomUUID, createHash, createHmac, timingSafeEqual, randomBytes };
export const webcrypto = globalThis.crypto;
