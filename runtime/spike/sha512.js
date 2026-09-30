// dsh:logging-exempt (pure function module — a digest takes no policy decisions)
/**
 * Pure-JS SHA-512 (FIPS 180-4) for the marketplace's ed25519 verifier.
 *
 * WHY hand-rolled, same answer as sha256.js: the spike runtime exposes
 * exactly two crypto seams (crypto.getRandomValues + btoa — see
 * host/dsh_spike_host.c) and the frozen gateway has no digest primitive, so
 * the signature face (RFC 8032 ed25519 hashes R||A||M with SHA-512) has no
 * async digest to call. ed25519 is VERIFY-ONLY here and quickjs-ng carries
 * BigInt, so a BigInt-word implementation keeps the module dependency-free
 * (~120 lines) and pure: bytes in (Uint8Array), 64 bytes out. The message is
 * short (a catalog index), so per-call BigInt allocation is not a hot path.
 */

const MASK = (1n << 64n) - 1n;

/** The 80 round constants, the fractional parts of the cube roots of the
 * first 80 primes (FIPS 180-4 §4.2.3), as BigInt literals. */
const K = [
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

const rotr = (x, n) => ((x >> BigInt(n)) | (x << (64n - BigInt(n)))) & MASK;
const ch = (x, y, z) => (x & y) ^ (~x & z);
const maj = (x, y, z) => (x & y) ^ (x & z) ^ (y & z);
const bigSigma0 = (x) => rotr(x, 28) ^ rotr(x, 34) ^ rotr(x, 39);
const bigSigma1 = (x) => rotr(x, 14) ^ rotr(x, 18) ^ rotr(x, 41);
const smallSigma0 = (x) => rotr(x, 1) ^ rotr(x, 8) ^ (x >> 7n);
const smallSigma1 = (x) => rotr(x, 19) ^ rotr(x, 61) ^ (x >> 6n);

/** SHA-512 of `bytes` — 64 digest bytes out. */
export const sha512Bytes = (bytes) => {
  const bitLen = BigInt(bytes.length) * 8n;
  const padded = (((bytes.length + 17 + 127) >> 7) << 7);
  const buf = new Uint8Array(padded);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  // 128-bit big-endian bit length in the final 16 bytes (JS lengths are far
  // below 2^88, so the high word is always zero — write it anyway, honestly).
  const at = buf.length - 16;
  for (let i = 0; i < 8; i++) buf[at + i] = 0;
  for (let i = 0; i < 8; i++) buf[at + 8 + i] = Number((bitLen >> BigInt(56 - 8 * i)) & 0xffn);

  let h0 = 0x6a09e667f3bcc908n, h1 = 0xbb67ae8584caa73bn,
    h2 = 0x3c6ef372fe94f82bn, h3 = 0xa54ff53a5f1d36f1n,
    h4 = 0x510e527fade682d1n, h5 = 0x9b05688c2b3e6c1fn,
    h6 = 0x1f83d9abfb41bd6bn, h7 = 0x5be0cd19137e2179n;

  const w = new Array(80);
  for (let off = 0; off < padded; off += 128) {
    for (let i = 0; i < 16; i++) {
      let v = 0n;
      for (let j = 0; j < 8; j++) v = (v << 8n) | BigInt(buf[off + i * 8 + j]);
      w[i] = v;
    }
    for (let i = 16; i < 80; i++) {
      w[i] = (smallSigma1(w[i - 2]) + w[i - 7] + smallSigma0(w[i - 15]) + w[i - 16]) & MASK;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 80; i++) {
      const t1 = (h + bigSigma1(e) + ch(e, f, g) + K[i] + w[i]) & MASK;
      const t2 = (bigSigma0(a) + maj(a, b, c)) & MASK;
      h = g; g = f; f = e; e = (d + t1) & MASK;
      d = c; c = b; b = a; a = (t1 + t2) & MASK;
    }
    h0 = (h0 + a) & MASK; h1 = (h1 + b) & MASK; h2 = (h2 + c) & MASK; h3 = (h3 + d) & MASK;
    h4 = (h4 + e) & MASK; h5 = (h5 + f) & MASK; h6 = (h6 + g) & MASK; h7 = (h7 + h) & MASK;
  }
  const out = new Uint8Array(64);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((word, i) => {
    for (let j = 0; j < 8; j++) out[i * 8 + j] = Number((word >> BigInt(56 - 8 * j)) & 0xffn);
  });
  return out;
};
