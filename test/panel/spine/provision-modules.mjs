// dsh:logging-exempt (test provisioning script: console IS the product)
/**
 * provision-modules.mjs — the spine suite's node_modules farm.
 *
 * The spine tests boot the REAL runtime (runtime/dsh/upstream/boot.js) under
 * plain Node. On the device the dsh host resolves every bare specifier
 * through its own loader map (vendor/dsh faces, the runtime root for
 * `upstream/…`/`logger.js`/`gateway.js`); Node has no import map, so the
 * suite stages one node_modules farm at runtime/dsh/node_modules (already
 * gitignored) that mirrors that map:
 *
 *   @deepseek-ai/<pkg>  → vendor/dsh/<pkg>@0.1.6-alpha.2   (the vendored
 *                          closure, verbatim, resolved through each
 *                          package's own package.json)
 *   <npm name>          → vendor/npm/<name>@<version>       (the pinned npm
 *                          rows; duplicate versions resolve to the HIGHEST
 *                          — the closure's own newest pin)
 *   upstream / web-live / system-plugins
 *                       → the runtime's own directories (the loader's
 *                          dsh-root-relative spellings)
 *   logger.js / gateway.js
 *                       → package stubs whose index re-exports the runtime
 *                          root's real module (a re-export, never a copy —
 *                          the farm cannot drift)
 *
 * Idempotent: existing links are verified and refreshed only on mismatch.
 * usage: node provision-modules.mjs     exit 0 = the farm is ready
 */
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runtimeDsh = join(here, '..', '..', '..', 'runtime', 'dsh');
const vendorDsh = join(runtimeDsh, 'vendor', 'dsh');
const vendorNpm = join(runtimeDsh, 'vendor', 'npm');
const modules = join(runtimeDsh, 'node_modules');

/** `[major, minor, patch]` of a `<name>@<version>` directory name. */
const versionOf = (dirName) => {
  const at = dirName.lastIndexOf('@');
  return (at <= 0 ? '0' : dirName.slice(at + 1))
    .split('.').map((part) => parseInt(part, 10) || 0);
};

const compareVersions = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
};

/** One farm row: link `modules/<name>` → target. Refreshed on mismatch. */
const link = (name, target) => {
  const at = join(modules, name);
  mkdirSync(dirname(at), { recursive: true });
  // lstat, never existsSync: a junction whose target is missing still
  // occupies the name (existsSync FOLLOWS the target and answers false —
  // the stale row then survives and symlinkSync dies EEXIST).
  let st;
  try { st = lstatSync(at); } catch { st = undefined; }
  if (st !== undefined) {
    let current;
    try { current = readlinkSync(at); } catch { current = undefined; }
    if (current === target) return false;
    rmSync(at, { recursive: true, force: true });
  }
  // 'junction' needs no developer mode on Windows; dir symlinks elsewhere.
  symlinkSync(target, at, 'junction');
  return true;
};

const writeIfChanged = (at, text) => {
  if (existsSync(at)) {
    try {
      if (readFileSync(at, 'utf8') === text) return;
    } catch { /* rewrite */ }
  }
  writeFileSync(at, text);
};

/** A file:// URL for an exports-map entry (absolute, forward slashes). */
const fileUrl = (path) => `file://${path.replace(/\\/g, '/')}`;

/** One package stub whose index re-exports a runtime-root module. */
const stub = (name, relative) => {
  const dir = join(modules, name);
  mkdirSync(dir, { recursive: true });
  writeIfChanged(join(dir, 'package.json'),
    `{"name":"${name}","private":true,"type":"module","main":"index.js"}\n`);
  writeIfChanged(join(dir, 'index.js'), `export * from '${relative}';\n`);
};

/** The vendored dsh closure rows. The link name comes from each package's
 * OWN package.json "name" (the vendored directory drops the `dsh-` prefix:
 * llm@0.1.6-alpha.2 IS @deepseek-ai/dsh-llm), so the farm can never disagree
 * with the closure it links. Absolute targets: a Windows junction resolves a
 * relative target against the LINK'S OWN directory, so `..`-spelled rows
 * land one level short (measured: the scoped links pointed at
 * node_modules/vendor/…). The farm is regenerated per machine, so absolute
 * is the honest shape. */
const linkDshClosure = () => {
  let links = 0;
  for (const entry of readdirSync(vendorDsh, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = JSON.parse(readFileSync(
      join(vendorDsh, entry.name, 'package.json'), 'utf8'));
    if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
      throw new Error(`provision-modules: vendored package without a name: ${entry.name}`);
    }
    if (link(manifest.name, join(vendorDsh, entry.name))) links += 1;
  }
  return links;
};

/** The pinned npm rows (scoped + plain), highest version on duplicates. */
const linkNpmRows = () => {
  const npmBest = new Map();
  const consider = (pkg, target, dirName) => {
    const prev = npmBest.get(pkg);
    if (prev === undefined || compareVersions(versionOf(dirName), versionOf(prev.dirName)) > 0) {
      npmBest.set(pkg, { target, dirName });
    }
  };
  for (const entry of readdirSync(vendorNpm, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('@')) {
      // entry.name already carries its own '@' — composing another would
      // mint `@@scope/pkg` rows (measured: the whole scoped tier linked
      // under that doubled name and every scoped import missed).
      for (const nested of readdirSync(join(vendorNpm, entry.name), { withFileTypes: true })) {
        if (!nested.isDirectory()) continue;
        consider(`${entry.name}/${nested.name.replace(/@[^@]+$/, '')}`,
          join(vendorNpm, entry.name, nested.name), nested.name);
      }
      continue;
    }
    consider(entry.name.replace(/@[^@]+$/, ''),
      join(vendorNpm, entry.name), entry.name);
  }
  let links = 0;
  for (const [pkg, row] of npmBest) {
    if (link(pkg, row.target)) links += 1;
  }
  return { links, npmBest };
};

/** The loader's dsh-root-relative spellings + the fork-scoped ALIAS rows
 * (dsh_runtime_host.c dsh_map_bare): fork-scoped names whose vendored trees
 * ride under their PLAIN npm names. Without these rows every
 * `@deepseek-ai/cordis` import in the closure misses (the vendored dir is
 * `cordis@4.0.2`, not `@deepseek-ai/cordis@…`). */
const linkRuntimeFaces = (npmBest) => {
  let links = 0;
  for (const dir of ['upstream', 'web-live', 'system-plugins']) {
    if (link(dir, join(runtimeDsh, dir))) links += 1;
  }
  const ALIASES = {
    '@deepseek-ai/cordis': join(vendorNpm, 'cordis@4.0.2'),
    '@deepseek-ai/cosmokit': join(vendorNpm, 'cosmokit@1.8.3'),
    '@deepseek-ai/schemastery': join(vendorNpm, 'schemastery@3.18.2'),
  };
  for (const [name, target] of Object.entries(ALIASES)) {
    if (link(name, target)) links += 1;
  }
  // node-addon-system: the '.' face is the vendored npm package, but the
  // '/flock' subpath must be the RUNTIME SHIM (the host maps it there —
  // the vendored flock binding is a quickjs native addon Node cannot load).
  // A real directory with an exports map beats a junction here.
  const flockPkg = join(modules, '@deepseek-ai', 'node-addon-system');
  rmSync(flockPkg, { recursive: true, force: true });
  mkdirSync(flockPkg, { recursive: true });
  writeIfChanged(join(flockPkg, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/node-addon-system',
    private: true,
    type: 'module',
    exports: {
      '.': fileUrl(join(vendorNpm,
        `node-addon-system@${npmBest.get('node-addon-system')?.dirName ?? '0.0.0'}`)),
      './flock': fileUrl(join(runtimeDsh, 'upstream', 'shims', 'node-addon-system-flock.js')),
    },
  }, null, 2) + '\n');
  return links;
};

const setup = () => {
  if (!existsSync(vendorDsh)) {
    throw new Error(
      `provision-modules: the vendored closure is missing (${vendorDsh}) — `
      + 'run runtime/dsh/vendor/ensure-dsh.sh first');
  }
  mkdirSync(modules, { recursive: true });

  // Re-export stubs for the runtime root's own module spellings (the
  // relative path from <modules>/<name>/index.js to the runtime root) —
  // every bare `<name>.js` import the runtime sources use at the dsh root
  // (the host's bare map owns them on device).
  stub('logger.js', '../../logger.js');
  stub('gateway.js', '../../gateway.js');
  stub('canonical-json.js', '../../canonical-json.js');
  stub('config-layer.js', '../../config-layer.js');
  stub('ed25519.js', '../../ed25519.js');
  stub('freshness-store.js', '../../freshness-store.js');
  stub('install-fetch.js', '../../install-fetch.js');
  stub('install-pipeline.js', '../../install-pipeline.js');
  stub('llm.js', '../../llm.js');
  stub('marketplace-resolver.js', '../../marketplace-resolver.js');
  stub('marketplace.js', '../../marketplace.js');
  stub('plugin-mount.js', '../../plugin-mount.js');
  stub('receipt-journal.js', '../../receipt-journal.js');
  stub('registry.js', '../../registry.js');
  stub('semver-range.js', '../../semver-range.js');
  stub('sha256.js', '../../sha256.js');
  stub('surface.js', '../../surface.js');
  stub('tar-mini.js', '../../tar-mini.js');
  stub('workspace-registry.js', '../../workspace-registry.js');

  let links = linkDshClosure();
  const npm = linkNpmRows();
  links += npm.links;
  links += linkRuntimeFaces(npm.npmBest);
  console.log(`provision-modules: farm ready at ${modules} (${links} links refreshed)`);
};

setup();
