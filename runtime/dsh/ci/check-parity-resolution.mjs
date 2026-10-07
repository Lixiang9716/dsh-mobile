// dsh:logging-exempt (build tool: its stdout is the verdict)
/**
 * check-parity-resolution.mjs — the #328 gate assertion: a fresh
 * materialization must resolve the specifiers the raw upstream-suite vitest
 * face Cannot-find-packaged on main (js-yaml ×63, tsx ×34,
 * @deepseek-ai/node-addon-system/flock ×24, chokidar ×16,
 * @agentclientprotocol/sdk ×10 — the layout that serves them is built by
 * ci/parity-node-modules.sh, which no refresh path ran before 2026-10-04).
 *
 * Two proof strengths per row:
 *   - require: createRequire(fromDir).resolve(spec) — REAL Node resolution
 *     (the CJS faces);
 *   - walk: the first ancestor node_modules holding the package root — the
 *     structural face for ESM-only exports maps that require.resolve
 *     refuses (ERR_PACKAGE_PATH_NOT_EXPORTED is an exports-map fact, not a
 *     layout fact; the failure class this gate exists for is a MISSING
 *     ancestor node_modules).
 * Every row fails loud naming the offender (rule 5). Wired into
 * reproducibility-proof.sh's full scope; runnable by hand after any
 * materialization.
 */
import { createRequire } from 'node:module';
import { existsSync, readlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VENDOR = resolve(HERE, '../vendor');
const TESTS = join(VENDOR, 'dsh-tests@dsh-v0.1.6-alpha.2');
const INCLUDE_LIB = join(VENDOR, 'npm/@deepseek-ai/cordis-plugin-include@1.0.7/lib');

const failures = [];
let requireResolved = 0;
let walkResolved = 0;
let seatsVerified = 0;

const fail = (message) => { failures.push(message); };

/** The importer dirs are parse-rot canaries: if the materialized tree no
 * longer carries one, the check must say WHICH path rotted, not mask it as
 * a resolution failure (rule 6 — a gate that cannot fail meaningfully is
 * vacuous). */
const requireDir = (label, path) => {
  if (!existsSync(path)) fail(`importer dir rot: ${label} missing (${path}) — the check's own table no longer matches the layout`);
  return path;
};

const resolveLoose = (specifier, fromDir) => {
  try {
    const resolved = createRequire(join(fromDir, 'package.json')).resolve(specifier);
    requireResolved += 1;
    return `require → ${resolved}`;
  } catch (error) {
    if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' && error?.code !== 'MODULE_NOT_FOUND') {
      fail(`"${specifier}" from ${fromDir}: unexpected resolver error ${error?.code}: ${error?.message}`);
      return undefined;
    }
  }
  const pkgRoot = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', pkgRoot);
    if (existsSync(candidate)) {
      walkResolved += 1;
      return `walk → ${candidate}`;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      fail(`"${specifier}" from ${fromDir}: no ancestor node_modules holds "${pkgRoot}" — the #328 break, still live`);
      return undefined;
    }
    dir = parent;
  }
};

/** One nested seat: the per-consumer symlink the layout must carry, at the
 * expected major (the path fragment `name@major` must appear in the link's
 * target — a seat pointing at the wrong major resolves, wrongly). */
const seat = (path, expectedFragment) => {
  if (!existsSync(path)) {
    fail(`nested seat missing: ${path}`);
    return;
  }
  const target = readlinkSync(path);
  if (expectedFragment && !target.includes(expectedFragment)) {
    fail(`nested seat ${path} links to ${target} — expected *${expectedFragment}*`);
    return;
  }
  seatsVerified += 1;
};

// ---- the rows: the specifiers #328 named, from their real importer sites --

// js-yaml ×63 — the issue's concrete instance: this vendored lib imports it
// bare, and node walks THIS ancestor chain.
resolveLoose('js-yaml', requireDir('cordis-plugin-include lib', INCLUDE_LIB));
// tsx ×34 — the specs/transform workers import it; the dsh-tests source
// packages share one ancestor chain into vendor/node_modules.
resolveLoose('tsx', requireDir('dsh-tests webworker-runtime src',
  join(TESTS, 'packages/experimental/webworker-runtime/src')));
// @agentclientprotocol/sdk ×10 — an npm test face resolved from the tests
// tree.
resolveLoose('@agentclientprotocol/sdk', requireDir('dsh-tests packages', join(TESTS, 'packages')));
// flock ×24 — the lazy face node-addon-system resolves at call time; the
// SUBPATH still resolves through the package's exports/ancestor chain.
resolveLoose('@deepseek-ai/node-addon-system/flock', requireDir('dsh-tests packages', join(TESTS, 'packages')));

// chokidar ×16 — deliberately NOT top-linked: per-consumer majors. Both
// source seats plus the per-major readdirp nesting, and the closure seats
// when ensure-dsh.sh materialized their consumers. A seat is verified
// including its LINKED MAJOR — a seat pointing at the wrong chokidar is
// exactly the silent-wrong-resolution class rule 5 refuses.
seat(join(VENDOR, 'npm/chokidar@4.0.3/node_modules/readdirp'), 'readdirp@4');
seat(join(VENDOR, 'npm/chokidar@5.0.0/node_modules/readdirp'), 'readdirp@5');
seat(join(TESTS, 'packages/settings/settings-file/node_modules/chokidar'), 'chokidar@4');
seat(join(TESTS, 'packages/skill/skill-filesystem/node_modules/chokidar'), 'chokidar@5');
const closureSeat = (consumer, expected) => {
  if (existsSync(consumer)) seat(join(consumer, 'node_modules/chokidar'), expected);
};
closureSeat(join(VENDOR, 'dsh/dsh-settings-file@0.1.6-alpha.2'), 'chokidar@4');
closureSeat(join(VENDOR, 'dsh/dsh-credentials-local@0.1.6-alpha.2'), 'chokidar@4');
closureSeat(join(VENDOR, 'dsh/skill-filesystem@0.1.6-alpha.2'), 'chokidar@5');

if (failures.length > 0) {
  console.error('parity-resolution: FAIL — the materialized layout does not resolve the #328 named faces:');
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(`parity-resolution: PASS — 4 named specifiers resolved (${requireResolved} require, ${walkResolved} structural walk), ${seatsVerified} nested seats verified`);
