#!/usr/bin/env node
// dsh:logging-exempt (build tool: its stdout is the manifest)
/**
 * transpile.mjs — the Node-side prepass of the on-emulator upstream suite:
 * each upstream spec becomes plain ESM executable by our quickjs host —
 * package imports left BARE (the host loader serves them from the vendored
 * closure), local fixtures bundled in, and the `vitest` import rewritten to
 * the quickjs-side harness (scenario/upstream-test-harness.js).
 *
 * Specs whose vitest API exceeds the harness subset (vi.mock, fake timers,
 * expect.extend) are EXCLUDED with a named reason and a count — never
 * silently dropped (a green suite that skipped in the dark would fake the
 * compatibility proof). The UNIMPLEMENTED scan runs on the SPEC SOURCE and
 * again on the BUILT OUTPUT: esbuild bundles local test helpers, whose
 * imports never appear in the spec's own text (the session-snapshot suite's
 * vi.waitFor hid inside a helper for a whole round).
 *
 * usage: node transpile.mjs   (writes runtime/spike/upstream-tests/ + manifest.json)
 */
import esbuild from 'esbuild';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, realpathSync, unlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const TESTS = join(ROOT, 'runtime/spike/vendor/dsh-tests@dsh-v0.1.6-alpha.2/packages');
const OUT = join(ROOT, 'runtime/spike/upstream-tests');
const HARNESS_SPECIFIER = 'scenario/upstream-test-harness.js';
// The path-rewrite machinery lives in transpile-rewrites.js (the file
// crossed the size budget; these faces are pure source->source transforms).
import { BARE_EXTERNAL_PLUGIN, SUBMODULE_BARE_RESOLVES, hoistCreateRequireJson, hoistSubmoduleSrcSubpaths, rewriteBundleManifestRoot, rewriteSeedTreeRoots, collectSeedTreeFiles, walk, BUNDLE_MANIFEST_PACKAGES, BUNDLE_MANIFEST_FILES, SEED_TREE_SPECS } from './transpile-rewrites.mjs';

const UNIMPLEMENTED = [
  [/from\s*[\x27\x22]node:vm[\x27\x22]/, 'node:vm (no spike shim — the vm builtin is a Node embedding surface)'],
  // NOTE: the session-persistence-jsonl exclusion was REMOVED when the
  // closure harvest staged the koffi-free submodule-built package
  // (vendor/dsh/session-persistence-jsonl@0.1.6-alpha.2, 2026-09-23): its
  // worker-backed lease degrades to the in-process path through the
  // node:worker_threads errors shim, exactly like the vendored session
  // package, and the flock addon maps to a shim.
  [/from\s*[\x27\x22]fast-check[\x27\x22]/, 'fast-check (not in the loader bare map — a vendoring decision, not a silent drop)'],
  [/vi\.mock\s*\(|vi\.doMock\s*\(|vi\.resetModules\s*\(/, 'vi.mock/doMock/resetModules (loader-level module interception)'],
  // NOTE: the fake-timers / vi.waitFor / expect.poll exclusions were
  // REMOVED with the v1.4.0 timer seam (contract + host + harness fakes);
  // specs demanding wall-clock semantics (vi.setSystemTime, Date mocking)
  // stay excluded below. expect.poll rides the harness's own poller
  // (upstream/shims/expect-poll.js) on the 0-delay timer arm — its
  // "no timer seam" exclusion is gone with the same seam.
  [/vi\.setSystemTime|vi\.mockedDate|vi\.setSystemTime/, 'wall-clock time mocking (the v1.4.0 seam is monotonic scheduling only)'],
  [/expect\.extend\s*\(/, 'expect.extend (custom matchers)'],
  // Decorators survive esbuild's TS transform verbatim (ES decorators, not
  // experimentalDecorators) and quickjs-ng 0.17 refuses to parse them.
  // Stripping them would silently drop the @Remote registration semantics
  // these host-spec controllers exist to exercise — excluded, not mangled.
  [/^\s*@[A-Z][A-Za-z]*(\s*\(.*\))?\s*$/m, 'decorators (@Remote/@RemoteScope — quickjs-ng 0.17 cannot parse them; stripping would drop the remote-registration semantics)'],
  // Monorepo src/ subpaths: the published tarballs ship lib/ only, so these
  // can never resolve from the vendored closure (upstream's own suite runs
  // from source). A named exclusion, not an on-device noise failure.
  [/from\s*[\x27\x22]@deepseek-ai\/dsh-[a-z0-9-]+\/src\//, 'monorepo src/ subpath (npm tarballs ship lib/ only — upstream runs its suite from source)'],
  // NOTE: the FiberState exclusion was REMOVED (2026-09-27, wave 3): the
  // runtime no longer needs the npm cordis@4.0.2 face to carry the export —
  // upstream/shims/runtime-modules.js registers `@deepseek-ai/cordis` as the
  // vendored lib PLUS FiberState (enum values read off the same package's
  // src/fiber.ts) and LoggerLevel. The tool-cordis lifecycle spec staged
  // again through the same rule's removal; its probe passed 2/0 on the
  // registered face (tmp/r3-ledger-H.json).
];

/** vi.spyOn on an `import * as` namespace can never land: ESM bindings are
 * read-only, so the spy assignment throws ('X' is read-only) — upstream
 * gets away with it only via vi.mock's loader-level interception, already
 * an excluded class. Returns a per-spec pattern set for the namespace names
 * that spec actually imports. */
const spyOnNamespaceRules = (source) => {
  const namespaces = [...source.matchAll(/import\s+\*\s+as\s+(\w+)\s+from/g)].map((m) => m[1]);
  return namespaces
    .filter((name) => new RegExp(`vi\\.spyOn\\(\\s*${name}\\s*,`).test(source))
    .map(() => [/vi\.spyOn\(/, 'vi.spyOn on a module namespace (ESM bindings are read-only without vi.mock loader interception — excluded class)']);
};

// Every bare import stays external (the host loader serves the closure;
// third-party gaps become named failures on the target host). dsh SUBPATH
// imports (e.g. '@deepseek-ai/dsh-session/invariant') stay bare too: the
// loader's vendored-package probe owns subpath resolution (both vendored
// directory families + the exports-map file shapes) — one resolution site,
// no second map to drift against the C host.
//
// EXCEPT imports made from inside an INLINED monorepo limb (see
// SUBMODULE_SRC_HOISTS below) that name packages the mobile closure does
// not vendor: llm-pi-ai's config/provider schemas reach '@earendil-works/
// pi-ai' (not vendored anywhere — the adapter speaks to it only through
// bundled desktop builds) and '@deepseek-ai/dsh-credentials' (not staged
// under vendor/dsh/). Leaving them bare would only relocate the on-device
// load failure from src/context.ts to pi-ai. They resolve instead to a CJS
// stub whose every property read yields a function that throws when CALLED:
// linking is satisfied (esbuild interops named imports through property
// access), module init stays safe (the only top-level dereference in the
// inlined graph is provider.ts's PROTOCOLS table, which binds the throwers
// as inert values), and any future live path that executes one fails loud
// and named — the limbs toPiContext actually serves never touch them. The
// scope guard is the importer: only the pinned submodule's files get the
// stub; a SPEC's own pi-ai import stays bare external and keeps failing
// loud on-device (the llm group's open work, unchanged).
// esbuild resolves symlinks by default, so importers arrive as REAL paths —
// a worktree/symlinked checkout must scope the stub against the resolved
// submodule location or the guard silently misses (observed: the pi-ai
// imports leaked back to bare-external). Falls back to the plain path when
// the submodule is absent; the hoists then no-op through existsSync below.
let SUBMODULE_ROOT = join(ROOT, 'third-party/deepseek-harness');
try {
  SUBMODULE_ROOT = realpathSync(SUBMODULE_ROOT);
} catch {
  /* absent submodule: SUBMODULE_SRC_HOISTS targets fail existsSync and the
   * generic monorepo-src exclusion names the specifier instead */
}
/** Bare specifiers the loader cannot serve as-is, resolved here so the
 * esbuild graph (spec source, bundled helpers AND inlined submodule limbs —
 * every importer funnels through this plugin) links without touching the
 * vendored package bytes (D6) or the C host's bare map:
 *
 * - `@deepseek-ai/dsh-subprocess-local` — the npm tarball's lib/index.js is
 *   the ONE vendored entry carrying RELATIVE chunk imports (the upstream
 *   build code-splits: `./runner-launch-DGV26RBf.js` + sibling lib files).
 *   Loaded under the BARE specifier, the host normalizes those relative
 *   imports against `@deepseek-ai` (the specifier has no subpath to carry
 *   the package directory) and the chunk name can never resolve. Rewriting
 *   the external to the `/index` SUBPATH makes the loader's module NAME
 *   carry the package directory, so `./chunk.js` re-enters the bare map's
 *   vendored probe and hits `lib/<chunk>.js` in the tarball. Only this
 *   package gets the rewrite: no vendored lib imports it bare, so no second
 *   module instance can split state (the generic rewrite would — vendored
 *   libs import sibling dsh packages bare and must keep the exact names).
 *
 * - `@deepseek-ai/cordis-plugin-group` — an upstream vendor/ workspace
 *   package the test closure never stages; the vendored dsh_app-boot
 *   tarball's bare import of it fails in the loader. Resolved to the pinned
 *   submodule's BUILT lib (D6-verbatim, read-only) and inlined.
 *
 * - `@deepseek-ai/dsh-app-boot` — same face problem as the group: the
 *   tarball's lib/index.js imports cordis-plugin-group bare, which no
 *   loader row serves. The spec-side graph inlines the pinned submodule's
 *   SOURCE limb instead; the group resolves inside it via the row above,
 *   `resolve.exports` via the row below, and every vendored dep stays a
 *   loader-served bare external under its exact name (cordis Context and
 *   the cordis-plugin-* libs keep one instance across spec + limb).
 *
 * - `resolve.exports` — the app-boot limb's package-resolution helper,
 *   present only in the submodule's lockfile store (pnpm layout). */
const buildOptionsFor = (rel, hoisted, forceStdin) => {
  const options = {
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    plugins: [BARE_EXTERNAL_PLUGIN],
    logLevel: 'silent',
  };
  // forceStdin is required when an IN-MEMORY transform must reach the build:
  // entryPoints reads the bytes off DISK, silently dropping any rewrite that
  // left `hoisted` equal to the rewritten source (measured W5-Q: the
  // bundle-manifest root rewrite produced a hoisted string identical to the
  // rewritten source, so the old `hoisted === source` probe took the
  // entryPoints path and the staged output kept the original '..' join).
  if (forceStdin) {
    options.stdin = {
      contents: hoisted,
      loader: 'ts',
      resolveDir: dirname(join(TESTS, rel)),
      sourcefile: join(TESTS, rel),
    };
  } else {
    options.entryPoints = [join(TESTS, rel)];
  }
  return options;
};

const unimplementedIn = (text, extraRules = []) => [...UNIMPLEMENTED, ...extraRules]
  .filter(([re]) => re.test(text)).map(([, reason]) => reason);

const transpileOne = async (rel, manifest) => {
  const onDisk = readFileSync(join(TESTS, rel), 'utf8');
  // The bundle-manifest family's root rewrite lands BEFORE the exclusion
  // scan and the build (the '..' join is the only thing that changes; see
  // BUNDLE_MANIFEST_PACKAGES above).
  const manifestRewritten = BUNDLE_MANIFEST_PACKAGES.has(rel);
  const seedTree = SEED_TREE_SPECS.get(rel);
  const source = manifestRewritten
    ? rewriteBundleManifestRoot(onDisk)
    : seedTree ? rewriteSeedTreeRoots(onDisk, seedTree.rewrites) : onDisk;
  // Hoisting precedes the exclusion scan: a src/ subpath we can inline from
  // the pinned submodule is no longer a bare monorepo specifier, while any
  // specifier without a hoist target keeps its named exclusion below.
  const hoisted = hoistSubmoduleSrcSubpaths(hoistCreateRequireJson(source, rel));
  const unimplemented = unimplementedIn(hoisted, spyOnNamespaceRules(hoisted));
  if (unimplemented.length > 0) {
    const key = unimplemented.join(' + ');
    manifest.excluded[key] = (manifest.excluded[key] ?? 0) + 1;
    return;
  }
  let built;
  try {
    built = await esbuild.build(buildOptionsFor(rel, hoisted, manifestRewritten || seedTree !== undefined || hoisted !== source));
  } catch (error) {
    // Fail loud naming the specifier (rule 5): a swallowed bundle failure
    // turns the missing-dependency map — the whole actionable surface of
    // this bucket — into an opaque count.
    const detail = error?.errors?.[0]?.text ?? error?.message ?? String(error);
    const firstLine = String(detail).split('\n')[0]
      .replace(/^.\s*/, '').slice(0, 160);
    manifest.excluded[`esbuild transform failed: ${firstLine}`] =
      (manifest.excluded[`esbuild transform failed: ${firstLine}`] ?? 0) + 1;
    return;
  }
  const text = built.outputFiles[0].text;
  // The output scan catches what esbuild BUNDLED IN (local test helpers the
  // spec imports — their imports never appear in the spec source itself).
  const bundled = unimplementedIn(text);
  if (bundled.length > 0) {
    const key = `bundled helper: ${bundled.join(' + ')}`;
    manifest.excluded[key] = (manifest.excluded[key] ?? 0) + 1;
    return;
  }
  const flat = rel.split('/').join('__').replace(/\.spec\.ts$/, '.spec.mjs');
  writeFileSync(join(OUT, flat), text.replace(/from\s*"vitest"/g, `from "${HARNESS_SPECIFIER}"`));
  emitFixturesModule(rel, flat);
  manifest.transpiled.push(flat);
};

// The spec's own tests/fixtures tree rides along as a data module: the
// suite driver seeds it into the staged fs view (node:fs's seedStagedFiles)
// before running the tests, so `join(dirname(fileURLToPath(import.meta.url)),
// "fixtures")` resolves to REAL seeded files at /upstream-tests/fixtures.
// Base64-wrapped; one module per spec — one spec per runtime, so the flat
// /upstream-tests/fixtures namespace never collides.
const emitFixturesModule = (rel, flat) => {
  const fixturesDir = join(TESTS, dirname(rel), 'fixtures');
  const files = [];
  if (existsSync(fixturesDir)) {
    const walkFx = (dir, base) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walkFx(full, `${base}/${name}`);
        else files.push({ path: `/upstream-tests/fixtures${base}/${name}`,
          b64: readFileSync(full).toString('base64') });
      }
    };
    walkFx(fixturesDir, '');
  }
  // The bundle-manifest family rides the same seed delivery: the REAL
  // package-root files at /upstream-tests/<name> (see BUNDLE_MANIFEST_PACKAGES).
  const manifestPkg = BUNDLE_MANIFEST_PACKAGES.get(rel);
  if (manifestPkg !== undefined) {
    const pkgRoot = join(SUBMODULE_ROOT, 'packages', manifestPkg);
    for (const name of BUNDLE_MANIFEST_FILES) {
      const full = join(pkgRoot, name);
      if (existsSync(full)) {
        files.push({ path: `/upstream-tests/${name}`, b64: readFileSync(full).toString('base64') });
      }
    }
  }
  // The layout-tree family seeds the WHOLE vendored source tree at
  // /upstream-tests/src (verbatim submodule bytes — the spec re-audits the
  // real upstream sources), the named compiler manifests, and (mirrorTests)
  // the vendored tests/*.ts so the spec's own-directory walk sees the same
  // tree shape upstream's tests/ layout gives it.
  collectSeedTreeFiles(rel, files, true);
  emitPackageAssets(rel, files);
  if (files.length === 0) return;
  const stem = flat.replace(/\.spec\.mjs$/, '');
  writeFileSync(join(OUT, `${stem}.fixtures.js`),
    `// emitted by transpile.mjs: the spec's tests/fixtures tree, seeded by the driver\n`
    + `export const fixtures = ${JSON.stringify(files)};\n`);
};

// W5-T: the spec's PACKAGE assets (skill-badge's ../assets/dsh-badge.png).
// The tests tarball stages no assets/, but the vendored npm tree of the same
// package ships them verbatim; they ride the same fixtures seed delivery at
// the URL the spec builds (new URL('../assets/<name>', import.meta.url) from
// upstream-tests/ → /assets/<name>). D6: bytes verbatim from the pinned
// tarball.
const emitPackageAssets = (rel, files) => {
  const pkgName = rel.split('/')[1];
  const assetCandidates = [
    join(ROOT, `runtime/spike/vendor/npm/@deepseek-ai/dsh-${pkgName}@0.1.6-alpha.2/assets`),
    join(ROOT, `runtime/spike/vendor/npm/@deepseek-ai/${pkgName}@0.1.6-alpha.2/assets`),
  ];
  for (const assetsDir of assetCandidates) {
    if (!existsSync(assetsDir)) continue;
    const walkAssets = (dir, base) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walkAssets(full, `${base}/${name}`);
        else files.push({ path: `/assets${base}/${name}`, b64: readFileSync(full).toString('base64') });
      }
    };
    walkAssets(assetsDir, '');
    break; // one staging family only — never double-seed the same bytes
  }
};


mkdirSync(OUT, { recursive: true });
const manifest = { transpiled: [], excluded: {} };
const specs = walk(TESTS)
  .map((full) => relative(TESTS, full))
  // The client face and the per-OS/native suites are out of this phase's
  // scope (counted exclusions, never silent).
  .filter((rel) => !rel.startsWith('client/'))
  .filter((rel) => !/\/(office-to-pdf|sandbox-local|sandbox-windows-acl|win32-process|terminal|tool-fs-search|browser-use-|computer-use-|speech-to-text|voice-input-bundle|ptc-runtime-python|app-boot|hmr)\//.test(rel));

for (const rel of specs) {
  await transpileOne(rel, manifest);
}

// The experimental Inspector's WORKER entry (W5-Q, 2026-09-28): the vendored
// host bridge spawns the BUILT entry sibling of its lib chunk —
// `new Worker(new URL('./worker.js', import.meta.url))`. The staged .host
// specs inline the controller source, but the worker entry is a separate
// build artifact the tests tarball never carries, so the in-process Worker
// face (node-worker-threads shim) fails the import with "cannot load module
// '/upstream-tests/worker.js'". Bundle it from the pinned submodule (D6:
// verbatim upstream) into the staged root — bare externals (node:* shims,
// ws) stay loader-served so the controller and the worker share ONE shim
// module instance, which the parentPort/workerData swap window requires.
const inspectorStaged = manifest.transpiled.some((f) => f.startsWith('experimental__inspector__'));
const workerEntry = join(TESTS, 'experimental/inspector/src/worker/entry.ts');
if (inspectorStaged && existsSync(workerEntry)) {
  const built = await esbuild.build({
    entryPoints: [workerEntry],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    plugins: [BARE_EXTERNAL_PLUGIN],
    logLevel: 'silent',
  });
  writeFileSync(join(OUT, 'worker.js'), built.outputFiles[0].text);
  manifest.workerEntries = ['worker.js'];
}

// Prune staged files the current manifest does not list: exclusions evolve
// (a specifier's hoist lands, or an exclusion narrows), and a stale .spec.mjs
// left behind would keep running in the sweep — which enumerates this
// directory, not the manifest — as a noise failure the manifest already
// accounts for with a named reason. Only the two suffixes this tool emits
// are pruned; anything else in OUT is not ours to touch.
const listed = new Set(manifest.transpiled);
for (const name of readdirSync(OUT)) {
  const stem = name.replace(/\.fixtures\.js$/, '.spec.mjs');
  if ((name.endsWith('.spec.mjs') || name.endsWith('.fixtures.js'))
      && !listed.has(stem)) {
    unlinkSync(join(OUT, name));
  }
}

manifest.counts = {
  transpiled: manifest.transpiled.length,
  excluded: Object.entries(manifest.excluded).map(([reason, count]) => ({ reason, count })),
};
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest.counts, null, 2));
