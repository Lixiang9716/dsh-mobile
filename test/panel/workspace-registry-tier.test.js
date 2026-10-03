import { describe, it, expect } from 'vitest';
import { makePluginManagerHandlers, makePluginInventoryHandler } from 'web-write-inventory.js';

// The workspace registry tier (the one-sentence-creation path, T-0170): the
// agent self-installs plugins into the workspace's dsh.plugins/1 registry,
// and the 插件 manager's LIST legs must say so — a read-only tier beside the
// spine and staged tiers, never a fabricated host install. The provider is
// optional (absent → the historical byte-shape) and a malformed registry
// rejects loud (rule 5) instead of degrading to an empty list.

const SPINE = [{ entryId: 'spine.tool', moduleName: 'spine.tool', enabled: true, fiberPhase: 'active' }];
const STAGED = [{ loaderName: 'staged.app' }];

const handlers = (workspaceRegistry) =>
  makePluginManagerHandlers({}, {
    spine: () => SPINE,
    stagedPlugins: () => STAGED,
    ...(workspaceRegistry === undefined ? {} : { workspaceRegistry }),
  });

const REGISTRY = [
  { id: 'countdown10', name: '10s Countdown', enabled: true, capabilities: ['card'] },
  { id: 'silent', enabled: false },
];

describe('the workspace registry tier in the pluginManager LIST legs', () => {
  it('listPlugins carries the workspace entries as read-only rows', async () => {
    const { listPlugins } = handlers(async () => REGISTRY);
    const rows = await listPlugins();
    const ws = rows.filter((r) => r.entryId === 'countdown10' || r.entryId === 'silent');
    expect(ws).toHaveLength(2);
    expect(ws[0]).toMatchObject({ entryId: 'countdown10', moduleName: '10s Countdown', enabled: true, fiberPhase: null, readOnlyReason: 'management-required' });
    expect(ws[1]).toMatchObject({ entryId: 'silent', enabled: false, moduleName: 'silent' });
    expect(rows.some((r) => r.entryId === 'spine.tool')).toBe(true);
  });

  it('listBundles answers a third workspace-registry bundle', async () => {
    const { listBundles } = handlers(async () => REGISTRY);
    const bundles = await listBundles();
    const ws = bundles.find((bnd) => bnd.name === 'workspace-registry');
    expect(ws.installed).toBe(true);
    expect(ws.readOnlyReason).toBe('management-required');
    expect(ws.rows.map((r) => r.rowId)).toEqual(['countdown10', 'silent']);
  });

  it('an empty registry answers an empty, not-installed tier (the normal pre-creation state)', async () => {
    const { listPlugins, listBundles } = handlers(async () => []);
    expect(await listPlugins()).toHaveLength(2);
    const ws = (await listBundles()).find((bnd) => bnd.name === 'workspace-registry');
    expect(ws.installed).toBe(false);
    expect(ws.rows).toEqual([]);
  });

  it('without a provider the tier answers empty and not-installed (no fabricated rows)', async () => {
    const { listPlugins, listBundles } = handlers(undefined);
    const rows = await listPlugins();
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.entryId === 'countdown10')).toBe(false);
    const ws = (await listBundles()).find((bnd) => bnd.name === 'workspace-registry');
    expect(ws.installed).toBe(false);
    expect(ws.rows).toEqual([]);
  });

  it('a malformed registry rejects loud (rule 5) — never an empty tier', async () => {
    const { listPlugins } = handlers(async () => ({ version: 1 }));
    await expect(listPlugins()).rejects.toThrow(/did not answer an array/);
  });
});

describe('the workspace registry tier in the pluginInventory snapshot', () => {
  // the inventory answers the Agent 预设 plane from the real service; the
  // stub carries an empty roster (this suite judges the workspace tier only)
  const CTX = { get: () => ({ compositionInventory: async () => [] }) };
  const inventory = (workspaceRegistry) =>
    makePluginInventoryHandler(CTX, {
      spine: () => SPINE,
      stagedPlugins: () => STAGED,
      ...(workspaceRegistry === undefined ? {} : { workspaceRegistry }),
    });

  it('the snapshot carries the workspace entries as session-scope rows', async () => {
    const res = await inventory(async () => REGISTRY)();
    const ws = res.entries.filter((r) => r.entryId === 'countdown10' || r.entryId === 'silent');
    expect(ws).toHaveLength(2);
    expect(ws[0]).toMatchObject({ entryId: 'countdown10', moduleName: '10s Countdown', enabled: true, fiberPhase: null });
    expect(res.managementAvailable).toBe(false);
  });

  it('without a provider the snapshot keeps its historical shape', async () => {
    const res = await inventory(undefined)();
    expect(res.entries).toHaveLength(2);
    expect(res.entries.some((r) => r.entryId === 'countdown10')).toBe(false);
  });

  it('a malformed registry rejects loud (rule 5)', async () => {
    await expect(inventory(async () => ({ version: 1 }))()).rejects.toThrow(/did not answer an array/);
  });
});
