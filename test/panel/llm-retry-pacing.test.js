import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// loop-c2: seam-side PACING for transport-class fast failures. The
// battery-r18 field round (w1-retry-lines.txt, v1-timeline.txt): after the
// loop-u2 watchdog cut attempt 1 at t0+120.4s (TIMEOUT), the vendored
// dsh-llm-retry rhythm ran its online defaults (500ms ×2) and every
// following attempt died at the offline DNS/proxy reflex in 0.5-4s — the
// whole 5-retry budget burned in ~7s and the turn ERRORED at t0+136s, two
// minutes before the network returned (t_restore = t0+255s).
//
// The fix rides the vendored injection point: the seam's fast TRANSPORT
// failures carry `providerRetryAfterMs` (dsh-llm-retry's recover() adopts
// it verbatim — its index.js:168-172), the route's providerRetryPolicy()
// widens maxDelayMs so the vendored give-up clause can never fire on a
// paced failure, and the ladder 15s/45s/120s (×3, capped at the read-idle
// budget) spreads the chain across the outage. Slow failures stay unpaced:
// the online rhythm is bit-identical to before.
//
// Two lenses:
// - SEAM (describe 1): the adapter's failures carry the right fields over a
//   scripted gateway (the llm-transport-read-idle fake's vocabulary).
// - VENDORED CONSUMER (describe 2): the REAL @deepseek-ai/dsh-llm-retry
//   recover() — the tracked android staged bytes the `closures` gate pins —
//   driven over those very failures: paced waits land in llm/retry delayMs,
//   the exhaustion attempt hands the error to next() (the turn still
//   errors), and an unpaced slow failure keeps the ~500ms local rhythm.

vi.mock('../../runtime/spike/gateway.js', () => ({ httpFetch: vi.fn() }));

// dsh-llm-retry imports `zod` at module top for its projection state
// schema; the bare specifier has no tracked bytes (the C host's bare map
// resolves it on device). recover()'s path never parses that schema — the
// context fake below replays the projection itself — so a chainable
// stand-in keeps the module graph loadable without new suite dependencies.
vi.mock('zod', () => {
  const schemaish = new Proxy(function () {}, {
    get: (_target, prop) => (prop === Symbol.toPrimitive ? () => 'zod-schema' : schemaish),
    apply: () => schemaish,
  });
  return { z: schemaish };
});

const { httpFetch } = await import('../../runtime/spike/gateway.js');
const { createGatewayLlmAdapter } =
  await import('../../runtime/spike/upstream/llm-transport.js');
const {
  FAST_TRANSPORT_FAIL_MS,
  FAST_TRANSPORT_PACES_MS,
  FAST_TRANSPORT_MAX_PACE_MS,
  FAST_TRANSPORT_EPISODE_MS,
} = await import('../../runtime/spike/upstream/llm-retry-pacing.js');
const { LlmError } = await import('@deepseek-ai/dsh-llm'); // the suite's stub alias

const SLOW_MS = FAST_TRANSPORT_FAIL_MS + 1_000; // a "slow" transport failure for the tests

/** The offline reflex, as the seam's catch sees it (the r18 messages). */
const dnsError = () => {
  const error = new Error('Unable to resolve host "open.bigmodel.cn": No address associated with hostname');
  error.code = 'EAI_AGAIN';
  return error;
};

const connectError = () => new Error('Failed to connect to /10.0.2.2:7890');

const callOptions = () => ({
  provider: 'bigmodel',
  model: 'glm-test',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
});

const mountAdapter = (extra = {}) => createGatewayLlmAdapter({
  baseURL: 'http://127.0.0.1:9',
  apiKey: 'k',
  provider: 'bigmodel',
  ...extra,
});

/** One offline attempt: the transport opens and dies instantly. Answers a
 * promise for the LlmError the attempt rejected with (the object the
 * vendored loop would receive). Instant failures settle without the clock;
 * slow ones (mockImplementation timers) need the caller to advance it. */
const offlineAttempt = (adapter) => {
  const gen = adapter.stream(callOptions());
  return gen.next().then(
    () => { throw new Error('expected the attempt to reject'); },
    (error) => error,
  );
};

/** The mount that points httpFetch at a fresh offline reflex. */
const offlineGateway = () => httpFetch.mockRejectedValue(dnsError());

/** A fresh failure from an offline-fast attempt — its baked pace is the
 * adapter ladder's CURRENT rung, so each call consumes one strike. */
const offlineFailure = async (adapter) => {
  offlineGateway();
  return (await offlineAttempt(adapter)).failure;
};

/** A fresh failure from a SLOW transport attempt (unpaced by the seam);
 * advances the fake clock to settle it. */
const slowFailure = async (adapter) => {
  httpFetch.mockImplementation(() => new Promise((_resolve, reject) => {
    setTimeout(() => reject(connectError()), SLOW_MS);
  }));
  const pending = offlineAttempt(adapter); // parks until the clock moves
  await vi.advanceTimersByTimeAsync(SLOW_MS);
  return (await pending).failure;
};

/** The battery-r18 stream: one SSE payload lands, then the wire goes silent
 * — next() parks until response.abort() wakes it with a rejection (the
 * gateway bridge's real wake shape, llm-transport-read-idle's fake). */
const silentStreamGateway = () => {
  const sse = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n');
  const response = { status: 200, headers: {}, abortCalls: 0, errored: null, done: false };
  let parked = null;
  let delivered = false;
  response.body = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise((resolve, reject) => {
        parked = { resolve, reject };
        if (!delivered) {
          delivered = true;
          resolve({ value: sse, done: false });
        }
      }),
    }),
  };
  response.abort = () => {
    response.abortCalls += 1;
    if (!response.done && !response.errored) {
      response.errored = new Error('gateway: cancelled');
      parked?.reject(response.errored);
    }
  };
  httpFetch.mockResolvedValue(response);
  return response;
};

beforeEach(() => {
  vi.useFakeTimers();
  offlineGateway();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('loop-c2 seam: the pace ladder and its resets', () => {
  it('consecutive offline fast fails pace 15s/45s/120s, clamped at the cap', async () => {
    const adapter = mountAdapter();
    const paces = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const error = await offlineAttempt(adapter); // attempts 1..5, all offline-reflex
      expect(error).toBeInstanceOf(LlmError);
      expect(error.code).toBe('TRANSPORT'); // pacing never softens the failure
      paces.push(error.failure.providerRetryAfterMs);
    }
    // strikes 0,1,2 climb the table; a 5-retry chain fast-fails at most four
    // times, and the clamp holds the cap from there on
    expect(paces).toEqual([...FAST_TRANSPORT_PACES_MS, FAST_TRANSPORT_MAX_PACE_MS, FAST_TRANSPORT_MAX_PACE_MS]);
  });

  it('a SLOW transport failure stays unpaced and resets the ladder (the online rhythm is untouched)', async () => {
    const adapter = mountAdapter();
    const slow = await slowFailure(adapter);
    expect(slow.code).toBe('TRANSPORT');
    expect(slow.providerRetryAfterMs).toBeUndefined(); // slow: unpaced

    // the next offline-fast attempt restarts from the FIRST slot, because
    // the slow failure cleared the ladder
    expect((await offlineFailure(adapter)).providerRetryAfterMs).toBe(FAST_TRANSPORT_PACES_MS[0]);
  });
});

describe('loop-c2 seam: the field shape and the route policy', () => {
  it('the field shape: the watchdog TIMEOUT consumes no strike; the fast fails after it pace from slot 0', async () => {
    // battery-r18: attempt 1 died by read-idle (TIMEOUT — slow by
    // construction: the budget ran out), the retries were the instant
    // offline reflex.
    const response = silentStreamGateway();
    const adapter = mountAdapter({ readIdleTimeoutMs: 1_000 });

    const gen = adapter.stream(callOptions());
    expect((await gen.next()).value.type).toBe('block-start'); // the payload's first chunk
    expect((await gen.next()).value.type).toBe('text-delta'); // its second — the last bytes ever
    const stalled = gen.next().then(() => { throw new Error('expected the stall'); }, (error) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    const timeout = await stalled;
    expect(timeout.code).toBe('TIMEOUT');
    expect(timeout.failure.providerRetryAfterMs).toBeUndefined(); // a slow failure: unpaced

    // the retries are offline reflexes — they pace from the FIRST slot
    const retry1 = await offlineFailure(adapter);
    const retry2 = await offlineFailure(adapter);
    expect(retry1.providerRetryAfterMs).toBe(FAST_TRANSPORT_PACES_MS[0]);
    expect(retry2.providerRetryAfterMs).toBe(FAST_TRANSPORT_PACES_MS[1]);
    expect(response.abortCalls).toBeGreaterThanOrEqual(1); // the watchdog aborted the attempt
  });

  it('an outage episode gone stale restarts the ladder (a fresh turn re-earns the short slots)', async () => {
    const adapter = mountAdapter();
    expect((await offlineFailure(adapter)).providerRetryAfterMs).toBe(FAST_TRANSPORT_PACES_MS[0]);
    expect((await offlineFailure(adapter)).providerRetryAfterMs).toBe(FAST_TRANSPORT_PACES_MS[1]);
    await vi.advanceTimersByTimeAsync(FAST_TRANSPORT_EPISODE_MS + 1);
    expect((await offlineFailure(adapter)).providerRetryAfterMs).toBe(FAST_TRANSPORT_PACES_MS[0]);
  });

  it('the route retry policy admits the widest slot and keeps the vendored local defaults', () => {
    const policy = mountAdapter().providerRetryPolicy('bigmodel');
    expect(policy.mode).toBe('normal');
    expect(policy.maxRetries).toBe(5); // the honest budget: five retries, unchanged
    expect(policy.initialDelayMs).toBe(500); // the unpaced rhythm: unchanged
    expect(policy.maxDelayMs).toBe(FAST_TRANSPORT_MAX_PACE_MS); // the give-up clause can never fire
    expect(policy.retryableCodes).toContain('TRANSPORT');
    expect(policy.retryableCodes).toContain('TIMEOUT');
  });
});

// ---- the vendored consumer: the REAL dsh-llm-retry recover() over the
// seam's failures. The context fake mirrors the two faces apply() uses
// (ctx.on, ctx.sessionProjections) and replays the llmRetry projection
// exactly as the session would (init/apply per appended event).

const fakeCtx = () => {
  const handlers = new Map();
  const projections = new Map();
  return {
    handlers,
    projections,
    on(event, handler) {
      handlers.set(event, handler);
    },
    effect() {},
    logger: { warn() {}, info() {}, debug() {}, error() {} },
    sessionProjections: {
      register(projection) {
        projections.set(projection.key, { ...projection, state: projection.init() });
      },
      stateOf(_session, key) {
        return projections.get(key)?.state;
      },
    },
  };
};

const fakeAgent = (ctx) => ({
  session: {
    events: [],
    append(type, data) {
      const event = { type, data, seq: this.events.length + 1 };
      this.events.push(event);
      const projection = ctx.projections.get('llmRetry');
      if (projection) projection.state = projection.apply(projection.state, event);
      return { seq: event.seq };
    },
  },
});

/** Drive one recover() with the seam-shaped failure: answers the retrier's
 * decision after its scheduled wait has been advanced through, plus the
 * llm/retry event THIS call appended (none on the exhaustion leg — the
 * last event must not be mistaken for this round's). */
const driveAttempt = async (ctx, agent, policy, failure) => {
  const next = vi.fn(() => undefined);
  const before = agent.session.events.length;
  const pending = Promise.resolve(ctx.handlers.get('agent/request-error')(
    { agent, turn: 1, step: 1, provider: 'bigmodel', failure, retryPolicy: policy, signal: new AbortController().signal },
    next,
  ));
  pending.catch(() => {});
  const retryEvent = agent.session.events.slice(before)
    .filter((event) => event.type === 'llm/retry').at(-1);
  if (retryEvent) await vi.advanceTimersByTimeAsync(retryEvent.data.delayMs);
  const action = await pending;
  return { action, nextCalled: next.mock.calls.length > 0, retryEvent };
};

/** Mount the REAL vendored plugin with its context fake, an agent whose
 * journal replays the llmRetry projection, and a seam-backed failure kit. */
const mountVendoredChain = async () => {
  const { apply } = await import('@deepseek-ai/dsh-llm-retry'); // the tracked staged bytes
  const ctx = fakeCtx();
  apply(ctx);
  const adapter = mountAdapter();
  return { ctx, agent: fakeAgent(ctx), adapter, policy: adapter.providerRetryPolicy('bigmodel') };
};

describe('loop-c2 × vendored dsh-llm-retry: the loop consumes the pace', () => {
  it('the watchdog cut retries on the vendored local rhythm (~500ms, unpaced)', async () => {
    const { ctx, agent, policy } = await mountVendoredChain();
    // attempt 1 (the r18 watchdog leg): unpaced — the local rhythm runs
    const timeoutFailure = {
      message: 'gateway SSE stream stalled: no bytes for 120000ms — read-idle watchdog aborted the attempt',
      code: 'TIMEOUT',
    };
    const attempt1 = await driveAttempt(ctx, agent, policy, timeoutFailure);
    expect(attempt1.retryEvent.data.retry).toBe(1);
    expect(attempt1.retryEvent.data.delayMs).toBeGreaterThanOrEqual(450); // 500ms ± 10% jitter
    expect(attempt1.retryEvent.data.delayMs).toBeLessThanOrEqual(550);
    expect(attempt1.action).toEqual({ kind: 'retry' });
  });

  it('the offline reflex chain paces 15/45/120/120s; the scheduled waits span ~5 minutes', async () => {
    const { ctx, agent, adapter, policy } = await mountVendoredChain();
    // retry 1 belongs to the (unpaced) watchdog leg; the offline reflexes follow
    await driveAttempt(ctx, agent, policy, { message: 'gateway SSE stream stalled', code: 'TIMEOUT' });
    await slowFailure(adapter); // interleave: resets the seam ladder deterministically

    // retries 2..5 schedule the ladder — each round's failure is freshly
    // produced, so its baked pace is the rung the loop then adopts verbatim
    for (const [round0, expected] of [...FAST_TRANSPORT_PACES_MS, FAST_TRANSPORT_MAX_PACE_MS].entries()) {
      const failure = await offlineFailure(adapter);
      expect(failure.providerRetryAfterMs).toBe(expected); // the seam's rung
      const round = await driveAttempt(ctx, agent, policy, failure);
      expect(round.retryEvent.data.retry).toBe(2 + round0); // retries 2..5
      expect(round.retryEvent.data.delayMs).toBe(expected); // adopted verbatim
      expect(round.action).toEqual({ kind: 'retry' });
    }

    // the spread: the scheduled waits sum to ~5 minutes of outage coverage
    // (battery-r18 burned the same budget in ~7s)
    const scheduled = agent.session.events
      .filter((event) => event.type === 'llm/retry')
      .reduce((total, event) => total + event.data.delayMs, 0);
    expect(scheduled).toBeGreaterThanOrEqual(299_000);
  });
});

describe('loop-c2 × vendored dsh-llm-retry: the budget stays honest', () => {
  it('exhaustion hands the error on (the turn still errors) after five paced retries', async () => {
    const { ctx, agent, adapter, policy } = await mountVendoredChain();
    const failure = { message: 'gateway transport failed', code: 'TRANSPORT', providerRetryAfterMs: 15_000 };

    // burn the budget: five paced retries schedule (a compact replay)
    for (let retry = 1; retry <= 5; retry++) {
      const round = await driveAttempt(ctx, agent, policy, failure);
      expect(round.action).toEqual({ kind: 'retry' });
    }

    // the sixth failure: maxRetries reached — next() runs, no retry is
    // scheduled, and the failure stands (loop-u's turn-recovery picks up
    // the queued followups)
    const exhausted = await driveAttempt(ctx, agent, policy, failure);
    expect(exhausted.nextCalled).toBe(true);
    expect(exhausted.retryEvent).toBeUndefined();
    expect(exhausted.action).toBeUndefined();
  });

  it('an unpaced slow failure inside a live chain keeps the ~500ms local rhythm', async () => {
    const { ctx, agent, adapter, policy } = await mountVendoredChain();
    const failure = await slowFailure(adapter); // no providerRetryAfterMs — the seam left it alone

    const round = await driveAttempt(ctx, agent, policy, failure);
    expect(round.nextCalled).toBe(false);
    expect(round.retryEvent.data.delayMs).toBeGreaterThanOrEqual(450);
    expect(round.retryEvent.data.delayMs).toBeLessThanOrEqual(550);
    expect(round.retryEvent.data.delayMs).not.toBe(FAST_TRANSPORT_PACES_MS[0]);
  });

  it('a non-retryable code passes straight through (the seam never widened the retryable set)', async () => {
    const { ctx, agent, policy } = await mountVendoredChain();
    const round = await driveAttempt(ctx, agent, policy, { message: 'provider error (HTTP 401)', code: 'AUTH' });
    expect(round.nextCalled).toBe(true);
    expect(round.retryEvent).toBeUndefined();
    expect(agent.session.events).toHaveLength(0);
  });
});
