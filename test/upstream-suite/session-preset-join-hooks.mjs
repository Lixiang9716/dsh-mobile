// dsh:logging-exempt (test loader: no logging surface of its own)
/**
 * session-preset-join-hooks.mjs — the module-resolution hooks that let the
 * session-preset-join driver (session-preset-join.mjs) boot the REAL mobile
 * spine under plain Node: our upstream layer resolves its bundle-root
 * specifiers and the fs/timer shims exactly like the quickjs host's bare map
 * serves them, the vendored closure resolves through the parity node_modules
 * layout (ci/parity-node-modules.sh) with REAL node builtins (the same shape
 * the raw upstream-suite vitest face runs), and the two C-host seams the
 * boot graph touches are substituted Node-side — httpFetch over real fetch
 * (the parity-node-gateway contract) and the staged-VFS file<->path spelling
 * (session-preset-join-url-vfs.mjs).
 *
 * Resolution order (mirrors the host's own bare-map precedence):
 *   1. runtime-defined modules (the __dshModuleDefine registry — npm-bridges
 *      rows land here; served from test/upstream-suite/.runtime-modules,
 *      the smoke.mjs mechanism)
 *   2. bundle-root spellings ('/x', 'upstream/*', 'scenario/*',
 *      'system-plugins/*', bare root files like 'logger.js')
 *   3. dsh:util-crypto (the legacy virtual specifier)
 *   4. node:* — shims for OUR layer, REAL for vendored code (but node:url,
 *      which needs the /vendor/-aware adapter), REAL for the driver
 *   5. bare packages — runtime/dsh/vendor/node_modules (subpath-aware)
 * plus a load hook that evaluates vendored esbuild-CJS faces against the
 * bridge scope's globalThis.exports/module (the host loader's CJS eval
 * semantics; without it the turndown-plugin-gfm bridge reads an empty face).
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve as pathResolve, dirname } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = pathResolve(HERE, '../..');
const SPIKE = pathResolve(ROOT, 'runtime/dsh');
const NM = pathResolve(SPIKE, 'vendor/node_modules');
const SHIMS = pathResolve(SPIKE, 'upstream/shims');
const REG_DIR = pathResolve(HERE, '.runtime-modules');

const regFile = (name) => {
  const f = pathResolve(REG_DIR, encodeURIComponent(name) + '.mjs');
  return existsSync(f) ? f : undefined;
};

const pickExport = (pkgDir, v) => {
  if (typeof v === 'string') return pathResolve(pkgDir, v.replace(/^\.\//, ''));
  if (v && typeof v === 'object' && typeof v.default === 'string') {
    return pathResolve(pkgDir, v.default.replace(/^\.\//, ''));
  }
  return undefined;
};

const entryOf = (pkgDir) => {
  const pj = pathResolve(pkgDir, 'package.json');
  if (existsSync(pj)) {
    try {
      const m = JSON.parse(readFileSync(pj, 'utf8'));
      if (typeof m.exports === 'string') {
        const hit = pickExport(pkgDir, m.exports);
        if (hit && existsSync(hit)) return hit;
      }
      if (m.exports && typeof m.exports === 'object' && m.exports['.']) {
        const hit = pickExport(pkgDir, m.exports['.']);
        if (hit && existsSync(hit)) return hit;
      }
      for (const key of ['module', 'main']) {
        if (typeof m[key] === 'string') {
          const hit = pathResolve(pkgDir, m[key]);
          if (existsSync(hit)) return hit;
        }
      }
    } catch { /* fall through to the index.js default */ }
  }
  return pathResolve(pkgDir, 'index.js');
};

// node builtin -> shim file name (the bare-map shim rows our layer needs;
// vendored code resolves every builtin but node:url REAL instead).
const NODE_SHIMS = {
  'node:path': 'path.js', 'node:crypto': 'crypto.js', 'node:async_hooks': 'async-hooks.js',
  'node:util': 'util.js', 'node:util/types': 'util-types.js', 'node:fs': 'fs.js',
  'node:fs/promises': 'fs-promises.js', 'node:timers/promises': 'timers-promises.js',
  'node:buffer': 'buffer.js', 'node:os': 'os.js', 'node:process': 'process.js',
  'node:module': 'node-module.js', 'node:url': 'url.js', 'node:perf_hooks': 'node-perf-hooks.js',
  'node:zlib': 'node-zlib.js', 'node:worker_threads': 'node-worker-threads.js',
  'node:stream': 'node-stream.js', 'node:events': 'events.js', 'node:sqlite': 'node-sqlite.js',
};

const resolveBare = (specifier) => {
  const parts = specifier.split('/');
  const pkgName = specifier[0] === '@' ? parts.slice(0, 2).join('/') : parts[0];
  const subpath = specifier.slice(pkgName.length).replace(/^\//, '');
  const pkgDir = pathResolve(NM, pkgName);
  if (!existsSync(pkgDir)) return undefined;
  if (subpath === '') {
    const entry = entryOf(pkgDir);
    return existsSync(entry) ? entry : undefined;
  }
  const pj = pathResolve(pkgDir, 'package.json');
  if (existsSync(pj)) {
    try {
      const m = JSON.parse(readFileSync(pj, 'utf8'));
      if (m.exports && typeof m.exports === 'object' && !Array.isArray(m.exports)
        && m.exports[`./${subpath}`] !== undefined) {
        const hit = pickExport(pkgDir, m.exports[`./${subpath}`]);
        if (hit && existsSync(hit)) return hit;
      }
    } catch { /* fall through to the path candidates */ }
  }
  for (const cand of [
    pathResolve(pkgDir, subpath),
    pathResolve(pkgDir, 'lib', subpath),
    pathResolve(pkgDir, 'src', subpath),
    pathResolve(pkgDir, 'dist', subpath),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return undefined;
};

/** The node:* branch (split from resolve at the function-size gate):
 * registry-served modules and our runtime/dsh layer resolve their builtins
 * through the shims (the bare map's rows), the shim file ITSELF falls
 * through to real node (its self-references are the real builtin), vendored
 * code resolves everything REAL but node:url (the /vendor/-aware adapter),
 * and any importer outside runtime/dsh (the driver) gets real node. */
const resolveNodeBuiltin = (specifier, parent, context, nextResolve) => {
  const regPrefix = pathToFileURL(REG_DIR).href + '/';
  const inRegistry = parent.startsWith(regPrefix);
  const inRuntime = parent.includes('/runtime/dsh/');
  if (!inRegistry && !inRuntime) return nextResolve(specifier, context);
  const inVendor = parent.includes('/runtime/dsh/vendor/');
  if (inVendor && specifier !== 'node:url') return nextResolve(specifier, context);
  if (inVendor) {
    return { url: pathToFileURL(pathResolve(HERE, 'session-preset-join-url-vfs.mjs')).href, shortCircuit: true };
  }
  const shim = NODE_SHIMS[specifier];
  if (shim !== undefined) {
    const shimURL = pathToFileURL(pathResolve(SHIMS, shim)).href;
    if (parent !== shimURL) return { url: shimURL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
};

export async function resolve(specifier, context, nextResolve) {
  const parent = typeof context.parentURL === 'string' ? context.parentURL : '';
  // 1. runtime-defined modules (the __dshModuleDefine registry files)
  const registered = regFile(specifier);
  if (registered !== undefined) {
    return { url: pathToFileURL(registered).href, shortCircuit: true };
  }
  // 2. bundle-root spellings ('/x' IS the runtime/dsh root)
  if (specifier.startsWith('/') && !specifier.startsWith('//')) {
    return { url: pathToFileURL(pathResolve(SPIKE, specifier.slice(1))).href, shortCircuit: true };
  }
  if (/^(upstream|scenario|system-plugins|vendor)\//.test(specifier)
    || /^[a-z][a-z0-9-]*\.js$/.test(specifier)) {
    return { url: pathToFileURL(pathResolve(SPIKE, specifier)).href, shortCircuit: true };
  }
  // 3. the legacy dsh: virtual specifier
  if (specifier.startsWith('dsh:')) {
    if (specifier === 'dsh:util-crypto') {
      const hit = pathResolve(SPIKE, 'vendor/dsh/util-crypto@0.1.6-alpha.2/lib/index.js');
      if (existsSync(hit)) {
        return { url: pathToFileURL(hit).href, shortCircuit: true };
      }
    }
    throw new Error(`session-preset-join hooks: no mapping for '${specifier}'`);
  }
  // 4. node:* — shims for OUR layer and registry-served modules; REAL for
  //    vendored code (node:url gets the /vendor/-aware adapter) and the
  //    driver; the shim file ITSELF falls through to real node.
  if (specifier.startsWith('node:')) {
    return resolveNodeBuiltin(specifier, parent, context, nextResolve);
  }
  // 5. gateway.js from our upstream layer: the node gateway (real-fetch
  //    httpFetch over the shim's other exports).
  if (specifier.startsWith('.') && parent.includes('/runtime/dsh/upstream/')
    && specifier.endsWith('gateway.js')) {
    return { url: pathToFileURL(pathResolve(HERE, 'session-preset-join-gateway-node.mjs')).href, shortCircuit: true };
  }
  // 6. bare packages -> vendor/node_modules (subpath-aware)
  if (!/^(node:|\.|\/|file:|data:)/.test(specifier)) {
    const hit = resolveBare(specifier);
    if (hit !== undefined) return { url: pathToFileURL(hit).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

// The vendored esbuild-CJS faces (the `.cjs.js` vendor files npm-bridges
// imports) evaluate against the bridge scope's globalThis.exports/module —
// the host loader's CJS eval semantics. Prepending the two bindings makes
// the free `exports` identifier write the object the bridge then reads.
export async function load(url, context, nextLoad) {
  const marker = '/runtime/dsh/vendor/';
  if (url.includes(marker) && url.endsWith('.cjs.js')) {
    const file = fileURLToPath(url);
    let source = readFileSync(file, 'utf8');
    if (/\b(exports|module)\b/.test(source.slice(0, 400))) {
      const prelude = 'var exports = globalThis.exports; var module = globalThis.module;\n'
        + 'if (exports === undefined) { throw new Error("cjs face loaded outside a bridge scope"); }\n';
      source = prelude + source + '\nexport default globalThis.exports;\n';
      return { format: 'module', source, shortCircuit: true };
    }
  }
  return nextLoad(url, context, nextLoad);
}
