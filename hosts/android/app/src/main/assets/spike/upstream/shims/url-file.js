// dsh:logging-exempt (shim layer)
/**
 * shims/url-file.js — the file: URL faces of the node:url shim
 * (`pathToFileURL` / `fileURLToPath`), split out of url.js when that file
 * crossed the code-size budget. The URL parser stays the single source of
 * truth: these faces import it from url.js and url.js re-exports the faces
 * here, so every existing `from 'upstream/shims/url.js'` import keeps
 * working (an ESM cycle by construction — call-time access only, live
 * bindings; neither module body touches the other's bindings at eval time).
 */
import { encodeUtf8 } from 'upstream/shims/buffer.js';
import { DshURL, parseAbsolute, percentDecode, resolvePath } from 'upstream/shims/url.js';

/** POSIX `pathToFileURL`: absolute path → file: URL (percent-encoded). The
 * input is a RAW FILESYSTEM path, not URL-space: a literal '%' is data and
 * must become %25 (measured 2026-09-28: fs-ssh's remote paths carry literal
 * '%20' names and node's pathToFileURL answers 'literal%2520…'). This is why
 * the raw-path encoder below does NOT reuse pathEncode's keep-%XX rule —
 * that rule is correct only for pathname values already in URL-space. */
const rawFilePathEncode = (path) => path.replace(/[^A-Za-z0-9\-._~/!$&'()*+,;=:@]/g, (ch) => {
  const bytes = encodeUtf8(ch);
  return [...bytes].map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
});
export const pathToFileURL = (path) => {
  // node resolves a relative input against process.cwd() (pathToFileURL
  // shares path.resolve's semantics); the pinned profile cwd plays that
  // role here (W3-K, 2026-09-28 — the typert generator re-URLs its
  // cwd-relative scratch dir).
  let resolved = path;
  if (typeof resolved === 'string' && !resolved.startsWith('/')) {
    const cwd = globalThis.__dshProfileCwd;
    if (typeof cwd !== 'string' || !cwd.startsWith('/')) {
      throw new Error(`node:url: pathToFileURL needs an absolute POSIX path (no profile cwd pinned), got ${JSON.stringify(path)}`);
    }
    resolved = `${cwd.replace(/\/$/, '')}/${resolved}`;
  }
  if (typeof resolved !== 'string' || !resolved.startsWith('/')) {
    throw new Error(`node:url: pathToFileURL needs an absolute POSIX path, got ${JSON.stringify(path)}`);
  }
  const url = new DshURL('file:///');
  url.pathname = resolved;
  return {
    href: `file://${rawFilePathEncode(resolved)}`,
    protocol: 'file:',
    pathname: rawFilePathEncode(resolved),
    toString() { return this.href; },
  };
};

/** node's windows world (module level for size): file://host/share → UNC;
 * /C:/x → C:\x; all separators become backslashes. */
const fileURLToPathWindows = (host, path) => {
  if (host !== '' && host !== 'localhost') return `\\\\${host}${path.replaceAll('/', '\\')}`;
  const drive = path.replace(/^\/[a-zA-Z]:/, (m) => m.slice(1));
  return drive.replaceAll('/', '\\');
};

/** POSIX `fileURLToPath`: file: URL (string or URL-like) → absolute path. */
export const fileURLToPath = (input, options) => {
  const windows = typeof options === 'object' && options !== null ? options.windows === true : false;
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
  // node: an ENCODED separator (%2F) or a bad escape in the path is an
  // invalid file URL path; decoded NUL likewise (the lsp renderUri tests
  // exercise 'file:///bad%2Fpath' and 'file:///bad%00path' — both must
  // THROW so the caller keeps the URI verbatim).
  if (/%2f/i.test(parsed.pathname)) {
    throw new Error(`file URL path must not include encoded / characters: ${parsed.pathname}`);
  }
  if (windows && /%5c/i.test(parsed.pathname)) {
    throw new Error(`file URL path must not include encoded \\ characters: ${parsed.pathname}`);
  }
  let path = percentDecode(parsed.pathname);
  if (path.includes('\0')) {
    throw new Error(`file URL path must not include encoded null characters: ${parsed.pathname}`);
  }
  if (windows) return fileURLToPathWindows(host, path);
  if (host !== '' && host !== 'localhost') {
    throw new Error(`node:url: fileURLToPath refuses non-local file host '${host}'`);
  }
  if (!path.startsWith('/')) {
    throw new Error(`node:url: fileURLToPath resolved a non-absolute path: ${JSON.stringify(path)}`);
  }
  return path;
};
