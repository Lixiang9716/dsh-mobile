/**
 * Typed JS shim over the C spike host's gateway bridge (contract/ v1.0.0).
 * Scenarios import this module instead of touching the raw __dshGatewayCall
 * seam: every primitive of contract/primitives.d.ts is exposed with its
 * frozen shape. Bytes travel base64 — encoded via the vendored upstream
 * package, decoded here (upstream ships no inverse). Rejections are
 * GatewayError {code, primitive, message}. The httpFetch response body is an
 * AsyncIterable fed by the host's http.body/http.end/http.error events for
 * the response's bodyId, abortable via __dshGatewayAbort.
 */
import { createLogger } from './logger.js';
import { bytesToBase64 } from 'dsh:util-crypto';

const log = createLogger('dsh.gateway');

/** Base64 alphabet for the inline decode side (upstream ships encode only). */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const b64Val = (c) => B64.indexOf(c);

const base64ToBytes = (text) => {
  log.debug('base64 decode', { chars: String(text).length });
  const clean = String(text).replace(/=+$/, '');
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const rem = clean.length - i;
    const n = (b64Val(clean[i]) << 18) | (b64Val(clean[i + 1]) << 12)
      | (b64Val(clean[i + 2] ?? 'A') << 6) | b64Val(clean[i + 3] ?? 'A');
    out.push((n >> 16) & 255);
    if (rem > 2) out.push((n >> 8) & 255);
    if (rem > 3) out.push(n & 255);
  }
  return new Uint8Array(out);
};

/** Structured rejection of a primitive call (contract §3 error codes). */
export class GatewayError extends Error {
  constructor(code, primitive, message) {
    super(message ?? `gateway ${primitive} failed (${code})`);
    this.name = 'GatewayError';
    this.code = code;
    this.primitive = primitive;
    log.debug('gateway error', { code, primitive });
  }
}

/** One bridge call: JSON-serialized args in, parsed JSON payload out.
 * Rejections are reshaped to GatewayError; unknown/absent codes pass
 * through untouched (receivers never fall back on a code they do not
 * know — fail-loud rule). */
const call = async (name, args) => {
  log.debug('gateway call', { name });
  try {
    return await globalThis.__dshGatewayCall(name, JSON.stringify(args));
  } catch (err) {
    throw new GatewayError(err?.code, name, err?.message);
  }
};

// ---- filesystem ----------------------------------------------------------

export const fsRead = async (scope, path) => {
  const res = await call('fsRead', { scope, path });
  return { bytes: base64ToBytes(res.bytesB64), mtime: res.mtime };
};

export const fsWrite = async (scope, path, bytes, opts = {}) => {
  const res = await call('fsWrite', {
    scope,
    path,
    bytesB64: bytesToBase64(bytes),
    append: opts.append ?? false,
    create: opts.create ?? true,
  });
  return { written: res.written };
};

export const fsScope = {
  persist: async (scope) => await call('fsScope.persist', { scope }),
  resolve: async (ref) => await call('fsScope.resolve', { ref }),
};

// ---- httpFetch (streaming response body) ---------------------------------

/** In-flight response-body streams keyed by bodyId. */
const streams = new Map();

const wake = (st) => {
  const pending = st.wake;
  st.wake = null;
  pending?.();
};

/** Consume one bridge event for a known body stream; false = not ours. */
const streamEvent = (ev) => {
  const st = streams.get(ev.callId);
  if (!st) return false;
  log.debug('body stream event', { event: ev.event, bodyId: ev.callId });
  if (ev.event === 'http.body') st.chunks.push(base64ToBytes(ev.chunkB64));
  else if (ev.event === 'http.end') st.done = true;
  else if (ev.event === 'http.error') {
    st.done = true;
    st.err = { code: ev.code, message: ev.message ?? 'http body failed' };
  } else return false;
  wake(st);
  return true;
};

const nextChunk = async (bodyId) => {
  const st = streams.get(bodyId);
  log.debug('body chunk wait', { bodyId, buffered: st.chunks.length });
  while (st.chunks.length === 0 && !st.done) {
    await new Promise((resolve) => (st.wake = resolve));
  }
  if (st.chunks.length > 0) return { value: st.chunks.shift(), done: false };
  if (st.err) throw new GatewayError(st.err.code, 'httpFetch', st.err.message);
  return { value: undefined, done: true };
};

export const httpFetch = async (url, init = {}) => {
  log.debug('httpFetch', { url, method: init.method ?? 'GET' });
  const res = await call('httpFetch', {
    url,
    method: init.method,
    headers: init.headers,
    bodyB64: init.body ? bytesToBase64(init.body) : undefined,
  });
  const bodyId = res.bodyId;
  streams.set(bodyId, { chunks: [], done: false, err: null, wake: null });
  return {
    status: res.status,
    headers: res.headers,
    body: { [Symbol.asyncIterator]: () => ({ next: () => nextChunk(bodyId) }) },
    abort: () => {
      log.debug('httpFetch abort', { bodyId });
      globalThis.__dshGatewayAbort?.(bodyId);
      const st = streams.get(bodyId);
      if (st && !st.done) {
        st.done = true;
        st.err = { code: 'cancelled', message: 'aborted by the caller' };
        wake(st);
      }
    },
  };
};

// ---- notifications / native UI / credentials ------------------------------

export const notify = async (payload) => await call('notify', payload);

export const presentApproval = async (req) => await call('presentApproval', req);

export const presentPicker = async (req) => await call('presentPicker', req);

export const keychainGet = async (ref) => {
  const res = await call('keychainGet', { ref });
  return res ? { secret: base64ToBytes(res.secretB64) } : null;
};

export const keychainSet = async (ref, secret) => await call('keychainSet', {
  ref,
  secretB64: secret ? bytesToBase64(secret) : null,
});

// ---- bridge event plumbing ------------------------------------------------

const listeners = new Set();

/** Subscribe to non-stream bridge events (app.state, notify.response,
 * host.info, ...). httpFetch body traffic is consumed by the shim itself. */
export const onEvent = (fn) => listeners.add(fn);

globalThis.__dshGatewayOnEvent = (eventJson) => {
  log.debug('gateway event', { chars: eventJson.length });
  const ev = JSON.parse(eventJson);
  if (!streamEvent(ev)) listeners.forEach((fn) => fn(ev));
};
