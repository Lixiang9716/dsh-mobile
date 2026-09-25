// dsh:logging-exempt (shim layer)
/**
 * node:url shim + the minimal `URL` global face — the URL machinery the
 * web-boot closure (@deepseek-ai/dsh-client-modules) needs (W-INTEG leg).
 *
 * Covers (upstream usage → this module):
 *   - pathToFileURL / fileURLToPath — client-modules resolves staged package
 *     roots into `file:` URLs and walks back to package.json paths (the
 *     Loader-internal resolveSync contract on runtimes without Node
 *     internals).
 *   - `new URL(input, base)` + href/origin/pathname/search/hash — combo
 *     request routing (chunkRequest) and resolution-base joins. File-scope:
 *     absolute and root-relative HTTP(S) forms only; everything else fails
 *     loud naming the input (rule 5). Installed as globalThis.URL by
 *     web-shims.js.
 *
 * NOT supported: non-special schemes with opaque paths, URLSearchParams,
 * unicode host parsing, IPv6 literals — no mounted closure reaches them.
 */
import { encodeUtf8, decodeUtf8 } from 'upstream/shims/buffer.js';

const SPECIAL = {
  'http:': '80',
  'https:': '443',
  'ws:': '80',
  'wss:': '443',
  'ftp:': '21',
  'file:': null,
};

const percentDecode = (text) => {
  if (!text.includes('%')) return text;
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '%') {
      const hex = text.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        throw new Error(`node:url: malformed percent-encoding '${text.slice(i, i + 3)}'`);
      }
      bytes.push(parseInt(hex, 16));
      i += 2;
      continue;
    }
    bytes.push(...encodeUtf8(text[i]));
  }
  return decodeUtf8(bytes);
};

const pathEncode = (path) => path.replace(/[^A-Za-z0-9\-._~/!$&'()*+,;=:@]/g, (ch) => {
  const bytes = encodeUtf8(ch);
  return [...bytes].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
});

/** Split `scheme://authority/path?query#hash`; path may be empty for file:/ */
const parseAbsolute = (input) => {
  const schemeAt = input.indexOf(':');
  if (schemeAt <= 0) return undefined;
  const scheme = input.slice(0, schemeAt).toLowerCase();
  if (SPECIAL[`${scheme}:`] === undefined) return undefined;
  let rest = input.slice(schemeAt + 1);
  if (scheme === 'file') {
    // WHATWG file parser: file://host/path, file:///path, file:/path and
    // file:path all normalize onto file:///path (empty authority; node maps
    // the localhost host onto the empty one).
    const slashes = rest.match(/^\/+/)?.[0] ?? '';
    rest = slashes.length >= 2 ? rest.slice(2) : `/${rest.slice(slashes.length)}`;
  } else {
    if (!rest.startsWith('//')) return undefined;
    rest = rest.slice(2);
  }
  const hashAt = rest.indexOf('#');
  let fragment = '';
  if (hashAt >= 0) {
    fragment = rest.slice(hashAt);
    rest = rest.slice(0, hashAt);
  }
  const queryAt = rest.indexOf('?');
  let search = '';
  if (queryAt >= 0) {
    search = rest.slice(queryAt);
    rest = rest.slice(0, queryAt);
  }
  const slashAt = rest.indexOf('/');
  let authority = '';
  let pathname = '';
  if (slashAt >= 0) {
    authority = rest.slice(0, slashAt);
    pathname = rest.slice(slashAt);
  } else {
    authority = rest;
    pathname = '/';
  }
  if (pathname === '') pathname = '/';
  let authorityFinal = authority;
  if (scheme === 'file' && authorityFinal === 'localhost') authorityFinal = '';
  return { scheme, authority: authorityFinal, pathname, search, fragment };
};

/** POSIX dirname+pjoin with '.'/'..' resolution (lexical; no fs access). */
const resolvePath = (path) => {
  const out = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('/');
};

/** Resolve a scheme-less input (spike path space) against an optional base —
 * see the constructor: import.meta.url is a bundle-relative staged path, and
 * vendored packages join their own resources against it. */
const parsePathUrl = (asString, base) => {
  if (base !== undefined) {
    const baseParsed = new DshURL(base);
    const dir = baseParsed.pathname.slice(0, baseParsed.pathname.lastIndexOf('/') + 1);
    return { ...baseParsed, pathname: resolvePath(dir + asString), search: '', fragment: '' };
  }
  return {
    scheme: '', authority: '', pathname: resolvePath(`/${asString}`),
    search: '', fragment: '',
  };
};

export class DshURL {
  constructor(input, base = undefined) {
    let parsed;
    const asString = String(input);
    const hasScheme = /^[A-Za-z][A-Za-z0-9+.\-]*:/.test(asString);
    // A scheme-less input is a spike PATH-URL (the loader pins import.meta.url
    // to the staged bundle-relative path — plain POSIX, no scheme); lexical
    // joins keep new URL('../presets/', import.meta.url) in the same space,
    // and fileURLToPath passes path URLs through unchanged.
    if (!hasScheme) {
      parsed = parsePathUrl(asString, base);
    } else if (hasScheme) {
      parsed = parseAbsolute(asString);
    } else if (base !== undefined) {
      const baseParsed = new DshURL(base);
      if (asString.startsWith('/')) {
        parsed = { ...baseParsed, pathname: asString, search: '', fragment: '' };
      } else if (asString === '') {
        parsed = { ...baseParsed };
      } else if (baseParsed.scheme === '' || asString.startsWith('.')) {
        // Lexical join in PATH space (scheme-less spike URLs): '.'/'..' kept
        // verbatim would corrupt the walk; resolve them the way realpath does.
        const dir = baseParsed.pathname.slice(0, baseParsed.pathname.lastIndexOf('/') + 1);
        parsed = { ...baseParsed, pathname: resolvePath(dir + asString), search: '', fragment: '' };
      } else {
        const dir = baseParsed.pathname.slice(0, baseParsed.pathname.lastIndexOf('/') + 1);
        parsed = { ...baseParsed, pathname: dir + asString, search: '', fragment: '' };
      }
    } else {
      throw new Error(`node:url: relative URL '${asString}' needs a base`);
    }
    if (parsed === undefined) {
      throw new Error(`node:url: unsupported URL '${asString}' (special schemes only)`);
    }
    this.scheme = parsed.scheme;
    this.authority = parsed.authority;
    this.pathname = parsed.pathname;
    this.search = parsed.search;
    this.fragment = parsed.fragment;
    const hashAt = this.pathname.indexOf('#');
    if (hashAt >= 0) {
      this.fragment = this.pathname.slice(hashAt);
      this.pathname = this.pathname.slice(0, hashAt);
    }
    const queryAt = this.pathname.indexOf('?');
    if (queryAt >= 0) {
      this.search = this.pathname.slice(queryAt);
      this.pathname = this.pathname.slice(0, queryAt);
    }
  }

  get protocol() { return `${this.scheme}:`; }
  get host() { return this.authority; }
  get hostname() { return this.authority.split(':')[0] ?? this.authority; }
  get port() {
    const at = this.authority.lastIndexOf(':');
    return at > 0 ? this.authority.slice(at + 1) : '';
  }
  get origin() {
    if (this.scheme === 'file') return 'null';
    return `${this.scheme}://${this.authority}`;
  }
  get hash() { return this.fragment; }
  get href() {
    if (this.scheme === 'file') {
      return `file://${pathEncode(this.pathname)}${this.search}${this.fragment}`;
    }
    // Path URLs (empty scheme) serialize as plain paths — a '://' with an
    // empty scheme would be unparseable noise round-tripping through href.
    const head = this.scheme === '' ? '' : `${this.scheme}://${this.authority}`;
    return `${head}${pathEncode(this.pathname)}${this.search}${this.fragment}`;
  }
  toString() { return this.href; }
  toJSON() { return this.href; }
}

/** POSIX `pathToFileURL`: absolute path → file: URL (percent-encoded). */
export const pathToFileURL = (path) => {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new Error(`node:url: pathToFileURL needs an absolute POSIX path, got ${JSON.stringify(path)}`);
  }
  const url = new DshURL('file:///');
  url.pathname = path;
  return {
    href: `file://${pathEncode(path)}`,
    protocol: 'file:',
    pathname: pathEncode(path),
    toString() { return this.href; },
  };
};

/** POSIX `fileURLToPath`: file: URL (string or URL-like) → absolute path. */
export const fileURLToPath = (input) => {
  const href = typeof input === 'string' ? input : String(input?.href ?? input);
  // A scheme-less absolute path is already the spike's path space — identity.
  if (!href.startsWith('file:')) {
    // ':///path' is a path URL a caller stringified through a file:-expecting
    // API — the empty-scheme serialization. Strip the marker, keep the path.
    if (href.startsWith(':///')) return href.slice(3);
    if (href.startsWith('/')) return href;
    // A scheme-less RELATIVE path is the loader's import.meta.url spelling for
    // bundle-root-relative modules (the transpiled upstream specs): resolve it
    // against the bundle root the same lexical walk absolute path-URLs get.
    if (!/^[A-Za-z][A-Za-z0-9+.\-]*:/.test(href)) {
      return resolvePath(`/${href}`);
    }
    throw new Error(`node:url: fileURLToPath needs a file: URL, got ${JSON.stringify(href)}`);
  }
  const parsed = parseAbsolute(href);
  if (parsed === undefined || parsed.scheme !== 'file') {
    throw new Error(`node:url: fileURLToPath cannot parse ${JSON.stringify(href)}`);
  }
  const host = parsed.authority;
  if (host !== '' && host !== 'localhost') {
    throw new Error(`node:url: fileURLToPath refuses non-local file host '${host}'`);
  }
  const path = percentDecode(parsed.pathname);
  if (!path.startsWith('/')) {
    throw new Error(`node:url: fileURLToPath resolved a non-absolute path: ${JSON.stringify(path)}`);
  }
  return path;
};

export default { pathToFileURL, fileURLToPath, URL: DshURL };
