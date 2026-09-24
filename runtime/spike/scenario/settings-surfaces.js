// dsh:logging-exempt (boot module; logging happens through the mounted logger)
/**
 * settings-surfaces.js — the CLI proof for the official client's SETTINGS
 * screens (scenario `settings.surfaces`): the Agent 预设 roster and the
 * 插件 (plugin) inventory, answered at the same wire boundary the page uses.
 *
 * Flow: upstream/boot.js composes the mobile profile with the REAL settings
 * plane mounted (the cordis Loader service + the vendored @deepseek-ai/
 * dsh-agent-presets over the staged presets VFS), the `web.plugins` bus
 * delivery (staged by the runner via --bus-inject, the full application-tier
 * roster) composes the official web boot wire, and an `agentPresets.seed`
 * delivery (the same shape the platform drives deliver) mounts the presets
 * tree. The scenario then self-probes the claimed /api surface:
 *
 *   agentPresets/list          → the REAL roster (shipped presets, default
 *                                marked, honest per-preset health verdicts)
 *   agentPresets/read          → the default preset's composition document
 *   agentPresets/copy          → the honest read-only refusal (agent-preset/
 *                                read-only — the staged fs has no user root)
 *   pluginInventory/list       → the honest read-only snapshot: mounted spine
 *                                + staged client bundles + 预设 compositions
 *   pluginManager/listBundles  → READ-ONLY rows (readOnlyReason:
 *                                machinery stays unclaimed — fail loud)
 *
 * No LLM turn is driven: the settings surfaces are pure reads, so the llm
 * route is a never-dialed loopback placeholder (boot demands a route; the
 * profile has no transport-free fallback).
 *
 * Every expected event is declared one-to-one in
 * tools/e2e/scenarios/settings-surfaces.json; artifacts land under
 * runtime/spike/artifacts/macos-cli-settings-surfaces/.
 */
import { createLogger } from 'logger.js';
import { fsScope } from 'gateway.js';
import { AGENT_PRESETS_BASE_URL, bootUpstream, spineInventory } from 'upstream/boot.js';
import { createWebBootRuntime } from 'upstream/web-boot.js';
import { errorOf } from 'upstream/web-write.js';
import seedManifest from './agent-presets-probe-seed.js';

const SCENARIO = 'settings.surfaces';
const AGENT_ID = 'main';
const SESSION_ID = 's-settings-surfaces-1';
const DEFAULT_PRESET = 'mobile';

const log = createLogger('settings.surfaces');
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  const error = reason instanceof Error ? reason : null;
  const message = error ? error.message : (typeof reason === 'object' ? JSON.stringify(reason) : String(reason));
  const withStack = error?.stack
    ? `${message} | ${error.stack.split('\n').slice(0, 4).join(' / ')}`
    : message;
  log.debug('scenario failed', { reason: withStack });
  emit('scenario.failed', { reason: withStack });
  globalThis.__dshComplete(false, withStack);
};
const demand = (cond, reason) => {
  if (cond) return;
  log.debug('demand failed', { reason });
  fail(reason);
  throw new Error(reason);
};

/** Bus plumbing: deliveries may arrive while eval is still running (the host
 * injects right after eval), so the subscription exists at module scope and
 * buffers until the adapter is mounted. */
const busDeliveries = [];
let busHandler = null;
globalThis.__dshBusOnMessage = (line) => {
  const msg = JSON.parse(line);
  if (busHandler === null) busDeliveries.push(msg);
  else busHandler(msg);
};

/** All posted frames, in order — the probes assert on the api.respond frames
 * and the api.claim frame (the exact wire the carrier consumes). */
const posted = [];
const post = (msg) => {
  posted.push(msg);
  globalThis.__dshBusPost?.(JSON.stringify(msg));
};

const launchEnv = () => {
  log.debug('launch env phase begin', {});
  const raw = globalThis.__dshLaunchEnv?.();
  demand(typeof raw === 'string', 'launch env snapshot missing (CLI must pass --env)');
  return JSON.parse(raw);
};

const bootPhase = async (env) => {
  log.debug('boot phase begin', {});
  const resolved = await fsScope.resolve('scope://app/');
  const root = resolved?.path;
  demand(typeof root === 'string' && root.startsWith('/'), `profile container not resolved: ${JSON.stringify(resolved)}`);
  const { ctx } = await bootUpstream({
    scenario: SCENARIO,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    cwd: root,
    onEvent: emit,
    container: {
      cwd: root,
      tmpdir: `${root}/tmp`,
      home: `${root}/home`,
      env,
      argv: ['dsh', '--profile', 'mobile'],
    },
    llm: {
      // Never dialed: the settings surfaces are pure reads. The boot demands
      // a route because the profile has no transport-free fallback.
      baseURL: env.DSH_SETTINGS_LLM_BASEURL,
      apiKey: 'unused-settings-proof',
      provider: 'mock',
      model: 'mock-1',
    },
  });
  demand(ctx.get('agentPresets') !== undefined, 'the agentPresets service is not mounted');
  demand(ctx.get('loader') !== undefined, 'the cordis Loader service is not mounted');
  emit('settings.services', {
    loader: 'mounted',
    agentPresets: 'mounted',
    baseUrl: AGENT_PRESETS_BASE_URL,
  });
  return ctx;
};

/** The presets seed as the bus delivery the platform drives post: every file
 * base64 under its VFS path, fixed stamp (mtimeMs 0). */
const seedDelivery = () => {
  const files = {};
  for (const [path, file] of Object.entries(seedManifest)) {
    files[path] = {
      b64: globalThis.Buffer.from(file.bytes).toString('base64'),
      mtimeMs: 0,
    };
  }
  return { type: 'agentPresets.seed', files };
};

/** Mount the web-boot runtime half (write surface composed), queue the
 * presets seed BEFORE the drain (the device delivery order: config →
 * web.plugins → seed), and install the dispatcher. */
let STAGED_PLUGINS = -1;
const mountBusPhase = (ctx) => {
  const runtime = createWebBootRuntime({
    ctx, post,
    write: {
      root: globalThis.__dshProfileCwd,
      provider: 'mock',
      model: 'mock-1',
      spine: () => spineInventory(ctx),
    },
  });
  busHandler = (msg) => {
    const outcome = runtime.deliver(msg);
    if (outcome.kind === 'unknown') {
      throw new Error(`web-boot: unknown bus delivery type '${outcome.type}'`);
    }
    if (outcome.kind === 'handler') {
      outcome.run().then((value) => {
        post({ type: 'api.respond', rpcId: msg.rpcId, result: { ok: true, value } });
      }, (error) => {
        post({ type: 'api.respond', rpcId: msg.rpcId, result: { ok: false, error: errorOf(error) } });
      });
    }
  };
  busDeliveries.push(seedDelivery());
  // The staged plugin count the inventory assertions compare against, read
  // from the delivery BEFORE the drain consumes it.
  const pluginsDelivery = busDeliveries.find((m) => m.type === 'web.plugins');
  demand(pluginsDelivery !== undefined,
    'no web.plugins delivery was injected by the host');
  STAGED_PLUGINS = pluginsDelivery.plugins.length;
  for (const msg of busDeliveries.splice(0)) busHandler(msg);
  log.debug('bus phase mounted', { stagedPlugins: STAGED_PLUGINS });
};

const PROBES = [
  { rpcId: 'probe/agentPresets-list-1', endpoint: 'agentPresets/list', args: {} },
  { rpcId: 'probe/agentPresets-read-1', endpoint: 'agentPresets/read', args: { agentPreset: DEFAULT_PRESET } },
  { rpcId: 'probe/agentPresets-copy-1', endpoint: 'agentPresets/copy', args: { from: DEFAULT_PRESET, id: 'copy-probe', name: 'Copy probe' } },
  { rpcId: 'probe/agentPresets-delete-1', endpoint: 'agentPresets/deletePreset', args: { id: DEFAULT_PRESET } },
  { rpcId: 'probe/agentPresets-select-1', endpoint: 'agentPresets/select', args: { agent: 's-not-attached', agentPreset: DEFAULT_PRESET } },
  { rpcId: 'probe/pluginInventory-list-1', endpoint: 'pluginInventory/list', args: {} },
  { rpcId: 'probe/pluginManager-listBundles-1', endpoint: 'pluginManager/listBundles', args: {} },
  { rpcId: 'probe/pluginManager-listPlugins-1', endpoint: 'pluginManager/listPlugins', args: {} },
];

const awaitRespond = async (rpcId) => {
  let guard = 0;
  while (!posted.some((f) => f.type === 'api.respond' && f.rpcId === rpcId) && guard++ < 10000) {
    await Promise.resolve();
  }
  const respond = posted.find((f) => f.type === 'api.respond' && f.rpcId === rpcId);
  demand(respond !== undefined, `no api.respond for the ${rpcId} probe`);
  return respond.result;
};

/** The claims phase: the runtime's api.claim frame must cover the settings
 * legs (every claimed endpoint is asserted by a record somewhere). */
const assertClaimsPhase = () => {
  log.debug('claims phase begin', {});
  const claim = posted.find((f) => f.type === 'api.claim');
  demand(claim !== undefined, 'no api.claim frame was posted');
  const SETTINGS_LEGS = [
    'agentPresets/list', 'agentPresets/read', 'agentPresets/copy',
    'agentPresets/deletePreset', 'agentPresets/select', 'pluginInventory/list',
    // The 内置插件 section reads these directly (no managementAvailable
    // gate there); they answer READ-ONLY rows. The WRITE legs stay unclaimed.
    'pluginManager/listBundles', 'pluginManager/listPlugins',
    'credentials/describe', 'session/modelCatalog',
  ];
  const missing = SETTINGS_LEGS.filter((e) => !claim.endpoints.includes(e));
  demand(missing.length === 0, `the claims are missing the settings legs: ${missing.join(', ')}`);
  emit('settings.claims', {
    endpoints: claim.endpoints.length,
    settingsLegs: SETTINGS_LEGS.length,
    pluginManagerReadonly: true,
  });
};

/** 预设 roster + read: the REAL vendored service over the wire. */
const probePresets = async () => {
  const roster = await awaitRespond('probe/agentPresets-list-1');
  demand(roster.ok === true,
    `agentPresets/list did not answer ok: ${JSON.stringify(roster.error ?? roster)}`);
  const presets = roster.value.presets ?? [];
  const defaultRow = presets.find((p) => p.isDefault === true);
  demand(presets.length >= 1, 'the preset roster is empty');
  demand(defaultRow?.id === DEFAULT_PRESET,
    `the default preset is ${JSON.stringify(defaultRow?.id)}`);
  demand(roster.value.authorable === false,
    'the staged fs has no user root: authoring must read as unavailable');
  emit('settings.preset.roster', {
    presets: presets.map((p) => p.id),
    default: defaultRow.id,
    authorable: false,
    healthy: presets.filter((p) => p.broken === undefined).length,
  });

  const read = await awaitRespond('probe/agentPresets-read-1');
  demand(read.ok === true,
    `agentPresets/read did not answer ok: ${JSON.stringify(read.error ?? read)}`);
  const content = read.value?.content;
  demand(typeof content === 'string' && content.length > 0,
    `agentPresets/read answered no composition content: ${JSON.stringify(read.value)?.slice(0, 120)}`);
  emit('settings.preset.read', {
    preset: DEFAULT_PRESET,
    bytes: content.length,
    ok: true,
  });
};

/** copy/deletePreset refuse read-only (no user root); select answers the
 * honest session/not-found for an agent the runtime does not attach. */
const assertAuthoringRefusals = async () => {
  for (const [rpcId, what] of [
    ['probe/agentPresets-copy-1', 'copy'],
    ['probe/agentPresets-delete-1', 'deletePreset'],
  ]) {
    const refused = await awaitRespond(rpcId);
    demand(refused.ok === false && refused.error?.code === 'agent-preset/read-only',
      `agentPresets/${what} must refuse read-only, got ${JSON.stringify(refused)}`);
  }
  emit('settings.preset.copyRefused', {
    code: 'agent-preset/read-only',
    preset: DEFAULT_PRESET,
  });
  const select = await awaitRespond('probe/agentPresets-select-1');
  demand(select.ok === false && select.error?.code === 'session/not-found',
    `agentPresets/select must answer session/not-found, got ${JSON.stringify(select)}`);
  emit('settings.preset.selectRefused', {
    code: select.error.code,
    agent: 's-not-attached',
  });
};

/** The inventory entries' wire-shape demands. */
const assertInventoryShapes = (snapshot) => {
  const everyRowWired = snapshot.entries.every((e) => typeof e.entryId === 'string'
    && typeof e.moduleName === 'string' && typeof e.enabled === 'boolean'
    && e.fiberPhase !== undefined);
  demand(everyRowWired, 'an inventory entry is missing its wire fields');
};

/** The spine/client plane split + the inventory emit. */
const emitPlaneCounts = (snapshot, ctx) => {
  const spineIds = new Set(spineInventory(ctx).map((row) => row.entryId));
  const spineEntries = snapshot.entries.filter((e) => spineIds.has(e.entryId));
  const clientEntries = snapshot.entries.filter((e) => !spineIds.has(e.entryId));
  demand(spineEntries.length === spineIds.size,
    `the inventory spine plane has ${spineEntries.length} rows, the spine mounts ${spineIds.size}`);
  demand(clientEntries.length === STAGED_PLUGINS,
    `the inventory client plane has ${clientEntries.length} rows, the staging delivered ${STAGED_PLUGINS}`);
  demand(clientEntries.some((e) => e.entryId === '@deepseek-ai/dsh-client-ui-settings-plugin-inventory'),
    'the inventory is missing the plugin-inventory client bundle itself');
  emit('settings.plugin.inventory', {
    managementAvailable: false,
    spineEntries: spineEntries.length,
    clientEntries: clientEntries.length,
    presets: snapshot.agentPresets.length,
    presetRows: snapshot.agentPresets.reduce((sum, p) => sum + (p.rows?.length ?? 0), 0),
    spineSample: spineEntries
      .filter((e) => ['agent-loop', 'llm', 'shell-wasm', 'shell-ish'].includes(e.entryId))
      .map((e) => ({ id: e.entryId, enabled: e.enabled, fiberPhase: e.fiberPhase })),
  });
};

/** The manager LIST legs: READ-ONLY rows over the same snapshot — the
 * wire's own `readOnlyReason: 'management-required'` disposition. The
 * write legs stay unclaimed (fail loud when the page ever calls one). */
const probeManagerLegs = async () => {
  const manager = await awaitRespond('probe/pluginManager-listBundles-1');
  demand(manager.ok === true,
    `pluginManager/listBundles did not answer ok: ${JSON.stringify(manager.error ?? manager)}`);
  const bundles = manager.value ?? [];
  demand(bundles.length >= 1 && bundles.every((b) => b.readOnlyReason === 'management-required'
    && Array.isArray(b.rows) && b.rows.length > 0 && b.removable === false),
    `the read-only bundles are misshaped: ${JSON.stringify(bundles).slice(0, 160)}`);
  const plugins = await awaitRespond('probe/pluginManager-listPlugins-1');
  demand(plugins.ok === true,
    `pluginManager/listPlugins did not answer ok: ${JSON.stringify(plugins.error ?? plugins)}`);
  const pluginRows = plugins.value ?? [];
  demand(pluginRows.length > 0 && pluginRows.every((r) => r.readOnlyReason === 'management-required'
    && r.patchId === undefined),
    'the read-only plugin rows must carry readOnlyReason and no patchId');
  emit('settings.pluginManager.readonly', {
    bundles: bundles.length,
    bundleRows: bundles.reduce((sum, b) => sum + b.rows.length, 0),
    plugins: pluginRows.length,
    readOnlyReason: 'management-required',
  });
};

/** The 插件 inventory + manager-legs probes. */
const probePlugins = async (ctx) => {
  const inventory = await awaitRespond('probe/pluginInventory-list-1');
  demand(inventory.ok === true,
    `pluginInventory/list did not answer ok: ${JSON.stringify(inventory.error ?? inventory)}`);
  const snapshot = inventory.value;
  demand(snapshot.managementAvailable === false,
    'the plugin inventory must be a read-only snapshot (managementAvailable false)');
  demand(Array.isArray(snapshot.entries) && snapshot.entries.length > 0,
    'the plugin inventory answered no entries');
  demand(Array.isArray(snapshot.agentPresets) && snapshot.agentPresets.length > 0,
    'the plugin inventory answered no agentPresets plane');
  assertInventoryShapes(snapshot);
  emitPlaneCounts(snapshot, ctx);
  await probeManagerLegs();
};

/** The settings-surface probes, driven at the same wire boundary the page
 * uses (synthesized api.request frames answered by the resident runtime). */
const probePhase = async (ctx) => {
  log.debug('probe phase begin', {});
  for (const probe of PROBES) {
    busHandler({ type: 'api.request', rpcId: probe.rpcId, endpoint: probe.endpoint,
      payload: { args: probe.args } });
  }
  await probePresets();
  await assertAuthoringRefusals();
  await probePlugins(ctx);
  log.debug('probe phase done', {});
};

const main = async () => {
  log.debug('main begin', {});
  const env = launchEnv();
  demand(typeof env.DSH_SETTINGS_LLM_BASEURL === 'string',
    'DSH_SETTINGS_LLM_BASEURL missing from the launch env (the runner pins it)');

  const ctx = await bootPhase(env);
  mountBusPhase(ctx);
  assertClaimsPhase();
  await probePhase(ctx);

  emit('settings.surfaces/completed', {
    status: 'pass',
    upstream: '0.1.6-alpha.2',
    surfaces: 'the official client 预设 roster + 插件 inventory over the real spine',
  });
  globalThis.__dshComplete(true, 'pass');
};

main().catch(fail);
