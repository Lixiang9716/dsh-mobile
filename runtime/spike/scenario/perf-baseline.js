/**
 * perf.baseline — the performance MEASUREMENT leg (A1): one full
 * cold boot + mock session turn + signed-catalog install on the CLI host,
 * every number emitted into THIS scenario's event stream (D8 — no side
 * channel), then extracted by the runner into the receipt and re-recorded
 * into baselines/perf-baseline.json by hand (the baseline documents a real
 * run; the trend gate audits the receipt against it).
 *
 * What each number is (and is not):
 *   bootMs          eval start → bootUpstream's agent registered. This is the
 *                   in-runtime boot cost; the PROCESS cold start (spawn →
 *                   PASS) is the runner's shell-side measurement, receipt-only
 *                   (it must never enter the deterministic log).
 *   turnMs          session/create → session/prompt → whenIdle — one scripted
 *                   mock-LLM turn over the page's own wire (onboarding.flow's
 *                   first-turn shape).
 *   refreshMs       the catalog resolver's fetch + ed25519 verify (9 entries).
 *   installMs       installFromFetch over the signed entry: fetch → extract →
 *                   verify → commit. The trust passthrough is asserted here
 *                   (receipt.blobSha256 === entry.blobSha256) but the trust
 *                   ladder itself stays marketplace.install's job — this leg
 *                   measures, it does not re-prove.
 *
 * Numbers are machine-local and jittery BY NATURE: the one-to-one manifest
 * pins the events and their stable fields only, never a measured value.
 * The heap face used by the companion leak.canary leg is the host-side
 * __dshPerfProbe test hook (spike host global, NOT a gateway primitive —
 * it never enters a descriptor or the contract/ freeze).
 */
import { createLogger } from 'logger.js';
import { httpFetch } from 'gateway.js';
import { bootUpstream } from 'upstream/boot.js';
import { createWriteSurface } from 'upstream/web-write.js';
import { createResolver } from 'marketplace.js';
import { ed25519SelfTest } from 'ed25519.js';

const SCENARIO = 'perf.baseline';
const log = createLogger(SCENARIO);
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  log.debug('scenario failed', { reason });
  emit('perf.baseline.failed', { reason });
  globalThis.__dshComplete(false, reason);
};
const demand = (cond, reason) => {
  if (cond) return;
  log.debug('demand failed', { reason });
  fail(reason);
  throw new Error(reason);
};

/** The cold-boot clock's origin is the first eval line: module resolution,
 * imports, and every boot step after it are all inside bootMs. */
const T0 = Date.now();

const ROOT = '/perf-ws';
const rawEnv = globalThis.__dshLaunchEnv?.();
demand(typeof rawEnv === 'string', 'launch env snapshot missing (CLI must pass --env)');
const ENV = JSON.parse(rawEnv);
const MOCK_URL = ENV.DSH_MOCK_LLM_URL;
demand(typeof MOCK_URL === 'string' && MOCK_URL.startsWith('http://127.0.0.1:'),
  `mock LLM endpoint missing from the launch env: ${JSON.stringify(MOCK_URL)}`);
const MARKET_URL = ENV.DSH_MARKET_URL;
demand(typeof MARKET_URL === 'string' && MARKET_URL.startsWith('http://127.0.0.1:'),
  `market endpoint missing from the launch env: ${JSON.stringify(MARKET_URL)}`);
const PINNED_KEYS = { 'dsh-market-1': 'yHFYEqEja90V51eEaopnHEQ1onn/aUVbiMuEMx8As5w=' };
const ENTRY_SPEC = 'dsh-fs@^0.1.0';

/** Phase 1 — COLD BOOT: the mobile profile over the mock route (the
 * onboarding.flow boot shape). bootMs covers eval start → agent registered. */
const bootPhase = async () => {
  log.debug('boot phase begin');
  const { ctx } = await bootUpstream({
    scenario: SCENARIO, agentId: 'perf', sessionId: 's-perf-boot',
    cwd: ROOT, onEvent: () => {},
    container: { cwd: ROOT, tmpdir: `${ROOT}/.tmp`, home: `${ROOT}/home`,
      env: {}, argv: ['dsh', '--profile', 'mobile'] },
    systemPrompt: { personaPrefix: '' },
    llm: { baseURL: MOCK_URL, apiKey: ENV.DSH_MOCK_LLM_KEY, provider: 'mock', model: 'mock-1' },
  });
  let guard = 0;
  while ((ctx.agents.get('s-perf-boot') === undefined) && guard++ < 10000) {
    await Promise.resolve();
  }
  demand(ctx.agents.get('s-perf-boot') !== undefined, 'the boot agent never appeared');
  const bootMs = Date.now() - T0;
  emit('perf.cold.boot', { bootMs, profile: 'mobile', provider: 'mock' });
  return ctx;
};

/** Phase 2 — ONE MOCK SESSION TURN over the page's own wire: create →
 * prompt → whenIdle → the scripted assistant text (session-write face). */
const turnPhase = async (ctx) => {
  log.debug('turn phase begin');
  const surface = createWriteSurface(ctx, () => {}, {
    root: ROOT, provider: 'mock', model: 'mock-1', baseURL: MOCK_URL,
    routeKind: 'mock',
    spine: () => [], stagedPlugins: () => [], fullCoverage: true,
  });
  const { api, dispose } = surface;
  const tCreate = Date.now();
  const created = await api['session/create']({ request: {} });
  const sessionId = created?.sessionId;
  demand(typeof sessionId === 'string' && sessionId.length > 0, 'no session minted');
  await api['session/prompt']({ request: {
    sessionId, requestId: 'perf-turn-1', mode: 'queue',
    content: [{ type: 'text', text: 'ping' }],
  } });
  let guard = 0;
  while (ctx.agents.get(sessionId) === undefined && guard++ < 10000) await Promise.resolve();
  const agent = ctx.agents.get(sessionId);
  demand(agent !== undefined, 'the session agent never appeared');
  await agent.whenIdle();
  const events = ctx.sessions.get(sessionId).snapshotEvents();
  const assistant = events.find((record) => record.type === 'assistant/message');
  demand(assistant !== undefined, 'no assistant/message in the session log');
  const text = assistant.data?.message?.content
    ?.filter((block) => block.type === 'text').map((block) => block.text).join('') ?? '';
  demand(text === 'Hello from upstream', `the turn answered "${text}"`);
  dispose?.();
  const turnMs = Date.now() - tCreate;
  emit('perf.session.turn', { turnMs, textLen: text.length, sessionIdPrefix: sessionId.slice(0, 8) });
};

/** Phase 3 — SIGNED-CATALOG INSTALL: refresh (fetch + ed25519 verify) and
 * install (fetch → extract → verify → commit), each timed. The resolver's
 * own lifecycle events stay silent here (marketplace.install owns their
 * one-to-one audit); this leg carries only the numbers. */
const installPhase = async () => {
  log.debug('install phase begin');
  demand(ed25519SelfTest(), 'ed25519 self-test (RFC 8032 vectors) failed');
  const resolver = createResolver({
    fetchImpl: (url) => httpFetch(url, { method: 'GET' }),
    indexUrl: `${MARKET_URL}/index.json`,
    pinnedKeys: PINNED_KEYS,
  });
  const tRefresh = Date.now();
  const index = await resolver.refresh();
  demand(index.entries.length === 9, 'catalog entry count drifted');
  const refreshMs = Date.now() - tRefresh;
  emit('perf.catalog.refresh', { refreshMs, entries: 9, key: 'dsh-market-1' });
  const entry = resolver.lookup(ENTRY_SPEC);
  const tInstall = Date.now();
  const result = await resolver.install({ spec: ENTRY_SPEC, txId: 'perf-c001' });
  const installMs = Date.now() - tInstall;
  demand(result.receipt.status === 'committed' && result.receipt.id === entry.id,
    'receipt drifted');
  demand(result.receipt.blobSha256 === entry.blobSha256, 'trust record did not pass through');
  emit('perf.install.commit', {
    installMs, spec: ENTRY_SPEC, version: entry.version,
    blobSha256: entry.blobSha256, trustMatched: true,
  });
};

const main = async () => {
  log.debug('main begin');
  demand(typeof globalThis.__dshGatewayNegotiate === 'function'
    && globalThis.__dshGatewayNegotiate('gateway@1'), 'gateway negotiation failed');
  emit('perf.baseline.begin', { legs: 3, host: 'macos-cli' });
  const ctx = await bootPhase();
  await turnPhase(ctx);
  await installPhase();
  emit('perf.baseline.completed', { status: 'pass', legs: 3, wallMs: Date.now() - T0 });
  globalThis.__dshComplete(true, 'ok');
};

await main().catch((err) => fail(`uncaught: ${err?.message ?? err}`));
