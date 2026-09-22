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

export function createRequire(base) {
  if (typeof base !== 'string' || base.length === 0) {
    throw new TypeError(`node:module: createRequire needs a module name, got ${String(base)}`);
  }
  return (request) => {
    if (typeof request !== 'string' || request.length === 0) {
      throw new TypeError(`node:module: require needs a relative request, got ${String(request)}`);
    }
    const text = globalThis.__dshBundleRequire?.(base, request);
    if (typeof text !== 'string') {
      throw new Error(`node:module: require('${request}') from ${base}: host bundle-read seam unavailable`);
    }
    return JSON.parse(text);
  };
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

export default { createRequire, isBuiltin };
