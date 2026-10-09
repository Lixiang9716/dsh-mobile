// dsh:logging-exempt (test: assertion failures ARE the diagnostic)
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import seedFiles from '../../runtime/dsh/scenario/agent-presets-probe-seed.js';

// The REAL patch module loads under this shim face (it imports only the
// runtime's node:buffer codec pair; the seed module itself never touches
// node:buffer) — the byte-equality test below makes replica drift against
// it impossible, the exact blind spot that shipped the 252:3 blocker.
vi.mock('node:buffer', async (importOriginal) => ({
  ...await importOriginal(),
  encodeUtf8: (text) => new TextEncoder().encode(String(text ?? '')),
  decodeUtf8: (bytes) => new TextDecoder().decode(bytes),
}));

// The settings-surfaces CLI leg's DEFAULT_PRESET demand, replicated as pure
// functions over the GENERATED seed artifact
// (runtime/dsh/scenario/agent-presets-probe-seed.js — gen-presets-seed.py's
// output, the same bytes the scenario posts as its `agentPresets.seed`
// delivery). The leg itself is macOS/Linux-only (the dsh-cli host does not
// build on Windows) and NO CI job runs it (build/build.sh test core is a
// local surface), so this panel test is the only gate that exercises the
// demand on every PR: the scenario demands the roster's default row carry
// `AGENT_PRESETS_DEFAULT` (settings-surfaces.js `DEFAULT_PRESET`), which went
// red-by-construction the moment boot.js named `mobile` while the seed
// carried only the four upstream-shipped presets.
//
// The verdict rules are the vendored AgentPresets discovery's
// (runtime/dsh/vendor/dsh/agent-presets@0.1.6-alpha.2/lib/index.js):
//   - scanRoot: a preset dir under the seeded presets/ root holding
//     `agent.cordis.yml` (COMPOSITION_FILE), metadata from `preset.yml`,
//     sorted by `order` ascending then id;
//   - health: every enabled row must resolve — `cordis:`/`node:` builtins
//     always; preset-relative rows against the seed; package rows through the
//     seed's node_modules markers (one per vendored dsh package);
//   - the seed patch (upstream/preset-mobile-rows.js, applied by web-boot.js
//     to every agentPresets.seed delivery on EVERY host): rows whose id is in
//     MOBILE_ABSENT_ROW_IDS arrive `disabled: true` in the delivered docs.
// The patch module itself imports the runtime's node:buffer shim face and
// cannot load under node, so its row ids are read from the source text — the
// same rule preset-health.test.js uses.

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEED_PREFIX = '/vendor/dsh/agent-presets@0.1.6-alpha.2/';
const COMPOSITION_FILE = 'agent.cordis.yml';
const METADATA_FILE = 'preset.yml';
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/;

/** The generated seed as the {vfsPath: Uint8Array} map the runner posts. */
const seedMap = () => {
  const files = new Map();
  for (const [path, file] of Object.entries(seedFiles)) files.set(path, file.bytes);
  return files;
};

/** The deployment default, parsed from upstream/boot.js (the module imports
 * the whole spine and cannot load under node). */
const agentPresetsDefault = () => {
  const src = readFileSync(join(REPO, 'runtime/dsh/upstream/boot.js'), 'utf8');
  const hit = src.match(/export const AGENT_PRESETS_DEFAULT = '([A-Za-z0-9_-]+)'/);
  expect(hit, 'boot.js no longer declares AGENT_PRESETS_DEFAULT').toBeTruthy();
  return hit[1];
};

/** The mobile-absent row ids, read from the adaptation module's source (see
 * the header — the module cannot load under node). */
const mobileAbsentRowIds = () => {
  const src = readFileSync(join(REPO, 'runtime/dsh/upstream/preset-mobile-rows.js'), 'utf8');
  const block = src.match(/MOBILE_ABSENT_ROW_IDS = new Set\(\[([\s\S]*?)\]\)/);
  expect(block, 'preset-mobile-rows.js no longer declares MOBILE_ABSENT_ROW_IDS').toBeTruthy();
  return new Set([...block[1].matchAll(/'([A-Za-z0-9_-]+)'/g)].map((m) => m[1]));
};

/** The seed's marker set: every node_modules/<pkg>/package.json key, scope-
 * aware split — the same walk the vendored packageInstalled does over the
 * seeded VFS. */
const markerSet = (files) => {
  const names = new Set();
  for (const path of files.keys()) {
    const at = path.indexOf('/node_modules/');
    if (at < 0) continue;
    const rest = path.slice(at + '/node_modules/'.length);
    names.add(rest.split('/').slice(0, rest.startsWith('@') ? 2 : 1).join('/'));
  }
  return names;
};

/** One parsed row's patch-and-disabled verdict: the delivered docs carry the
 * patch already, so an absent-id row is a disabled row. */
const rowEnabled = (row) => !Boolean(row.disabled);

/** The seed patch, replicated line-for-line from
 * upstream/preset-mobile-rows.js (findRowBlock / rowHasDisabled /
 * disableMobileAbsentRows + spliceCreateRow): every absent-id row gains
 * `disabled: true` right after its `- id:` line, same indent; already-disabled
 * rows pass; a drifted row shape (no name line) throws — rule 5. THEN the
 * composition gains the `tool-plugin-create` row at the tool-plugin-manager
 * row block's END (next same-indent row / dedent / EOF). web-boot.js applies
 * this to every presets/**.yml row of every agentPresets.seed delivery on
 * every host BEFORE the VFS merge, so the delivered docs — and every
 * length/health verdict below — are the PATCHED text. The splicer used to be
 * missing from this replica: the id-adjacent insertion it really did severs
 * the manager row's own keys onto the new row ("duplicated mapping key
 * (252:3)", session/create dead on every preset with a plugin plane,
 * measured 2026-10-10) and the blind spot let it ship — the mirror is the
 * net, it must cover BOTH transforms. */
const applySeedPatch = (text, absentIds, docName) => {
  const findRowBlock = (lines, rowId) => {
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^(\s*)-\s+id:\s*['"]?([A-Za-z0-9_-]+)['"]?\s*$/);
      if (match && match[2] === rowId) return { start: i, indent: match[1] };
    }
    return null;
  };
  const rowHasDisabled = (lines, start, dashIndent) => {
    const keyIndent = `${dashIndent}  `;
    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
      if (!line.startsWith(keyIndent)) return false;
      if (line.startsWith(`${keyIndent}disabled:`)) return true;
    }
    return false;
  };
  const lines = text.split('\n');
  for (const rowId of absentIds) {
    const block = findRowBlock(lines, rowId);
    if (block === null) continue;
    if (rowHasDisabled(lines, block.start, block.indent)) continue;
    const nameAt = lines.findIndex((line, i) => i > block.start
      && line.startsWith(`${block.indent}  name:`));
    if (nameAt < 0) throw new Error(`preset-mobile-rows: ${docName} row "${rowId}" has no name line`);
    lines.splice(block.start + 1, 0, `${block.indent}  disabled: true`);
  }
  if (!text.includes('id: tool-plugin-create')) {
    const at = lines.findIndex((line) => line.includes('- id: tool-plugin-manager'));
    if (at >= 0) {
      const indent = lines[at].slice(0, lines[at].indexOf('-'));
      let end = lines.length;
      for (let i = at + 1; i < lines.length; i += 1) {
        const line = lines[i];
        if (line.startsWith(`${indent}-`)) { end = i; break; } // the next row
        if (line.trim() === '') continue; // blank: still inside the block
        if (!line.startsWith(`${indent} `)) { end = i; break; } // dedent: list ended
      }
      lines.splice(end, 0,
        `${indent}- id: tool-plugin-create`,
        `${indent}  name: 'system-plugins/dsh-create/index.js'`);
    }
  }
  return lines.join('\n');
};

/** The composition's rows, flattened the way the health check walks them
 * (groups recurse; everything else is a row). */
const compositionRows = (doc) => {
  const rows = [];
  const walk = (list) => {
    for (const row of list ?? []) {
      if (row.group === true) { walk(row.config); continue; }
      rows.push(row);
    }
  };
  walk(doc);
  return rows;
};

/** The vendored unresolvableRows verdict over one enabled row: cordis:/node:
 * builtins resolve; preset-relative rows must exist in the seed; package rows
 * need a marker; file:/absolute rows cannot resolve on the staged VFS (none
 * of the pinned docs name one). */
const rowResolves = (row, presetId, files, markers) => {
  const name = row.name;
  if (name.startsWith('cordis:') || name.startsWith('node:')) return true;
  if (name.startsWith('.')) {
    const base = `${SEED_PREFIX}presets/${presetId}/`;
    return files.has(new URL(name, `file://${base}`).href.replace('file://', ''));
  }
  if (name.startsWith('file:') || name.startsWith('/')) return false;
  const pkg = name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/');
  return markers.has(pkg);
};

/** The roster as the vendored scanRoot + remoteExportList compute it over the
 * seeded tree AFTER the seed patch (web-boot.js patches every presets/**.yml
 * row before the VFS merge): id/order/name from discovery, `broken` from the
 * health walk over the PATCHED docs, the deployment default marked. */
const roster = (files, absentIds) => {
  const markers = markerSet(files);
  const ids = new Set();
  for (const path of files.keys()) {
    const hit = path.match(new RegExp(`^${SEED_PREFIX.replace(/[@.]/g, '\\$&')}presets/([^/]+)/`));
    if (hit) ids.add(hit[1]);
  }
  const presets = [];
  for (const id of [...ids].sort()) {
    if (!PRESET_ID.test(id)) continue;
    const compositionPath = `${SEED_PREFIX}presets/${id}/${COMPOSITION_FILE}`;
    if (!files.has(compositionPath)) {
      // scanRoot keeps the directory with a missing-composition broken
      // verdict ("the directory still occupies the id").
      presets.push({ id, order: undefined, broken: ['missing composition'] });
      continue;
    }
    const composition = applySeedPatch(
      new TextDecoder().decode(files.get(compositionPath)), absentIds, `${id}/${COMPOSITION_FILE}`);
    const doc = yaml.load(composition.replaceAll('!!js ', '!!str '));
    const metadataPath = `${SEED_PREFIX}presets/${id}/${METADATA_FILE}`;
    const metadata = files.has(metadataPath)
      ? yaml.load(new TextDecoder().decode(files.get(metadataPath)))
      : {};
    const unresolvable = compositionRows(doc)
      .filter(rowEnabled)
      .filter((row) => !rowResolves(row, id, files, markers));
    presets.push({
      id,
      order: typeof metadata.order === 'number' ? metadata.order : undefined,
      broken: unresolvable.length > 0 ? unresolvable : undefined,
    });
  }
  presets.sort((left, right) => {
    const byOrder = (left.order ?? Number.POSITIVE_INFINITY) - (right.order ?? Number.POSITIVE_INFINITY);
    return byOrder === 0 ? left.id.localeCompare(right.id) : byOrder;
  });
  return presets;
};

/** The PATCHED composition text of one seeded preset — what readDocument
 * serves (the seed patch runs at delivery, before the VFS merge). */
const patchedComposition = (files, absentIds, id) => applySeedPatch(
  new TextDecoder().decode(files.get(`${SEED_PREFIX}presets/${id}/${COMPOSITION_FILE}`)),
  absentIds, `${id}/${COMPOSITION_FILE}`);

/** The expected manifest, keyed by event. */
const expectedManifest = () => {
  const manifest = JSON.parse(readFileSync(
    join(REPO, 'test/e2e/scenarios/settings-surfaces.json'), 'utf8'));
  return new Map(manifest.expect.map((e) => [e.event, e.match]));
};

describe('the CLI presets seed satisfies the settings-surfaces default demand', () => {
  const files = seedMap();
  const absentIds = mobileAbsentRowIds();
  const rows = roster(files, absentIds);
  const defaultId = agentPresetsDefault();

  it('the generated seed carries the mobile preset at the device stagers rel', () => {
    for (const name of ['preset.yml', 'agent.cordis.yml']) {
      const key = `${SEED_PREFIX}presets/mobile/${name}`;
      expect(files.has(key), `the seed is missing ${key}`).toBe(true);
      const source = readFileSync(join(REPO, 'runtime/dsh/presets-mobile/mobile', name));
      expect(Buffer.from(files.get(key)).equals(source),
        `the seeded ${name} drifted from the presets-mobile source (the device stagers stage these bytes verbatim)`).toBe(true);
    }
  });

  it('the roster answers the deployment default — the demand settings-surfaces.js makes', () => {
    // The exact demand the leg fails without the mobile synthesis:
    // `demand(defaultRow?.id === DEFAULT_PRESET)` over agentPresets/list.
    const defaultRow = rows.find((row) => row.id === defaultId);
    expect(defaultRow, `the roster carries no '${defaultId}' row — the seed is missing the deployment default (the settings-surfaces CLI leg is red-by-construction)`).toBeDefined();
  });

  it('the roster order is the vendored scanRoot rule: order asc, then id', () => {
    expect(rows.map((row) => row.id)).toEqual(['standard', 'mobile', 'ptc', 'minimal', 'cordis']);
  });
});

describe('the settings-surfaces expected manifest agrees with the generated seed', () => {
  const files = seedMap();
  const absentIds = mobileAbsentRowIds();
  const rows = roster(files, absentIds);
  const defaultId = agentPresetsDefault();

  it('the expected manifest roster matches the seed derivation (no silent rot)', () => {
    // The leg's one-to-one checker reads this manifest; nobody runs the leg
    // on Windows and no CI job runs it at all, so THIS is the check that
    // keeps the recorded expectations honest when the seed, the pin, the
    // patch set, or a composition doc moves. healthy = rows without a broken
    // verdict.
    const rosterMatch = expectedManifest().get('settings.preset.roster');
    expect(rosterMatch.presets).toEqual(rows.map((row) => row.id));
    expect(rosterMatch.default).toBe(defaultId);
    expect(rosterMatch.healthy).toBe(rows.filter((row) => row.broken === undefined).length);
  });

  it('the expected manifest read/inventory match the patched-doc derivation', () => {
    // read bytes = the PATCHED mobile doc's length (web-boot.js patches every
    // seed .yml before the VFS merge; readDocument serves the patched text,
    // content.length = UTF-16 units). presetRows = compositionInventory's
    // sum: broken presets answer rows: [], healthy ones their flattened row
    // count.
    const byEvent = expectedManifest();
    const readMatch = byEvent.get('settings.preset.read');
    expect(readMatch.preset).toBe(defaultId);
    expect(readMatch.bytes).toBe(patchedComposition(files, absentIds, 'mobile').length);
    expect(byEvent.get('settings.preset.copyRefused').preset).toBe(defaultId);
    const inventoryMatch = byEvent.get('settings.plugin.inventory');
    expect(inventoryMatch.presets).toBe(rows.length);
    expect(inventoryMatch.presetRows).toBe(rows
      .filter((row) => row.broken === undefined)
      .reduce((sum, row) => sum + compositionRows(yaml.load(
        patchedComposition(files, absentIds, row.id).replaceAll('!!js ', '!!str '))).length, 0));
  });

  it('the ci/ manifest mirror stays identical to the test/e2e manifest', () => {
    const canonical = readFileSync(join(REPO, 'test/e2e/scenarios/settings-surfaces.json'), 'utf8');
    const mirror = readFileSync(join(REPO, 'runtime/dsh/ci/settings-surfaces.manifest.json'), 'utf8');
    expect(mirror.trim()).toBe(canonical.trim());
  });
});

// The 2026-10-10 blocker, pinned by name: the real splicer once inserted
// tool-plugin-create right after the manager row's `- id:` line, severing
// the manager row's own name/disabled keys onto the new row — js-yaml
// answered "duplicated mapping key (252:3)" and session/create died on
// every preset with a plugin plane (the replica then covered only the
// disabler, so this suite stayed green over docs that never got the
// create row). Both transforms now ride the replica; this test makes the
// failure mode explicit: every patched preset doc parses, the create row
// lands WHOLE after the manager block, and the patch is idempotent.
describe('the seed patch delivers parseable documents (the 252:3 regression)', () => {
  const files = seedMap();
  const absentIds = mobileAbsentRowIds();

  it('every patched preset composition parses and keeps both rows whole', () => {
    for (const [path, file] of files) {
      if (!path.includes('/presets/') || !path.endsWith('.yml')) continue;
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (!name.endsWith(COMPOSITION_FILE)) continue;
      const patched = applySeedPatch(
        new TextDecoder().decode(file), absentIds, name);
      const doc = yaml.load(patched.replaceAll('!!js ', '!!str '));
      expect(doc, `${path} must parse`).toBeTruthy();
      if (!patched.includes('id: tool-plugin-manager')) continue;
      const rows = compositionRows(doc);
      const manager = rows.find((row) => row.id === 'tool-plugin-manager');
      const create = rows.find((row) => row.id === 'tool-plugin-create');
      expect(manager, `${path} lost the manager row`).toBeTruthy();
      expect(manager.name, `${path} lost the manager row's name to the splice`)
        .toBe('@deepseek-ai/dsh-plugin-manager/tools');
      expect(create, `${path} lost the create row`).toBeTruthy();
      expect(create.name).toBe('system-plugins/dsh-create/index.js');
    }
  });

  it('the patch is idempotent — a re-seed does not duplicate the create row', () => {
    const path = [...files.keys()].find((p) => p.endsWith('mobile/agent.cordis.yml'));
    expect(path, 'the seed carries the mobile composition').toBeTruthy();
    const once = applySeedPatch(
      new TextDecoder().decode(files.get(path)), absentIds, 'mobile/agent.cordis.yml');
    const twice = applySeedPatch(once, absentIds, 'mobile/agent.cordis.yml');
    expect(twice).toBe(once);
  });
});

describe('the replica is the real transform (byte-equality, the 252:3 blind-spot net)', () => {
  it('applySeedPatch matches patchPresetSeedFiles byte-for-byte on every seed doc', async () => {
    const { patchPresetSeedFiles } = await import(
      '../../runtime/dsh/upstream/preset-mobile-rows.js');
    const files = seedMap();
    const absentIds = mobileAbsentRowIds();
    for (const [path, bytes] of files) {
      if (!path.includes('/presets/') || !path.endsWith('.yml')) continue;
      const text = new TextDecoder().decode(bytes);
      const docName = path.slice(path.lastIndexOf('/') + 1);
      const viaReplica = applySeedPatch(text, absentIds, docName);
      // The delivery map is a PLAIN object (Object.entries walks it); a Map
      // here would silently skip every file (viaReal === raw).
      const viaReal = new TextDecoder().decode(
        patchPresetSeedFiles({ [path]: { bytes: bytes.slice() } })[path].bytes);      expect(viaReplica, `${docName}: the replica drifted from the real transform`)
        .toBe(viaReal);
    }
  });
});
