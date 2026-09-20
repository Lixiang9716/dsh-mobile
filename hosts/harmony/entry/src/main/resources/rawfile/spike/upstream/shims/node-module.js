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

export default { createRequire };
