// dsh:logging-exempt (test file: assertions ARE the product)
/**
 * gen-staging-manifests.test.mjs — the staging GENERATOR's own net
 * (tools/gen-staging-manifests.mjs).
 *
 * The tool derives what each manifest must name from reality and reports the
 * round-trip delta; these tests pin the verdict semantics on a hermetic
 * fixture repo (real tool sources copied verbatim into a tmp repo): the
 * freeze-fatal classes exit 1 (a derived graph row missing from a committed
 * manifest — the fresh-install death class; a stage/verify twin drift; the
 * zod quadruple drifting apart), structural drift and absent pin trees exit
 * 2, and classified delta (extras the JS tree cannot see) stays report-only
 * with its classification intact in the JSON.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildGreenFixture, REPO, VER, ZOD_PIN, ZOD_ROWS,
} from './test/tools/helpers/staging-fixture.mjs';

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

const harmonyOf = (data) => data.reports.find((r) => r.host === 'harmony');
const androidOf = (data) => data.reports.find((r) => r.host === 'android');
const iosOf = (data) => data.reports.find((r) => r.host === 'ios');

describe('gen-staging-manifests green fixture: harmony parity', () => {
  it('exit 0: no freeze-fatal rows, harmony parity clean, zod quadruple agrees', () => {
    const fx = freshFixture();
    const r = fx.json('gen-staging-manifests.mjs');
    expect(r.status).toBe(0);
    expect(r.data.ok).toBe(true);
    expect(r.data.fatal).toEqual([]);
    const h = harmonyOf(r.data);
    expect(h.bundleFiles.missing).toEqual([]);
    expect(h.bundleFiles.extra).toEqual([]);
    expect(h.bundleFiles.dupes).toBe(0);
    expect(h.legs.map((l) => l.leg)).toEqual(['graph', 'dshpins', 'pinfiles', 'closure-faces', 'webclient']);
    expect(h.zodQuadruple.copiesAgree).toBe(true);
    expect(h.zodQuadruple.recomputed).toBe(ZOD_ROWS.length);
  });

  it('the summary line says the round trip holds', () => {
    const fx = freshFixture();
    const r = fx.run('gen-staging-manifests.mjs');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('staging-generate: round-trip holds · 0 freeze-fatal row(s)');
  });
});

describe('gen-staging-manifests green fixture: android and ios surfaces', () => {
  it('the android roster reports policy twins clean and no pins absent', () => {
    const fx = freshFixture();
    const r = fx.json('gen-staging-manifests.mjs');
    const a = androidOf(r.data);
    expect(a.twins).toEqual({
      scenarioStageVsVerify: [], pkgStageVsVerify: [], pkgVerifyVsStage: [],
      npmStageVsVerify: [], npmVerifyVsStage: [],
    });
    expect(a.pinsAbsent).toEqual([]);
    expect(a.graphRowsOutsideMirrors).toEqual([]);
    expect(a.scenarioRoster).toEqual({ rows: 2, onDisk: 2, unstagedByPolicy: 0 });
  });

  it('the ios surfaces carry every graph row; trees resolve on disk', () => {
    const fx = freshFixture();
    const r = fx.json('gen-staging-manifests.mjs');
    const i = iosOf(r.data);
    expect(i.resources.missingFromGraph).toEqual([]);
    expect(i.trees.rootsAbsentOnDisk).toEqual([]);
    expect(i.trees.mirrorRoots).toBeGreaterThanOrEqual(6);
    // the comprehension followed the py name list: one mirror root per name
    expect(i.trees.mirrorRoots).toBeGreaterThanOrEqual(2);
  });
});

describe('gen-staging-manifests freeze-fatal: manifests vs reality', () => {
  it('a derived graph row missing from BUNDLE_FILES → fatal, exit 1', () => {
    const fx = freshFixture();
    // a committed manifest that forgot a scoped closure row = the
    // fresh-install death class the generator exists to name
    const ets = join('hosts/harmony/entry/src/main/ets/pages/Index.ets');
    const src = fx.read(ets);
    fx.write(ets, src.replace("  'scenario/leg-a.js',\n", ''));
    const r = fx.run('gen-staging-manifests.mjs');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FATAL harmony BUNDLE_FILES missing graph row: scenario/leg-a.js');
    expect(r.stdout).toContain('staging-generate: ROUND-TRIP FATAL');
  });

  it('an OUT-of-scope missing row is classified delta, not fatal', () => {
    const fx = freshFixture();
    const ets = join('hosts/harmony/entry/src/main/ets/pages/Index.ets');
    const src = fx.read(ets);
    fx.write(ets, src.replace("  'vendor/npm/@noble/hashes@2.3.0/lib/index.js',\n", ''));
    const r = fx.json('gen-staging-manifests.mjs');
    expect(r.status).toBe(0);
    expect(r.data.ok).toBe(true);
    expect(harmonyOf(r.data).bundleFiles.missing).toContain('vendor/npm/@noble/hashes@2.3.0/lib/index.js');
  });

});

describe('gen-staging-manifests freeze-fatal: the android twins', () => {
  it('a stage/verify twin drift → fatal, exit 1', () => {
    const fx = freshFixture();
    // the verify twin forgets leg-a.js: stage would ship it, verify would
    // not check it — the drift class the twins leg exists for
    const sh = join('hosts/android/ci/stage-spine-closure.sh');
    fx.write(sh, fx.read(sh).replace(
      'for s in leg-a.js upstream-suite-leg.js; do test -f',
      'for s in upstream-suite-leg.js; do test -f',
    ));
    const r = fx.run('gen-staging-manifests.mjs');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FATAL android scenario twin drift: scenario/leg-a.js');
  });

  it('a graph row outside the android mirrors → fatal, exit 1', () => {
    const fx = freshFixture();
    // a new scenario file, imported by a staged entry, absent from the
    // hand list: no mirror covers it — the same defect check-staging
    // reports as a GAP, here as the generator's freeze-fatal class
    fx.writeSpike('scenario/leg-c.js', 'export const c = 1;\n');
    fx.writeSpike('scenario/upstream-suite-leg.js',
      "import './leg-a.js';\nimport './leg-c.js';\nimport '../upstream/helper.js';\n");
    const r = fx.run('gen-staging-manifests.mjs');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FATAL android graph row outside mirrors: scenario/leg-c.js');
  });

});

describe('gen-staging-manifests freeze-fatal: the zod quadruple', () => {
  it('the zod quadruple drifting apart is surfaced honestly (copiesAgree false)', () => {
    const fx = freshFixture();
    // the ios hand copy forgets errors.js: three hand copies disagree with
    // the recomputed closure — the drift that froze stale zod bytes. The
    // subset-without-lengths formula called this "agreement" (the union's
    // size never notices a MISSING row); the fixed formula must not.
    const py = join('hosts/ios/Tools/gen_bundle_header.py');
    fx.write(py, fx.read(py).replace('    "errors.js",\n', ''));
    const r = fx.json('gen-staging-manifests.mjs');
    expect(r.status).toBe(0); // report-only: BUNDLE_FILES itself is complete
    const z = harmonyOf(r.data).zodQuadruple;
    expect(z.copiesAgree).toBe(false);
    expect(z.iosZodFiles).toBe(ZOD_ROWS.length - 1);
    expect(z.bundleFiles).toBe(ZOD_ROWS.length);
    expect(z.recomputed).toBe(ZOD_ROWS.length);
    expect(r.data.fatal).toEqual([]);
  });

  it('a zod row missing from BUNDLE_FILES itself → fatal, exit 1', () => {
    const fx = freshFixture();
    const ets = join('hosts/harmony/entry/src/main/ets/pages/Index.ets');
    const src = fx.read(ets);
    fx.write(ets, src.replace(`  '${ZOD_PIN}/errors.js',\n`, ''));
    const r = fx.run('gen-staging-manifests.mjs');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`FATAL harmony BUNDLE_FILES missing zod closure row: ${ZOD_PIN}/errors.js`);
  });
});

describe('gen-staging-manifests classified delta (report-only extras)', () => {
  it('extras the JS walk cannot see come back with their classification', () => {
    const fx = freshFixture();
    // the extra rows' files exist on disk (rawfile mirror needs them);
    // none is derivable from today's legs — the classification is the point
    for (const rel of ['upstream/shims/npm-bridges.js', 'upstream/extra/row/manifest.json',
      'vendor/npm/cordis@4.0.2/LICENSE', 'deep/random/row.js']) {
      fx.writeSpike(rel, 'fixture bytes\n');
    }
    fx.addBundleRows([
      'upstream/shims/npm-bridges.js',
      'upstream/extra/row/manifest.json',
      'system-plugins/dsh-fs/lib/plugin.js',
      'vendor/npm/cordis@4.0.2/LICENSE',
      'logger.js',
      'deep/random/row.js',
    ]);
    const r = fx.json('gen-staging-manifests.mjs');
    expect(r.status).toBe(0);
    const byRow = new Map(harmonyOf(r.data).bundleFiles.extraClass.map((e) => [e.row, e.leg]));
    expect(byRow.get('upstream/shims/npm-bridges.js')).toMatch(/host-loader-namespace/);
    expect(byRow.get('upstream/extra/row/manifest.json')).toMatch(/runtime-data/);
    expect(byRow.get('system-plugins/dsh-fs/lib/plugin.js')).toMatch(/runtime-data/);
    expect(byRow.get('vendor/npm/cordis@4.0.2/LICENSE')).toMatch(/vendor-shape/);
    expect(byRow.get('logger.js')).toMatch(/e2e-harness/);
    expect(byRow.get('deep/random/row.js')).toBe('unclassified');
  });

  it('duplicate hand rows are counted on the AS-WRITTEN list, not swallowed', () => {
    const fx = freshFixture();
    const ets = join('hosts/harmony/entry/src/main/ets/pages/Index.ets');
    const src = fx.read(ets);
    fx.write(ets, src.replace('const BUNDLE_FILES: string[] = [',
      `const BUNDLE_FILES: string[] = [\n${Array.from({ length: 3 }, () => "  'logger.js',").join('\n')}`));
    const r = fx.json('gen-staging-manifests.mjs');
    expect(r.status).toBe(0);
    const bf = harmonyOf(r.data).bundleFiles;
    expect(bf.dupes).toBe(2);
    expect(bf.rawRows).toBeGreaterThan(bf.committed);
  });
});

describe('gen-staging-manifests structural drift fails loud (exit 2)', () => {
  it('a stager-named pin absent from the materialized tree fails loud (exit 2)', () => {
    const fx = freshFixture();
    // rule 5: a missing pin tree is a materialization failure, not an
    // empty leg that would silently rot the evidence green
    fx.removeTree(join('runtime/dsh', `vendor/dsh/brand@${VER}`));
    const r = fx.run('gen-staging-manifests.mjs');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(`dsh roster pins absent from the materialized tree: vendor/dsh/brand@${VER}`);
  });

  it('a seventh for-in list in the android script refuses to be guessed around', () => {
    const fx = freshFixture();
    const sh = join('hosts/android/ci/stage-spine-closure.sh');
    fx.write(sh, `${fx.read(sh)}\nfor pkg in extra-thing; do echo "$pkg"; done\n`);
    const r = fx.run('gen-staging-manifests.mjs');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('expected 2 dsh for-in lists in stage-spine-closure.sh, parsed 3');
  });

  it('a missing ZOD_SRC assignment fails loud (exit 2)', () => {
    const fx = freshFixture();
    const sh = join('hosts/android/ci/stage-spine-closure.sh');
    fx.write(sh, fx.read(sh).replace(`ZOD_SRC=$SPIKE/${ZOD_PIN}\n`, ''));
    const r = fx.run('gen-staging-manifests.mjs');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('ZOD_SRC assignment not found');
  });
});

describe('gen-staging-manifests artifacts and usage (exit 2)', () => {
  it('--out writes the generated rows and the machine-readable delta', () => {
    const fx = freshFixture();
    const out = join(fx.root, 'tmp', 'gen-artifacts');
    const r = fx.run('gen-staging-manifests.mjs', ['--out', out]);
    expect(r.status).toBe(0);
    const rowsFile = join(out, 'harmony-BUNDLE_FILES.rows');
    expect(existsSync(rowsFile)).toBe(true);
    const rows = readFileSync(rowsFile, 'utf8').split('\n').filter((l) => l.length > 0);
    expect(rows).toContain('scenario/leg-a.js');
    expect(rows.length).toBe(harmonyOf(JSON.parse(fx.run('gen-staging-manifests.mjs', ['--json']).stdout)).bundleFiles.derived);
    const delta = JSON.parse(readFileSync(join(out, 'delta.json'), 'utf8'));
    expect(delta.fatal).toEqual([]);
    expect(delta.reports.map((x) => x.host)).toEqual(['harmony', 'android', 'ios']);
  });

  it('unknown host fails loud (exit 2) — on the real CLI too', () => {
    const fx = freshFixture();
    const r = fx.run('gen-staging-manifests.mjs', ['--host', 'wp81']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown host 'wp81'");
    const real = spawnSync(process.execPath,
      [join(REPO_ROOT, 'tools', 'gen-staging-manifests.mjs'), '--host', 'wp81'], { encoding: 'utf8' });
    expect(real.status).toBe(2);
    expect(real.stderr).toContain("unknown host 'wp81'");
  });
});

describe('gen-staging-manifests against the real repo (materialized pins)', () => {
  // The vendored pins are materialized by runtime/dsh/vendor/ensure*.sh
  // (CI does the same before the gate DAG). What holds on ANY prepared
  // checkout: the tool runs to a verdict (never a crash), three host
  // reports parse, and the manifest-parsing legs all execute.
  it('runs to a verdict with three parseable host reports', () => {
    const real = spawnSync(process.execPath,
      [join(REPO_ROOT, 'tools', 'gen-staging-manifests.mjs'), '--json'], { encoding: 'utf8' });
    expect([0, 1]).toContain(real.status);
    const data = JSON.parse(real.stdout);
    expect(data.reports.map((r) => r.host)).toEqual(['harmony', 'android', 'ios']);
    expect(Array.isArray(data.fatal)).toBe(true);
    expect(harmonyOf(data).legs.map((l) => l.leg))
      .toEqual(['graph', 'dshpins', 'pinfiles', 'closure-faces', 'webclient']);
  });
});
