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
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const TESTS = join(ROOT, 'runtime/spike/vendor/dsh-tests@dsh-v0.1.6-alpha.2/packages');
const OUT = join(ROOT, 'runtime/spike/upstream-tests');
const HARNESS_SPECIFIER = 'scenario/upstream-test-harness.js';

const UNIMPLEMENTED = [
  [/from\s*['"]node:vm['"]/, 'node:vm (no spike shim — the vm builtin is a Node embedding surface)'],
  [/from\s*['"]@deepseek-ai\/dsh-session-persistence-jsonl['"]/, 'session-persistence-jsonl (koffi native dep — deliberately outside every mobile closure)'],
  [/from\s*['"]fast-check['"]/, 'fast-check (not in the loader bare map — a vendoring decision, not a silent drop)'],
  [/vi\.mock\s*\(|vi\.doMock\s*\(|vi\.resetModules\s*\(/, 'vi.mock/doMock/resetModules (loader-level module interception)'],
  // NOTE: the fake-timers / vi.waitFor / expect.poll exclusions were
  // REMOVED with the v1.4.0 timer seam (contract + host + harness fakes);
  // specs demanding wall-clock semantics (vi.setSystemTime, Date mocking)
  // stay excluded below.
  [/vi\.setSystemTime|vi\.mockedDate|vi\.setSystemTime/, 'wall-clock time mocking (the v1.4.0 seam is monotonic scheduling only)'],
  [/expect\.extend\s*\(/, 'expect.extend (custom matchers)'],
  [/expect\.poll\s*\(/, 'expect.poll (timer-based polling — the runtime has no timer seam)'],
  // Decorators survive esbuild's TS transform verbatim (ES decorators, not
  // experimentalDecorators) and quickjs-ng 0.17 refuses to parse them.
  // Stripping them would silently drop the @Remote registration semantics
  // these host-spec controllers exist to exercise — excluded, not mangled.
  [/^\s*@[A-Z][A-Za-z]*(\s*\(.*\))?\s*$/m, 'decorators (@Remote/@RemoteScope — quickjs-ng 0.17 cannot parse them; stripping would drop the remote-registration semantics)'],
  // Monorepo src/ subpaths: the published tarballs ship lib/ only, so these
  // can never resolve from the vendored closure (upstream's own suite runs
  // from source). A named exclusion, not an on-device noise failure.
  [/from\s*['"]@deepseek-ai\/dsh-[a-z0-9-]+\/src\//, 'monorepo src/ subpath (npm tarballs ship lib/ only — upstream runs its suite from source)'],
  // cordis@4.0.2 (the closure's pinned npm dep, D6) predates the FiberState
  // export upstream's newer lockfile carries. A vendoring decision, not a
  // silent drop; revisit when the cordis pin moves.
  [/import\s*\{[^}]*FiberState[^}]*\}\s*from\s*['"]@deepseek-ai\/cordis['"]/, 'FiberState from @deepseek-ai/cordis (the closure pins cordis@4.0.2, which predates that export)'],
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
const BARE_EXTERNAL_PLUGIN = {
  name: 'bare-external',
  setup(build) {
    build.onResolve({ filter: /^[.@a-zA-Z]/ }, (args) => {
      if (args.path.startsWith('.') || args.path.startsWith('/')) return null;
      if (args.importer.startsWith(SUBMODULE_ROOT)
          && UNVENDORED_INLINED.some((re) => re.test(args.path))) {
        return { path: `${args.path}.cjs`, namespace: 'unvendored-stub' };
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
  const flat = rel.split('/').join('__').replace(/\.spec\.ts$/, '.spec.mjs');
  // The hoisted package.json reads (see hoistCreateRequireJson) and the
  // inlined monorepo limbs (see hoistSubmoduleSrcSubpaths) build through
  // stdin; a spec untouched by either builds from its file as before.
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
  let built;
  try {
    built = await esbuild.build(options);
  } catch {
    manifest.excluded['esbuild transform failed'] = (manifest.excluded['esbuild transform failed'] ?? 0) + 1;
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
  writeFileSync(join(OUT, flat), text.replace(/from\s*"vitest"/g, `from "${HARNESS_SPECIFIER}"`));
  manifest.transpiled.push(flat);
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

manifest.counts = {
  transpiled: manifest.transpiled.length,
  excluded: Object.entries(manifest.excluded).map(([reason, count]) => ({ reason, count })),
};
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest.counts, null, 2));
