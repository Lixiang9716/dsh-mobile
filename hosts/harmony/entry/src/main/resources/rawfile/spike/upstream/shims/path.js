// dsh:logging-exempt (shim layer)
/**
 * node:path shim — POSIX member subset.
 *
 * Covers (upstream usage → this module):
 *   - dsh-session (`isAbsolute`) — session cwd guards.
 *   - boot.js/profile code (`join`, `resolve`, `dirname`, `basename`) —
 *     profile-container paths, POSIX-shaped by contract (the gateway fs
 *     scopes are POSIX-relative per contract/primitives).
 *
 * Intentionally NOT supported: win32 namespace (`path.win32` — absent, so an
 * import of it is a loud link error); no filesystem access of its own.
 */
const join = (...parts) => normalize(parts.filter((p) => p !== '').join('/'));

const normalize = (path) => {
  const absolute = path.startsWith('/');
  const out = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(seg);
  }
  return (absolute ? '/' : '') + out.join('/');
};

const resolve = (...parts) => {
  let resolved = '';
  for (const part of parts) {
    if (part === '') continue;
    resolved = isAbsolute(part) ? part : `${resolved}/${part}`;
  }
  return normalize(resolved || '.');
};

const isAbsolute = (path) => typeof path === 'string' && path.startsWith('/');

const dirname = (path) => {
  const at = path.lastIndexOf('/');
  if (at < 0) return '.';
  if (at === 0) return '/';
  return path.slice(0, at);
};

const basename = (path, suffix) => {
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (suffix && base.endsWith(suffix)) return base.slice(0, base.length - suffix.length);
  return base;
};

const extname = (path) => {
  const base = basename(path);
  const at = base.lastIndexOf('.');
  return at <= 0 ? '' : base.slice(at);
};

const relative = (from, to) => {
  const fromParts = resolve(from).split('/').filter(Boolean);
  const toParts = resolve(to).split('/').filter(Boolean);
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common++;
  const up = fromParts.slice(common).map(() => '..');
  return normalize([...up, ...toParts.slice(common)].join('/') || '.');
};

export const sep = '/';
export const delimiter = ':';
/** POSIX identity: namespacing (\\?\ prefixes) is a win32-only concern, and
 * the vendored fs-local calls it only inside its win32 branch. Declared
 * BEFORE the `posix` object, which folds it in. */
export const toNamespacedPath = (path) => path;
export const posix = {
  basename, delimiter, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep, toNamespacedPath,
};
export const win32 = undefined; // loud: `import { win32 }` yields undefined, property use throws
export { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve };
