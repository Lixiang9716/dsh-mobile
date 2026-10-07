// dsh:logging-exempt satellite of check-staging.mjs (dev script: console IS the
// product, like check-bundle-files.mjs) — kept for symmetry with its siblings.
/**
 * check-staging-graph.mjs — the import-graph half of check-staging.
 *
 * Walks the runtime closure's import graph from the boot entries, resolving
 * relative and bundle-root spellings (./x, ../x, upstream/x, scenario/x,
 * system-plugins/x, vendor/..., /vendor/..., dsh-root *.js) through the
 * shims' export-from chains and the vendored layout
 * (vendor/dsh/<pkg>@<ver>/lib, vendor/npm/<pkg>@<ver>/...). node:* and bare
 * npm names are NOT followed — they resolve through the loader's bridge/map
 * rows (npm-bridges-*.js tables, the bare map), which are themselves
 * manifest rows checked by direction (b) of the per-host adapters in
 * check-staging-hosts.mjs.
 *
 * Split out of check-staging.mjs purely for the code-size gate; the three
 * files together are one tool — see the CLI's header for the full contract.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DSH = join(REPO, 'runtime', 'dsh');

// --- graph walk -------------------------------------------------------------

/** Bundle-root subtrees a first-party specifier may name (the dsh host's
 * ESM loader resolves these from the bundle root; everything else that is
 * not relative is a bare npm name → bridge/map row → skipped). */
const BUNDLE_DIRS = new Set([
  'upstream', 'scenario', 'system-plugins', 'vendor', 'fixtures',
  'presets-mobile', 'webclient', 'upstream-tests', 'profiles', 'assets',
]);
/** Dsh-root single files the loader serves by name. */
const ROOT_FILES = new Set([
  'logger.js', 'gateway.js', 'registry.js', 'sha256.js', 'tar-mini.js',
  'llm.js', 'install-pipeline.js', 'install-fetch.js', 'receipt-journal.js',
  'config-layer.js', 'manifest.json', 'credential-stage.js',
]);
/** Check (a) scope: the subtrees whose staging the manifests hand-maintain. */
const SCOPE_PREFIXES = ['scenario/', 'upstream/', 'system-plugins/'];

export const inScope = (rel) => SCOPE_PREFIXES.some((p) => rel.startsWith(p));
const isJs = (rel) => /\.(js|mjs)$/.test(rel);

/** Strip line and block comments and MASK string contents so regexes only
 * see real statements. Double-quoted strings and template literals are
 * masked (bridge tables — npm-bridges-*.js — carry `export * from
 * '/vendor/…'` rows as registered-module DATA, not statements); import
 * specifiers in this closure are single-quoted and stay visible. Newlines
 * are always preserved so reported line numbers stay true. */
function stripComments(src) {
  let out = '';
  let i = 0;
  let state = 'code';
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { state = c; out += c; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += c; // keep newlines so reported lines stay true
      i += 1; continue;
    }
    // inside a quote — honor escapes, close on the matching quote
    if (c === '\\') {
      if (state !== "'") out += '  ';
      i += 2; continue;
    }
    if (c === state) { state = 'code'; out += c; i += 1; continue; }
    if (state === "'") out += c; // single-quoted = real specifiers stay
    else out += c === '\n' ? '\n' : ' ';
    i += 1;
  }
  return out;
}

// Quote-bearing patterns are built via new RegExp from plain strings: a quote
// inside a regex LITERAL desyncs govrail's code-size string tracking, which
// re-detects the file's indent unit and ghosts phantom INDENT violations
// (govrail#411). Patterns + capture groups identical to the literal forms.
const DYN_IMPORT = new RegExp("\\bimport\\s*\\(\\s*'([^']+)'\\s*\\)", 'g');
const IMPORT_FROM =
  new RegExp("(?:^|[;\\n}])(\\s*)(?:import|export)\\b[^;'\"`()]*?\\bfrom\\s*'([^']+)'", 'gm');
const SIDE_EFFECT = new RegExp("(?:^|[;\\n}])(\\s*)import\\s*'([^']+)'", 'gm');

/** All import/export-from specifiers with their line numbers and edge kind.
 * Single-quoted specifiers only (masked strings cannot yield edges), and a
 * static import/export must sit at a statement boundary so prose remnants
 * cannot masquerade as edges. Reported lines anchor at the specifier's own
 * position (the `from '…'` text), which stays exact under masking even when
 * a statement wraps across lines. */
function specifiersOf(src) {
  const text = stripComments(src);
  const edges = [];
  const lineAt = (idx) => text.slice(0, idx).split('\n').length;
  const push = (m, specGroup, kind) => {
    if (!m) return;
    const at = text.indexOf(m[specGroup], m.index);
    edges.push({ spec: m[specGroup], kind, line: lineAt(at < 0 ? m.index : at) });
  };
  for (const m of text.matchAll(DYN_IMPORT)) push(m, 1, 'dynamic-import');
  for (const m of text.matchAll(IMPORT_FROM)) push(m, 2, 'import-from');
  for (const m of text.matchAll(SIDE_EFFECT)) push(m, 2, 'side-effect-import');
  return edges;
}

/** Resolve one specifier to a bundle-root-relative path — or a skip reason.
 * Missing-disk resolution for first-party importers is reported, not thrown:
 * a first-party import that resolves nowhere is itself a staging-class
 * defect the walk should name. */
function resolveSpecifier(spec, fromRel) {
  if (spec.startsWith('node:')) return { type: 'skip', reason: 'node-builtin' };
  if (spec.startsWith('./') || spec.startsWith('../')) {
    return { type: 'path', rel: normalize(join(dirname(fromRel), spec)) };
  }
  if (spec.startsWith('/')) return { type: 'path', rel: normalize(spec.slice(1)) };
  if (spec.startsWith('@')) return { type: 'skip', reason: 'bare-npm' };
  const first = spec.split('/')[0];
  if (BUNDLE_DIRS.has(first)) return { type: 'path', rel: normalize(spec) };
  if (/^[A-Za-z0-9_.-]+\.(js|mjs|json)$/.test(spec)) {
    return { type: 'path', rel: normalize(spec) };
  }
  return { type: 'skip', reason: 'bare-npm' };
}

/** Walk the graph from roots. Returns reached (rel → first edge that got us
 * there), skipped bare names, and first-party edges that resolve to nothing. */
export function walkGraph(roots) {
  const reached = new Map(); // rel -> { via: rel, spec, kind, line }
  const skippedBare = new Set();
  const brokenEdges = []; // { from, spec, kind, line }
  const queue = [];
  const seen = new Set();
  const enqueue = (rel, edge) => {
    if (!seen.has(rel)) { seen.add(rel); reached.set(rel, edge); queue.push(rel); }
  };
  for (const root of roots) {
    if (existsSync(join(DSH, root))) enqueue(root, { via: '(entry)', spec: root, kind: 'boot-entry', line: 0 });
  }
  while (queue.length) {
    const rel = queue.shift();
    const abs = join(DSH, rel);
    if (!existsSync(abs) || !isJs(rel)) continue; // .json reached but not walked
    // vendor subtrees are staged whole by every host; their internal edges
    // never affect check (a), and dist imports use npm semantics — stop here.
    if (rel.startsWith('vendor/')) continue;
    let src;
    try {
      src = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const { spec, kind, line } of specifiersOf(src)) {
      const r = resolveSpecifier(spec, rel);
      if (r.type === 'skip') {
        if (r.reason === 'bare-npm') skippedBare.add(spec);
        continue;
      }
      let target = r.rel;
      if (!existsSync(join(DSH, target))) {
        const candidates = [target + '.js', target + '.mjs', target + '/index.js'];
        const hit = candidates.find((c) => existsSync(join(DSH, c)));
        if (!hit) {
          if (inScope(rel) || !rel.includes('/')) brokenEdges.push({ from: rel, spec, kind, line }); // vendor-internal extensionless dist imports: not our graph
          continue;
        }
        target = hit;
      }
      enqueue(target, { via: rel, spec, kind, line });
    }
  }
  return { reached, skippedBare, brokenEdges };
}
