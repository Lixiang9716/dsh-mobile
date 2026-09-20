// dsh:logging-exempt (shim layer)
/**
 * node:crypto shim — the one member the vendored closure imports.
 *
 * Covers (upstream usage → this module):
 *   - dsh-agent-loop, dsh-sdk-protocol (`randomUUID`) — message/attempt
 *     identity; built on the spike host's `crypto.getRandomValues` (the same
 *     platform RNG seam the M1 spike proved).
 *
 * Intentionally NOT supported: everything else (createHash, ciphers, HMAC —
 * digest belongs to the gateway/content-addressing layer, sha256.js in the
 * spike). An import of any other name is a loud ESM link error.
 */
const randomUUID = () => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export { randomUUID };
export const webcrypto = globalThis.crypto;
