#!/usr/bin/env node
// dsh:logging-exempt (dev script: console IS the product, like check-staging.mjs)
/**
 * gen-staging-manifests.mjs — the P2 staging-manifest GENERATOR (the ledger's
 * step two; tools/check-staging.mjs is step one, the verifier).
 *
 * check-staging proves graph→list in one direction; the hand lists themselves
 * stay hand (a missed row freezes a shim silently on a fresh install). This
 * tool flips the flow: it DERIVES what each manifest must name from reality —
 * the closure's import graph plus the materialized vendor trees — under the
 * staging policy the stagers themselves declare, and reports the round-trip
 * delta against the committed manifests row by row. Phase 2 ships the
 * generator + the delta ONLY: the committed manifests are not replaced (that
 * flip, and emitting the hosts' source blocks from here, is the post-
 * hardening step), so today the tool is evidence, not authority.
 *
 * Derivation legs (mechanics in gen-staging-legs.mjs):
 *   graph    — check-staging's walkGraph over each host's roots; the roots'
 *              scenario roster is policy, taken from the host's own manifest
 *              (ios: every on-disk scenario — its whole-dir mirror rule);
 *   dshpins  — every materialized vendor/dsh/<pkg>@<ver> expands to
 *              package.json + lib/** (−.d.ts) + presets/** (the stage_pkg /
 *              suite-extras rule);
 *   pinfiles — noble *.js, pi-ai js+json, the goal trio js+json, zod's
 *              recomputed import closure; npm single-file faces are policy,
 *              extracted verbatim from vendor-official.sh's CLOSURE rows;
 *   webcl    — presentation/web-client{,-next,-whale} at their staged names.
 *
 * Round-trip verdicts: a derived graph-leg row missing from a committed
 * manifest is the fresh-install death class → exit 1. Everything else
 * (extras, duplicate hand rows, ordering the graph cannot dictate,
 * host-loader-namespace rows the JS tree cannot see) is reported as
 * classified delta — discovering a manifest typo IS the deliverable, so none
 * of it is silently normalized away.
 *
 * usage: node tools/gen-staging-manifests.mjs [--host harmony|android|ios]
 *                                            [--out DIR] [--json]
 * exit: 0 = the derived graph closure is covered by every committed manifest
 *       1 = a derived graph-leg row is missing from a committed manifest
 *       2 = usage/structure error (a manifest this tool cannot parse is a
 *           manifest nobody can trust)
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, SPIKE, walkGraph, inScope } from './check-staging-graph.mjs';
import { buildHosts } from './check-staging-hosts.mjs';
import {
  dirPinRows, zodClosureRows, webclientRows, dshRosterRows,
} from './gen-staging-legs.mjs';

const fail = (msg) => { throw new Error(`gen-staging-manifests: ${msg}`); };

// --- committed-source policy extraction -------------------------------------

// Quote-bearing patterns are built via new RegExp from plain strings: a quote
// inside a regex LITERAL desyncs govrail's code-size string tracking and
// ghosts phantom INDENT violations (govrail#411) — see check-staging-graph.mjs.
const ETS_ROW = new RegExp("'([^']+)'", 'g');
const PY_ROW = new RegExp('"([^"]*)"', 'g');
const SHELL_ASSIGN = (name) => new RegExp(`^${name}="(.*)"$`, 'm');

/** Raw (pre-dedup) BUNDLE_FILES rows — dup counting needs the list AS hand-
 * written, not the verifier's Set view. */
function bundleRawRows() {
  const file = join(REPO, 'hosts/harmony/entry/src/main/ets/pages/Index.ets');
  const src = readFileSync(file, 'utf8');
  const at = src.indexOf('const BUNDLE_FILES: string[] = [');
  const end = src.indexOf('\n];', at);
  if (at < 0 || end < 0) fail('BUNDLE_FILES block not found in Index.ets');
  return { file, rows: [...src.slice(at, end).matchAll(ETS_ROW)].map((m) => m[1]) };
}

/** android stage-spine-closure.sh: the `for s in` scenario rosters and the
 * for-pkg lists (stage + verify twins for each) — kept separate so twin drift
 * is reportable. The script carries SIX for-in lists (scenario/dsh/npm ×
 * stage/verify); they are classified by content, and anything else is a
 * structural drift this tool refuses to guess around. */
function androidScriptFacts() {
  const file = join(REPO, 'hosts/android/ci/stage-spine-closure.sh');
  const src = readFileSync(file, 'utf8');
  const lists = [...src.matchAll(/for (?:pkg|s) in ([^;]+); do/g)]
    .map((m) => m[1].replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean));
  const kind = (l) => (l.some((x) => x.endsWith('.js')) ? 'scenario'
    : l.every((x) => x.startsWith('dsh-')) ? 'npm' : 'dsh');
  const byKind = { scenario: [], npm: [], dsh: [] };
  for (const l of lists) byKind[kind(l)].push(l);
  for (const k of Object.keys(byKind)) {
    if (byKind[k].length !== 2) fail(`expected 2 ${k} for-in lists in stage-spine-closure.sh, parsed ${byKind[k].length}`);
  }
  const ver = src.match(/^VER=(\S+)$/m);
  if (!ver) fail('VER assignment not found in stage-spine-closure.sh');
  const zod = src.match(/^ZOD_SRC=\$SPIKE\/(\S+)$/m);
  if (!zod) fail('ZOD_SRC assignment not found in stage-spine-closure.sh');
  return {
    file,
    ver: ver[1],
    zodPin: zod[1],
    scenarioStage: byKind.scenario[0].map((s) => `scenario/${s}`),
    scenarioVerify: byKind.scenario[1].map((s) => `scenario/${s}`),
    pkgStage: byKind.dsh[0],
    pkgVerify: byKind.dsh[1],
    npmStage: byKind.npm[0],
    npmVerify: byKind.npm[1],
  };
}

/** The pin dirs a `$(cd runtime/spike && find … | LC_ALL=C sort)` segment in
 * vendor-official.sh names — the generated-at-stage-time rows whose pin CHOICE
 * is still the script's own declaration. Both find segments are parsed; the
 * vendor/npm ones are the goal-trio faces the BUNDLE_FILES derivation walks. */
function findSpanPinDirs(src, face) {
  const span = new RegExp('\\$\\(cd runtime/spike && find ([\\s\\S]*?)\\| LC_ALL=C sort\\)', 'g');
  const dirs = new Set();
  for (const m of src.matchAll(span)) {
    for (const tok of m[1].replace(/\\\n/g, ' ').split(/\s+/)) {
      if (tok.startsWith(`${face}/`)) dirs.add(tok);
    }
  }
  return [...dirs].sort();
}

/** vendor-official.sh's own declarations: SPINE_PKG_DSH (the find-segment pin
 * roster), the NOBLE/PIAI staged dirs, and the goal-trio faces its generated
 * find segment names. Every pin version this tool derives comes from these
 * declarations (or android's VER=) — never a local copy. */
function closureScriptFacts() {
  const file = join(REPO, 'hosts/harmony/ci/vendor-official.sh');
  const src = readFileSync(file, 'utf8');
  const pkg = src.match(SHELL_ASSIGN('SPINE_PKG_DSH'));
  const noble = src.match(SHELL_ASSIGN('NOBLE_DIR'));
  const piai = src.match(SHELL_ASSIGN('PIAI_DIR'));
  if (!pkg || !noble || !piai) fail('SPINE_PKG_DSH/NOBLE_DIR/PIAI_DIR not found in vendor-official.sh');
  const goalTrio = findSpanPinDirs(src, 'vendor/npm');
  if (!goalTrio.length) fail('no vendor/npm pin dirs in the find segments of vendor-official.sh (goal trio)');
  return {
    file,
    spinePkgs: pkg[1].trim().split(/\s+/).sort(),
    noble: noble[1], piai: piai[1],
    goalTrio,
  };
}

/** The dsh pin-name roster the three stagers jointly declare: SPINE_PKG_DSH
 * (harmony's find segments) ∪ android's stage loop ∪ iOS TREES comprehension
 * + the dsh pins iOS RESOURCES names. NOT a glob of the materialized tree —
 * the tree also holds the test-closure pins, which no runtime manifest
 * stages. */
function dshPinRoster(hosts, facts, closure) {
  const iosMirrors = hosts.ios.surfaces.primary.mirrorRoots
    .map((m) => m.rel.match(/^vendor\/dsh\/([^@]+)@/)?.[1])
    .filter(Boolean);
  const iosResources = hosts.ios.surfaces.primary.rows
    .filter((r) => r.startsWith('vendor/dsh/'))
    .map((r) => r.split('/')[2].replace(/@.*$/, ''));
  return [...new Set([...closure.spinePkgs, ...facts.pkgStage, ...iosMirrors, ...iosResources])].sort();
}

// --- derivation -------------------------------------------------------------

const WEBCLIENT_TREES = [
  { dir: 'presentation/web-client', staged: 'dsh-web-client' },
  { dir: 'presentation/web-client-next', staged: 'dsh-web-client-next' },
  { dir: 'presentation/web-client-whale', staged: 'dsh-web-client-whale' },
];

/** One stager-named pin subtree — the dir MUST exist. A missing pin tree is
 * not an empty leg, it is a materialization failure that would silently rot
 * the evidence (a bumped pin leaves the old rows "extra" and the report
 * green); rules.md rule 5: fail loud, naming the dir (exit 2). */
function pinRowsOrFail(pin, opts) {
  if (!existsSync(join(SPIKE, pin))) {
    fail(`pin tree absent: ${pin} — a stager names it; runtime/spike/vendor/ensure*.sh materializes the pins`);
  }
  return dirPinRows(SPIKE, pin, opts) ?? [];
}

/** Every leg for harmony's BUNDLE_FILES, kept per-leg so the delta can
 * attribute each row to the reality that demands it. Every pin/version comes
 * from the stagers' own declarations (facts/closure) — no local copies. */
function deriveBundleFiles(host, closureRows, roster, facts, closure) {
  const legs = new Map();
  legs.set('graph', [...walkGraph(host.roots(host.surfaces)).reached.keys()].sort());
  const dsh = dshRosterRows(SPIKE, roster, facts.ver);
  if (dsh.absent.length) fail(`dsh roster pins absent from the materialized tree: ${dsh.absent.join(', ')}`);
  legs.set('dshpins', dsh.rows);
  legs.set('pinfiles', [
    ...pinRowsOrFail(closure.noble, { exts: ['.js'] }),
    ...pinRowsOrFail(closure.piai, { exts: ['.js', '.json'] }),
    ...closure.goalTrio.flatMap((p) => pinRowsOrFail(p, { exts: ['.js', '.json'] })),
    ...zodClosureRows(SPIKE, facts.zodPin),
  ]);
  legs.set('closure-faces', closureRows.filter((r) => r.startsWith('vendor/')).sort());
  const wc = webclientRows(REPO, WEBCLIENT_TREES);
  legs.set('webclient', wc.rows);
  return { legs, webclientMissing: wc.missing }; // dsh.absent non-empty already failed above
}

// --- set helpers -------------------------------------------------------------

const setDelta = (name, derivedRows, committedRows) => {
  const d = new Set(derivedRows);
  const c = new Set(committedRows);
  return {
    surface: name, derived: d.size, committed: c.size,
    missing: [...d].filter((r) => !c.has(r)).sort(),
    extra: [...c].filter((r) => !d.has(r)).sort(),
    dupes: committedRows.length - c.size,
  };
};

/** Why a committed row is not derivable from today's legs — the honest
 * classification the delta report exists to carry. */
function classifyExtra(row) {
  if (row.startsWith('upstream/shims/')) return 'host-loader-namespace: bare-map/runtime-module reach the JS walk cannot see';
  if (row.endsWith('manifest.json')) return 'runtime-data: plugin loader reads manifests, no import edge exists';
  if (row.startsWith('system-plugins/')) return 'runtime-data: plugin file referenced from a manifest, not an import';
  if (/^vendor\/npm\/.*(lib\/(index|client)\.js)$/.test(row)) return 'host-loader-namespace: the loader bridge resolves the npm face, no JS import edge';
  if (row.startsWith('vendor/')) return 'vendor-shape: staged under a pin shape no stager rule emits (util-crypto docs/LICENSE)';
  if (!row.includes('/')) return 'e2e-harness: spike-root file staged for the runner, not reached from the boot graph';
  return 'unclassified';
}

const mirrorCovers = (rel, roots) => roots.some((r) => (r.endsWith('/**')
  ? rel.startsWith(r.slice(0, -2))
  : rel === r || rel.startsWith(`${r}/`)));

/** ios gen_bundle_header.py's ZOD_FILES rows — the third hand copy of the zod
 * closure (BUNDLE_FILES and the CLOSURE carry the other two). */
function iosZodFiles() {
  const file = join(REPO, 'hosts/ios/Tools/gen_bundle_header.py');
  const src = readFileSync(file, 'utf8');
  const at = src.indexOf('ZOD_FILES = [');
  const end = src.indexOf('\n]', at);
  if (at < 0 || end < 0) fail('ZOD_FILES block not found in gen_bundle_header.py');
  return [...src.slice(at, end).matchAll(PY_ROW)].map((m) => m[1]);
}

// --- host round-trips -------------------------------------------------------

function roundTripHarmony(hosts, facts, closure) {
  const h = hosts.harmony;
  const raw = bundleRawRows();
  const committed = h.surfaces.primary.rows;
  const closureRows = h.surfaces.advisory.rows;
  const roster = dshPinRoster(hosts, facts, closure);
  const { legs, webclientMissing } = deriveBundleFiles(h, closureRows, roster, facts, closure);
  const derived = [...new Set([...legs.values()].flat())].sort();
  const bf = setDelta('Index.ets BUNDLE_FILES', derived, committed);
  bf.extraClass = bf.extra.map((row) => ({ row, leg: classifyExtra(row) }));
  bf.rows = derived; // the generated content: what Phase 3 would commit in place
  bf.dupes = raw.rows.length - new Set(raw.rows).size; // count the AS-WRITTEN hand list
  const zod = facts.zodPin;
  const zodHand = committed.filter((r) => r.startsWith(`${zod}/`));
  const zodDerived = zodClosureRows(SPIKE, zod);
  const zodClosureHand = closureRows.filter((r) => r.startsWith(`${zod}/`));
  const zodIos = iosZodFiles().map((r) => `${zod}/${r}`);
  return {
    host: 'harmony',
    bundleFiles: { ...bf, rawRows: raw.rows.length, file: raw.file },
    legs: [...legs.entries()].map(([leg, rows]) => ({ leg, rows: rows.length })),
    roster: { names: roster.length },
    webclientSourceMissing: webclientMissing,
    zodQuadruple: {
      pin: zod,
      recomputed: zodDerived.length,
      bundleFiles: zodHand.length, closure: zodClosureHand.length, iosZodFiles: zodIos.length,
      copiesAgree: new Set([...zodHand, ...zodClosureHand, ...zodIos]).size === zodHand.length
        && zodHand.length === zodDerived.length,
      missingFromRecomputed: zodDerived.filter((r) => !zodHand.includes(r)),
    },
  };
}

function roundTripAndroid(hosts, facts) {
  const a = hosts.android;
  const onDisk = readdirSync(join(SPIKE, 'scenario'))
    .filter((f) => f.endsWith('.js')).map((f) => `scenario/${f}`).sort();
  const reached = [...walkGraph(a.roots(a.surfaces)).reached.keys()];
  const mirrors = a.surfaces.primary.mirrors;
  const covered = (r) => mirrorCovers(r, mirrors) || facts.scenarioStage.includes(r);
  const graphRowsOutsideMirrors = reached.filter((r) => inScope(r) && !covered(r)).sort();
  const twins = {
    scenarioStageVsVerify: facts.scenarioStage.filter((r) => !facts.scenarioVerify.includes(r)),
    pkgStageVsVerify: facts.pkgStage.filter((p) => !facts.pkgVerify.includes(p)),
    pkgVerifyVsStage: facts.pkgVerify.filter((p) => !facts.pkgStage.includes(p)),
    npmStageVsVerify: facts.npmStage.filter((p) => !facts.npmVerify.includes(p)),
    npmVerifyVsStage: facts.npmVerify.filter((p) => !facts.npmStage.includes(p)),
  };
  const pinAbs = (p) => (/^dsh-/.test(p)
    ? `vendor/npm/@deepseek-ai/${p}@${facts.ver}` : `vendor/dsh/${p}@${facts.ver}`);
  const pinsAbsent = [...new Set([...facts.pkgStage, ...facts.pkgVerify, ...facts.npmStage, ...facts.npmVerify])]
    .map(pinAbs).filter((p) => !existsSync(join(SPIKE, p)));
  return {
    host: 'android',
    file: facts.file,
    scenarioRoster: {
      rows: facts.scenarioStage.length, onDisk: onDisk.length,
      unstagedByPolicy: onDisk.filter((r) => !facts.scenarioStage.includes(r)).length,
    },
    mirrors,
    graphRowsOutsideMirrors,
    twins,
    pinsAbsent,
  };
}

function roundTripIos(hosts) {
  const io = hosts.ios;
  const s = io.surfaces.primary;
  const reached = new Set([...walkGraph(io.roots(io.surfaces)).reached.keys()]);
  const covered = (rel) => s.rows.includes(rel) || s.repoRows.includes(rel)
    || mirrorCovers(rel, s.mirrorRoots.map((m) => m.rel));
  const resources = {
    rows: s.rows.length,
    graphDerived: s.rows.filter((r) => reached.has(r)).length,
    policyRows: s.rows.filter((r) => !reached.has(r)),
    missingFromGraph: [...reached].filter((r) => inScope(r) && !covered(r)).sort(),
  };
  const treesAbsent = s.mirrorRoots
    .filter((m) => !existsSync(join(m.root === 'SPIKE' ? SPIKE : REPO, m.rel)))
    .map((m) => `${m.root}:${m.rel}`);
  return {
    host: 'ios',
    file: s.rowOrigin,
    resources,
    trees: { mirrorRoots: s.mirrorRoots.length, rootsAbsentOnDisk: treesAbsent },
  };
}

// --- verdict + report -------------------------------------------------------

function freezeFatal(reports) {
  const out = [];
  for (const r of reports) {
    if (r.host === 'harmony') {
      for (const m of r.bundleFiles.missing.filter(inScope)) out.push(`harmony BUNDLE_FILES missing graph row: ${m}`);
      for (const m of r.zodQuadruple.missingFromRecomputed) out.push(`harmony BUNDLE_FILES missing zod closure row: ${m}`);
    }
    if (r.host === 'android') {
      for (const m of r.twins.scenarioStageVsVerify) out.push(`android scenario twin drift: ${m}`);
      for (const m of r.twins.pkgStageVsVerify) out.push(`android pkg twin drift (verify lacks): ${m}`);
      for (const m of r.twins.pkgVerifyVsStage) out.push(`android pkg twin drift (stage lacks): ${m}`);
      for (const m of r.twins.npmStageVsVerify) out.push(`android npm twin drift (verify lacks): ${m}`);
      for (const m of r.twins.npmVerifyVsStage) out.push(`android npm twin drift (stage lacks): ${m}`);
      for (const m of r.graphRowsOutsideMirrors) out.push(`android graph row outside mirrors: ${m}`);
    }
    if (r.host === 'ios') {
      for (const m of r.resources.missingFromGraph) out.push(`ios surfaces missing graph row: ${m}`);
    }
  }
  return out;
}

function hostLines(r) {
  const lines = [`== ${r.host} ==`];
  if (r.host === 'harmony') {
    const bf = r.bundleFiles;
    lines.push(`BUNDLE_FILES: committed ${bf.committed} unique (raw ${bf.rawRows}, ${bf.dupes} duplicate hand rows) · derived ${bf.derived} from ${r.legs.map((l) => `${l.leg}=${l.rows}`).join(' ')}`);
    lines.push(`  set parity: missing(derived−committed) ${bf.missing.length} · extra(committed−derived) ${bf.extra.length}`);
    for (const m of bf.missing) lines.push(`    MISSING ${m}`);
    for (const e of bf.extraClass) lines.push(`    EXTRA ${e.row} — ${e.leg}`);
    const z = r.zodQuadruple;
    lines.push(`  zod closure (${z.pin}): recomputed ${z.recomputed} · hand copies BUNDLE_FILES=${z.bundleFiles} CLOSURE=${z.closure} ios ZOD_FILES=${z.iosZodFiles} · copies agree: ${z.copiesAgree ? 'yes' : `NO (${z.missingFromRecomputed.length} off)`}`);
    if (r.webclientSourceMissing.length) lines.push(`  webclient source dirs absent: ${r.webclientSourceMissing.join(', ')}`);
  } else if (r.host === 'android') {
    lines.push(`scenario roster: ${r.scenarioRoster.rows} staged (policy) of ${r.scenarioRoster.onDisk} on-disk — ${r.scenarioRoster.unstagedByPolicy} unstaged by host policy`);
    lines.push(`mirrors: ${r.mirrors.join(', ')}`);
    lines.push(`graph rows outside mirrors: ${r.graphRowsOutsideMirrors.length}`);
    lines.push(`twin lists: scenario drift ${r.twins.scenarioStageVsVerify.length} · pkg drift ${r.twins.pkgStageVsVerify.length}/${r.twins.pkgVerifyVsStage.length} · npm drift ${r.twins.npmStageVsVerify.length}/${r.twins.npmVerifyVsStage.length} · declared pins absent on disk: ${r.pinsAbsent.length}`);
    for (const p of r.pinsAbsent) lines.push(`    PIN ABSENT ${p}`);
  } else {
    lines.push(`RESOURCES: ${r.resources.rows} rows — ${r.resources.graphDerived} graph-derived, ${r.resources.policyRows.length} policy rows (classified, not graph-derivable)`);
    for (const p of r.resources.policyRows) lines.push(`    POLICY ${p}`);
    lines.push(`TREES: ${r.trees.mirrorRoots} mirror roots · absent on disk: ${r.trees.rootsAbsentOnDisk.length}`);
    for (const p of r.trees.rootsAbsentOnDisk) lines.push(`    TREE ABSENT ${p}`);
  }
  return lines;
}

function parseArgs(argv) {
  const only = { '--host': null, '--out': null, '--json': false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--host' || argv[i] === '--out') {
      if (!argv[i + 1]) fail(`${argv[i]} requires a value`);
      only[argv[i]] = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--json') only['--json'] = true;
    else fail(`unknown argument: ${argv[i]} (usage: gen-staging-manifests.mjs [--host h] [--out DIR] [--json])`);
  }
  return only;
}

/** The generated content + the machine-readable delta, for the round-trip
 * runner: harmony-BUNDLE_FILES.rows is what Phase 3 would commit in place of
 * the hand list. */
function emitArtifacts(out, reports, fatal) {
  mkdirSync(out, { recursive: true });
  for (const r of reports) {
    if (r.host !== 'harmony') continue;
    writeFileSync(join(out, 'harmony-BUNDLE_FILES.rows'), `${r.bundleFiles.rows.join('\n')}\n`);
  }
  writeFileSync(join(out, 'delta.json'), `${JSON.stringify({ reports, fatal }, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const hosts = buildHosts();
  if (args['--host'] && !hosts[args['--host']]) fail(`unknown host '${args['--host']}' (expected harmony|android|ios)`);
  const facts = androidScriptFacts();
  const closure = closureScriptFacts();
  const selected = args['--host'] ? [args['--host']] : ['harmony', 'android', 'ios'];
  const reports = [];
  if (selected.includes('harmony')) reports.push(roundTripHarmony(hosts, facts, closure));
  if (selected.includes('android')) reports.push(roundTripAndroid(hosts, facts));
  if (selected.includes('ios')) reports.push(roundTripIos(hosts));
  const fatal = freezeFatal(reports);
  if (args['--out']) emitArtifacts(args['--out'], reports, fatal);
  if (args['--json']) console.log(JSON.stringify({ ok: fatal.length === 0, reports, fatal }, null, 2));
  else {
    console.log(reports.flatMap(hostLines).join('\n'));
    console.log(`staging-generate: ${fatal.length ? 'ROUND-TRIP FATAL' : 'round-trip holds'} · ${fatal.length} freeze-fatal row(s)`);
    for (const f of fatal) console.log(`  FATAL ${f}`);
  }
  process.exitCode = fatal.length ? 1 : 0;
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 2;
}
