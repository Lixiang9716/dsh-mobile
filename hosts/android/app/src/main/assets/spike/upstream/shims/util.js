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
export const inspect = (value, options = {}) => {
  const depthLimit = typeof options?.depth === 'number' ? options.depth : 2;
  const maxArrayLength = typeof options?.maxArrayLength === 'number' ? options.maxArrayLength : 100;
  const maxStringLength = typeof options?.maxStringLength === 'number' ? options.maxStringLength : 10000;
  const seen = new Map(); // object → circular reference guard
  const render = (v, depth) => {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    const kind = typeof v;
    if (kind === 'string') return inspectQuote(v, maxStringLength);
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
      if (v instanceof Map) {
        if (depth >= depthLimit) return `Map(${v.size})`;
        const rows = [];
        let index = 0;
        for (const [k, val] of v) {
          if (index >= maxArrayLength) {
            const rest = v.size - maxArrayLength;
            rows.push(`... ${rest} more item${rest === 1 ? '' : 's'}`);
            break;
          }
          rows.push(`${render(k, depth + 1)} => ${render(val, depth + 1)}`);
          index += 1;
        }
        return v.size === 0 ? 'Map(0) {}' : `Map(${v.size}) { ${rows.join(', ')} }`;
      }
      if (v instanceof Set) {
        if (depth >= depthLimit) return `Set(${v.size})`;
        const rows = [];
        let index = 0;
        for (const val of v) {
          if (index >= maxArrayLength) {
            const rest = v.size - maxArrayLength;
            rows.push(`... ${rest} more item${rest === 1 ? '' : 's'}`);
            break;
          }
          rows.push(render(val, depth + 1));
          index += 1;
        }
        return v.size === 0 ? 'Set(0) {}' : `Set(${v.size}) { ${rows.join(', ')} }`;
      }
      if (Array.isArray(v)) {
        if (depth >= depthLimit) return '[Array]';
        const shown = v.slice(0, maxArrayLength).map((item) => render(item, depth + 1));
        if (v.length > maxArrayLength) {
          const rest = v.length - maxArrayLength;
          shown.push(`... ${rest} more item${rest === 1 ? '' : 's'}`);
        }
        return shown.length === 0 ? '[]' : `[ ${shown.join(', ')} ]`;
      }
      // Plain objects and class instances: `ClassName { k: v }` (the class
      // prefix is omitted for plain Object-inheriting objects).
      const keys = Object.keys(v);
      const ctor = v.constructor?.name;
      const prefix = typeof ctor === 'string' && ctor !== '' && ctor !== 'Object' ? `${ctor} ` : '';
      if (depth >= depthLimit && keys.length > 0) return `${prefix}[Object]`;
      const rows = keys.map((key) => {
        const label = INSPECT_IDENTIFIER.test(key) ? key : inspectQuote(key, maxStringLength);
        return `${label}: ${render(v[key], depth + 1)}`;
      });
      return rows.length === 0 ? `${prefix}{}` : `${prefix}{ ${rows.join(', ')} }`;
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

/** node's uv-errno table (Linux values, node's own doc set): number + the
 * message getSystemErrorMessage renders. One table serves BOTH util faces
 * (getSystemErrorName/getSystemErrorMessage — demanded at module scope by
 * the vendored bash-local/subprocess-local spawn result decoders) and the
 * node:os constants.errno map (os.js derives its numbers from here). */
export const UV_ERRNO = {
  E2BIG: [7, 'argument list too long'],
  EACCES: [13, 'permission denied'],
  EADDRINUSE: [48, 'address already in use'],
  EADDRNOTAVAIL: [49, 'cannot assign requested address'],
  EAFNOSUPPORT: [47, 'address family not supported by protocol family'],
  EAGAIN: [35, 'resource temporarily unavailable'],
  EALREADY: [37, 'operation already in progress'],
  EBADF: [9, 'bad file descriptor'],
  EBADMSG: [94, 'bad message'],
  EBUSY: [16, 'resource busy or locked'],
  ECANCELED: [89, 'operation canceled'],
  ECONNABORTED: [53, 'software caused connection abort'],
  ECONNREFUSED: [61, 'connection refused'],
  ECONNRESET: [54, 'connection reset by peer'],
  EDEADLK: [11, 'resource deadlock avoided'],
  EDESTADDRREQ: [39, 'destination address required'],
  EDOM: [33, 'numerical argument out of domain'],
  EDQUOT: [69, 'quota exceeded'],
  EEXIST: [17, 'file already exists'],
  EFAULT: [14, 'bad address in system call argument'],
  EFBIG: [27, 'file too large'],
  EHOSTUNREACH: [65, 'no route to host'],
  EIDRM: [90, 'identifier removed'],
  EILSEQ: [92, 'illegal byte sequence'],
  EINPROGRESS: [36, 'operation now in progress'],
  EINTR: [4, 'interrupted system call'],
  EINVAL: [22, 'invalid argument'],
  EIO: [5, 'i/o error'],
  EISCONN: [56, 'socket is already connected'],
  EISDIR: [21, 'is a directory'],
  ELOOP: [62, 'too many symbolic links encountered'],
  EMFILE: [24, 'too many open files'],
  EMLINK: [31, 'too many links'],
  EMSGSIZE: [40, 'message too long'],
  EMULTIHOP: [95, 'multihop attempted'],
  ENAMETOOLONG: [63, 'file name too long'],
  ENETDOWN: [50, 'network is down'],
  ENETUNREACH: [51, 'network is unreachable'],
  ENFILE: [23, 'file table overflow'],
  ENOBUFS: [55, 'no buffer space available'],
  ENODATA: [96, 'no data available'],
  ENODEV: [19, 'no such device'],
  ENOENT: [2, 'no such file or directory'],
  ENOEXEC: [8, 'exec format error'],
  ENOLCK: [77, 'no locks available'],
  ENOLINK: [97, 'link has been severed'],
  ENOMEM: [12, 'cannot allocate memory'],
  ENOMSG: [91, 'no message of the desired type'],
  ENOPROTOOPT: [42, 'protocol not available'],
  ENOSPC: [28, 'no space left on device'],
  ENOSR: [98, 'no stream resources'],
  ENOSTR: [99, 'not a stream'],
  ENOSYS: [78, 'function not implemented'],
  ENOTCONN: [57, 'socket is not connected'],
  ENOTDIR: [20, 'not a directory'],
  ENOTEMPTY: [66, 'directory not empty'],
  ENOTSOCK: [38, 'socket operation on non-socket'],
  ENOTSUP: [45, 'operation not supported'],
  ENOTTY: [25, 'inappropriate ioctl for device'],
  ENXIO: [6, 'no such device or address'],
  EOPNOTSUPP: [45, 'operation not supported on socket'],
  EOVERFLOW: [84, 'value too large for defined data type'],
  EPERM: [1, 'operation not permitted'],
  EPIPE: [32, 'broken pipe'],
  EPROTO: [100, 'protocol error'],
  EPROTONOSUPPORT: [43, 'protocol not supported'],
  EPROTOTYPE: [41, 'protocol wrong type for socket'],
  ERANGE: [34, 'numerical result out of range'],
  EROFS: [30, 'read-only file system'],
  ESPIPE: [29, 'invalid seek'],
  ESRCH: [3, 'no such process'],
  ESTALE: [70, 'stale file handle'],
  ETIME: [101, 'timer expired'],
  ETIMEDOUT: [60, 'connection timed out'],
  ETXTBSY: [26, 'text file is busy'],
  EWOULDBLOCK: [35, 'operation would block'],
  EXDEV: [18, 'cross-device link not permitted'],
};

const errnoByNumber = (errno) => {
  for (const [name, entry] of Object.entries(UV_ERRNO)) {
    if (entry[0] === errno) return name;
  }
  return undefined;
};

/** getSystemErrorName(errno) / getSystemErrorMessage(errno) — the libuv
 * error-code tables (undefined for an unknown number, node's contract). */
export const getSystemErrorName = (errno) => {
  if (!Number.isInteger(errno)) {
    throw new TypeError(`getSystemErrorName: integer required (got ${typeof errno})`);
  }
  return errnoByNumber(errno);
};
export const getSystemErrorMessage = (errno) => {
  if (!Number.isInteger(errno)) {
    throw new TypeError(`getSystemErrorMessage: integer required (got ${typeof errno})`);
  }
  return UV_ERRNO[errnoByNumber(errno) ?? '']?.[1];
};

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

/** parseArgs({ args, options, strict, allowPositionals, tokens }) — the
 * config subset the suite's CLI parsers drive: long options (--name=value /
 * --name value), short option clusters (-abc), negation (--no-name), and
 * positional collection. strict:false tolerates unknown options (they land
 * in `values` anyway); strict:true throws on undeclared ones like node. */
export const parseArgs = (config = {}) => {
  const args = config.args ?? (typeof globalThis.process?.argv !== 'undefined' ? globalThis.process.argv.slice(2) : []);
  const options = config.options ?? {};
  const strict = config.strict === true;
  const declared = (longName) => Object.prototype.hasOwnProperty.call(options, longName);
  const wantsValue = (longName, kind) => {
    const option = options[longName];
    const type = typeof option === 'string' ? option : option?.type;
    if (type === 'string') return true;
    if (type === 'boolean') return false;
    if (type === undefined) return kind === 'inline'; // undeclared: value only when --x=v
    throw new TypeError(`util.parseArgs: option '${longName}' has invalid type ${String(type)}`);
  };
  const values = {};
  const positionals = [];
  const tokens = config.tokens === true ? [] : undefined;
  let onlyPositionals = false; // after `--`, everything is positional
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (tokens !== undefined) tokens.push({ kind: 'positional', value: arg, index: i });
    if (onlyPositionals || arg === '-' || !arg.startsWith('-')) {
      if (config.allowPositionals !== true) {
        // node's 22+ contract: strict parse of a positional without
        // allowPositionals is `Unexpected argument '<arg>'` (the
        // llm-mock-server CLI tests match that text).
        throw new Error(`Unexpected argument '${arg}'`);
      }
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      onlyPositionals = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      const longName = eq === -1 ? body : body.slice(0, eq);
      const negated = longName.startsWith('no-');
      const bare = negated ? longName.slice(3) : longName;
      const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);
      if (strict && !declared(bare)) {
        // node's capital-U contract (llm-mock-server CLI tests match the exact text)
        throw new Error(`Unknown option '--${longName}'`);
      }
      if (inlineValue !== undefined) {
        values[bare] = inlineValue;
      } else if (wantsValue(bare)) {
        if (i + 1 >= args.length) {
          // node's missing-argument contract (strict mode)
          throw new Error(`Option '--${bare} <value>' argument missing`);
        }
        values[bare] = args[++i];
      } else {
        values[bare] = !negated;
      }
      if (tokens !== undefined) {
        tokens.push({ kind: 'option', name: longName, rawName: arg, index: i,
          value: values[bare], inlineValue });
      }
      continue;
    }
    // short cluster: -ab or -ovalue
    const cluster = arg.slice(1);
    for (let k = 0; k < cluster.length; k++) {
      const shortName = cluster[k];
      const longFor = Object.keys(options).find((name) => options[name]?.short === `-${shortName}`);
      const name = longFor ?? shortName;
      const rest = cluster.slice(k + 1);
      if (strict && !declared(name)) {
        throw new Error(`Unknown option '-${shortName}'`);
      }
      if (rest.length > 0 && wantsValue(name)) {
        values[name] = rest;
        if (tokens !== undefined) tokens.push({ kind: 'option', name, rawName: `-${shortName}${rest}`, index: i, value: rest });
        break;
      }
      if (wantsValue(name)) {
        if (i + 1 >= args.length) {
          // node reports the LONG spelling when the short maps to one
          throw new Error(`Option '--${declared(name) ? name : shortName} <value>' argument missing`);
        }
        values[name] = args[++i];
        if (tokens !== undefined) tokens.push({ kind: 'option', name, rawName: `-${shortName}`, index: i, value: values[name] });
        break;
      }
      values[name] = true;
      if (tokens !== undefined) tokens.push({ kind: 'option', name, rawName: `-${shortName}`, index: i });
    }
  }
  // Defaults: declared boolean options absent from args default false,
  // string options undefined (node's config-defaults contract).
  for (const [name, option] of Object.entries(options)) {
    const type = typeof option === 'string' ? option : option?.type;
    if (values[name] === undefined && type === 'boolean') values[name] = false;
    if (option?.default !== undefined && values[name] === undefined) values[name] = option.default;
  }
  const result = { values, positionals };
  if (tokens !== undefined) result.tokens = tokens;
  return result;
};

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
    // Any byte VIEW is accepted (ArrayBuffer/DataView/the vendored faces'
    // own Uint8Array-like views arrive here cross-instance — a strict
    // instanceof would misreject them; ArrayBuffer.isView is the gate).
    if (bytes instanceof ArrayBuffer) {
      bytes = new Uint8Array(bytes);
    } else if (bytes !== null && typeof bytes === 'object' && ArrayBuffer.isView(bytes)
        && !(bytes instanceof Uint8Array)) {
      bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
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
