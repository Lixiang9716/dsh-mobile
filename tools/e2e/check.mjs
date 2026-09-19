#!/usr/bin/env node
/**
 * E2E verdict by logs — one-to-one expected<->logged match, per the
 * "E2E verification" contract in docs/ARCHITECTURE.md: for the manifest's
 * scenario, the captured log must contain exactly one structured entry per
 * expected event, in declaration order, nothing missing, nothing extra.
 * The failure report IS the diagnosis: it lists the first mismatched index
 * with both sides, plus any unparsable entries.
 *
 * tools/ dev script (out of the logging gate's scope; console IS the product).
 *
 * usage: check.mjs --manifest <scenarios/foo.json> --log <captured-log>
 *                  [--out <verdict.json>]   exit 0 = pass, 1 = fail.
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

/** Extract this scenario's structured records, in log order. */
const extract = (logText, manifest) => {
  const prefix = manifest.extract.prefix;
  const records = [];
  const parseErrors = [];
  logText.split('\n').forEach((line, i) => {
    const at = line.indexOf(prefix);
    if (at < 0) return;
    try {
      const rec = JSON.parse(line.slice(at + prefix.length).trim());
      const payload = Array.isArray(rec.data) ? rec.data[0] : undefined;
      if (payload && payload.scenario === manifest.scenario) {
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
  expected: { event: expect.event, match: expect.match },
  logged: rec ? { line: rec.line, payload: rec.payload } : null,
});

const matchOne = (expect, rec) => {
  if (!rec) return mismatch(expect, null);
  if (rec.payload.event !== expect.event) return mismatch(expect, rec);
  for (const [key, want] of Object.entries(expect.match ?? {})) {
    if (!deepEq(rec.payload[key], want)) return mismatch(expect, rec);
  }
  return null;
};

const run = () => {
  const args = parseArgs(process.argv.slice(2));
  const manifest = JSON.parse(readFileSync(args.manifest, 'utf8'));
  const { records, parseErrors } = extract(readFileSync(args.log, 'utf8'), manifest);

  const failures = [];
  for (let i = 0; i < manifest.expect.length; i++) {
    const rec = records[i];
    const bad = matchOne({ ...manifest.expect[i], index: i }, rec);
    if (bad) failures.push(bad);
  }
  if (records.length > manifest.expect.length) {
    failures.push({ extra: records.slice(manifest.expect.length).map((r) => r.payload) });
  }

  const verdict = {
    scenario: manifest.scenario,
    pass: failures.length === 0 && parseErrors.length === 0,
    expected: manifest.expect.length,
    logged: records.length,
    failures,
    parseErrors,
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
