// dsh:logging-exempt (test: assertion failures ARE the diagnostic)
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import yaml from '../../hosts/android/app/src/main/assets/spike/vendor/npm/js-yaml@4.1.0/dist/js-yaml.mjs';

// The BUILT-IN Agent 预设 cards' health verdict, mirrored against the REAL
// seed data: the preset documents the `agentPresets.seed` delivery carries
// (the staged android assets copy, byte-identity-gated by the closures
// gate) and the node_modules marker set the seeders write (one per staged
// vendor/dsh package, name+version from its own package.json —
// AgentPresetsSeed.kt / the iOS drive / harmony's OfficialServe /
// gen-presets-seed.py are the same rule four times).
//
// The verdict rule is the vendored AgentPresets discovery's
// (runtime/spike/vendor/dsh/agent-presets@0.1.6-alpha.2/lib/index.js):
//   - a row with a truthy `disabled` is not part of the composition — a
//     `!!js` expression arrives as an OBJECT there, so it is always truthy
//     and skips the row; these docs are pre-mapped `!!js` → `!!str` so every
//     such value becomes a non-empty string, preserving that truthiness
//     (the loader never evaluates the expression during health);
//   - a `cordis:` builtin always resolves; a relative/file row resolves
//     against the preset's own directory; a package row resolves through
//     packageInstalled's specifier→package split against the markers;
//   - a group row (`group: true`) recurses into its `config` list.
// This is the check that decides the 设置 → Agent presets cards:
// Standard/PTC/Creator all shipped 加载失败 on #324 because their shared
// `present` row named @deepseek-ai/dsh-tool-present — pinned on the npm
// face only, so no vendor/dsh marker existed for it. The panel asserts the
// roster the seed produces is healthy WHOLE, so the next face that drifts
// from its embed fails here first, naming the row and the package.

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAGED_DSH = join(REPO, 'hosts/android/app/src/main/assets/spike/vendor/dsh');
const PRESETS_ROOT = join(STAGED_DSH, 'agent-presets@0.1.6-alpha.2', 'presets');

/** The staged marker set: every staged vendor/dsh package's own name. */
const markerNames = () => {
  const names = new Set();
  for (const dir of readdirSync(STAGED_DSH)) {
    try {
      const manifest = JSON.parse(readFileSync(join(STAGED_DSH, dir, 'package.json'), 'utf8'));
      if (manifest.name && manifest.version) names.add(manifest.name);
    } catch { /* a dir without a package.json carries no marker — the seed rule */ }
  }
  return names;
};

/** The mobile-absent row ids, read from the adaptation module's own
 * declaration (the module itself imports the runtime's node:buffer shim
 * face and cannot load under node). */
const mobileAbsentRowIds = () => {
  const src = readFileSync(join(REPO, 'runtime/spike/upstream/preset-mobile-rows.js'), 'utf8');
  const block = src.match(/MOBILE_ABSENT_ROW_IDS = new Set\(\[([\s\S]*?)\]\)/);
  expect(block, 'preset-mobile-rows.js no longer declares MOBILE_ABSENT_ROW_IDS').toBeTruthy();
  return new Set([...block[1].matchAll(/'([A-Za-z0-9_-]+)'/g)].map((m) => m[1]));
};

/** One row's own truthy-disabled verdict (the `!!js` → truthy-object rule). */
const rowDisabled = (row) => Boolean(row.disabled);

/** The composition's rows, flattened the way the health check walks them:
 * group rows recurse, truthy-disabled rows are skipped, and every remaining
 * row must resolve (the return value names the ones that do not). */
const unresolvableRows = (rows, presetDir, markers, at = '') => {
  const found = [];
  rows.forEach((row, index) => {
    if (rowDisabled(row)) return;
    const label = typeof row.id === 'string' && row.id !== '' ? `row "${row.id}"` : `${at}row ${index + 1}`;
    if (row.group === true) {
      found.push(...unresolvableRows(row.config, presetDir, markers, `${label} `));
      return;
    }
    const name = row.name;
    if (name.startsWith('cordis:')) return; // builtin
    if (name.startsWith('.')) {
      // preset-relative: a real file beside the composition
      try { statSync(join(presetDir, name)); return; } catch { /* fall through */ }
    } else if (!name.startsWith('file:') && !name.startsWith('/')) {
      // package row: packageInstalled's scope-aware split against the markers
      const pkg = name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/');
      if (markers.has(pkg)) return;
    } else {
      // file URL / absolute path: a real file on the staged tree
      const spec = name.startsWith('file:') ? fileURLToPath(name) : name;
      try { statSync(spec.startsWith('/') ? join(REPO, 'hosts/android/app/src/main/assets/spike', `.${spec}`) : spec); return; } catch { /* fall through */ }
    }
    found.push({ label, name });
  });
  return found;
};

/** Parse one composition the health check reads it: the `!!js` family is
 * mapped to plain strings BEFORE load (see the header — truthiness only). */
const loadComposition = (presetDir) =>
  yaml.load(readFileSync(join(presetDir, 'agent.cordis.yml'), 'utf8').replaceAll('!!js ', '!!str '));

/** The device verdict for one preset: the seed disables the mobile-absent
 * rows first (preset-mobile-rows.js), then the vendored health check walks
 * every row that survives. Each row that still fails to resolve is a
 * Failed-to-load card (the #324 class). */
const seedVerdictFailures = (presetId, presetDir, markers, absentIds) => {
  const skipRow = (row) => rowDisabled(row)
    || (typeof row.id === 'string' && absentIds.has(row.id));
  const failures = [];
  const walk = (rows, at) => rows.forEach((row, index) => {
    if (skipRow(row)) return;
    if (row.group === true) return walk(row.config, `${at}row ${index + 1} `);
    const label = typeof row.id === 'string' && row.id !== '' ? `row "${row.id}"` : `${at}row ${index + 1}`;
    const pkg = row.name.split('/').slice(0, row.name.startsWith('@') ? 2 : 1).join('/');
    if (!markers.has(pkg)) failures.push(`${presetId}: ${label} → ${row.name}`);
  });
  walk(loadComposition(presetDir), '');
  return failures;
};

describe('built-in agent preset health under the mobile seed (issue #324)', () => {
  const markers = markerNames();
  const absentIds = mobileAbsentRowIds();
  const presetIds = readdirSync(PRESETS_ROOT).filter((d) =>
    statSync(join(PRESETS_ROOT, d)).isDirectory()).sort();

  it('stages all four built-in preset documents', () => {
    expect(presetIds).toEqual(['cordis', 'minimal', 'ptc', 'standard']);
  });

  it('carries a resolution marker for every package the mobile-absent patch leaves enabled', () => {
    const failures = presetIds.flatMap((id) =>
      seedVerdictFailures(id, join(PRESETS_ROOT, id), markers, absentIds));
    expect(failures, 'unresolvable enabled rows (each is a Failed-to-load card)').toEqual([]);
  });

  it('the mobile-absent patch list exactly covers the closure gap — nothing else is unresolved', () => {
    // The forward direction of the seed contract: in the RAW documents,
    // every unresolvable row is one the patch disables. A row outside the
    // patch list failing here means the marker set is missing a package the
    // patch does not know about — the #324 class (it was row "present").
    const unexpected = [];
    for (const id of presetIds) {
      const presetDir = join(PRESETS_ROOT, id);
      const doc = loadComposition(presetDir);
      for (const row of unresolvableRows(doc, presetDir, markers)) {
        if (!absentIds.has(String(row.label?.match(/"([^"]+)"/)?.[1]))) {
          unexpected.push(`${id}: ${row.label} → ${row.name}`);
        }
      }
    }
    expect(unexpected, 'rows neither patch-disabled nor resolvable').toEqual([]);
  });

  it('stages the npm-face shell surface at the dsh rel paths the marker seeders walk', () => {
    // The #324 fix itself: these four preset-row packages pin on the npm
    // face only; the staged tree must carry them at vendor/dsh/<pkg>@<ver>
    // (the dirs every seeder reads) with the npm pin's own package.json.
    for (const pkg of ['tool-present', 'tool-ralph', 'tool-bash', 'tool-pwsh']) {
      const manifest = JSON.parse(readFileSync(
        join(STAGED_DSH, `${pkg}@0.1.6-alpha.2`, 'package.json'), 'utf8'));
      expect(manifest.name).toBe(`@deepseek-ai/dsh-${pkg}`);
      expect(markers.has(manifest.name), `no marker resolves ${manifest.name}`).toBe(true);
    }
  });
});
