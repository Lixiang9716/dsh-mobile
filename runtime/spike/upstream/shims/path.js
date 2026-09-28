// dsh:logging-exempt (shim layer)
/**
 * node:path shim — POSIX face with NODE-EXACT semantics (rewritten 2026-09-27
 * after the upstream path-diff spec measured 59 divergences against the
 * webworker-runtime's own reference implementation, which upstream CI asserts
 * equals node). The algorithms below are node's lib/path.js posix half: the
 * single-pass normalizeString scanner, the right-to-left resolve, and the
 * slash-dot state machines in dirname/basename/extname/parse — the edge
 * behavior (trailing separators kept by normalize, `..`/leading-dot extname
 * rules, dir+root precedence in format) falls out of them verbatim.
 *
 * Intentionally NOT supported: win32 namespace (`path.win32` — undefined, so
 * an import of it is a loud link error); no filesystem access of its own.
 */
const CHAR_DOT = 46;
const CHAR_FORWARD_SLASH = 47;

const isPosixPathSeparator = (code) => code === CHAR_FORWARD_SLASH;

const assertPath = (path) => {
  if (typeof path !== 'string') {
    throw new TypeError(`Path must be a string. Received ${String(path)}`);
  }
};

/** node's normalizeString: walk once, collapsing separators and dot
 * segments; `allowAboveRoot` lets leading `..` survive on relative paths.
 * (Split into module-level helpers for the size gate — the scan state rides
 * a plain object so the separator handler can mutate it in place; the
 * algorithm is node's lib/path.js verbatim.) */
const popLastSegment = (res) => {
  const lastSlashIndex = res.lastIndexOf('/');
  if (lastSlashIndex === -1) return { res: '', lastSegmentLength: 0 };
  const cut = res.slice(0, lastSlashIndex);
  return { res: cut, lastSegmentLength: cut.length - 1 - cut.lastIndexOf('/') };
};

const handleSeparator = (state, path, i, allowAboveRoot) => {
  const res = state.res;
  if (state.lastSlash === i - 1 || state.dots === 1) {
    // double separator or a single dot segment: drop
  } else if (state.dots === 2) {
    const isDotDot = res.length >= 2 && state.lastSegmentLength === 2
      && res.charCodeAt(res.length - 1) === CHAR_DOT
      && res.charCodeAt(res.length - 2) === CHAR_DOT;
    if (!isDotDot && res.length > 2) {
      Object.assign(state, popLastSegment(res));
      state.lastSlash = i;
      state.dots = 0;
      return;
    }
    if (!isDotDot && res.length !== 0) {
      state.res = '';
      state.lastSegmentLength = 0;
      state.lastSlash = i;
      state.dots = 0;
      return;
    }
    if (allowAboveRoot) {
      state.res += state.res.length > 0 ? '/..' : '..';
      state.lastSegmentLength = 2;
    }
  } else {
    if (res.length > 0) state.res += `/${path.slice(state.lastSlash + 1, i)}`;
    else state.res = path.slice(state.lastSlash + 1, i);
    state.lastSegmentLength = i - state.lastSlash - 1;
  }
  state.lastSlash = i;
  state.dots = 0;
};

const normalizeString = (path, allowAboveRoot) => {
  const state = { res: '', lastSegmentLength: 0, lastSlash: -1, dots: 0 };
  let code = 0;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i);
    else if (code === CHAR_FORWARD_SLASH) break;
    else code = CHAR_FORWARD_SLASH;
    if (code === CHAR_FORWARD_SLASH) handleSeparator(state, path, i, allowAboveRoot);
    else if (code === CHAR_DOT && state.dots !== -1) ++state.dots;
    else state.dots = -1;
  }
  return state.res;
};

/** The process cwd the relative forms resolve against (the profile container;
 * the vendored face reads the same global through the process shim). */
const cwd = () => globalThis.process?.cwd?.() ?? '/';

export const resolve = (...paths) => {
  let resolved = '';
  let absolute = false;
  for (let i = paths.length - 1; i >= 0 && !absolute; i--) {
    const path = paths[i];
    assertPath(path);
    if (path.length === 0) continue;
    resolved = resolved.length === 0 ? path : `${path}/${resolved}`;
    absolute = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
  }
  if (!absolute) {
    const base = cwd();
    resolved = resolved.length === 0 ? base : `${base}/${resolved}`;
    absolute = base.charCodeAt(0) === CHAR_FORWARD_SLASH;
  }
  const normalized = normalizeString(resolved, !absolute);
  if (absolute) return `/${normalized}`;
  return normalized.length > 0 ? normalized : '.';
};

export const normalize = (path) => {
  assertPath(path);
  if (path.length === 0) return '.';
  const isAbsolutePath = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
  const trailingSeparator = path.charCodeAt(path.length - 1) === CHAR_FORWARD_SLASH;
  let normalized = normalizeString(path, !isAbsolutePath);
  if (normalized.length === 0) {
    if (isAbsolutePath) return '/';
    return trailingSeparator ? './' : '.';
  }
  if (trailingSeparator) normalized += '/';
  return isAbsolutePath ? `/${normalized}` : normalized;
};

export const isAbsolute = (path) => {
  assertPath(path);
  return path.length > 0 && path.charCodeAt(0) === CHAR_FORWARD_SLASH;
};

export const join = (...paths) => {
  if (paths.length === 0) return '.';
  let joined;
  for (const path of paths) {
    assertPath(path);
    if (path.length === 0) continue;
    joined = joined === undefined ? path : `${joined}/${path}`;
  }
  return joined === undefined ? '.' : normalize(joined);
};

export const relative = (from, to) => {
  assertPath(from);
  assertPath(to);
  if (from === to) return '';
  const fromResolved = resolve(from);
  const toResolved = resolve(to);
  if (fromResolved === toResolved) return '';
  const fromParts = fromResolved.split('/').filter((part) => part.length > 0);
  const toParts = toResolved.split('/').filter((part) => part.length > 0);
  let shared = 0;
  while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) shared++;
  const up = Array.from({ length: fromParts.length - shared }, () => '..');
  return [...up, ...toParts.slice(shared)].join('/') || '.';
};

export const dirname = (path) => {
  assertPath(path);
  if (path.length === 0) return '.';
  const hasRoot = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 1; --i) {
    if (path.charCodeAt(i) === CHAR_FORWARD_SLASH) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) return hasRoot ? '/' : '.';
  if (hasRoot && end === 1) return '//';
  return path.slice(0, end);
};

export const basename = (path, suffix) => {
  assertPath(path);
  let start = 0;
  let end = -1;
  let matchedSlash = true;
  if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
    if (suffix === path) return '';
    let extIdx = suffix.length - 1;
    let firstNonSlashEnd = -1;
    for (let i = path.length - 1; i >= 0; --i) {
      const code = path.charCodeAt(i);
      if (code === CHAR_FORWARD_SLASH) {
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
        continue;
      }
      if (firstNonSlashEnd === -1) {
        matchedSlash = false;
        firstNonSlashEnd = i + 1;
      }
      if (extIdx >= 0) {
        if (code === suffix.charCodeAt(extIdx)) {
          if (--extIdx === -1) end = i;
        } else {
          extIdx = -1;
          end = firstNonSlashEnd;
        }
      }
    }
    if (start === end) end = firstNonSlashEnd;
    else if (end === -1) end = path.length;
    return path.slice(start, end);
  }
  for (let i = path.length - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === CHAR_FORWARD_SLASH) {
      if (!matchedSlash) {
        start = i + 1;
        break;
      }
    } else if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
  }
  return end === -1 ? '' : path.slice(start, end);
};

export const extname = (path) => {
  assertPath(path);
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  let preDotState = 0;
  for (let i = path.length - 1; i >= 0; --i) {
    const code = path.charCodeAt(i);
    if (code === CHAR_FORWARD_SLASH) {
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
    if (code === CHAR_DOT) {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }
  if (startDot === -1 || end === -1 || preDotState === 0
      || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
    return '';
  }
  return path.slice(startDot, end);
};

/** format(pathObject) — node's precedence: dir (with a separator join, kept
 * verbatim when it already ends in one) > root; base > name+ext (the dot
 * prepended only when ext lacks it); bare root when nothing else is set. */
export const format = (pathObject) => {
  if (pathObject === null || typeof pathObject !== 'object') {
    throw new TypeError(`Parameter "pathObject" must be an object, not ${typeof pathObject}`);
  }
  const root = pathObject.root ?? '';
  const dir = pathObject.dir ?? root;
  const base = pathObject.base ?? `${pathObject.name ?? ''}${pathObject.ext ?? ''}`;
  if (dir === '') return base;
  return dir === root ? `${dir}${base}` : `${dir}/${base}`;
};

/** parse(path) — the node PathObject split. The dir slice keeps interior
 * separators verbatim (`a//b` → dir `a/`), trailing separators are stripped
 * before the last-slash scan, and leading-dot bases carry no ext. */
export function parse(path) {
  assertPath(path);
  const base = basename(path);
  const ext = extname(path);
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const lastSlash = trimmed.lastIndexOf('/');
  const root = isAbsolute(path) ? '/' : '';
  return {
    root,
    dir: trimmed === '' ? root : lastSlash === -1 ? '' : lastSlash === 0 ? '/' : trimmed.slice(0, lastSlash),
    base,
    ext,
    name: ext.length > 0 ? base.slice(0, base.length - ext.length) : base,
  };
}

export const sep = '/';
export const delimiter = ':';
/** POSIX identity: namespacing (\\?\ prefixes) is a win32-only concern, and
 * the vendored fs-local calls it only inside its win32 branch. */
export const toNamespacedPath = (path) => path;

export const posix = {
  resolve,
  normalize,
  isAbsolute,
  join,
  relative,
  dirname,
  basename,
  extname,
  format,
  parse,
  sep,
  delimiter,
  toNamespacedPath,
};
/* ---- win32 namespace (2026-09-27) --------------------------------------
 * The workspace suite drives the vendored paths helpers with platform:'win32'
 * (fully-qualified-root classification + title derivation), which needs node's
 * win32 parse/isAbsolute/basename semantics: drive roots (C:, C:\), UNC
 * shares (\\server\share), and POSIX-ish separators both counting. The old
 * `win32 = undefined` loud stub dated from a closure that never touched it. */
const WIN32_SEPS = /[\\/]+/;
const WIN32_DEVICE = /^([a-zA-Z]:)([\\/]?)/;
const WIN32_UNC = /^([\\/]{2}[^\\/]+[\\/][^\\/]+)/;
const WIN32_LONE_SEP = /^([\\/])/;
const win32SplitRoot = (path) => {
  let m = WIN32_UNC.exec(path);
  if (m) return { root: m[1], rest: path.slice(m[1].length) };
  m = WIN32_DEVICE.exec(path);
  if (m) return { root: m[1] + m[2], rest: path.slice(m[0].length) };
  m = WIN32_LONE_SEP.exec(path);
  if (m) return { root: m[1], rest: path.slice(1) };
  return { root: '', rest: path };
};
export const win32IsAbsolute = (path) => {
  assertPath(path);
  return WIN32_DEVICE.test(path) ? WIN32_DEVICE.exec(path)[2] !== ''
    : WIN32_UNC.test(path) || WIN32_LONE_SEP.test(path);
};
export const win32Basename = (path, suffix) => {
  assertPath(path);
  // node: the basename of a bare root (C:\, C:, \\server\share, \) is '' —
  // split the root off first, then take the final non-empty segment.
  const { rest } = win32SplitRoot(path);
  const segs = rest.split(WIN32_SEPS).filter((s) => s !== '');
  if (segs.length === 0) {
    // node: a bare UNC root's basename IS its share segment
    // ('\\server\share' -> 'share'); bare drives/seps yield ''.
    const unc = WIN32_UNC.exec(path);
    if (unc) {
      const parts = unc[1].split(/[\\/]+/).filter((s) => s !== '');
      return parts[parts.length - 1] ?? '';
    }
    return '';
  }
  const base = segs[segs.length - 1];
  if (suffix !== undefined && base.endsWith(suffix) && base.length > suffix.length) {
    return base.slice(0, base.length - suffix.length);
  }
  return base;
};
export const win32Extname = (path) => {
  const base = win32Basename(path);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot);
};
export const win32Parse = (path) => {
  assertPath(path);
  const { root, rest } = win32SplitRoot(path);
  const segs = rest.split(WIN32_SEPS).filter((s) => s !== '');
  const base = segs.length > 0 ? segs[segs.length - 1] : '';
  const dir = root + (segs.length > 1 ? segs.slice(0, -1).join('\\') + '\\' : '');
  const dot = base.lastIndexOf('.');
  const ext = dot <= 0 ? '' : base.slice(dot);
  return {
    root, dir, base, ext,
    name: ext.length > 0 ? base.slice(0, base.length - ext.length) : base,
  };
};
export const win32Join = (...parts) => win32Normalize(parts.filter((p) => p !== '').join('\\'));
export const win32Normalize = (path) => {
  assertPath(path);
  const { root, rest } = win32SplitRoot(path);
  const segs = [];
  for (const seg of rest.split(WIN32_SEPS)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { segs.pop(); continue; }
    segs.push(seg);
  }
  return (root === '' ? '' : root.replace(/[\\/]+$/, '') + (segs.length > 0 ? '\\' : ''))
    + segs.join('\\') || (root === '' && segs.length === 0 ? '.' : root);
};
export const win32Resolve = (...parts) => {
  let resolved = '';
  let absolute = false;
  for (let i = parts.length - 1; i >= 0 && !absolute; i -= 1) {
    const part = parts[i];
    assertPath(part);
    if (part === '') continue;
    resolved = `${part}\\${resolved}`;
    absolute = win32IsAbsolute(part);
  }
  return win32Normalize(resolved.replace(/\\+$/, ''));
};
/** win32.relative(from, to) — node's drive-aware case-insensitive ordering:
  * segments compare case-insensitively (the drive letter too) but the
  * result preserves `to`'s case; different drives return `to` itself
  * (the lsp renderUri windows-world tests drive exactly this face). */
export const win32Relative = (from, to) => {
  assertPath(from);
  assertPath(to);
  if (from === to) return '';
  if (from.toLowerCase() === to.toLowerCase()) return '';
  const fromDev = WIN32_DEVICE.exec(from)?.[1]?.toLowerCase();
  const toDev = WIN32_DEVICE.exec(to)?.[1]?.toLowerCase();
  const fromUnc = WIN32_UNC.test(from);
  const toUnc = WIN32_UNC.test(to);
  if ((fromDev !== undefined || toDev !== undefined) && fromDev !== toDev) return win32Normalize(to);
  if (fromUnc !== toUnc) return win32Normalize(to);
  const fromSegs = from.toLowerCase().split(WIN32_SEPS).filter((p) => p !== '');
  const toSegs = to.split(WIN32_SEPS).filter((p) => p !== '');
  let shared = 0;
  while (shared < fromSegs.length && shared < toSegs.length && fromSegs[shared] === toSegs[shared].toLowerCase()) shared++;
  const up = Array.from({ length: fromSegs.length - shared }, () => '..');
  const rel = [...up, ...toSegs.slice(shared)].join('\\');
  return rel === '' ? '.' : rel;
};

export const win32 = {
  relative: win32Relative,
  resolve: win32Resolve,
  normalize: win32Normalize,
  isAbsolute: win32IsAbsolute,
  join: win32Join,
  dirname: (path) => win32Parse(path).dir,
  basename: win32Basename,
  extname: win32Extname,
  format: (o) => `${o.dir ?? ''}${o.dir ? '\\' : ''}${o.base ?? ''}`,
  parse: win32Parse,
  sep: '\\',
  delimiter: ';',
  toNamespacedPath: (path) => '\\\\?\\' + String(path),
};

/** `import path from 'node:path'` — node's CJS default is the module itself.
 * Demanded at link time by tool-subagent's `import path from "node:path"`. */
export default {
  basename, delimiter, dirname, extname, format, isAbsolute, join, normalize, parse, posix, relative, resolve, sep, toNamespacedPath, win32,
};
