// dsh:logging-exempt (shim layer)
/**
 * node:fs SEEDED-VIEW half — split from fs.js (2026-09-29, the file crossed
 * the size budget). Lives here: the root facts (`WEB_PLUGINS_ROOT`,
 * `VFS_ROOTS`), the global-store accessor (`vfs`), and the seed writers
 * (`seedWebPlugins`, `mergeWebPlugins`, `seedStagedFiles`) plus their
 * private module-define helper (`defineSeededModule`).
 *
 * W-INTEG exception — the STAGED WEB-PLUGIN VFS. Composing the official web
 * boot requires @deepseek-ai/dsh-client-modules' node half, whose incremental
 * `dsh.client` scan reads package manifests and client bundles synchronously
 * (`existsSync` / `readFileSync` / `statSync`). The host stages that
 * scan-scoped file set and delivers it over the bus seam (`web.plugins`);
 * `seedWebPlugins` mounts it read-only under /web-plugins. Outside the seeded
 * view the fs shim stays loud exactly as before, with one boundary decision:
 * `existsSync` ANSWERS a question (never moves bytes), so it returns false
 * outside the VFS instead of throwing — upstream's nearest-package walk relies
 * on false to keep scanning. `readFileSync` / `statSync` still refuse loudly
 * outside the VFS roots; inside it, a missing file throws ENOENT (upstream
 * classifies failures by `error.code`).
 *
 * ONE-WAY EDGE: this module imports NOTHING from fs.js — a static import
 * cycle between two runtime/shims files kills quickjs at link with an empty
 * error (measured). fs.js imports the names below and re-exports them, so
 * every existing import keeps its specifier.
 *
 * The store stays on the GLOBAL, not module state: quickjs compiles the
 * node:fs-mapped shim and any bundle-relative import of fs.js as TWO module
 * instances, and module-local state would silently fork (the seed would land
 * in the instance the vendored scan never reads). The global is the single
 * store; `VFS_ROOTS`/`WEB_PLUGINS_ROOT` are immutable facts, so instances
 * cannot drift.
 */
import { decodeUtf8 } from 'upstream/shims/buffer.js';

/** The VFS root (a POSIX path prefix; nothing below it hits a real disk). */
export const WEB_PLUGINS_ROOT = '/web-plugins';

/**
 * The seeded view lives on the global, NOT in module state: the vendored
 * closure imports `node:fs` while our adapters may import the shim by its
 * bundle-relative path — quickjs would compile TWO module instances, and
 * module-local state would silently fork (the seed would land in the
 * instance the vendored scan never reads). The global is the single store.
 */
export const vfs = () => {
  if (typeof globalThis.__DSH_WEB_PLUGINS_VFS__ === 'undefined') {
    globalThis.__DSH_WEB_PLUGINS_VFS__ = null;
  }
  return globalThis.__DSH_WEB_PLUGINS_VFS__;
};

/**
 * Mount the staged web-plugin view (bus seam `web.plugins`).
 * @param files - absolute POSIX path → { bytes: Uint8Array, mtimeMs: number }.
 */
export const seedWebPlugins = (files) => {
  const mounted = new Map();
  for (const [path, file] of Object.entries(files)) {
    if (typeof path !== 'string' || !VFS_ROOTS.some((root) => path.startsWith(root))) {
      throw new Error(`node:fs: staged seed path outside the VFS roots: ${path}`);
    }
    if (!(file.bytes instanceof Uint8Array) || typeof file.mtimeMs !== 'number') {
      throw new Error(`node:fs: staged web-plugin file ${path} needs {bytes, mtimeMs}`);
    }
    mounted.set(path, file);
  }
  globalThis.__DSH_WEB_PLUGINS_VFS__ = mounted;
};

/**
 * MERGE one staged chunk into the seeded view (bus seam `web.plugins`
 * chunked delivery — the harmony drive splits the multi-megabyte delivery so
 * the carrier's main thread yields between packages; the same validation as
 * `seedWebPlugins`, additive semantics).
 * @param files - absolute POSIX path → { bytes: Uint8Array, mtimeMs: number }.
 */
export const mergeWebPlugins = (files) => {
  const mounted = vfs() ?? new Map();
  for (const [path, file] of Object.entries(files)) {
    if (typeof path !== 'string' || !VFS_ROOTS.some((root) => path.startsWith(root))) {
      throw new Error(`node:fs: staged seed path outside the VFS roots: ${path}`);
    }
    if (!(file.bytes instanceof Uint8Array) || typeof file.mtimeMs !== 'number') {
      throw new Error(`node:fs: staged web-plugin file ${path} needs {bytes, mtimeMs}`);
    }
    mounted.set(path, file);
  }
  globalThis.__DSH_WEB_PLUGINS_VFS__ = mounted;
};

/** Register one seeded JS file as a runtime-defined module under its `file:`
 * URL (the __dshModuleDefine seam the host loader consults FIRST). The
 * vendored cordis plugin loader imports composition rows by dynamic import
 * of `new URL(row, baseUrl).href` — a file: URL the host cannot read off
 * disk because the seeded view lives in JS memory. Defining the source under
 * exactly the specifier the loader computes closes that seam without
 * touching the host. No-op for non-JS files and on hosts without the seam. */
const defineSeededModule = (path, bytes) => {
  if (!/\.(js|mjs)$/.test(path)) return;
  const define = globalThis.__dshModuleDefine;
  if (typeof define !== 'function') return;
  define.call(globalThis, `file://${path}`, decodeUtf8(bytes));
};

/**
 * MERGE spec-fixture files into the seeded view (the upstream-suite driver's
 * seeding of one spec's fixtures under /upstream-tests/ — same validation and
 * store as the web-plugins view, additive so several seed deliveries compose).
 * @param files - absolute POSIX path → { bytes: Uint8Array, mtimeMs: number }.
 */
export const seedStagedFiles = (files) => {
  const mounted = vfs() ?? new Map();
  for (const [path, file] of Object.entries(files)) {
    if (typeof path !== 'string' || !VFS_ROOTS.some((root) => path.startsWith(root))) {
      throw new Error(`node:fs: staged seed path outside the VFS roots: ${path}`);
    }
    if (!(file.bytes instanceof Uint8Array) || typeof file.mtimeMs !== 'number') {
      throw new Error(`node:fs: staged file ${path} needs {bytes, mtimeMs}`);
    }
    mounted.set(path, file);
    defineSeededModule(path, file.bytes);
  }
  globalThis.__DSH_WEB_PLUGINS_VFS__ = mounted;
};

/** The staged read-only roots the VFS serves. Besides the web-plugins scan
 * view, vendored packages delivered as seed data (the agent-presets presets
 * tree, under the package's own bundle-relative directory) are readable —
 * that is what the fs/promises shim walks for the presets service. Exported
 * for fs.js only: its `underVFS` gate reads the same root list this module's
 * writers validate against (one list, two consumers, no cycle). */
export const VFS_ROOTS = [`${WEB_PLUGINS_ROOT}/`, '/vendor/dsh/agent-presets@0.1.6-alpha.2/',
  // The upstream-suite spec fixtures (growth round 3): transpiled specs sit
  // flat at /upstream-tests/<stem>.spec.mjs, so their `../fixtures` joins
  // resolve to /upstream-tests/fixtures — the suite driver seeds the bytes
  // there before running the spec's tests (one spec per runtime, so last-
  // write-wins across specs is not a hazard).
  '/upstream-tests/',
  // The spec PACKAGE assets (W5-T): skill-badge's spec builds
  // new URL('../assets/<name>', import.meta.url) from upstream-tests/ —
  // /assets/<name> — and the transpiler seeds the vendored tarball's
  // verbatim asset bytes there (the fixtures seed delivery's VFS root).
  '/assets/',
  // The source-introspection root (W6-V): the source-audit tests read their
  // package's production sources — readFileSync(new URL('../src/<file>',
  // import.meta.url)) from /upstream-tests/<stem>.spec.mjs lands at
  // /src/<file> — and the suite driver stages the vendored tree's verbatim
  // bytes there (upstream-suite-leg.js stageSourceIntrospectionTree; one
  // spec per runtime, so the flat /src namespace never collides).
  '/src/',
  // The committed session-format corpus roots (W8, 2026-09-29): the
  // llm-replay session-format-corpus spec walks the upstream REPO ROOT
  // (resolve(import.meta.dirname, '../../../..') → '/' under flat staging)
  // for committed session fixtures under snapshots/ + packages/ +
  // scripts/snapshots/python-sdk-single-exe — the leg stages the pinned
  // submodule's verbatim corpus at exactly those spellings (D6: read-only,
  // staged not edited). Seeded-only arms: a prefix miss stays ENOENT, and
  // no real-disk fallback claims these spellings.
  '/snapshots/',
  '/packages/',
  '/scripts/',
  // The remote-mock type world (W8): the tsconfig chain sits at the bundle
  // ROOT (root = resolve(dirname,'../../../..') → '/'), and the compiler
  // resolves @vitest/@types packages under /node_modules/. File-spelling
  // roots for the two configs; /node_modules/ carries only what the leg
  // seeds (the pnpm store's vitest d.ts trees + the @types/node stub).
  '/tsconfig.base.client.json',
  '/tsconfig.base.json',
  '/node_modules/'];
