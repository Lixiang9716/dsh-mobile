// dsh-loader-hooks.mjs — the spine suite's Node loader bridge for the host
// loader's maps (the resolve/load half; the __dshModuleDefine seam's WRITE
// half lives on the main thread — register()'s bootstrap runs in the loader
// worker, whose globals the spec code never sees, so the definitions cross
// threads through the .runtime-modules directory, the smoke.mjs precedent).
//
// On the device the dsh host's module loader resolves:
//   - `dsh:util-crypto` onto the vendored @deepseek-ai/dsh-util-crypto
//     package (the only `dsh:` scheme spelling our runtime sources use);
//   - '/…' dsh-root-relative specifiers ('/vendor/…' in the npm-bridges
//     shims, '/upstream/…' in runtime-modules.js — '/' IS the dsh root);
//   - `node:buffer` onto a face that ALSO carries encodeUtf8/decodeUtf8
//     (llm-route.js, preset-mobile-rows.js, web-write-llm.js) — plain
//     Node's node:buffer lacks both helpers;
//   - __dshModuleDefine-registered names (npm-bridges rows) before the bare
//     map — same replay semantics as the host C seam (a second define for a
//     name replaces the source).
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, resolve as pathResolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

// Anchored at THIS FILE, never process.cwd() — the suite runs from whatever
// cwd the runner hands it.
const HERE = pathResolve(fileURLToPath(import.meta.url), '..');
const runtimeDsh = pathResolve(HERE, '..', '..', '..', 'runtime', 'dsh');
const runtimeRoot = pathToFileURL(pathResolve(runtimeDsh, '..')).href;
const shim = (name) => pathToFileURL(join(runtimeDsh, 'upstream', 'shims', name)).href;
const bufferShimUrl = pathToFileURL(join(HERE, 'node-buffer-shim.mjs')).href;
// The __dshModuleDefine drop dir (written on the main thread by the test's
// seam install, read here in the loader worker). Under runtime/dsh/
// node_modules so the bridge sources' bare 'upstream/…' imports resolve
// through the farm.
const defineDir = join(runtimeDsh, 'node_modules', '.spine-defines');
const DEFINE_SCHEME = 'dsh-define://';

const defineFile = (name) => join(defineDir, `${encodeURIComponent(name)}.mjs`);

const dshSchemeTarget = (specifier) => specifier === 'dsh:util-crypto'
  ? join(runtimeDsh, 'vendor', 'dsh', 'util-crypto@0.1.6-alpha.2', 'lib', 'index.js')
  : undefined;

export async function resolve(specifier, context, nextResolve) {
  // Runtime/vendor importers get the DEVICE node: faces: the host loader
  // maps node:buffer (with the UTF-8 helpers) and node:fs[/promises] (the
  // seeded VFS + workspace overlay, shims/fs.js family) onto the shims —
  // plain Node's real disk is NOT the device shape (the vendored
  // agent-presets discovery, fs-local's world, and the preset seed all read
  // the staged views through these faces). The shim's own imports of these
  // specifiers must stay real (a self-cycle).
  const importerUnderRuntime = typeof context.parentURL === 'string'
    && context.parentURL.startsWith(runtimeRoot);
  if (importerUnderRuntime) {
    if (specifier === 'node:buffer') return { url: bufferShimUrl, shortCircuit: true };
    if (specifier === 'node:fs') return { url: shim('fs.js'), shortCircuit: true };
    if (specifier === 'node:fs/promises') return { url: shim('fs-promises.js'), shortCircuit: true };
    // The device's fileURLToPath keeps the dsh-root POSIX spelling (the
    // vendored agent-presets discovery resolves its shipped presets root
    // through it — a Windows disk path would leave every shim's world).
    if (specifier === 'node:url') return { url: shim('url.js'), shortCircuit: true };
  }
  const schemeTarget = dshSchemeTarget(specifier);
  if (schemeTarget !== undefined) {
    return { url: pathToFileURL(schemeTarget).href, shortCircuit: true };
  }
  // __dshModuleDefine registrations (the checked seam before the bare map):
  // the main thread wrote <enc(name)>.mjs into the drop dir — a real file,
  // so its own file: URL serves it (no virtual scheme: Node's package scope
  // walk rejects non-file URLs without a path).
  const definePath = defineFile(specifier);
  if (existsSync(definePath)) {
    return { url: pathToFileURL(definePath).href, shortCircuit: true };
  }
  // The loader's dsh-root-relative spellings ('/vendor/…' in the npm-bridges
  // shims, '/upstream/…' in runtime-modules.js — '/' IS the dsh root on
  // device, dsh_runtime_host.c dsh_map_bare).
  if (specifier.startsWith('/')) {
    return {
      url: pathToFileURL(join(runtimeDsh, specifier.slice(1))).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  // Vendored CJS files under /vendor: the device loader evaluates them as
  // global scripts (bare `exports` resolves through the globalThis.exports
  // the bridge setup pre-plants — the turndown-plugin-gfm bridge's shape).
  // Plain Node would parse them as ESM/CJS and lose that. Same semantics,
  // one wrapper: indirect eval in the caller's global scope.
  const vendorPrefix = pathToFileURL(join(runtimeDsh, 'vendor')).href;
  if (url.startsWith(`${vendorPrefix}/`)
    && (url.endsWith('.cjs.js') || url.endsWith('.cjs'))) {
    const { fileURLToPath } = await import('node:url');
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(fileURLToPath(url), 'utf8');
    const source = [
      `const __dshVendorCjsSource = ${JSON.stringify(text)};`,
      '(0, eval)(__dshVendorCjsSource);',
    ].join('\n');
    return { format: 'module', source, shortCircuit: true };
  }
  return nextLoad(url, context);
}
