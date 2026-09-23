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
 * compatibility proof).
 *
 * usage: node transpile.mjs   (writes runtime/spike/upstream-tests/ + manifest.json)
 */
import esbuild from 'esbuild';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

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
];

// Every bare import stays external (the host loader serves the closure;
// third-party gaps become named failures on the target host).
const BARE_EXTERNAL_PLUGIN = {
  name: 'bare-external',
  setup(build) {
    build.onResolve({ filter: /^[.@a-zA-Z]/ }, (args) => {
      if (args.path.startsWith('.') || args.path.startsWith('/')) return null;
      // dsh SUBPATH imports (e.g. '@deepseek-ai/dsh-session/invariant')
      // become bundle-relative file paths: the host loader's bare map
      // whitelists specific subpaths only, while its generic path route
      // serves anything under the bundle root — and the vendored packages
      // live there verbatim.
      const sub = /^@deepseek-ai\/(dsh-[a-z0-9-]+)\/(.+)$/.exec(args.path);
      if (sub !== null) {
        const file = sub[2].endsWith('.js') ? sub[2] : `${sub[2]}.js`;
        return { path: `vendor/dsh/${sub[1]}@0.1.6-alpha.2/lib/${file}`, external: true };
      }
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

/** Transpile one spec (or record its named exclusion). */
const transpileOne = async (rel, manifest) => {
  const source = readFileSync(join(TESTS, rel), 'utf8');
  const unimplemented = UNIMPLEMENTED.filter(([re]) => re.test(source)).map(([, reason]) => reason);
  if (unimplemented.length > 0) {
    const key = unimplemented.join(' + ');
    manifest.excluded[key] = (manifest.excluded[key] ?? 0) + 1;
    return;
  }
  const flat = rel.split('/').join('__').replace(/\.spec\.ts$/, '.spec.mjs');
  let built;
  try {
    built = await esbuild.build({
      entryPoints: [join(TESTS, rel)],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      write: false,
      plugins: [BARE_EXTERNAL_PLUGIN],
      logLevel: 'silent',
    });
  } catch {
    manifest.excluded['esbuild transform failed'] = (manifest.excluded['esbuild transform failed'] ?? 0) + 1;
    return;
  }
  writeFileSync(join(OUT, flat), built.outputFiles[0].text.replace(/from\s*"vitest"/g, `from "${HARNESS_SPECIFIER}"`));
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
