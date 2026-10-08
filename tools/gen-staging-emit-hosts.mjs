// dsh:logging-exempt satellite of gen-staging-emit.mjs (dev script: console
// IS the product, like check-staging.mjs)
/**
 * gen-staging-emit-hosts.mjs — the android + ios halves of the staging
 * manifest consolidation (gen-staging-emit.mjs is the CLI + the harmony
 * half; the code-size gate splits the tool, the files together are one).
 *
 * android — the stager's scenario/web-live for-in lists. A staged entry is
 *   host POLICY (which scenarios the device stages — no derivation can
 *   mint an entry); the graph-derived half (scenario/web-live files a
 *   staged entry imports — the embed-list trap class) joins automatically:
 *     android-scenario.rows / android-web-live.rows        generated
 *         = policy ∪ (transitively reached − excluded)
 *     android-scenario.policy.rows / android-web-live.…    the declared
 *         entries (first emit harvests the committed list; after that a
 *         new entry is a hand row)
 *     android-*.exclude.rows   transitively reached rows the host
 *         deliberately does not stage (absent while empty)
 *
 * ios — the embedder's RESOURCES accession table and TREES mirror roots.
 *   Accessor suffixes (Swift links against dsh_runtime_res_<suffix>) and
 *   pin choices are host policy no derivation can mint, so the rows files
 *   are the DECLARED source, in block order (the C arrays and the tree
 *   walk consume that order — a reorder would churn the committed
 *   Generated sources), and the .py blocks are machine-materialized:
 *     ios-RESOURCES.rows   `<suffix>=<rel>` (`repo:` prefix = REPO root)
 *     ios-TREES.rows       `<bundle-rel>=<source-rel>` (DSH-rooted)
 *   Both carry `#` comments (the block prose moved here with the rows).
 *   Coverage (a graph row no RESOURCES row names and no TREES mirror
 *   covers) stays with check-staging's ios surface, blocking in the DAG
 *   ahead of this gate.
 *
 * check(dir) — the committed rows files, the host blocks and the
 *   derivation must agree exactly; declared rows must exist on disk; any
 *   drift exits 1 with the remedy line.
 * emit(dir)  — harvest the android entry policy when absent (first run
 *   only — it is hand-owned afterwards), write the generated rows, splice
 *   the host blocks in place. An emit on a current tree is a no-op diff.
 *   The ios rows files are hand-authored (this consolidation's one-time
 *   transcription); a missing one is a loud usage error, never a harvest —
 *   the pre-flattening TREES comprehension is a parser this tool refuses
 *   to duplicate.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, DSH, walkGraph, inScope } from './check-staging-graph.mjs';
import { buildHosts } from './check-staging-hosts.mjs';

const fail = (msg) => { throw new Error(`gen-staging-emit: ${msg}`); };
const ANDROID_SH = 'hosts/android/ci/stage-spine-closure.sh';
const IOS_HEADER = 'hosts/ios/Tools/gen_bundle_header.py';
const IOS_RESOURCES = 'hosts/ios/Tools/gen_bundle_resources.py';
const ANDROID_DIRS = ['scenario', 'web-live'];

/** Committed lines of a rows file, `#` comments and blanks dropped. */
function readLines(dir, name) {
  const p = join(dir, name);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n');
}

/** Declared rows of a rows file: `#` comments and blanks dropped (the rows
 * files carry the block prose that moved out of the host sources). */
const declared = (dir, name, why) => {
  const rows = readLines(dir, name).map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!rows.length) fail(`${name} is missing or empty — ${why}`);
  return rows;
};

// --- android -----------------------------------------------------------------

/** The four scenario/web-live for-in headers, keyed `stage:scenario` etc.
 * Each loop is anchored at its copy/cmp line (the verify twin cmps, the
 * stage loop cps — the anchors stay unique per dir), and the header spans
 * from the preceding `for s in` to its `; do`. */
function androidLoops(src) {
  const spans = {};
  for (const dir of ANDROID_DIRS) {
    for (const role of ['stage', 'verify']) {
      const needle = role === 'stage' ? `cp "$DSH/${dir}/$s"` : `cmp -s "$DSH/${dir}/$s"`;
      const at = src.indexOf(needle);
      const head = at < 0 ? -1 : src.lastIndexOf('for s in', at);
      const end = head < 0 ? -1 : src.indexOf('; do', head);
      if (at < 0 || head < 0 || end < 0) {
        fail(`the ${role} ${dir} for-in loop not found in ${ANDROID_SH}`);
      }
      spans[`${role}:${dir}`] = {
        start: head, end,
        rows: src.slice(head + 'for s in'.length, end).replace(/\\\n/g, ' ')
          .split(/\s+/).filter(Boolean).map((s) => `${dir}/${s}`),
      };
    }
  }
  return spans;
}

/** The android derivation: transitively reached in-scope rows per dir (the
 * entries themselves arrive as policy — walkGraph marks every walk root
 * boot-entry). */
function androidDerived() {
  const host = buildHosts().android;
  const { reached } = walkGraph(host.roots(host.surfaces));
  const split = { scenario: [], 'web-live': [] };
  for (const [rel, edge] of reached) {
    if (edge.kind === 'boot-entry' || !inScope(rel)) continue;
    for (const dir of ANDROID_DIRS) {
      if (rel.startsWith(`${dir}/`)) split[dir].push(rel);
    }
  }
  for (const dir of ANDROID_DIRS) split[dir].sort();
  return split;
}

/** The generated rows for one dir = policy ∪ (transitive − excluded).
 * Policy rows must exist on disk (a deleted file leaves the staging lists
 * in the same commit); an excluded row no edge reaches is drift, not
 * silence. The exclude file is legitimately absent while empty. The spliced
 * list ORDER is the committed stage list's (kept rows stay put, added rows
 * append sorted) — the generated .rows file stays the sorted canonical. */
function androidExpected(artifacts, dirName, derived, committed) {
  const policy = declared(artifacts, `android-${dirName}.policy.rows`,
    'run --emit to harvest the committed entries');
  const gone = policy.filter((r) => !existsSync(join(DSH, r)));
  if (gone.length) fail(`android-${dirName}.policy.rows names files the tree no longer has: ${gone.join(', ')}`);
  const excluded = readLines(artifacts, `android-${dirName}.exclude.rows`)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const unknown = excluded.filter((r) => !derived.includes(r));
  if (unknown.length) {
    fail(`android-${dirName}.exclude.rows names rows no edge reaches (drop them or move to policy): ${unknown.join(', ')}`);
  }
  const set = new Set([...policy, ...derived.filter((r) => !excluded.includes(r))]);
  const rows = [...committed.filter((r) => set.has(r)),
    ...[...set].filter((r) => !committed.includes(r)).sort()];
  return { rows, policy, excluded };
}

/** Wrap one for-in header: four names per line, continuation style kept;
 * the loop's own `; do` stays in the script (the span ends before it). */
function forInHeader(dirName, rows) {
  const names = rows.map((r) => r.slice(dirName.length + 1));
  const lines = [];
  for (let i = 0; i < names.length; i += 4) {
    const chunk = names.slice(i, i + 4).join(' ');
    lines.push(i === 0 ? `for s in ${chunk}` : `         ${chunk}`);
  }
  return lines.join(' \\\n');
}

/** Rewrite the four headers in one pass, later spans first so the earlier
 * offsets stay valid. */
function androidSplice(src, spans, manifests) {
  const edits = ANDROID_DIRS.flatMap((dir) => ['stage', 'verify']
    .map((role) => ({ ...spans[`${role}:${dir}`], text: forInHeader(dir, manifests[dir].rows) })))
    .sort((a, b) => b.start - a.start);
  let out = src;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** --check half: the committed lists must equal the derivation exactly
 * (stage and verify twins are one list spliced twice; membership compares
 * sorted — the spliced list's order is the committed hand order). `drift`
 * is what an emit fixes; the caller adds the remedy line. */
export function androidCheck(dir) {
  const src = readFileSync(join(REPO, ANDROID_SH), 'utf8');
  const spans = androidLoops(src);
  const derived = androidDerived();
  const drift = [];
  const manifests = {};
  const sorted = (rows) => rows.slice().sort().join(' ');
  for (const dirName of ANDROID_DIRS) {
    manifests[dirName] = androidExpected(dir, dirName, derived[dirName],
      spans[`stage:${dirName}`].rows);
    const stage = spans[`stage:${dirName}`].rows;
    const verify = spans[`verify:${dirName}`].rows;
    const want = manifests[dirName].rows;
    if (sorted(verify) !== sorted(stage)) {
      drift.push(`the ${dirName} stage/verify twins disagree (one list, spliced twice)`);
    }
    if (sorted(stage) !== sorted(want)) {
      drift.push(`the android ${dirName} staging list drifted from the derivation`);
    }
  }
  return { drift, manifests, src, spans };
}

/** --emit half: harvest the entry policy when absent, write the generated
 * rows, splice both lists per dir (order-preserving; membership only). */
export function androidEmit(dir) {
  const did = [];
  const src = readFileSync(join(REPO, ANDROID_SH), 'utf8');
  const spans = androidLoops(src);
  const derived = androidDerived();
  const manifests = {};
  let changed = false;
  const sorted = (rows) => rows.slice().sort().join(' ');
  for (const dirName of ANDROID_DIRS) {
    const policyName = `android-${dirName}.policy.rows`;
    if (!existsSync(join(dir, policyName))) {
      const entries = spans[`stage:${dirName}`].rows
        .filter((r) => !derived[dirName].includes(r)).sort();
      writeFileSync(join(dir, policyName), `${entries.join('\n')}\n`);
      did.push(`${policyName} harvested (${entries.length} entries)`);
    }
    manifests[dirName] = androidExpected(dir, dirName, derived[dirName],
      spans[`stage:${dirName}`].rows);
    writeFileSync(join(dir, `android-${dirName}.rows`), `${manifests[dirName].rows.join('\n')}\n`);
    const twin = sorted(spans[`verify:${dirName}`].rows) !== sorted(spans[`stage:${dirName}`].rows);
    if (sorted(spans[`stage:${dirName}`].rows) !== sorted(manifests[dirName].rows) || twin) {
      changed = true;
      did.push(`android ${dirName} lists spliced (${manifests[dirName].rows.length} rows)`);
    }
  }
  if (changed) writeFileSync(join(REPO, ANDROID_SH), androidSplice(src, spans, manifests), 'utf8');
  return did;
}

// --- ios ---------------------------------------------------------------------

// Quote-bearing patterns are built via new RegExp from plain strings: a quote
// inside a regex LITERAL desyncs govrail's code-size string tracking and
// ghosts phantom INDENT violations (govrail#411) — see check-staging-graph.mjs.
const PY_STR = new RegExp('"([^"]*)"', 'g');
const PY_PAREN_ROW = /\(((?:[^()]|\([^()]*\))*)\)/gs;

/** Index of the `]` closing the list opened at `open`, comment- and string-
 * aware; a `] + [` continuation keeps scanning (the pre-flattening TREES is
 * assembled from continuation segments). -1 when the list never closes. */
function pyListSpan(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '#') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (c === '"') {
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i += 1;
        i += 1;
      }
      continue;
    }
    if (c === '[') depth += 1;
    else if (c === ']') {
      depth -= 1;
      if (depth === 0) {
        const tail = text.slice(i + 1).match(/^\s*(?:#[^\n]*\n\s*)*\+\s*\[/);
        if (tail) { depth = 1; i += tail.index + tail[0].length; }
        else return i;
      }
    }
  }
  return -1;
}

/** The [contentStart, closeAt) span of a top-level `NAME = [ … ]` block
 * (line-anchored so WEBCLIENT_TREES cannot shadow TREES). */
function pyBlockSpan(src, name, where) {
  const at = src.indexOf(`\n${name} = [`);
  if (at < 0) fail(`${name} block not found in ${where}`);
  const open = src.indexOf('[', at);
  const end = pyListSpan(src, open);
  if (end < 0) fail(`${name} block closing ] not found in ${where}`);
  return [open + 1, end];
}

/** (suffix, PATH) rows of a flat RESOURCES body — { suffix, root, rel } in
 * block order; a row naming neither DSH nor REPO is structural drift. */
function pyResourceRows(body, where) {
  const rows = [];
  for (const m of body.matchAll(PY_PAREN_ROW)) {
    const strs = [...m[1].matchAll(PY_STR)].map((x) => x[1]);
    const root = m[1].includes('DSH') ? 'DSH' : m[1].includes('REPO') ? 'REPO' : null;
    if (!root || strs.length < 2) continue;
    rows.push({ suffix: strs[0], root, rel: strs.slice(1).join('/') });
  }
  if (!rows.length) fail(`${where} parsed to zero rows`);
  return rows;
}

/** (bundle, source) rows of a flat TREES body, in block order. */
function pyTreeRows(body) {
  const rows = [];
  for (const m of body.matchAll(PY_PAREN_ROW)) {
    const strs = [...m[1].matchAll(PY_STR)].map((x) => x[1]);
    if (strs.length < 2 || strs[0].includes('%s') || strs[0].includes('{pkg}')) continue;
    rows.push({ bundle: strs[0], source: strs.slice(1).join('/') });
  }
  return rows;
}

const pyStr = (s) => `"${s}"`;
const pyPath = (root, rel) => `${root} / ${rel.split('/').map(pyStr).join(' / ')}`;
const resourcesBody = (rows) => rows.map((r) => `    (${pyStr(r.suffix)}, ${pyPath(r.root, r.rel)}),`);
const treesBody = (rows) => rows.map((r) => `    (${pyStr(r.bundle)}, ${pyPath('DSH', r.source)}),`);

/** The declared ios rows files: RESOURCES `<suffix>=<rel>` (repo: marks a
 * REPO-rooted row), TREES `<bundle>=<source>`; `#` comments ride along. */
function declaredResources(dir) {
  return declared(dir, 'ios-RESOURCES.rows', 'author it (this '
    + 'consolidation\'s one-time transcription of the committed table)').map((t) => {
    const at = t.indexOf('=');
    if (at < 0) fail(`ios-RESOURCES.rows row lacks suffix=rel: ${t}`);
    const rel = t.slice(at + 1);
    const repo = rel.startsWith('repo:');
    return { suffix: t.slice(0, at), root: repo ? 'REPO' : 'DSH', rel: repo ? rel.slice(5) : rel };
  });
}

function declaredTrees(dir) {
  return declared(dir, 'ios-TREES.rows', 'author it (this '
    + 'consolidation\'s one-time transcription of the committed roots)').map((t) => {
    const at = t.indexOf('=');
    if (at < 0) fail(`ios-TREES.rows row lacks bundle=source: ${t}`);
    return { bundle: t.slice(0, at), source: t.slice(at + 1) };
  });
}

const resExists = (r) => existsSync(join(r.root === 'DSH' ? DSH : REPO, r.rel));

/** --check half: blocks ≡ declared rows, accessor suffixes unique, every
 * path on disk (a stale declared row is the list remembering a renamed
 * file). `drift` is what an emit fixes; `disk` needs a human. */
export function iosCheck(dir) {
  const resSrc = readFileSync(join(REPO, IOS_RESOURCES), 'utf8');
  const headerSrc = readFileSync(join(REPO, IOS_HEADER), 'utf8');
  const [resOpen, resEnd] = pyBlockSpan(resSrc, 'RESOURCES', IOS_RESOURCES);
  const [treeOpen, treeEnd] = pyBlockSpan(headerSrc, 'TREES', IOS_HEADER);
  const committedRes = pyResourceRows(resSrc.slice(resOpen, resEnd), IOS_RESOURCES);
  const committedTrees = pyTreeRows(headerSrc.slice(treeOpen, treeEnd));
  const wantRes = declaredResources(dir);
  const wantTrees = declaredTrees(dir);
  const drift = [];
  const disk = [];
  const resKey = (r) => `${r.suffix}=${r.root}:${r.rel}`;
  const treeKey = (r) => `${r.bundle}=${r.source}`;
  if (committedRes.map(resKey).join('\n') !== wantRes.map(resKey).join('\n')) {
    drift.push(`${IOS_RESOURCES} RESOURCES drifted from ios-RESOURCES.rows`);
  }
  if (committedTrees.map(treeKey).join('\n') !== wantTrees.map(treeKey).join('\n')) {
    drift.push(`${IOS_HEADER} TREES drifted from ios-TREES.rows`);
  }
  const dupes = wantRes.map((r) => r.suffix).filter((s, i, a) => a.indexOf(s) !== i);
  for (const s of new Set(dupes)) disk.push(`duplicate RESOURCES accessor suffix: ${s}`);
  for (const gone of wantRes.filter((r) => !resExists(r))) {
    disk.push(`RESOURCES row names a missing file: ${gone.suffix}=`
      + `${gone.root === 'REPO' ? 'repo:' : ''}${gone.rel}`);
  }
  for (const gone of wantTrees.filter((r) => !existsSync(join(DSH, r.source)))) {
    disk.push(`TREES row names a missing source: ${gone.bundle}=${gone.source}`);
  }
  return { drift, disk, resSrc, headerSrc, spans: { resOpen, resEnd, treeOpen, treeEnd }, wantRes, wantTrees };
}

function spliceBlock(src, span, body) {
  return `${src.slice(0, span[0])}\n${body.join('\n')}\n${src.slice(span[1])}`;
}

/** --emit half: materialize the two blocks from the declared rows files
 * (never the reverse — the files are the hand-owned source). */
export function iosEmit(dir) {
  const did = [];
  const { drift, disk, resSrc, headerSrc, spans, wantRes, wantTrees } = iosCheck(dir);
  if (disk.length) fail(`the declared ios rows name missing referents: ${disk.join(' · ')}`);
  if (drift.length) {
    writeFileSync(join(REPO, IOS_RESOURCES),
      spliceBlock(resSrc, [spans.resOpen, spans.resEnd], resourcesBody(wantRes)), 'utf8');
    writeFileSync(join(REPO, IOS_HEADER),
      spliceBlock(headerSrc, [spans.treeOpen, spans.treeEnd], treesBody(wantTrees)), 'utf8');
    did.push(`RESOURCES (${wantRes.length} rows) + TREES (${wantTrees.length} roots) `
      + 'blocks materialized from the declared rows');
  }
  return did;
}
