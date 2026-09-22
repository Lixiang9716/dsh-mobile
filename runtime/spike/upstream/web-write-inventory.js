// dsh:logging-exempt (adapter over vendored code; logging stays in the caller)
/**
 * upstream/web-write-inventory.js — the settings 插件 (plugin) inventory leg
 * of the write surface. The official client's plugin-inventory settings tab
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
 * `managementAvailable` is FALSE: this is a read-only host — bundle
 * install/enable is desktop plugin-manager machinery (no vendored package,
 * nothing to port — D9). The plugin-manager SIDEBAR panel renders its
 * designed unavailable state on exactly this field. The settings 内置插件
 * section, though, calls `pluginManager/listBundles` + `listPlugins`
 * DIRECTLY with no managementAvailable gate (measured on device 2026-09-22:
 * unclaimed endpoints left that panel on its 暂时无法读取插件 error), so
 * the two LIST legs are served READ-ONLY from the same snapshot — the wire
 * itself carries the honest disposition: every row ships
 * `readOnlyReason: 'management-required'` (the dsh-api-remotes union's
 * designed read-only member), and the WRITE legs
 * (`setBundleEnabled`/`setPluginEnabled`/`installBundle`/`removeBundle`/
 * `inspect`/`cancelInstall`) stay UNCLAIMED (fail loud, never faked).
 */

/** cordis root-fiber state → the wire's `fiberPhase` vocabulary (the
 * dsh-host-plugin-inventory union). Unknown states refuse loudly (rule 5). */
const FIBER_PHASES = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: 'unloading',
};

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
  return {
    // Read-only host: bundle install/enable is the desktop plugin-manager's
    // machinery — the plugin-manager panel renders its unavailable state.
    managementAvailable: false,
    entries: [...spineRows, ...clientRows],
    agentPresets: await presetPlane(ctx),
  };
};

/** The `pluginManager/listBundles` + `listPlugins` READ-ONLY handlers over
 * the same snapshot sources. Shapes are the frozen dsh-api-remotes
 * descriptors:
 *   listBundles → [{ name, version?, description?, enabled, installed,
 *                    optional, removable, readOnlyReason?, rows: [{rowId,
 *                    moduleName, entryId?}], overrides: [] }]
 *   listPlugins → [{ entryId, moduleName, enabled, fiberPhase,
 *                    readOnlyReason: 'management-required' }]  (the union's
 *                  read-only member — never a `patchId`)
 * Two bundles answer, one per real source: the mounted runtime spine and
 * the staged client tier the page is running from. Every row is read-only
 * — management is desktop machinery, and this host says so per row instead
 * of hiding the list. */
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
    ],
    listPlugins: async () => [...spineRows(), ...stagedRows()],
  };
};
