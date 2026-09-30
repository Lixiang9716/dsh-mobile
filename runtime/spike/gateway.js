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
  log.debug('fsRead', { scope, path });
  const res = await call('fsRead', { scope, path });
  return { bytes: base64ToBytes(res.bytesB64), mtime: res.mtime };
};

export const fsWrite = async (scope, path, bytes, opts = {}) => {
  log.debug('fsWrite', { scope, path });
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

// ---- filesystem additions (contract v1.1.0) -----------------------------
// What the upstream file service (@deepseek-ai/dsh-fs-local) needs on top of
// read/write: stat and list to resolve a target, mkdir + rename for its
// atomic-write path, remove for cleanup. A host that does not implement one
// of these answers `unavailable`, and the caller must treat that as a
// capability gap rather than an error to retry (contract/primitives.md §4).

/** `{ kind: "file" | "dir" | "other", size, mtime }`; a missing path is `io`. */
export const fsStat = async (scope, path) => await call('fsStat', { scope, path });

/** One directory level, sorted by name: `{ entries: [{ name, kind }] }`. */
export const fsList = async (scope, path) => await call('fsList', { scope, path });

/** Create a directory and any missing parents (`mkdir -p` by default). */
export const fsMkdir = async (scope, path, opts = {}) =>
  await call('fsMkdir', { scope, path, existing: opts.existing ?? 'ok' });

/** Remove a file, or a tree with `{ recursive: true }`. */
export const fsRemove = async (scope, path, opts = {}) => await call('fsRemove', {
  scope, path, recursive: opts.recursive ?? false, missing: opts.missing ?? 'ok',
});

/** Move within the scope; an existing destination is replaced (POSIX rename). */
export const fsRename = async (scope, from, to) =>
  await call('fsRename', { scope, from, to });

// ---- wasm (contract v1.2.0) ---------------------------------------------
// One export of one module, executed IN-PROCESS by the host's interpreter.
// iOS forbids JIT and this architecture refuses subprocesses (D2), so the
// alternative is no WebAssembly at all rather than a child process. The module
// talks back through the imported function `dsh.emit(ptr, len)`.

/** `{ result, output }`; a trap or a missing export is an `io` rejection. */
export const wasmRun = async (scope, path, func, input = '') =>
  await call('wasmRun', { scope, path, func, input });

// ---- ish (contract v1.3.0) ----------------------------------------------
// One program in the host's IN-PROCESS Linux userland. The guest is emulated
// instruction by instruction inside the app process (no child process, no
// second OS — D2), and (scope, path) names the directory the program starts in:
// the authorized workspace is mounted inside the guest, so a relative path the
// guest writes is a file the session sees.

/** `{ exitCode, stdout, stderr, timedOut, truncated }`. A non-zero exit status
 * is a result, not a rejection; only a command the guest cannot start rejects. */
export const ishRun = async (scope, path, argv, opts) =>
  await call('ishRun', {
    scope,
    path,
    argv: Array.isArray(argv) ? argv.map((item) => String(item)) : [],
    timeoutMs: Number.isFinite(opts?.timeoutMs) ? opts.timeoutMs : 0,
  });

// ---- httpFetch (streaming response body) ---------------------------------

/** In-flight response-body streams keyed by bodyId. */
const streams = new Map();

const wake = (st) => {
  log.debug('stream wake');
  const pending = st.wake;
  st.wake = null;
  pending?.();
};

/** Consume one bridge event for a known body stream; false = not ours. */
const streamEvent = (ev) => {
  // the bridge emits the numeric call id; streams are keyed by bodyId "body:N"
  const st = streams.get(ev.callId) ?? streams.get(`body:${ev.callId}`);
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
  log.debug('keychainGet', { ref });
  const res = await call('keychainGet', { ref });
  return res ? { secret: base64ToBytes(res.secretB64) } : null;
};

export const timerSchedule = async (delayMs, opts = {}) =>
  await call('timerSchedule', { delayMs, ...opts });

export const timerCancel = async (timerId) =>
  await call('timerCancel', { timerId });

// ---- the device plane (v1.5.0) --------------------------------------------

export const deviceInfo = async () => await call('deviceInfo', {});

export const haptic = async (pattern) => await call('haptic', { pattern });

export const clipboardRead = async () => await call('clipboardRead', {});

export const clipboardWrite = async (text) => await call('clipboardWrite', { text });

export const presentShare = async (payload) => await call('presentShare', payload);

export const keepAwake = async (hold) => await call('keepAwake', { hold });

export const keychainSet = async (ref, secret) => await call('keychainSet', {
  ref,
  secretB64: secret ? bytesToBase64(secret) : null,
});

// ---- the socket seam (contract v1.8.0) ------------------------------------
// Audited LOOPBACK-ONLY TCP under the adopted proposal's five-rule model:
// direction grading (listen vs connect), the narrowest-scope default
// (`loopback` is v1.8.0's only scope), family-flag grants, one gateway audit
// record per listen/connect/accept, session-scoped grants. The data face
// rides the same gateway bridge (socketWrite/socketEnd/socketClose — the
// proposal's connection face) while the pump's poll is the one host
// intrinsic (the same child-process/pty split: the JS pump turns the poll
// into the data/close event sequence, D8). A host without the seam answers
// `unavailable` — a capability gap, not a retryable error.

/** `{ serverId, port } | null`; omitting `port` lets the host pick (the
 * resolved port is the source of truth). `null` = the user refused. */
export const socketListen = async (request) =>
  await call('socketListen', { scope: 'loopback', ...request });

/** `{ connectionId } | null`; host is the literal 127.0.0.1 in v1.8.0. */
export const socketConnect = async (request) =>
  await call('socketConnect', { scope: 'loopback', host: '127.0.0.1', ...request });

/** `{ written, buffered }` — `buffered` > 0 is the host parking the refused
 * tail in the slot's backpressure buffer (it drains on the pump ticks). */
export const socketWrite = async (connectionId, bytes) => {
  log.debug('socketWrite', { connectionId, bytes: bytes.byteLength });
  const res = await call('socketWrite', {
    connectionId,
    bytesB64: bytesToBase64(bytes),
  });
  return { written: res.written, buffered: res.buffered ?? 0 };
};

/** Half-close: the peer reads the trailing bytes then sees EOF. */
export const socketEnd = async (connectionId) =>
  await call('socketEnd', { connectionId });

/** Close a server (`{ id }`) or a connection (`{ connectionId }`). */
export const socketClose = async (ref) =>
  await call('socketClose', ref.connectionId !== undefined
    ? { id: ref.connectionId }
    : ref);

// ---- the system capability plane: camera (proposal v1.10.0) ---------------
// The capture burst is the v1 implementation face; photos land in the host's
// capture scope (the v1.5.0 media-picker read-through posture) and ride the
// fs primitives like any file. The recording shape is specified and PHASED:
// its implementation follows as its own change, so hosts register the two
// control rows to answer `unavailable` (the honest declaration — contract
// §1), and the descriptor's unavailable array names them. User refusal at
// either consent layer resolves null; a device without a camera rejects
// `unavailable`.

/** One capture burst: `{ photos: CapturedPhoto[] }`, or null on refusal. */
export const cameraCapture = async (request = {}) => await call('cameraCapture', {
  count: request.count,
  format: request.format,
  flash: request.flash,
  maxBytes: request.maxBytes,
  tag: request.tag,
});

/** Phased shape: `{ recordingId }`, or null on refusal — answers
 * `unavailable` until the recording line lands. */
export const cameraRecordStart = async (request = {}) => await call('cameraRecordStart', {
  maxDurationMs: request.maxDurationMs,
  withAudio: request.withAudio,
});

/** Phased shape: `{ recording: CapturedPhoto }` — answers `unavailable`
 * until the recording line lands. */
export const cameraRecordStop = async (recordingId) =>
  await call('cameraRecordStop', { recordingId });

export const bleScanStart = async (request = {}) => await call('bleScanStart', {
  serviceUuids: request.serviceUuids,
  timeoutMs: request.timeoutMs,
  tag: request.tag,
});

export const bleScanStop = async (scanId) => await call('bleScanStop', { scanId });

export const bleConnect = async (deviceId) => await call('bleConnect', { deviceId });

export const bleDisconnect = async (connectionId) =>
  await call('bleDisconnect', { connectionId });

export const bleRead = async (connectionId, service, characteristic) => {
  log.debug('bleRead', { connectionId, service, characteristic });
  const res = await call('bleRead', { connectionId, service, characteristic });
  return { bytes: base64ToBytes(res.bytesB64) };
};

export const bleWrite = async (connectionId, service, characteristic, bytes, opts = {}) =>
  await call('bleWrite', {
    connectionId,
    service,
    characteristic,
    bytesB64: bytesToBase64(bytes),
    response: opts.response ?? true,
  });

export const bleSubscribe = async (connectionId, service, characteristic) =>
  await call('bleSubscribe', { connectionId, service, characteristic });

export const bleUnsubscribe = async (connectionId, service, characteristic) =>
  await call('bleUnsubscribe', { connectionId, service, characteristic });

// ---- bridge event plumbing ------------------------------------------------

const listeners = new Set();

/** Subscribe to non-stream bridge events (app.state, notify.response,
 * host.info, ble.event, ...). httpFetch body traffic is consumed by the
 * shim itself. Returns the unsubscribe function. */
export const onEvent = (fn) => {
  listeners.add(fn);
  return () => {
    log.debug('event unsubscribe');
    listeners.delete(fn);
  };
};

globalThis.__dshGatewayOnEvent = (eventJson) => {
  log.debug('gateway event', { chars: eventJson.length });
  const ev = JSON.parse(eventJson);
  // The bridge carries GATT payloads base64 (the frozen transport
  // convention); the §7 event shape the consumer sees is `bytes`.
  if (ev?.event === 'ble.event' && ev.kind === 'notify' && ev.bytesB64) {
    ev.bytes = base64ToBytes(ev.bytesB64);
    delete ev.bytesB64;
  }
  if (!streamEvent(ev)) listeners.forEach((fn) => fn(ev));
};
