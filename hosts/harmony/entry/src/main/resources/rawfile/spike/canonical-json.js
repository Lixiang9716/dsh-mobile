// dsh:logging-exempt (pure function module — a codec takes no policy decisions)
/**
 * Pure wire codecs for the marketplace resolver (the sha256.js precedent):
 * canonical JSON serialization and UTF-8 encode/decode that do not lean on
 * TextEncoder/TextDecoder (absent in some embeds).
 *
 * canonicalJson is the byte form the catalog's ed25519 signature covers
 * ("canonical JSON of everything except signature"): recursively sorted
 * object keys, no whitespace. The node-side test vehicles keep a copy
 * (runtime/spike/ci/marketplace-canonical.mjs — node cannot resolve this
 * module's bare imports); drift between the two is DETECTED by the
 * signature check in the e2e leg, never assumed away.
 */

/** Canonical JSON: recursively sorted keys, no whitespace. */
export const canonicalJson = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
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
