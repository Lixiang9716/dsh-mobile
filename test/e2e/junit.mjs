#!/usr/bin/env node
/**
 * JUnit XML for the E2E verdicts — the machine-readable form of what
 * check.mjs decides.
 *
 * Why this exists: the checker already renders a failure as a diagnosis, but it
 * ships it as JSON on stdout plus an exit code, so a CI failure reaches the pull
 * request as "the step is red" and nothing else. JUnit XML is the artifact
 * GitHub turns into per-test annotations (uploaded, or handed to a reporter),
 * so the SAME diagnosis arrives attached to the scenario that produced it —
 * "m2.gateway.binding missed fs.denied at expected[4]" instead of "e2e failed".
 *
 * Shape: one <testsuite> per verdict, one <testcase> per verdict, with
 *   classname = e2e.<scenario>, name = <scenario>,
 * a failed verdict carrying a <failure> whose text is the verdict's
 * failures / parseErrors rendered readable (the checker's own diagnosis, not a
 * re-derivation of it), and the verdict's CI provenance — runId / commit /
 * producedAt, stamped by check.mjs when it runs under GITHUB_RUN_ID — riding as
 * suite <properties> and in the testcase <system-out>. Provenance is not
 * decoration: the verdict JSON is committed evidence, and "which run earned
 * this" is the same question one level down.
 *
 * tools/ dev script (out of the logging gate's scope; console IS the product).
 *
 * usage: junit.mjs [--out <xml>] <verdict.json> [<verdict.json> ...]
 *        (stdout when --out is omitted) — exit 0 written, 2 unusable input.
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* --- XML plumbing: a document a strict reader rejects is worse than none --- */

/** Characters XML 1.0 forbids outright; a captured log line can still carry them. */
const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]/g;

const TEXT_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const ATTR_ESCAPES = { ...TEXT_ESCAPES, '"': '&quot;', "'": '&apos;' };

const escape = (value, table) => String(value ?? '')
  .replace(ILLEGAL_XML_CHARS, '\uFFFD')
  .replace(/[&<>"']/g, (char) => table[char] ?? char);

/** Element text: newlines are content and stay as written; quotes stay readable. */
const text = (value) => escape(value, TEXT_ESCAPES);

/** Attribute value: quoted literals must be entity-escaped, and folded to one line. */
const attr = (value) => escape(value, ATTR_ESCAPES).replace(/\r?\n/g, ' ');

/* --- The diagnosis: the checker's own failure report, rendered readable ---- */

const PROVENANCE_KEYS = ['runId', 'commit', 'producedAt'];

/** [name, value] pairs for the verdict's CI provenance — empty outside CI. */
const provenanceRows = (verdict) =>
  PROVENANCE_KEYS.filter((key) => verdict[key]).map((key) => [key, String(verdict[key])]);

/** The expectation as the manifest declares it: expected[i] name + field matchers.
 * The index sits on the FAILURE entry, not inside its `expected` snapshot. */
const expectationLine = (failure) => {
  const expect = failure.expected;
  const name = expect.primitive !== undefined
    ? `primitive "${expect.primitive}"`
    : `event "${expect.event}"`;
  const fields = Object.keys(expect.match ?? {});
  const want = fields.length ? ` match ${JSON.stringify(expect.match)}` : '';
  return `expected[${failure.index ?? '?'}] ${name}${want}`;
};

/** What sat at that position — or the absence that failed the match. */
const loggedLine = (logged) => (logged
  ? `logged   line ${logged.line}: ${JSON.stringify(logged.payload)}`
  : 'logged   nothing — the stream ended, or this position holds no matching record');

/** One entry of the verdict's `failures` array: a mismatch, or trailing extras. */
const failureLines = (failure) => {
  if (Array.isArray(failure.extra)) {
    return [
      `unexpected record(s) past the last expectation (${failure.extra.length}):`,
      ...failure.extra.map((payload) => `  ${JSON.stringify(payload)}`),
    ];
  }
  if (!failure.expected) return [`unrecognised failure entry: ${JSON.stringify(failure)}`];
  return [expectationLine(failure), loggedLine(failure.logged)];
};

/** The one-line summary: what went wrong, in counts, for the annotation title. */
const failureMessage = (verdict) => {
  const counts = `${(verdict.failures ?? []).length} unmatched expectation(s), `
    + `${(verdict.parseErrors ?? []).length} unparsable line(s)`;
  return `${counts} in ${verdict.scenario}`;
};

/** The <failure> body: counts, provenance, then every mismatch and bad line. */
const diagnosis = (verdict) => {
  const lines = [
    `scenario: ${verdict.scenario}`,
    `verdict:  FAIL — ${verdict.expected} expected, ${verdict.logged} logged`,
    ...provenanceRows(verdict).map(([name, value]) => `${name}: ${value}`),
  ];
  const failures = verdict.failures ?? [];
  failures.forEach((failure, i) => {
    lines.push('', `failure ${i + 1}/${failures.length}:`, ...failureLines(failure));
  });
  const parseErrors = verdict.parseErrors ?? [];
  if (parseErrors.length) {
    lines.push('', `unparsable log line(s): ${parseErrors.length}`);
    for (const error of parseErrors) lines.push(`  line ${error.line}: ${error.text}`);
  }
  return lines.join('\n');
};

/* --- Element rendering ----------------------------------------------------- */

const className = (verdict) => `e2e.${verdict.scenario}`;

/** JUnit's timestamp format is ISO-8601 to the second, no zone suffix. */
const junitTimestamp = (iso) => {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 19);
};

const suiteOpenTag = (verdict) => {
  const failed = verdict.pass === true ? 0 : 1;
  const stamp = verdict.producedAt ? junitTimestamp(verdict.producedAt) : null;
  const when = stamp ? ` timestamp="${attr(stamp)}"` : '';
  return `<testsuite name="${attr(className(verdict))}" tests="1" failures="${failed}"`
    + ` errors="0" skipped="0" time="0"${when}>`;
};

const propertyLines = (verdict) => {
  const rows = [
    ['scenario', verdict.scenario],
    ...provenanceRows(verdict),
    ['expected', verdict.expected ?? '?'],
    ['logged', verdict.logged ?? '?'],
  ];
  return rows.map(([name, value]) => `    <property name="${attr(name)}" value="${attr(value)}"/>`);
};

const failureElement = (verdict) => [
  `    <failure message="${attr(failureMessage(verdict))}" type="E2EVerdictMismatch">`,
  text(diagnosis(verdict)),
  '    </failure>',
];

/** Traceability at the testcase level too: reporters surface system-out, not suite properties. */
const systemOut = (verdict) => [
  `scenario: ${verdict.scenario}`,
  `result: ${verdict.pass === true ? 'PASS' : 'FAIL'}`,
  ...provenanceRows(verdict).map(([name, value]) => `${name}: ${value}`),
].join('\n');

const suiteLines = (verdict) => {
  const lines = [
    suiteOpenTag(verdict),
    '  <properties>',
    ...propertyLines(verdict),
    '  </properties>',
    `  <testcase classname="${attr(className(verdict))}" name="${attr(verdict.scenario)}" time="0">`,
  ];
  if (verdict.pass !== true) lines.push(...failureElement(verdict));
  lines.push(`    <system-out>${text(systemOut(verdict))}</system-out>`);
  lines.push('  </testcase>', '</testsuite>');
  return lines;
};

/** ONE JUnit document for every verdict given, in the order given. */
export const toJUnit = (verdicts) => {
  const failed = verdicts.filter((verdict) => verdict.pass !== true).length;
  const head = `<testsuites name="dsh-mobile e2e" tests="${verdicts.length}"`
    + ` failures="${failed}" errors="0" time="0">`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    head,
    ...verdicts.flatMap(suiteLines),
    '</testsuites>',
    '',
  ].join('\n');
};

export const writeJUnit = (path, verdicts) => {
  writeFileSync(path, toJUnit(verdicts));
};

/* --- CLI ------------------------------------------------------------------- */

const usage = () => {
  console.error('usage: junit.mjs [--out <xml>] <verdict.json> [<verdict.json> ...]');
  process.exit(2);
};

const parseArgs = (argv) => {
  const files = [];
  let out = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1]) {
      out = argv[i + 1];
      i += 1;
    } else if (argv[i].startsWith('--')) {
      usage();
    } else {
      files.push(argv[i]);
    }
  }
  if (!files.length) usage();
  return { out, files };
};

/** Rule 5: an unusable verdict names itself and stops the run — never a silent skip. */
const loadVerdict = (path) => {
  let verdict;
  try {
    verdict = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`junit: unusable verdict ${path}: ${err.message}`);
    process.exit(2);
  }
  if (typeof verdict?.scenario !== 'string' || typeof verdict?.pass !== 'boolean') {
    console.error(`junit: ${path} is not a check.mjs verdict — a string "scenario" and `
      + 'a boolean "pass" are required');
    process.exit(2);
  }
  return verdict;
};

/** True only when this module IS the entry point: check.mjs imports the
 * converter, and an unguarded main() would then parse the CHECKER's argv. */
const isEntryPoint = () => {
  if (!process.argv[1]) return false;
  try {
    const self = fileURLToPath(import.meta.url);
    return realpathSync(process.argv[1]) === realpathSync(self);
  } catch {
    return false;
  }
};

const main = () => {
  const { out, files } = parseArgs(process.argv.slice(2));
  const verdicts = files.map(loadVerdict);
  const xml = toJUnit(verdicts);
  if (!out) {
    process.stdout.write(xml);
    return;
  }
  writeFileSync(out, xml);
  const failed = verdicts.filter((verdict) => verdict.pass !== true).length;
  console.log(`junit: wrote ${out} — ${verdicts.length} scenario(s), ${failed} failing`);
};

if (isEntryPoint()) main();
