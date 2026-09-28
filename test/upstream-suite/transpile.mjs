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

const UNIMPLEMENTED = [
  [/from\s*['"]node:vm['"]/, 'node:vm (no spike shim — the vm builtin is a Node embedding surface)'],
  // NOTE: the session-persistence-jsonl exclusion was REMOVED when the
  // closure harvest staged the koffi-free submodule-built package
  // (vendor/dsh/session-persistence-jsonl@0.1.6-alpha.2, 2026-09-23): its
  // worker-backed lease degrades to the in-process path through the
  // node:worker_threads errors shim, exactly like the vendored session
  // package, and the flock addon maps to a shim.
  [/from\s*['"]fast-check['"]/, 'fast-check (not in the loader bare map — a vendoring decision, not a silent drop)'],
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
  [/from\s*['"]@deepseek-ai\/dsh-[a-z0-9-]+\/src\//, 'monorepo src/ subpath (npm tarballs ship lib/ only — upstream runs its suite from source)'],
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
const UNVENDORED_INLINED = [
  /^@earendil-works\/pi-ai(?:\/|$)/,
  /^@deepseek-ai\/dsh-credentials$/,
];
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
const SUBMODULE_BARE_RESOLVES = () => {
  const abs = (rel) => join(SUBMODULE_ROOT, rel);
  const rows = new Map([
    ['@deepseek-ai/dsh-subprocess-local', { externalSubpath: 'index' }],
    ['@deepseek-ai/cordis-plugin-group', { inline: abs('vendor/group/lib/index.js') }],
    ['@deepseek-ai/dsh-app-boot', { inline: abs('packages/boot/app-boot/src/index.ts') }],
    ['resolve.exports', {
      inline: abs('node_modules/.pnpm/resolve.exports@2.0.3'
        + '/node_modules/resolve.exports/dist/index.mjs'),
    }],
  ]);
  // A missing submodule target must keep its bare external (the loader then
  // fails loud naming the specifier) — never a silently half-mapped graph.
  for (const [spec, row] of rows) {
    if (row.inline && !existsSync(row.inline)) rows.delete(spec);
  }
  return rows;
};
const BARE_RESOLVES = SUBMODULE_BARE_RESOLVES();

const BARE_EXTERNAL_PLUGIN = {
  name: 'bare-external',
  setup(build) {
    build.onResolve({ filter: /^[.@a-zA-Z]/ }, (args) => {
      if (args.path.startsWith('.') || args.path.startsWith('/')) return null;
      if (args.importer.startsWith(SUBMODULE_ROOT)
          && UNVENDORED_INLINED.some((re) => re.test(args.path))) {
        return { path: `${args.path}.cjs`, namespace: 'unvendored-stub' };
      }
      const resolveRow = BARE_RESOLVES.get(args.path);
      if (resolveRow) {
        if (resolveRow.externalSubpath !== undefined) {
          return { path: `${args.path}/${resolveRow.externalSubpath}`, external: true };
        }
        return { path: resolveRow.inline }; // absolute: esbuild loads + inlines
      }
      // src/ hoist rows also resolve NESTED importers (a vendored package's
      // inlined src limb imports the same monorepo specifier its spec does):
      // returning the submodule file inlines it, so the bare specifier never
      // survives to the bundled-output scan. The spec-source rewrite (above)
      // hits the same absolute path, so esbuild keeps ONE instance.
      const srcRow = SUBMODULE_SRC_HOISTS.get(args.path);
      if (srcRow !== undefined && existsSync(join(SUBMODULE_ROOT, srcRow))) {
        return { path: join(SUBMODULE_ROOT, srcRow) };
      }
      return { path: args.path, external: true };
    });
    build.onLoad({ filter: /.*/, namespace: 'unvendored-stub' }, () => ({
      // The .cjs suffix makes esbuild treat the stub as CommonJS, which is
      // what lets named imports of arbitrary symbols link through property
      // access instead of failing "No matching export" at build time.
      contents: 'module.exports = new Proxy({}, { get(_t, key) {'
        + ' return () => { throw new Error("unvendored limb executed at runtime: " + String(key)); };'
        + ' } });',
      loader: 'js',
    }));
  },
};

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.spec.ts')) out.push(full);
  }
  return out;
};

const unimplementedIn = (text, extraRules = []) => [...UNIMPLEMENTED, ...extraRules]
  .filter(([re]) => re.test(text)).map(([, reason]) => reason);

/** `createRequire(import.meta.url)('../package.json')` reads the SPEC'S OWN
 * PACKAGE manifest — a monorepo-layout fact our corpus does not have (the
 * staged spec's parent directory is upstream-tests/, and the tests codeload
 * tarball ships no package.json at all). The manifest DOES exist in the
 * vendored npm tree for the same version, so each such read is rewritten to
 * a bundled JSON import resolved against: (a) the tests tree, then (b) the
 * vendored package (both directory families). esbuild inlines it verbatim,
 * preserving the attribution checks exactly. */
const hoistCreateRequireJson = (source, rel) => {
  const re = /createRequire\(import\.meta\.url\)\('([^']+\.json)'\)/g;
  const specDir = dirname(join(TESTS, rel));
  const pkgName = rel.split('/')[1];
  const vendorCandidates = [
    join(ROOT, `runtime/spike/vendor/dsh/${pkgName}@0.1.6-alpha.2`),
    join(ROOT, `runtime/spike/vendor/dsh/dsh-${pkgName}@0.1.6-alpha.2`),
  ];
  const imports = [];
  const rewritten = source.replace(re, (_m, rawPath) => {
    const direct = join(specDir, rawPath);
    let resolved = existsSync(direct) ? direct : null;
    if (resolved === null) {
      // '../package.json' (or deeper) resolves inside the package root the
      // vendored tarball carries.
      const inPkg = relative(specDir, join(specDir, rawPath)).replace(/^\.\.\//, '');
      resolved = vendorCandidates
        .map((dir) => join(dir, inPkg))
        .find((full) => existsSync(full)) ?? null;
    }
    if (resolved === null) return _m; // unresolved: esbuild will fail loud
    const name = `__dsh_pkg_json_${imports.length}`;
    imports.push(`import ${name} from ${JSON.stringify(resolved)};`);
    return name;
  });
  if (imports.length === 0) return source;
  return `${imports.join('\n')}\n${rewritten}`;
};

/** Monorepo src/ subpaths a spec needs at RUNTIME for symbols no vendored
 * tarball carries. '@deepseek-ai/dsh-llm-pi-ai/src/context.ts' (toPiContext —
 * the system-prompt-admission spec's admission oracle) is a deliberate
 * TS-source export of the upstream package, but the npm tarball this closure
 * vendors ships a SINGLE-FILE lib/index.js bundle whose export list (Config,
 * PiAiAdapter, apply, inject, name, recordKeyFor, supportedProtocols) omits
 * it — no bare rewrite can reach the symbol, and the loader's probe families
 * cannot serve the tarball's shapes for a src/ subpath. The rewrite points
 * the import at the PINNED SUBMODULE's source (D6: verbatim upstream, never
 * a modified copy) so esbuild inlines the limb exactly like a local fixture;
 * the two packages that limb's dead schemas reach but the closure does not
 * vendor become throwing stubs (see UNVENDORED_INLINED). A missing hoist
 * target leaves the specifier untouched, so the generic monorepo-src
 * exclusion still names it — fail loud, never a silent drop (rule 5). */
const SUBMODULE_SRC_HOISTS = new Map([
  ['@deepseek-ai/dsh-llm-pi-ai/src/context.ts', 'packages/llm/llm-pi-ai/src/context.ts'],
  // subprocess-local src/ faces the lsp-stdio and process-inspector specs
  // drive directly (spawnSubprocess / the inspector classes). The tarball
  // ships only the bundled lib/ face; these files exist verbatim in the
  // pinned submodule, whose relative imports esbuild inlines while the bare
  // deps (dsh-subprocess, dsh-timeout, dsh-lazy-require) stay loader-served.
  ['@deepseek-ai/dsh-subprocess-local/src/spawn.ts', 'packages/subprocess/subprocess-local/src/spawn.ts'],
  ['@deepseek-ai/dsh-subprocess-local/src/process-inspector.ts', 'packages/subprocess/subprocess-local/src/process-inspector.ts'],
  ['@deepseek-ai/dsh-subprocess-local/src/windows-inspector.ts', 'packages/subprocess/subprocess-local/src/windows-inspector.ts'],
  // lsp-stdio's specs import connection.ts / instance.ts TYPE-ONLY (esbuild
  // erases them), but the monorepo-src exclusion regex reads the SOURCE —
  // hoisting the specifier past the scan lets the erased-at-build reality
  // hold, instead of a named exclusion for an import that never loads.
  ['@deepseek-ai/dsh-lsp-stdio/src/connection.ts', 'packages/lsp/lsp-stdio/src/connection.ts'],
  ['@deepseek-ai/dsh-lsp-stdio/src/instance.ts', 'packages/lsp/lsp-stdio/src/instance.ts'],
  // webworker-runtime src/ faces whose transitive closure stays inside the
  // loader's surface (its externals are shimmed node: builtins or vendored
  // dsh packages). Deliberately NARROW: the other src/-importing specs pull
  // unvendored npm packages through their limbs (buffer / readable-stream /
  // @noble/hashes / @yarnpkg/parsers / picomatch) and keep their named
  // monorepo-src exclusion instead of trading it for an on-device load
  // failure. Each row below was checked to close over served externals only:
  // path-diff → node:path; als-shim → node:async_hooks; tunnel-client →
  // dsh-host-webserver (vendored).
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/client/client.ts', 'packages/experimental/webworker-runtime/src/client/client.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/path.ts', 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/path.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/async_hooks.ts', 'packages/experimental/webworker-runtime/src/node/builtin_modules/implemented/async_hooks.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/node/globals/timers.ts', 'packages/experimental/webworker-runtime/src/node/globals/timers.ts'],
  ['@deepseek-ai/dsh-experimental-webworker-runtime/src/polyfill/async-context/async-context-hooks.ts', 'packages/experimental/webworker-runtime/src/polyfill/async-context/async-context-hooks.ts'],
  // Wave-3 batch (2026-09-27, worker L): the monorepo-src specs whose src
  // limbs close over SERVED externals only — every bare import below is a
  // vendored vendor/dsh/ tarball, a shimmed node: builtin, a bare-map npm pin
  // (zod@4.4.3), or a registered runtime-module/npm-bridge face
  // (@modelcontextprotocol/client + /stdio — npm-bridges rows). Each row was
  // checked limb-by-limb (the files' import lines): pure config/sanitize/
  // render/projection units, no unvendored npm package reachable.
  ['@deepseek-ai/dsh-tools/src/py-types.ts', 'packages/core/tools/src/py-types.ts'],
  ['@deepseek-ai/dsh-tools/src/ts-types.ts', 'packages/core/tools/src/ts-types.ts'],
  ['@deepseek-ai/dsh-tools/src/json-schema.ts', 'packages/core/tools/src/json-schema.ts'],
  ['@deepseek-ai/dsh-hooks-claude-code/src/config.ts', 'packages/hooks/hooks-claude-code/src/config.ts'],
  ['@deepseek-ai/dsh-hooks-codex/src/config.ts', 'packages/hooks/hooks-codex/src/config.ts'],
  ['@deepseek-ai/dsh-mcp-client/src/transport.ts', 'packages/mcp/mcp-client/src/transport.ts'],
  ['@deepseek-ai/dsh-mcp-client/src/tools.ts', 'packages/mcp/mcp-client/src/tools.ts'],
  ['@deepseek-ai/dsh-session-stats/src/projection.ts', 'packages/session/session-stats/src/projection.ts'],
  ['@deepseek-ai/dsh-session-turn-outline/src/projection.ts', 'packages/session/session-turn-outline/src/projection.ts'],
  ['@deepseek-ai/dsh-terminal-bash/src/config.ts', 'packages/terminal/terminal-bash/src/config.ts'],
  ['@deepseek-ai/dsh-terminal-bash/src/sanitize.ts', 'packages/terminal/terminal-bash/src/sanitize.ts'],
  ['@deepseek-ai/dsh-tool-terminal/src/render.ts', 'packages/terminal/tool-terminal/src/render.ts'],
  ['@deepseek-ai/dsh-compaction-basic/src/config.ts', 'packages/compaction/compaction-basic/src/config.ts'],
  ['@deepseek-ai/dsh-compaction-basic/src/summarizer.ts', 'packages/compaction/compaction-basic/src/summarizer.ts'],
  ['@deepseek-ai/dsh-compaction-basic/src/region.ts', 'packages/compaction/compaction-basic/src/region.ts'],
  ['@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts', 'packages/session/session-persistence-jsonl/src/format.ts'],
]);
const hoistSubmoduleSrcSubpaths = (source) => {
  let out = source;
  for (const [specifier, rel] of SUBMODULE_SRC_HOISTS) {
    const target = join(SUBMODULE_ROOT, rel);
    if (!existsSync(target)) continue;
    out = out.replaceAll(`'${specifier}'`, JSON.stringify(target))
              .replaceAll(`"${specifier}"`, JSON.stringify(target));
  }
  return out;
};

/** Transpile one spec (or record its named exclusion). */
/** The esbuild option shape for one spec: entry file when nothing hoisted,
 * stdin otherwise (the hoisted package.json reads and inlined monorepo
 * limbs build through stdin — split from transpileOne for the function
 * shape budget). */
const buildOptionsFor = (rel, hoisted, source) => {
  const options = {
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    plugins: [BARE_EXTERNAL_PLUGIN],
    logLevel: 'silent',
  };
  if (hoisted === source) {
    options.entryPoints = [join(TESTS, rel)];
  } else {
    options.stdin = {
      contents: hoisted,
      loader: 'ts',
      resolveDir: dirname(join(TESTS, rel)),
      sourcefile: join(TESTS, rel),
    };
  }
  return options;
};

const transpileOne = async (rel, manifest) => {
  const source = readFileSync(join(TESTS, rel), 'utf8');
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
    built = await esbuild.build(buildOptionsFor(rel, hoisted, source));
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
  if (!existsSync(fixturesDir)) return;
  const files = [];
  const walkFx = (dir, base) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walkFx(full, `${base}/${name}`);
      else files.push({ path: `/upstream-tests/fixtures${base}/${name}`,
        b64: readFileSync(full).toString('base64') });
    }
  };
  walkFx(fixturesDir, '');
  const stem = flat.replace(/\.spec\.mjs$/, '');
  writeFileSync(join(OUT, `${stem}.fixtures.js`),
    `// emitted by transpile.mjs: the spec's tests/fixtures tree, seeded by the driver\n`
    + `export const fixtures = ${JSON.stringify(files)};\n`);
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
