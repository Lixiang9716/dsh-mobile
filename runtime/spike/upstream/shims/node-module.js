// dsh:logging-exempt (shim layer: no transport, no I/O of its own)
/**
 * node:module shim — `createRequire` only, backed by the host's bundle-read
 * seam (`__dshBundleRequire`). Upstream uses require() exactly once in the
 * vendored closure (dsh-llm's attribution header: `createRequire(import.meta
 * .url)("../package.json")`), so the shim serves package-style RELATIVE
 * `.json` reads and fails loud on everything else (rule 5): no arbitrary
 * file reads, no CommonJS module resolution — the gateway fs scopes are not
 * the module filesystem, and the loader's bare map stays the single owner of
 * the specifier → vendor path mapping (the C binding resolves `base` through
 * the very same table).
 *
 * import.meta.url in this runtime is the module NAME (the bare specifier, or
 * the bundle-root-relative entry path), which is exactly what the C seam
 * expects as `base`.
 */

import { existsSync } from 'upstream/shims/fs.js';
import { fileURLToPath } from 'upstream/shims/url.js';
import { makeRequire, bareCjsPackages } from 'upstream/shims/cjs-loader.js';

/** The directory one base lives in — base is a file: URL, a bundle-root
 * path, or a bare module name (import.meta.url in this runtime is the
 * module NAME; see the module header). A base that NAMES a directory
 * (trailing separator — tree ctx.baseUrl spellings are directory URLs)
 * is its own first search parent; anything else uses path.dirname. */
const baseDirOf = (base) => {
  let p = base.startsWith('file:') ? fileURLToPath(base) : base;
  const isDirectory = /\/$/.test(p);
  p = p.replace(/\/+$/, '');
  if (isDirectory) return p === '' ? '/' : p;
  const cut = p.lastIndexOf('/');
  return cut > 0 ? p.slice(0, cut) : '/';
};

/** node's resolution search paths for a base: `<ancestor>/node_modules` from
 * the base directory up to the root (the global/current-dir tail node adds
 * has no counterpart here). The plugin-package inventory walks these to find
 * manifests the staged workspace carries. */
const resolvePathsFor = (base) => {
  const dirs = [];
  let current = baseDirOf(base);
  for (;;) {
    dirs.push(`${current}/node_modules`);
    if (current === '/' || current.length === 0) break;
    const cut = current.lastIndexOf('/');
    current = cut > 0 ? current.slice(0, cut) : '/';
  }
  return dirs;
};

export function createRequire(base) {
  if (typeof base !== 'string' || base.length === 0) {
    throw new TypeError(`node:module: createRequire needs a module name, got ${String(base)}`);
  }
  const require = (request) => {
    if (typeof request !== 'string' || request.length === 0) {
      throw new TypeError(`node:module: require needs a relative request, got ${String(request)}`);
    }
    // JS modules (relative .js/.cjs/.mjs) go through the userland CJS
    // loader: it EVALUATES (per-file scope, memoized, cycle-safe) over the
    // staged view and the bundle disk — the host seam only returns raw
    // text, and the CJS graph (@mixmark-io/domino et al) needs node's
    // per-file semantics, which no flat bridge row can express.
    // RELATIVE .json stays on the host seam: the seam resolves `base`
    // through the loader's bare map (dsh-llm's attribution header reads
    // ../package.json with base = the bare specifier — lexical dirname
    // math on a bare name cannot reproduce that resolution).
    const isJsModule = /\.(js|cjs|mjs)$/.test(request);
    const isRelative = request.startsWith('./') || request.startsWith('../') || request.startsWith('/');
    // bare requests naming a cjs-loader table row (package name or subpath
    // of one) evaluate through the CJS loader as well
    const pkgName = request.startsWith('@')
      ? request.split('/').slice(0, 2).join('/')
      : request.split('/')[0];
    if ((isJsModule && isRelative) || (!isRelative && pkgName in bareCjsPackages)) {
      return makeRequire(base)(request);
    }
    const text = globalThis.__dshBundleRequire?.(base, request);
    if (typeof text !== 'string') {
      throw new Error(`node:module: require('${request}') from ${base}: host bundle-read seam unavailable`);
    }
    return JSON.parse(text);
  };
  // require.resolve — the plugin-package inventory reads only `.paths(name)`
  // (the node_modules candidates a bare specifier would search); the face
  // answers from the staged fs view so workspace-seeded manifests resolve.
  const resolve = (request) => {
    if (typeof request !== 'string' || request.length === 0) {
      throw new TypeError(`node:module: resolve needs a specifier, got ${String(request)}`);
    }
    for (const dir of resolvePathsFor(base)) {
      const manifest = `${dir}/${request}/package.json`;
      if (existsSync(manifest)) return manifest;
    }
    const error = new Error(`node:module: cannot resolve '${request}' from ${base}`);
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  };
  resolve.paths = (request) => {
    if (typeof request !== 'string' || request.length === 0) {
      throw new TypeError(`node:module: resolve.paths needs a specifier, got ${String(request)}`);
    }
    return resolvePathsFor(base);
  };
  require.resolve = resolve;
  return require;
}

/** isBuiltin(specifier): the presets service classifies composition rows with
 * it (a row naming `node:fs` is a builtin row; one naming a package needs a
 * resolver). The spike's builtin surface is exactly the shim table — a bare
 * specifier is built-in only when it names one of those node: modules. */
const BUILTIN_PREFIXES = [
  'node:', 'fs', 'path', 'crypto', 'util', 'os', 'url', 'events',
  'buffer', 'process', 'string_decoder', 'timers', 'async_hooks', 'module',
];
export function isBuiltin(specifier) {
  if (typeof specifier !== 'string') return false;
  if (specifier.startsWith('node:')) return true;
  const pkg = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : (specifier.split('/')[0] ?? '');
  return BUILTIN_PREFIXES.includes(pkg);
}

/** stripTypeScriptTypes — node 22.8+'s type-stripping loader API. The vendored
 * caller (ptc-runtime-node) wraps EVERY PTC program in an async function and
 * passes it through here before running it IN-PROCESS (the 2026-09-28 spill
 * suite measures the in-process arm, not just the subprocess one), slicing
 * the result back by the wrap offsets — so plain JavaScript MUST come back
 * byte-identical, exactly like node's amaro stripper answers for JS input.
 * This runtime has no TypeScript stripper: a program carrying TS syntax gets
 * the unchanged text and fails at parse time (still loud, one layer later)
 * instead of being refused before any program runs. */
export function stripTypeScriptTypes(code) {
  if (typeof code !== 'string') {
    throw new TypeError(`node:module: stripTypeScriptTypes needs a string of source, got ${typeof code}`);
  }
  return code;
}

export default { createRequire, isBuiltin, stripTypeScriptTypes };
