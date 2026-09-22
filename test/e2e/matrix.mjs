#!/usr/bin/env node
/**
 * Cross-host E2E evidence inventory — regenerates the committed-artifacts
 * matrix (docs/e2e-matrix.md) from the working tree: every directory carrying
 * verdict*.json is an evidence unit; each is checked for the acceptance bar's
 * deliverables (logs.txt + scenario.jsonl + receipt.json + verdicts), PNG
 * integrity (magic bytes — screenshots are debugging artifacts, never checker
 * inputs), and a manifest in scenarios/ for every verdict scenario id.
 *
 * Exit contract — one truth, two invocations (the second is what a gate wires):
 *
 *   default             report EVERY finding and exit 1 on any of them,
 *                       registered or not: the unvarnished list.
 *   --accept-known-gaps exit 0 while every finding is a row of the known-gaps
 *                       register, and 1 on (a) a finding no row names — a NEW
 *                       regression; (b) a row whose finding is gone — STALE,
 *                       and a closed gap is struck from the register in the
 *                       same change; (c) a register grown past
 *                       KNOWN_GAP_BUDGET — the backlog shrinks by default.
 *
 * The register is machine-read from the known-gaps table of docs/e2e-matrix.md:
 * the human honest list IS the register — never a second copy to drift — and an
 * unreadable one is itself a finding (rule 5: fail loud, never silently skip).
 * Manifest-revision drift (an older evidence dir checked against a since-grown
 * manifest) is REPORTED, not failed — the verdict.json is the record of what ran.
 *
 * tools/ dev script (out of the logging gate's scope; console IS the product).
 *
 * usage: matrix.mjs [--root <repo-root>] [--out <inventory.json>]
 *        [--register <doc.md>] [--accept-known-gaps] [--self-test]
 *   exit 0 = clean inventory (or every finding is a registered, owned gap, or
 *   the self-test holds), 1 = findings, 2 = usage.
 *
 * --self-test synthesizes fixture trees in a temp dir and proves every
 * rejection class actually rejects (rule 6: verify the world, not the
 * self-report) — the assertion set is documented in test/e2e/README.md.
 */
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PNG_MAGIC = '89504e470d0a1a0a';
const DELIVERABLES = ['logs.txt', 'scenario.jsonl', 'receipt.json'];
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const VERDICT_RE = /^verdict(?:-.+)?\.json$/;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTER_DOC = 'docs/e2e-matrix.md';
const REGISTER_HEADER = ['code', 'file', 'owner', 'closes with'];
/** The register size at which this checker first became gate-able: the seven
 *  host receipts awaiting their owning work stream's re-run plus the two
 *  quota-blocked harmony m2.llm verdicts. Accepting a NEW gap means raising
 *  this number in the same change — deliberate and reviewed, never a drift. */
const KNOWN_GAP_BUDGET = 9;

const usage = () => {
  console.error('usage: matrix.mjs [--root <repo-root>] [--out <inventory.json>] ' +
    '[--register <doc.md>] [--accept-known-gaps] [--self-test]');
  process.exit(2);
};

const parseArgs = (argv) => {
  const args = { root: REPO_ROOT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--self-test') { args.selfTest = true; continue; }
    if (argv[i] === '--accept-known-gaps') { args.acceptKnownGaps = true; continue; }
    if (argv[i] === '--root' || argv[i] === '--out' || argv[i] === '--register') {
      if (!argv[i + 1]) usage();
      args[argv[i].slice(2)] = resolve(argv[++i]);
      continue;
    }
    usage();
  }
  return args;
};

const walkFiles = (dir, out = []) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
};

const statSafe = (p) => {
  try { return statSync(p); } catch { return null; }
};

const baseName = (p) => p.split('/').pop();

/** Platform label from the path: the segment before `artifacts`; the runtime
 *  spike tree's hosts are named by the dir itself (macos-cli*). */
const platformOf = (relDir) => {
  const parts = relDir.split('/');
  const at = parts.indexOf('artifacts');
  const host = at > 0 ? parts[at - 1] : parts[0];
  return host === 'spike' ? 'macos-cli' : host;
};

/** Every path this checker prints or matches is relative to the audited root,
 *  so the register keys, the doc's table and the inventory agree whatever the
 *  process cwd is (findings used to be cwd-relative — the register cannot be
 *  keyed on a path that moves). */
const finding = (root, code, file, detail) => ({ code, file: relative(root, file), detail });

const FIELD_TYPES = { scenario: 'string', pass: 'boolean', expected: 'number', logged: 'number' };

const checkVerdict = (root, file, manifestDir) => {
  let v;
  try {
    v = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { findings: [finding(root, 'VERDICT_MALFORMED', file, `unparsable: ${e.message}`)] };
  }
  const bad = Object.keys(FIELD_TYPES).filter((k) => typeof v[k] !== FIELD_TYPES[k]);
  if (bad.length > 0) {
    return { findings: [finding(root, 'VERDICT_MALFORMED', file, `missing/bad field(s): ${bad}`)] };
  }
  const findings = [];
  if (v.pass !== true) findings.push(finding(root, 'VERDICT_FAIL', file, v.scenario));
  const out = { file: relative(root, file), scenario: v.scenario, pass: v.pass,
    expected: v.expected, logged: v.logged };
  // Manifest resolution: prefer the verdict file's own stem
  // (verdict-<stem>.json → scenarios/<stem>.json — several manifests may
  // share one scenario id, e.g. the m2.llm CLI vs device legs), falling
  // back to the scenario-id convention for plain verdict.json files.
  const stem = (/^verdict-(.+)\.json$/.exec(baseName(file)) ?? [])[1];
  let manifest = join(manifestDir, `${v.scenario.replace(/\./g, '-')}.json`);
  if (stem && statSafe(join(manifestDir, `${stem}.json`))) {
    manifest = join(manifestDir, `${stem}.json`);
  }
  out.manifest = relative(root, manifest);
  let repeatAware = false;
  if (!statSafe(manifest)) {
    findings.push(finding(root, 'SCENARIO_WITHOUT_MANIFEST', file, v.scenario));
  } else {
    const expect = JSON.parse(readFileSync(manifest, 'utf8')).expect;
    out.manifestExpect = expect.length;
    out.drift = out.manifestExpect !== v.expected;
    // Repeat expectations (one-to-many, e.g. the real-LLM legs' delta runs)
    // make logged > expected legitimate for a passing verdict.
    repeatAware = expect.some((e) => e && e.repeat === true);
  }
  // Count consistency is a rule about a PASSING record: `pass: false` with
  // differing counts IS the failure, already reported above — a FAIL verdict
  // must not also draw a notice that claims `pass=true`.
  if (v.pass === true && v.expected !== v.logged && !repeatAware) {
    findings.push(finding(root, 'VERDICT_MALFORMED', file,
      `${v.scenario}: expected=${v.expected} logged=${v.logged} but pass=true`));
  }
  return { verdict: out, findings };
};

const checkDeliverables = (root, dir) => {
  const findings = [];
  const present = {};
  for (const name of DELIVERABLES) {
    const p = join(dir, name);
    const st = statSafe(p);
    if (!st) { findings.push(finding(root, 'MISSING_DELIVERABLE', p, name)); continue; }
    if (st.size === 0) { findings.push(finding(root, 'EMPTY_DELIVERABLE', p, name)); continue; }
    present[name] = true;
    if (name === 'receipt.json') {
      try { JSON.parse(readFileSync(p, 'utf8')); } catch (e) {
        findings.push(finding(root, 'RECEIPT_MALFORMED', p, `unparsable: ${e.message}`));
      }
    }
  }
  return { findings, present };
};

const checkPngs = (root, files) => {
  const findings = [];
  const pngs = files.filter((f) => f.endsWith('.png'));
  for (const f of pngs) {
    const head = readFileSync(f).subarray(0, 8).toString('hex');
    if (head !== PNG_MAGIC) {
      findings.push(finding(root, 'PNG_BROKEN', f, `magic=${head} (not a PNG)`));
    }
  }
  return { findings, count: pngs.length };
};

/** Audit one repo tree; `root` and `scenariosDir` are split so --self-test
 *  can point both at synthetic fixtures. */
export const audit = (root, scenariosDir) => {
  const files = walkFiles(root);
  const verdictDirs = [...new Set(files.filter((f) => VERDICT_RE.test(baseName(f)))
    .map((f) => dirname(f)))].sort();
  const entries = [];
  const findings = [];
  for (const dir of verdictDirs) {
    const inDir = files.filter((f) => dirname(f) === dir || dirname(f).startsWith(`${dir}/`));
    const verdicts = inDir.filter((f) => dirname(f) === dir && VERDICT_RE.test(baseName(f)))
      .sort().map((f) => checkVerdict(root, f, scenariosDir));
    const deliv = checkDeliverables(root, dir);
    const pngs = checkPngs(root, inDir);
    const relDir = relative(root, dir);
    entries.push({
      dir: relDir,
      platform: platformOf(relDir),
      deliverables: deliv.present,
      screenshots: pngs.count,
      verdicts: verdicts.map((v) => v.verdict),
    });
    findings.push(...deliv.findings, ...pngs.findings,
      ...verdicts.flatMap((v) => v.findings));
  }
  return {
    root: relative(process.cwd(), root),
    scenariosDir: relative(process.cwd(), scenariosDir),
    dirs: entries.length,
    verdicts: entries.reduce((n, e) => n + e.verdicts.length, 0),
    screenshots: entries.reduce((n, e) => n + e.screenshots, 0),
    entries,
    findings,
  };
};

// --- the known-gaps register (machine-read; the doc's honest list) ---------

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

const emit = (stream, label, list) => {
  for (const f of list) {
    stream(`e2e: ${label} ${f.code} ${f.file}${f.detail ? ` — ${f.detail}` : ''}`);
    if (f.gap) stream(`e2e:          owner: ${f.gap.owner} | closes with: ${f.gap.closesWith}`);
  }
};

const report = (inv, reg, args) => {
  const ev = evaluate(inv, reg);
  const unregistered = inv.findings.length - ev.accepted.length;
  const defects = ev.blocking.length - unregistered;
  // Default: every finding fails the run. With --accept-known-gaps: only what
  // the register does not own (new findings, stale rows, its own defects).
  const failed = args.acceptKnownGaps ? ev.blocking.length > 0
    : inv.findings.length > 0 || defects > 0;
  const how = args.acceptKnownGaps ? ' under --accept-known-gaps' : '';
  console.log(`e2e: ${failed ? 'FAIL' : 'PASS'} matrix (${inv.dirs} dirs, ` +
    `${inv.verdicts} verdicts, ${inv.screenshots} pngs; ${inv.findings.length} findings${how}: ` +
    `${ev.accepted.length} accepted (owned) gaps, ${unregistered} unregistered, ` +
    `${defects} register defects)`);
  emit(console.error, 'blocking', ev.blocking);
  emit(console.log, 'accepted', ev.accepted);
  if (args.out) {
    const record = { ...inv, evaluation: { blocking: ev.blocking.length,
      accepted: ev.accepted.length, unregistered, registerDefects: defects },
    acceptedGaps: ev.accepted.map((f) => ({ code: f.code, file: f.file, owner: f.gap.owner })) };
    writeFileSync(args.out, JSON.stringify(record, null, 2) + '\n');
  }
  process.exit(failed ? 1 : 0);
};

// --- self-test: prove every rejection class rejects (rule 6) --------------

const FIX_VERDICT = { scenario: 't.ok', pass: true, expected: 1, logged: 1 };

const buildFixture = (base, mutate) => {
  const root = join(base, 'tree');
  const scen = join(base, 'scenarios');
  mkdirSync(join(root, 'ev'), { recursive: true });
  mkdirSync(scen, { recursive: true });
  writeFileSync(join(scen, 't-ok.json'), JSON.stringify({ scenario: 't.ok', expect: [{}] }));
  writeFileSync(join(root, 'ev', 'logs.txt'), 'log\n');
  writeFileSync(join(root, 'ev', 'scenario.jsonl'), 'entry\n');
  writeFileSync(join(root, 'ev', 'receipt.json'), '{}');
  writeFileSync(join(root, 'ev', 'shot.png'), Buffer.from(PNG_MAGIC, 'hex'));
  writeFileSync(join(root, 'ev', 'verdict.json'), JSON.stringify(FIX_VERDICT));
  mutate(root);
  return { root, scen };
};

/** Fixture mutators: one artifact of the tree above, rewritten or removed. */
const at = (name, text) => (root) => writeFileSync(join(root, 'ev', name), text);
const noReceipt = (root) => rmSync(join(root, 'ev', 'receipt.json'));
const verdict = (patch) => at('verdict.json', JSON.stringify({ ...FIX_VERDICT, ...patch }));

const REG_FIXTURE = [
  '| code | file | owner | closes with |',
  '| --- | --- | --- | --- |',
  '| MISSING_DELIVERABLE | ev/receipt.json | android work stream (#66) | run-android-full.sh |',
].join('\n');

const harness = () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-matrix-'));
  const state = { n: 0 };
  const fail = (name, msg) => {
    console.error(`matrix: self-test FAIL ${name} — ${msg}`);
    rmSync(base, { recursive: true, force: true });
    process.exit(1);
  };
  const assert = (name, ok, msg) => { state.n += 1; if (!ok) fail(name, msg); };
  return {
    base,
    fixture: (mutate) => buildFixture(base, mutate),
    done: () => {
      rmSync(base, { recursive: true, force: true });
      console.log(`matrix: self-test PASS (${state.n} assertions)`);
    },
    assertOne: (name, fx, want, notWant = []) => {
      const got = audit(fx.root, fx.scen).findings.map((f) => f.code);
      assert(name, want.every((c) => got.includes(c)) && notWant.every((c) => !got.includes(c)),
        `wanted [${want}] without [${notWant}], got [${got}]`);
    },
    assertEqual: (name, got, want) => assert(name,
      JSON.stringify(got) === JSON.stringify(want),
      `wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`),
  };
};

const selfTestAudit = (t) => {
  t.assertOne('positive', t.fixture(() => {}), []);
  t.assertOne('verdict fail', t.fixture(verdict({ pass: false })), ['VERDICT_FAIL']);
  t.assertOne('missing deliverable', t.fixture(noReceipt), ['MISSING_DELIVERABLE']);
  t.assertOne('empty deliverable', t.fixture(at('scenario.jsonl', '')), ['EMPTY_DELIVERABLE']);
  t.assertOne('broken png', t.fixture(at('shot.png', Buffer.from('ffd8ffe000104a46', 'hex'))),
    ['PNG_BROKEN']);
  t.assertOne('scenario without manifest', t.fixture(verdict({ scenario: 't.missing' })),
    ['SCENARIO_WITHOUT_MANIFEST']);
  t.assertOne('malformed verdict', t.fixture(at('verdict.json', '{not json')), ['VERDICT_MALFORMED']);
  t.assertOne('malformed receipt', t.fixture(at('receipt.json', '{not json')), ['RECEIPT_MALFORMED']);
  // The count-consistency notice is about a PASSING record: a FAIL verdict
  // reports VERDICT_FAIL alone; a passing one with differing counts is caught.
  t.assertOne('fail verdict draws one finding, not a derived notice',
    t.fixture(verdict({ pass: false, logged: 0 })), ['VERDICT_FAIL'], ['VERDICT_MALFORMED']);
  t.assertOne('passing verdict with differing counts', t.fixture(verdict({ logged: 2 })),
    ['VERDICT_MALFORMED']);
};

const selfTestRegister = (t) => {
  const reg = parseRegister(REG_FIXTURE);
  // Each assertion builds the tree it needs: fixtures share one path, so a
  // later build would silently rewrite an earlier one's state.
  const gap = () => audit(t.fixture(noReceipt).root, join(t.base, 'scenarios'));
  const whole = () => audit(t.fixture(() => {}).root, join(t.base, 'scenarios'));
  t.assertEqual('register reads its row', [reg.rows.length, reg.rows[0].code, reg.rows[0].file,
    reg.rows[0].owner, reg.rows[0].closesWith],
  [1, 'MISSING_DELIVERABLE', 'ev/receipt.json', 'android work stream (#66)', 'run-android-full.sh']);
  t.assertEqual('register without its table', [parseRegister('# nothing').missing,
    parseRegister('# nothing').rows.length], [true, 0]);
  t.assertEqual('register row that is not four cells',
    !!parseRegister(`${REG_FIXTURE}\n| MISSING_DELIVERABLE | ev/receipt.json | owner |`).malformed,
    true);
  t.assertEqual('a listed gap is accepted, not blocking',
    [evaluate(gap(), reg).blocking.length, evaluate(gap(), reg).accepted.length], [0, 1]);
  t.assertEqual('a finding no row names blocks',
    evaluate(gap(), parseRegister(REG_FIXTURE.replace('ev/receipt.json', 'ev/other.json')))
      .blocking.map((f) => f.code), ['STALE_KNOWN_GAP', 'MISSING_DELIVERABLE']);
  t.assertEqual('a row whose finding is gone blocks',
    evaluate(whole(), reg).blocking.map((f) => f.code), ['STALE_KNOWN_GAP']);
  t.assertEqual('an unreadable register is its own finding',
    evaluate(gap(), loadRegister(join(t.base, 'absent.md'))).blocking.map((f) => f.code),
  ['REGISTER_MISSING', 'MISSING_DELIVERABLE']);
  t.assertEqual('the backlog cannot grow silently', evaluate({ findings: [] }, {
    doc: 'synthetic.md',
    rows: Array.from({ length: KNOWN_GAP_BUDGET + 1 },
      (_, i) => ({ code: 'X', file: `f${i}`, owner: 'o', closesWith: 'c' })),
  }).blocking.map((f) => f.code).filter((c, i, all) => all.indexOf(c) === i),
  ['STALE_KNOWN_GAP', 'REGISTER_GROWN']);
};

const selfTest = () => {
  const t = harness();
  selfTestAudit(t);
  selfTestRegister(t);
  t.done();
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) { selfTest(); return; }
  const reg = loadRegister(args.register ?? join(REPO_ROOT, REGISTER_DOC));
  report(audit(args.root, join(args.root, 'test/e2e/scenarios')), reg, args);
};

main();
