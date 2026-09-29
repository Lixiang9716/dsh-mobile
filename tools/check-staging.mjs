#!/usr/bin/env node
// dsh:logging-exempt (dev script: console IS the product, like check-bundle-files.mjs)
/**
 * check-staging.mjs — the P2 staging-manifest verifier.
 *
 * Every host's staging manifest is hand-maintained, and a hand list dies four
 * ways: the gate blocks the leg (门拦), the file is absent on device (真机死),
 * the list matches a stale tree so the leg passes against bytes that no
 * longer exist (假绿), or nothing compares the list to anything at all
 * (静默). ci/check-bundle-files.mjs already pins harmony's BUNDLE_FILES
 * against the rawfile tree; what NOTHING pins today is the list against the
 * REAL import graph — a new `import` added to the closure still boots green
 * in CI (the file is on the dev disk) and dies only on a fresh device
 * install, which is exactly the 2026-09 shims/ splits' failure class.
 *
 * This verifier walks the runtime closure's import graph from the boot
 * entries (upstream/boot.js, upstream/web-boot.js,
 * scenario/upstream-suite-leg.js) plus the scenario files each host's
 * staging names, resolving relative and bundle-root spellings (./x, ../x,
 * upstream/x, scenario/x, system-plugins/x, vendor/..., /vendor/...,
 * spike-root *.js) through the shims' export-from chains and the vendored
 * layout (vendor/dsh/<pkg>@<ver>/lib, vendor/npm/<pkg>@<ver>/...). node:*
 * and bare npm names are NOT followed — they resolve through the loader's
 * bridge/map rows (npm-bridges-*.js tables, the bare map), which are
 * themselves manifest rows checked by direction (b).
 *
 * It then checks each host's staging surfaces in two directions:
 *   (a) graph → manifest: every reached file under
 *       runtime/spike/{scenario,upstream,system-plugins} must be covered by
 *       the host's staging (an exact hand row or a whole-dir mirror the
 *       host's stager actually performs);
 *   (b) manifest → disk: every hand row must name a file that exists
 *       (stale rows — the list remembering a file the tree renamed).
 *
 * usage: node tools/check-staging.mjs [--host harmony|android|ios] [--json]
 * exit: 0 = clean · 1 = staging gaps or stale rows · 2 = usage/structure
 * error (a manifest this tool cannot parse is a manifest nobody can trust).
 *
 * NOT wired into a gate: the clean-run residual gap count goes to the owner
 * first; gate wiring is the owner's call after seeing it.
 *
 * Layout: the import-graph walker lives in check-staging-graph.mjs, the
 * three host manifest adapters (Index.ets rows, the android stage script's
 * copy blocks, the ios py RESOURCES/TREES lists) plus the host wiring in
 * check-staging-hosts.mjs; this file is the CLI — arg parsing,
 * orchestration, report/JSON emission. The split exists only for the
 * code-size gate; the three files together are this one tool.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, SPIKE, inScope, walkGraph } from './check-staging-graph.mjs';
import { fail, buildHosts } from './check-staging-hosts.mjs';

// --- the check --------------------------------------------------------------

/** Graph half of one host's check: its roots (fixed boot entries + the
 * staged scenario entries), the walk over them, and the check-(a) subset. */
function collectHostGraph(host) {
  const surfaces = host.surfaces;
  const roots = host.roots(surfaces);
  const missingRoots = roots.filter((r) => !existsSync(join(SPIKE, r)));
  const { reached, skippedBare, brokenEdges } = walkGraph(roots);
  const scoped = [...reached.keys()].filter(inScope).sort();
  return {
    roots, reached, scoped, skippedBare, brokenEdges, missingRoots,
    // The full reached closure (bundle-root paths, sorted) — the concrete
    // "staging list" the graph says each host must cover.
    reachedFiles: [...reached.keys()].sort(),
  };
}

/** One surface's two directions: (a) graph → manifest coverage gaps,
 * (b) manifest → disk stale rows. */
function checkSurface(surfaces, surface, scoped, reached) {
  const sres = { label: surface.label, rows: surface.rows ? surface.rows.length : surface.scenarioRows.length, gaps: [], stale: [], advisory: surface === surfaces.advisory };
  const rowList = surface.rows || surface.scenarioRows || [];
  // (a) graph → manifest
  for (const rel of scoped) {
    if (!surface.covers(rel, rowList, surface)) {
      const edge = reached.get(rel);
      sres.gaps.push({
        file: rel,
        via: `${edge.via}${edge.line ? `:${edge.line}` : ''}`,
        kind: edge.kind,
      });
    }
  }
  // (b) manifest → disk (stale rows)
  const staleBase = surface.staleRoot || SPIKE;
  const spikeRows = rowList.filter((r) => !r.includes('**'));
  for (const row of spikeRows) {
    if (!existsSync(join(staleBase, row))) sres.stale.push(row);
  }
  if (surface.outOfSpikeRows) {
    for (const r of surface.outOfSpikeRows) {
      if (!existsSync(join(REPO, r.rel))) sres.stale.push(`(repo) ${r.rel}`);
    }
    for (const m of surface.mirrorRoots) {
      const base = m.root === 'SPIKE' ? SPIKE : REPO;
      if (!existsSync(join(base, m.rel))) sres.stale.push(`(tree ${m.root}) ${m.rel}`);
    }
  }
  return sres;
}

function checkHost(host) {
  const g = collectHostGraph(host);
  const result = {
    host: host.label, roots: g.roots.length, reached: g.reached.size,
    scopedReached: g.scoped.length, skippedBare: g.skippedBare.size,
    brokenEdges: g.brokenEdges, missingRoots: g.missingRoots, surfaces: [],
    reachedFiles: g.reachedFiles,
  };
  for (const surface of Object.values(host.surfaces)) {
    result.surfaces.push(checkSurface(host.surfaces, surface, g.scoped, g.reached));
  }
  return result;
}

// --- report -----------------------------------------------------------------

function humanReport(results) {
  const lines = [];
  let failing = false;
  for (const r of results) {
    lines.push(`== host ${r.host} ==`);
    lines.push(`roots ${r.roots} · graph ${r.reached} files reached (${r.scopedReached} in scenario/upstream/system-plugins scope) · bare bridge/map imports skipped: ${r.skippedBare} distinct specifiers`);
    for (const e of r.brokenEdges) {
      lines.push(`  BROKEN EDGE ${e.from}:${e.line} imports '${e.spec}' (${e.kind}) — resolves to no file under runtime/spike`);
    }
    for (const s of r.surfaces) {
      const tag = s.advisory ? ' (advisory surface)' : '';
      lines.push(`surface ${s.label} — ${s.rows} hand rows${tag}`);
      // An advisory surface stages a deliberately narrower closure (the
      // officialweb mount boots a subset of the bundle), so its coverage
      // misses are context, not verdicts — cap the listing, keep the count.
      const gapList = s.advisory && s.gaps.length > 20 ? s.gaps.slice(0, 20) : s.gaps;
      for (const g of gapList) {
        lines.push(`  GAP ${g.file} — reached via ${g.via} (${g.kind}) — NOT staged`);
      }
      if (s.advisory && s.gaps.length > 20) {
        lines.push(`  … and ${s.gaps.length - 20} more advisory coverage misses (count only)`);
      }
      for (const st of s.stale) {
        lines.push(`  STALE ${st} — no such file`);
      }
      if (!s.advisory && (s.gaps.length || r.brokenEdges.length)) failing = true;
      if (s.stale.length) failing = true;
      if (!s.gaps.length && !s.stale.length) lines.push('  clean');
    }
    if (r.missingRoots.length) {
      failing = true;
      lines.push(`  MISSING ROOTS (staged scenario entry does not exist): ${r.missingRoots.join(', ')}`);
    }
  }
  return { lines, failing };
}

// --- main -------------------------------------------------------------------

/** argv → { '--host': name|null, '--json': bool }; anything else is a usage
 * error (exit 2 via fail). */
function parseArgs(argv) {
  const only = { '--host': null, '--json': false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--host') {
      if (!argv[i + 1]) fail('--host requires a value: harmony|android|ios');
      only['--host'] = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--json') only['--json'] = true;
    else fail(`unknown argument: ${argv[i]} (usage: node tools/check-staging.mjs [--host harmony|android|ios] [--json])`);
  }
  return only;
}

function main() {
  const only = parseArgs(process.argv.slice(2));
  const hosts = buildHosts();
  const selected = only['--host']
    ? [only['--host']]
    : Object.keys(hosts);
  for (const h of selected) {
    if (!hosts[h]) fail(`unknown host '${h}' (expected harmony|android|ios)`);
  }
  const results = selected.map((h) => checkHost(hosts[h]));
  const { lines, failing } = humanReport(results);
  if (only['--json']) {
    console.log(JSON.stringify({ ok: !failing, results }, null, 2));
  } else {
    console.log(lines.join('\n'));
  }
  process.exitCode = failing ? 1 : 0;
}

try {
  main();
} catch (err) {
  // Usage/structure errors (unparsable manifests, unknown flags/hosts) are
  // distinct from check findings: exit 2, message on stderr, no stack —
  // a manifest this tool cannot parse is a manifest nobody can trust.
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 2;
}
