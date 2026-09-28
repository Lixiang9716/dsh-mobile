// dsh:logging-exempt (host shim: no side effects to log)
/**
 * shims/node-zlib-xxh64.js — the XXH64 frame-checksum machinery of the
 * node:zlib shim, split out of node-zlib.js when that file crossed the
 * code-size budget. Pure functions: no imports from the core module.
 */

/** The 64-bit primes and the multiply/rotate primitives (module level for
 * size): BigInt arithmetic emulating the unsigned 64-bit XXH64 ops on
 * quickjs (no native 64-bit lanes). */
const P1 = 0x9E3779B185EBCA87n, P2 = 0xC2B2AE3D27D4EB4Fn, P3 = 0x165667B19E3779F9n;
const P4 = 0x85EBCA77C2B2AE63n, P5 = 0x27D4EB2F165667C5n;
const M64 = (1n << 64n) - 1n;
const rotl = (x, r) => ((x << r) | (x >> (64n - r))) & M64;
const mul = (a, b) => {
  const aL = a & 0xFFFFFFFFn, bL = b & 0xFFFFFFFFn;
  return (((aL * bL) & M64) + ((((a >> 32n) * bL) & M64) << 32n) + ((((aL * (b >> 32n)) & M64) << 32n))) & M64;
};
const round = (acc, input) => mul(rotl((acc + mul(input, P2)) & M64, 31n), P1);
const mergeRound = (acc, val) => (mul(acc ^ round(0n, val), P1) + P4) & M64;

/** The stripe loop: sixteen bytes per lane over every 32-byte stripe. */
const stripeRound = (state, read64, at) => {
  let [v1, v2, v3, v4] = state;
  v1 = round(v1, read64(at)); at += 8;
  v2 = round(v2, read64(at)); at += 8;
  v3 = round(v3, read64(at)); at += 8;
  v4 = round(v4, read64(at)); at += 8;
  state[0] = v1; state[1] = v2; state[2] = v3; state[3] = v4;
  return at;
};

export const XXH64 = (bytes) => {
  const len = bytes.length;
  let at = 0;
  let v1 = (P1 + P2) & M64, v2 = P2 & M64, v3 = 0n, v4 = (0n - P1) & M64;
  const read64 = (p) => {
    let x = 0n;
    for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(bytes[p + i]);
    return x;
  };
  const read32 = (p) => BigInt((bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0);
  let h;
  if (len >= 32) {
    const limit = len - 32;
    const state = [v1, v2, v3, v4];
    do {
      at = stripeRound(state, read64, at);
    } while (at <= limit);
    [v1, v2, v3, v4] = state;
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & M64;
    h = mergeRound(h, v1); h = mergeRound(h, v2); h = mergeRound(h, v3); h = mergeRound(h, v4);
  } else {
    h = P5 & M64;
  }
  h = (h + BigInt(len)) & M64;
  while (at + 8 <= len) {
    h = (mul(h ^ round(0n, read64(at)), P1) + P4) & M64;
    at += 8;
  }
  while (at + 4 <= len) {
    h = (h ^ mul(read32(at), P1)) & M64;
    h = (mul(rotl(h, 23n), P2) + P3) & M64;
    at += 4;
  }
  while (at < len) {
    h = (h ^ mul(BigInt(bytes[at]), P5)) & M64;
    h = mul(rotl(h, 11n), P1);
    at += 1;
  }
  h ^= h >> 33n; h = mul(h, P2); h ^= h >> 29n; h = mul(h, P3); h ^= h >> 32n;
  return h & M64;
};

/** The 4-byte frame checksum trailer for `content` under the flag bit. */
export const zstdChecksumTrailer = (content) => {
  const digest = XXH64(content) & 0xFFFFFFFFn;
  return Uint8Array.of(Number(digest & 0xFFn), Number((digest >> 8n) & 0xFFn), Number((digest >> 16n) & 0xFFn), Number((digest >> 24n) & 0xFFn));
};

/** Validate a frame-complete checksummed frame against its decoded plaintext
 * (the one-shot route strips the trailer before the intrinsic — which WOULD
 * natively enforce it — so the shim owns the comparison; W6-V upgraded the
 * trailer from the old zero placeholder to the real XXH64, and the vendored
 * corruption tests flip on exactly this). */
export const validateFrameChecksum = (frameBytes, plaintext) => {
  const expected = zstdChecksumTrailer(plaintext);
  const at = frameBytes.length - 4;
  for (let i = 0; i < 4; i++) {
    if (frameBytes[at + i] !== expected[i]) {
      throw new Error(`zstd: frame checksum mismatch (stored ${frameBytes[at + i].toString(16)}, computed ${expected[i].toString(16)} at trailer byte ${i})`);
    }
  }
};

/** Sync codec core (compress): one intrinsic shot, then — when the caller
 * requested ZSTD_c_checksumFlag — the checksum bit is SET in the descriptor
 * and a real XXH64 trailer is appended (RFC 8878 layout; W6-V replaced the
 * old zero placeholder, which made every flagged frame a silently-unchecked
 * checksum claim). */
