// dsh:logging-exempt (shim layer: no transport, no I/O of its own)
/**
 * Userland CommonJS loader with per-file scopes (R3-H handoff, W5-S).
 *
 * The vendored closure contains CJS packages with NO ESM face —
 * @mixmark-io/domino (turndown's HTML parser, a ~40-file relative require
 * graph with cycles) is the operative one — and the upstream specs require
 * CJS fixtures through createRequire (util/lazy-require's `./fixtures/
 * value.cjs`). The ESM bridge rows in npm-bridges.js cannot serve a require
 * GRAPH: each row is one flat module, while CJS resolution is per-file
 * (extension probing, index fallback, cycle-visible partial exports).
 *
 * This loader is that per-file resolver. Reads compose two views: the
 * seeded/staged fs view (node:fs readFileSync — /upstream-tests fixtures,
 * the workspace) and the host's bundle-read seam (__dshBundleRequire —
 * bundle-root-confined disk reads; the 2026-09-28 host change serves
 * .js/.cjs/.mjs TEXT alongside .json). Evaluation is `new Function` with
 * node's CJS wrapper arguments (exports/require/module/__filename/
 * __dirname) in sloppy mode, memoized per canonical path with the partial
 * `module.exports` visible DURING evaluation — node's cycle semantics,
 * which domino's Document<->DOMImplementation ring relies on.
 *
 * Bare specifiers resolve through BARE_PACKAGES below — a small table of
 * CJS-vendor packages the closure needs; extend it (with the pin comment)
 * when a vendor round stages another CJS-only package. Deliberately NOT the
 * C host's dsh_map_bare: that table owns ESM module resolution, while CJS
 * packages need a package-dir + main-field resolution the ESM faces never
 * express. `.json` requests relative to a bare-module base stay with the
 * host seam (node-module.js) — that seam resolves the base through the
 * loader's own bare map, which lexical dirname math cannot reproduce.
 */

import { readFileSync } from 'upstream/shims/fs.js';

/** CJS-only vendored packages, name → staged package dir (absolute VFS
 * spelling). Pins mirror the vendor/npm tree; bump BOTH together. */
const BARE_PACKAGES = {
  // @mixmark-io/domino 2.2.0 — turndown 7.2.4's createHTMLParser() requires
  // it bare when no DOMParser global exists (tool-web fetch-formatting).
  // main: "./lib" → lib/index.js.
  '@mixmark-io/domino': '/vendor/npm/@mixmark-io/domino@2.2.0',
  // @xterm/headless 6.0.0 + @xterm/addon-serialize 0.14.0 (W7-X1) — the
  // session-buffer / terminal-controller specs' createLazyRequire targets:
  // the lazy-require face goes through node:module's require, whose bare
  // routing consults THIS table (bareCjsPackages), so the row is the
  // operative mapping; the npm-bridges rows only mirror it for ESM
  // spellings. Both bundles are self-contained webpack CJS (zero require()
  // calls — measured 2026-09-28): no builtin faces needed. main:
  // "./lib-headless/xterm-headless.js" / "./lib/addon-serialize.js".
  '@xterm/headless': '/vendor/npm/@xterm/headless@6.0.0',
  '@xterm/addon-serialize': '/vendor/npm/@xterm/addon-serialize@0.14.0',
  // sharp 0.34.4 FACE — NOT the upstream package (the libvips binary cannot
  // ride a QuickJS closure; decision-matrix D-c). Our pure-JS adaptation
  // package (upstream/shims/sharp/) over the vendored pngjs/jpeg-js/fflate
  // pins serves attachment-local's createLazyRequire('sharp') through
  // node:module's bare routing; the npm-bridges row mirrors it for the ESM
  // spelling (the @xterm pattern).
  sharp: '/upstream/shims/sharp',
};

const dirOf = (p) => {
  const cut = p.lastIndexOf('/');
  return cut > 0 ? p.slice(0, cut) : '/';
};

/** Raw text of one absolute path: the seeded/staged fs view first, then the
 * bundle disk through the host seam. The seam resolves the request against
 * the PARENT DIRECTORY of its base (base is a module file name — the node
 * createRequire shape), so the base here is `dir` anchored by a lexical
 * marker file name whose content is never consulted. */
const readText = (abs) => {
  try {
    const staged = readFileSync(abs, 'utf8');
    if (typeof staged === 'string') return staged;
  } catch {
    // not in the staged view — fall through to the bundle disk
  }
  const seam = globalThis.__dshBundleRequire;
  if (typeof seam !== 'function') {
    throw new Error(`cjs-loader: no bundle-read seam for '${abs}'`);
  }
  const dir = dirOf(abs);
  return seam(`${dir}/__dsh_cjs_anchor__`, `./${abs.slice(dir.length + 1)}`);
};

/** Node's resolution attempts for one candidate path (no extension): the
 * literal spelling, the two JS extensions, .json, then the index faces. */
const candidatePaths = (candidate) => [
  candidate,
  `${candidate}.js`,
  `${candidate}.cjs`,
  `${candidate}.json`,
  `${candidate}/index.js`,
  `${candidate}/index.cjs`,
  `${candidate}/index.json`,
];

/** module cache — canonical absolute path → { exports } (set BEFORE
 * evaluation so require cycles observe node's partial-exports semantics). */
const cache = new Map();

const loadCjs = (abs) => {
  const hit = cache.get(abs);
  if (hit !== undefined) return hit.exports;
  const source = readText(abs);
  if (abs.endsWith('.json')) {
    const parsed = JSON.parse(source);
    cache.set(abs, { exports: parsed });
    return parsed;
  }
  const module = { exports: {} };
  cache.set(abs, module);
  // node's CJS wrapper, sloppy mode (CJS sources are non-strict by
  // default; `this` at their top level is module.exports)
  const fn = new Function(
    'exports', 'require', 'module', '__filename', '__dirname', source,
  );
  fn.call(module.exports, module.exports, makeRequire(abs), module, abs, dirOf(abs));
  return module.exports;
};

/** Resolve `request` the way node's CJS require would from `fromFile` and
 * return the loaded module exports. Failures stay LOUD naming the request
 * (rule 5); failures are never memoized (lazy-require asserts a failed
 * load stays failed). */
const resolveAndLoad = (fromFile, request) => {
  // relative to the requiring file's directory
  const baseDir = dirOf(fromFile);
  const joined = request.startsWith('/')
    ? request
    : `${baseDir}/${request}`;
  // lexical walk of '.' / '..' segments
  const segs = [];
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') segs.pop();
    else segs.push(part);
  }
  const candidate = `/${segs.join('/')}`;
  const failures = [];
  for (const path of candidatePaths(candidate)) {
    try {
      return loadCjs(path);
    } catch (error) {
      // every candidate failure rides the final error — the FIRST refusal
      // (a no-extension probe) would otherwise mask the real cause (W5-Q:
      // ws's require('./lib/stream') chain failed on an evaluation error
      // that the no-extension probe's refusal was hiding).
      failures.push(`${path}: ${error?.message ?? String(error)}`);
    }
  }
  throw new Error(`cjs-loader: cannot resolve '${request}' from ${fromFile} — `
    + failures.join(' | '));
};

/** node-builtin faces for CJS require graphs (W5-Q, 2026-09-28): the
 * vendored ws@8.21.0 lib requires bare 'events'/'http'/'https'/'net'/'tls'/
 * 'crypto'/'stream'/'url'/'util'/'buffer'/'zlib' at MODULE LOAD. CJS
 * evaluation is synchronous, so the faces must be registered BEFORE the
 * package's entry evaluates — the bridge row for 'ws' imports the ESM shims
 * statically and registers them here, then requires the package entry. */
const BUILTIN_FACES = new Map();
export const registerBuiltinFace = (name, face) => {
  BUILTIN_FACES.set(name, face);
};

/** The bare face: table hit → package dir, entry = package.json main (with
 * the same extension probing), subpaths resolve directly under the dir. */
const loadBare = (request) => {
  const slash = request.indexOf('/', 1);
  const isScoped = request.startsWith('@');
  const cut = isScoped
    ? request.indexOf('/', request.indexOf('/') + 1)
    : slash;
  const name = cut === -1 ? request : request.slice(0, cut);
  const sub = cut === -1 ? '' : request.slice(cut);
  const pkgDir = BARE_PACKAGES[name];
  if (pkgDir === undefined) return undefined;
  if (sub !== '') {
    // anchor the relative walk at a file INSIDE the package dir
    return resolveAndLoad(`${pkgDir}/package.json`, `.${sub}`);
  }
  return loadPackageEntry(pkgDir, name);
};

/** Load one package dir's entry: package.json main, probed (domino: "./lib"
 * → lib/index.js; ws: "./index.js"). Shared by the bare table and the
 * bridge rows' requireCjsPackage. */
const loadPackageEntry = (pkgDir, name) => {
  let main = '.';
  try {
    const manifest = JSON.parse(readText(`${pkgDir}/package.json`));
    if (typeof manifest.main === 'string') main = manifest.main;
  } catch {
    // no parsable manifest — probe the index fallbacks below
  }
  let firstError;
  for (const path of candidatePaths(`${pkgDir}/${main.replace(/^\.\//, '')}`)) {
    try {
      return loadCjs(path);
    } catch (error) {
      firstError = firstError ?? error;
    }
  }
  throw firstError ?? new Error(`cjs-loader: cannot load entry of '${name ?? pkgDir}'`);
};

/** Bridge-row face: load a vendored CJS package by its STAGED DIR (absolute
 * VFS spelling) regardless of the bare table. Used where an ESM row needs
 * the real package (ws) instead of a hand-written face. */
export const requireCjsPackage = (pkgDir) => loadPackageEntry(pkgDir, pkgDir);

/** Build a require function whose relative requests resolve from
 * `fromFile` (the CJS per-file require, and the createRequire face). Bare
 * requests go through BARE_PACKAGES and fail loud naming the specifier
 * when untabled — the same linkage-stub contract the bridge setup module
 * used to install, now backed by real resolution for the tabled names. */
export const makeRequire = (fromFile) => (request) => {
  if (typeof request !== 'string' || request.length === 0) {
    throw new TypeError(`cjs-loader: require needs a specifier, got ${String(request)}`);
  }
  if (request.startsWith('./') || request.startsWith('../') || request.startsWith('/')) {
    return resolveAndLoad(fromFile, request);
  }
  const bare = loadBare(request);
  if (bare !== undefined) return bare;
  // node-builtin faces (events/http/crypto/...): registered by the bridge
  // rows that need them for their package graph — before that registration
  // the face is simply absent and the failure names the specifier (rule 5).
  if (BUILTIN_FACES.has(request)) return BUILTIN_FACES.get(request);
  throw new Error(`require: ${request} is not served in this runtime — `
    + 'the CJS face has no ESM build and the specifier is not in the cjs-loader table (linkage stub)');
};

/** The table, for node-module.js routing and the bridge setup global. */
export const bareCjsPackages = BARE_PACKAGES;
