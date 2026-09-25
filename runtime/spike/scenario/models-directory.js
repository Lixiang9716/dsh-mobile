// dsh:logging-exempt (probe: its verdict output IS the product)
/** models-directory.js — the CLI proof for the official client's models
 * 设置页 (scenario `models.directory`): the provider directory row, the
 * settings mirror it renders from, the page's own write path into the user
 * layer, and the credential round-trip — answered at the same wire boundary
 * the page uses (the write surface with `fullCoverage: true`, so the llm
 * directory and the credential write half are claimed exactly as the
 * coverage plane claims them on device).
 *
 * Flow: upstream/boot.js composes the mobile profile with the vendored
 * LlmRuntime directory (the boot registered exactly the route provider —
 * the e230ce1 fix), the write surface answers:
 *
 *   llm/listProviders             → the single route provider
 *   llm/listConfigurableProviders → the DECLARED row (provider, settingsNs
 *                                   llm-<provider>, settingsPath
 *                                   providers/default) — the row the page
 *                                   renders
 *   settings/canOpenAgentPresetDirectory → false (read-only page on this host)
 *   settings/describe             → the llm-mock namespace with the STAGED
 *                                   ROUTE as its base layer, user layer free
 *   settings/mutate               → a page write lands in the user layer
 *                                   over the intact base, revision +1
 *   credentials/describe|set|unset → the round-trip; values never come back
 *                                   over the wire
 *   session/modelCatalog          → the staged single-route catalog
 *
 * No LLM turn is driven: the models page is configuration surface, so the
 * llm route is a never-dialed loopback placeholder.
 *
 * Every expected event is declared one-to-one in
 * test/e2e/scenarios/models-directory.json; artifacts land under
 * runtime/spike/artifacts/macos-cli-models-directory/.
 */
import { createLogger } from 'logger.js';
import { bootUpstream } from 'upstream/boot.js';
import { createWriteSurface } from 'upstream/web-write.js';

const SCENARIO = 'models.directory';
const log = createLogger(SCENARIO);
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const ROOT = '/models-ws';
const SESSION_ID = 's-models-dir';
const BASE_URL = 'http://127.0.0.1:1/v1';
const STAGED_KEY = 'staged-model-key';
let verdict = false;
const fail = (reason) => {
  log.error('probe failed', { reason });
  if (!verdict) { verdict = true; globalThis.__dshComplete(false, reason); }
  throw new Error(reason);
};
const demand = (ok, why) => { if (!ok) fail(why + ' @ ' + (new Error().stack ?? '').slice(0, 300)); };

/** Assert `value` deep-matches the {subset} members (shape asserts stay
 * readable; extra wire members are fine). */
const like = (value, subset, why) => {
  for (const [key, want] of Object.entries(subset)) {
    const got = value?.[key];
    demand(JSON.stringify(got) === JSON.stringify(want),
      `${why}: .${key} = ${JSON.stringify(got)} != ${JSON.stringify(want)}`);
  }
};

/** Boot the mobile profile with the route provider staged. */
const boot = async () => {
  const { ctx } = await bootUpstream({
    scenario: SCENARIO, agentId: 'models', sessionId: SESSION_ID,
    cwd: ROOT, onEvent: () => {},
    container: { cwd: ROOT, tmpdir: `${ROOT}/.tmp`, home: `${ROOT}/home`,
      env: {}, argv: ['dsh', '--profile', 'mobile'] },
    systemPrompt: { personaPrefix: '' },
    llm: { baseURL: BASE_URL, apiKey: STAGED_KEY, provider: 'mock',
      model: 'probe-1', onRequestBody: () => {} },
  });
  let guard = 0;
  while ((ctx.agents.get(SESSION_ID) === undefined || ctx.sessions.get(SESSION_ID) === undefined)
    && guard++ < 10000) await Promise.resolve();
  demand(ctx.agents.get(SESSION_ID) !== undefined, 'the configured agent never appeared');
  return ctx;
};

/** The directory legs: the route provider, its DECLARED configurable row,
 * and the page's read-only preset gate. */
const directoryPhase = async (api) => {
  const providers = await api['llm/listProviders']({});
  demand(Array.isArray(providers) && providers.length === 1
    && providers[0].id === 'mock' && typeof providers[0].name === 'string'
    && providers[0].name.length > 0,
    `listProviders: ${JSON.stringify(providers)}`);
  const directory = await api['llm/listConfigurableProviders']({});
  demand(Array.isArray(directory) && directory.length === 1
    && directory[0].provider === 'mock' && directory[0].settingsNs === 'llm-mock'
    && JSON.stringify(directory[0].settingsPath) === '["providers","default"]',
    `listConfigurableProviders: ${JSON.stringify(directory)}`);
  const canOpen = await api['settings/canOpenAgentPresetDirectory']({});
  demand(canOpen === false, `canOpenAgentPresetDirectory: ${JSON.stringify(canOpen)}`);
  emit('models.directory', {
    providers: providers.length, provider: 'mock',
    settingsNs: directory[0].settingsNs, settingsPath: directory[0].settingsPath,
    canOpenPresetDirectory: canOpen,
  });
  return directory;
};

/** The mirror legs: the namespace the page renders from, registered with
 * the STAGED ROUTE as its base layer and a free user layer; then the page's
 * own write landing in the user layer over the intact base. */
const mirrorPhase = async (api) => {
  const described = await api['settings/describe']({});
  demand(described.writable === true && described.hasDocument === false,
    `describe wrapper: ${JSON.stringify({ w: described.writable, d: described.hasDocument })}`);
  const ns = described.namespaces.find((n) => n.ns === 'llm-mock');
  demand(ns !== undefined,
    `llm-mock namespace missing: ${JSON.stringify(described.namespaces.map((n) => n.ns))}`);
  like(ns.base, { providers: { default: {
    baseURL: BASE_URL, model: 'probe-1', apiKeyEnv: 'MOCK_API_KEY' } } },
  'mirror base layer');
  demand(ns.user === undefined, `user layer starts free: ${JSON.stringify(ns.user)}`);
  demand(typeof ns.revision === 'number', 'namespace revision');
  emit('models.mirror', {
    ns: ns.ns, writable: described.writable, hasDocument: described.hasDocument,
    baseModel: ns.base.providers.default.model,
    baseKeyEnv: ns.base.providers.default.apiKeyEnv,
    userLayer: false, revision: ns.revision,
  });

  const written = await api['settings/mutate']({
    ns: 'llm-mock',
    ops: [{ op: 'set', path: ['providers', 'default', 'model'], value: 'probe-2' }],
  });
  demand(written.ns === 'llm-mock' && written.revision === ns.revision + 1,
    `mutate revision: ${JSON.stringify({ r: written.revision, want: ns.revision + 1 })}`);
  demand(written.user?.providers?.default?.model === 'probe-2',
    `user layer write: ${JSON.stringify(written.user)}`);
  demand(written.base?.providers?.default?.model === 'probe-1',
    `base intact: ${JSON.stringify(written.base)}`);
  demand(written.value?.providers?.default?.model === 'probe-2',
    `merged view: ${JSON.stringify(written.value)}`);
  emit('models.mirror.write', {
    ns: written.ns, op: 'set providers/default/model',
    userWins: true, baseIntact: true, revision: written.revision,
  });
  return ns;
};

/** The credential round-trip behind the row's 已配置 state: set → describe →
 * unset → describe, the values never coming back over the wire. */
const credentialsPhase = async (api) => {
  const refs = ['MOCK_API_KEY', 'OTHER_API_KEY'];
  const before = await api['credentials/describe']({ refs });
  demand(before.MOCK_API_KEY.configured === true
    && before.MOCK_API_KEY.writable === true
    && before.OTHER_API_KEY.configured === false,
    `describe before set: ${JSON.stringify(before)}`);
  await api['credentials/set']({ ref: 'OTHER_API_KEY', value: 'sekrit-page-key' });
  const after = await api['credentials/describe']({ refs });
  demand(after.OTHER_API_KEY.configured === true
    && after.OTHER_API_KEY.source === undefined
    && after.MOCK_API_KEY.configured === true,
    `describe after set: ${JSON.stringify(after)}`);
  await api['credentials/unset']({ ref: 'OTHER_API_KEY' });
  const removed = await api['credentials/describe']({ refs });
  demand(removed.OTHER_API_KEY.configured === false,
    `describe after unset: ${JSON.stringify(removed)}`);
  emit('models.credentials', {
    route: 'configured', roundtrip: 'set→describe→unset→describe',
    leaked: false,
  });
};

/** The model catalog the page's model picker reads: the staged single-route
 * facts, nothing invented. */
const catalogPhase = async (api) => {
  const catalog = await api['session/modelCatalog']({});
  like(catalog, { default: { provider: 'mock', model: 'probe-1' },
    routableProviders: ['mock'] }, 'catalog route');
  demand(catalog.groups.length === 1 && catalog.groups[0].models.length === 1
    && catalog.groups[0].models[0].id === 'probe-1',
    `catalog groups: ${JSON.stringify(catalog.groups)}`);
  emit('models.catalog', { default: 'mock/probe-1', groups: 1 });
};

/** Main: boot → surface → phases → complete. */
try {
  const ctx = await boot();
  const { api } = createWriteSurface(ctx, () => {}, {
    root: ROOT, provider: 'mock', model: 'probe-1', baseURL: BASE_URL,
    spine: () => [], stagedPlugins: () => [], fullCoverage: true,
  });
  await directoryPhase(api);
  await mirrorPhase(api);
  await credentialsPhase(api);
  await catalogPhase(api);
  emit('models.directory/completed', {
    status: 'pass', upstream: '0.1.6-alpha.2',
    surface: 'the official models 设置页: directory row + settings mirror + page write + credential roundtrip',
  });
  if (!verdict) { verdict = true; globalThis.__dshComplete(true, 'models directory verified'); }
} catch (e) {
  fail((e?.message ?? String(e)) + ' @ ' + (e?.stack ?? '').slice(0, 300)
    + ' | code=' + (e?.code ?? '-'));
}
