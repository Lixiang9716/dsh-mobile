#!/usr/bin/env node
// tools/check-perf-budget.mjs — the performance TREND gate's deciding half:
// audits the two committed perf receipts (the perf.baseline measurement leg
// and the leak.canary leg) against baselines/perf-baseline.json — the
// recorded real numbers plus their warn-tier margins. Over margin = exit 1.
//
// The receipts are COMMITTED evidence (runtime/spike/artifacts/…), produced
// by runtime/spike/ci/run-perf-baseline.sh and run-leak-canary.sh — the gate
// audits, it does not re-run (the office-plane lesson's evidence-audit
// shape: a stale receipt is the runner's re-run away, and the baselines
// file's recordedAt names the run the numbers came from).
//
// Fail-loud (rules.md rule 5): a budget with no receipt, or a receipt
// missing the audited number, aborts naming the gap — a missing measurement
// is a violation, never a silent pass.
//
// Warn-tier: gates.json wires this with allowFailure (the first-version
// budgets are calibrated from ONE machine's run — red is recorded, never
// blocks, until a few machines have confirmed the margins).
//
// --budgets FILE / --artifacts-root DIR exist for the rule-6 rejection
// case, so its proof runs against a sandbox copy and never opens a mutation
// window on the real tree.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const budgetsArgIdx = process.argv.indexOf('--budgets');
const BUDGETS_PATH = budgetsArgIdx > -1
  ? resolve(process.argv[budgetsArgIdx + 1])
  : resolve(REPO, 'baselines/perf-baseline.json');
const artArgIdx = process.argv.indexOf('--artifacts-root');
const ART_ROOT = artArgIdx > -1
  ? resolve(process.argv[artArgIdx + 1])
  : REPO;

const budgets = JSON.parse(readFileSync(BUDGETS_PATH, 'utf8'));

/** Walk a dot path into the receipts; undefined = the audit gap itself. */
const walk = (obj, path) => path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);

const loadReceipt = (name) => {
  const rel = budgets.receipts[name];
  if (!rel) throw new Error(`${BUDGETS_PATH}: no receipt named "${name}"`);
  const path = resolve(ART_ROOT, rel);
  try {
    return { path, doc: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { path, doc: null };
  }
};

const receipts = {};
for (const name of Object.keys(budgets.receipts ?? {})) receipts[name] = loadReceipt(name);

const rows = [];
const violations = [];
for (const [id, b] of Object.entries(budgets.metrics ?? {})) {
  const receipt = receipts[b.receipt];
  if (!receipt) {
    violations.push(`${id}: budget names unknown receipt "${b.receipt}"`);
    rows.push({ id, measured: '—', baseline: b.baseline, margin: b.warnAbove, verdict: 'NO RECEIPT' });
    continue;
  }
  if (!receipt.doc) {
    violations.push(`${id}: no receipt at ${receipt.path} — run the leg's runner first (see the baselines file's receipts map)`);
    rows.push({ id, measured: '—', baseline: b.baseline, margin: b.warnAbove, verdict: 'NO RECEIPT' });
    continue;
  }
  const measured = walk(receipt.doc, b.path);
  if (typeof measured !== 'number') {
    violations.push(`${id}: receipt ${receipt.path} has no number at "${b.path}"`);
    rows.push({ id, measured: '??', baseline: b.baseline, margin: b.warnAbove, verdict: 'MALFORMED' });
    continue;
  }
  const over = measured > b.warnAbove;
  if (over) violations.push(`${id}: measured ${measured} > margin ${b.warnAbove} (baseline ${b.baseline})`);
  rows.push({ id, measured, baseline: b.baseline, margin: b.warnAbove, verdict: over ? 'FAIL' : 'PASS' });
}

if (rows.length === 0) {
  console.error(`check-perf-budget: FAIL: no metrics in ${BUDGETS_PATH}`);
  process.exit(1);
}

const width = Math.max(...rows.map((r) => r.id.length), 'metric'.length);
console.log('');
console.log(`metric${' '.repeat(width - 'metric'.length)} | measured | baseline | warn above | verdict`);
console.log(`${'-'.repeat(width)}-+---------+---------+-----------+-------`);
for (const r of rows) {
  console.log(
    `${r.id.padEnd(width)} | ${String(r.measured).padStart(8)} | ${String(r.baseline).padStart(8)} | ${String(r.margin).padStart(10)} | ${r.verdict}`,
  );
}
console.log('');
console.log(`machine: ${budgets.machine?.os ?? '?'} ${budgets.machine?.chip ?? ''} (${budgets.machine?.node ?? '?'}) — numbers are machine-local; recorded ${budgets.recordedAt}`);

if (violations.length > 0) {
  for (const v of violations) console.error(`perf-budget: FAIL: ${v}`);
  process.exit(1);
}
console.log('perf-budget: all measured numbers within their warn margins');
