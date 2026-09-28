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

/** stripTypeScriptTypes — node 22.8+'s type-stripping loader API (node
 * embeds the amaro/swc stripper). The runtime has neither: and the vendored
 * consumer (ptc-runtime-node's lib) links the name at MODULE scope only to
 * strip PTC programs it then runs in a node SUBPROCESS — the seam this
 * runtime deliberately does not provide (rule D2, the same verdict as the
 * node:vm face). Linkage only (the chokidar pattern): the import resolves,
 * every call fails loud naming the gap. */
export function stripTypeScriptTypes() {
  throw new Error('node:module: stripTypeScriptTypes is not served in this runtime — '
    + 'the TypeScript type-stripper is a node-embedding capability, and its caller '
    + '(ptc-runtime-node) executes in the subprocess class this runtime does not provide (rule D2)');
}

export default { createRequire, isBuiltin, stripTypeScriptTypes };
