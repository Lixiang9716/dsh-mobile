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
import { join, dirname, relative, basename, sep } from 'node:path';
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
      // BUNDLE_FILES entries are forward-slash relatives; a Windows readdir
      // yields backslash ones — normalize before the set comparisons.
      out.push(relative(rawRoot, full).split(sep).join('/'));
    }
  };
  walk(rawRoot);
  return out;
};

const listed = new Set(bundleFiles());
let onDisk = diskFiles();

// The upstream-suite job stages the transpiled corpus + test closure into
// rawfile/spike as UNTRACKED extras (vendor-official.sh --suite-extras; the
// extras manifest __files.txt lists them) — the suite HAP needs them beside
// the pinned bundle, while BUNDLE_FILES (the tracked tree) never lists them
// by design. When the extras manifest is present, those paths are counted
// SKIPS (surfaced, never silent) instead of missing-from-list drifts — the
// same posture the closures gate applies to untracked-but-closure files.
const extrasManifest = join(rawRoot, 'upstream-tests', '__files.txt');
let extrasSkipped = 0;
try {
  const nl = String.fromCharCode(10);
  const extras = readFileSync(extrasManifest, 'utf8').split(nl)
    .map((line) => line.trim()).filter((line) => line.length > 0);
  extras.push('upstream-tests/__files.txt'); // the manifest itself: staged beside the extras
  const extraSet = new Set(extras);
  // Pure extras only: a file BUNDLE_FILES also lists stays on disk (it is a
  // tracked entry — some suite-closure vendor files are).
  const before = onDisk.length;
  onDisk = onDisk.filter((rel) => listed.has(rel) || !extraSet.has(rel));
  extrasSkipped = before - onDisk.length;
} catch { /* no extras manifest — the standard tree */ }

// A hidden file can never reach the materialized bundle: the HAP packer
// drops dotfiles at packaging (measured 2026-09-30 — the pi-ai providers
// manifest's dot name died at materializeBundle on every device leg after
// #251 staged it), so listing one is a launch-time death and staging one is
// dead weight the both-directions check below would have to exempt. The
// seam (npm-bridges-pi-ai.js) reads such bytes through their non-hidden
// alias instead.
const hidden = onDisk.filter((rel) => basename(rel).startsWith('.')).sort();
if (hidden.length > 0) {
  console.error('check-bundle-files: FAIL — hidden files cannot ride the HAP (the packer drops dotfiles);'
    + ' stage their bytes under a non-hidden alias and read that from the seam:');
  for (const rel of hidden) {
    console.error(`  hidden rawfile file: ${rel}`);
  }
  process.exit(1);
}

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
