// dsh:logging-exempt (shim layer; specifier registration, no logging surface)
/**
 * Runtime module bridges for pinned npm packages the HOST LOADER's bare map
 * cannot name. `dsh_map_bare` (the platform file hosts/**) owns the bare
 * specifiers it maps, and bare npm names without a dot or slash fail loud as
 * "unmapped module specifier" — but the loader resolves RUNTIME-DEFINED
 * modules first, through the `__dshModuleDefine(name, source)` seam the M3
 * install pipeline already ships. A one-line re-export bridge registered
 * here puts the VERBATIM, sha256-pinned vendored npm tree behind the bare
 * specifier the vendored tool packages import — zero upstream bytes copied,
 * edited, or re-pinned (D6), and no host-file edit.
 *
 * Rows (npm package → vendored tree → bare specifier a vendored package
 * imports):
 *   - diff@9.0.0 → vendor/npm/diff@9.0.0 (libesm — the ESM face its exports
 *     map gives an importer) → `diff`, imported by @deepseek-ai/dsh-tool-fs
 *     (`structuredPatch` — the hunk diffs in write/edit results).
 *
 * Self-registering on import (the web-shims.js pattern): import this module
 * BEFORE the first import of a bridged package. Everything fails loud
 * (rule 5): no seam, no bridge; a missing vendored tree surfaces as the
 * loader's own resolution error naming the path.
 */
const BRIDGES = [
  ['diff', "export * from '/vendor/npm/diff@9.0.0/libesm/index.js';"],
];

export const defineNpmBridges = () => {
  const define = globalThis.__dshModuleDefine;
  if (typeof define !== 'function') {
    throw new Error('npm-bridges: __dshModuleDefine is not available — this host does not expose the runtime module seam the bridges register through');
  }
  for (const [name, source] of BRIDGES) {
    define(name, source);
  }
  return BRIDGES.map(([name]) => name);
};

defineNpmBridges();
