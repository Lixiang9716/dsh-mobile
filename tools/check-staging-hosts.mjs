// dsh:logging-exempt (dev script module: console IS the product, like check-bundle-files.mjs)
/**
 * check-staging-hosts.mjs — the per-host staging-manifest readers for
 * check-staging (the three host adapters) plus the host wiring that turns
 * parsed manifests into checkable surfaces:
 *
 *   harmony — Index.ets BUNDLE_FILES rows (primary, stale-judged against the
 *             committed rawfile/dsh tree) + ci/vendor-official.sh
 *             CLOSURE/SPINE_OURS (advisory);
 *   android — ci/stage-spine-closure.sh scenario hand list + whole-dir
 *             mirrors;
 *   ios     — Tools/gen_bundle_header.py RESOURCES hand rows + TREES
 *             whole-dir mirror roots (including the two comprehension rows).
 *
 * Split out of check-staging.mjs purely for the code-size gate; the three
 * files together are one tool — see the CLI's header for the full contract.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, relative as relPath } from 'node:path';
import { REPO, DSH } from './check-staging-graph.mjs';

// --- manifest surfaces ------------------------------------------------------

export const fail = (msg) => { throw new Error(`check-staging: ${msg}`); };

// Quote-bearing patterns are built via new RegExp from plain strings: a quote
// inside a regex LITERAL desyncs govrail's code-size string tracking and
// ghosts phantom INDENT violations (govrail#411) — see check-staging-graph.mjs.
const BUNDLE_ROW = new RegExp("'([^']+)'", 'g');
const UNESCAPED_DQUOTE = new RegExp('(?<!\\\\)"');
const PY_STR = new RegExp('"([^"]*)"', 'g');

/** Index.ets BUNDLE_FILES (harmony): the app-bundle materialization list. */
function harmonyBundleFiles() {
  const file = join(REPO, 'hosts/harmony/entry/src/main/ets/pages/Index.ets');
  const src = readFileSync(file, 'utf8');
  const at = src.indexOf('const BUNDLE_FILES: string[] = [');
  if (at < 0) fail('BUNDLE_FILES not found in hosts/harmony/.../Index.ets');
  const end = src.indexOf('\n];', at);
  if (end < 0) fail('BUNDLE_FILES closing ]; not found in Index.ets');
  const rows = [...src.slice(at, end).matchAll(BUNDLE_ROW)].map((m) => m[1]);
  if (!rows.length) fail('BUNDLE_FILES parsed to zero rows in Index.ets');
  return { file, rows: [...new Set(rows)] };
}

/** Shell double-quoted assignments in a script, multiline, in file order —
 * a name may be assigned MORE THAN ONCE (CLOSURE is built up: base list,
 * then CLOSURE="$CLOSURE\n$SPINE_OURS…"), so values accumulate as groups;
 * $() command substitutions are kept as opaque parts and simple
 * VAR=value bindings collected for interpolation. */
function shellAssignments(file) {
  const src = readFileSync(file, 'utf8');
  const quoted = new Map(); // NAME -> [parts[], ...] one parts[] per assignment
  const simple = new Map(); // NAME -> value
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const [, name, rest] = m;
    if (rest.startsWith('"')) {
      const parts = [];
      let buf = rest.slice(1);
      let j = i;
      for (;;) {
        const close = buf.search(UNESCAPED_DQUOTE);
        if (close >= 0) {
          parts.push(`${buf.slice(0, close)}\n`);
          if (!quoted.has(name)) quoted.set(name, []);
          quoted.get(name).push(parts);
          break;
        }
        parts.push(`${buf}\n`);
        j += 1;
        if (j >= lines.length) fail(`unterminated quote in ${name} (${file})`);
        buf = lines[j];
      }
      // continue scanning after the closing line
      i = j;
      continue;
    }
    if (rest.startsWith('$(')) continue; // computed (ROOT=$(cd ...)) — not a row list
    simple.set(name, rest.trim());
  }
  return { quoted, simple };
}

/** Remove every $( … ) command substitution from a shell string — the
 * vendor-official.sh CLOSURE embeds `$(cd … && find … \( -name '*.js' … \) …)`
 * spans whose rows are generated at stage time. Balanced scan; a backslashed
 * paren (\( in find filters) is a literal, not depth. */
function stripSubshells(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('$(', i);
    if (at < 0) { out += text.slice(i); break; }
    out += text.slice(i, at);
    let depth = 0;
    let j = at + 1;
    for (; j < text.length; j += 1) {
      const c = text[j];
      if (c === '\\') { j += 1; continue; }
      if (c === '(') depth += 1;
      else if (c === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (j >= text.length) fail('unterminated $( … ) substitution in vendor-official.sh');
    i = j + 1;
  }
  return out;
}

/** Expand a shell assignment into its whitespace-separated rows. Each
 * assignment REPLACES the value (shell semantics): `SPINE_OURS="$SPINE_OURS
 * \n…"` means previous-value + more, so a self-reference resolves to the
 * value accumulated so far and the group's expansion becomes the new
 * value. $() spans are dropped (their rows are vendor trees generated by
 * `find` at stage time — out of check-(a) scope, existence enforced by the
 * find itself). */
function expandShellRows(name, quoted, simple, cache = new Map(), active = new Set()) {
  if (cache.has(name)) return cache.get(name);
  const groups = quoted.get(name);
  if (!groups) fail(`shell assignment ${name} not found`);
  active.add(name);
  let acc = '';
  for (const parts of groups) {
    let text = parts.join('');
    text = stripSubshells(text);
    for (const [varName, value] of simple) {
      text = text.split(`$${varName}`).join(value);
    }
    text = text.replace(/\$[A-Z_][A-Z0-9_]*/g, (ref) => {
      const refName = ref.slice(1);
      if (refName === name) return acc; // self-reference: value so far
      if (quoted.has(refName)) {
        if (active.has(refName)) fail(`cyclic shell assignment: ${refName}`);
        return expandShellRows(refName, quoted, simple, cache, active).join('\n');
      }
      return '';
    });
    acc = text; // an assignment REPLACES the value
  }
  active.delete(name);
  cache.set(name, acc.split(/\s+/).filter(Boolean));
  return cache.get(name);
}

/** vendor-official.sh CLOSURE (harmony officialweb + spine rawfile surface):
 * secondary surface — stale-row check plus an advisory coverage column. */
function harmonyClosureSurface() {
  const file = join(REPO, 'hosts/harmony/ci/vendor-official.sh');
  const { quoted, simple } = shellAssignments(file);
  if (!quoted.has('CLOSURE')) fail('CLOSURE assignment not found in vendor-official.sh');
  const rows = expandShellRows('CLOSURE', quoted, simple);
  return {
    file, label: 'ci/vendor-official.sh CLOSURE/SPINE_OURS',
    rows: [...new Set(rows)],
  };
}

/** stage-spine-closure.sh (android): scenario hand list + whole-dir mirrors. */
function androidSurface() {
  const file = join(REPO, 'hosts/android/ci/stage-spine-closure.sh');
  const src = readFileSync(file, 'utf8');
  const loopAt = src.indexOf('cp "$DSH/scenario/$s"');
  if (loopAt < 0) fail('scenario copy loop not found in stage-spine-closure.sh');
  const head = src.lastIndexOf('for s in', loopAt);
  if (head < 0) fail('for s in loop header not found in stage-spine-closure.sh');
  const header = src.slice(head, loopAt).split('; do')[0];
  const names = header.slice('for s in'.length).replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean);
  if (!names.length) fail('scenario staging list parsed to zero rows (android)');
  const mirrors = [];
  const mirrorOf = (needle, rel) => {
    if (!src.includes(needle)) fail(`whole-dir mirror gone from stage-spine-closure.sh: ${needle}`);
    mirrors.push(rel);
  };
  mirrorOf('find "$DSH/upstream"', 'upstream/**');
  mirrorOf('find "$DSH/upstream/shims"', 'upstream/shims/**');
  mirrorOf('"$DSH"/system-plugins/*/', 'system-plugins/**');
  return { file, label: 'ci/stage-spine-closure.sh', scenarioRows: names.map((s) => `scenario/${s}`), mirrors };
}

// --- gen_bundle_header.py (ios) block scanners -------------------------------

/** Index of the double quote closing the Python string opened at `open`
 * (src[open] === '"'), honoring backslash escapes; src.length when the
 * string never closes (the caller's bounds check then fails loud). */
function pyStringClose(text, open) {
  let i = open + 1;
  while (i < text.length && text[i] !== '"') {
    if (text[i] === '\\') i += 1;
    i += 1;
  }
  return i;
}

/** Index of the `]` closing the Python list segment opened at `open` —
 * comments are skipped whole (their quotes and parens are prose, e.g. `(the
 * "/" surface's session plugins)`) and only double-quoted spans count as
 * strings (the file uses no single-quoted strings; comment apostrophes like
 * "loader's" would desync a naive quote tracker). Fails loud when the
 * segment never closes. */
function pyListClose(text, open, name) {
  let depth = 0;
  let i = open;
  for (; i < text.length; i += 1) {
    const c = text[i];
    if (c === '#') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (c === '"') { i = pyStringClose(text, i); continue; }
    if (c === '[') depth += 1;
    else if (c === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return fail(`${name} block closing ] not found in gen_bundle_header.py`);
}

/** Whole Python list literal for `name`, joining `] + [` continuation
 * segments — the TREES block is assembled with those continuations, so a
 * naive `\n]` search would truncate it at the first continuation and
 * silently drop the later mirror rows. Each segment is kept with its
 * closing `]` and newline-terminated. */
function pyListBlock(src, name) {
  const at = src.indexOf(`${name} = [`);
  if (at < 0) fail(`${name} block not found in gen_bundle_header.py`);
  let out = '';
  let seg = src.indexOf('[', at);
  for (;;) {
    const end = pyListClose(src, seg, name);
    out += `${src.slice(seg, end)}]\n`;
    // `] + [` continuation → keep scanning the next segment
    const tail = src.slice(end + 1);
    const cont = tail.match(/^\s*(?:#[^\n]*\n\s*)*\+\s*\[/);
    if (!cont) break;
    seg = end + 1 + cont.index + cont[0].length - 1;
  }
  return out;
}

const PY_PAREN_ROW = /\(((?:[^()]|\([^()]*\))*)\)/gs;
const rootOf = (body) => (body.includes('DSH') ? 'DSH' : body.includes('REPO') ? 'REPO' : null);

/** (suffix, PATH) paren rows in a block body — { rel, root: 'DSH'|'REPO' };
 * skips anything that is not a (suffix, PATH) row (no DSH/REPO root, or
 * fewer than two strings). */
function pyRows(text) {
  const rows = [];
  for (const m of text.matchAll(PY_PAREN_ROW)) {
    const strs = [...m[1].matchAll(PY_STR)].map((x) => x[1]);
    const root = rootOf(m[1]);
    if (!root || strs.length < 2) continue; // not a (suffix, PATH) row
    rows.push({ rel: strs.slice(1).join('/'), root });
  }
  return rows;
}

/** Index of the bracket/paren closing the opener at `openAt` — comment- and
 * quote-aware (the name lists carry prose comments with bare `)` and `"`
 * inside). Fails loud when the list never closes. */
function pyListEnd(text, openAt) {
  const close = text[openAt] === '[' ? ']' : ')';
  let depth = 1;
  let i = openAt + 1;
  while (i < text.length) {
    const c = text[i];
    if (c === '#') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (c === '"' || c === "'") {
      const q = c;
      i += 1;
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === text[openAt]) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return fail('unterminated comprehension list in gen_bundle_header.py TREES');
}

/** Start of the tuple preceding a comprehension's `for` clause: the tuple
 * precedes its `for`, so walk back from `forAt` over the clause's closing
 * paren and match parens backward to the tuple opener; -1 when absent. */
function pyTupleStart(text, forAt) {
  let i = forAt - 1;
  while (i >= 0 && /\s/.test(text[i])) i -= 1;
  if (i < 0 || text[i] !== ')') return -1;
  let depth = 0;
  for (; i >= 0; i -= 1) {
    const c = text[i];
    if (c === ')') depth += 1;
    else if (c === '(') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Expand TREES comprehension rows — `(PATTERN) for pkg in [names]` /
 * `(TUPLE) for n in (names)`: a new vendored pin joins the mirror by joining
 * the py name list, so the expansion must follow the list, not a snapshot.
 * Returns the expanded mirror roots plus the block with the comprehension
 * spans excised, so a plain pass cannot double-count them. */
function expandPyTrees(treesBlock) {
  const mirrorRoots = [];
  const spans = []; // comprehension constructs to exclude from the plain pass
  const forRe = /\bfor (?:pkg|n) in ([[(])/g;
  let fm;
  while ((fm = forRe.exec(treesBlock))) {
    const openAt = fm.index + fm[0].length - 1;
    const closeAt = pyListEnd(treesBlock, openAt);
    const tupleStart = pyTupleStart(treesBlock, fm.index);
    const tupleText = treesBlock.slice(tupleStart, fm.index);
    const listText = treesBlock.slice(openAt + 1, closeAt);
    const root = rootOf(tupleText);
    const strs = [...tupleText.matchAll(PY_STR)].map((x) => x[1]);
    // comments may carry quoted prose ("the "/" surface") — strip them
    let clean = '';
    for (let i = 0; i < listText.length; i += 1) {
      if (listText[i] === '#') { while (i < listText.length && listText[i] !== '\n') i += 1; continue; }
      clean += listText[i];
    }
    const names = [...clean.matchAll(PY_STR)].map((x) => x[1]);
    if (!root || !names.length || strs.length < 2) {
      console.error(`check-staging: WARN unparsed TREES comprehension row near: ${tupleText.slice(0, 80)}`);
    } else {
      for (const name of names) {
        const segs = strs.slice(1).map((s) => s.replace('%s', name).replace('{pkg}', name));
        mirrorRoots.push({ rel: segs.join('/'), root });
      }
    }
    spans.push([tupleStart, closeAt + 1]);
    forRe.lastIndex = closeAt + 1;
  }
  let rest = treesBlock;
  for (const [a, b] of spans.reverse()) rest = rest.slice(0, a) + rest.slice(b);
  return { mirrorRoots, rest };
}

/** gen_bundle_header.py (ios): RESOURCES hand rows (DSH-rooted rows are
 * bundle-root staging; REPO-rooted rows stage outside runtime/dsh) +
 * TREES whole-dir mirror roots, including the two comprehension rows. */
function iosSurface() {
  const file = join(REPO, 'hosts/ios/Tools/gen_bundle_header.py');
  const src = readFileSync(file, 'utf8');
  const rows = pyRows(pyListBlock(src, 'RESOURCES'));
  if (!rows.length) fail('RESOURCES parsed to zero rows in gen_bundle_header.py');
  const { mirrorRoots, rest } = expandPyTrees(pyListBlock(src, 'TREES'));
  mirrorRoots.push(...pyRows(rest));
  if (!mirrorRoots.length) fail('TREES parsed to zero mirror roots in gen_bundle_header.py');
  return { file, label: 'Tools/gen_bundle_header.py RESOURCES+TREES', rows, mirrorRoots };
}

// --- host wiring ------------------------------------------------------------

const mirrorCovers = (rel, roots) =>
  roots.some((r) => (r.endsWith('/**')
    ? rel.startsWith(r.slice(0, -2))
    : rel === r || rel.startsWith(`${r}/`)));

function listDirFiles(dir) {
  const out = [];
  const visit = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) visit(p);
      else out.push(relPath(dir, p));
    }
  };
  visit(dir);
  return out.sort();
}

function harmonyHost(bf, closure) {
  return {
    label: 'harmony',
    // Fixed boot entries + every scenario row the harmony staging names.
    roots: (surfaces) => [
      'upstream/boot.js', 'upstream/web-boot.js', 'scenario/upstream-suite-leg.js',
      ...surfaces.primary.rows.filter((r) => r.startsWith('scenario/')),
    ],
    surfaces: {
      primary: {
        label: 'Index.ets BUNDLE_FILES',
        rows: bf.rows,
        rowOrigin: bf.file,
        // BUNDLE_FILES materializes from the COMMITTED rawfile tree (the
        // webclient/, credential-stage.js and npm-face-staged vendor/dsh rows live
        // only there), so stale rows are judged against rawfile/dsh —
        // the same root ci/check-bundle-files.mjs pins the list to.
        staleRoot: join(REPO, 'hosts/harmony/entry/src/main/resources/rawfile/dsh'),
        covers: (rel, rows) => rows.includes(rel),
      },
      advisory: {
        label: closure.label,
        rows: closure.rows,
        rowOrigin: closure.file,
        staleRoot: DSH, // vendor-official.sh copies from runtime/dsh
        covers: (rel, rows) => rows.includes(rel),
      },
    },
  };
}

function androidHost(android) {
  return {
    label: 'android',
    roots: (surfaces) => [
      'upstream/boot.js', 'upstream/web-boot.js', 'scenario/upstream-suite-leg.js',
      ...surfaces.primary.scenarioRows,
    ],
    surfaces: {
      primary: {
        label: android.label,
        scenarioRows: android.scenarioRows,
        mirrors: android.mirrors,
        rowOrigin: android.file,
        covers: (rel, _rows, surface) =>
          surface.scenarioRows.includes(rel) || mirrorCovers(rel, surface.mirrors),
      },
    },
  };
}

function iosHost(ios) {
  return {
    label: 'ios',
    // scenario/ rides the whole-dir tree, so EVERY on-disk scenario is an
    // entry the ios embed stages; root the walk at them all.
    roots: (surfaces) => [
      'upstream/boot.js', 'upstream/web-boot.js', 'scenario/upstream-suite-leg.js',
      ...surfaces.primary.mirrorRoots
        .filter((r) => r.root === 'DSH' && (r.rel === 'scenario' || r.rel.startsWith('scenario/')))
        .flatMap((r) => listDirFiles(join(DSH, r.rel)).map((f) => `${r.rel}/${f}`))
        .filter((f) => f.endsWith('.js')),
    ],
    surfaces: {
      primary: {
        label: ios.label,
        rows: ios.rows.filter((r) => r.root === 'DSH').map((r) => r.rel),
        outOfSpikeRows: ios.rows.filter((r) => r.root === 'REPO'),
        mirrorRoots: ios.mirrorRoots,
        rowOrigin: ios.file,
        // REPO-rooted rows stage the repo copies AT the same bundle paths
        // (system-plugins/dsh-fs/... is embedded from the repo tree), so a
        // REPO row covers the matching bundle-root file; its stale check
        // above pins the source's existence.
        repoRows: ios.rows.filter((r) => r.root === 'REPO').map((r) => r.rel),
        covers: (rel, rows, surface) =>
          rows.includes(rel) || surface.repoRows.includes(rel) ||
          mirrorCovers(rel, surface.mirrorRoots.map((r) => r.rel)),
      },
    },
  };
}

/** All three hosts, manifests parsed eagerly in a fixed order (a manifest
 * this tool cannot parse is a manifest nobody can trust — fail loud before
 * any check runs, whatever --host selected). */
export function buildHosts() {
  const harmonyBf = harmonyBundleFiles();
  const harmonyClosure = harmonyClosureSurface();
  const android = androidSurface();
  const ios = iosSurface();
  return {
    harmony: harmonyHost(harmonyBf, harmonyClosure),
    android: androidHost(android),
    ios: iosHost(ios),
  };
}
