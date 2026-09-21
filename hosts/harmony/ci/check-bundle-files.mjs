#!/usr/bin/env node
// dsh:logging-exempt (dev script: console IS the product, like check.mjs)
/**
 * check-bundle-files.mjs — the #56-class drift guard for the harmony rawfile
 * closure (dsh-mobile#57 proposes making this a gate; until then it runs at
 * the end of ci/vendor-official.sh, inside run-host-e2e.sh's build step, and
 * standalone on demand).
 *
 * Index.ets's BUNDLE_FILES is the MATERIALIZATION LIST: every bundle-root
 * relative file the runtime half loads must be copied from rawfile into the
 * app cache dir before startSpike/hostStart. Two silent-drift directions
 * burned the m1 spike once (surprise ledger: a stale copy survived because
 * nothing compared the lists):
 *
 *   a rawfile file missing from BUNDLE_FILES  → never materialized; the
 *     runtime only fails loud at eval time (a bare-map loader error), so a
 *     leg that never runs it stays silently broken;
 *   a BUNDLE_FILES entry missing from rawfile → copyRawFile throws at launch.
 *
 * The check pins the invariant in BOTH directions against the rawfile/spike
 * tree ON DISK (the vendor script materializes it before any check runs):
 *
 *   every file under rawfile/spike (except the served-directly officialweb/
 *   assets) must appear in BUNDLE_FILES, and every BUNDLE_FILES entry must
 *   exist on disk.
 *
 * The disk walk (not git ls-files) matters: the pinned zod closure is
 * tracked-UNtracked deliberately (gitignore — verbatim upstream bytes the
 * syntax checker cannot parse; see .gitignore), yet it IS materialized into
 * the bundle and must stay listed.
 *
 * usage: hosts/harmony/ci/check-bundle-files.mjs   exit 0 = lists agree
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const rawRoot = join(root, 'hosts/harmony/entry/src/main/resources/rawfile/spike');
const indexEts = join(root, 'hosts/harmony/entry/src/main/ets/pages/Index.ets');

/** BUNDLE_FILES entries between the `const BUNDLE_FILES: string[] = [` and
 * the closing `];` — one quoted relative path per line. */
const bundleFiles = () => {
  const src = readFileSync(indexEts, 'utf8');
  const at = src.indexOf('const BUNDLE_FILES: string[] = [');
  if (at < 0) {
    throw new Error('check-bundle-files: BUNDLE_FILES not found in Index.ets');
  }
  const end = src.indexOf('];', at);
  const body = src.slice(at, end);
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

/** Every file on disk under rawfile/spike except officialweb/ (the served
 * -straight-from-rawfile assets, deliberately not materialized). */
const diskFiles = () => {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (full === join(rawRoot, 'officialweb')) {
          continue;
        }
        walk(full);
        continue;
      }
      out.push(relative(rawRoot, full));
    }
  };
  walk(rawRoot);
  return out;
};

const listed = new Set(bundleFiles());
const onDisk = diskFiles();
const missingFromList = onDisk.filter((rel) => !listed.has(rel)).sort();
const missingOnDisk = [...listed].filter((rel) => !onDisk.includes(rel)).sort();

if (missingFromList.length > 0 || missingOnDisk.length > 0) {
  console.error('check-bundle-files: FAIL — BUNDLE_FILES and rawfile/spike disagree');
  for (const rel of missingFromList) {
    console.error(`  rawfile file missing from BUNDLE_FILES: ${rel}`);
  }
  for (const rel of missingOnDisk) {
    console.error(`  BUNDLE_FILES entry missing from rawfile: ${rel}`);
  }
  process.exit(1);
}
console.log(`check-bundle-files: OK (${listed.size} listed = ${onDisk.length} rawfile files on disk, both directions)`);
