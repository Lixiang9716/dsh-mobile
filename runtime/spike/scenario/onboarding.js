// dsh:logging-exempt (probe: its verdict output IS the product)
/** onboarding.js — the CLI proof for the BYOK first-run panel (scenario
 * `onboarding.flow`): the no-credential detect, the connection test's two
 * paths over the REAL gateway transport (one minimal chat-completions
 * against the vendored mock LLM server — the scripted success and the 401
 * auth leg), the keychain save, the 已配过 re-detect, the models 设置页
 * directory following the live route (the B29 round: the byok row replaces
 * the boot row on save), the RELAUNCH route resolution (boot #2 reads the
 * keychain through the same resolver composer-web-live boots with), the
 * FIRST TURN over the rebound route through the page's own wire
 * (session/create → session/prompt → the assistant text the mock server
 * scripts), and the CLEAR leg — onboarding/clear deletes the keychain ref
 * and restores the boot route LIVE (the second turn answers from the mock
 * adapter again, no relaunch).
 *
 * Everything rides the write surface exactly as the page drives it
 * (fullCoverage: true — the onboarding legs are coverage rows). The key
 * values are never emitted: the mock key and the wrong-key probe value
 * appear nowhere in the raw log (the runner greps for both).
 *
 * Every expected event is declared one-to-one in
 * test/e2e/scenarios/onboarding-flow.json; artifacts land under
 * runtime/spike/artifacts/macos-cli-onboarding/.
 */
import { createLogger } from 'logger.js';
import { bootUpstream } from 'upstream/boot.js';
import { createWriteSurface } from 'upstream/web-write.js';
import { resolveLlmRoute, bootRouteOf, registerBootRouteFactory } from 'upstream/llm-route.js';
import { keychainGet } from 'gateway.js';

const SCENARIO = 'onboarding.flow';
const log = createLogger(SCENARIO);
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const ROOT = '/onboarding-ws';
const WRONG_KEY = 'byok-wrong-key-0000';
let verdict = false;
const fail = (reason) => {
  log.error('probe failed', { reason });
  if (!verdict) { verdict = true; globalThis.__dshComplete(false, reason); }
  throw new Error(reason);
};
const demand = (ok, why) => { if (!ok) fail(why + ' @ ' + (new Error().stack ?? '').slice(0, 300)); };

/** The launch env snapshot (--env KEY=VALUE on the CLI) — the mock endpoint
 * facts ride the same channel upstream process.env would. */
const launchEnv = () => {
  const raw = globalThis.__dshLaunchEnv?.();
  demand(typeof raw === 'string', 'launch env snapshot missing (CLI must pass --env)');
  return JSON.parse(raw);
};
const ENV = launchEnv();
const MOCK_URL = ENV.DSH_MOCK_LLM_URL;
const MOCK_KEY = ENV.DSH_MOCK_LLM_KEY;
const BYOK_CREDENTIAL = {
  provider: 'deepseek',
  baseURL: MOCK_URL,
  apiKey: MOCK_KEY,
  model: 'mock-1',
};

const like = (value, subset, why) => {
  for (const [key, want] of Object.entries(subset)) {
    demand(JSON.stringify(value?.[key]) === JSON.stringify(want),
      `${why}: .${key} = ${JSON.stringify(value?.[key])} != ${JSON.stringify(want)}`);
  }
};

/** Boot the mobile profile with the mock route — the shape a beta user's
 * first launch delivers (the carrier's scripted loopback endpoint when no
 * credential is staged, provider 'mock'). */
const boot = async () => {
  const { ctx } = await bootUpstream({
    scenario: SCENARIO, agentId: 'onb', sessionId: 's-onboarding-boot',
    cwd: ROOT, onEvent: () => {},
    container: { cwd: ROOT, tmpdir: `${ROOT}/.tmp`, home: `${ROOT}/home`,
      env: {}, argv: ['dsh', '--profile', 'mobile'] },
    systemPrompt: { personaPrefix: '' },
    llm: { baseURL: MOCK_URL, apiKey: MOCK_KEY, provider: 'mock', model: 'mock-1' },
  });
  let guard = 0;
  while ((ctx.agents.get('s-onboarding-boot') === undefined) && guard++ < 10000) {
    await Promise.resolve();
  }
  demand(ctx.agents.get('s-onboarding-boot') !== undefined, 'the boot agent never appeared');
  return ctx;
};

/** The surface's frame plumbing: one capturing post. A probe's terminal
 * frame is observed by POLLING with settle-yield waits (rule 8's condition
 * poll, bounded below) — each yield is one settling gateway call, the
 * resume path every boot already proves, never a blind sleep. */
const makeFrameHub = () => {
  const frames = [];
  return {
    frames,
    post: (frame) => { frames.push(frame); },
  };
};

/** The boot route facts the onboarding panel reads: 无凭证 → mock. */
const detectPhase = async (api) => {
  const status = await api['onboarding/status']({});
  like(status, { mode: 'mock', provider: 'mock' }, 'status before any credential');
  emit('onboarding.detect', { mode: status.mode, provider: status.provider });
};

/** The connection test's two paths against the vendored mock LLM server:
 * the scripted success (streamed to done) and the 401 auth leg (one
 * readable wire error). Both ride the REAL gateway httpFetch transport. */
const probePhase = (surface, hub) => Promise.resolve()
  .then(() => runProbe(surface, hub, 's-onb-good', BYOK_CREDENTIAL))
  .then((good) => {
    demand(good.done?.kind === 'probe.done' && good.done.chars > 0,
      `the success probe never completed: ${JSON.stringify(good)}`);
    emit('onboarding.probe.open', { status: good.open?.status });
    emit('onboarding.probe.passed', { chars: good.done.chars, deltas: good.done.deltas });
    return runProbe(surface, hub, 's-onb-bad', { ...BYOK_CREDENTIAL, apiKey: WRONG_KEY });
  })
  .then((bad) => {
    demand(bad.error !== undefined, 'the wrong-key probe unexpectedly passed');
    demand(/status 401/.test(bad.error.message ?? ''),
      `the auth error is not the mock's 401: ${JSON.stringify(bad.error)}`);
    emit('onboarding.probe.failed', { code: bad.error.code, httpStatus: 401 });
  });

/** One settling gateway call — the poll's yield. The keychain read is the
 * cheapest leg every host serves (null on the unset ref), and it rides the
 * same settle path the boot's route resolution proves. */
const settleYield = async () => { await keychainGet('dsh.onboarding/poll'); };

/** One probe through the surface's stream open leg; resolves at the
 * stream's terminal frame (bounded, fail loud). */
const runProbe = async (surface, hub, streamId, args) => {
  surface.openStream({
    endpoint: 'onboarding/test', streamId, payload: { args },
  });
  const mine = () => hub.frames.filter((f) => f.streamId === streamId);
  for (let guard = 0; guard < 400; guard++) {
    // The surface posts RAW mux.* frames (the page's WS layer normalizes
    // them to item/error/end; the scenario consumes the raw shapes).
    const error = mine().find((f) => f.type === 'mux.error');
    if (error !== undefined) return { error };
    const end = mine().find((f) => f.type === 'mux.end');
    if (end !== undefined) {
      return {
        open: mine().find((f) => f.type === 'mux.item' && f.value?.kind === 'probe.open')?.value,
        done: mine().find((f) => f.type === 'mux.item' && f.value?.kind === 'probe.done')?.value,
      };
    }
    await settleYield();
  }
  fail(`probe stream ${streamId} never ended`);
};

/** The save: keychain persist + live rebind + route mutation. The status
 * answer afterwards carries NO credential material. */
const savePhase = async (api) => {
  // Unary handlers take payload.args directly (the deliverApiRequest
  // unwrap); the page's rpc wraps {args: draft} on the wire.
  await api['onboarding/save'](BYOK_CREDENTIAL);
  const status = await api['onboarding/status']({});
  like(status, { mode: 'byok', provider: 'deepseek', baseURL: MOCK_URL, model: 'mock-1' },
    'status after save');
  demand(JSON.stringify(status).includes(MOCK_KEY) === false,
    'the status answer leaked the key');
  emit('onboarding.saved', { mode: status.mode, provider: status.provider });
  emit('onboarding.detect.after', { mode: status.mode, configured: true });
};

/** The models 设置页 directory follows the live route (the B29 round): the
 * DECLARED row is the byok provider after a save (settingsNs llm-deepseek,
 * the row the page renders), and the settings mirror gained the matching
 * namespace with the byok facts as its base layer — never the key. */
const directoryByokPhase = async (api) => {
  const directory = await api['llm/listConfigurableProviders']({});
  demand(Array.isArray(directory) && directory.length === 1
    && directory[0].provider === 'deepseek' && directory[0].settingsNs === 'llm-deepseek'
    && JSON.stringify(directory[0].settingsPath) === '["providers","default"]',
    `directory after save: ${JSON.stringify(directory)}`);
  const described = await api['settings/describe']({});
  const ns = described.namespaces.find((n) => n.ns === 'llm-deepseek');
  demand(ns !== undefined,
    `llm-deepseek namespace missing: ${JSON.stringify(described.namespaces.map((n) => n.ns))}`);
  demand(ns.base?.providers?.default?.baseURL === MOCK_URL
    && ns.base?.providers?.default?.model === 'mock-1'
    && ns.base?.providers?.default?.apiKeyEnv === 'DEEPSEEK_API_KEY',
    `byok mirror base: ${JSON.stringify(ns.base)}`);
  demand(JSON.stringify(ns).includes(MOCK_KEY) === false,
    'the namespace mirror leaked the key');
  emit('onboarding.directory.byok', {
    provider: directory[0].provider, settingsNs: directory[0].settingsNs,
  });
};

/** Boot #2: the route resolver composer-web-live boots with, against the
 * runtime.config a RELAUNCH delivers (no staged credential — the keychain
 * is the only source). The byok route must win, still never naming the key. */
const relaunchPhase = async () => {
  const route = await resolveLlmRoute({ mockLlmUrl: MOCK_URL, apiKey: MOCK_KEY });
  like(route, { kind: 'byok', scripted: false, userEndpoint: true, provider: 'deepseek' },
    'relaunch route');
  // The route object legitimately carries apiKey (it IS the boot input, the
  // staged route's shape); what must never leak is the emitted-LABEL surface.
  demand(route.adapterName.includes(MOCK_KEY) === false
    && route.transportLabel.includes(MOCK_KEY) === false,
    'the route labels leaked the key');
  emit('onboarding.relaunch.route', {
    kind: route.kind, scripted: route.scripted, provider: route.provider,
    model: route.model,
  });
};

/** The FIRST TURN on the rebound route, through the page's own wire: create
 * (the mutated route binds the new session to the byok provider) → prompt →
 * the scripted assistant text. Returns the sessionId. */
const runTurn = async (ctx, api, requestId) => {
  const created = await api['session/create']({ request: {} });
  const sessionId = created?.sessionId;
  demand(typeof sessionId === 'string' && sessionId.length > 0, 'no session minted');
  await api['session/prompt']({ request: {
    sessionId, requestId, mode: 'queue',
    content: [{ type: 'text', text: 'ping' }],
  } });
  let guard = 0;
  while (ctx.agents.get(sessionId) === undefined && guard++ < 10000) await Promise.resolve();
  const agent = ctx.agents.get(sessionId);
  demand(agent !== undefined, 'the onboarding session agent never appeared');
  await agent.whenIdle();
  const events = ctx.sessions.get(sessionId).snapshotEvents();
  const assistant = events.find((record) => record.type === 'assistant/message');
  demand(assistant !== undefined, 'no assistant/message in the onboarding session log');
  const text = assistant.data?.message?.content
    ?.filter((block) => block.type === 'text').map((block) => block.text).join('') ?? '';
  demand(text === 'Hello from upstream', `the turn answered "${text}"`);
  return sessionId;
};

const firstTurnPhase = async (ctx, api) => {
  const sessionId = await runTurn(ctx, api, 'onb-turn-1');
  emit('onboarding.first.turn', { sessionId: sessionId.slice(0, 8), text: 'Hello from upstream', provider: 'deepseek' });
};

/** The CLEAR leg (the B29 round): onboarding/clear takes NO arguments — the
 * runtime deletes the keychain ref and restores the boot route LIVE. The
 * status answers mock again, the directory row swaps back to the boot
 * provider, and a SECOND TURN answers from the restored mock adapter with
 * no relaunch. */
const clearPhase = async (ctx, api) => {
  await api['onboarding/clear']({});
  const status = await api['onboarding/status']({});
  like(status, { mode: 'mock', provider: 'mock' }, 'status after clear');
  const directory = await api['llm/listConfigurableProviders']({});
  demand(Array.isArray(directory) && directory.length === 1
    && directory[0].provider === 'mock' && directory[0].settingsNs === 'llm-mock',
    `directory after clear: ${JSON.stringify(directory)}`);
  emit('onboarding.clear', { mode: status.mode, provider: status.provider });
  emit('onboarding.directory.restored', {
    provider: directory[0].provider, settingsNs: directory[0].settingsNs,
  });
  const sessionId = await runTurn(ctx, api, 'onb-turn-2');
  emit('onboarding.second.turn', {
    sessionId: sessionId.slice(0, 8), text: 'Hello from upstream', provider: 'mock',
  });
};

/** Main: boot → detect → probes (two paths) → save → directory follows →
 * relaunch route → first turn → clear (live restore) → second turn →
 * complete. */
try {
  demand(typeof MOCK_URL === 'string' && MOCK_URL.startsWith('http://127.0.0.1:'),
    'DSH_MOCK_LLM_URL must be the runner\'s loopback mock');
  const ctx = await boot();
  // The unbind seam's factory: the boot route re-derived from this boot's
  // runtime.config (composer-web-live registers the same shape).
  registerBootRouteFactory(ctx, () => bootRouteOf({
    mockLlmUrl: MOCK_URL, apiKey: MOCK_KEY,
  }));
  const hub = makeFrameHub();
  const surface = createWriteSurface(ctx, hub.post, {
    root: ROOT, provider: 'mock', model: 'mock-1', baseURL: MOCK_URL,
    routeKind: 'mock',
    spine: () => [], stagedPlugins: () => [], fullCoverage: true,
  });
  const { api, dispose } = surface;
  await detectPhase(api);
  await probePhase(surface, hub);
  await savePhase(api);
  await directoryByokPhase(api);
  await relaunchPhase();
  await firstTurnPhase(ctx, api);
  await clearPhase(ctx, api);
  dispose?.();
  emit('onboarding.flow/completed', {
    status: 'pass',
    surface: 'BYOK onboarding: detect → test (success+401) → keychain save → directory follows → relaunch route → first turn → clear (live restore) → second turn',
  });
  if (!verdict) { verdict = true; globalThis.__dshComplete(true, 'onboarding flow verified'); }
} catch (e) {
  fail((e?.message ?? String(e)) + ' @ ' + (e?.stack ?? '').slice(0, 300)
    + ' | code=' + (e?.code ?? '-'));
}
