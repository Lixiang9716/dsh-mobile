#!/usr/bin/env node
// dsh:logging-exempt (dev script: console IS the product, like check-staging.mjs)
/**
 * gen-staging-emit.mjs — the staging manifest CONSOLIDATION face (the
 * ledger's step three; check-staging verifies, gen-staging-manifests
 * derives, this emits and enforces).
 *
 * Single source: the DERIVATION (the import graph + the stagers' own pin
 * declarations) plus two small committed policy files for the rows no
 * derivation can see:
 *
 *   harmony-BUNDLE_FILES.rows         — the generated manifest (sorted):
 *                                       (derived − excluded) ∪ policy
 *   harmony-BUNDLE_FILES.policy.rows  — staged-without-an-edge rows (plugin
 *                                       files/manifests the loader reads,
 *                                       runner files): hand-declared, each
 *                                       row must exist on disk
 *   harmony-BUNDLE_FILES.exclude.rows — derived rows the host deliberately
 *                                       does not stage: hand-declared
 *
 * modes:
 *   --check <dir>  the enforcement gate: recompute the derivation and
 *                  verify the three committed files + the committed
 *                  Index.ets array match it exactly; ANY drift exits 1
 *                  with the remedy line (run --emit, review, commit).
 *   --emit <dir>   refresh the three files + splice the Index.ets array
 *                  block in place (the committed row ORDER is preserved —
 *                  the splice only adds/removes rows — so the first emit
 *                  on a correct tree is a no-op diff).
 *
 * The policy/exclude files are hand-DECLARED (a row there is a staging
 * decision a human made, reviewable in diffs); the derived rows are
 * machine-derived (never hand-edited — --check fails on drift). This is
 * what makes the manifest single-sourced: the 1007 graph/pin rows arrive
 * automatically on every new import, and only genuinely edge-less files
 * need a policy decision.
 *
 * Scope: harmony's BUNDLE_FILES (the derivation covers it completely).
 * The android/iOS scenario rosters are HOST POLICY (per-host staged
 * subsets, round-trip-verified by gen-staging-manifests) — consolidating
 * them needs a per-host policy-input redesign and is deliberately not
 * attempted here.
 *
 * usage:
 *   node tools/gen-staging-emit.mjs --emit <dir>
 *   node tools/gen-staging-emit.mjs --check <dir>
 * exit: 0 = the committed artifacts match the derivation · 1 = drift (the
 * remedy is printed) · 2 = usage/structure error.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { walkGraph, inScope } from './check-staging-graph.mjs';
import { buildHosts } from './check-staging-hosts.mjs';

const fail = (msg) => { throw new Error(`gen-staging-emit: ${msg}`); };

const FILES = 'hosts/harmony/entry/src/main/ets/pages/Index.ets';
const BLOCK_START = 'const BUNDLE_FILES: string[] = [';
const BLOCK_END = '\n];';
const ROW_RE = /'([^']+)'/g;

/** The committed Index.ets array rows, AS ORDERED (the splice preserves the
 * hand row order; only membership is generated). */
function committedRows() {
  const src = readFileSync(FILES, 'utf8');
  const at = src.indexOf(BLOCK_START);
  const end = src.indexOf(BLOCK_END, at);
  if (at < 0 || end < 0) fail('BUNDLE_FILES block not found in Index.ets');
  return { src, at, end, rows: [...src.slice(at, end).matchAll(ROW_RE)].map((m) => m[1]) };
}

/** Read one committed policy/exclude file (sorted unique rows). */
function readRows(dir, name) {
  const p = join(dir, name);
  if (!existsSync(p)) return { file: p, rows: [] };
  return { file: p, rows: [...new Set(readFileSync(p, 'utf8').split('\n')
    .map((l) => l.trim()).filter(Boolean))] };
}

/** The derivation half — the graph-reached rows in the checker's scope. */
function derivedRows() {
  const hosts = buildHosts();
  const reached = walkGraph(hosts.harmony.roots(hosts.harmony.surfaces)).reached;
  return [...reached.keys()].filter(inScope).sort();
}

/** Splice the Index.ets array block in place: preserve the committed row
 * order, append added rows (sorted) at the block's end, drop removed rows.
 * Returns whether the source changed. */
function spliceIndex(rows) {
  const { src, at, end, rows: current } = committedRows();
  const wanted = [...new Set(rows)];
  const kept = current.filter((r) => wanted.includes(r));
  const added = wanted.filter((r) => !current.includes(r)).sort();
  const next = [...kept, ...added];
  if (next.length === current.length && next.every((r, i) => r === current[i])) {
    return false;
  }
  const body = next.map((r) => `  '${r}',`).join('\n');
  const splice = `${BLOCK_START}\n${body}\n];`;
  writeFileSync(FILES, src.slice(0, at) + splice + src.slice(end + BLOCK_END.length), 'utf8');
  return true;
}

/** The emitted manifest = (derived − excluded) ∪ policy. Policy rows that no
 * longer exist on disk are dropped loudly (a deleted file must leave the
 * staging lists in the same commit). */
// The harmony primary surface judges existence against the STAGED rawfile
// tree (the same root ci/check-bundle-files.mjs pins): webclient/,
// credential-stage.js and npm-face rows live only there.
const STALE_ROOT = join('hosts/harmony/entry/src/main/resources/rawfile/dsh');

function manifestRows(dir, derived) {
  const policy = readRows(dir, 'harmony-BUNDLE_FILES.policy.rows');
  const excluded = readRows(dir, 'harmony-BUNDLE_FILES.exclude.rows');
  const gone = policy.rows.filter((r) => !existsSync(join(STALE_ROOT, r)));
  if (gone.length) fail(`policy rows name files the tree no longer has: ${gone.join(', ')}`);
  const excl = new Set(excluded.rows);
  const rows = [...new Set([...derived.filter((r) => !excl.has(r)), ...policy.rows])].sort();
  return { rows, policy, excluded };
}

/** --check: the committed Index.ets array + the three files must match the
 * derivation exactly. */
function check(dir) {
  if (!dir) fail('--check requires the artifacts directory');
  const derived = derivedRows();
  const { rows: committed } = committedRows();
  for (const name of ['harmony-BUNDLE_FILES.rows', 'harmony-BUNDLE_FILES.policy.rows',
    'harmony-BUNDLE_FILES.exclude.rows']) {
    if (!existsSync(join(dir, name))) {
      fail(`${name} is missing from ${dir} — run --emit ${dir} to generate it`);
    }
  }
  const { rows } = manifestRows(dir, derived);
  const drift = [];
  const a = new Set(rows);
  const b = new Set(committed);
  for (const r of rows) if (!b.has(r)) drift.push(`Index.ets lacks generated row: ${r}`);
  for (const r of committed) if (!a.has(r)) drift.push(`Index.ets carries a row the derivation does not name: ${r}`);
  const onDisk = readRows(dir, 'harmony-BUNDLE_FILES.rows').rows.join('\n');
  if (onDisk !== readFileSync(join(dir, 'harmony-BUNDLE_FILES.rows'), 'utf8').trim()) {
    drift.push('the committed .rows file drifted from its own bytes (line-ending noise?)');
  }
  if (drift.length) {
    console.error('gen-staging-emit: the generated manifest drifted — run'
      + ` \`node tools/gen-staging-emit.mjs --emit ${dir}\`, review, commit:`);
    for (const d of drift) console.error(`  DRIFT ${d}`);
    process.exitCode = 1;
    return;
  }
  console.log(`gen-staging-emit: generated manifest matches the derivation (${rows.length} rows)`);
}

/** --emit: refresh the three files + splice Index.ets. */
function emit(dir) {
  if (!dir) fail('--emit requires the artifacts directory');
  const derived = derivedRows();
  const { rows: committed } = committedRows();
  const derivedSet = new Set(derived);
  // First-emit capture: the committed rows the derivation does not name are
  // the declared POLICY; the derived rows the host deliberately does not
  // stage are the declared EXCLUDE. Both land as committed, hand-editable
  // files (a row's move between them is a staging decision in the diff).
  const policyName = 'harmony-BUNDLE_FILES.policy.rows';
  const excludeName = 'harmony-BUNDLE_FILES.exclude.rows';
  const carriedPolicy = readRows(dir, policyName).rows;
  const carriedExclude = readRows(dir, excludeName).rows;
  const policy = [...new Set([...carriedPolicy, ...committed.filter((r) => !derivedSet.has(r))])]
    .filter((r) => existsSync(join(STALE_ROOT, r))).sort();
  const excluded = [...new Set([...carriedExclude, ...derived.filter((r) => !committed.includes(r))])].sort();
  const rows = [...new Set([...derived.filter((r) => !excluded.includes(r)), ...policy])].sort();
  mkdirs(dir);
  writeFileSync(join(dir, policyName), `${policy.join('\n')}\n`);
  writeFileSync(join(dir, excludeName), `${excluded.join('\n')}\n`);
  writeFileSync(join(dir, 'harmony-BUNDLE_FILES.rows'), `${rows.join('\n')}\n`);
  const spliced = spliceIndex(rows);
  console.log(`gen-staging-emit: ${rows.length} rows (derived ${derived.length - excluded.length}`
    + ` + policy ${policy.length}) → ${dir}; Index.ets ${spliced ? 'spliced' : 'already current'}`);
}

function mkdirs(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function main() {
  const argv = process.argv.slice(2);
  const mode = argv[0];
  const dir = argv[1];
  if ((mode !== '--emit' && mode !== '--check') || !dir) {
    fail('usage: gen-staging-emit.mjs (--emit|--check) <artifacts-dir>');
  }
  if (mode === '--check') check(dir);
  else emit(dir);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 2;
}
