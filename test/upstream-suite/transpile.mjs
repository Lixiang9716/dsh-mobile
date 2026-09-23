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
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
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
  [/vi\.useFakeTimers|vi\.advanceTimersByTime|vi\.setSystemTime/, 'fake timers (the runtime has no timer seam)'],
  [/expect\.extend\s*\(/, 'expect.extend (custom matchers)'],
  [/vi\.waitFor|vi\.waitUntil/, 'vi.waitFor (timer-based polling)'],
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
const BARE_EXTERNAL_PLUGIN = {
  name: 'bare-external',
  setup(build) {
    build.onResolve({ filter: /^[.@a-zA-Z]/ }, (args) => {
      if (args.path.startsWith('.') || args.path.startsWith('/')) return null;
      return { path: args.path, external: true };
    });
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

/** Transpile one spec (or record its named exclusion). */
const transpileOne = async (rel, manifest) => {
  const source = readFileSync(join(TESTS, rel), 'utf8');
  const unimplemented = unimplementedIn(source, spyOnNamespaceRules(source));
  if (unimplemented.length > 0) {
    const key = unimplemented.join(' + ');
    manifest.excluded[key] = (manifest.excluded[key] ?? 0) + 1;
    return;
  }
  const flat = rel.split('/').join('__').replace(/\.spec\.ts$/, '.spec.mjs');
  // The hoisted package.json reads (see hoistCreateRequireJson) inline
  // verbatim through esbuild's json loader; a spec without them builds from
  // its file as before.
  const hoisted = hoistCreateRequireJson(source, rel);
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
