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
import { decodeUtf8 } from 'upstream/shims/buffer.js';
// The errno table and parseArgs live in their own modules (the file crossed
// the size budget); re-exported here so every existing import keeps its
// specifier (os.js's UV_ERRNO import included).
import { UV_ERRNO, getSystemErrorName, getSystemErrorMessage } from 'upstream/shims/util-errors.js';
import { parseArgs } from 'upstream/shims/util-parse-args.js';
export { UV_ERRNO, getSystemErrorName, getSystemErrorMessage, parseArgs };
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

/** Node's util.inspect face — the subset the closure renders console/log
 * lines with. Upgraded 2026-09-27 from pretty-JSON: the ptc-runtime console
 * shim's contract is "util.inspect-style" (`plain { a: 1 }` — single line,
 * unquoted identifier keys, single-quoted strings), measured against Node 24
 * through the ptc bootstrap spec. Options honored: depth (default 2),
 * maxArrayLength (default 100), maxStringLength (default 10000); others are
 * accepted and ignored (the old silent-reject broke the closure's bounded
 * options object). */
const INSPECT_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const inspectQuote = (text, maxStringLength) => {
  let body = text;
  if (maxStringLength < body.length) {
    body = `${body.slice(0, maxStringLength)}... ${body.length - maxStringLength} more characters`;
  }
  return `'${body.replace(/[\\']/g, '\\$&').replace(/\n/g, '\\n')}'`;
};
/** The inspect render branches for the collection shapes (module level for
 * size): each takes the shared context (depth limit, array/string caps) and
 * the recursive render. Output is node's inspect shape verbatim, including
 * the "... N more item(s)" truncation rows. */
const renderInspectMap = (v, depth, render, ctx) => {
  if (depth >= ctx.depthLimit) return `Map(${v.size})`;
  const rows = [];
  let index = 0;
  for (const [k, val] of v) {
    if (index >= ctx.maxArrayLength) {
      const rest = v.size - ctx.maxArrayLength;
      rows.push(`... ${rest} more item${rest === 1 ? '' : 's'}`);
      break;
    }
    rows.push(`${render(k, depth + 1)} => ${render(val, depth + 1)}`);
    index += 1;
  }
  return v.size === 0 ? 'Map(0) {}' : `Map(${v.size}) { ${rows.join(', ')} }`;
};

const renderInspectSet = (v, depth, render, ctx) => {
  if (depth >= ctx.depthLimit) return `Set(${v.size})`;
  const rows = [];
  let index = 0;
  for (const val of v) {
    if (index >= ctx.maxArrayLength) {
      const rest = v.size - ctx.maxArrayLength;
      rows.push(`... ${rest} more item${rest === 1 ? '' : 's'}`);
      break;
    }
    rows.push(render(val, depth + 1));
    index += 1;
  }
  return v.size === 0 ? 'Set(0) {}' : `Set(${v.size}) { ${rows.join(', ')} }`;
};

/** Plain objects and class instances: `ClassName { k: v }` (the class
 * prefix is omitted for plain Object-inheriting objects). */
const renderInspectObject = (v, depth, render, ctx) => {
  const keys = Object.keys(v);
  const ctor = v.constructor?.name;
  const prefix = typeof ctor === 'string' && ctor !== '' && ctor !== 'Object' ? `${ctor} ` : '';
  if (depth >= ctx.depthLimit && keys.length > 0) return `${prefix}[Object]`;
  const rows = keys.map((key) => {
    const label = INSPECT_IDENTIFIER.test(key) ? key : inspectQuote(key, ctx.maxStringLength);
    return `${label}: ${render(v[key], depth + 1)}`;
  });
  return rows.length === 0 ? `${prefix}{}` : `${prefix}{ ${rows.join(', ')} }`;
};

export const inspect = (value, options = {}) => {
  const ctx = {
    depthLimit: typeof options?.depth === 'number' ? options.depth : 2,
    maxArrayLength: typeof options?.maxArrayLength === 'number' ? options.maxArrayLength : 100,
    maxStringLength: typeof options?.maxStringLength === 'number' ? options.maxStringLength : 10000,
  };
  const seen = new Map(); // object → circular reference guard
  const render = (v, depth) => {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    const kind = typeof v;
    if (kind === 'string') return inspectQuote(v, ctx.maxStringLength);
    if (kind === 'number' || kind === 'boolean') return String(v);
    if (kind === 'bigint') return `${v}n`;
    if (kind === 'symbol') return v.toString();
    if (kind === 'function') return v.name ? `[Function: ${v.name}]` : '[Function (anonymous)]';
    if (seen.has(v)) return '[Circular]';
    seen.set(v, true);
    try {
      if (v instanceof Error) {
        // the stack string (with the V8 header our globals shim adds)
        const stack = v.stack;
        return typeof stack === 'string' ? stack : String(v);
      }
      if (v instanceof Date) return v.toISOString();
      if (v instanceof Map) return renderInspectMap(v, depth, render, ctx);
      if (v instanceof Set) return renderInspectSet(v, depth, render, ctx);
      if (Array.isArray(v)) {
        if (depth >= ctx.depthLimit) return '[Array]';
        const shown = v.slice(0, ctx.maxArrayLength).map((item) => render(item, depth + 1));
        if (v.length > ctx.maxArrayLength) {
          const rest = v.length - ctx.maxArrayLength;
          shown.push(`... ${rest} more item${rest === 1 ? '' : 's'}`);
        }
        return shown.length === 0 ? '[]' : `[ ${shown.join(', ')} ]`;
      }
      return renderInspectObject(v, depth, render, ctx);
    } finally {
      seen.delete(v);
    }
  };
  try {
    return render(value, 0);
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

/** stripVTControlCharacters(str) — removes ANSI escape sequences (CSI/OSC
 * and the single-char set) so width/progress renderers measure plain text.
 * The regex mirrors node's util.stripVTControlCharacters pattern. */
export const stripVTControlCharacters = (str) => {
  if (typeof str !== 'string') {
    throw new TypeError(`util.stripVTControlCharacters: string required (got ${typeof str})`);
  }
  // eslint-disable-next-line no-control-regex
  return str.replace(/(?:\u001B\[|\u001B\])[0-9;?]*[ -/]*[@-~]|\u001B[@-_]/g, '');
};

/** parseEnv(content) — the .env grammar (Node 20+): KEY=VALUE lines, `export
 * ` prefixes stripped, single/double quotes (with \n and \r escapes in
 * doubles) and backslash continuations in unquoted values, blank/# comments
 * ignored, later lines overwrite earlier ones. */
export const parseEnv = (content) => {
  if (typeof content !== 'string' && !(content instanceof Uint8Array)) {
    throw new TypeError(`util.parseEnv: string or Uint8Array required (got ${typeof content})`);
  }
  const text = typeof content === 'string' ? content : decodeUtf8(content);
  const out = {};
  // Line split keeps \r handling explicit: a CRLF file must not leave \r on
  // the last value character.
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') || line.startsWith('export\t')
      ? line.slice(7).trim()
      : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      // double quotes: node decodes \n \r \v \f \b and the escaped specials
      value = value.slice(1, -1).replace(/\\(.)/g, (m, c) => ({
        n: '\n', r: '\r', v: '\v', f: '\f', b: '\b',
      })[c] ?? c);
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1); // single quotes are literal
    } else {
      // unquoted: a trailing \ continues the value across the line break —
      // here that collapses to a space-joined value (node joins with \n and
      // strips the continuation; the corpus's envs are single-line)
      value = value.replace(/\\$/, '');
    }
    out[key] = value;
  }
  return out;
};

/**
 * TextDecoder (utf-8 + windows-1252) — the face the vendored fs-local decodes
 * file text with: `new TextDecoder('utf-8', { fatal: true })` for whole reads
 * (invalid bytes must throw, not sanitize) and `{ stream: true }` chunked
 * decodes that may split a multi-byte sequence anywhere. The single-byte
 * windows-1252 face serves the web-fetch-http charset negotiation (W5-S):
 * WHATWG maps the iso-8859-1/latin1/ascii label family onto the windows-1252
 * decoder, whose `.encoding` REPORTS 'windows-1252' (the upstream charset
 * test's exact expectation). Non-fatal utf-8 decodes route through the
 * buffer shim's lossy decoder (U+FFFD substitution).
 */

/** The WHATWG windows-1252 label set (the encoding-standard label table,
 * lowercased): the iso-8859-1 family and the ascii family both map here. */
const WINDOWS_1252_LABELS = new Set([
  'windows-1252', 'cp1252', 'cp-1252', 'x-cp1252',
  'iso-8859-1', 'iso8859-1', 'iso88591', 'iso_8859-1', 'iso88591987',
  'iso-ir-100', 'csisolatin1', 'l1', 'latin1', 'latin-1', 'ibm819',
  'cp819', 'us-ascii', 'ascii', 'ansi_x3.4-1968', 'iso-ir-6', '646',
]);

/** C1 controls (0x80–0x9F) through the cp1252 printable remap; the five
 * unassigned slots decode U+FFFD (WHATWG index "error" rows — this face
 * never fatals, so the replacement renders). */
const WINDOWS_1252_C1 = [
  0x20ac, 0xfffd, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021,
  0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0xfffd, 0x017d, 0xfffd,
  0xfffd, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0xfffd, 0x017e, 0x0178,
];

/** Any byte VIEW is accepted (ArrayBuffer/DataView/the vendored faces'
 * own Uint8Array-like views arrive here cross-instance — a strict
 * instanceof would misreject them; ArrayBuffer.isView is the gate). */
const toBytesView = (bytes) => {
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (bytes !== null && typeof bytes === 'object' && ArrayBuffer.isView(bytes)
      && !(bytes instanceof Uint8Array)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  return bytes;
};

/** The single-byte face: ASCII passthrough, C1 remap through the cp1252
 * index, 0xA0+ identity. */
const decodeCp1252 = (bytes) => {
  let out = '';
  for (let at = 0; at < bytes.length; at += 1) {
    const b = bytes[at];
    out += String.fromCodePoint(b < 0x80 ? b : b < 0xa0 ? WINDOWS_1252_C1[b - 0x80] : b);
  }
  return out;
};

export class TextDecoder {
  #fatal = false;
  #ignoreBOM = false;
  #pending = null; // trailing incomplete sequence bytes between stream decodes
  #cp1252 = false; // single-byte face: no sequences, no stream carry

  constructor(encoding = 'utf-8', options = {}) {
    const label = String(encoding).toLowerCase();
    const isUtf8 = label === 'utf-8' || label === 'utf8' || label === 'unicode-1-1-utf-8';
    const isCp1252 = WINDOWS_1252_LABELS.has(label);
    if (!isUtf8 && !isCp1252) {
      throw new RangeError(`node:util TextDecoder: encoding '${encoding}' is not supported — supported: utf-8, windows-1252 (the closure's text encodings)`);
    }
    if (options !== undefined && typeof options !== 'object') {
      throw new TypeError('node:util TextDecoder: options must be an object');
    }
    this.#fatal = options?.fatal === true;
    this.#ignoreBOM = options?.ignoreBOM === true;
    this.#cp1252 = isCp1252;
  }

  get encoding() { return this.#cp1252 ? 'windows-1252' : 'utf-8'; }
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
    bytes = toBytesView(bytes);
    if (bytes === undefined || bytes === null) {
      this.#pending = null;
      return '';
    }
    // Single-byte face: every byte maps through the cp1252 index directly;
    // no sequences, so stream mode carries nothing.
    if (this.#cp1252) {
      this.#pending = null;
      return decodeCp1252(bytes);
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
