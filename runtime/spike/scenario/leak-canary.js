/**
 * leak.canary — the leak CANARY leg (A2): N mock session rounds against the
 * scripted loopback LLM, the engine heap watermark read BEFORE and AFTER a
 * FORCED collection, red when the post-GC watermark does not fall back.
 *
 * The reading face is the spike host's __dshPerfProbe C hook (TEST
 * INFRASTRUCTURE — a host global like __dshComplete, never a gateway
 * primitive, never in a descriptor or the contract/ freeze): 'gc' runs
 * JS_RunGC over the runtime and then reads JS_ComputeMemoryUsage. Both
 * watermarks are gc-mode readings — the baseline is collected too, so the
 * comparison is collected-vs-collected (comparing an uncollected boot heap
 * against a collected one would measure collection itself, not leakage).
 *
 * What growth is EXPECTED (and therefore in the tolerance, not a leak): the
 * upstream spine keeps session records resident by design (ctx.sessions /
 * ctx.agents are lifetime maps — a session's log outlives its turn), and
 * engine-side atom/shape tables ratchet. What the canary catches is the
 * ENGINE leak class (the quickjs GC leak the decision-matrix wave fixed and
 * re-pinned): per-turn churn (JSON bodies, stream buffers, promise chains)
 * that a full collection cannot reclaim. LEAK_TOLERANCE_BYTES therefore
 * sits far above the measured natural growth of 100 healthy rounds — the
 * real number lives in baselines/perf-baseline.json and the receipt; the
 * falsification proof (a deliberately retained array per round trips this
 * leg red) is in the perf-baseline Agent Note.
 */
import { createLogger } from 'logger.js';
import { bootUpstream } from 'upstream/boot.js';
import { createWriteSurface } from 'upstream/web-write.js';

const SCENARIO = 'leak.canary';
const log = createLogger(SCENARIO);
const emit = (event, fields = {}) => log.info('e2e', { scenario: SCENARIO, event, ...fields });
const fail = (reason) => {
  log.debug('scenario failed', { reason });
  emit('leak.canary.failed', { reason });
  globalThis.__dshComplete(false, reason);
};
const demand = (cond, reason) => {
  if (cond) return;
  log.debug('demand failed', { reason });
  fail(reason);
  throw new Error(reason);
};

const ROOT = '/leak-ws';
const ROUNDS = 100;
const PROGRESS_EVERY = 25;
/** MEASURED, then padded (never guessed): 100 healthy rounds grew the
 * post-GC heap by 8,347,650 bytes (2026-10-01, this machine — the natural
 * residency of 100 session records: ctx.sessions/ctx.agents are lifetime
 * maps by design, plus engine atom/shape ratchet). The tolerance sits at
 * ~2x that: honest churn + session residency passes; the falsification
 * proof (one retained 1MB array per round → ~108MB growth) trips it by an
 * order of magnitude. The measured natural number lives in
 * baselines/perf-baseline.json next to this tolerance. */
const LEAK_TOLERANCE_BYTES = 16 * 1024 * 1024;

const rawEnv = globalThis.__dshLaunchEnv?.();
demand(typeof rawEnv === 'string', 'launch env snapshot missing (CLI must pass --env)');
const ENV = JSON.parse(rawEnv);
const MOCK_URL = ENV.DSH_MOCK_LLM_URL;
demand(typeof MOCK_URL === 'string' && MOCK_URL.startsWith('http://127.0.0.1:'),
  `mock LLM endpoint missing from the launch env: ${JSON.stringify(MOCK_URL)}`);

/** The probe: force a full collection, then read the engine's accounting. */
const heapAfterGc = () => {
  log.debug('heap probe (gc)');
  const probe = globalThis.__dshPerfProbe?.('gc');
  demand(probe && typeof probe.memoryUsedSize === 'number',
    '__dshPerfProbe(gc) unavailable — the host lacks the measurement hook');
  return probe;
};

const boot = async () => {
  log.debug('boot begin');
  const { ctx } = await bootUpstream({
    scenario: SCENARIO, agentId: 'leak', sessionId: 's-leak-boot',
    cwd: ROOT, onEvent: () => {},
    container: { cwd: ROOT, tmpdir: `${ROOT}/.tmp`, home: `${ROOT}/home`,
      env: {}, argv: ['dsh', '--profile', 'mobile'] },
    systemPrompt: { personaPrefix: '' },
    llm: { baseURL: MOCK_URL, apiKey: ENV.DSH_MOCK_LLM_KEY, provider: 'mock', model: 'mock-1' },
  });
  let guard = 0;
  while ((ctx.agents.get('s-leak-boot') === undefined) && guard++ < 10000) {
    await Promise.resolve();
  }
  demand(ctx.agents.get('s-leak-boot') !== undefined, 'the boot agent never appeared');
  return ctx;
};

/** One round over the page's own wire: create → prompt → whenIdle. The
 * round's locals go out of scope on return — what leaks is what GC cannot
 * reach, which is exactly what the after-watermark measures. */
const oneRound = async (ctx, api, i) => {
  log.debug('round begin', { round: i });
  const created = await api['session/create']({ request: {} });
  const sessionId = created?.sessionId;
  demand(typeof sessionId === 'string' && sessionId.length > 0, `round ${i}: no session minted`);
  await api['session/prompt']({ request: {
    sessionId, requestId: `leak-r${i}`, mode: 'queue',
    content: [{ type: 'text', text: 'ping' }],
  } });
  let guard = 0;
  while (ctx.agents.get(sessionId) === undefined && guard++ < 10000) await Promise.resolve();
  const agent = ctx.agents.get(sessionId);
  demand(agent !== undefined, `round ${i}: agent never appeared`);
  await agent.whenIdle();
  const events = ctx.sessions.get(sessionId).snapshotEvents();
  const assistant = events.find((record) => record.type === 'assistant/message');
  demand(assistant !== undefined, `round ${i}: no assistant/message`);
  return assistant.data?.message?.content
    ?.filter((block) => block.type === 'text').map((block) => block.text).join('') ?? '';
};

const main = async () => {
  log.debug('main begin');
  demand(typeof globalThis.__dshGatewayNegotiate === 'function'
    && globalThis.__dshGatewayNegotiate('gateway@1'), 'gateway negotiation failed');
  const ctx = await boot();
  const surface = createWriteSurface(ctx, () => {}, {
    root: ROOT, provider: 'mock', model: 'mock-1', baseURL: MOCK_URL,
    routeKind: 'mock',
    spine: () => [], stagedPlugins: () => [], fullCoverage: true,
  });
  const { api, dispose } = surface;

  const before = heapAfterGc();
  emit('leak.canary.begin', {
    rounds: ROUNDS, mode: 'gc', beforeMemoryUsedSize: before.memoryUsedSize,
  });

  let answered = 0;
  for (let i = 1; i <= ROUNDS; i++) {
    const text = await oneRound(ctx, api, i);
    demand(text === 'Hello from upstream', `round ${i} answered "${text}"`);
    answered = i;
    if (i % PROGRESS_EVERY === 0) {
      emit('leak.canary.progress', { round: i, of: ROUNDS });
    }
  }
  demand(answered === ROUNDS, `only ${answered}/${ROUNDS} rounds completed`);

  const after = heapAfterGc();
  const growth = after.memoryUsedSize - before.memoryUsedSize;
  const leaked = growth > LEAK_TOLERANCE_BYTES;
  emit('leak.canary.verdict', {
    status: leaked ? 'leak' : 'pass',
    rounds: ROUNDS,
    beforeMemoryUsedSize: before.memoryUsedSize,
    afterMemoryUsedSize: after.memoryUsedSize,
    growthBytes: growth,
    toleranceBytes: LEAK_TOLERANCE_BYTES,
  });
  dispose?.();
  if (leaked) {
    fail(`heap did not fall back after forced GC: +${growth} bytes over baseline `
      + `(tolerance ${LEAK_TOLERANCE_BYTES})`);
    // fail() completes FALSE but does not throw (demand() is the throwing
    // form) — without this return the branch FELL THROUGH to __dshComplete
    // (true,'ok'): the CLI printed PASS on a tripped canary (review #297).
    return;
  }
  globalThis.__dshComplete(true, 'ok');
};

await main().catch((err) => fail(`uncaught: ${err?.message ?? err}`));
