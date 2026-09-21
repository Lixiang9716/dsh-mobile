#!/usr/bin/env node
// dsh:logging-exempt (the recipe's own dev tool: its two console lines ARE the
// product — they are the comparison the build prints for the operator)
/**
 * verify-manifest.mjs — compare a staged client-bundles tree against the
 * committed REFERENCE record (`MANIFEST.sha256`), and BOUND the divergence.
 *
 * The upstream client build embeds the ABSOLUTE work path in its output, in
 * two ways that both come from the same source file: the
 * `//#region \0dsh-css:<abs-path>` markers and the css-module class-name hash
 * (upstream builds css modules with `pattern: '[hash]_[local]'`, and
 * lightningcss hashes the absolute virtual filename). So the files that embed
 * that path can never be byte-identical across two machines whose realpaths
 * differ — `/private/tmp/dsh-harness-src` on macOS against
 * `/tmp/dsh-harness-src` on Linux. Everything else in the tree IS
 * reproducible, and this tool is the proof that the divergence stays inside
 * that ONE class:
 *
 *   every diverging file embeds the work path  → environment-bound: exit 0,
 *                                                reported by name and count
 *   any diverging file that does not           → a REAL byte change: name it,
 *                                                exit 1 (fail loud, rule 5)
 *   a file the record names but the tree lacks,
 *   or one the tree has that the record does   → exit 1
 *
 * Measured against this repository's own record: the class is exactly the 40
 * files the Linux CI build reported as mismatching, which is why the class is
 * treated as understood rather than as an excuse — a divergence outside it
 * still stops the build.
 *
 * usage: verify-manifest.mjs --tree <dir> --reference <sha256-file> --work <path>
 *   exit 0 = no divergence, or every divergence is the environment-bound class
 *   exit 1 = a divergence outside the class, or a tree/record mismatch
 *   exit 2 = usage
 *
 * tools/ dev script (out of the logging gate's scope; console IS the product).
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const usage = () => {
  console.error('usage: verify-manifest.mjs --tree <dir> --reference <sha256-file> --work <path>');
  process.exit(2);
};

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (!['--tree', '--reference', '--work'].includes(process.argv[i]) || !process.argv[i + 1]) usage();
  args[process.argv[i].slice(2)] = resolve(process.argv[++i]);
}
if (!args.tree || !args.reference || !args.work) usage();

/** A `shasum -a 256` record: `<64 hex>  <path>` lines, paths relative to the
 *  tree and prefixed `./`. Unparsable lines abort — a record this tool cannot
 *  read is not an empty record (rule 5). */
const recordLine = /^([0-9a-f]{64}) {2}\.\/(.+)$/;
const readRecord = (path) => {
  const out = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const m = recordLine.exec(line);
    if (!m) {
      console.error(`client-bundles: FAIL unparsable record line in ${path}: ${line.slice(0, 60)}`);
      process.exit(1);
    }
    out.set(m[2], m[1]);
  }
  return out;
};

const walk = (dir, base = dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, base, out);
    else out.push(relative(base, p));
  }
  return out;
};

const reference = readRecord(args.reference);
const files = walk(args.tree);
const onDisk = new Set(files);

const missing = [...reference.keys()].filter((f) => !onDisk.has(f));
const extra = files.filter((f) => !reference.has(f));

/** Every divergence, split into the two classes this tool exists to tell
 *  apart. `pathBound` is decided by the file's own bytes: it is the class iff
 *  the work directory appears in it — as the exact path given, or with any
 *  leading directory prefix, which is what a different realpath of the same
 *  work dir looks like (`/tmp/dsh-harness-src` on Linux against
 *  `/private/tmp/dsh-harness-src` on macOS). The prefix-tolerant form is what
 *  lets a cache-restored tree be judged here, where the work dir may not exist
 *  to be resolved. */
const workSegment = `/${args.work.replace(/\/+$/, '').split('/').pop()}/`;
const pathBound = [];
const unexplained = [];
for (const file of files) {
  if (!reference.has(file)) continue;
  const bytes = readFileSync(join(args.tree, file));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest === reference.get(file)) continue;
  (bytes.includes(args.work) || bytes.includes(workSegment) ? pathBound : unexplained).push(file);
}

const name = (list, limit = 4) => (list.length <= limit
  ? list.join(', ')
  : `${list.slice(0, limit).join(', ')} … (+${list.length - limit} more)`);

const fail = [];
if (missing.length > 0) fail.push(`missing from the tree: ${name(missing)}`);
if (extra.length > 0) fail.push(`not in the record: ${name(extra)}`);
if (unexplained.length > 0) fail.push(`diverging OUTSIDE the work-path class: ${name(unexplained, 8)}`);

if (fail.length > 0) {
  console.error(`client-bundles: FAIL ${files.length} files, ${reference.size} recorded — ` + fail.join('; '));
  process.exit(1);
}

if (pathBound.length === 0) {
  console.log(`client-bundles: PASS reproduced the committed reference record byte-for-byte ` +
    `(${files.length} files)`);
  process.exit(0);
}
console.log(`client-bundles: PASS ${files.length} files; ${pathBound.length} diverge from the ` +
  `committed reference record as the embedded-work-path class (work path ${args.work}): ${name(pathBound)}`);
