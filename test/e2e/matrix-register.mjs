// dsh:logging-exempt (dev script: console IS the product, like check.mjs)
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const REGISTER_HEADER = ['code', 'file', 'owner', 'closes with'];
export const KNOWN_GAP_BUDGET = 9;

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '')
  .split('|').map((c) => c.trim());
const isRule = (c) => c.length > 0 && c.every((x) => /^:?-{2,}:?$/.test(x));
const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ');

/** Parse the known-gaps register out of the matrix doc: the first table headed
 *  `| code | file | owner | closes with |` starts it and every following
 *  `|`-row is one owned gap. Strict on purpose — a register that cannot be
 *  read is a finding of its own (rule 5), never a silent accept or reject. */
export const parseRegister = (text) => {
  const lines = text.split('\n');
  const head = lines.findIndex((l) => {
    const c = cells(l).map(norm);
    return c.length === REGISTER_HEADER.length && REGISTER_HEADER.every((h, i) => c[i] === h);
  });
  if (head === -1) return { rows: [], missing: true };
  const rows = [];
  for (const line of lines.slice(head + 1)) {
    if (!line.trim().startsWith('|')) break;
    const c = cells(line);
    if (isRule(c)) continue;
    if (c.length !== REGISTER_HEADER.length || c.some((x) => x === '')) {
      return { rows, malformed: line.trim() };
    }
    rows.push({ code: c[0], file: c[1], owner: c[2], closesWith: c[3] });
  }
  return { rows, missing: false };
};

/** Load the register. A doc that cannot be read, or a table that does not
 *  parse, is an ISSUE finding — never a silent empty set (rule 5). */
export const loadRegister = (path) => {
  const doc = relative(REPO_ROOT, path) || path;
  let text = null;
  try { text = readFileSync(path, 'utf8'); } catch { text = null; }
  if (text === null) {
    return { doc, rows: [], issue: { code: 'REGISTER_MISSING', file: doc, detail: 'unreadable' } };
  }
  const parsed = parseRegister(text);
  if (parsed.missing) {
    return { doc, rows: [], issue: { code: 'REGISTER_MISSING', file: doc,
      detail: `no table headed | ${REGISTER_HEADER.join(' | ')} |` } };
  }
  if (parsed.malformed) {
    return { doc, rows: parsed.rows, issue: { code: 'REGISTER_MALFORMED', file: doc,
      detail: `not ${REGISTER_HEADER.length} non-empty cells: ${parsed.malformed}` } };
  }
  return { doc, rows: parsed.rows, issue: null };
};

const gapKey = (code, file) => `${code}\t${file}`;

/** The register's own defects: an unreadable register, a row whose finding is
 *  gone (a closed gap left behind — the register must shrink with it), or a
 *  backlog grown past the budget. All of them block in either invocation. */
export const registerDefectFindings = (reg, unmatched) => {
  const out = reg.issue ? [reg.issue] : [];
  for (const r of unmatched) {
    out.push({ code: 'STALE_KNOWN_GAP', file: r.file, gap: r,
      detail: `no finding matches this row (owner: ${r.owner}) — strike it in the same change` });
  }
  if (reg.rows.length > KNOWN_GAP_BUDGET) {
    out.push({ code: 'REGISTER_GROWN', file: reg.doc,
      detail: `${reg.rows.length} rows exceed the budget ${KNOWN_GAP_BUDGET} — accepting a new ` +
        'gap means raising KNOWN_GAP_BUDGET in test/e2e/matrix.mjs, deliberately' });
  }
  return out;
};

/** Split the inventory's findings against the register: `accepted` are the
 *  rows' owned gaps, `blocking` is everything that must fail the run (findings
 *  no row names, plus the register's own defects and stale rows). */
export const evaluate = (inv, reg) => {
  const rows = [...reg.rows];
  const accepted = [];
  const blocking = [];
  for (const f of inv.findings) {
    const row = rows.find((r) => gapKey(r.code, r.file) === gapKey(f.code, f.file));
    if (!row) { blocking.push(f); continue; }
    rows.splice(rows.indexOf(row), 1);
    accepted.push({ ...f, gap: row });
  }
  return { blocking: [...registerDefectFindings(reg, rows), ...blocking], accepted };
};

// --- report ---------------------------------------------------------------

