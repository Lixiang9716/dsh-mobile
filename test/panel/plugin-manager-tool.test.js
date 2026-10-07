import { describe, it, expect, beforeEach } from 'vitest';
import { apply, manifest } from 'system-plugins/dsh-plugin-manager-tools/index.js';
import { workspace, __dump } from 'gateway.js';
import { workspaceRegistryPath, workspacePrefix } from 'workspace-registry.js';

// The plugin_manager TOOL (#346 item 3): the session toolset's plugin
// pipeline. The Creator composition's `tool-plugin-manager` row has been
// Enabled since #334, but no `plugin_manager` tool existed on the mobile
// seat — the composition chain never composes (the boot agent joins no
// preset) and the vendored row module needs the desktop pluginManager/
// sandboxPolicy services + dsh-sandbox (unstaged). The fix mounts this
// outboard implementation package on the spine, so the assertion that
// matters is the model-facing one: after the spine's tool mounts, the
// tool table carries `plugin_manager` — here, apply() against a
// ToolRuntime-shaped ctx (the same register/view surface boot.js's
// spineInventory row reads), then the legs driven against the gateway
// shim with the device seat's workspace geometry (workspace `spike/`
// inside the app scope root).

const REGISTRY_DOC = {
  version: 1,
  plugins: [
    { id: 'countdown10', name: '10s Countdown', version: '1.0.0',
      path: 'plugins/countdown10', enabled: true },
    { id: 'silent', enabled: false },
  ],
};

/** The device seat's geometry: workspace = <scopeRoot>/spike. */
const SEAT = { containerRoot: '/data/user/0/com.dshmobile.spike/files/profiles/default/dsh',
  scopeRoot: '/data/user/0/com.dshmobile.spike/files/profiles/default' };
const SEAT_REGISTRY = 'dsh/plugins/registry.json';

const encode = (text) => new TextEncoder().encode(text);
const seedRegistry = (doc, path = SEAT_REGISTRY) => {
  workspace.set(`app/${path}`, encode(`${JSON.stringify(doc, null, 2)}\n`));
};

let registered;
const ctx = { tools: { register: (tool) => registered.set(tool.name, tool) } };

const drive = async (args) => JSON.parse(await registered.get('plugin_manager').execute(args));

beforeEach(() => {
  registered = new Map();
  workspace.clear();
  globalThis.__dshProfileCwd = SEAT.containerRoot;
  globalThis.__dshProfileScopeRoot = SEAT.scopeRoot;
  apply(ctx);
  expect(registered.size).toBe(1);
});

describe('the plugin_manager tool registers into the session toolset', () => {
  it('registers exactly one tool named plugin_manager (the composition row\'s name)', () => {
    expect(registered.get('plugin_manager')?.name).toBe('plugin_manager');
  });

  it('the spine mount shape is the tool-row contract (inject tools, manifest present)', () => {
    expect(manifest.id).toBe('dsh-plugin-manager-tools');
    expect(manifest.capabilities.required).toContain('fsRead');
  });
});

describe('plugin_manager list legs over the workspace registry', () => {
  it('list_plugins answers the workspace roster paged (the device seat path)', async () => {
    seedRegistry(REGISTRY_DOC);
    const res = await drive({ action: 'list_plugins' });
    expect(res.ok).toBe(true);
    expect(res.total).toBe(2);
    expect(res.entries[0]).toMatchObject({ entryId: 'countdown10', moduleName: '10s Countdown', enabled: true });
  });

  it('an absent registry answers the honest empty roster (the pre-creation state)', async () => {
    const res = await drive({ action: 'list_plugins' });
    expect(res.ok).toBe(true);
    expect(res.total).toBe(0);
    expect(res.entries).toEqual([]);
  });

  it('list_bundles answers one manageable workspace-registry bundle', async () => {
    seedRegistry(REGISTRY_DOC);
    const res = await drive({ action: 'list_bundles' });
    expect(res.total).toBe(1);
    expect(res.bundles[0]).toMatchObject({ name: 'workspace-registry', installed: true, removable: true });
    expect(res.bundles[0].rows.map((r) => r.rowId)).toEqual(['countdown10', 'silent']);
  });

  it('a malformed registry refuses in-band (never a throw, never a fake empty)', async () => {
    workspace.set(`app/${SEAT_REGISTRY}`, encode('not json'));
    const res = await drive({ action: 'list_plugins' });
    expect(res.ok).toBe(true); // the envelope is the tool's ok face...
    expect(res.application).toBe('failed');
    expect(res.error.code).toBe('operation-error');
  });
});

describe('plugin_manager enable + remove legs', () => {
  it('set_plugin flips the roster row and persists it to the workspace file', async () => {
    seedRegistry(REGISTRY_DOC);
    const res = await drive({ action: 'set_plugin', target: 'silent', enabled: true });
    expect(res).toMatchObject({ ok: true, changed: true, application: 'applied', enabled: true });
    const doc = JSON.parse(new TextDecoder().decode(__dump(`app/${SEAT_REGISTRY}`)));
    expect(doc.plugins.find((row) => row.id === 'silent').enabled).toBe(true);
  });

  it('set_bundle on an unknown name refuses in-band with the vendor vocabulary', async () => {
    seedRegistry(REGISTRY_DOC);
    const res = await drive({ action: 'set_bundle', target: 'nope', enabled: false });
    expect(res.application).toBe('failed');
    expect(res.error.code).toBe('unknown-plugin');
  });

  it('remove_bundle drops only the roster row (workspace files untouched)', async () => {
    seedRegistry(REGISTRY_DOC);
    workspace.set('app/spike/plugins/quotes/manifest.json', encode('{}'));
    const res = await drive({ action: 'remove_bundle', target: 'countdown10' });
    expect(res).toMatchObject({ ok: true, changed: true, application: 'applied' });
    expect(JSON.parse(new TextDecoder().decode(__dump(`app/${SEAT_REGISTRY}`))).plugins)
      .toHaveLength(1);
    expect(__dump('app/spike/plugins/quotes/manifest.json')).toBeDefined();
  });
});

describe('plugin_manager install leg (the workspace-tree adoption)', () => {
  const MANIFEST = { id: 'quotes', name: 'Famous Quotes Carousel', version: '1.0.0',
    entry: 'module.js', capabilities: ['card'] };

  it('installs the authored tree: manifest validated, roster row upserted', async () => {
    seedRegistry(REGISTRY_DOC);
    workspace.set('app/spike/plugins/quotes/manifest.json', encode(JSON.stringify(MANIFEST)));
    const res = await drive({ action: 'install_bundle', target: 'quotes' });
    expect(res).toMatchObject({ ok: true, application: 'applied', stage: 'install', bundle: 'quotes', enabled: true });
    const doc = JSON.parse(new TextDecoder().decode(__dump(`app/${SEAT_REGISTRY}`)));
    expect(doc.plugins.find((row) => row.id === 'quotes')).toMatchObject(
      { id: 'quotes', version: '1.0.0', path: 'plugins/quotes', source: 'workspace' });
  });

  it('a spec with no workspace tree refuses in-band naming the search', async () => {
    const res = await drive({ action: 'install_bundle', target: 'absent' });
    expect(res.application).toBe('failed');
    expect(res.error.code).toBe('not-found');
    expect(res.error.diagnostic).toContain('plugins/absent/manifest.json');
  });

  it('a manifest whose id disagrees with the spec refuses (rule 5, in-band)', async () => {
    workspace.set('app/spike/plugins/wrong/manifest.json',
      encode(JSON.stringify({ ...MANIFEST, id: 'other' })));
    const res = await drive({ action: 'install_bundle', target: 'wrong' });
    expect(res.application).toBe('failed');
    expect(res.error.code).toBe('invalid-spec');
  });

  it('an unknown action answers the refusal text (never a throw)', async () => {
    const res = JSON.parse(await registered.get('plugin_manager').execute({ action: 'explode' }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain('unknown action');
  });
});

describe('the workspace geometry the tool and the LIST tier share', () => {
  it('derives the device seat prefix (containerRoot below the scope root)', () => {
    expect(workspacePrefix(SEAT)).toBe('dsh');
    expect(workspaceRegistryPath(SEAT)).toBe('dsh/plugins/registry.json');
  });

  it('derives the bare spelling when the workspace IS the scope root (CLI seats)', () => {
    const parts = { containerRoot: '/profiles/default', scopeRoot: '/profiles/default' };
    expect(workspacePrefix(parts)).toBe('');
    expect(workspaceRegistryPath(parts)).toBe('plugins/registry.json');
  });

  it('derives the bare spelling when no scope root is pinned (never throws)', () => {
    expect(workspacePrefix({ containerRoot: '/x' })).toBe('');
    expect(workspacePrefix(undefined)).toBe('');
    expect(workspacePrefix({ containerRoot: '/x/y', scopeRoot: '/z' })).toBe('');
  });
});
