// dsh:logging-exempt (pure function module — a verify takes no policy decisions)
/**
 * Pure-JS Ed25519 VERIFY-ONLY (RFC 8032) for the marketplace resolver.
 *
 * WHY hand-rolled (the sha256.js precedent): the runtime's crypto seams are
 * exactly crypto.getRandomValues + btoa, the gateway has no signature
 * primitive, and the frozen package closure carries no ed25519 (dsh-util-crypto
 * ships base64/uuid only). The marketplace catalog (contract proposal
 * 2026-10-01: data-protocols v1.1.0 candidate) is a SIGNED index — ed25519,
 * verification public key pinned host-side — and trust verification is a pure
 * data operation: no secret key is ever handled here, only public material.
 *
 * Provable-correctness posture: verify-only (nothing here can sign), the
 * field arithmetic is plain BigInt mod p = 2^255-19, and the module is pinned
 * by the RFC 8032 §7.1 test vectors plus tamper rejections (test/panel and
 * the e2e leg both exercise real signatures produced by an INDEPENDENT
 * implementation — node:crypto/OpenSSL — so the two must agree).
 *
 *   verify(publicKeyB64, messageBytes, signatureB64) → true | false
 *
 * Base64 decode is local (the runtime's atob is absent in some embeds); the
 * digest is SHA-512 (FIPS 180-4) in BigInt — sizes here are index-sized
 * (kilobytes), never bulk data (the bulk digests stay sha256 in the pipeline).
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64 → bytes (RFC 4648, padding required). The trailing pad bits encode
 * no byte — the output is floor(bits/8) and non-zero pad bits are a
 * non-canonical encoding (rejected, not rounded up into a phantom byte). */
export const b64ToBytes = (text) => {
  if (typeof text !== 'string' || text.length === 0 || text.length % 4 !== 0) {
    throw new Error('ed25519: publicKey/signature must be padded base64');
  }
  let pad = 0;
  if (text.endsWith('==')) pad = 2;
  else if (text.endsWith('=')) pad = 1;
  const clean = text.slice(0, text.length - pad);
  const out = new Uint8Array(Math.floor(clean.length * 6 / 8));
  let bits = 0;
  let acc = 0;
  let at = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error(`ed25519: bad base64 character ${JSON.stringify(ch)}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) {
    throw new Error('ed25519: non-canonical base64 (non-zero pad bits)');
  }
  return out;
};

// ---- SHA-512 (BigInt; 64-bit words are native there) -----------------------

const MASK64 = (1n << 64n) - 1n;
const K512 = [
  0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
  0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
  0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
  0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
  0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
  0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
  0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
  0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
  0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
  0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
];
const rotr64 = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & MASK64;

/** One 128-byte block through the SHA-512 compression (h updated in place). */
const sha512Block = (h, block, off) => {
  const w = [];
  for (let i = 0; i < 16; i++) {
    let word = 0n;
    for (let j = 0; j < 8; j++) word = (word << 8n) | BigInt(block[off + i * 8 + j]);
    w.push(word);
  }
  for (let i = 16; i < 80; i++) {
    const s0 = rotr64(w[i - 15], 1) ^ rotr64(w[i - 15], 8) ^ (w[i - 15] >> 7n);
    const s1 = rotr64(w[i - 2], 19) ^ rotr64(w[i - 2], 61) ^ (w[i - 2] >> 6n);
    w.push((w[i - 16] + s0 + w[i - 7] + s1) & MASK64);
  }
  let [a, b, c, d, e, f, g, hh] = h;
  for (let i = 0; i < 80; i++) {
    const S1 = rotr64(e, 14) ^ rotr64(e, 18) ^ rotr64(e, 41);
    const ch = (e & f) ^ (~e & g);
    const t1 = (hh + S1 + ch + K512[i] + w[i]) & MASK64;
    const S0 = rotr64(a, 28) ^ rotr64(a, 34) ^ rotr64(a, 39);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (S0 + maj) & MASK64;
    hh = g; g = f; f = e;
    e = (d + t1) & MASK64;
    d = c; c = b; b = a;
    a = (t1 + t2) & MASK64;
  }
  const next = [a, b, c, d, e, f, g, hh];
  for (let i = 0; i < 8; i++) h[i] = (h[i] + next[i]) & MASK64;
};

/** SHA-512 of `bytes` → 64 digest bytes. */
export const sha512Bytes = (bytes) => {
  const bitLen = BigInt(bytes.length) * 8n;
  const padded = ((bytes.length + 17 + 127) >> 7) << 7;
  const buf = new Uint8Array(padded);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const h = [
    0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
    0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
  ];
  // The 128-bit big-endian bit length in the padding's final 16 bytes.
  for (let i = 0; i < 16; i++) {
    buf[padded - 16 + i] = Number((bitLen >> BigInt(8 * (15 - i))) & 0xffn);
  }
  for (let off = 0; off < padded; off += 128) sha512Block(h, buf, off);
  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((h[i] >> BigInt(56 - 8 * j)) & 0xffn);
  }
  return out;
};

// ---- field + curve arithmetic (BigInt mod p = 2^255 - 19) ------------------

const P = (1n << 255n) - 19n;
// d = -121665/121666 mod p, normalized to the positive representative — every
// residue compared below stays in [0, p), so === checks are class checks.
const D = ((-121665n * modPow(121666n, P - 2n)) % P + P) % P;
const SQRT_M1 = modPow(2n, (P - 1n) / 4n);
const L = 2n ** 252n
  + 27742317777372353535851937790883648493n;
const GY = 46316835694926478169428394003475163141307993866256225615783033603165251855960n;
const GX = 15112221349535400772501151409588531511454012693041857206046113283949847762202n;

function modPow(base, exp) {
  let result = 1n;
  let b = base % P;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

/** Extended twisted-Edwards point (X, Y, Z, T with x=X/Z, y=Y/Z, xy=T/Z). */
const pt = (X, Y, Z, T) => ({ X: X % P, Y: Y % P, Z: Z % P, T: T % P });
const BASE = pt(GX, GY, 1n, (GX * GY) % P);
const IDENTITY = pt(0n, 1n, 1n, 0n);

/** Extended twisted-Edwards addition, DERIVED (not recited) from the affine
 * twisted-Edwards law (BJLP08, a = −1): x3 = (x1y2+y1x2)/(1+d·x1x2y1y2),
 * y3 = (y1y2+x1x2)/(1−d·x1x2y1y2). In X=xZ, Y=yZ, T=xyZ terms with
 * U = X1Y2+X2Y1, V = Y1Y2+X1X2, W = Z1Z2, Q = d·T1T2 (note T1T2 = x1x2y1y2·W,
 * so 1+d·x1x2y1y2 = (W+Q)/W): x3 = U/(W+Q), y3 = V/(W−Q) → Z3 = (W+Q)(W−Q),
 * X3 = U(W−Q), Y3 = V(W+Q), T3 = X3Y3/Z3 = U·V. Unified (doubling included),
 * so addPts(a, a) is [2]a. */
const addPts = (a, b) => {
  const U = a.X * b.Y + b.X * a.Y;
  const V = a.Y * b.Y + a.X * b.X;
  const W = a.Z * b.Z;
  const Q = D * a.T * b.T;
  return pt(U * (W - Q), V * (W + Q), (W + Q) * (W - Q), U * V);
};

/** [n]·a by double-and-add (n reduced mod L first — group order). The
 * extended addition above is strongly unified (P = Q included), so doubling
 * is addPts(a, a) — slower per bit than a dedicated dbl, trivially correct. */
const mulPt = (a, n) => {
  let result = IDENTITY;
  let addend = a;
  let k = ((n % L) + L) % L;
  while (k > 0n) {
    if (k & 1n) result = addPts(result, addend);
    addend = addPts(addend, addend);
    k >>= 1n;
  }
  return result;
};

const equalPts = (a, b) =>
  ((a.X * b.Z - b.X * a.Z) % P === 0n) && ((a.Y * b.Z - b.Y * a.Z) % P === 0n);

/** 32-byte little-endian → BigInt (scalars, y coordinates). */
const le256 = (bytes, off) => {
  let v = 0n;
  for (let i = 31; i >= 0; i--) v = (v << 8n) | BigInt(bytes[off + i]);
  return v;
};

/** 64-byte little-endian → BigInt (the SHA-512 verify hash before mod L). */
const le512 = (bytes, off) => {
  let v = 0n;
  for (let i = 63; i >= 0; i--) v = (v << 8n) | BigInt(bytes[off + i]);
  return v;
};

/** Decode a 32-byte point encoding → extended point; rejects the
 * non-canonical y (y >= p) and the not-on-curve / no-sqrt cases. Bit 255 is
 * the sign of x — never part of y (RFC 8032 §5.1.2). */
const decodePt = (bytes) => {
  const sign = bytes[31] >> 7;
  const y = le256(bytes, 0) & ((1n << 255n) - 1n);
  if (y >= P) return null;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const t = modPow((u * modPow(v, 7n)) % P, (P - 5n) / 8n);
  let x = ((u * modPow(v, 3n)) % P * t) % P;
  const vxx = (v * x * x) % P;
  if (vxx === u) {
    // x is the square root already
  } else if (vxx === (P - u) % P) {
    x = (x * SQRT_M1) % P;
  } else {
    return null; // not on the curve
  }
  if (x === 0n && sign === 1) return null; // negative zero is not canonical
  if ((x & 1n) !== BigInt(sign)) x = (P - x) % P;
  return pt(x, y, 1n, (x * y) % P);
};

/** Encode an extended point (y little-endian + the sign bit of x). Residues
 * are normalized to [0, p) FIRST — a negative % P representative would be
 * byte-serialized as its two's-complement wrap, corrupting the encoding. */
const encodePt = (a) => {
  const zInv = modPow(a.Z, P - 2n);
  const x = ((a.X * zInv) % P + P) % P;
  const y = ((a.Y * zInv) % P + P) % P;
  const out = new Uint8Array(32);
  let v = y;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  out[31] |= Number(x & 1n) << 7;
  return out;
};

/** RFC 8032 §5.1.7 verify: [s]B == R + [k]A with k = SHA512(R || A || M) mod L
 * and the canonical scalar check s < L (malleability refused). */
export const ed25519Verify = (publicKeyB64, messageBytes, signatureB64) => {
  try {
    const pk = b64ToBytes(publicKeyB64);
    const sig = b64ToBytes(signatureB64);
    if (pk.length !== 32 || sig.length !== 64) return false;
    const a = decodePt(pk);
    const r = decodePt(sig.slice(0, 32));
    if (a === null || r === null) return false;
    const s = le256(sig, 32);
    if (s >= L) return false;
    const h = sha512Bytes([...sig.slice(0, 32), ...pk, ...messageBytes]);
    const k = le512(h, 0) % L;
    return equalPts(mulPt(BASE, s), addPts(r, mulPt(a, k)));
  } catch {
    return false; // malformed base64 / impossible encodings are a NO, not a throw
  }
};

/** The encoded base point — the resolver's self-check and the e2e's anchor. */
export const ed25519BaseEncoded = () => encodePt(BASE);
