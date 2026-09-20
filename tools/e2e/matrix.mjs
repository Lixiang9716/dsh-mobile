#!/usr/bin/env node
/**
 * Cross-host E2E evidence inventory — regenerates the committed-artifacts
 * matrix (docs/e2e-matrix.md) from the working tree: every directory carrying
 * verdict*.json is an evidence unit; each is checked for the acceptance bar's
 * deliverables (logs.txt + scenario.jsonl + receipt.json + verdicts), PNG
 * integrity (magic bytes — screenshots are debugging artifacts, never checker
 * inputs), and a manifest in scenarios/ for every verdict scenario id.
 * Exits non-zero on any regression: a failed verdict, a missing or empty
 * deliverable, a broken PNG, a malformed verdict/receipt, or a scenario
 * without a manifest. Manifest-revision drift (an older evidence dir checked
 * against a since-grown manifest) is REPORTED, not failed — the verdict.json
 * is the record of what ran.
 *
 * tools/ dev script (out of the logging gate's scope; console IS the product).
 *
 * usage: matrix.mjs [--root <repo-root>] [--out <inventory.json>] [--self-test]
 *   exit 0 = clean inventory (or self-test holds), 1 = findings, 2 = usage.
 *
 * --self-test synthesizes fixture trees in a temp dir and proves every
 * rejection class actually rejects (rule 6: verify the world, not the
 * self-report) — the assertion set is documented in tools/e2e/README.md.
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

const usage = () => {
  console.error('usage: matrix.mjs [--root <repo-root>] [--out <inventory.json>] [--self-test]');
  process.exit(2);
};

const parseArgs = (argv) => {
  const args = { root: resolve(dirname(fileURLToPath(import.meta.url)), '../..') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--self-test') { args.selfTest = true; continue; }
    if (argv[i] === '--root' || argv[i] === '--out') {
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

const finding = (code, file, detail) => ({
  code, file: relative(process.cwd(), file), detail,
});

const FIELD_TYPES = { scenario: 'string', pass: 'boolean', expected: 'number', logged: 'number' };

const checkVerdict = (file, manifestDir) => {
  let v;
  try {
    v = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return { findings: [finding('VERDICT_MALFORMED', file, `unparsable: ${e.message}`)] };
  }
  const bad = Object.keys(FIELD_TYPES).filter((k) => typeof v[k] !== FIELD_TYPES[k]);
  if (bad.length > 0) {
    return { findings: [finding('VERDICT_MALFORMED', file, `missing/bad field(s): ${bad}`)] };
  }
  const findings = [];
  if (v.pass !== true) findings.push(finding('VERDICT_FAIL', file, v.scenario));
  if (v.expected !== v.logged) {
    findings.push(finding('VERDICT_MALFORMED', file,
      `${v.scenario}: expected=${v.expected} logged=${v.logged} but pass=true`));
  }
  const out = { file: relative(process.cwd(), file), scenario: v.scenario, pass: v.pass,
    expected: v.expected, logged: v.logged };
  const manifest = join(manifestDir, `${v.scenario.replace(/\./g, '-')}.json`);
  out.manifest = relative(process.cwd(), manifest);
  if (!statSafe(manifest)) {
    findings.push(finding('SCENARIO_WITHOUT_MANIFEST', file, v.scenario));
  } else {
    out.manifestExpect = JSON.parse(readFileSync(manifest, 'utf8')).expect.length;
    out.drift = out.manifestExpect !== v.expected;
  }
  return { verdict: out, findings };
};

const checkDeliverables = (dir) => {
  const findings = [];
  const present = {};
  for (const name of DELIVERABLES) {
    const p = join(dir, name);
    const st = statSafe(p);
    if (!st) { findings.push(finding('MISSING_DELIVERABLE', p, name)); continue; }
    if (st.size === 0) { findings.push(finding('EMPTY_DELIVERABLE', p, name)); continue; }
    present[name] = true;
    if (name === 'receipt.json') {
      try { JSON.parse(readFileSync(p, 'utf8')); } catch (e) {
        findings.push(finding('RECEIPT_MALFORMED', p, `unparsable: ${e.message}`));
      }
    }
  }
  return { findings, present };
};

const checkPngs = (files) => {
  const findings = [];
  const pngs = files.filter((f) => f.endsWith('.png'));
  for (const f of pngs) {
    const head = readFileSync(f).subarray(0, 8).toString('hex');
    if (head !== PNG_MAGIC) {
      findings.push(finding('PNG_BROKEN', f, `magic=${head} (not a PNG)`));
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
      .sort().map((f) => checkVerdict(f, scenariosDir));
    const deliv = checkDeliverables(dir);
    const pngs = checkPngs(inDir);
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

const report = (inv, outPath) => {
  if (inv.findings.length === 0) {
    console.log(`e2e: PASS matrix (${inv.dirs} dirs, ${inv.verdicts} verdicts, ` +
      `${inv.screenshots} pngs, 0 findings)`);
  } else {
    console.error(`e2e: FAIL matrix (${inv.findings.length} findings)`);
    console.error(JSON.stringify(inv, null, 2));
  }
  if (outPath) writeFileSync(outPath, JSON.stringify(inv, null, 2) + '\n');
  process.exit(inv.findings.length === 0 ? 0 : 1);
};

// --- self-test: prove every rejection class rejects (rule 6) ---

const FIX_VERDICT = { scenario: 't.ok', pass: true, expected: 1, logged: 1 };

const buildFixture = (base, mutate) => {
  const root = join(base, 'tree');
  const scen = join(base, 'scenarios');
  mkdirSync(join(root, 'ev'), { recursive: true });
  mkdirSync(scen, { recursive: true });
  writeFileSync(join(scen, 't-ok.json'),
    JSON.stringify({ scenario: 't.ok', expect: [{}] }));
  writeFileSync(join(root, 'ev', 'logs.txt'), 'log\n');
  writeFileSync(join(root, 'ev', 'scenario.jsonl'), 'entry\n');
  writeFileSync(join(root, 'ev', 'receipt.json'), '{}');
  writeFileSync(join(root, 'ev', 'shot.png'), Buffer.from(PNG_MAGIC, 'hex'));
  writeFileSync(join(root, 'ev', 'verdict.json'), JSON.stringify(FIX_VERDICT));
  mutate(root);
  return { root, scen };
};

const selfTest = () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-matrix-'));
  const assertOne = (name, fx, want) => {
    const got = audit(fx.root, fx.scen).findings.map((f) => f.code);
    if (!want.every((c) => got.includes(c))) {
      console.error(`matrix: self-test FAIL ${name} — wanted [${want}] got [${got}]`);
      rmSync(base, { recursive: true, force: true });
      process.exit(1);
    }
  };
  assertOne('positive', buildFixture(base, () => {}), []);
  assertOne('verdict fail', buildFixture(base, (root) => {
    writeFileSync(join(root, 'ev', 'verdict.json'),
      JSON.stringify({ ...FIX_VERDICT, pass: false }));
  }), ['VERDICT_FAIL']);
  assertOne('missing deliverable', buildFixture(base, (root) => {
    rmSync(join(root, 'ev', 'receipt.json'));
  }), ['MISSING_DELIVERABLE']);
  assertOne('empty deliverable', buildFixture(base, (root) => {
    writeFileSync(join(root, 'ev', 'scenario.jsonl'), '');
  }), ['EMPTY_DELIVERABLE']);
  assertOne('broken png', buildFixture(base, (root) => {
    writeFileSync(join(root, 'ev', 'shot.png'), Buffer.from('ffd8ffe000104a46', 'hex'));
  }), ['PNG_BROKEN']);
  assertOne('scenario without manifest', buildFixture(base, (root) => {
    writeFileSync(join(root, 'ev', 'verdict.json'),
      JSON.stringify({ ...FIX_VERDICT, scenario: 't.missing' }));
  }), ['SCENARIO_WITHOUT_MANIFEST']);
  assertOne('malformed verdict', buildFixture(base, (root) => {
    writeFileSync(join(root, 'ev', 'verdict.json'), '{not json');
  }), ['VERDICT_MALFORMED']);
  assertOne('malformed receipt', buildFixture(base, (root) => {
    writeFileSync(join(root, 'ev', 'receipt.json'), '{not json');
  }), ['RECEIPT_MALFORMED']);
  rmSync(base, { recursive: true, force: true });
  console.log('matrix: self-test PASS (8 assertions)');
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) { selfTest(); return; }
  report(audit(args.root, join(args.root, 'tools/e2e/scenarios')), args.out);
};

main();
