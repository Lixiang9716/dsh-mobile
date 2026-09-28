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
// The file: URL faces live in url-file.js (the file crossed the size
// budget); re-exported here so every existing import keeps its specifier.
import { pathToFileURL, fileURLToPath } from 'upstream/shims/url-file.js';
export { pathToFileURL, fileURLToPath };

const SPECIAL = {
  'http:': '80',
  'https:': '443',
  'ws:': '80',
  'wss:': '443',
  'ftp:': '21',
  'file:': null,
};

export const percentDecode = (text) => {
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

const pathEncode = (path) => path.replace(/%[0-9a-fA-F]{2}|[^A-Za-z0-9\-._~/!$&'()*+,;=:@]/g, (ch) => {
  // An existing %XX escape is kept verbatim (node hrefs preserve the URL's
  // own encoding; re-encoding '%' corrupted %2F paths into %252F).
  if (ch.startsWith('%')) return ch;
  const bytes = encodeUtf8(ch);
  return [...bytes].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
});

/** Authority validation for a parsed special-scheme URL (module level for
 * size; both checks throw TypeError 'Invalid URL' like node).
 *
 * Port validation (R3-G1, 2026-09-28): node throws when the authority
 * carries a port that is not all-digits (or above 65535) — the browser-use
 * endpoint validator distinguishes `http://localhost:bad/path` through
 * exactly that throw. Accepted ports keep the authority verbatim (the port
 * face reads it back). The scan runs after the last '@' so a userinfo colon
 * never counts, and skips bracketed IPv6 hosts.
 *
 * Host bracket validation (node throws TypeError on hosts like '[' — the
 * only legal bracket pair is a full IPv6 literal): an unterminated or
 * otherwise-brackety host must FAIL construction, not become a URL whose
 * authority silently round-trips into paths (lsp renderUri keeps-malformed
 * test: 'file://[' stayed verbatim only if URL construction rejects it).
 * A trailing numeric port belongs to the authority, not the literal
 * (W3-K 2026-09-28: `http://[::1]:3000/a` threw here because the regex
 * anchored before the port — the http-proxy policy's IPv6 bypass rows all
 * build bracketed-with-port URLs). */
const validateAuthority = (authorityFinal) => {
  const hostPart = authorityFinal.slice(authorityFinal.lastIndexOf('@') + 1);
  const portAt = hostPart.lastIndexOf(':');
  if (portAt >= 0 && !hostPart.endsWith(']')) {
    const port = hostPart.slice(portAt + 1);
    if (port !== '' && (!/^\d+$/.test(port) || Number(port) > 65535)) {
      throw new TypeError('Invalid URL');
    }
  }
  if (/[[\]]/.test(hostPart) && !/^\[[0-9a-fA-F:.]+\](?::\d*)?$/.test(hostPart)) {
    throw new TypeError('Invalid URL');
  }
};

/** Split `scheme://authority/path?query#hash`; path may be empty for file:/
 * (exported for the file: URL faces in url-file.js). */
export const parseAbsolute = (input) => {
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
  validateAuthority(authorityFinal);
  return { scheme, authority: authorityFinal, pathname, search, fragment };
};

/** Non-special scheme (socks5:, mailto:, urn: …) — the WHATWG opaque-path
 * parser: after `scheme:` an optional `//authority`, then the path taken
 * verbatim (no dot-segment normalization, no special-scheme table). The
 * http-proxy policy reader discriminates SOCKS proxies through
 * `URL.parse("socks5://…")` — under a special-schemes-only parser those
 * read as "invalid URL" and the diagnostic mislabels them. */
const parseOpaque = (input) => {
  const schemeAt = input.indexOf(':');
  const scheme = input.slice(0, schemeAt).toLowerCase();
  let rest = input.slice(schemeAt + 1);
  let authority = '';
  if (rest.startsWith('//')) {
    rest = rest.slice(2);
    const slashAt = rest.indexOf('/');
    if (slashAt >= 0) {
      authority = rest.slice(0, slashAt);
      rest = rest.slice(slashAt);
    } else {
      authority = rest;
      rest = '';
    }
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
  return { scheme, authority, pathname: rest, search, fragment };
};

/** POSIX dirname+pjoin with '.'/'..' resolution (lexical; no fs access;
 * exported for the file: URL faces in url-file.js). */
export const resolvePath = (path) => {
  const out = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('/');
};

/** WHATWG directory-ness: an input whose FINAL segment is empty, '.', or '..'
 * resolves to a DIRECTORY — the result carries a trailing slash. The slash is
 * load-bearing: a later relative resolution against this result as the base
 * drops the final segment only when it is marked a directory (measured
 * 2026-09-27: the agent-presets mount health check joins a row's
 * `../../plugins/x.js` against `new URL('.', fileURLToPath-of-composition)`;
 * without the trailing slash the walk climbed one level too far and the row
 * read as unresolvable). */
const endsAtDirectory = (relative) => relative === '' || relative === '.'
  || relative === '..' || relative.endsWith('/') || relative.endsWith('/.')
  || relative.endsWith('/..');

/** The lexical join the two relative-resolution branches share: the base's
 * directory prefix + the relative spelling, dot-segments resolved, and the
 * trailing-slash rule applied. */
const joinRelative = (basePathname, relative) => {
  const dir = basePathname.slice(0, basePathname.lastIndexOf('/') + 1);
  const resolved = resolvePath(dir + relative);
  return endsAtDirectory(relative) && resolved !== '/' && !resolved.endsWith('/')
    ? `${resolved}/`
    : resolved;
};

/** Resolve a scheme-less input (spike path space) against an optional base —
 * see the constructor: import.meta.url is a bundle-relative staged path, and
 * vendored packages join their own resources against it. */
const parsePathUrl = (asString, base) => {
  // node (WHATWG) rejects a scheme-less RELATIVE reference with no base —
  // 'not a url' throws Invalid URL there, and the vendored tool-web
  // sourceLabel relies on that throw for its raw-string fallback (W4-N,
  // 2026-09-28). Node can throw for EVERY relative no-base input because its
  // import.meta.url is absolute file:; the spike's module space is
  // POSIX-relative by design (the loader pins import.meta.url to a
  // bundle-relative path, and new URL(import.meta.url) must parse — the
  // ptc-runtime launch spec leans on it), so the guard fires only on inputs
  // that cannot be a path at all: whitespace-bearing ones. Base resolution
  // goes through constructBase/parsePathUrlLenient and never guards.
  if (base === undefined && !asString.startsWith('/') && /\s/.test(asString)) {
    throw new TypeError('Invalid URL');
  }
  return parsePathUrlLenient(asString, base);
};

/** The LENIENT path-space parse (base join, or the no-base path record):
 * base resolution uses this — a relative bundle path is a legal BASE
 * (import.meta.url's staged spelling) even though a relative no-base INPUT
 * at top level throws node's Invalid URL (see parsePathUrl). */
const parsePathUrlLenient = (asString, base) => {
  if (base !== undefined) {
    const baseParsed = constructBase(base);
    return { ...baseParsed, pathname: joinRelative(baseParsed.pathname, asString), search: '', fragment: '' };
  }
  return {
    scheme: '', authority: '', pathname: joinRelative('/', asString),
    search: '', fragment: '',
  };
};

/** Internal URL construction for BASE resolution: identical to the
 * constructor except a RELATIVE path-URL base is accepted (see
 * parsePathUrlLenient). */
const constructBase = (base) => {
  const asString = String(base);
  const hasScheme = /^[A-Za-z][A-Za-z0-9+.\-]*:/.test(asString);
  if (hasScheme) return new DshURL(asString);
  return parsePathUrlLenient(asString, undefined);
};

/** Scheme-less input against a SPECIAL-scheme base (module level for size):
 * '/x' is ROOT-relative (replaces the path), '?q'/'#f' swap one component,
 * an empty input keeps the base, and a bare segment joins the base DIRECTORY
 * with dot-segment normalization (joinRelative) — agent-presets health
 * checks join '../../plugins/x.js' against a file: URL, and the old plain
 * concatenation left '../' in the path so isFile missed the target
 * (R3-G2, 2026-09-28). */
const resolveAgainstSpecialBase = (asString, baseParsed) => {
  if (asString.startsWith('/')) {
    return { ...baseParsed, pathname: asString, search: '', fragment: '' };
  }
  if (asString.startsWith('?')) {
    return { ...baseParsed, search: asString, fragment: '' };
  }
  if (asString.startsWith('#')) {
    return { ...baseParsed, fragment: asString };
  }
  if (asString === '') {
    return { ...baseParsed };
  }
  return { ...baseParsed, pathname: joinRelative(baseParsed.pathname, asString), search: '', fragment: '' };
};

/** Copy the parsed components onto the URL face, then split a path-embedded
 * `?#` tail off the pathname (the parser-level component split). */
const splitPathComponents = (target, parsed) => {
  target.pathname = parsed.pathname;
  target.search = parsed.search;
  target.fragment = parsed.fragment;
  const hashAt = target.pathname.indexOf('#');
  if (hashAt >= 0) {
    target.fragment = target.pathname.slice(hashAt);
    target.pathname = target.pathname.slice(0, hashAt);
  }
  const queryAt = target.pathname.indexOf('?');
  if (queryAt >= 0) {
    target.search = target.pathname.slice(queryAt);
    target.pathname = target.pathname.slice(0, queryAt);
  }
};

export class DshURL {
  /** URL.parse — the WHATWG static face (Node 22+): the constructor without
   * the throw, null on any invalid input. The vendored http-proxy policy
   * reader discriminates "invalid proxy URL" with exactly that contract. */
  static parse(input, base = undefined) {
    try {
      return new DshURL(input, base);
    } catch {
      return null;
    }
  }

  constructor(input, base = undefined) {
    let parsed;
    const asString = String(input);
    const hasScheme = /^[A-Za-z][A-Za-z0-9+.\-]*:/.test(asString);
    // A scheme-less input is a spike PATH-URL (the loader pins import.meta.url
    // to the staged bundle-relative path — plain POSIX, no scheme); lexical
    // joins keep new URL('../presets/', import.meta.url) in the same space,
    // and fileURLToPath passes path URLs through unchanged.
    if (!hasScheme) {
      // A special-scheme base keeps the input in WHATWG space: '/x' is
      // ROOT-relative (replaces the path), '?q'/'#f' swap one component, and
      // a bare segment joins the base directory (R3-G1, 2026-09-28 — the
      // load-bundle spec resolves a root-relative sourceMappingURL
      // '/plugins/…' against an http URL; the old path-space join DOUBLED the
      // first segment: 'plugins/plugins/…').
      const baseParsed = base !== undefined ? constructBase(base) : undefined;
      if (baseParsed !== undefined && baseParsed.scheme !== '') {
        parsed = resolveAgainstSpecialBase(asString, baseParsed);
      } else {
        parsed = parsePathUrl(asString, base);
      }
    } else if (hasScheme) {
      parsed = parseAbsolute(asString) ?? parseOpaque(asString);
    } else if (base !== undefined) {
      const baseParsed = new DshURL(base);
      if (asString.startsWith('/')) {
        parsed = { ...baseParsed, pathname: asString, search: '', fragment: '' };
      } else if (asString === '') {
        parsed = { ...baseParsed };
      } else if (baseParsed.scheme === '' || asString.startsWith('.')) {
        // Lexical join in PATH space (scheme-less spike URLs): '.'/'..' kept
        // verbatim would corrupt the walk; resolve them the way realpath does.
        parsed = { ...baseParsed, pathname: joinRelative(baseParsed.pathname, asString), search: '', fragment: '' };
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
    splitPathComponents(this, parsed);
  }

  get protocol() { return `${this.scheme}:`; }
  /** WHATWG protocol SETTER — the scheme-swap face (`url.protocol = 'wss:'`).
   * The api-gateway client mux derives its stream URL by building the page
   * URL and flipping https:→wss: in place (remoteStreamUrl), so a getter-only
   * protocol broke the vendored client at its first connect. Follows the
   * basic URL parser's scheme state: accept the scheme with or without its
   * trailing ':', lowercase it, and when the scheme CHANGES, drop an explicit
   * port that equals the NEW scheme's default (443 on an https:→wss: swap is
   * elided; an explicit-80 https: URL flipped to ws: keeps its 80 per spec).
   * Targets outside the special-scheme table the shim serves fail loud
   * (rule 5). */
  set protocol(value) {
    const match = /^([A-Za-z][A-Za-z0-9+.\-]*):?$/.exec(String(value));
    if (match === null) {
      throw new TypeError(`node:url: protocol setter: invalid scheme '${String(value)}'`);
    }
    const next = match[1].toLowerCase();
    if (next === this.scheme) return;
    const newDefault = SPECIAL[`${next}:`];
    if (newDefault === undefined) {
      throw new Error(`node:url: protocol setter: scheme '${next}:' is not served (special schemes only)`);
    }
    if (this.port !== '' && this.port === newDefault) {
      // Strip the ':port' suffix (IPv6-aware: a ':' inside brackets is an
      // address segment, never the port separator).
      const bracketAt = this.authority.lastIndexOf(']');
      const colonAt = this.authority.lastIndexOf(':');
      if (colonAt > bracketAt) this.authority = this.authority.slice(0, colonAt);
    }
    this.scheme = next;
  }
  get host() { return this.authority; }
  /** username/password — the authority's `user:pass@` prefix (WHATWG keeps
   * them percent-encoded verbatim). The llm-deepseek Messages baseURL
   * validator refuses credentials in the URL through exactly these members
   * (R3-G1, 2026-09-28: absent getters read falsy and a credentialed URL
   * slipped the "must be a root without credentials" gate). */
  get username() {
    const at = this.authority.lastIndexOf('@');
    if (at <= 0) return '';
    const userInfo = this.authority.slice(0, at);
    const colon = userInfo.indexOf(':');
    return userInfo.slice(0, colon === -1 ? userInfo.length : colon);
  }
  get password() {
    const at = this.authority.lastIndexOf('@');
    if (at <= 0) return '';
    const userInfo = this.authority.slice(0, at);
    const colon = userInfo.indexOf(':');
    return colon === -1 ? '' : userInfo.slice(colon + 1);
  }
  get hostname() {
    // Bracketed IPv6: everything through `]` is the host (the colons inside
    // are address segments, never a host:port separator — WHATWG rule the
    // http-proxy loopback checks lean on for [::1]/[::ffff:...]).
    const bracketAt = this.authority.lastIndexOf(']');
    if (bracketAt > 0) return this.authority.slice(0, bracketAt + 1);
    const colonAt = this.authority.lastIndexOf(':');
    return colonAt > 0 ? this.authority.slice(0, colonAt) : this.authority;
  }
  get port() {
    const bracketAt = this.authority.lastIndexOf(']');
    if (bracketAt > 0) {
      const rest = this.authority.slice(bracketAt + 1);
      return rest.startsWith(':') ? rest.slice(1) : '';
    }
    const colonAt = this.authority.lastIndexOf(':');
    return colonAt > 0 ? this.authority.slice(colonAt + 1) : '';
  }
  get origin() {
    if (this.scheme === 'file') return 'null';
    return `${this.scheme}://${this.authority}`;
  }
  get hash() { return this.fragment; }
  get href() {
    if (this.scheme === 'file') {
      // The file: AUTHORITY is part of the href (node: file://server/share/x
      // hrefs carry the host). Dropping it made 'file://[' round-trip as
      // 'file:///' — a malformed authority silently became a valid root URL
      // (measured 2026-09-28: lsp renderUri keeps-malformed test).
      const head = this.authority === '' ? '' : `//${this.authority}`;
      return `file://${head}${pathEncode(this.pathname)}${this.search}${this.fragment}`;
    }
    // Path URLs (empty scheme) serialize as plain paths — a '://' with an
    // empty scheme would be unparseable noise round-tripping through href.
    const head = this.scheme === '' ? '' : `${this.scheme}://${this.authority}`;
    return `${head}${pathEncode(this.pathname)}${this.search}${this.fragment}`;
  }
  toString() { return this.href; }
  toJSON() { return this.href; }

  /** WHATWG URL.canParse — boolean parse probe (the web-search providers
   * validate configured base URLs with it; measured 2026-09-27). */
  static canParse(input, base = undefined) {
    // WHATWG: a scheme-less input WITHOUT a base is a relative URL that
    // cannot parse. (WITH a base it is a valid relative reference — the
    // spike additionally allows scheme-less PATH-URL joins, its loader's
    // import.meta.url space; both stay parseable when a base is given.)
    const asString = String(input);
    const hasScheme = /^[A-Za-z][A-Za-z0-9+.\-]*:/.test(asString);
    if (base === undefined && !hasScheme) return false;
    try {
      new DshURL(input, base);
      return true;
    } catch {
      return false;
    }
  }
}

// The file: faces come from url-file.js (an ESM cycle under the bare
// 'node:url' entry) — getters defer the binding reads past the cycle, the
// object shape stays the same.
export default {
  get pathToFileURL() { return pathToFileURL; },
  get fileURLToPath() { return fileURLToPath; },
  URL: DshURL,
};
