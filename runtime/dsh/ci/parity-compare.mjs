#!/usr/bin/env node
// dsh:logging-exempt (verdict printer: exit code is the interface)
/**
 * parity-compare — diff the reference and port projections of the same
 * scripted turns. Both inputs are JSONL (one projected session record per
 * line); the reference comes from ci/parity-reference.mjs stdout, the port
 * leg's from the runner's extraction of the scenario stream.
 *
 * The comparison is structural and ordered: records must match one-to-one
 * (same seq, same type, deep-equal projected fields). The FIRST divergence
 * is reported with both records verbatim (fail loud, rule 5); identical
 * inputs print one verdict line and exit 0.
 *
 * usage: node parity-compare.mjs reference.jsonl port.jsonl
 */
import { readFileSync } from 'node:fs';

const [referencePath, portPath] = process.argv.slice(2);
if (typeof referencePath !== 'string' || typeof portPath !== 'string') {
  console.error('usage: parity-compare.mjs <reference.jsonl> <port.jsonl>');
  process.exit(2);
}

const load = (path) => readFileSync(path, 'utf8')
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

const reference = load(referencePath);
const port = load(portPath);

const count = Math.max(reference.length, port.length);
for (let i = 0; i < count; i++) {
  const left = reference[i];
  const right = port[i];
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    console.error(`parity: FIRST DIVERGENCE at record ${i}:`);
    console.error(`  reference: ${JSON.stringify(left ?? '<missing>')}`);
    console.error(`  port:      ${JSON.stringify(right ?? '<missing>')}`);
    process.exit(1);
  }
}

console.log(`parity: ${reference.length} record(s) identical (reference ${referencePath} == port ${portPath})`);
process.exit(0);
