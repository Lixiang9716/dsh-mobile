import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// P1 (2026-10-09): the real-turn 300s silent hang. The captured incident
// (session-4331764d in the device capture log): both wire attempts parked
// BEFORE response headers ("Operation timeout" each at the platform's 300s
// read timeout), the turn watchdog killed the turn as an ABORT first, and
// the turn settled `text:""` with the failure reason in NO record — the page
// showed an empty reply. Two surfaces carry the fix this suite pins:
//
//   1. web-live/turn-failure.js — the settle record's structured `error`
//      fold (turn/end reason + the newest llm/retry line). The vendored chat
//      UI renders a failure notice ONLY for turn/end reasons of kind
//      "error" (dsh-client-ui-chat failureFrom); a watchdog abort renders
//      nothing, so the record must carry the reason itself.
//   2. the transport seam's PRE-HEADERS face: a request that dies before
//      headers (the incident's exact shape — the read-idle watchdog does not
//      even exist until parseSse, which starts after headers) must surface
//      as a retryable TRANSPORT LlmError naming the wire failure. The
//      host-side fast-fail itself (HttpFetch.ets's stalled-read guard) is
//      device code; this pins the seam contract its rejection feeds.

vi.mock('../../runtime/dsh/gateway.js', () => ({ httpFetch: vi.fn() }));

const { httpFetch } = await import('../../runtime/dsh/gateway.js');
const { createGatewayLlmAdapter } =
  await import('../../runtime/dsh/upstream/llm-transport.js');
const { turnFailureOf } = await import('../../runtime/dsh/web-live/turn-failure.js');
const { describeLlmRetry } =
  await import('../../runtime/dsh/upstream/retry-telemetry.js');
const { LlmError } = await import('@deepseek-ai/dsh-llm'); // the suite's stub alias

class GatewayError extends Error {
  constructor(code) {
    super(`gateway httpFetch failed (${code})`);
    this.name = 'GatewayError';
    this.code = code;
  }
}

const callOptions = () => ({
  provider: 'bigmodel',
  model: 'glm-test',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
});

const mountAdapter = () => createGatewayLlmAdapter({
  baseURL: 'http://127.0.0.1:9', apiKey: 'k', provider: 'bigmodel',
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('P1: the settle record failure fold — failure shapes (web-live/turn-failure.js)', () => {
  it('an error turn/end reason folds to {kind:"error", code, message} — the shape the vendored chat UI can render', () => {
    const failure = turnFailureOf({
      kind: 'error',
      error: { message: 'gateway SSE stream stalled: no bytes for 120000ms', code: 'TIMEOUT' },
    }, undefined);
    expect(failure).toEqual({
      kind: 'error', code: 'TIMEOUT',
      message: 'gateway SSE stream stalled: no bytes for 120000ms',
    });
  });

  it('the watchdog-abort shape surfaces its cause — the incident shape that rendered as NOTHING before', () => {
    const failure = turnFailureOf({
      kind: 'aborted',
      reason: { kind: 'watchdog', message: 'no turn progress for 300000ms' },
    }, 'attempt 1/5: TRANSPORT gateway transport failed: Operation timeout');
    expect(failure).toEqual({
      kind: 'aborted', code: 'watchdog',
      message: 'no turn progress for 300000ms',
      lastRetry: 'attempt 1/5: TRANSPORT gateway transport failed: Operation timeout',
    });
  });

  it('a user abort (no message on the cause) still renders an honest line', () => {
    const failure = turnFailureOf({ kind: 'aborted', reason: { kind: 'user' } }, undefined);
    expect(failure).toEqual({
      kind: 'aborted', code: 'user', message: 'turn aborted (user)',
    });
  });
});

describe('P1: the settle record failure fold — silence and hardening', () => {
  it('normal completions fold to null — the happy-path settle record stays byte-identical', () => {
    expect(turnFailureOf({ kind: 'completed' }, undefined)).toBeNull();
    expect(turnFailureOf({ kind: 'stop' }, undefined)).toBeNull();
    expect(turnFailureOf({ kind: 'max-tokens' }, undefined)).toBeNull();
    expect(turnFailureOf({ kind: 'blocked' }, undefined)).toBeNull();
  });

  it('a missing/malformed reason never throws the settle projection', () => {
    expect(turnFailureOf(undefined, undefined)).toBeNull();
    expect(turnFailureOf(null, undefined)).toBeNull();
    expect(turnFailureOf('completed', undefined)).toBeNull();
    expect(turnFailureOf({ kind: 'error' }, undefined)).toEqual({
      kind: 'error', code: 'UNKNOWN', message: '',
    });
  });

  it('describeLlmRetry renders the journal event the fold cites as lastRetry', () => {
    expect(describeLlmRetry({
      retry: 1, maxRetries: 5,
      failure: { code: 'TRANSPORT', message: 'gateway transport to https://open.bigmodel.cn failed: Operation timeout' },
    })).toBe('attempt 1/5: TRANSPORT gateway transport to https://open.bigmodel.cn '
      + 'failed: Operation timeout');
    expect(describeLlmRetry({ retry: 2, failure: { code: 'TIMEOUT' } })).toBe('attempt 2: TIMEOUT');
  });
});

describe('P1: the pre-headers wire failure surfaces retryable at the seam', () => {
  it('an httpFetch rejection BEFORE any header rides TRANSPORT with the cause named (the incident face)', async () => {
    httpFetch.mockRejectedValue(new GatewayError('timeout'));
    const adapter = mountAdapter();
    const gen = adapter.stream(callOptions());
    const error = await gen.next().then(
      () => { throw new Error('expected the stream to reject'); },
      (e) => e,
    );
    expect(error).toBeInstanceOf(LlmError);
    expect(error.code).toBe('TRANSPORT');
    expect(error.failure.code).toBe('TRANSPORT');
    expect(error.message).toContain('gateway transport to http://127.0.0.1:9/chat/completions failed');
    expect(error.message).toContain('gateway httpFetch failed (timeout)');
  });
});
