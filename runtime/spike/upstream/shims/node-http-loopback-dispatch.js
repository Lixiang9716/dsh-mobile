// dsh:logging-exempt (shim layer; no logging surface in the hot path)
/**
 * shims/node-http-loopback-dispatch.js — the fetch-side dispatch of the
 * loopback shim (dispatchLoopback + the request/response exchange), split
 * out of node-http-loopback.js when that file crossed the code-size budget.
 * The server registry and the Incoming/Response classes stay the single
 * source of truth in node-http-loopback.js (imported here; the cycle is
 * call-time-only).
 */
import {
  registry,
  keyFor,
  toBytes,
  hostFor,
  nextTick,
  LoopbackIncoming,
  LoopbackServerResponse,
  pinnedHttpLookups,
} from 'upstream/shims/node-http-loopback.js';
import { encodeFormData } from 'upstream/shims/web-multipart.js';
import { gunzipSync } from 'upstream/shims/node-zlib.js';
import { EventEmitter } from 'upstream/shims/events.js';
import { encodeUtf8, decodeUtf8 } from 'upstream/shims/buffer.js';

/** ===== Upgrade-gate helpers (local copies) ================================
 * serverUpgradeIngress/clientUpgradeAwait moved here from the client module
 * in the size-budget split, but their helpers stayed there as free
 * variables — module bindings are not globals, so the first gate that ever
 * RAN in this file died on `parseHttpHead is not defined` (W8: the
 * net.connect raw-dial face is that first caller). Local definitions; the
 * client module keeps its own.
 * ======================================================================== */
const HEADER_END = '\r\n\r\n';

/** Index of the header-terminator start across buffered chunks, or -1. */
const findHeaderEnd = (chunks, totalLength) => {
  if (chunks.length === 0) return -1;
  const whole = chunks.length === 1 ? chunks[0] : (() => {
    const all = new Uint8Array(totalLength);
    let at = 0;
    for (const c of chunks) { all.set(c, at); at += c.byteLength; }
    return all;
  })();
  const marker = encodeUtf8(HEADER_END);
  outer: for (let i = 0; i + marker.length <= whole.length; i++) {
    for (let j = 0; j < marker.length; j++) {
      if (whole[i + j] !== marker[j]) continue outer;
    }
    return i;
  }
  return -1;
};

const concatChunks = (chunks, totalLength) => {
  if (chunks.length === 1) return chunks[0];
  const all = new Uint8Array(totalLength);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return all;
};

/** Parse one HTTP request/response head (bytes BEFORE the terminator) into
 * {firstLine, headers, rawHeaders} — header names lowercase in the bag, the
 * last value winning per header name. */
const parseHttpHead = (headBytes) => {
  const text = decodeUtf8(headBytes);
  const lines = text.split('\r\n');
  const firstLine = lines[0];
  const headers = Object.create(null);
  const rawHeaders = [];
  for (const line of lines.slice(1)) {
    if (line.length === 0) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    rawHeaders.push(name, value);
    headers[name.toLowerCase()] = value;
  }
  return { firstLine, headers, rawHeaders };
};

/** The transparent content-decoding face (W8): real fetch decodes the
 * `content-encoding` the server applied (the webserver gzip arm asserts the
 * PLAINTEXT body after requesting compression). gzip rides the one-shot
 * fflate face — the corpus's compressed bodies are complete-at-end plain
 * payloads (SSE is excluded from compression by the webserver's own
 * filter), so the decoded stream serves the whole payload on close. */
const decodeContentEncoding = (body, encoding) => {
  if (encoding !== 'gzip') return body; // deflate/br never negotiated in the corpus
  return new ReadableStream({
    start(controller) {
      const reader = body.getReader();
      const chunks = [];
      let total = 0;
      const pump = () => reader.read().then(({ done, value }) => {
        if (done) {
          if (total > 0) {
            const whole = new Uint8Array(total);
            let at = 0;
            for (const chunk of chunks) { whole.set(chunk, at); at += chunk.byteLength; }
            const out = gunzipSync(whole);
            const bytes = out instanceof Uint8Array ? out : new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
            controller.enqueue(globalThis.Buffer ? globalThis.Buffer.from(bytes) : bytes);
          }
          controller.close();
          return;
        }
        chunks.push(value instanceof Uint8Array ? value : new Uint8Array(value));
        total += chunks[chunks.length - 1].byteLength;
        return pump();
      });
      pump().catch((error) => {
        try { controller.error(error); } catch { /* already closed */ }
      });
    },
  });
};

/** The fetch-side entry: dispatch `url` through a registered loopback server
 * when one matches; returns undefined so the caller keeps its own behavior
 * (fail-loud or gateway) for everything else. `options.requestUrlOverride`
 * serves the PROXY shape (undici shim): the dial goes to the proxy server's
 * host:port while the request line carries the ABSOLUTE target URL — what a
 * real HTTP proxy receives, and what the egress specs' in-test proxy records. */
/** The pinned-lookup consult (W8): resolve the hostname through each
 * registered node:http Agent resolver; a loopback answer with a live
 * in-process server on the port re-dials that address (the real connect
 * target). Async — the resolvers are callback-style — so this returns a
 * promise, or undefined when no resolver is registered at all. */
const isLoopbackAddress = (address) => address === '::1' || address === '127.0.0.1' || address.startsWith('127.');

const dispatchPinnedHttp = (parsed, init, options) => {
  if (pinnedHttpLookups.size === 0) return undefined;
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
  const hostname = hostFor(parsed);
  const resolveOne = (lookup) => new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    try {
      lookup(hostname, { all: false }, (error, address) => {
        if (error !== undefined && error !== null) return finish(undefined);
        if (typeof address === 'string') return finish(address);
        if (Array.isArray(address) && typeof address[0]?.address === 'string') return finish(address[0].address);
        finish(undefined);
      });
      // A resolver that never calls back must not wedge the dispatch — real
      // DNS resolves or errors; this face budgets one macrotask second.
      setTimeout(() => finish(undefined), 1000);
    } catch {
      finish(undefined);
    }
  });
  return (async () => {
    for (const lookup of pinnedHttpLookups) {
      const address = await resolveOne(lookup);
      if (address === undefined || !isLoopbackAddress(address)) continue;
      const pinnedHost = address === '::1' ? '[::1]' : '127.0.0.1';
      const pinnedHref = `http://${pinnedHost}${parsed.port === '' ? '' : `:${parsed.port}`}${parsed.pathname}${parsed.search}`;
      let pinnedParsed;
      try {
        pinnedParsed = new globalThis.URL(pinnedHref);
      } catch {
        continue;
      }
      const pinnedRecord = registry.get(keyFor(hostFor(pinnedParsed), port));
      if (!pinnedRecord || !pinnedRecord.server.listening) continue;
      return dispatchLoopback(pinnedHref, init, { ...options, __dshPinnedHop: true });
    }
    return undefined;
  })();
};
export const dispatchLoopback = (input, init = {}, options = {}) => {
  let urlString;
  try {
    urlString = typeof input === 'string' ? input : (String(input?.url ?? input));
  } catch {
    return undefined;
  }
  let parsed;
  try {
    parsed = new globalThis.URL(urlString);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
  const record = registry.get(keyFor(hostFor(parsed), port));
  if ((!record || !record.server.listening) && options.__dshPinnedHop !== true) {
    // Registry miss under a PINNING AGENT (W8): a node:http request whose
    // agent carries a DNS lookup dials the RESOLVED address, not the URL
    // host — the session-telemetry egress suite pins its collector hostname
    // to 127.0.0.1 exactly that way. Consult the registered resolvers; a
    // loopback answer with a live in-process server on the port is the
    // address a real connect would have dialed. The hop flag keeps the
    // rewritten dial from re-entering this branch.
    const pinned = dispatchPinnedHttp(parsed, init, options);
    if (pinned !== undefined) return pinned;
  }
  if (!record || !record.server.listening) return undefined;

  // A FormData body serializes to its multipart byte stream first (real
  // fetch encodes it inside the engine; the Files API upload family depends
  // on the bytes + the boundary content-type reaching the in-test server).
  const rawBody = init?.body;
  if (rawBody !== null && rawBody !== undefined && typeof globalThis.FormData === 'function'
    && rawBody instanceof globalThis.FormData) {
    return encodeFormData(rawBody).then((encoded) => dispatchParsed(parsed, init, options, encoded.bytes, encoded.contentType));
  }
  return dispatchParsed(parsed, init, options, toBytes(rawBody), undefined);
};

/** The resolved-body half of the dispatch (dispatchLoopback above resolves
 * the URL, the registry record, and any FormData encoding first). */
/** The response header callback (module level for size): redirect:'error'
 * rejects 3xx as the fetch-level TypeError; default 'follow' re-dispatches
 * through the registry to the Location target — 307/308 preserve
 * method+body, 301/302/303 degrade a non-GET to GET without a body (the
 * fetch spec's change-method rule), and a host change strips the credential
 * pair. The web-search-deepseek redirect spec drives exactly this face (its
 * 307 must forward the POST body). */
const onLoopbackHeaders = (ctx) => (status, headerObject) => {
  const { parsed, init, options, requestUrl, method, headers, bodyBytes, formDataType, body, settled, resolve, reject } = ctx;
  if (settled.get()) return;
  if (init?.redirect === 'error' && [301, 302, 303, 307, 308].includes(status)) {
    settled.set();
    reject(new TypeError(`fetch: redirect for ${requestUrl} (redirect: 'error')`));
    return;
  }
  const locationValue = headerObject?.location ?? headerObject?.Location;
  if ((init?.redirect ?? 'follow') === 'follow'
    && [301, 302, 303, 307, 308].includes(status) && locationValue) {
    if ((options.redirectCount ?? 0) >= 20) {
      settled.set();
      reject(new TypeError('fetch: too many redirects'));
      return;
    }
    let nextParsed;
    try {
      nextParsed = new globalThis.URL(locationValue, parsed.href);
    } catch {
      settled.set();
      reject(new TypeError(`fetch: invalid redirect location ${locationValue}`));
      return;
    }
    settled.set(); // the redirect hop owns the outcome now
    const keepMethod = status === 307 || status === 308;
    const nextMethod = keepMethod ? method : 'GET';
    const nextInit = { ...init, method: nextMethod };
    const nextBody = keepMethod ? bodyBytes : undefined;
    if (!keepMethod) nextInit.body = undefined;
    if (hostFor(nextParsed) !== hostFor(parsed)) {
      nextInit.headers = Object.fromEntries(Object.entries({ ...headers })
        .filter(([name]) => name !== 'authorization' && name !== 'cookie'));
    }
    resolve(dispatchParsed(nextParsed, nextInit, { ...options, redirectCount: (options.redirectCount ?? 0) + 1 }, nextBody, formDataType));
    return;
  }
  settled.set();
  const contentEncoding = String(headerObject?.['content-encoding'] ?? headerObject?.['Content-Encoding'] ?? '').trim().toLowerCase();
  resolve(new globalThis.Response(decodeContentEncoding(body, contentEncoding), {
    status,
    statusText: ctx.response.statusMessage ?? '',
    headers: headerObject,
    url: String(parsed.href),
  }));
};

/** Collect the request headers (module level for size): a Headers-like
 * bag or a record, lowercased. */
const collectRequestHeaders = (source, headerBag) => {
  if (!source) return;
  if (typeof source.forEach === 'function') {
    source.forEach((value, name) => headerBag.set(String(name).toLowerCase(), String(value)));
    return;
  }
  for (const [name, value] of Object.entries(source)) {
    headerBag.set(String(name).toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
  }
};

/** The dispatch core (module level for size): builds the request/response
 * pair over one registry record and runs the handler inside a promise the
 * headers/destroy/abort outcomes settle. `settled` is a tiny gate object —
 * the header callback and the abort listener both own the outcome. */
/** Wire the abort signal (module level for size): a pre-aborted signal
 * rejects immediately; a live one errors the body stream, destroys the
 * response server-side (the in-test server observes 'close'), and rejects
 * unless the headers callback already owned the outcome. */
const wireLoopbackAbort = (signal, captured, response, settled, reject, abortError) => {
  if (signal.aborted) {
    settled.set();
    reject(abortError());
    return;
  }
  signal.addEventListener('abort', () => {
    try { captured.error(abortError()); } catch { /* body already closed */ }
    response.destroy(); // server-side 'close' — the in-test server observes this
    if (!settled.get()) {
      settled.set();
      reject(abortError());
    }
  });
};

/** Run the server's CURRENT 'request' listeners (module level for size):
 * node dispatches a request through the 'request' event — createServer(handler)
 * registers the handler AS a listener, so an in-test swap
 * (removeAllListeners('request') + on('request', ...)) takes effect (the
 * web-fetch-http proxy spec's cross-origin redirect test drives exactly
 * this, W7-Y2). A promise return has its rejection routed to the fetch
 * promise; with zero listeners the record's constructor handler keeps
 * answering (the pre-listener-face contract). beginReplay starts the
 * request's recorded-byte delivery. */
const runLoopbackHandler = (record, request, response, settled, reject) => {
  try {
    let result;
    const listeners = typeof record.server?.listeners === 'function'
      ? record.server.listeners('request')
      : [];
    if (listeners.length > 0) {
      for (const fn of listeners) {
        const value = fn.call(record.server, request, response);
        if (result === undefined && value && typeof value.catch === 'function') result = value;
      }
    } else {
      const value = record.handler(request, response);
      if (value && typeof value.catch === 'function') result = value;
    }
    if (result !== undefined) {
      result.catch((error) => {
        if (settled.get()) return;
        settled.set();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    }
    request.beginReplay();
  } catch (error) {
    if (settled.get()) return;
    settled.set();
    reject(error instanceof Error ? error : new Error(String(error)));
  }
};

const dispatchParsed = (parsed, init, options, bodyBytes, formDataType) => {
  const record = registry.get(keyFor(hostFor(parsed), parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port)));
  const method = String(init?.method ?? 'GET').toUpperCase();
  const headerBag = new Map();
  collectRequestHeaders(init?.headers, headerBag);
  // W8: a real HTTP client always sends the Host header (HTTP/1.1 requires
  // it). The vendored gateway's Host/Origin fence reads request.headers.host
  // and 403'd every /api request without it. WHATWG spelling: no default
  // port on the value.
  if (!headerBag.has('host')) headerBag.set('host', parsed.host);
  if (formDataType !== undefined && !headerBag.has('content-type')) headerBag.set('content-type', formDataType);

  const requestUrl = options.requestUrlOverride ?? `${parsed.pathname}${parsed.search}`;
  if (init?.body !== undefined && init.body !== null && !headerBag.has('content-length')) {
    headerBag.set('content-length', String(bodyBytes.byteLength));
  }
  const headers = Object.fromEntries(headerBag);
  const signal = init?.signal;

  return new Promise((resolve, reject) => {
    let captured = null;
    const body = new ReadableStream({
      start: (controller) => { captured = controller; },
    });
    const abortError = () => {
      const error = new (globalThis.DOMException ?? Error)('This operation was aborted');
      error.name = 'AbortError';
      return error;
    };
    let done = false;
    const settled = { get: () => done, set: () => { done = true; } };
    // Headers resolve the fetch (real HTTP timing); the body stream keeps
    // living until end/destroy. See LoopbackServerResponse.#maybeHeaders.
    const response = new LoopbackServerResponse(captured, (status, headerObject) => {
      onLoopbackHeaders({ parsed, init, options, requestUrl, method, headers, bodyBytes, formDataType, body, settled, resolve, reject, response })(status, headerObject);
    }, (error) => {
      // Destroyed before headers: real fetch rejects (the socket died).
      if (settled.get()) return;
      settled.set();
      reject(error ?? new Error('response destroyed before headers'));
    });
    const request = new LoopbackIncoming({ method, url: requestUrl, headers, body: globalThis.Buffer ? globalThis.Buffer.from(bodyBytes ?? new Uint8Array(0)) : (bodyBytes ?? new Uint8Array(0)) });
    // The reset face: `connection_reset` behaviors tear the request socket
    // down (llm-mock-server's `request.socket.destroy()`), which on the wire
    // is a client-side ECONNRESET — the adapter classifies it TRANSPORT.
    request.socket = {
      destroy: (error) => response.destroy(error ?? new Error('socket hang up')),
    };
    // node's res.socket points at the connection — the vendored webserver's
    // gzip middleware gates on `res.socket === void 0` ("socket-backed"
    // responses only; W8). A socket-level destroy tears the exchange down.
    response.socket = request.socket;
    if (signal) wireLoopbackAbort(signal, captured, response, settled, reject, abortError);
    runLoopbackHandler(record, request, response, settled, reject);
  });
};

// The HTTP upgrade + client-request face lives in node-http-loopback-client.js
// (the file crossed the size budget); re-exported so bare-importers keep shape.

// The upgrade ingress/refusal/await helpers serve the client module's
// dispatchUpgradeRequest (the registry read is call-time).

const serverUpgradeIngress = (record, serverHalf) => {
  let buffered = [];
  let total = 0;
  serverHalf._installGate((bytes) => {
    buffered.push(bytes);
    total += bytes.byteLength;
    const at = findHeaderEnd(buffered, total);
    if (at === -1) return new Uint8Array(0); // head incomplete — keep gating
    const whole = concatChunks(buffered, total);
    const headBytes = whole.slice(0, at);
    const rest = whole.slice(at + HEADER_END.length);
    const { firstLine, headers, rawHeaders } = parseHttpHead(headBytes);
    const firstSpace = firstLine.indexOf(' ');
    const lastSpace = firstLine.lastIndexOf(' ');
    const method = firstSpace === -1 ? 'GET' : firstLine.slice(0, firstSpace);
    const url = firstSpace === -1 ? '/' : firstLine.slice(firstSpace + 1, lastSpace === -1 ? firstLine.length : lastSpace);
    const incoming = new LoopbackIncoming({ method, url, headers, body: [] });
    incoming.rawHeaders = rawHeaders;
    incoming.complete = true;
    incoming.readable = false;
    if (record.server.listenerCount('upgrade') === 0) {
      serverHalf.write(serializeRefusalHead());
      serverHalf.end();
      return new Uint8Array(0);
    }
    serverHalf._releaseGate();
    record.server.emit('upgrade', incoming, serverHalf, rest);
    return new Uint8Array(0);
  });
};

/** The refusal head (node: an upgrade request with no upgrade listener). */
const serializeRefusalHead = () => 'HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n';

/** The CLIENT-side handshake: parse the 101 (or any final status) off the
 * client half and emit `req.emit('upgrade', res, socket, head)` the way
 * node's http client does. A non-101 becomes a plain 'response'. */
const clientUpgradeAwait = (clientHalf, req) => {
  let buffered = [];
  let total = 0;
  clientHalf._installGate((bytes) => {
    buffered.push(bytes);
    total += bytes.byteLength;
    const at = findHeaderEnd(buffered, total);
    if (at === -1) return new Uint8Array(0);
    const whole = concatChunks(buffered, total);
    const headBytes = whole.slice(0, at);
    const rest = whole.slice(at + HEADER_END.length);
    const { firstLine, headers, rawHeaders } = parseHttpHead(headBytes);
    const statusCode = Number(firstLine.split(' ')[1] ?? 0);
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.statusMessage = firstLine.split(' ').slice(2).join(' ');
    res.headers = headers;
    res.rawHeaders = rawHeaders;
    res.resume = () => res;
    res.pause = () => res;
    clientHalf._releaseGate();
    if (statusCode === 101) {
      req.emit('upgrade', res, clientHalf, rest);
    } else {
      const incoming = new LoopbackIncoming({ method: 'GET', url: '/', headers, body: rest.byteLength > 0 ? [globalThis.Buffer ? globalThis.Buffer.from(rest) : rest] : [] });
      incoming.statusCode = statusCode;
      incoming.statusMessage = res.statusMessage;
      incoming.rawHeaders = rawHeaders;
      req.emit('response', incoming);
      incoming.beginReplay();
    }
    return new Uint8Array(0);
  });
};

/** The upgrade dispatch behind http.request for Upgrade-shaped calls:
 * serialize the client head, pair the halves against the registry record,
 * and return the req whose 'upgrade' event the vendored ws client awaits.
 * The caller's `opts.createConnection` is deliberately bypassed: this
 * runtime has no net.connect seam, and the loopback IS the transport. */
export { serverUpgradeIngress, serializeRefusalHead, clientUpgradeAwait };

/** ===== The RAW net.connect loopback face (W8, 2026-09-29) ================
 * The webserver spec drives its upgrade routes over a RAW socket
 * (`net.connect(port, '127.0.0.1')` + a hand-rolled HTTP request head), the
 * same wire shape a real client would dial. LoopbackNetSocket is a paired
 * in-memory byte pipe like pipe(2) — no OS socket, nothing leaves the
 * process (D2 holds): the client half is what the caller holds, the server
 * half rides the registry record through serverUpgradeIngress (the same
 * head-parsing ingress the http.request UPGRADE branch uses, so 'upgrade'
 * emission and the 501 refusal behave identically on both dials).
 * ======================================================================== */
class LoopbackNetSocket extends EventEmitter {
  #peer = null;
  #pending = [];
  #draining = false;
  #paused = false;
  #ended = false;
  #destroyed = false;
  #gate = null;
  remoteAddress = '127.0.0.1';
  remotePort = 0;
  localPort = 0;
  static _pair(a, b) {
    a.#peer = b;
    b.#peer = a;
    a.remotePort = b.localPort;
    b.remotePort = a.localPort;
  }
  get destroyed() { return this.#destroyed; }
  get readable() { return !this.#destroyed; }
  get writable() { return !this.#destroyed && !this.#ended; }
  connect(options, callback) {
    if (typeof callback === 'function') this.once('connect', callback);
    return this;
  }
  write(chunk, encodingOrCb, maybeCb) {
    const cb = typeof encodingOrCb === 'function' ? encodingOrCb : maybeCb;
    if (this.#destroyed || this.#ended) {
      const error = new Error('write after end');
      if (cb) nextTick(cb, error);
      else this.emit('error', error);
      return false;
    }
    this.#peer.#pending.push(toBytes(chunk));
    this.#peer.#schedule();
    if (cb) nextTick(cb);
    return true;
  }
  cork() {}
  uncork() {}
  end(chunk, cb) {
    if (chunk !== undefined && chunk !== null) this.write(chunk);
    this.#ended = true;
    if (typeof cb === 'function') nextTick(cb);
    const peer = this.#peer;
    nextTick(() => {
      if (!peer.#destroyed) peer.emit('end');
    });
    return this;
  }
  pause() { this.#paused = true; return this; }
  resume() {
    this.#paused = false;
    this.#schedule();
    return this;
  }
  destroy(error) {
    if (this.#destroyed) return this;
    this.#destroyed = true;
    this.#pending.length = 0;
    const peer = this.#peer;
    peer.#destroyed = true;
    peer.#pending.length = 0;
    if (error !== undefined && error !== null) this.emit('error', error);
    nextTick(() => {
      this.emit('close');
      peer.emit('close');
    });
    return this;
  }
  setTimeout() { return this; }
  setNoDelay() {}
  setKeepAlive() {}
  unref() {}
  ref() {}
  _installGate(gate) {
    this.#gate = gate;
    this.#schedule();
  }
  _releaseGate() {
    this.#gate = null;
    this.#schedule();
  }
  #schedule() {
    if (this.#draining) return;
    this.#draining = true;
    queueMicrotask(() => {
      this.#draining = false;
      this.#drain();
    });
  }
  #drain() {
    if (this.#destroyed) return;
    while (!this.#paused && !this.#destroyed && this.#pending.length > 0) {
      const bytes = this.#pending.shift();
      if (this.#gate !== null) {
        const leftover = this.#gate(bytes);
        if (leftover !== undefined && leftover.byteLength > 0) {
          this.#pending.unshift(leftover);
        }
        if (this.#gate !== null) return; // still gated — a partial head waits for more bytes
      } else {
        this.emit('data', globalThis.Buffer ? globalThis.Buffer.from(bytes) : bytes);
      }
    }
  }
}

/** The net.connect face over the loopback registry: connect(port[, host]),
 * connect(path) (a unix path is never registered — ECONNREFUSED), and
 * connect(options[, callback]). The 'connect'/'ready' pair fires on the
 * next macrotask like a real dial. */
export const connectLoopbackNet = (...args) => {
  let options = {};
  let callback;
  const first = args[0];
  if (typeof first === 'number') {
    options.port = first;
    for (const arg of args.slice(1)) {
      if (typeof arg === 'string') options.host = arg;
      else if (typeof arg === 'object' && arg !== null) options = { ...arg, port: first };
      else if (typeof arg === 'function') callback = arg;
    }
  } else if (first && typeof first === 'object') {
    options = first;
    for (const arg of args.slice(1)) {
      if (typeof arg === 'function') callback = arg;
    }
  } else {
    // node treats a non-options first argument (a path string) as a pipe path
    options = { path: String(first ?? '') };
  }
  const port = Number(options.port ?? 0);
  const host = String(options.host ?? '127.0.0.1');
  const socket = new LoopbackNetSocket();
  socket.localPort = port;
  if (typeof callback === 'function') socket.once('connect', callback);
  nextTick(() => {
    const record = registry.get(keyFor(host, port));
    if (!record || !record.server.listening) {
      const error = new Error(`connect ECONNREFUSED ${host}:${port}`);
      error.code = 'ECONNREFUSED';
      error.errno = -61;
      error.syscall = 'connect';
      error.address = host;
      error.port = port;
      socket.emit('error', error);
      nextTick(() => socket.emit('close'));
      return;
    }
    const serverHalf = new LoopbackNetSocket();
    serverHalf.localPort = port;
    LoopbackNetSocket._pair(socket, serverHalf);
    serverUpgradeIngress(record, serverHalf);
    socket.emit('connect');
    socket.emit('ready');
  });
  return socket;
};
