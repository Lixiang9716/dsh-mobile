// dsh:logging-exempt (node-side staging driver: console IS the product)
/**
 * roster.mjs — derive the APPLICATION-TIER client-bundle roster from the
 * upstream monorepo checkout (decision D9, W-SHELL leg).
 *
 * The official web app's browser roster is whatever the mounted host plugins
 * declare through `dsh.client` (platform: "web") in their package manifests:
 * the vendored `@deepseek-ai/dsh-client-modules` node half scans the Loader
 * entries for exactly those declarations and composes `window.__DSH_BOOT__`
 * from them. The shipped composition is the `@deepseek-ai/dsh-web-app` patch
 * layer (`packages/bundle/web-app/cordis.patch.yml`), so THIS script derives
 * the roster the same way the desktop ships it:
 *
 *   1. read every `- name: '<pkg>'` row of the web-app patch layer;
 *   2. keep the packages whose manifest declares `dsh.client.platform=web`;
 *   3. close over the declarations' `inject` + `external` fields (a bundle's
 *      externals must resolve to a graph row or a shell-static module, or
 *      materialization fails loud — the closure is therefore exact);
 *   4. subtract the shell-static modules the vite build shares through the
 *      seed table (`apps/web` → `getStaticModules()`; they are compiled into
 *      the entry chunk, never fetched).
 *
 * The bootstrap package (`@deepseek-ai/dsh-client-modules`) stays in the
 * roster: the graph's `bootstrap` phase is defined as exactly that id
 * (`PARSER_PRELOAD_IDS`), everything else lands in the `application` phase.
 *
 * usage: node roster.mjs <upstream-checkout> <out.json>
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const upstream = process.argv[2];
const out = process.argv[3];
if (!upstream || !out) {
  console.error('usage: node roster.mjs <upstream-checkout> <out.json>');
  process.exit(2);
}

/** The shell-static modules (apps/web seed.ts, the platform constant table):
 * shared into the frozen module table by the vite entry chunk, so they are
 * NOT graph rows and never fetched from /plugins. */
const SHELL_STATIC_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
];

/** Map every package name in the checkout to its directory (fail loud on a
 * duplicate name — a roster row must resolve to exactly one manifest). */
const pkgDirs = {};
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    const manifest = join(path, 'package.json');
    if (existsSync(manifest)) {
      const json = JSON.parse(readFileSync(manifest, 'utf8'));
      if (typeof json.name === 'string') pkgDirs[json.name] ??= path;
    }
    walk(path);
  }
};
walk(join(upstream, 'packages'));
walk(join(upstream, 'apps'));

/** The `dsh.client` declaration of one package, or undefined. */
const declarations = {};
const dshClient = (name) => {
  if (declarations[name] !== undefined) return declarations[name];
  const dir = pkgDirs[name] ?? subpathOwner(name);
  if (dir === undefined) throw new Error(`roster: package not found in the checkout: ${name}`);
  const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const client = json.dsh?.client;
  const decl = client?.platform === 'web'
    ? {
        inject: client.inject ?? [],
        external: client.external ?? [],
        immediately: client.immediately === true,
        clientExport: json.exports?.['./client'],
      }
    : undefined;
  declarations[name] = decl;
  return decl;
};

/** Patch rows may name a SUBPATH export of a package (`<pkg>/startup`, the
 * web-app startup service); such a row mounts inside the named package, so
 * the declaration to scan is the owning package's. Returns undefined when no
 * package name prefixes the specifier. */
const subpathOwner = (name) => {
  const candidates = Object.keys(pkgDirs).filter((pkg) => name.startsWith(`${pkg}/`));
  candidates.sort((a, b) => b.length - a.length);
  return candidates.length > 0 ? pkgDirs[candidates[0]] : undefined;
};

// 1. the web-app patch-layer rows.
const patch = readFileSync(
  join(upstream, 'packages', 'bundle', 'web-app', 'cordis.patch.yml'), 'utf8');
const rows = [...patch.matchAll(/- id: [\w./-]+\n\s+name: '([^']+)'/g)].map((m) => m[1]);
if (rows.length === 0) throw new Error('roster: no plugin rows parsed from the web-app patch layer');

// 2-3. filter to `dsh.client` packages and close over the declarations.
// An `external` may be a subpath specifier (`<pkg>/client`); upstream
// `stripClientSuffix` normalizes it onto the owning package's graph row, so
// the closure normalizes the same way.
const BOOTSTRAP_ID = '@deepseek-ai/dsh-client-modules';
const stripClientSuffix = (spec) => spec.endsWith('/client') ? spec.slice(0, -7) : spec;
const roster = new Set();
const queue = [...rows];
while (queue.length > 0) {
  const name = queue.pop();
  if (roster.has(name) || SHELL_STATIC_MODULES.includes(name)) continue;
  const decl = dshClient(name);
  if (decl === undefined) continue;
  roster.add(name);
  for (const dep of [...decl.inject, ...decl.external]) {
    const normalized = stripClientSuffix(dep);
    if (!roster.has(normalized)) queue.push(normalized);
  }
}

// 4. materialize the staged file list per package: the manifest + the
//    `exports["./client"]` bundle. Package-local chunk files (upstream
//    CLIENT_CHUNK shape `client.<name>.js`) are RECORDED but NOT staged:
//    they are off the boot path (lazy `require.async` inside their owner
//    bundle, triggered only by the terminal / document-preview panels) and
//    carry most of the bytes (pdf.js alone is ~7 MB). A fetch for an
//    unstaged chunk 404s — the same upstream stale-rev behavior — which is
//    the named gap, never a fake. The carrier's chunk route is implemented,
//    so staging a chunk later is a roster-list change, not code. Source maps
//    are excluded too (identity maps are served without them — the same
//    allowlist choice as the dist vendoring).
const entries = [...roster].sort().map((name) => {
  const dir = pkgDirs[name];
  const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const decl = dshClient(name);
  const clientRel = typeof decl.clientExport === 'string'
    ? decl.clientExport
    : decl.clientExport?.default;
  if (typeof clientRel !== 'string') {
    throw new Error(`roster: ${name} declares dsh.client but exports no "./client" bundle`);
  }
  const bundlePath = join(dir, clientRel.replace(/^\.\//, ''));
  const libDir = join(bundlePath, '..');
  const bundleRel = clientRel.replace(/^\.\//, '');
  const files = ['package.json', bundleRel];
  const chunks = [];
  for (const file of readdirSync(libDir)) {
    if (/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(file) && file !== 'client.js') {
      chunks.push(`${bundleRel.replace(/[^/]+$/, '')}${file}`);
    }
  }
  for (const file of files) {
    if (!existsSync(join(dir, file))) throw new Error(`roster: ${name} is missing ${file} (build the client face first)`);
  }
  return {
    name,
    version: json.version,
    dir,
    immediately: decl.immediately,
    inject: decl.inject,
    external: decl.external,
    files,
    chunks,
    bundle: bundlePath,
    bootstrap: name === BOOTSTRAP_ID,
  };
});

const payload = {
  generator: 'presentation/official-web/client-bundles/roster.mjs',
  source: 'packages/bundle/web-app/cordis.patch.yml dsh.client closure',
  shellStaticModules: SHELL_STATIC_MODULES,
  entries,
};
writeFileSync(out, JSON.stringify(payload, null, 2));
console.error(`roster: ${entries.length} packages (${entries.filter((e) => e.bootstrap).length} bootstrap, `
  + `${entries.reduce((n, e) => n + e.files.length, 0)} files) -> ${out}`);
