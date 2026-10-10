/**
 * plugin-mount — the LIVE mount seam for workspace-authored plugins (the
 * render-surface campaign): install-pipeline.js made installing a data
 * transaction; this module makes MOUNTING one — reading an adopted
 * plugins/<spec>/ tree through the gateway fs, registering its entry bytes
 * on the host loader seam (`__dshModuleDefine`, checked before the bare
 * map, so a registered name wins), linking it as a real module (`import()`
 * — its own imports resolve through the ordinary bundle-root/bare map),
 * and mounting the plugin on the cordis context (`ctx.plugin`), all at
 * runtime, after boot, on the serial thread (D2/D8: every step is either
 * an async gateway round trip or loader work the runtime owns).
 *
 * All three upstream plugin forms are first-class (the tutorial's one-to-one
 * promise): an OBJECT module (named `name`/`inject`/`apply` exports — or
 * the same under `default`), a FUNCTION module (`export default (ctx) =>`),
 * and a CLASS module (`export class X extends Service` — a single
 * function/class export is picked; `Service` itself imports from
 * '@deepseek-ai/cordis', which the loader's bare map serves).
 *
 * Unload is a first-class operation too: the mount keeps the fiber
 * `ctx.plugin` returned, `unmountWorkspacePlugin` awaits its `dispose()`
 * (cordis unwinds everything the plugin registered — listeners, tools,
 * timers, `ctx.effect` cleanups — as effects on that fiber) and disables
 * the registry row. A remount after an unmount re-links under a fresh
 * epoch query (`?e=n`, the loader's node-style cache-buster), so edited
 * source re-reads exactly like node re-reading the file.
 *
 * The approval gate: mounting third-party-authored code is a checkpoint
 * boundary, so the default flow asks presentApproval first (contract §4:
 * approval while pending may checkpoint; the native dialog on hosts that
 * present it) and refuses the mount on `{approved: false}` — the "user
 * dismissal is a value" rule. Callers that already hold an approval may
 * pass `{ approved: true }` to skip the dialog; `mountEnabledRegistry`
 * (the boot-time cordis.yml-insert equivalent — every enabled workspace
 * row mounts at spine boot, the approval happened at adoption) does.
 *
 * The manifest grammar is the workspace-authored shape (validated by the
 * same function the plugin_manager tool uses — imported from the system
 * plugin, never duplicated): `{id, name?, version, entry,
 * capabilities?: [string]}`. The registry row upsert goes through the same
 * workspace dsh.plugins/1 registry the tool's install_bundle writes, so a
 * mounted plugin IS an installed plugin to every other consumer (settings
 * panel, list legs).
 *
 * Lifecycle logging is the E2E surface (scenario plugin.mount.* /
 * plugin.unmount.*): each step logs one structured line; the legs' verdict
 * lines are what the manifests assert against.
 */
import { createLogger } from 'logger.js';
import { fsRead, fsWrite, presentApproval } from 'gateway.js';
import { workspacePrefix as prefixOf, upsertRegistryRow,
  setRegistryRowEnabled, readWorkspaceRegistryDoc }
  from 'workspace-registry.js';
import { validateWorkspaceManifest }
  from 'system-plugins/dsh-plugin-manager-tools/index.js';

const log = createLogger('dsh.plugin-mount');

/** Live mounts: spec → the fiber `ctx.plugin` returned (its `dispose()`
 * unloads the plugin and settles once cordis finished the cleanup). */
const liveFibers = new Map();
/** Link epochs per spec: a remount after an unmount links under `?e=<n>` so
 * the import cache serves a FRESH compile of the (possibly edited) source. */
const epochs = new Map();

/** The workspace prefix for gateway paths, the same derivation the plugin
 * manager tool uses (a seat with no pinned scope root has its workspace AT
 * the scope root — the bare spelling). */
const workspacePrefix = () => prefixOf({
  containerRoot: globalThis.__dshProfileCwd,
  scopeRoot: globalThis.__dshProfileScopeRoot,
});

const utf8Decode = (bytes) => {
  log.debug('latin-1 fallback decode', { length: bytes?.length ?? 0 });
  if (bytes === null || typeof bytes !== 'object') return '';
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
  // multi-byte sequences survive only if the host handed UTF-16 units; the
  // loader's own decoder is the authority — this path is ASCII (the JSON
  // manifest + the authored source the tools write UTF-8-safe).
  return out;
};

/** Decode UTF-8 bytes through the runtime's own TextDecoder face (the
 * llm module's), falling back to latin-1 when absent — the sources the
 * creation flow writes are UTF-8 (the write tool encodes so). */
const decodeUtf8 = async (bytes) => {
  log.debug('decode utf8 face probe', { length: bytes?.length ?? 0 });
  try {
    const mod = await import('llm.js');
    if (typeof mod.utf8Decode === 'function') return mod.utf8Decode(bytes);
  } catch { /* the llm face absent: the fallback below */ }
  return utf8Decode(bytes);
};

/** One live-mount refusal: never a throw — the in-band value the seat and
 * the scenarios log as a step verdict. */
const refused = (step, spec, reason) => {
  log.warn('plugin mount refused', { step, spec, reason });
  return { mounted: false, step, spec, reason };
};

/** Read + grammar-check the workspace manifest (step pair: read →
 * validated). Returns the parsed manifest, or a refused outcome. */
const readManifest = async (spec, prefix) => {
  log.debug('manifest read begin', { spec, prefix });
  const manifestPath = `${prefix ? prefix + '/' : ''}plugins/${spec}/manifest.json`;
  let manifest;
  try {
    const { bytes } = await fsRead('app', manifestPath);
    manifest = JSON.parse(await decodeUtf8(bytes));
  } catch (error) {
    return refused('read', spec,
      `no readable manifest at ${manifestPath}: ${error?.message ?? error}`);
  }
  log.info('e2e', { scenario: 'plugin.mount', event: 'plugin.mount.read',
    spec, version: manifest.version ?? null });
  const invalid = validateWorkspaceManifest(manifest);
  if (invalid) return refused('validated', spec, invalid);
  if (manifest.id !== spec) {
    return refused('validated', spec, `the manifest names id "${manifest.id}", not "${spec}"`);
  }
  log.info('e2e', { scenario: 'plugin.mount', event: 'plugin.mount.validated',
    spec, version: manifest.version });
  return { manifest };
};

/** The approval gate + registry upsert (steps: approved → adopted). */
const adoptAfterApproval = async (manifest, spec, prefix, opts) => {
  log.debug('approval gate', { spec });
  const approved = opts.approved === true ? true : await (async () => {
    if (opts.askApproval === false) return true;
    const verdict = await presentApproval({
      title: `挂载插件 ${manifest.name ?? spec} v${manifest.version}?`,
      message: '该插件由本次会话创作，将以真实代码挂载运行。',
    });
    return verdict?.approved === true;
  })();
  if (!approved) return refused('approval', spec, 'the user declined the mount');
  log.info('e2e', { scenario: 'plugin.mount', event: 'plugin.mount.approved', spec });
  const registry = await upsertRegistryRow({
    fsRead, fsWrite, path: `${prefix ? prefix + '/' : ''}dsh.plugins/1/registry.json`,
  }, {
    id: manifest.id, name: manifest.name ?? manifest.id, version: manifest.version,
    path: `plugins/${spec}`, source: 'workspace', enabled: true,
    installedAt: new Date().toISOString(),
  });
  if (!registry.ok) return refused('adopted', spec, `${registry.code}: ${registry.message}`);
  log.info('e2e', { scenario: 'plugin.mount', event: 'plugin.mount.adopted',
    spec, version: manifest.version });
  return { adopted: true };
};

/** Normalize a linked module's exports to the plugin cordis expects (a
 * function, or an object with an `apply` method — cordis's own contract).
 * The namespace itself works only for the object form's named exports;
 * `default` interop and the single-class pick cover the other two tutorial
 * forms. Returns null when no export is a plugin (refused loud upstream). */
const resolvePluginExport = (ns, spec) => {
  if (ns && typeof ns.apply === 'function') return ns;
  if (ns && ns.default !== undefined) {
    const d = ns.default;
    if (typeof d === 'function') return d;
    if (d && typeof d.apply === 'function') return d;
  }
  const keys = Object.keys(ns ?? {}).filter((k) => k !== 'default');
  const callables = keys.filter((k) => typeof ns[k] === 'function');
  if (keys.length === 1 && callables.length === 1) return ns[keys[0]];
  log.warn('entry exports no plugin', { spec, exports: keys });
  return null;
};

/** Register the entry bytes on the loader seam and import them (step:
 * linked) — the REAL dynamic load, post-boot. A spec remounted after an
 * unmount links under `?e=<epoch>`: the loader's node-style cache-buster,
 * so the fresh compile of the current source is what links. */
const linkEntry = async (manifest, spec, prefix) => {
  log.debug('entry link begin', { spec });
  const entryRel = manifest.entry.replace(/^\.?\//, '');
  const entryPath = `${prefix ? prefix + '/' : ''}plugins/${spec}/${entryRel}`;
  let entryBytes;
  try {
    ({ bytes: entryBytes } = await fsRead('app', entryPath));
  } catch (error) {
    return refused('linked', spec,
      `no readable entry at ${entryPath}: ${error?.message ?? error}`);
  }
  const moduleName = `plugins/${spec}/${entryRel}`;
  const define = globalThis.__dshModuleDefine;
  if (typeof define !== 'function') {
    return refused('linked', spec, 'this host loader has no __dshModuleDefine seam');
  }
  const epoch = epochs.get(spec) ?? 0;
  const importName = epoch > 0 ? `${moduleName}?e=${epoch}` : moduleName;
  define(moduleName, await decodeUtf8(entryBytes));
  let ns;
  try {
    ns = await import(importName);
  } catch (error) {
    return refused('linked', spec, `the entry did not link: ${error?.message ?? error}`);
  }
  const plugin = resolvePluginExport(ns, spec);
  if (plugin === null) {
    return refused('linked', spec,
      'the entry exports no plugin: need an `apply` export, a `default` plugin,'
      + ' or a single Service class export');
  }
  log.info('e2e', { scenario: 'plugin.mount', event: 'plugin.mount.linked',
    spec, module: importName });
  return { plugin, moduleName: importName };
};

/**
 * `mountWorkspacePlugin(ctx, spec, opts?)` — adopt + live-mount the
 * workspace tree at plugins/<spec>/ (manifest grammar as above). Steps
 * (each an E2E log line, one round trip each): read → validated →
 * approved → adopted → linked → mounted. The fiber cordis returned is
 * retained for `unmountWorkspacePlugin`. See the option docs above.
 */
export const mountWorkspacePlugin = async (ctx, spec, opts = {}) => {
  log.debug('mount begin', { spec });
  if (!ctx || typeof ctx.plugin !== 'function') {
    return refused('context', spec, 'no cordis context to mount on');
  }
  if (typeof spec !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(spec)) {
    return refused('spec', spec, 'a spec must be a bare plugin id');
  }
  if (liveFibers.has(spec)) {
    return refused('context', spec, 'already mounted — unmount first (reload is unmount + mount)');
  }
  const prefix = typeof opts.prefix === 'string' ? opts.prefix : workspacePrefix();
  const read = await readManifest(spec, prefix);
  if (read.manifest === undefined) return read;
  const manifest = read.manifest;
  const adopted = await adoptAfterApproval(manifest, spec, prefix, opts);
  if (adopted.adopted !== true) return adopted;
  const linked = await linkEntry(manifest, spec, prefix);
  if (linked.plugin === undefined) return linked;
  try {
    const fiber = ctx.plugin(linked.plugin, opts.pluginOpts ?? {});
    await fiber;
    liveFibers.set(spec, fiber);
  } catch (error) {
    return refused('mounted', spec, `ctx.plugin refused: ${error?.message ?? error}`);
  }
  log.info('e2e', { scenario: 'plugin.mount', event: 'plugin.mount.mounted',
    spec, version: manifest.version });
  return { mounted: true, spec, version: manifest.version, module: linked.moduleName };
};

/** `unmountWorkspacePlugin(spec, opts?)` — the unload half of the tutorial's
 * lifecycle: awaits the fiber's `dispose()` (cordis unwinds every effect the
 * plugin registered — listeners, tools, timers, `ctx.effect` cleanups), then
 * disables the registry row. Steps (E2E log lines): live → disposed →
 * unregistered. The NEXT mount of the spec links a fresh compile (epoch). */
export const unmountWorkspacePlugin = async (spec, opts = {}) => {
  log.debug('unmount begin', { spec });
  const fiber = liveFibers.get(spec);
  if (fiber === undefined) {
    return refused('live', spec, 'not mounted (nothing to unload)');
  }
  log.info('e2e', { scenario: 'plugin.unmount', event: 'plugin.unmount.live', spec });
  try {
    await fiber.dispose();
  } catch (error) {
    return refused('disposed', spec, `fiber.dispose failed: ${error?.message ?? error}`);
  }
  log.info('e2e', { scenario: 'plugin.unmount', event: 'plugin.unmount.disposed', spec });
  liveFibers.delete(spec);
  epochs.set(spec, (epochs.get(spec) ?? 0) + 1);
  const prefix = typeof opts.prefix === 'string' ? opts.prefix : workspacePrefix();
  const registry = await setRegistryRowEnabled({
    fsRead, fsWrite, path: `${prefix ? prefix + '/' : ''}dsh.plugins/1/registry.json`,
  }, spec, false);
  if (!registry.ok) {
    return refused('unregistered', spec, `${registry.code}: ${registry.message}`);
  }
  log.info('e2e', { scenario: 'plugin.unmount', event: 'plugin.unmount.unregistered', spec });
  return { unmounted: true, spec };
};

/** Whether a spec is live-mounted (the plugin manager's remove face checks
 * before disposing). */
export const isMounted = (spec) => liveFibers.has(spec);

/**
 * `mountEnabledRegistry(ctx, opts?)` — the boot-time cordis.yml-insert
 * equivalent: every ENABLED workspace row in the dsh.plugins/1 registry
 * mounts at spine boot (the approval happened at adoption; rows pass
 * `{approved: true}`). A missing registry is the fresh roster — nothing to
 * mount, not an error. Returns the mount outcomes (mounted + refused).
 */
export const mountEnabledRegistry = async (ctx, opts = {}) => {
  log.debug('mount-enabled-registry begin', {});
  const prefix = typeof opts.prefix === 'string' ? opts.prefix : workspacePrefix();
  const doc = await readWorkspaceRegistryDoc({
    fsRead, path: `${prefix ? prefix + '/' : ''}dsh.plugins/1/registry.json`,
  });
  if (!doc.ok) {
    return { ok: false, code: doc.code, message: doc.message, mounted: [], refused: [] };
  }
  const outcomes = { ok: true, mounted: [], refused: [] };
  for (const row of doc.plugins) {
    if (row?.enabled !== true || row.source !== 'workspace') continue;
    const outcome = await mountWorkspacePlugin(ctx, row.id, { ...opts, approved: true });
    if (outcome.mounted) outcomes.mounted.push(outcome);
    else outcomes.refused.push(outcome);
  }
  // Zero rows, zero events: a workspace with no enabled plugins must leave
  // the boot's event stream BYTE-IDENTICAL (the parity legs' frozen
  // manifests assert exact sequences — an empty boot-list line would be an
  // unexpected event there).
  if (outcomes.mounted.length > 0 || outcomes.refused.length > 0) {
    log.info('e2e', { scenario: 'plugin.mount', event: 'plugin.mount.boot-list',
      mounted: outcomes.mounted.map((m) => m.spec),
      refused: outcomes.refused.map((r) => `${r.spec}@${r.step}`) });
  }
  return outcomes;
};

/** The boot-time caller's wrapper (boot.js): mount the enabled rows and
 * report the outcome as one `upstream/boot-plugins` event — a boot never
 * dies on a plugin; refusals ride the event and the spine stands. An empty
 * boot-list stays silent (frozen parity manifests, see above). */
export const mountBootRows = async (ctx, onEvent) => {
  log.debug('boot rows begin', {});
  try {
    const rows = await mountEnabledRegistry(ctx);
    if (rows.ok && rows.mounted.length === 0 && rows.refused.length === 0) return;
    onEvent('upstream/boot-plugins', {
      mounted: rows.ok ? rows.mounted.map((m) => m.spec) : [],
      refused: rows.ok
        ? rows.refused.map((r) => `${r.spec}@${r.step}`)
        : [`${rows.code}: ${rows.message}`],
    });
  } catch (error) {
    onEvent('upstream/boot-plugins', { mounted: [], refused: [String(error?.message ?? error)] });
  }
};

/** The turn-settled hook the creation seats call: if the session authored
 * a plugin tree (plugins/<spec>/manifest.json exists), mount it live. A
 * tree that does not exist is not an error — most turns author none. */
export const mountAfterTurn = async (ctx, specs, opts = {}) => {
  log.debug('mount-after-turn begin', { specs });
  const mounted = [];
  for (const spec of specs) {
    const outcome = await mountWorkspacePlugin(ctx, spec, opts);
    if (outcome.mounted) mounted.push(outcome);
  }
  return mounted;
};
