#!/usr/bin/env node
/**
 * E2E verdict by logs — one-to-one expected<->logged match, per the
 * "E2E verification" contract in docs/ARCHITECTURE.md: for the manifest's
 * scenario, the captured log must contain exactly one structured entry per
 * expected event, in declaration order, nothing missing, nothing extra.
 * The failure report IS the diagnosis: it lists the first mismatched index
 * with both sides, plus any unparsable entries.
 *
 * ONE exception to one-to-one: an expectation with "repeat": true greedily
 * consumes one-or-more consecutive records matching it (name + matchers).
 * It exists for genuinely nondeterministic stream cardinality — the real
 * LLM legs' delta counts (scenario m2.llm) — and still asserts "at least
 * one, in this position, matching these fields"; it is proven by the
 * repeat fixtures in selftest.sh (rule 6).
 *
 * tools/ dev script (out of the logging gate's scope; console IS the product).
 *
 * usage: check.mjs --manifest <scenarios/foo.json> --log <captured-log>
 *                  [--out <verdict.json>]   exit 0 = pass, 1 = fail.
 *
 * Manifests default to the unified-logger envelope; "extract.envelope":
 * "flat" switches to a plain-JSON stream (gateway audit: one flat record per
 * line, matched on its top-level primitive/verdict/outcome fields).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const usage = () => {
  console.error('usage: check.mjs --manifest <json> --log <file> [--out <json>]');
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

const run = () => {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(args.manifest, 'utf8'));
  const { records, parseErrors } = extract(readFileSync(args.log, 'utf8'), manifest);

  const failures = [];
  let at = 0;
  for (let i = 0; i < manifest.expect.length; i++) {
    const expect = { ...manifest.expect[i], index: i };
    if (expect.repeat) {
      // Greedy run of one-or-more matching records (see header docs).
      let consumed = 0;
      while (at < records.length && matchOne(expect, records[at]) === null) {
        at += 1;
        consumed += 1;
      }
      if (consumed === 0) failures.push(mismatch(expect, records[at]));
    } else {
      const bad = matchOne(expect, records[at]);
      if (bad) failures.push(bad);
      at += 1;
    }
  }
  if (records.length > at) {
    failures.push({ extra: records.slice(at).map((r) => r.payload) });
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
  if (verdict.pass) {
    console.log(`e2e: PASS ${verdict.scenario} (${verdict.expected}/${verdict.expected} events, in order)`);
  } else {
    console.error(`e2e: FAIL ${verdict.scenario}`);
    console.error(JSON.stringify(verdict, null, 2));
  }
  process.exit(verdict.pass ? 0 : 1);
};

run();
