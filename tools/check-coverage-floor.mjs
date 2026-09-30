#!/usr/bin/env node
// tools/check-coverage-floor.mjs — the coverage-floor checker: reads the
// per-surface floors (tools/test/coverage-floors.json) and the measured
// per-surface vitest reports (<surface>/coverage/coverage-summary.json,
// produced by tools/test/run-coverage.sh), prints the surface table, and —
// with --enforce — exits 1 when any surface sits below its floor.
//
// Without --enforce it is the aggregator's reporter: below-floor surfaces
// print WARN and the exit stays 0. With --enforce it is the gate's deciding
// half (gates.json id `coverage-floor`, warn-tier via allowFailure).
//
// Fail-loud (rules.md rule 5): a surface with a floor but no report aborts
// naming the missing file — a missing measurement is a violation, never a
// silent pass.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENFORCE = process.argv.includes('--enforce');
const floorsArgIdx = process.argv.indexOf('--floors');
const FLOORS_PATH = floorsArgIdx > -1
  ? resolve(process.argv[floorsArgIdx + 1])
  : resolve(REPO, 'tools/test/coverage-floors.json');
const EPSILON = 1e-9;

const registry = JSON.parse(readFileSync(FLOORS_PATH, 'utf8'));
const surfaces = registry.surfaces ?? {};

if (Object.keys(surfaces).length === 0) {
  console.error(`check-coverage-floor: FAIL: no surfaces in ${FLOORS_PATH}`);
  process.exit(1);
}

const rows = [];
const violations = [];

for (const [surface, floor] of Object.entries(surfaces)) {
  const summaryPath = resolve(REPO, surface, 'coverage', 'coverage-summary.json');
  let summary;
  try {
    summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  } catch {
    violations.push(
      `${surface}: no coverage report at ${summaryPath} — run tools/test/run-coverage.sh first`,
    );
    rows.push({ surface, lines: '—', branches: '—', floor, verdict: 'NO REPORT' });
    continue;
  }
  const lines = summary.total?.lines?.pct;
  const branches = summary.total?.branches?.pct;
  if (typeof lines !== 'number' || typeof branches !== 'number') {
    violations.push(`${surface}: malformed summary ${summaryPath} (missing total.lines.pct / total.branches.pct)`);
    rows.push({ surface, lines: '??', branches: '??', floor, verdict: 'MALFORMED' });
    continue;
  }
  const below = [];
  if (lines + EPSILON < floor.lines) below.push(`lines ${lines} < floor ${floor.lines}`);
  if (branches + EPSILON < floor.branches) below.push(`branches ${branches} < floor ${floor.branches}`);
  const verdict = below.length === 0 ? 'PASS' : 'FAIL';
  if (below.length > 0) violations.push(`${surface}: ${below.join('; ')}`);
  rows.push({ surface, lines, branches, floor, verdict });
}

const width = Math.max(...rows.map((r) => r.surface.length), 'surface'.length);
console.log('');
console.log(`surface${' '.repeat(width - 'surface'.length)} |  lines% | branch% | floor (lines/branch) | verdict`);
console.log(`${'-'.repeat(width)}-+--------+---------+----------------------+--------`);
for (const r of rows) {
  const f = `${r.floor.lines}/${r.floor.branches}`;
  console.log(
    `${r.surface.padEnd(width)} | ${String(r.lines).padStart(6)} | ${String(r.branches).padStart(7)} | ${f.padStart(20)} | ${r.verdict}`,
  );
}
console.log('');

if (violations.length > 0) {
  for (const v of violations) console.error(`coverage-floor: ${ENFORCE ? 'FAIL' : 'WARN'}: ${v}`);
  if (ENFORCE) process.exit(1);
  console.log('coverage-floor: warn-tier — advisory only, the DAG stays green');
} else {
  console.log('coverage-floor: all surfaces at or above their floors');
}
