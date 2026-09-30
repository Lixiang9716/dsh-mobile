// dsh:logging-exempt (pure function module — an encoding takes no policy decisions)
/**
 * utf8 — bytes ↔ JS string over the UTF-8 encoding (RFC 3629), the byte
 * form of the signed catalog's canonical JSON (data-protocols.md §7.1) and
 * of every catalog document the resolver parses (the index carries zh
 * summaries — non-ASCII by design).
 *
 * WHY hand-rolled: the spike runtime has no TextEncoder/TextDecoder (the
 * host injects only getRandomValues/btoa — dsh_spike_host.c), and the
 * `[...str].map(charCodeAt)` idiom used elsewhere is LATIN-1: it truncates
 * every code point above 0xFF, silently corrupting zh text. The catalog's
 * signature is defined over UTF-8 bytes, so an approximate encoder would
 * make every signed index containing zh text unverifiable — fail loud here
 * instead (rule 5) on malformed sequences.
 */

/** JS string → UTF-8 bytes (code points above the BMP ride surrogate pairs). */
export const utf8Encode = (text) => {
  const out = [];
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp <= 0x7f) out.push(cp);
    else if (cp <= 0x7ff) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp <= 0xffff) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  return Uint8Array.from(out);
};

/** UTF-8 bytes → JS string; a malformed sequence fails loud (never mojibake). */
export const utf8Decode = (bytes) => {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    let cp;
    if (b < 0x80) {
      cp = b;
      i += 1;
    } else if ((b & 0xe0) === 0xc0) {
      if (i + 1 >= bytes.length || (bytes[i + 1] & 0xc0) !== 0x80) throw new Error('utf8: malformed 2-byte sequence');
      cp = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
      i += 2;
    } else if ((b & 0xf0) === 0xe0) {
      if (i + 2 >= bytes.length || (bytes[i + 1] & 0xc0) !== 0x80 || (bytes[i + 2] & 0xc0) !== 0x80) {
        throw new Error('utf8: malformed 3-byte sequence');
      }
      cp = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
      i += 3;
    } else if ((b & 0xf8) === 0xf0) {
      if (i + 3 >= bytes.length || (bytes[i + 1] & 0xc0) !== 0x80
        || (bytes[i + 2] & 0xc0) !== 0x80 || (bytes[i + 3] & 0xc0) !== 0x80) {
        throw new Error('utf8: malformed 4-byte sequence');
      }
      cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      i += 4;
    } else {
      throw new Error(`utf8: invalid lead byte 0x${b.toString(16)}`);
    }
    out += String.fromCodePoint(cp);
  }
  return out;
};
