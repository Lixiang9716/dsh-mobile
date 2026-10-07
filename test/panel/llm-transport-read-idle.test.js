import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// loop-u2: the read-idle watchdog in the gateway LLM transport seam. The
// battery-r14 field evidence (w1-journal-timeline.txt, w1b-follow-frames.log):
// a black-holed socket (airplane mode mid-attempt) parked `for await` on the
// response body forever — last stream frame 18:49:44, the Connection reset
// only surfaced 18:58:20 (~8.6 min later), the retry's own attempt then froze
// for good, and the queued followup stranded behind it. The seam now aborts
// an attempt whose read side goes silent, as a retryable TIMEOUT LlmError —
// dsh-llm-retry's 1/5..5/5 rhythm then advances, and an exhausted budget
// errors the turn (loop-u's turn-recovery continues the followups).
//
// The fake below mirrors the REAL gateway contract (runtime/dsh/gateway.js
// httpFetch): the body is an AsyncIterable whose next() parks until a bridge
// event lands, and response.abort() marks the stream errored and WAKES the
// parked read with a rejection — the exact primitive that makes the watchdog
// able to unwind a byteless stall.

vi.mock('../../runtime/dsh/gateway.js', () => ({ httpFetch: vi.fn() }));

const { httpFetch } = await import('../../runtime/dsh/gateway.js');
const { createGatewayLlmAdapter } =
  await import('../../runtime/dsh/upstream/llm-transport.js');
const { DEFAULT_READ_IDLE_TIMEOUT_MS } =
  await import('../../runtime/dsh/upstream/llm-read-idle.js');
const { LlmError } = await import('@deepseek-ai/dsh-llm'); // the suite's stub alias

/** The gateway bridge's error vocabulary, as the seam's catch sees it. */
class GatewayError extends Error {
  constructor(code) {
    super(`gateway httpFetch failed (${code})`);
    this.name = 'GatewayError';
    this.code = code;
  }
}

const sse = (payload) => new TextEncoder().encode(`data: ${payload}\n\n`);

/** A scripted httpFetch response over the gateway's event shape. `steps` are
 * `{ afterMs, bytes?, end?, error? }` bridge events at absolute offsets. A
 * step list that just STOPS (no end/error) is the black hole: next() parks
 * forever until response.abort() lands — which rejects the parked read
 * exactly like the real gateway does (st.err set + wake, gateway.js
 * nextChunk). */
const scriptedResponse = (steps) => {
  const response = { status: 200, headers: {}, abortCalls: 0, errored: null, done: false };
  const queue = [];
  let pending = null;
  const settle = () => {
    if (!pending) return;
    if (response.errored) {
      const p = pending;
      pending = null;
      p.reject(response.errored);
      return;
    }
    if (queue.length > 0) {
      const p = pending;
      pending = null;
      p.resolve({ value: queue.shift(), done: false });
      return;
    }
    if (response.done) {
      const p = pending;
      pending = null;
      p.resolve({ value: undefined, done: true });
    }
  };
  for (const step of steps) {
    setTimeout(() => {
      if (response.done || response.errored) return;
      if (step.error !== undefined) response.errored = new GatewayError(step.error);
      else if (step.end === true) response.done = true;
      else if (step.bytes !== undefined) queue.push(step.bytes);
      settle();
    }, step.afterMs);
  }
  response.body = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise((resolve, reject) => {
        pending = { resolve, reject };
        settle();
      }),
    }),
  };
  response.abort = () => {
    response.abortCalls += 1;
    if (!response.done && !response.errored) response.errored = new GatewayError('cancelled');
    settle();
  };
  return response;
};

const IDLE = 1_000; // the tests' configured budget (small; fake timers drive it)

const mountAdapter = (response, extra = {}) => {
  httpFetch.mockResolvedValue(response);
  return createGatewayLlmAdapter({
    baseURL: 'http://127.0.0.1:9',
    apiKey: 'k',
    provider: 'bigmodel',
    readIdleTimeoutMs: IDLE,
    ...extra,
  });
};

const callOptions = (signal) => ({
  provider: 'bigmodel',
  model: 'glm-test',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  ...(signal === undefined ? {} : { signal }),
});

/** Begin one pull of `gen`, advancing the fake clock so scripted bytes (or
 * the idle budget) can land, then hand the pending result back. The raw pull
 * gets a no-op catch FIRST: it can reject mid-advance, before the caller's
 * own chain exists — an unhandled-rejection warning would otherwise flag the
 * rejection the test fully intends to consume. */
const pull = (gen, advanceMs = 0) => {
  const p = gen.next();
  p.catch(() => {});
  if (advanceMs > 0) return vi.advanceTimersByTimeAsync(advanceMs).then(() => p);
  return p;
};

/** Drain one settled pull into the error it rejected with. */
const rejectionOf = (p) => p.then(
  () => { throw new Error('expected the pull to reject'); },
  (error) => error,
);

/** Drive one attempt to [DONE], collecting the StreamChunks. */
const drain = (gen) => (async () => {
  const pulled = [];
  for (;;) {
    const { value, done } = await gen.next();
    if (done) return pulled;
    pulled.push(value);
  }
})();

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('loop-u2 read-idle watchdog: a frozen attempt becomes a retryable failure', () => {
  it('bytes stop mid-stream: the parked read unwinds via response.abort() and the attempt fails TIMEOUT', async () => {
    // round-1 shape: deltas flowed (rev387 in the field log), then silence.
    const response = scriptedResponse([
      { afterMs: 10, bytes: sse('{"choices":[{"delta":{"content":"hel"}}]}') },
      { afterMs: 20, bytes: sse('{"choices":[{"delta":{"content":"lo"}}]}') },
      // … then the socket black-holes: no end, no error, nothing.
    ]);
    const adapter = mountAdapter(response);
    const gen = adapter.stream(callOptions());

    // payload → StreamChunks order: a text block opens first, then its deltas
    const opening = await pull(gen, 20);
    expect((await opening).value).toEqual({ type: 'block-start', index: 0, blockType: 'text' });
    const delta1 = await pull(gen); // same payload's first delta
    expect((await delta1).value).toEqual({ type: 'text-delta', index: 0, text: 'hel' });
    const delta2 = await pull(gen); // the pre-queued second chunk, no stall
    expect((await delta2).value).toEqual({ type: 'text-delta', index: 0, text: 'lo' });

    const stalled = rejectionOf(pull(gen)); // handler attached before the lapse
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(response.abortCalls).toBe(0); // one tick short — the budget has not lapsed
    await vi.advanceTimersByTimeAsync(1);
    const error = await stalled;
    expect(error).toBeInstanceOf(LlmError);
    expect(error.code).toBe('TIMEOUT');
    expect(response.abortCalls).toBeGreaterThanOrEqual(1); // the watchdog aborted the attempt
  });

  it('the failure names the stall and carries the retryable fact: TIMEOUT in .code and .failure (the vendored DEFAULT_RETRYABLE_CODES leg, llm@lib index.js:244)', async () => {
    const response = scriptedResponse([{ afterMs: 5, bytes: sse('{"choices":[{"delta":{"content":"x"}}]}') }]);
    const adapter = mountAdapter(response);
    const gen = adapter.stream(callOptions());
    await pull(gen, 10); // block-start
    await pull(gen); // the text delta — the last bytes the wire ever delivers
    const error = await rejectionOf(pull(gen, IDLE));
    expect(error).toBeInstanceOf(LlmError);
    expect(error.code).toBe('TIMEOUT');
    expect(error.failure).toMatchObject({ code: 'TIMEOUT' });
    expect(error.message).toContain(`no bytes for ${IDLE}ms`);
    expect(error.message).toContain('read-idle watchdog');
  });
});

describe('loop-u2 read-idle watchdog: wire liveness stays wiring', () => {
  it('inter-chunk lulls under the budget never trip it: a normal stream completes untouched', async () => {
    const response = scriptedResponse([
      { afterMs: 1, bytes: sse('{"choices":[{"delta":{"content":"a"}}]}') },
      { afterMs: 600, bytes: sse('{"choices":[{"delta":{"content":"b"}}]}') },
      { afterMs: 1200, bytes: sse('{"choices":[{"delta":{"content":"c"}}]}') },
      { afterMs: 1205, bytes: sse('{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":3,"total_tokens":4}}') },
      { afterMs: 1210, bytes: sse('[DONE]') },
    ]);
    const adapter = mountAdapter(response);
    const gen = adapter.stream(callOptions());
    const drive = drain(gen);
    await vi.advanceTimersByTimeAsync(5_000);
    const pulled = await drive;
    expect(pulled.filter((c) => c.type === 'text-delta').map((c) => c.text)).toEqual(['a', 'b', 'c']);
    expect(pulled.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } });
    expect(pulled.some((c) => c.type === 'usage')).toBe(true);
    expect(response.abortCalls).toBe(0); // armed the whole time, never fired
  });

  it('the watchdog re-arms per chunk: pauses just over half the budget, twice, are lulls — not a stall', async () => {
    const response = scriptedResponse([
      { afterMs: 1, bytes: sse('{"choices":[{"delta":{"content":"a"}}]}') },
      { afterMs: 700, bytes: sse('{"choices":[{"delta":{"content":"b"}}]}') },
      { afterMs: 1400, bytes: sse('{"choices":[{"delta":{"content":"c"}}]}') },
      { afterMs: 1401, bytes: sse('[DONE]') },
    ]);
    const adapter = mountAdapter(response);
    const gen = adapter.stream(callOptions());
    const drive = drain(gen);
    await vi.advanceTimersByTimeAsync(5_000);
    const pulled = await drive;
    expect(pulled.filter((c) => c.type === 'text-delta').map((c) => c.text)).toEqual(['a', 'b', 'c']);
    expect(response.abortCalls).toBe(0);
  });
});

describe('loop-u2 read-idle watchdog: the guard is per-attempt (the retry re-enters clean)', () => {
  it('after a timed-out attempt the next attempt (the retry) streams cleanly — no leaked timer', async () => {
    const blackHole = scriptedResponse([{ afterMs: 5, bytes: sse('{"choices":[{"delta":{"content":"x"}}]}') }]);
    const adapter = mountAdapter(blackHole);
    const gen1 = adapter.stream(callOptions());
    await pull(gen1, 10); // block-start
    await pull(gen1); // text delta
    const error = await rejectionOf(pull(gen1, IDLE));
    expect(error.code).toBe('TIMEOUT');

    // dsh-llm-retry's rhythm, at the seam: the retry is a fresh stream() call.
    httpFetch.mockResolvedValue(scriptedResponse([
      { afterMs: 1, bytes: sse('{"choices":[{"delta":{"content":"ok"}}]}') },
      { afterMs: 2, bytes: sse('[DONE]') },
    ]));
    const gen2 = adapter.stream(callOptions());
    const drive = drain(gen2);
    await vi.advanceTimersByTimeAsync(10);
    const pulled = await drive;
    expect(pulled.some((c) => c.type === 'text-delta' && c.text === 'ok')).toBe(true);
    expect(pulled.at(-1)).toMatchObject({ type: 'finish' });
  });
});

describe('loop-u2 caller-abort bridge: an abort unwinds a byteless stall', () => {
  it('signal abort with ZERO bytes ever delivered: the parked read rejects ABORTED and response.abort() ran', async () => {
    // the field bug's second face: ring-2's watchdog cancel parked forever,
    // because throwIfAborted only ran when a chunk arrived.
    const response = scriptedResponse([]); // eternal black hole
    const adapter = mountAdapter(response);
    const ctrl = new AbortController();
    const gen = adapter.stream(callOptions(ctrl.signal));
    const parked = pull(gen);
    expect(response.abortCalls).toBe(0);
    ctrl.abort(); // the bridge aborts the response synchronously
    const error = await rejectionOf(parked);
    expect(error).toBeInstanceOf(LlmError);
    expect(error.code).toBe('ABORTED');
    expect(response.abortCalls).toBeGreaterThanOrEqual(1);
  });

  it('an abort mid-stream still reads ABORTED, not TIMEOUT', async () => {
    const response = scriptedResponse([{ afterMs: 1, bytes: sse('{"choices":[{"delta":{"content":"x"}}]}') }]);
    const adapter = mountAdapter(response);
    const ctrl = new AbortController();
    const gen = adapter.stream(callOptions(ctrl.signal));
    await pull(gen, 10); // block-start
    await pull(gen); // text delta
    const nextPull = pull(gen);
    ctrl.abort();
    const error = await rejectionOf(nextPull);
    expect(error.code).toBe('ABORTED');
  });
});

describe('loop-u2: the untouched legs keep their mapping', () => {
  it('a real socket error mid-stream still maps TRANSPORT (the watchdog did not fire)', async () => {
    const response = scriptedResponse([
      { afterMs: 1, bytes: sse('{"choices":[{"delta":{"content":"x"}}]}') },
      { afterMs: 5, error: 'ECONNRESET' },
    ]);
    const adapter = mountAdapter(response);
    const gen = adapter.stream(callOptions());
    await pull(gen, 10); // block-start
    await pull(gen); // text delta
    const error = await rejectionOf(pull(gen));
    expect(error.code).toBe('TRANSPORT');
    expect(error.message).toContain('ECONNRESET');
  });

  it('a stream that ends without [DONE] still maps STREAM_CLOSED', async () => {
    const response = scriptedResponse([
      { afterMs: 1, bytes: sse('{"choices":[{"delta":{"content":"x"}}]}') },
      { afterMs: 5, end: true },
    ]);
    const adapter = mountAdapter(response);
    const gen = adapter.stream(callOptions());
    await pull(gen, 10); // block-start
    await pull(gen); // text delta
    const error = await rejectionOf(pull(gen));
    expect(error.code).toBe('STREAM_CLOSED');
  });
});

describe('loop-u2: the budget and its config', () => {
  it('the default is 120s — the #326 guard-family number (ring-1 tool budget), under ring-2\'s 300s', () => {
    expect(DEFAULT_READ_IDLE_TIMEOUT_MS).toBe(120_000);
  });

  it('the default budget is live behavior, not just a constant: an unconfigured adapter trips at exactly 120s', async () => {
    const response = scriptedResponse([{ afterMs: 5, bytes: sse('{"choices":[{"delta":{"content":"x"}}]}') }]);
    httpFetch.mockResolvedValue(response);
    const adapter = createGatewayLlmAdapter({
      baseURL: 'http://127.0.0.1:9', apiKey: 'k', provider: 'bigmodel',
    });
    const gen = adapter.stream(callOptions());
    await pull(gen, 10); // block-start
    await pull(gen); // text delta
    const stalled = rejectionOf(pull(gen)); // handler attached before the lapse
    await vi.advanceTimersByTimeAsync(119_999);
    expect(response.abortCalls).toBe(0); // one tick short — still patient
    await vi.advanceTimersByTimeAsync(1);
    const error = await stalled;
    expect(error.code).toBe('TIMEOUT');
    expect(error.message).toContain('no bytes for 120000ms');
  });

  it.each([0, -1, NaN, Infinity, '5000', null])('a bad readIdleTimeoutMs (%p) fails loud at mount (rule 5)', (bad) => {
    expect(() => createGatewayLlmAdapter({
      baseURL: 'http://127.0.0.1:9', apiKey: 'k', provider: 'bigmodel', readIdleTimeoutMs: bad,
    })).toThrow('readIdleTimeoutMs must be a positive finite number');
  });
});
