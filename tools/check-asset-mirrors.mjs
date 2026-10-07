#!/usr/bin/env node
/* check-asset-mirrors.mjs — the product-tree ↔ host-mirror comparator.
 *
 * The #286-class drift: a product-tree file (presentation/web-client-next/
 * web/js/timeline.js, #279) moves while the host mirrors that ship its bytes
 * (android assets, harmony rawfile, the iOS embed) stay at the old version —
 * silent on a dev disk, stale on every fresh install, and (measured
 * 2026-10-01) invisible to the android stager's own --check because its
 * webclient loop's find(1) `./` prefix made is_tracked match nothing — the
 * whole tree verified as counted SKIPs. This tool is the cross-host face of
 * that comparison: ONE named surface that walks every product tree in the
 * mirror family and byte-compares each host mirror in BOTH directions
 * (mirror file stale/missing vs product, and mirror-only files — dead bytes
 * a sync would never refresh), plus the iOS embedder's tree declaration vs
 * the family (the D9 flip made generated freshness the iOS claim; the
 * declaration is what decides WHICH trees the embedder even carries).
 *
 * The mirror family is a declared policy row, not a glob: next + whale, the
 * two trees the stagers stage (stage-spine-closure.sh's `for client in next
 * whale`, vendor-official.sh's WEBCLIENT_DIRS, gen_bundle_header.py's
 * WEBCLIENT_TREES). A new web-client-* tree outside the family is reported
 * as an informational `outside-family` row — whether it must mirror is a
 * human call, not a glob's — while a FAMILY member whose product dir is
 * absent fails loud (rule 5).
 *
 * usage:
 *   node tools/check-asset-mirrors.mjs           # human report; exit 1 on drift
 *   node tools/check-asset-mirrors.mjs --json    # structured findings for the gate
 *
 * exit 0 = every family mirror byte-identical both ways + declarations aligned;
 * exit 1 = any finding (drift, missing/extra mirror file, declaration gap).
 * Gate wiring: `asset-mirrors` (allowFailure — warn grade); the blocking
 * teeth for android/harmony live in the closures gate's per-host --check,
 * which the `./` fix made real again. Rejection case:
 * .gov/rejections/case-asset-mirrors.sh.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const fail = (msg) => {
  console.error(`check-asset-mirrors: ${msg}`);
  process.exit(2);
};

// The family, in the stagers' own words. Adding a member = adding it to the
// two stagers AND gen_bundle_header.py's WEBCLIENT_TREES, then a row here.
const FAMILY = ['next', 'whale'];
const PRODUCT_DIR = (name) => join(ROOT, 'presentation', `web-client-${name}`);
// (label, mirror path builder) — the committed copies the platform builds consume.
const MIRRORS = [
  ['android', (name) => join(ROOT, 'hosts', 'android', 'app', 'src', 'main', 'assets', 'dsh', `webclient-${name}`)],
  ['harmony', (name) => join(ROOT, 'hosts', 'harmony', 'entry', 'src', 'main', 'resources', 'rawfile', 'dsh', 'webclient', `dsh-web-client-${name}`)],
];
const IOS_EMBEDDER = join(ROOT, 'hosts', 'ios', 'Tools', 'gen_bundle_header.py');

const walk = (dir) => {
  const out = [];
  const visit = (cur) => {
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      const p = join(cur, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.isFile()) out.push(relative(dir, p).split('\\').join('/'));
    }
  };
  visit(dir);
  return out.sort();
};

const bytes = (p) => readFileSync(p);
const sameBytes = (a, b) => bytes(a).equals(bytes(b));

const findings = [];
const outsideFamily = [];
const hosts = [];

for (const name of FAMILY) {
  const src = PRODUCT_DIR(name);
  if (!statSync(src, { throwIfNoEntry: false })?.isDirectory?.()) {
    findings.push({ host: '*', tree: `web-client-${name}`, kind: 'family-dir-absent', file: `presentation/web-client-${name}` });
    continue;
  }
  const srcFiles = walk(src);
  const perHost = { tree: `web-client-${name}`, mirrors: [] };
  for (const [host, mirrorPath] of MIRRORS.map(([h, f]) => [h, f(name)])) {
    const row = { host, files: srcFiles.length, stale: [], missing: [], extra: [] };
    if (!statSync(mirrorPath, { throwIfNoEntry: false })?.isDirectory?.()) {
      findings.push({ host, tree: `web-client-${name}`, kind: 'mirror-dir-absent', file: relative(ROOT, mirrorPath) });
      row.missing.push('<mirror dir>');
    } else {
      const dstFiles = new Set(walk(mirrorPath));
      for (const rel of srcFiles) {
        if (!dstFiles.has(rel)) {
          row.missing.push(rel);
          findings.push({ host, tree: `web-client-${name}`, kind: 'mirror-file-missing', file: rel });
        } else if (!sameBytes(join(src, rel), join(mirrorPath, rel))) {
          row.stale.push(rel);
          findings.push({ host, tree: `web-client-${name}`, kind: 'mirror-stale', file: rel });
        }
      }
      for (const rel of dstFiles) {
        if (!srcFiles.includes(rel)) {
          row.extra.push(rel);
          findings.push({ host, tree: `web-client-${name}`, kind: 'mirror-file-extra', file: rel });
        }
      }
    }
    perHost.mirrors.push(row);
  }
  hosts.push(perHost);
}

// presentation/ trees outside the family — informational, never a verdict.
const presDir = join(ROOT, 'presentation');
for (const e of readdirSync(presDir, { withFileTypes: true })) {
  if (e.isDirectory() && e.name.startsWith('web-client-') &&
      !FAMILY.includes(e.name.slice('web-client-'.length))) {
    outsideFamily.push(e.name);
  }
}

// The iOS embedder's declaration must name exactly the family: a member it
// omits ships no iOS bytes; a row it names beyond the family embeds a tree
// the stagers don't maintain.
const embedderSrc = readFileSync(IOS_EMBEDDER, 'utf8');
const declRows = [...embedderSrc.matchAll(/\("webclient-([a-z0-9-]+)",\s*REPO\s*\/\s*"presentation"\s*\/\s*"web-client-([a-z0-9-]+)"/g)]
  .map((m) => m[1]);
for (const name of FAMILY) {
  if (!declRows.includes(name)) {
    findings.push({ host: 'ios', tree: `web-client-${name}`, kind: 'embedder-declaration-missing', file: 'WEBCLIENT_TREES' });
  }
}
for (const row of declRows) {
  if (!FAMILY.includes(row)) {
    findings.push({ host: 'ios', tree: `webclient-${row}`, kind: 'embedder-declaration-extra', file: 'WEBCLIENT_TREES' });
  }
}

const json = process.argv.includes('--json');
if (json) {
  console.log(JSON.stringify({ ok: findings.length === 0, family: FAMILY, hosts, findings, outsideFamily }, null, 2));
} else {
  for (const h of hosts) {
    for (const m of h.mirrors) {
      console.log(`check-asset-mirrors: ${h.tree} → ${m.host}: ${m.files} files · stale ${m.stale.length} · missing ${m.missing.length} · extra ${m.extra.length}`);
    }
  }
  for (const f of findings) {
    console.log(`::error::check-asset-mirrors: ${f.kind}: ${f.tree}/${f.file} (${f.host})`);
  }
  if (outsideFamily.length) {
    console.log(`check-asset-mirrors: outside the mirror family (informational): ${outsideFamily.join(', ')}`);
  }
  console.log(findings.length === 0
    ? 'check-asset-mirrors: every family mirror byte-identical both ways; embedder declaration aligned'
    : `check-asset-mirrors: ${findings.length} finding(s) — re-stage with build/build.sh sync <platform>`);
}
process.exit(findings.length === 0 ? 0 : 1);
