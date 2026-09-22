#!/usr/bin/env node
/**
 * E2E verdict by logs — one-to-one expected<->logged match, per the
 * "E2E verification" contract in docs/ARCHITECTURE.md: for the manifest's
 * scenario, the captured log must contain exactly one structured entry per
 * expected event, in declaration order, nothing missing, nothing extra.
 * The failure report IS the diagnosis: it lists the first mismatched index
 * with both sides, plus any unparsable entries.
 *
 * TWO exceptions to strict in-order matching, both proven by fixtures in
 * selftest.sh (rule 6):
 *
 * An expectation with "repeat": true greedily consumes one-or-more
 * consecutive records matching it (name + matchers). It exists for
 * genuinely nondeterministic stream cardinality — the real LLM legs' delta
 * counts (scenario llm.live-stream) — and still asserts "at least one, in this
 * position, matching these fields".
 *
 * An expectation with "order": "any" claims the FIRST unconsumed record
 * matching it, wherever that record sits in the log (a pre-pass before the
 * ordered walk). It exists for records whose position races other recorded
 * events by construction — the b4 session/journal attach lands between the
 * page's concurrent initial RPC answers, run to run — and still asserts
 * "exactly one such record exists in this log, matching these fields";
 * every other record must still match the ordered walk one-to-one.
 *
 * tools/ dev script (out of the logging gate's scope; console IS the product).
 *
 * usage: check.mjs --manifest <scenarios/foo.json> --log <captured-log>
 *                  [--out <verdict.json>] [--junit <verdict.xml>]
 *                  exit 0 = pass, 1 = fail. The --junit form is the SAME
 *                  verdict rendered for CI by junit.mjs, so a red scenario can
 *                  annotate the pull request instead of only reddening the step.
 *
 * Manifests default to the unified-logger envelope; "extract.envelope":
 * "flat" switches to a plain-JSON stream (gateway audit: one flat record per
 * line, matched on its top-level primitive/verdict/outcome fields).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { writeJUnit } from './junit.mjs';

const usage = () => {
  console.error('usage: check.mjs --manifest <json> --log <file> [--out <json>] [--junit <xml>]');
  process.exit(2);
};

const parseArgs = (argv) => {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || !argv[i + 1]) usage();
    args[argv[i].slice(2)] = argv[i + 1];
  }
  if (!args.manifest || !args.log) usage();
  return args;
};

const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Extract this scenario's structured records, in log order. Two envelopes:
 * the default unified-logger envelope ({"level",…,"data":[{scenario,…}]},
 * filtered on data[0].scenario) and "flat" (extract.envelope === "flat") for
 * out-of-band streams like the gateway audit log — records are plain JSON on
 * the line, matched at top level, no scenario field to filter on.
 */
const extract = (logText, manifest) => {
  const prefix = manifest.extract.prefix;
  const flat = manifest.extract.envelope === 'flat';
  const records = [];
  const parseErrors = [];
  logText.split('\n').forEach((line, i) => {
    const at = line.indexOf(prefix);
    if (at < 0) return;
    try {
      const rec = JSON.parse(line.slice(at + prefix.length).trim());
      const payload = flat ? rec : (Array.isArray(rec.data) ? rec.data[0] : undefined);
      if (payload && typeof payload === 'object' &&
          (flat || payload.scenario === manifest.scenario)) {
        records.push({ line: i + 1, payload });
      }
    } catch {
      parseErrors.push({ line: i + 1, text: line.trim() });
    }
  });
  return { records, parseErrors };
};

const mismatch = (expect, rec) => ({
  index: expect.index,
  expected: { event: expect.event, primitive: expect.primitive, match: expect.match },
  logged: rec ? { line: rec.line, payload: rec.payload } : null,
});

/** Name key of the record: "primitive" on flat streams, "event" otherwise. */
const nameKey = (expect) => (expect.primitive !== undefined ? 'primitive' : 'event');

const matchOne = (expect, rec) => {
  if (!rec) return mismatch(expect, null);
  const key = nameKey(expect);
  if (rec.payload[key] !== expect[key]) return mismatch(expect, rec);
  for (const [k, want] of Object.entries(expect.match ?? {})) {
    if (!deepEq(rec.payload[k], want)) return mismatch(expect, rec);
  }
  return null;
};

// Provenance: WHICH run produced this verdict. Without it a committed verdict
// file is indistinguishable from one this run earned, and a CI step that merely
// `cat`s the file reports a stale PASS as if it were today's result — measured
// live: a dev/ios run that exited before its checkers ran printed the committed
// 9/9. The reader (dev-ios.yml, "Report verdict") refuses a verdict whose runId
// is not the current run's. Empty outside CI, so local use is unchanged.
const provenance = () =>
  process.env.GITHUB_RUN_ID
    ? {
        runId: process.env.GITHUB_RUN_ID,
        commit: process.env.GITHUB_SHA || null,
        producedAt: new Date().toISOString(),
      }
    : {};


/**
 * The `order: "any"` pre-pass: such rows claim the first unconsumed record
 * matching them, wherever it sits (see header docs). One-to-one holds —
 * each row consumes exactly one record; the ordered walk covers all the
 * rest, so a missing or duplicated record still fails.
 */
const claimAnyOrder = (manifest, records, failures) => {
  const consumed = new Array(records.length).fill(false);
  const remaining = [];
  for (const raw of manifest.expect) {
    if (raw.order !== 'any') { remaining.push(raw); continue; }
    const j = records.findIndex((r, i) => !consumed[i] && matchOne(raw, r) === null);
    if (j === -1) failures.push(mismatch({ ...raw, index: -1 }, records[0] ?? null));
    else consumed[j] = true;
  }
  return { remaining, orderedRecords: records.filter((_, i) => !consumed[i]) };
};

const run = () => {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(args.manifest, 'utf8'));
  const { records, parseErrors } = extract(readFileSync(args.log, 'utf8'), manifest);

  const failures = [];
  const { remaining, orderedRecords } = claimAnyOrder(manifest, records, failures);
  let at = 0;
  for (let i = 0; i < remaining.length; i++) {
    const expect = { ...remaining[i], index: i };
    if (expect.repeat) {
      // Greedy run of one-or-more matching records (see header docs).
      let used = 0;
      while (at < orderedRecords.length && matchOne(expect, orderedRecords[at]) === null) {
        at += 1;
        used += 1;
      }
      if (used === 0) failures.push(mismatch(expect, orderedRecords[at]));
    } else {
      const bad = matchOne(expect, orderedRecords[at]);
      if (bad) failures.push(bad);
      at += 1;
    }
  }
  if (orderedRecords.length > at) {
    failures.push({ extra: orderedRecords.slice(at).map((r) => r.payload) });
  }

  const verdict = {
    scenario: manifest.scenario,
    pass: failures.length === 0 && parseErrors.length === 0,
    expected: manifest.expect.length,
    logged: records.length,
    failures,
    parseErrors,
    ...provenance(),
  };
  if (args.out) writeFileSync(args.out, JSON.stringify(verdict, null, 2) + '\n');
  // Written before the exit, so the verdict of a FAILING run reaches CI too —
  // a JUnit file that only exists on green is the report that never needed it.
  if (args.junit) writeJUnit(args.junit, [verdict]);
  if (verdict.pass) {
    console.log(`e2e: PASS ${verdict.scenario} (${verdict.expected}/${verdict.expected} events, in order)`);
  } else {
    console.error(`e2e: FAIL ${verdict.scenario}`);
    console.error(JSON.stringify(verdict, null, 2));
  }
  process.exit(verdict.pass ? 0 : 1);
};

run();
