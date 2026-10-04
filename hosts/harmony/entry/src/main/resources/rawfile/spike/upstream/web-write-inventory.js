// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/web-write-inventory.js — the settings 插件 (plugin) inventory leg
 * of the write surface. This module OWNS the 插件 api entries: the
 * inventory snapshot below, the manager's LIST legs, the WRITE legs
 * (#335 A1, web-write-plugin-manager.js) and the dynamicCordisRunner
 * runtime-side legs (#335 B3, web-write-cordis.js) — assembled here
 * (makePluginInventoryApiEntries, tail of file) so web-write.js stays a
 * router.
 *
 * The official client's plugin-inventory settings tab
 * is `POST /api` `pluginInventory/list`; its wire result (the frozen
 * dsh-api-remotes descriptor, PluginInventorySnapshot) is:
 *
 *   { managementAvailable?: boolean,
 *     entries: [{ entryId, moduleName, enabled, fiberPhase }],
 *     agentPresets?: [{ id, trust, name?, isDefault, broken?,
 *                       rows: [{ entryId|null, moduleName, enabled,
 *                                condition?, fiberPhase }] }] }
 *
 * The mobile answer is an HONEST snapshot of what this host actually has —
 * it invents nothing:
 *   - the mounted runtime spine (boot.js `spineInventory`: every row's
 *     enabled/fiberPhase is read from the live context — service mounted,
 *     tool registered — never from the boot declaration);
 *   - the staged client bundles (the `web.plugins` descriptors the boot
 *     composed — the same roster the official page is running from);
 *   - the Agent 预设 plane from the REAL vendored service
 *     (`compositionInventory()`), with each composition row normalized onto
 *     the wire's required `fiberPhase` (a file composition has no live
 *     fiber: `null`).
 *
 * `managementAvailable` stays FALSE: it names the DESKTOP plugin-manager
 * machinery (profile bundles, pnpm, restart-required applications), which
 * this host still does not offer — the plugin-manager SIDEBAR panel renders
 * its designed unavailable state on exactly this field. The settings 内置插件
 * section, though, calls `pluginManager/listBundles` + `listPlugins`
 * DIRECTLY with no managementAvailable gate (measured on device 2026-09-22:
 * unclaimed endpoints left that panel on its 暂时无法读取插件 error), so
 * the two LIST legs are served from the same snapshot with the honest
 * PER-ROW disposition: the spine and staged tiers ship
 * `readOnlyReason: 'management-required'` (the dsh-api-remotes union's
 * designed read-only member), and the WORKSPACE tier — the scope the
 * plugin-manager write legs actually manage since #335 A1 — carries
 * `patchId: 'plugins/registry.json'` instead (the union's manageable
 * member: the persistent file whose rows own the enablement).
 * The write legs themselves live in upstream/web-write-plugin-manager.js
 * over the §4 pipeline + receipts journal + the dsh.plugins/1 registry.
 */

/** cordis root-fiber state → the wire's `fiberPhase` vocabulary (the
 * dsh-host-plugin-inventory union). Unknown states refuse loudly (rule 5). */
// The pluginManager WRITE legs (#335 A1): the six verbs over the §4
// pipeline + the receipts journal + the workspace registry.
import { makePluginManagerWriteHandlers } from 'upstream/web-write-plugin-manager.js';
// The dynamicCordisRunner runtime-side legs (#335 B3): the honest answers
// that stop the per-page-load gateway/unimplemented pair.
import { makeCordisRunnerApiEntries } from 'upstream/web-write-cordis.js';

const FIBER_PHASES = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: 'unloading',
};

/** The workspace tier's persistent patch target — the same dsh.plugins/1
 * document the write legs read/write (web-write-plugin-manager.js's
 * WORKSPACE_PATCH_ID; kept literal here so the LIST plane never imports the
 * WRITE plane). */
const WORKSPACE_PATCH_ID = 'plugins/registry.json';

const fiberPhaseOf = (row) => {
  if (row.fiberState === undefined) return null; // a file composition: no live fiber
  const phase = FIBER_PHASES[row.fiberState];
  if (phase === undefined) {
    throw new Error(`web-write-inventory: unknown cordis fiber state ${String(row.fiberState)}`
      + ` (row ${JSON.stringify(row.moduleName)})`);
  }
  return phase;
};

/** The Agent 预设 plane, straight from the REAL service. Demands the mounted
 * service (fail loud, never a silent empty roster). */
const presetPlane = async (ctx) => {
  const service = ctx.get('agentPresets');
  if (service === undefined) {
    throw new Error('web-write-inventory: the agentPresets service is not mounted');
  }
  const found = await service.compositionInventory();
  return found.map((preset) => ({
    id: preset.id,
    trust: preset.trust,
    isDefault: preset.isDefault === true,
    ...(preset.name === undefined ? {} : { name: preset.name }),
    ...(preset.broken === undefined ? {} : { broken: preset.broken }),
    rows: (preset.rows ?? []).map((row) => ({
      entryId: row.entryId ?? null,
      moduleName: row.moduleName,
      enabled: row.enabled,
      fiberPhase: fiberPhaseOf(row),
      ...(row.condition === undefined ? {} : { condition: row.condition }),
    })),
  }));
};

/**
 * The `pluginInventory/list` handler over one booted spine ctx.
 * @param ctx - the spine context (ctx.agentPresets mounted by boot.js).
 * @param deps.spine - () => the mounted runtime spine rows (boot.js
 *   spineInventory; the caller wires it — web-boot cannot import boot.js
 *   without dragging the whole spine into the bare compose-only embed).
 * @param deps.stagedPlugins - () => the staged web-plugin descriptors (the
 *   web-boot delivery store) — the client bundles the boot composed.
 */
export const makePluginInventoryHandler = (ctx, deps) => async () => {
  if (typeof deps?.spine !== 'function') {
    throw new Error('web-write-inventory: no spine inventory provider was wired');
  }
  if (typeof deps?.stagedPlugins !== 'function') {
    throw new Error('web-write-inventory: no staged-plugin provider was wired');
  }
  const spineRows = deps.spine();
  if (!Array.isArray(spineRows)) {
    throw new Error('web-write-inventory: the spine inventory provider did not answer an array');
  }
  const staged = deps.stagedPlugins();
  const clientRows = (Array.isArray(staged) ? staged : []).map((plugin) => ({
    entryId: plugin.loaderName,
    moduleName: plugin.loaderName,
    enabled: true, // composed into the served boot graph (this list answers post-boot)
    fiberPhase: 'active',
  }));
  // The workspace registry tier (the agent-authored dsh.plugins/1 entries —
  // the one-sentence-creation path). Optional provider: absent → no rows (the
  // historical shape); malformed → reject loud (rule 5). These are
  // session-scope file compositions: no live fiber, never host-managed.
  let workspaceEntries = [];
  if (typeof deps.workspaceRegistry === 'function') {
    const entries = await deps.workspaceRegistry();
    if (!Array.isArray(entries)) {
      throw new Error('web-write-inventory: the workspace registry provider did not answer an array');
    }
    workspaceEntries = entries.map((entry) => ({
      entryId: entry.id,
      moduleName: entry.name ?? entry.id,
      enabled: entry.enabled === true,
      fiberPhase: null,
    }));
  }
  return {
    // Read-only host: bundle install/enable is the desktop plugin-manager's
    // machinery — the plugin-manager panel renders its unavailable state.
    managementAvailable: false,
    entries: [...spineRows, ...clientRows, ...workspaceEntries],
    agentPresets: await presetPlane(ctx),
  };
};

/** The `pluginManager/listBundles` + `listPlugins` handlers over the same
 * snapshot sources. Shapes are the frozen dsh-api-remotes descriptors:
 *   listBundles → [{ name, version?, description?, enabled, installed,
 *                    optional, removable, readOnlyReason?, rows: [{rowId,
 *                    moduleName, entryId?}], overrides: [] }]
 *   listPlugins → [{ entryId, moduleName, enabled, fiberPhase,
 *                    readOnlyReason: 'management-required' }]   (read-only
 *                  member)  |  [{ ..., patchId }]  (manageable member)
 * Three bundles answer, one per real source: the mounted runtime spine, the
 * staged client tier the page is running from, and the workspace registry —
 * the first two are read-only (desktop machinery), the workspace tier is
 * the scope the manager's WRITE legs handle in-band (#335 A1). */
/** The staged client tier as read-only plugin rows. */
const stagedReadOnlyRows = (staged, readOnly) =>
  (Array.isArray(staged) ? staged : []).map((plugin) => ({
    entryId: plugin.loaderName,
    moduleName: plugin.loaderName,
    enabled: true,
    fiberPhase: 'active',
    readOnlyReason: readOnly,
  }));

/** The mounted spine as read-only plugin rows (fail loud on a bad provider). */
const spineReadOnlyRows = (rows, readOnly) => {
  if (!Array.isArray(rows)) {
    throw new Error('web-write-inventory: the spine inventory provider did not answer an array');
  }
  return rows.map((row) => ({
    entryId: row.entryId,
    moduleName: row.moduleName,
    enabled: row.enabled === true,
    fiberPhase: row.fiberPhase ?? null,
    readOnlyReason: readOnly,
  }));
};

/** The workspace registry tier: plugins the AGENT authored and self-installed
 * into the workspace's dsh.plugins/1 registry (the one-sentence-creation
 * path), PLUS the packages the plugin-manager write legs adopted into the
 * same registry (#335 A1). MANAGEABLE rows: the union's patchId member —
 * the registry IS the persistent patch target the enable legs write (never
 * a readOnlyReason: the manager handles this tier in-band). The provider is
 * optional: without one the tier is empty (no fabricated rows); a provider
 * that answers a malformed registry rejects loud (rule 5). */
const workspaceRows = async (deps) => {
  if (typeof deps.workspaceRegistry !== 'function') return [];
  const entries = await deps.workspaceRegistry();
  if (!Array.isArray(entries)) {
    throw new Error('web-write-inventory: the workspace registry provider did not answer an array');
  }
  return entries.map((entry) => ({
    entryId: entry.id,
    moduleName: entry.name ?? entry.id,
    enabled: entry.enabled === true,
    fiberPhase: null, // a workspace-file composition: no live fiber
    patchId: WORKSPACE_PATCH_ID,
  }));
};

const workspaceBundle = async (deps) => {
  const rows = (await workspaceRows(deps)).map((row) => ({
    rowId: row.entryId,
    moduleName: row.moduleName,
    entryId: row.entryId,
  }));
  return {
    name: 'workspace-registry',
    enabled: true,
    installed: rows.length > 0,
    optional: true,
    removable: rows.length > 0, // removal availability rides installation
    rows,
    overrides: [],
  };
};

export const makePluginManagerHandlers = (ctx, deps) => {
  if (typeof deps?.spine !== 'function' || typeof deps?.stagedPlugins !== 'function') {
    throw new Error('web-write-inventory: no spine/staged-plugin provider was wired');
  }
  const READ_ONLY = 'management-required';
  const stagedRows = () => stagedReadOnlyRows(deps.stagedPlugins(), READ_ONLY);
  const spineRows = () => spineReadOnlyRows(deps.spine(), READ_ONLY);
  return {
    listBundles: async () => [
      {
        name: 'runtime-spine',
        enabled: true,
        installed: true,
        optional: false,
        removable: false,
        readOnlyReason: READ_ONLY,
        rows: spineRows().map((row) => ({
          rowId: row.entryId,
          moduleName: row.moduleName,
          entryId: row.entryId,
        })),
        overrides: [],
      },
      {
        name: 'official-web-app-tier',
        enabled: true,
        installed: true,
        optional: false,
        removable: false,
        readOnlyReason: READ_ONLY,
        rows: stagedRows().map((row) => ({
          rowId: row.entryId,
          moduleName: row.moduleName,
          entryId: row.entryId,
        })),
        overrides: [],
      },
      await workspaceBundle(deps),
    ],
    listPlugins: async () => [...spineRows(), ...stagedRows(), ...(await workspaceRows(deps))],
  };
};


/** The settings 插件 api entries (split from web-write.js at the file-size
 * gate): the read-only inventory snapshot, the manager's LIST legs, the
 * manager's WRITE legs (#335 A1) and the dynamicCordisRunner legs (#335 B3).
 * `deps.marketplace` is the write surface's VALIDATED opt-in — the write
 * legs refuse in-band when it is absent. */
export const makePluginInventoryApiEntries = (ctx, options, deps) => {
  const surfaceDeps = {
    spine: options.spine,
    stagedPlugins: options.stagedPlugins,
    ...(options.workspaceRegistry === undefined ? {} : { workspaceRegistry: options.workspaceRegistry }),
  };
  return {
    'pluginInventory/list': makePluginInventoryHandler(ctx, surfaceDeps),
    ...Object.fromEntries(Object.entries(
      makePluginManagerHandlers(ctx, surfaceDeps),
    ).map(([name, handler]) => [`pluginManager/${name}`, handler])),
    ...Object.fromEntries(Object.entries(
      makePluginManagerWriteHandlers(deps),
    ).map(([name, handler]) => [`pluginManager/${name}`, handler])),
    ...makeCordisRunnerApiEntries(ctx),
  };
};
