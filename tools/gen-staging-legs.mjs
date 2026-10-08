// dsh:logging-exempt satellite of gen-staging-manifests.mjs (dev script: console
// IS the product, like check-bundle-files.mjs).
/**
 * gen-staging-legs.mjs — the derivation legs of the staging-manifest
 * generator. Each leg turns one kind of REALITY (the import graph, a
 * materialized vendored pin tree, a mirrored repo tree, a closure walk) into
 * the bundle-root row set a staging manifest must name. Policy (which pins,
 * which scenario roster, which mirrors) lives in the CLI half; this module is
 * policy-free mechanics so a leg can be unit-reasoned about on its own.
 *
 * Legs:
 *   graphLeg        — check-staging's walkGraph over a host's roots (the
 *                     static + dynamic import closure, bridge/map rows
 *                     skipped the same way the verifier skips them);
 *   dshPinRows      — every materialized vendor/dsh/<pkg>@<ver> with a lib/
 *                     expands to package.json + lib/** (minus .d.ts) +
 *                     presets/** when the pin carries it — the stage_pkg /
 *                     suite-extras rule the stagers already perform;
 *   dirPinRows      — one pin subtree under an extension filter (noble *.js,
 *                     pi-ai js+json, the goal trio, diff libesm, yaml browser);
 *   zodClosureRows  — the pinned zod's runtime closure recomputed by walking
 *                     the pin's OWN relative import graph from index.js (the
 *                     ZOD_FILES comment's claim, made executable);
 *   webclientRows   — presentation/web-client* trees at their staged
 *                     webclient/dsh-web-client* names;
 *   walkDiskDir     — generic recursive listing for mirror legs.
 *
 * Split from the CLI purely for the code-size gate; the files together are
 * one tool.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';

/** Recursive listing of `abs` (files only), stable order. */
export function walkDiskDir(abs) {
  const out = [];
  const visit = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const jp = join(d, e.name);
      if (e.isDirectory()) visit(jp);
      else out.push(jp);
    }
  };
  visit(abs);
  return out.sort();
}

/** The vendor/dsh pin glob: every <pkg>@<ver> dir carrying a lib/. */
export function dshPinDirs(spikeAbs) {
  const base = join(spikeAbs, 'vendor', 'dsh');
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /@\d/.test(e.name) && existsSync(join(base, e.name, 'lib')))
    .map((e) => `vendor/dsh/${e.name}`)
    .sort();
}

/** Expand one dsh pin to its staged rows: package.json + lib/** minus .d.ts,
 * plus presets/** whole when the pin carries it. LICENSE/README rows are NOT
 * part of the rule (the stagers copy them into assets but no manifest row
 * names them except util-crypto's one-off shape — the delta reports that). */
export function dshPinRows(spikeAbs, pin) {
  const abs = join(spikeAbs, pin);
  const rows = [];
  if (existsSync(join(abs, 'package.json'))) rows.push(`${pin}/package.json`);
  for (const f of walkDiskDir(join(abs, 'lib'))) {
    const rel = f.slice(abs.length + 1).split(sep).join('/');
    if (!rel.endsWith('.d.ts')) rows.push(`${pin}/${rel}`);
  }
  if (existsSync(join(abs, 'presets'))) {
    for (const f of walkDiskDir(join(abs, 'presets'))) {
      rows.push(`${pin}/${f.slice(abs.length + 1).split(sep).join('/')}`);
    }
  }
  return rows;
}

/** Expand a stager-declared dsh pin-name roster to rows AT the vendor/dsh/
 * <name>@<ver> spelling. A name whose pin is materialized only on the npm
 * face (vendor/npm/@deepseek-ai/dsh-<name>@<ver> — the tool-present family)
 * expands from there; anything materialized nowhere is `absent`, reported
 * not swallowed. */
export function dshRosterRows(spikeAbs, names, ver) {
  const rows = [];
  const absent = [];
  for (const name of names) {
    const at = `vendor/dsh/${name}@${ver}`;
    const dshAbs = join(spikeAbs, at);
    const npmAbs = join(spikeAbs, 'vendor/npm/@deepseek-ai', `dsh-${name}@${ver}`);
    if (existsSync(dshAbs)) {
      rows.push(...dshPinRows(spikeAbs, at));
    } else if (existsSync(npmAbs)) {
      if (existsSync(join(npmAbs, 'package.json'))) rows.push(`${at}/package.json`);
      for (const f of walkDiskDir(join(npmAbs, 'lib'))) {
        const rel = f.slice(npmAbs.length + 1).split(sep).join('/');
        if (!rel.endsWith('.d.ts')) rows.push(`${at}/${rel}`);
      }
    } else absent.push(at);
  }
  return { rows, absent };
}

/** One pin subtree under a name filter: { root: pin-relative dir to walk
 * (empty = whole pin), exts: allowed extensions, keep: extra predicate }. */
export function dirPinRows(spikeAbs, pin, opts = {}) {
  const base = opts.root ? join(spikeAbs, pin, opts.root) : join(spikeAbs, pin);
  if (!existsSync(base)) return null; // caller decides whether absence is fatal
  const exts = opts.exts ?? ['.js', '.mjs', '.json'];
  const keep = opts.keep ?? (() => true);
  const prefix = `${pin}${opts.root ? `/${opts.root}` : ''}`;
  return walkDiskDir(base)
    .filter((f) => {
      const rel = f.slice(base.length + 1);
      return !rel.endsWith('.d.ts') && exts.some((e) => rel.endsWith(e)) && keep(rel);
    })
    .map((f) => `${prefix}/${f.slice(base.length + 1).split(sep).join('/')}`);
}

/** The vendored zod's runtime closure: walk the pin's own relative import
 * graph from index.js. The pin is REQUIRED — the caller derives it from a
 * stager declaration, never a default (a defaulted version is a fourth copy
 * of the pin policy). Resolves ./x, missing-.js, and dir/index.js exactly
 * like the vendored classic build spells them; non-relative specifiers
 * (node:, bare names) are leaves. Returns pin-relative rows, sorted. */
export function zodClosureRows(spikeAbs, pin) {
  const abs = join(spikeAbs, pin);
  const spec = /from\s*['"](\.[^'"]+)['"]|import\s*['"](\.[^'"]+)['"]|require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  const seen = new Set();
  const queue = ['index.js'];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const file = join(abs, rel);
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(spec)) {
      const want = m[1] || m[2] || m[3];
      const base = dirname(rel);
      const cand = [want, `${want}.js`, join(base, want), `${join(base, want)}.js`, join(base, want, 'index.js')]
        .map((c) => (c.startsWith('./') ? c.slice(2) : c));
      let hit = null;
      for (const c of cand) {
        const p = join(abs, c);
        if (existsSync(p) && statSync(p).isFile()) { hit = c; break; }
      }
      if (hit) queue.push(hit);
    }
  }
  return [...seen].sort().map((f) => `${pin}/${f.split(sep).join('/')}`);
}

/** The webclient trees: presentation/<dir> staged at webclient/<staged-name>.
 * Returns { rows, missing } — a source file absent from the presentation tree
 * is the stager's own failure, reported not swallowed. */
export function webclientRows(repoAbs, trees) {
  const rows = [];
  const missing = [];
  for (const t of trees) {
    const src = join(repoAbs, t.dir);
    if (!existsSync(src)) { missing.push(t.dir); continue; }
    for (const f of walkDiskDir(src)) rows.push(`webclient/${t.staged}/${f.slice(src.length + 1).split(sep).join('/')}`);
  }
  return { rows, missing };
}

/** The harmony-only staging rows: the npm faces vendor-official.sh stages at
 * the dsh rel path (its `for face in` verify loop is the declaration) expand
 * from their npm pins at the vendor/dsh/<face>@ spelling — dshRosterRows'
 * npm branch, scoped to the faces the HARMONY script names (the joint
 * roster's android-side names must not grow harmony rows) — plus the MOBILE
 * preset docs staged into the vendored presets copy. */
export function harmonyOnlyRows(spikeAbs, closure, ver) {
  const faceRows = closure.faceStages.flatMap((face) => {
    const pin = `vendor/npm/@deepseek-ai/dsh-${face}@${ver}`;
    const abs = join(spikeAbs, pin);
    if (!existsSync(abs)) throw new Error(`face stage pin absent: ${pin}`);
    const rows = [];
    if (existsSync(join(abs, 'LICENSE'))) rows.push(`vendor/dsh/${face}@${ver}/LICENSE`);
    rows.push(`vendor/dsh/${face}@${ver}/package.json`);
    for (const f of walkDiskDir(join(abs, 'lib'))) {
      const rel = f.slice(join(abs, 'lib').length + 1).split(sep).join('/');
      if (!rel.endsWith('.d.ts')) rows.push(`vendor/dsh/${face}@${ver}/lib/${rel}`);
    }
    return rows;
  });
  const mobileRows = closure.mobileDocs.map(
    (rel) => `vendor/dsh/agent-presets@${ver}/presets/mobile/${rel.split('/').pop()}`);
  return [...faceRows, ...mobileRows].sort();
}
