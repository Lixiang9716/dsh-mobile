// dsh:logging-exempt satellite of the shim exposure survey (dev script: console
// IS the product, like check-staging-graph.mjs).
/**
 * shim-exposure.mjs — aggregate DSH_MODULE_MANIFEST loader manifests into the
 * per-shim exposure table: which of the self-owned shims
 * (runtime/dsh/upstream/shims/*.js) the upstream suite runs actually load,
 * and which never do.
 *
 * The raw evidence is produced by the dsh host's default-off diagnostic:
 * with DSH_MODULE_MANIFEST=<path> in the process env, every resolved load
 * under upstream/shims/ appends one path line — ESM loads through
 * dsh_module_loader AND CJS reads through js_bundle_require (the
 * shims/sharp package internals). One manifest per spec run; this tool reads
 * the whole directory.
 *
 * usage: node tools/shim-exposure.mjs <manifest-dir>
 *          [--baseline <manifest>]     a harness-only run's manifest (the
 *                                      fixed cost every spec leg pays — its
 *                                      shims are exposure by infrastructure,
 *                                      not by any spec body)
 *          [--shims-dir <dir>]         default runtime/dsh/upstream/shims
 *          [--json]                    machine-readable output instead of
 *                                      the markdown table
 *
 * Exit 0 always — a diagnostic, not a gate.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.length === 0 || args[0].startsWith('-')) {
  console.error('usage: node tools/shim-exposure.mjs <manifest-dir> [--baseline <manifest>] [--shims-dir <dir>] [--json]');
  process.exit(2);
}
const manifestDir = args[0];
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const baselineFile = flag('--baseline');
const shimsDir = flag('--shims-dir') ?? 'runtime/dsh/upstream/shims';
const asJson = args.includes('--json');

/** The 86 self-owned shim modules: the top-level .js files of the shims dir
 * (the sharp/ subdirectory is a PACKAGE, not one shim — its files are
 * counted separately below). */
const shims = readdirSync(shimsDir)
  .filter((f) => f.endsWith('.js'))
  .sort();

/** manifest file → Set of shim names (top-level `x.js`) plus a Set of
 * sharp-package paths (`sharp/...`). */
const parseManifest = (file) => {
  const top = new Set();
  const sharp = new Set();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.startsWith('upstream/shims/')) continue;
    const rest = line.slice('upstream/shims/'.length);
    if (rest.startsWith('sharp/')) sharp.add(rest);
    else top.add(rest);
  }
  return { top, sharp };
};

const specFiles = readdirSync(manifestDir)
  // `__*` names are reserved for baseline/auxiliary runs — never spec rows.
  .filter((f) => (f.endsWith('.txt') || f.endsWith('.manifest')) && !f.startsWith('__'))
  .sort();
const baseline = baselineFile ? parseManifest(baselineFile) : { top: new Set(), sharp: new Set() };

/** spec manifest name → parsed */
const specRuns = new Map();
for (const f of specFiles) specRuns.set(f, parseManifest(join(manifestDir, f)));

const exposure = new Map(shims.map((s) => [s, { count: 0, runs: [] }]));
for (const [name, { top }] of specRuns) {
  for (const shim of top) {
    const row = exposure.get(shim);
    if (row) { row.count += 1; row.runs.push(name); }
  }
}
const exposed = shims.filter((s) => exposure.get(s).count > 0);
const zero = shims.filter((s) => exposure.get(s).count === 0);
const zeroEvenInBaseline = zero.filter((s) => !baseline.top.has(s));
const harnessOnly = shims.filter((s) => exposure.get(s).count === 0 && baseline.top.has(s));

const sharpPaths = new Set(baseline.sharp);
for (const { sharp } of specRuns.values()) for (const p of sharp) sharpPaths.add(p);

if (asJson) {
  console.log(JSON.stringify({
    shimsTotal: shims.length,
    specRuns: specRuns.size,
    baseline: baselineFile ? [...baseline.top].sort() : [],
    exposure: Object.fromEntries([...exposure].map(([s, r]) => [s, r.count])),
    zeroExposure: zero,
    zeroExposureIncludingBaseline: zeroEvenInBaseline,
    harnessFixedOnly: harnessOnly,
    sharpPackagePaths: [...sharpPaths].sort(),
  }, null, 2));
  process.exit(0);
}

const lines = [];
lines.push('# Shim exposure map (upstream suite → runtime/dsh/upstream/shims)');
lines.push('');
lines.push(`- spec manifests: ${specRuns.size} (dir ${manifestDir})`);
lines.push(`- shims total: ${shims.length} — exposed: ${exposed.length}, zero-exposure: ${zero.length}`);
if (baselineFile) {
  lines.push(`- baseline (harness-fixed): ${baselineFile} — ${baseline.top.size} shims load before any spec body`);
  lines.push(`- zero-exposure NOT even harness-fixed (真零曝光): ${zeroEvenInBaseline.length}`);
  lines.push(`- harness-fixed only (从未被 spec 触达): ${harnessOnly.length}`);
}
lines.push(`- sharp/ package files seen on any channel: ${sharpPaths.size}`);
lines.push('');
lines.push('| shim | spec runs loading it | harness-fixed |');
lines.push('|---|---|---|');
for (const s of shims) {
  const row = exposure.get(s);
  const fixed = baseline.top.has(s) ? 'yes' : '';
  lines.push(`| ${s} | ${row.count} | ${fixed} |`);
}
lines.push('');
lines.push('## Zero-exposure shims (loaded by NO spec run)');
lines.push('');
for (const s of zero) lines.push(`- ${s}${baseline.top.has(s) ? ' (harness-fixed only)' : ''}`);
lines.push('');
lines.push('## sharp/ package files (CJS channel, not part of the 86)');
lines.push('');
for (const p of [...sharpPaths].sort()) lines.push(`- ${p}`);
console.log(lines.join('\n'));
