// dsh:logging-exempt (pure codec: nothing to log, no side effects)
/**
 * Minimal SHA-1 for the RFC 6455 WebSocket accept handshake
 * (CarrierServer.ets). Hand-rolled on purpose, documented per the mission
 * decision: the RFC 6455 accept is computed synchronously inside the HTTP
 * upgrade path, and a 40-line padding-and-rounds implementation avoids both
 * an async cryptoFramework detour in the hot path and any API-version
 * question about 'SHA1' MD availability. Verified against the RFC 6217/RFC
 * 3174 test vectors below before first use on-device:
 *   sha1("abc")                  = a9993e364706816aba3e25717850c26c9cd0d89d
 *   sha1("")                     = da39a3ee5e6b4b0d3255bfef95601890afd80709
 * (the on-device handshake itself is proven by the page's WS connecting at
 * all — a wrong accept key would be rejected by ArkWeb's WebSocket client).
 */

const K: number[] = [
  0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6,
];

/** One 512-bit block of the SHA-1 compression function. */
function sha1Block(h: number[], block: Uint8Array, offset: number): void {
  const w: number[] = new Array<number>(80).fill(0);
  for (let i = 0; i < 16; i++) {
    const at = offset + i * 4;
    w[i] = ((block[at] << 24) | (block[at + 1] << 16) |
      (block[at + 2] << 8) | block[at + 3]) >>> 0;
  }
  for (let i = 16; i < 80; i++) {
    const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
    w[i] = ((x << 1) | (x >>> 31)) >>> 0;
  }
  let a = h[0];
  let b = h[1];
  let c = h[2];
  let d = h[3];
  let e = h[4];
  for (let i = 0; i < 80; i++) {
    let f = 0;
    let k = 0;
    if (i < 20) {
      f = (b & c) | (~b & d);
      k = K[0];
    } else if (i < 40) {
      f = b ^ c ^ d;
      k = K[1];
    } else if (i < 60) {
      f = (b & c) | (b & d) | (c & d);
      k = K[2];
    } else {
      f = b ^ c ^ d;
      k = K[3];
    }
    const temp = ((((a << 5) | (a >>> 27)) >>> 0) + (f >>> 0) + e + k + w[i]) >>> 0;
    e = d;
    d = c;
    c = ((b << 30) | (b >>> 2)) >>> 0;
    b = a;
    a = temp;
  }
  h[0] = (h[0] + a) >>> 0;
  h[1] = (h[1] + b) >>> 0;
  h[2] = (h[2] + c) >>> 0;
  h[3] = (h[3] + d) >>> 0;
  h[4] = (h[4] + e) >>> 0;
}

/** SHA-1 digest as lowercase hex (RFC 3174). */
export function sha1Hex(data: Uint8Array): string {
  const h: number[] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const bitLen = data.length * 8;
  const padded = new Uint8Array((Math.floor((data.length + 8) / 64) + 1) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const dv = padded.length - 8;
  // 64-bit big-endian bit length; JS shifts wrap mod 32, so the high four
  // bytes must not be written through a shift — they are 0 for any input
  // under 512 MiB, which bounds every input this host digests.
  padded[dv + 4] = (bitLen >>> 24) & 0xff;
  padded[dv + 5] = (bitLen >>> 16) & 0xff;
  padded[dv + 6] = (bitLen >>> 8) & 0xff;
  padded[dv + 7] = bitLen & 0xff;
  for (let at = 0; at < padded.length; at += 64) {
    sha1Block(h, padded, at);
  }
  let out = '';
  for (let i = 0; i < 5; i++) {
    out += (h[i] >>> 24).toString(16).padStart(2, '0');
    out += ((h[i] >>> 16) & 0xff).toString(16).padStart(2, '0');
    out += ((h[i] >>> 8) & 0xff).toString(16).padStart(2, '0');
    out += (h[i] & 0xff).toString(16).padStart(2, '0');
  }
  return out;
}

/** Hex string to bytes (for the WS accept digest). */
export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}
