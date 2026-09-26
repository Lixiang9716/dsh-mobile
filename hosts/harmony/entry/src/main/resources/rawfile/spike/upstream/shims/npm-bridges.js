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
 *   - yaml@2.9.0 → vendor/npm/yaml@2.9.0 (browser/ — the package's own ESM
 *     face; the "node" face is CJS, which this loader cannot serve) →
 *     `yaml`, imported by @deepseek-ai/dsh-skill-filesystem (`parse` — the
 *     SKILL.md frontmatter).
 *   - chokidar@5.0.0 → NO vendored tree (the @vscode/ripgrep precedent: the
 *     package's engine is real OS fs events plus awaitWriteFinish wall-clock
 *     timers, and the runtime has neither seam) → `chokidar`, imported at
 *     link time by @deepseek-ai/dsh-skill-filesystem. The linkage shim
 *     satisfies the import and its `watch()` throws loud naming the gap
 *     (rule 5); the mobile profile mounts skill-filesystem with `watch:false`
 *     and never reaches it.
 *
 * Self-registering on import (the web-shims.js pattern): import this module
 * BEFORE the first import of a bridged package. Everything fails loud
 * (rule 5): no seam, no bridge; a missing vendored tree surfaces as the
 * loader's own resolution error naming the path.
 */
const BRIDGES = [
  ['diff', "export * from '/vendor/npm/diff@9.0.0/libesm/index.js';"],
  ['yaml', "export * from '/vendor/npm/yaml@2.9.0/browser/index.js';"],
  // The upstream-suite growth round 3 (2026-09-25): test faces the suite's
  // own source packages import, pinned at the dsh-v0.1.6-alpha.2 lockfile's
  // exact resolutions and NEVER mounted by the product boot. Subpath rows
  // point at each package's own ESM face (the loader resolves concrete
  // files, not exports maps).
  ['zustand/vanilla', "export * from '/vendor/npm/zustand@4.4.7/esm/vanilla.js';"],
  ['zustand/shallow', "export * from '/vendor/npm/zustand@4.4.7/esm/shallow.js';"],
  ['zustand/middleware', "export * from '/vendor/npm/zustand@4.4.7/esm/middleware.js';"],
  ['eventsource-parser/stream', "export * from '/vendor/npm/eventsource-parser@3.1.0/dist/stream.js';"],
  ['eventsource-parser', "export * from '/vendor/npm/eventsource-parser@3.1.0/dist/index.js';"],
  // The chokidar linkage shim (no vendored tree — see the row note above).
  // The importing vendored package binds only the default export and calls
  // `chokidar.watch(...)`, so the shim is exactly that face; it fails loud
  // naming the seam that is missing, so an accidental watch:true mount can
  // never silently no-op.
  ['chokidar', [
    "const refuse = () => {",
    "  throw new Error('chokidar: watch() is not served in this runtime — ",
    "no fs-event or wall-clock timer seam (mount skill-filesystem with watch:false)');",
    "};",
    "export default { watch: refuse };",
  ].join(' ')],
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
