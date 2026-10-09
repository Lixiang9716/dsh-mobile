/**
 * plugin-mount — the LIVE mount seam for workspace-authored plugins (the
 * render-surface campaign): install-pipeline.js made installing a data
 * transaction; this module makes MOUNTING one — reading an adopted
 * plugins/<spec>/ tree through the gateway fs, registering its entry bytes
 * on the host loader seam (`__dshModuleDefine`, checked before the bare
 * map, so a registered name wins), linking it as a real module (`import()`
 * — its own imports resolve through the ordinary bundle-root/bare map),
 * and mounting the namespace as a cordis plugin (`ctx.plugin(ns)`), all at
 * runtime, after boot, on the serial thread (D2/D8: every step is either
 * an async gateway round trip or loader work the runtime owns).
 *
 * The approval gate: mounting third-party-authored code is a checkpoint
 * boundary, so the default flow asks presentApproval first (contract §4:
 * approval while pending may checkpoint; the native dialog on hosts that
 * present it) and refuses the mount on `{approved: false}` — the "user
 * dismissal is a value" rule. Callers that already hold an approval may
 * pass `{ approved: true }` to skip the dialog.
 *
 * The manifest grammar is the workspace-authored shape (validated by the
 * same function the plugin_manager tool uses — imported from the system
 * plugin, never duplicated): `{id, name?, version, entry,
 * capabilities?: [string]}`. The registry row upsert goes through the same
 * workspace dsh.plugins/1 registry the tool's install_bundle writes, so a
 * mounted plugin IS an installed plugin to every other consumer (settings
 * panel, list legs).
 *
 * Lifecycle logging is the E2E surface (scenario plugin.mount.*): each
 * step logs one structured line; the mount leg's verdict lines are what
 * the manifests assert against.
 */
import { createLogger } from 'logger.js';
import { fsRead, fsWrite, presentApproval } from 'gateway.js';
import { workspacePrefix as prefixOf, upsertRegistryRow }
  from 'workspace-registry.js';
import { validateWorkspaceManifest }
  from 'system-plugins/dsh-plugin-manager-tools/index.js';

const log = createLogger('dsh.plugin-mount');

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

/** Register the entry bytes on the loader seam and import them (step:
 * linked) — the REAL dynamic load, post-boot. */
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
  define(moduleName, await decodeUtf8(entryBytes));
  let ns;
  try {
    ns = await import(moduleName);
  } catch (error) {
    return refused('linked', spec, `the entry did not link: ${error?.message ?? error}`);
  }
  log.info('e2e', { scenario: 'plugin.mount', event: 'plugin.mount.linked',
    spec, module: moduleName });
  return { ns, moduleName };
};

/**
 * `mountWorkspacePlugin(ctx, spec, opts?)` — adopt + live-mount the
 * workspace tree at plugins/<spec>/ (manifest grammar as above). Steps
 * (each an E2E log line, one round trip each): read → validated →
 * approved → adopted → linked → mounted. See the option docs above.
 */
export const mountWorkspacePlugin = async (ctx, spec, opts = {}) => {
  log.debug('mount begin', { spec });
  if (!ctx || typeof ctx.plugin !== 'function') {
    return refused('context', spec, 'no cordis context to mount on');
  }
  if (typeof spec !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(spec)) {
    return refused('spec', spec, 'a spec must be a bare plugin id');
  }
  const prefix = typeof opts.prefix === 'string' ? opts.prefix : workspacePrefix();
  const read = await readManifest(spec, prefix);
  if (read.manifest === undefined) return read;
  const manifest = read.manifest;
  const adopted = await adoptAfterApproval(manifest, spec, prefix, opts);
  if (adopted.adopted !== true) return adopted;
  const linked = await linkEntry(manifest, spec, prefix);
  if (linked.ns === undefined) return linked;
  try {
    await ctx.plugin(linked.ns, opts.pluginOpts ?? {});
  } catch (error) {
    return refused('mounted', spec, `ctx.plugin refused: ${error?.message ?? error}`);
  }
  log.info('e2e', { scenario: 'plugin.mount', event: 'plugin.mount.mounted',
    spec, version: manifest.version });
  return { mounted: true, spec, version: manifest.version, module: linked.moduleName };
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
