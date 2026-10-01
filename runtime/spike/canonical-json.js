// dsh:logging-exempt (pure function module — a codec takes no policy decisions)
/**
 * Pure wire codecs for the marketplace signature plane (the sha256.js precedent):
 * canonical JSON serialization and UTF-8 encode/decode that do not lean on
 * TextEncoder/TextDecoder (absent in some embeds).
 *
 * canonicalJson is THE canonical form the catalog's ed25519 signature covers
 * (data-protocols.md §7.1: recursively sorted object keys, arrays in order, no
 * whitespace) — one canonical form, one module. Every signer and verifier in
 * the repo consumes THIS file and no other copy:
 *   - runtime embeds import it bare (`canonical-json.js`, host-loader resolved):
 *     marketplace-resolver.js, marketplace.js;
 *   - node-side signers/verifiers import it by relative path: the publisher
 *     tool (tools/gen-marketplace-index.mjs, re-exported to
 *     tools/marketplace-rotate-key.mjs), the hosting kit
 *     (deploy/marketplace/generate-index.mjs), the e2e vehicles
 *     (ci/mock-market-server.mjs, ci/market-test-indexes.mjs), and the panel
 *     suite (test/panel via vitest alias).
 * Drift between node:crypto-signed and pure-JS-verified bytes is therefore a
 * code defect, not a copy drift — and the cross legs stay as the detector:
 * test/panel (node:crypto signs, the resolver verifies) plus the marketplace
 * e2e legs would go red at the signature check if this form ever moved.
 *
 * A document that is not representable in JSON fails loud — `undefined`
 * in ANY position (member value or array element), function and symbol
 * values (JSON.stringify yields no bytes for them), and non-finite numbers
 * (JSON.stringify would silently rewrite them to `null`); BigInt already
 * throws from JSON.stringify itself. Any of these would otherwise silently
 * corrupt the signed bytes — the worst failure mode a signer can have, and
 * one a signature cross-check cannot detect (signer and verifier agree on
 * the corrupted bytes). Rule 5.
 */

/** Canonical JSON: recursively sorted keys, no whitespace; any value JSON
 * cannot represent is a loud error, not silent corruption. */
export const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    for (const k of keys) if (value[k] === undefined) throw new Error(`canonical JSON: key ${k} is undefined`);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`canonical JSON: ${value} is not representable in JSON`);
  }
  const scalar = JSON.stringify(value);
  if (scalar === undefined) throw new Error(`canonical JSON: a ${typeof value} is not representable in JSON`);
  return scalar;
};

/** UTF-8 text → bytes (surrogate pairs consumed; same output the Web
 * TextEncoder would produce). */
export const utf8Bytes = (text) => {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    let cp = text.codePointAt(i);
    if (cp >= 0x10000) i += 1;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return Uint8Array.from(bytes);
};

/** UTF-8 bytes → text. Malformed sequences decode to U+FFFD — callers
 * downstream (JSON.parse) reject the document. */
export const utf8Text = (bytes) => {
  let text = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    let cp;
    let take;
    if (b0 < 0x80) { cp = b0; take = 0; }
    else if (b0 >= 0xc2 && b0 < 0xe0) { cp = b0 & 0x1f; take = 1; }
    else if (b0 >= 0xe0 && b0 < 0xf0) { cp = b0 & 0x0f; take = 2; }
    else if (b0 >= 0xf0 && b0 < 0xf5) { cp = b0 & 0x07; take = 3; }
    else { cp = 0xfffd; take = 0; }
    for (let k = 1; k <= take && i + k < bytes.length; k++) {
      cp = (cp << 6) | (bytes[i + k] & 0x3f);
    }
    text += String.fromCodePoint(cp);
    i += take + 1;
  }
  return text;
};
