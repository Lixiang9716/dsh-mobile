import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apply as applyRetryTelemetry, describeLlmRetry } from '../../runtime/dsh/upstream/retry-telemetry.js';

// The warn line IS the deliverable (loop-x2: retries stay release-visible),
// so the logger is mocked to capture every sink-bound record.
vi.mock('logger.js', () => {
  const records = [];
  const capture = (level) => (message, data) => records.push({ level, message, data });
  const createLogger = () => ({
    debug: capture('debug'),
    info: capture('info'),
    warn: capture('warn'),
    error: capture('error'),
  });
  return { createLogger, records, releaseKeeps: () => true };
});

import { records } from 'logger.js';

const warns = () => records.filter((r) => r.level === 'warn');

/** A fake cordis context recording the plugin's one listener ('session/event',
 * the dispatch dsh-session hands its observers: (session, event)). */
const fakeCtx = () => {
    const listeners = new Map();
    return {
        on: (event, handler) => listeners.set(event, handler),
        emit: (session, event) => listeners.get('session/event')?.(session, event),
    };
};

/** The llm/retry payload exactly as the vendored dsh-llm-retry backoff()
 * journals it (normal mode), as captured in battery-r14 W1 (TRANSPORT). */
const retryEvent = (retry, overrides = {}) => ({
    type: 'llm/retry',
    seq: 25,
    time: 1791139859399,
    data: {
        retryId: '5e5ccc99-d6de-4555-82df-57725be4a873',
        turn: 3,
        step: 1,
        provider: 'bigmodel',
        mode: 'normal',
        policyKey: '["normal",5,["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],500,10000,0.1]',
        retry,
        maxRetries: 5,
        delayMs: 455.36,
        failure: { message: 'gateway SSE stream failed: Connection reset', code: 'TRANSPORT' },
        ...overrides,
    },
});

const mountTelemetry = () => {
    const ctx = fakeCtx();
    applyRetryTelemetry(ctx);
    return ctx;
};

// the capture array is module-level; every pin starts from a clean sink
beforeEach(() => {
    records.length = 0;
});

describe('retry telemetry: each llm/retry journal append warns once, release-visible', () => {
    it('one llm/retry event warns once, carrying the attempt ordinal and the failure category', () => {
        const ctx = mountTelemetry();

        ctx.emit({}, retryEvent(1));

        const lines = warns();
        expect(lines).toHaveLength(1);
        expect(lines[0].message).toContain('attempt 1/5');
        expect(lines[0].message).toContain('TRANSPORT');
        expect(lines[0].message).toContain('gateway SSE stream failed: Connection reset');
        // the structured data names the chain for correlation with the journal
        expect(lines[0].data).toMatchObject({ provider: 'bigmodel', turn: 3, step: 1 });
    });

    it('each attempt of a bounded chain warns once — 1/5 then 2/5, never a storm', () => {
        const ctx = mountTelemetry();

        ctx.emit({}, retryEvent(1));
        ctx.emit({}, retryEvent(2, { retryId: '1f0b7289-45cc-423b-a662-2f34da8aa7ca' }));

        const lines = warns();
        expect(lines).toHaveLength(2);
        expect(lines[0].message).toContain('attempt 1/5');
        expect(lines[1].message).toContain('attempt 2/5');
    });

    it('the always-retry policy (no maxRetries ceiling) still warns once, bare ordinal', () => {
        const ctx = mountTelemetry();

        ctx.emit({}, retryEvent(2, { mode: 'always', maxRetries: undefined }));

        const lines = warns();
        expect(lines).toHaveLength(1);
        expect(lines[0].message).toContain('attempt 2');
        expect(lines[0].message).not.toContain('/5');
    });
});

describe('retry telemetry: non-retry traffic stays silent, malformed input never throws', () => {
    it('turn boundaries, retry-started markers, and messages emit no warn', () => {
        const ctx = mountTelemetry();

        ctx.emit({}, { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } });
        ctx.emit({}, { type: 'llm/retry-started', seq: 26, time: 2, data: { retryId: 'x', turn: 3, step: 1, retry: 1 } });
        ctx.emit({}, { type: 'user/message', seq: 5, time: 3, data: {} });

        expect(warns()).toHaveLength(0);
    });

    it('a malformed payload renders UNKNOWN and never throws into the journal dispatch', () => {
        const ctx = mountTelemetry();

        const bare = { type: 'llm/retry', seq: 1, time: 1, data: {} };
        expect(() => ctx.emit({}, bare)).not.toThrow();
        expect(warns()).toHaveLength(1);
        expect(warns()[0].message).toContain('UNKNOWN');
    });
});

describe('retry telemetry: the message formatter', () => {
    it('renders ordinal + category + detail from the journal payload', () => {
        const text = describeLlmRetry(retryEvent(3).data);
        expect(text).toBe('attempt 3/5: TRANSPORT gateway SSE stream failed: Connection reset');
    });
});
