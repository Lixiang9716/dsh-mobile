import { describe, it, expect, vi } from 'vitest';
import { makeApiHandlerRespond, isWireError } from 'scenario/api-handler-respond.js';

// loop-w2: the malformed-but-valid-JSON session/prompt envelope (no args
// wrapper) made makePromptSession throw its structured `gateway/bad-request`
// (upstream/web-write.js:316) — and the drive legs treated EVERY handler
// rejection as a drive-killing defect WITHOUT posting any api.respond. On a
// resident seat the drive has long finished, the suppressed fail lands
// nowhere (scenario/scenario-verdict.js), and the HTTP caller waited the
// full RESPOND_TIMEOUT_MS — 30.0s — for the carrier's `gateway/unimplemented`
// timeout envelope (measured 2026-10-05: three malformed-envelope probes
// hung 30.0s each; well-formed payloads answered in 21-33ms). The guard
// answers EVERY thrown handler in band first, then fails the drive only for
// an UNSTRUCTURED throw.

// The thrown-value → wire-triple map, mirroring upstream/web-write.js:117
// errorOf's two pass-throughs (the adapter's remoteError shape and the
// vendored RemoteError marker) + the gateway/unavailable flatten. Injected
// into the guard in production; the real module's graph is the full write
// surface (too heavy to boot here), the mapping itself is unchanged and
// pre-existing — what this suite pins is the GUARD's control flow.
const wireErrorOf = (error) => {
  if (error && typeof error === 'object' && error.remote === true) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error && typeof error === 'object' && error.isDSHRemoteError === true
    && typeof error.code === 'string') {
    return { code: error.code, message: error.message, details: error.details ?? {} };
  }
  return {
    code: 'gateway/unavailable',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  };
};

// The exact shape makePromptSession throws for the malformed envelope
// (upstream/web-write.js:107 remoteError).
const badEnvelopeRejection = () => {
  const e = new Error('prompt request needs requestId, sessionId, mode, content');
  e.remote = true;
  e.code = 'gateway/bad-request';
  e.details = {};
  return e;
};

const harness = () => {
  const post = vi.fn();
  const fail = vi.fn();
  const onHandler = makeApiHandlerRespond({ post, fail, errorOf: wireErrorOf });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const msg = { rpcId: 'probe-1', endpoint: 'session/prompt' };
  return { post, fail, onHandler, settle, msg };
};

describe('the claimed-endpoint guard answers a structured refusal in band (loop-w2)', () => {
  it('the malformed-envelope bad-request posts the fast in-band error and never fails the drive', async () => {
    const { post, fail, onHandler, settle, msg } = harness();
    onHandler(msg, { run: async () => { throw badEnvelopeRejection(); } });
    await settle();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]).toEqual([{
      type: 'api.respond',
      rpcId: 'probe-1',
      result: {
        ok: false,
        error: {
          code: 'gateway/bad-request',
          message: 'prompt request needs requestId, sessionId, mode, content',
          details: {},
        },
      },
    }]);
    expect(fail).not.toHaveBeenCalled();
  });

  it('a vendored upstream RemoteError rejection answers in band the same way', async () => {
    const { post, fail, onHandler, settle, msg } = harness();
    const refused = { isDSHRemoteError: true, code: 'agent-preset/read-only',
      message: 'presets are read-only', details: {} };
    onHandler(msg, { run: async () => { throw refused; } });
    await settle();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0].result).toEqual({
      ok: false,
      error: { code: 'agent-preset/read-only', message: 'presets are read-only', details: {} },
    });
    expect(fail).not.toHaveBeenCalled();
  });
});

describe('the claimed-endpoint guard leaves the good envelope untouched (loop-w2)', () => {
  it('a resolution posts the ok:true value respond (the composer send\'s accepted frame)', async () => {
    const { post, fail, onHandler, settle, msg } = harness();
    onHandler(msg, { run: async () => ({ accepted: true }) });
    await settle();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]).toEqual([{
      type: 'api.respond',
      rpcId: 'probe-1',
      result: { ok: true, value: { accepted: true } },
    }]);
    expect(fail).not.toHaveBeenCalled();
  });
});

describe('the claimed-endpoint guard keeps unstructured defects fail-loud (loop-w2)', () => {
  it('an unexpected rejection answers the caller AND kills the drive with the historical message', async () => {
    const { post, fail, onHandler, settle, msg } = harness();
    onHandler(msg, { run: async () => { throw new TypeError('not a function'); } });
    await settle();
    // The caller is answered first — even a defect never black-holes a
    // connection.
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0].result.ok).toBe(false);
    expect(post.mock.calls[0][0].result.error.code).toBe('gateway/unavailable');
    expect(post.mock.calls[0][0].result.error.message).toBe('not a function');
    // Then the drive dies, naming the wire error triple exactly as before.
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail.mock.calls[0][0])
      .toBe('claimed endpoint session/prompt failed: gateway/unavailable: not a function');
  });

  it('a SYNCHRONOUS handler throw lands in the same leg — answered, then fail-loud', async () => {
    const { post, fail, onHandler, settle, msg } = harness();
    expect(() => onHandler(msg, {
      run: () => { throw new TypeError('sync boom'); },
    })).not.toThrow();
    await settle();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0].result.error).toEqual({
      code: 'gateway/unavailable', message: 'sync boom', details: {},
    });
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail.mock.calls[0][0])
      .toBe('claimed endpoint session/prompt failed: gateway/unavailable: sync boom');
  });
});

describe('isWireError splits the structured refusals from defects (loop-w2)', () => {
  it('the adapter remoteError shape and the vendored RemoteError marker are structured', () => {
    expect(isWireError({ remote: true, code: 'gateway/bad-request', message: 'm', details: {} }))
      .toBe(true);
    expect(isWireError({ isDSHRemoteError: true, code: 'session/not-found', message: 'm' }))
      .toBe(true);
  });

  it('errors, primitives, marker look-alikes, and non-string codes are unstructured', () => {
    expect(isWireError(new TypeError('boom'))).toBe(false);
    expect(isWireError(null)).toBe(false);
    expect(isWireError(undefined)).toBe(false);
    expect(isWireError('boom')).toBe(false);
    expect(isWireError({ remote: 'yes', code: 'x' })).toBe(false);
    expect(isWireError({ isDSHRemoteError: true, code: 42 })).toBe(false);
  });
});
