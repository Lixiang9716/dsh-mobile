// dsh:logging-exempt (node-side driver: console IS the product)
/**
 * compose-boot.mjs — compose the OFFICIAL web boot wire in Node.
 *
 * The dev carrier's boot payload is not hand-built: the VENDORED
 * `@deepseek-ai/dsh-client-modules` Node half (ClientModuleRegistry +
 * bootInjections) composes the same graph the mobile runtime composes
 * (runtime/spike/upstream/web-boot.js), over the same staged inputs
 * (presentation/official-web/client-bundles roster + the sha256-pinned
 * vendored bootstrap package). The mount below is web-boot.js's
 * `mountClientModules` decoration, ported for a real-filesystem host:
 * the QuickJS adapter stages a VFS because that runtime has no fs; Node
 * reads the committed trees directly, so the descriptors carry real
 * `file://` URLs and the registry's own readFileSync does the rest.
 *
 * The composed graph is cross-parsed through the VENDORED browser bundle
 * (materializeBootstrap in web-boot.js): the facade row's own script text
 * is evaluated, the client bundle registers on the queue facade, and its
 * exported parseBootManifest validates the graph the page will receive —
 * a graph the vendored parser rejects is never served.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, symlinkSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const VENDOR_NPM = 'runtime/spike/vendor/npm';
const BUNDLES_NPM = 'presentation/official-web/client-bundles/npm/@deepseek-ai';
const BOOTSTRAP_NAME = '@deepseek-ai/dsh-client-modules';

/** Fail loud with the materialization pointer when a tree is absent (rule 5). */
const demandTree = (repoRoot, rel, how) => {
  if (!existsSync(join(repoRoot, rel))) {
    throw new Error(`dev-web-carrier: ${rel} is not materialized — run ${how}`);
  }
};

/** One staged plugin descriptor over a real package directory. */
const descriptor = (repoRoot, pkgDir) => {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const entry = join(pkgDir, 'lib', 'client.js');
  if (!existsSync(entry)) throw new Error(`dev-web-carrier: ${pkg.name} has no lib/client.js`);
  return {
    loaderName: pkg.name,
    baseUrl: pathToFileURL(pkgDir).href + '/',
    pkgJsonPath: join(pkgDir, 'package.json'),
    entryFileURL: pathToFileURL(entry).href,
  };
};

/** The staged plugin set in delivery order: the client-bundles roster
 * (`<name>@<version>` sorted), with the bootstrap package taken from the
 * sha256-pinned vendored tree (web-plugins-payload.mjs's staging rule). */
export const stagedDescriptors = (repoRoot) => {
  demandTree(repoRoot, BUNDLES_NPM, 'tools/e2e/ensure-client-bundles.sh');
  demandTree(repoRoot, 'presentation/official-web/dist', 'test/e2e/ensure-official-dist.sh');
  const scope = join(repoRoot, BUNDLES_NPM);
  const names = readdirSync(scope, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  if (names.length === 0) throw new Error('dev-web-carrier: empty client-bundles roster');
  return names.map((dirName) => {
    if (dirName === `${BOOTSTRAP_NAME.split('/')[1]}@0.1.6-alpha.2`) {
      return descriptor(repoRoot, join(repoRoot, VENDOR_NPM, `${BOOTSTRAP_NAME}@0.1.6-alpha.2`));
    }
    return descriptor(repoRoot, join(scope, dirName));
  });
};

/** Build the Node resolution scope for the composer's bare imports: one
 * `node_modules/<declared-name>` symlink per vendored package. Regenerated
 * idempotently (the staging dir is derived state under tmp/). */
export const buildResolutionScope = (stageDir, repoRoot) => {
  const nm = join(stageDir, 'node_modules');
  rmSync(nm, { recursive: true, force: true });
  mkdirSync(nm, { recursive: true });
  const link = (pkgDir) => {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    const at = join(nm, ...pkg.name.split('/'));
    mkdirSync(dirname(at), { recursive: true });
    symlinkSync(pkgDir, at, 'dir');
  };
  for (const entry of readdirSync(join(repoRoot, VENDOR_NPM), { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('@')) link(join(repoRoot, VENDOR_NPM, entry.name));
  }
  for (const entry of readdirSync(join(repoRoot, VENDOR_NPM, '@deepseek-ai'), { withFileTypes: true })) {
    link(join(repoRoot, VENDOR_NPM, '@deepseek-ai', entry.name));
  }
  return nm;
};

/** The generated in-scope import facade. The composer's bare imports must
 * resolve through the staging scope, so the importing file lives there. */
const writeStageEntry = (stageDir) => {
  const text = [
    "export { Context } from '@deepseek-ai/cordis';",
    "export { Loader } from '@deepseek-ai/cordis-plugin-loader';",
    "export { ClientModuleRegistry, bootInjections } from '@deepseek-ai/dsh-client-modules';",
    '',
  ].join('\n');
  writeFileSync(join(stageDir, 'stage-entry.mjs'), text);
  return join(stageDir, 'stage-entry.mjs');
};

/** The generated resolver hook: Node resolves bare specifiers against the
 * IMPORTING file's realpath — the vendored trees, whose ancestor chain
 * carries no node_modules — so every bare specifier is re-anchored to the
 * staging scope. The hook fires per import hop, which is what makes the
 * symlink tree hold together however Node realpaths the modules. */
const writeStageResolver = (stageDir) => {
  const anchor = pathToFileURL(join(stageDir, 'stage-entry.mjs')).href;
  const text = [
    `const ANCHOR = ${JSON.stringify(anchor)};`,
    'export async function resolve(specifier, context, nextResolve) {',
    "  if (specifier.startsWith('node:') || specifier.startsWith('.') || specifier.startsWith('/')) {",
    '    return nextResolve(specifier, context);',
    '  }',
    '  return nextResolve(specifier, { ...context, parentURL: ANCHOR });',
    '}',
    '',
  ].join('\n');
  const file = join(stageDir, 'stage-resolver.mjs');
  writeFileSync(file, text);
  return file;
};

/** Evaluate the facade row's queue script under a minimal window shim, so
 * the vendored browser bundle can register and be materialized (web-boot.js
 * materializeBootstrap). */
const evalFacade = (scriptText) => {
  globalThis.window ??= {};
  const consoleWas = globalThis.window.console;
  globalThis.window.console ??= console;
  try {
    (0, eval)(scriptText);
  } finally {
    if (consoleWas === undefined) delete globalThis.window.console;
  }
};

/** Splice the bootstrap registration off the queue facade and run its
 * factory — the exported parseBootManifest is the wire validator. */
const materializeBootstrap = (clientBundle) => {
  const queue = globalThis.window.__ModuleLoader__.pendingQueue;
  const index = queue.findIndex((r) => r.id === BOOTSTRAP_NAME);
  if (index < 0) throw new Error('dev-web-carrier: vendored client bundle never registered on the facade');
  const [registration] = queue.splice(index, 1);
  return registration.factory(() => {
    throw new Error('dev-web-carrier: client.js requested an external before the module system existed');
  });
};

/** web-boot.js serializeRows: global row values ride as JSON text (the
 * vendored composer already encodes objects; either way the carrier
 * splices the text raw), `<`-escaped exactly like the upstream index
 * renderer. */
export const serializeRows = (rows) => rows.map((row) => {
  if (row.kind === 'global') {
    const raw = typeof row.value === 'string' ? row.value : JSON.stringify(row.value);
    return { kind: 'global', name: row.name, value: raw.replaceAll('<', '\\u003c') };
  }
  return { ...row };
});

/**
 * The `mountClientModules` port (web-boot.js): the loader decoration over
 * the staged descriptors, then the vendored registry's own graph. The
 * vendored constructor pair arrives as `vendored` (resolved through the
 * staging scope). Returns { registry, graph, rows }.
 */
const mountClientModules = (ctx, plugins, vendored) => {
  const byLoader = new Map(plugins.map((p) => [p.loaderName, p]));
  const loader = new vendored.Loader(ctx, { baseUrl: plugins[0].baseUrl });
  if (loader.internal !== undefined) {
    throw new Error('dev-web-carrier: the loader service already carries an internal resolver');
  }
  loader.internal = {
    version: 'v1',
    resolveSync: (specifier) => {
      const plugin = byLoader.get(specifier);
      if (plugin === undefined) throw new Error(`dev-web-carrier: resolveSync cannot map '${specifier}'`);
      return { url: plugin.entryFileURL };
    },
    import: (specifier) => {
      throw new Error(`dev-web-carrier: the staged resolver does not import modules ('${specifier}')`);
    },
  };
  const baseEntries = loader.entries.bind(loader);
  loader.entries = function* decoratedEntries() {
    yield* baseEntries();
    yield* plugins.map((p) => ({
      options: { name: p.loaderName },
      fiber: {},
      disabled: false,
      parent: { tree: { ctx: { baseUrl: p.baseUrl } } },
    }));
  };
  const registry = new vendored.ClientModuleRegistry(ctx);
  const graph = registry.graph();
  return { registry, graph, rows: serializeRows(vendored.bootInjections(graph)) };
};

/**
 * Compose the boot wire over the committed trees. Returns
 * { rows, graph, plugins, bundles, entryCount, batchCount } — rows are the
 * serialized index-injection rows (facade script, batch preloads, the
 * `__DSH_BOOT__` graph global), plugins the {id, rev, url} rows the
 * /plugins route adopts revs from, bundles the staged {id, file} list.
 */
export const composeBootWire = async ({ repoRoot, stageDir }) => {
  demandTree(repoRoot, VENDOR_NPM, 'runtime/spike/vendor/ensure-dsh.sh');
  mkdirSync(stageDir, { recursive: true });
  buildResolutionScope(stageDir, repoRoot);
  const entry = writeStageEntry(stageDir);
  const { register } = await import('node:module');
  await register(pathToFileURL(writeStageResolver(stageDir)).href, { parentURL: import.meta.url });
  const vendored = await import(pathToFileURL(entry).href);

  const plugins = stagedDescriptors(repoRoot);
  const ctx = new vendored.Context();
  const { graph, rows } = mountClientModules(ctx, plugins, vendored);

  // The page's boot order: facade row evaluates FIRST, the browser bundle
  // registers on its queue, then create() splices it. The cross-parse walks
  // the same path in Node — the row's own text, then the vendored bundle.
  const facadeRow = rows.find((row) => row.kind === 'script');
  if (facadeRow === undefined) throw new Error('dev-web-carrier: composed rows carry no facade script');
  evalFacade(facadeRow.text);
  const bootstrapDescriptor = plugins.find((p) => p.loaderName === BOOTSTRAP_NAME);
  const clientBundle = await import(bootstrapDescriptor.entryFileURL);
  const bootstrapExports = materializeBootstrap(clientBundle);
  bootstrapExports.parseBootManifest(graph); // loud on any wire violation

  const graphGlobal = rows.find((row) => row.kind === 'global' && row.name === '__DSH_BOOT__');
  if (graphGlobal === undefined) throw new Error('dev-web-carrier: composed rows carry no __DSH_BOOT__ global');
  const batches = JSON.parse(graphGlobal.value).batches ?? [];
  return {
    rows,
    graph,
    plugins: graph.entries.map((e) => ({ id: e.id, rev: e.rev, url: e.url })),
    bundles: plugins.map((p) => ({ id: p.loaderName, file: join(dirname(p.pkgJsonPath), 'lib', 'client.js') })),
    entryCount: graph.entries.length,
    batchCount: batches.length,
    preloadURLs: batches.map((b) => b.url),
  };
};

/** sha1 content hash shortened to 12 hex (upstream shortHash). */
export const shortHash = (input) =>
  createHash('sha1').update(input).digest('hex').slice(0, 12).toLowerCase();
