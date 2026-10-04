// dsh:logging-exempt (plugin entry; logging happens through the mounted logger)
/**
 * dsh-plugin-manager-tools — the session toolset's plugin pipeline (issue
 * #346 item 3): the `plugin_manager` tool the Creator composition declares
 * (row `tool-plugin-manager`, enabled since #334), mounted on the mobile
 * spine beside the other tool rows.
 *
 * WHY A SPINE MOUNT AND NOT THE COMPOSITION ROW (#346): the composition
 * chain never composes on this host — the boot agent joins no preset
 * (boot.js's documented staged gap; upstream's `agent/created` warning
 * names exactly this), so composition rows are inventory documents, not
 * mounts. And the vendored row module (`@deepseek-ai/dsh-plugin-manager/
 * tools`) cannot mount here either: its `inject` demands the `pluginManager`
 * + `sandboxPolicy` services (and its execute reads an `approval` service)
 * — the desktop policy/approval machinery this seat does not run, though
 * the packages themselves are vendored. Same decision shape as
 * tool-cordis (upstream/preset-mobile-rows.js): the desktop face stays
 * unmounted; the mobile face is this outboard implementation package (D6),
 * wired to the REAL #340 backend semantics — the workspace dsh.plugins/1
 * registry (the LIST legs' manageable plane) over the gateway fs, with
 * in-band refusals: a handler never throws (#312).
 *
 * The tool's verbs (the vendored tool's action vocabulary):
 *   list_plugins / list_bundles → the workspace registry roster
 *   set_plugin / set_bundle     → one row's enabled flag (read-modify-write)
 *   remove_bundle               → the roster row goes; workspace FILES stay
 *                                 (the #340 remove semantic)
 *   install_bundle              → adopt a WORKSPACE-AUTHORED tree: spec is
 *                                 a bare name resolved at plugins/<spec>/
 *                                 manifest.json under the workspace, its
 *                                 manifest validated against the
 *                                 workspace-authored grammar, then the
 *                                 roster row upserted (enabled unless
 *                                 options.enabled === false). Catalog
 *                                 installs (marketplace index → §4 fetch,
 *                                 the settings 内置插件 api legs) stay off
 *                                 this tool in v1 — a spec with no
 *                                 workspace tree refuses in-band naming
 *                                 the search.
 */
import { createLogger } from 'logger.js';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { fsRead, fsWrite, GatewayError } from 'gateway.js';
import {
  workspacePrefix, joinScoped, workspaceRegistryPath, decodeUtf8Face,
  readWorkspaceRegistryDoc, upsertRegistryRow, removeRegistryRow,
  setRegistryRowEnabled,
} from 'workspace-registry.js';

const log = createLogger('dsh.pluginManagerTools');

export const manifest = {
  schemaVersion: 1,
  id: 'dsh-plugin-manager-tools',
  version: '0.1.0',
  type: 'service',
  entry: 'index.js',
  capabilities: { required: ['fsRead', 'fsWrite'], optional: [] },
  hooks: { activate: 'activate' },
};

/** Package ids this tool adopts — the §4 pipeline's grammar
 * (install-pipeline.js PKG_ID). */
const PKG_ID = /^[a-z0-9][a-z0-9.-]*$/;

/** The workspace-authored manifest grammar (the one-sentence-creation
 * path's shape, device-verified: `{id, name?, version, entry,
 * capabilities?: [string]}` — the battery's quotes plugin, the countdown10
 * roster). Deliberately NOT the §4 pipeline's validateManifest: that schema
 * (schemaVersion/type/capabilities{required,optional}) governs MARKETPLACE
 * packages; an agent-authored workspace manifest carries free-form fields
 * this plane does not own. What the roster row consumes must parse: id,
 * semver version, entry path. @returns null, or the reason. */
const WORKSPACE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const validateWorkspaceManifest = (m) => {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'manifest must be an object';
  if (typeof m.id !== 'string' || !PKG_ID.test(m.id)) return 'bad manifest id';
  if (typeof m.version !== 'string' || !WORKSPACE_SEMVER.test(m.version)) {
    return 'bad manifest version';
  }
  if (typeof m.entry !== 'string' || m.entry.length === 0) return 'bad manifest entry';
  return null;
};

/** The workspace prefix for gateway paths, derived from the pinned globals
 * (the shell executor's scopePathFor convention, tolerant: a seat with no
 * pinned scope root has its workspace AT the scope root — the bare
 * spelling). */
const workspaceParts = () => ({
  containerRoot: globalThis.__dshProfileCwd,
  scopeRoot: globalThis.__dshProfileScopeRoot,
});

/** One in-band failure object (the #340 ChangeResult vocabulary). */
const failed = (stage, target, code, diagnostic) => {
  log.debug('tool leg refused in-band', { stage, target, code });
  return { changed: false, application: 'failed', stage, target,
    error: { code, diagnostic } };
};

/** The error-classifier the in-band frame uses: an io miss is `not-found`,
 * anything else is `operation-error` with the real message. */
const failCodeOf = (error) => (error?.code === 'io' ? 'not-found' : 'operation-error');

/** The in-band frame every verb runs under: a rejection becomes the wire's
 * `application: 'failed'` object, never a throw. */
const inBand = (stage, targetOf, run) => async (args) => {
  const target = targetOf(args);
  log.debug('tool leg begin', { stage, target });
  try {
    return await run(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failed(stage, String(target ?? ''), failCodeOf(error), message);
  }
};

/** The paged envelope the vendored tool answers list actions with. */
const paged = (rows, args) => {
  const offset = typeof args?.offset === 'number' && Number.isInteger(args.offset)
    && args.offset >= 0 ? args.offset : 0;
  const limit = typeof args?.limit === 'number' && Number.isInteger(args.limit)
    && args.limit >= 1 && args.limit <= 100 ? args.limit : 25;
  const entries = rows.slice(offset, offset + limit);
  return { entries, total: rows.length,
    nextOffset: offset + entries.length < rows.length ? offset + entries.length : null };
};

/** The workspace roster rows in the manager LIST shape (entryId/moduleName/
 * enabled, the inventory workspace tier's fields). */
const rosterRows = (plugins) => (Array.isArray(plugins) ? plugins : [])
  .filter((row) => row !== null && typeof row === 'object')
  .map((row) => ({
    entryId: row.id,
    moduleName: row.name ?? row.id,
    enabled: row.enabled === true,
    ...(row.version === undefined ? {} : { version: row.version }),
    ...(row.path === undefined ? {} : { path: row.path }),
  }));

/** list_plugins / list_bundles: the honest workspace roster. */
const listLeg = (mode) => inBand(mode, () => mode, async () => {
  const path = workspaceRegistryPath(workspaceParts());
  const read = await readWorkspaceRegistryDoc({ fsRead, path });
  if (!read.ok) {
    return failed('list', mode, 'operation-error', read.message);
  }
  const rows = rosterRows(read.plugins);
  if (mode === 'list_plugins') {
    return paged(rows, {});
  }
  return { bundles: [{
    name: 'workspace-registry',
    enabled: true,
    installed: rows.length > 0,
    optional: true,
    removable: rows.length > 0,
    rows: rows.map((row) => ({ rowId: row.entryId, moduleName: row.moduleName,
      entryId: row.entryId })),
    overrides: [],
  }], total: 1 };
});

/** The shared enable verb (set_plugin targets the entry id, set_bundle the
 * roster name — one roster on this host, so both flip the same row). */
const enableLeg = (stage) => inBand(stage, (a) => a?.target, async (args) => {
  const target = args?.target;
  const enabled = args?.enabled;
  if (typeof target !== 'string' || target.trim() === '') {
    return failed(stage, String(target ?? ''), 'invalid-spec', 'target is required');
  }
  if (typeof enabled !== 'boolean') {
    return failed(stage, target, 'invalid-spec', 'enabled must be a boolean');
  }
  const outcome = await setRegistryRowEnabled(
    { fsRead, fsWrite, path: workspaceRegistryPath(workspaceParts()) },
    target, enabled);
  if (!outcome.ok) {
    return failed(stage, target, outcome.code, outcome.message);
  }
  log.debug('tool enable applied', { stage, target, enabled });
  return { changed: outcome.changed, application: 'applied', stage, target, enabled };
});

/** remove_bundle: the roster row goes, the workspace files stay. */
const removeLeg = inBand('remove', (a) => a?.target, async (args) => {
  const target = args?.target;
  if (typeof target !== 'string' || !PKG_ID.test(target)) {
    return failed('remove', String(target ?? ''), 'invalid-spec',
      'a bare registry package name is required');
  }
  const outcome = await removeRegistryRow(
    { fsRead, fsWrite, path: workspaceRegistryPath(workspaceParts()) }, target);
  if (!outcome.ok) return failed('remove', target, outcome.code, outcome.message);
  if (!outcome.removed) {
    return failed('remove', target, 'unknown-plugin',
      `no registry row names "${target}"`);
  }
  log.debug('tool remove applied', { target });
  return { changed: true, application: 'applied', stage: 'remove', target };
});

/** install_bundle: adopt a workspace-authored tree (plugins/<spec>/ under
 * the workspace) after re-validating its manifest through the §4 pipeline's
 * validator. */
const installLeg = inBand('install', (a) => a?.target, async (args) => {
  const spec = args?.target;
  if (typeof spec !== 'string' || !PKG_ID.test(spec)) {
    return failed('install', String(spec ?? ''), 'invalid-spec',
      'v1 workspace scope adopts bare registry names only (a spec must name '
      + 'a plugin tree the session authored at plugins/<name>/)');
  }
  const prefix = workspacePrefix(workspaceParts());
  const manifestPath = joinScoped(prefix, `plugins/${spec}/manifest.json`);
  let parsed;
  try {
    const decode = await decodeUtf8Face();
    const { bytes } = await fsRead('app', manifestPath);
    parsed = JSON.parse(decode(bytes));
  } catch (error) {
    return failed('install', spec, failCodeOf(error),
      `no readable manifest at ${manifestPath}: ${error?.message ?? error}`);
  }
  const invalid = validateWorkspaceManifest(parsed);
  if (invalid) {
    return failed('install', spec, 'not-a-package',
      `the manifest no longer validates: ${invalid}`);
  }
  const manifest = parsed;
  if (manifest.id !== spec) {
    return failed('install', spec, 'invalid-spec',
      `the tree's manifest names id "${manifest.id}", not "${spec}"`);
  }
  const row = {
    id: manifest.id,
    name: manifest.name ?? manifest.id,
    version: manifest.version,
    path: `plugins/${spec}`,
    source: 'workspace',
    enabled: args?.enabled !== false,
    installedAt: new Date().toISOString(),
  };
  const outcome = await upsertRegistryRow(
    { fsRead, fsWrite, path: workspaceRegistryPath(workspaceParts()) }, row);
  if (!outcome.ok) return failed('install', spec, outcome.code, outcome.message);
  log.info('workspace plugin adopted', { id: spec, version: row.version,
    enabled: row.enabled, changed: outcome.changed });
  return { changed: outcome.changed, application: 'applied', stage: 'install',
    target: spec, bundle: spec, enabled: row.enabled };
});

const ACTIONS = {
  list_plugins: (args) => listLeg('list_plugins')(args),
  list_bundles: (args) => listLeg('list_bundles')(args),
  set_plugin: (args) => enableLeg('enable')(args),
  set_bundle: (args) => enableLeg('enable')(args),
  install_bundle: (args) => installLeg(args),
  remove_bundle: (args) => removeLeg(args),
};

/** The tool result: the model reads one JSON line either way — the success
 * envelope or the structured failure. GatewayError can only escape the
 * frame's own classification through a bug; it is caught here so the tool
 * boundary NEVER throws (#312). */
const execute = async (args) => {
  const action = args?.action;
  log.debug('tool invoked', { action });
  const leg = ACTIONS[action];
  if (leg === undefined) {
    return JSON.stringify({ ok: false, error: `unknown action: ${JSON.stringify(action ?? null)}`
      + ` — use list_plugins|list_bundles|set_plugin|set_bundle|install_bundle|remove_bundle` });
  }
  try {
    return JSON.stringify({ ok: true, ...await leg(args) });
  } catch (error) {
    log.warn('tool leg escaped the in-band frame', { action,
      error: error?.message ?? String(error) });
    return JSON.stringify({ ok: false,
      error: `plugin_manager ${action} failed: ${error?.message ?? String(error)}` });
  }
};

const pluginManagerTool = () => defineTool({
  name: 'plugin_manager',
  description: 'Manage this workspace\'s plugin pipeline: list the installed '
    + 'plugins, install one you have authored into the workspace '
    + '(plugins/<name>/ with its manifest.json), enable or disable it, or '
    + 'remove its roster entry. List first to obtain exact identifiers.',
  parameters: {
    action: {
      type: 'string', required: true,
      enum: ['list_plugins', 'list_bundles', 'set_plugin', 'set_bundle',
        'install_bundle', 'remove_bundle'],
      description: 'Management operation.',
    },
    target: {
      type: 'string',
      description: 'Plugin entry id or package name, according to action '
        + '(install_bundle resolves it at plugins/<name>/ in the workspace).',
    },
    enabled: {
      type: 'boolean',
      description: 'Required for set operations; defaults to true for install.',
    },
    offset: { type: 'number', description: 'Zero-based list offset (default 0).' },
    limit: { type: 'number', description: 'List page size, 1-100 (default 25).' },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  execute,
});

export function activate() {
  log.debug('dsh-plugin-manager-tools activated', {});
}

/** The spine's mount shape (boot.js): the tool registers into the `tools`
 * service at apply time — mounted after `tools`, which the inject waits
 * for. Unconditional: an empty roster is the honest pre-creation state, so
 * unlike the daemon-configured open_design tools there is nothing to
 * decline. */
export const name = 'dsh-plugin-manager-tools';
export const inject = ['tools'];

export const apply = (ctx) => {
  ctx.tools.register(pluginManagerTool());
  log.debug('plugin_manager registered', {});
};
