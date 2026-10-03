// dsh:logging-exempt (probe helper over the write surface's wire answers;
// the scenario's own logger owns the record stream)
/**
 * scenario/manager-legs-probe.js — the pluginManager LIST-legs probe shared
 * by the two settings-driving scenarios (composer-web-live,
 * settings-surfaces; split out at the file-size gate, #335 A1). It demands
 * the honest per-tier disposition over the wire:
 *
 *   - exactly TWO read-only bundles (runtime-spine, official-web-app-tier):
 *     `readOnlyReason: 'management-required'`, rows present, irremovable;
 *   - the workspace-registry bundle MANAGEABLE-shaped: no readOnlyReason,
 *     `removable === installed` (an empty roster is the normal
 *     pre-creation container);
 *   - the plugin rows split cleanly into the read-only members and the
 *     patchId members (`plugins/registry.json` — the write legs' patch
 *     target, #335 A1).
 *
 * Emits ONE record, `settings.pluginManager.readonly` — the shape the
 * frozen scenario manifests pin (re-freeze from a drive after any change).
 */

/** The bundle-plane demands; returns the emit fields (or throws loud). */
const demandBundles = async (awaitRespond) => {
  const manager = await awaitRespond('probe/pluginManager-listBundles-1');
  if (manager.ok !== true) {
    throw new Error(`pluginManager/listBundles did not answer ok: `
      + `${JSON.stringify(manager.error ?? manager)}`);
  }
  const bundles = manager.value ?? [];
  const readOnly = bundles.filter((b) => b.readOnlyReason === 'management-required');
  const workspace = bundles.find((b) => b.name === 'workspace-registry');
  const readOnlyOk = readOnly.length === 2 && readOnly.every((b) => Array.isArray(b.rows)
    && b.rows.length > 0 && b.removable === false);
  if (!readOnlyOk) {
    throw new Error(`the read-only bundles are misshaped: `
      + `${JSON.stringify(bundles).slice(0, 160)}`);
  }
  const workspaceOk = workspace !== undefined
    && workspace.readOnlyReason === undefined
    && workspace.removable === workspace.installed
    && Array.isArray(workspace.rows);
  if (!workspaceOk) {
    throw new Error(`the workspace bundle lost its manageable shape: `
      + `${JSON.stringify(workspace)}`);
  }
  return { bundles, readOnly, workspace };
};

/** The plugin-plane demand: the rows split into read-only and patchId
 * members, nothing in between. Returns the row count (or throws loud). */
const demandPlugins = async (awaitRespond) => {
  const plugins = await awaitRespond('probe/pluginManager-listPlugins-1');
  if (plugins.ok !== true) {
    throw new Error(`pluginManager/listPlugins did not answer ok: `
      + `${JSON.stringify(plugins.error ?? plugins)}`);
  }
  const rows = plugins.value ?? [];
  const locked = rows.filter((r) => r.readOnlyReason === 'management-required'
    && r.patchId === undefined);
  const manageable = rows.filter((r) => r.patchId === 'plugins/registry.json');
  if (locked.length === 0 || locked.length + manageable.length !== rows.length) {
    throw new Error('the plugin rows must split into read-only and patchId members');
  }
  return rows.length;
};

/**
 * Run both manager LIST-leg probes and emit the record.
 * @param deps.awaitRespond - (rpcId) => the api.respond result (the
 *   scenario's own helper — the probes ride the same wire boundary the
 *   page uses).
 * @param deps.emit - (event, fields) => void (the scenario record stream).
 */
export const probeManagerLegs = async ({ awaitRespond, emit }) => {
  const { bundles, readOnly, workspace } = await demandBundles(awaitRespond);
  const plugins = await demandPlugins(awaitRespond);
  emit('settings.pluginManager.readonly', {
    bundles: bundles.length,
    readOnlyBundles: readOnly.length,
    bundleRows: bundles.reduce((sum, b) => sum + b.rows.length, 0),
    plugins,
    workspaceRows: workspace.rows.length,
  });
};
