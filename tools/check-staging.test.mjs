// dsh:logging-exempt (test file: assertions ARE the product)
/**
 * check-staging.test.mjs — the staging VERIFIER's own net (tools/check-staging.mjs).
 *
 * The tool gates every landing; these tests gate the tool. Happy path and
 * counterexamples run against a HERMETIC fixture repo (test/tools/helpers/
 * staging-fixture.mjs): the real tool sources are copied verbatim into a tmp
 * repo, so a fixture run exercises the committed bytes, and every mutation
 * (gap / stale row / broken edge) is a tmp-only edit. One smoke leg runs the
 * real CLI in the real repo for the state that holds on any checkout (warn
 * mode + usage errors) — the blocking gate needs the materialized vendored
 * closure CI provisions, so it is not asserted here.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGreenFixture, SCOPED_REACHED } from './test/tools/helpers/staging-fixture.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const fixtures = [];
function freshFixture() {
  const fx = buildGreenFixture();
  fixtures.push(fx.root);
  return fx;
}
afterAll(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
});

describe('check-staging on the green fixture (happy path)', () => {
  it('warn mode (no --block) exits 0 with zero findings', () => {
    const fx = freshFixture();
    const r = fx.json('check-staging.mjs');
    expect(r.status).toBe(0);
    expect(r.data.ok).toBe(true);
    expect(r.data.warnFindings).toBe(0);
    expect(r.data.blockedHosts).toEqual([]);
    for (const host of r.data.results) {
      expect(host.findings, host.host).toBe(0);
      expect(host.brokenEdges, host.host).toEqual([]);
      expect(host.missingRoots, host.host).toEqual([]);
      for (const surface of host.surfaces) {
        expect(surface.gaps, `${host.host}/${surface.label}`).toEqual([]);
        expect(surface.stale, `${host.host}/${surface.label}`).toEqual([]);
      }
    }
  });

  it('the graph walks the whole closure: every scoped file is reached', () => {
    const fx = freshFixture();
    const r = fx.json('check-staging.mjs', ['--host', 'harmony']);
    const harmony = r.data.results[0];
    expect(harmony.roots).toBeGreaterThanOrEqual(3);
    for (const rel of SCOPED_REACHED) {
      expect(harmony.reachedFiles, rel).toContain(rel);
    }
  });

  it('blocking mode with all hosts blocked still exits 0 when clean', () => {
    const fx = freshFixture();
    const r = fx.json('check-staging.mjs', ['--block', 'harmony,android,ios']);
    expect(r.status).toBe(0);
    expect(r.data.ok).toBe(true);
    expect(r.data.blockedHosts).toEqual(['harmony', 'android', 'ios']);
    expect(r.data.results.every((h) => h.mode === 'blocking')).toBe(true);
  });

  it('the human report names each surface and ends with the summary line', () => {
    const fx = freshFixture();
    const r = fx.run('check-staging.mjs', ['--host', 'ios']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('== host ios (warn) ==');
    expect(r.stdout).toContain('surface Tools/gen_bundle_header.py RESOURCES+TREES');
    expect(r.stdout).toContain('clean');
    expect(r.stdout).toMatch(/^staging-check: ok · blocking hosts \(none\) · 0 warning\(s\)/m);
  });
});

describe('check-staging counterexamples (the teeth)', () => {
  it('a gap: new closure file not in the manifest → GAP, exit 1 blocked, warn counted', () => {
    const fx = freshFixture();
    // The 2026-09 shims/-splits failure class: a new file joins the closure,
    // CI stays green (the file is on the dev disk), a fresh install dies.
    fx.writeSpike('scenario/leg-b.js', "import './leg-a.js';\n");
    fx.writeSpike('scenario/leg-a.js', "import './leg-b.js';\n");
    const warn = fx.json('check-staging.mjs');
    expect(warn.status).toBe(0);
    expect(warn.data.ok).toBe(true); // warn mode counts, does not fail
    const harmonyWarn = warn.data.results.find((h) => h.host === 'harmony');
    const warnGaps = harmonyWarn.surfaces.flatMap((s) => s.gaps.map((g) => g.file));
    expect(warnGaps).toContain('scenario/leg-b.js');
    expect(warn.data.warnFindings).toBeGreaterThan(0);

    const blocked = fx.run('check-staging.mjs', ['--block', 'harmony']);
    expect(blocked.status).toBe(1);
    expect(blocked.stdout).toContain('GAP scenario/leg-b.js');
    expect(blocked.stdout).toContain('staging-check: FAIL');
  });

  it('a stale row: manifest names a file the tree renamed → STALE, exit 1 blocked', () => {
    const fx = freshFixture();
    fx.remove('hosts/harmony/entry/src/main/resources/rawfile/spike/scenario/leg-a.js');
    const r = fx.run('check-staging.mjs', ['--block', 'harmony']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('STALE scenario/leg-a.js — no such file');
  });

  it('a broken edge: first-party import resolving nowhere → BROKEN EDGE, exit 1', () => {
    const fx = freshFixture();
    fx.writeSpike('upstream/helper.js', "export { x } from './ghost.js';\n");
    const r = fx.run('check-staging.mjs', ['--block', 'android']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/BROKEN EDGE upstream\/helper\.js:\d+ imports '\.\/ghost\.js' \(import-from\)/);
  });

  it('a missing root: a staged scenario entry that does not exist → MISSING ROOTS', () => {
    const fx = freshFixture();
    // android's scenario rows ARE its roots; rename one on disk only.
    fx.remove('runtime/spike/scenario/leg-a.js');
    const r = fx.run('check-staging.mjs', ['--block', 'android']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('MISSING ROOTS (staged scenario entry does not exist)');
    expect(r.stdout).toContain('scenario/leg-a.js');
  });

  it('an advisory surface counts context, not verdicts (cap at 20 listed gaps)', () => {
    const fx = freshFixture();
    // 25 new closure files REACHED from web-boot (import edges), covered by
    // the PRIMARY surface (rows landed) but not named by the advisory
    // CLOSURE: gaps pile up advisory-only → counted, exit 0.
    const files = [];
    const imports = [];
    for (let i = 0; i < 25; i += 1) {
      const rel = `upstream/gen-${String(i).padStart(2, '0')}.js`;
      fx.writeSpike(rel, 'export const g = 1;\n');
      files.push(rel);
      imports.push(`import './gen-${String(i).padStart(2, '0')}.js';`);
    }
    fx.writeSpike('upstream/web-boot.js', `${imports.join('\n')}\n`);
    fx.addBundleRows(files);
    const r = fx.run('check-staging.mjs', ['--block', 'harmony']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('(advisory surface)');
    expect(r.stdout).toContain('… and 5 more advisory coverage misses (count only)');
    const data = fx.json('check-staging.mjs', ['--block', 'harmony']).data;
    const surfaces = data.results[0].surfaces;
    const advisorySurface = surfaces.find((s) => s.advisory);
    const primary = surfaces.find((s) => !s.advisory);
    expect(advisorySurface.gaps.length).toBe(25);
    expect(primary.gaps).toEqual([]);
    expect(data.ok).toBe(true);
    expect(data.results[0].findings).toBe(0);
  });
});

describe('check-staging CLI contract (exit 2 usage/structure errors)', () => {
  it('unknown host fails loud with the expected names', () => {
    const fx = freshFixture();
    const r = fx.run('check-staging.mjs', ['--host', 'wp81']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown host 'wp81'");
    expect(r.stderr).toContain('harmony|android|ios');
  });

  it('unknown --block host and unknown flags fail loud', () => {
    const fx = freshFixture();
    expect(fx.run('check-staging.mjs', ['--block', 'harmony,wp81']).status).toBe(2);
    const arg = fx.run('check-staging.mjs', ['--verbose']);
    expect(arg.status).toBe(2);
    expect(arg.stderr).toContain('unknown argument: --verbose');
  });

  it('a flag missing its value fails loud', () => {
    const fx = freshFixture();
    const r = fx.run('check-staging.mjs', ['--host']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--host requires a value');
  });

  it('--block parsing to zero host names fails loud', () => {
    const fx = freshFixture();
    const r = fx.run('check-staging.mjs', ['--block', ' , ']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--block value parsed to zero host names');
  });
});

describe('check-staging against the real repo (checkout-independent state)', () => {
  it('warn mode on the real tree: exit 0, ok, every host reported', () => {
    const r = runReal(['--json']);
    expect(r.status).toBe(0);
    const data = JSON.parse(r.stdout);
    expect(data.ok).toBe(true);
    expect(data.results.map((h) => h.host).sort()).toEqual(['android', 'harmony', 'ios']);
  });

  it('the real CLI refuses unknown hosts with exit 2', () => {
    const r = runReal(['--host', 'nope']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown host 'nope'");
  });
});

/** Run the REAL tools/check-staging.mjs from the repo checkout. */
function runReal(args) {
  const r = spawnSync(process.execPath, [join(REPO_ROOT, 'tools', 'check-staging.mjs'), ...args], {
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
