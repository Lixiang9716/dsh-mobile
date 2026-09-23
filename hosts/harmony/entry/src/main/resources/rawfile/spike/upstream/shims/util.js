// dsh:logging-exempt (shim layer)
/**
 * node:util shim — formatting subset.
 *
 * Covers (upstream usage → this module):
 *   - cordis/cosmokit diagnostics paths (`format`, `inspect`, `promisify`) on
 *     error reporting routes only. `inspect` renders JSON-with-quotes, NOT
 *     node's depth/ color machinery — honest rendering for log lines.
 *
 * Intentionally NOT supported: inspect custom depth/colors/options object
 * (ignored silently is NOT ok — options are rejected), util.types re-export
 * (import node:util/types directly), callbackify/promisify.custom.
 */
const formatValue = (value) => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

export const format = (template, ...args) => {
  if (typeof template !== 'string') return args.map(formatValue).join(' ');
  let at = 0;
  let out = template.replace(/%[sdjifoO%]/g, (spec) => {
    if (spec === '%%') return '%';
    if (at >= args.length) return spec;
    const value = args[at++];
    switch (spec) {
      case '%s': return String(value);
      case '%d':
      case '%i': {
        const n = Number(value);
        return spec === '%i' ? String(Math.trunc(n)) : String(n);
      }
      case '%f': return String(Number(value));
      case '%j': return JSON.stringify(value) ?? 'undefined';
      case '%o':
      case '%O': return formatValue(value);
      default: return spec;
    }
  });
  if (at < args.length) {
    out += ` ${args.slice(at).map(formatValue).join(' ')}`;
  }
  return out;
};

export const inspect = (value) => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

export const isDeepStrictEqual = (a, b) => {
  // structural equality with prototype identity, per Node util semantics
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => isDeepStrictEqual(a[k], b[k]));
};

export const promisify = (fn) => {
  if (typeof fn !== 'function') throw new TypeError('promisify requires a function');
  return (...args) => new Promise((resolve, reject) => {
    fn(...args, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
};

export const deprecate = (fn, message) => (
  (...args) => {
    globalThis.console?.warn?.(`(node:util deprecate) ${message}`);
    return fn(...args);
  }
);

export const noop = () => {};
export const types = {}; // loud redirect: import node:util/types instead — property access on {} yields undefined

/**
 * TextDecoder (utf-8) — the face the vendored fs-local decodes file text
 * with: `new TextDecoder('utf-8', { fatal: true })` for whole reads (invalid
 * bytes must throw, not sanitize) and `{ stream: true }` chunked decodes that
 * may split a multi-byte sequence anywhere. Only utf-8 is supported (the
 * closure's only text encoding); `fatal` walks the bytes strictly and throws
 * TypeError on the first invalid sequence, and a stream-mode decode carries
 * the trailing incomplete sequence to the next call. Non-fatal decodes route
 * through the buffer shim's lossy decoder (U+FFFD substitution).
 */
export class TextDecoder {
  #fatal = false;
  #ignoreBOM = false;
  #pending = null; // trailing incomplete sequence bytes between stream decodes

  constructor(encoding = 'utf-8', options = {}) {
    const label = String(encoding).toLowerCase();
    if (label !== 'utf-8' && label !== 'utf8') {
      throw new RangeError(`node:util TextDecoder: encoding '${encoding}' is not supported — only utf-8 (the closure's only text encoding)`);
    }
    if (options !== undefined && typeof options !== 'object') {
      throw new TypeError('node:util TextDecoder: options must be an object');
    }
    this.#fatal = options?.fatal === true;
    this.#ignoreBOM = options?.ignoreBOM === true;
  }

  get encoding() { return 'utf-8'; }
  get fatal() { return this.#fatal; }
  get ignoreBOM() { return this.#ignoreBOM; }

  /** Sequence length started by a UTF-8 lead byte; 0 when the byte cannot
   * start a sequence (continuation byte or overlong-form lead). */
  static #sequenceLength(b0) {
    if (b0 <= 0x7f) return 1;
    if (b0 >= 0xc2 && b0 <= 0xdf) return 2;
    if (b0 >= 0xe0 && b0 <= 0xef) return 3;
    if (b0 >= 0xf0 && b0 <= 0xf4) return 4;
    return 0;
  }

  /** Decode `bytes[start, end)` STRICTLY; throws TypeError on any invalid
   * sequence (the `{fatal: true}` contract fs-local relies on to reject
   * binary data as `FS_NOT_TEXT`). */
  static #decodeStrict(bytes, start, end) {
    let out = '';
    let at = start;
    while (at < end) {
      const b0 = bytes[at];
      const length = TextDecoder.#sequenceLength(b0);
      if (length === 0 || at + length > end) {
        throw new TypeError('The encoded data is not valid.');
      }
      let code = b0 & (0xff >> length);
      let valid = true;
      for (let k = 1; k < length; k++) {
        const bk = bytes[at + k];
        if ((bk & 0xc0) !== 0x80) { valid = false; break; }
        code = (code << 6) | (bk & 0x3f);
      }
      if (!valid || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        throw new TypeError('The encoded data is not valid.');
      }
      if (code <= 0xffff) out += String.fromCharCode(code);
      else {
        code -= 0x10000;
        out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff));
      }
      at += length;
    }
    return out;
  }

  /** Bytes of the longest COMPLETE sequence suffix of `bytes` — the carry a
   * `{stream: true}` decode holds back. */
  static #completePrefix(bytes) {
    for (let at = Math.max(0, bytes.length - 3); at < bytes.length; at += 1) {
      const length = TextDecoder.#sequenceLength(bytes[at]);
      if (length === 0) continue;
      if (at + length > bytes.length) return at;
    }
    return bytes.length;
  }

  decode(bytes, options = {}) {
    if (bytes !== undefined && bytes !== null && !(bytes instanceof Uint8Array)) {
      throw new TypeError(`node:util TextDecoder: decode input must be a Uint8Array, got ${typeof bytes}`);
    }
    if (bytes === undefined || bytes === null) {
      this.#pending = null;
      return '';
    }
    let input = bytes;
    if (this.#pending !== null && this.#pending.length > 0) {
      input = new Uint8Array(this.#pending.length + bytes.length);
      input.set(this.#pending, 0);
      input.set(bytes, this.#pending.length);
      this.#pending = null;
    }
    let end = input.length;
    let prefix = '';
    if (options?.stream === true) {
      end = TextDecoder.#completePrefix(input);
      this.#pending = input.slice(end);
    } else {
      this.#pending = null;
    }
    let at = 0;
    // A leading BOM decodes to U+FEFF; unless ignoreBOM was asked for, node
    // strips exactly one at the very start of the stream.
    if (this.#ignoreBOM !== true && input.length >= 3
        && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
      at = 3;
      if (end < 3) return ''; // BOM split across stream chunks; nothing else yet
    }
    if (this.#fatal) {
      prefix = TextDecoder.#decodeStrict(input, at, end);
    } else {
      prefix = decodeUtf8(input.subarray(at, end));
    }
    return prefix;
  }
}
