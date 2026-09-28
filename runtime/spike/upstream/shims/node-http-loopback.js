// dsh:logging-exempt (shim layer; no logging surface in the hot path)
/**
 * node-http-loopback — the IN-PROCESS HTTP loopback the upstream suite's
 * in-test servers run on (measured 2026-09-28: ~41 residual failures across
 * llm-deepseek/llm-pi-ai/sdk-server/subagent-codex build `http.createServer`
 * servers on 127.0.0.1 and point the product's `fetch` at them).
 *
 * There is still NO SOCKET SEAM (rule D2 for subprocesses; the socket gate
 * is the same design line): nothing ever binds a real port, dials a real
 * interface, or leaves this process. `listen` REGISTERs the server under its
 * host:port in a process-local table; a matching `fetch` is dispatched
 * straight through the registered handler with node-shaped
 * IncomingMessage/ServerResponse faces. Unmatched targets keep the existing
 * fail-loud fetch (no silent network plan change).
 *
 * Faces (the corpus's measured usage — helpers.ts/mock-server.ts/
 * plugin-apply.spec.ts/deepseek-responses-bridge.ts):
 *   - server.listen(0, '127.0.0.1'[, cb]) — port 0 takes an ephemeral from
 *     the IANA dynamic range (a counter; uniqueness is process-local),
 *     'listening' fires on the next macrotask (the specs `await once(server,
 *     'listening')` or pass a listen callback).
 *   - server.address() → { address, family, port }; close(cb) → 'close';
 *     closeAllConnections() → no-op (there are no sockets to close).
 *   - request: method/url(lowercased headers)/EventEmitter('data','end')/
 *     async-iterable body of Buffers.
 *   - response: statusCode/setHeader/writeHead(status[,reason][,headers])/
 *     write/end/destroy + 'finish'/'close' events; write() enqueues into the
 *     live response body stream so SSE cadence (delayMs timers) survives.
 */

import { EventEmitter } from 'upstream/shims/events.js';
import { encodeUtf8, decodeUtf8 } from 'upstream/shims/buffer.js';
import { encodeFormData } from 'upstream/shims/web-multipart.js';

/** host:port → server record. Key spelling: lowercased host, numeric port. */
const registry = new Map();
/** Ephemeral port allocator (listen(0)); IANA dynamic range start. */
let nextEphemeralPort = 49152;

const keyFor = (host, port) => `${String(host).toLowerCase()}:${port}`;

/** The registry host spelling of a parsed URL. WHATWG `hostname` strips the
 * IPv6 brackets ('[::1]' → '::1'); the URL shim keeps them, so strip here —
 * a listen record is keyed by the bare host spelling (W4-N: the mock-server
 * IPv6 listener test dials `http://[::1]:port`). */
const hostFor = (parsed) => {
  const h = parsed.hostname;
  return typeof h === 'string' && h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
};

const nextTick = (fn) => {
  if (typeof globalThis.setTimeout === 'function') setTimeout(fn, 0);
  else Promise.resolve().then(fn);
};

const toBytes = (value) => {
  if (value === undefined || value === null) return new Uint8Array(0);
  if (typeof value === 'string') return encodeUtf8(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'object' && typeof value.toString === 'function') return encodeUtf8(String(value));
  throw new TypeError(`loopback request body: unsupported ${typeof value}`);
};

/** The IncomingMessage face: node's request minus the socket. The body is
 * fully known at dispatch (the fetch caller already sent it), so the face
 * REPLAYS it to each consumption style independently: 'data'/'end' fire on
 * the next tick after the handler's first (so `.on('data')` registrations
 * inside the handler win) and the async iterator serves the same bytes for
 * `for await` consumers. Mixing the two styles double-reads — node forbids
 * that shape anyway, and the corpus never mixes. */
class LoopbackIncoming extends EventEmitter {
  constructor({ method, url, headers, body }) {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.rawHeaders = [];
    // node's IncomingMessage.headersDistinct: the same bag keyed to ARRAYS
    // (the webhook-github handler's requiredHeader reads headersDistinct[name]
    // and requires exactly one value — wave 5, measured off its spec).
    this.headersDistinct = Object.fromEntries(
      Object.entries(headers ?? {}).map(([name, value]) => [name, Array.isArray(value) ? value : [value]]),
    );
    this.statusCode = undefined;
    this.complete = false;
    this.readable = true;
    this.#body = body;
    this.#replayed = false;
  }
  #body;
  #replayed;
  #encoding;
  #ended;
  setTimeout() { return this; }
  /** The readable-stream no-ops node's IncomingMessage carries (the client
   * face's rawChat callback calls response.resume() — W4-N). */
  resume() { return this; }
  pause() { return this; }
  read() { return null; }
  /** setEncoding(encoding) — the webhook-github handler spec's request
   * callback declares `response.setEncoding('utf8')` before its 'data'
   * accumulation (spec :224); the loopback replays the response body as a
   * utf8 string on the 'data' channel already, so the face records the
   * encoding and decodes on emit (Buffer chunks render through toString). */
  setEncoding(encoding) {
    this.#encoding = String(encoding ?? 'utf8');
    return this;
  }
  destroy(error) {
    this.readable = false;
    this.complete = true;
    if (error) this.emit('error', error);
    this.emit('close');
    return this;
  }
  /** Start the replay — called by the dispatcher AFTER handler invocation. */
  beginReplay() {
    if (this.#replayed) return;
    this.#replayed = true;
    nextTick(() => {
      if (this.#body.length > 0) this.emit('data', this.renderChunk(this.#body));
      this.#finish();
    });
  }
  /** Terminal state, exactly once (an iterate-to-EOF read IS reading to the
   * end of the body — the webhook-github handler checks `request.complete`
   * synchronously after its for-await, so the async-iterator path must mark
   * completion itself, not one tick later via beginReplay). */
  #finish() {
    if (this.#ended) return;
    this.#ended = true;
    this.complete = true;
    this.emit('end');
    this.emit('close');
  }
  /** Render one replay chunk per setEncoding (default: utf8 string — the
   * loopback's 'data' payload has been a utf8 string since the W3 round;
   * an explicit encoding keeps the same face). */
  renderChunk(chunk) {
    if (this.#encoding === undefined) return chunk;
    if (typeof chunk === 'string') return chunk;
    if (globalThis.Buffer && typeof chunk.toString === 'function') {
      return chunk.toString(this.#encoding === 'buffer' ? 'utf8' : this.#encoding);
    }
    return chunk;
  }
  [Symbol.asyncIterator]() {
    const source = this;
    let consumed = false;
    return {
      next: async () => {
        if (consumed) {
          source.#finish();
          return { value: undefined, done: true };
        }
        consumed = true;
        // One tick so an event-style consumer registered first is served by
        // its own channel, not by this iterator.
        await new Promise((resolve) => nextTick(resolve));
        if (source.#body.length > 0) return { value: source.#body, done: false };
        source.#finish();
        return { value: undefined, done: true };
      },
      return: () => Promise.resolve({ value: undefined, done: true }),
      throw: (error) => Promise.reject(error),
    };
  }
}

/** The ServerResponse face: status/headers/write/end over a live response
 * body stream. Headers resolve the dispatch the way real HTTP delivers them
 * — on the FIRST of writeHead/write/flushHeaders/end (the onHeaders hook),
 * not at end: a streaming handler writes SSE events long after fetch has
 * resolved. */
class LoopbackServerResponse extends EventEmitter {
  constructor(streamController, onHeaders, onDestroy) {
    super();
    this.statusCode = 200;
    this.statusMessage = undefined;
    this.#headers = new Map();
    this.#controller = streamController;
    this.#onHeaders = onHeaders;
    this.#onDestroy = onDestroy;
    this.#finished = false;
    this.headersSent = false;
  }
  #headers;
  #controller;
  #onHeaders;
  #onDestroy;
  #finished;
  #maybeHeaders() {
    if (this.headersSent || this.#onHeaders === null) return;
    const hook = this.#onHeaders;
    this.#onHeaders = null;
    this.headersSent = true;
    hook(this.statusCode, this.getHeaders());
  }
  setHeader(name, value) { this.#headers.set(String(name).toLowerCase(), String(value)); return this; }
  getHeader(name) { return this.#headers.get(String(name).toLowerCase()); }
  getHeaderNames() { return [...this.#headers.keys()]; }
  removeHeader(name) { this.#headers.delete(String(name).toLowerCase()); }
  getHeaders() { return Object.fromEntries(this.#headers); }
  writeHead(status, reasonOrHeaders, maybeHeaders) {
    this.statusCode = status;
    if (typeof reasonOrHeaders === 'string') this.statusMessage = reasonOrHeaders;
    const extra = (typeof reasonOrHeaders === 'object' && reasonOrHeaders !== null) ? reasonOrHeaders : maybeHeaders;
    if (extra) {
      for (const [name, value] of Object.entries(extra)) {
        this.#headers.set(String(name).toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
      }
    }
    this.#maybeHeaders();
    return this;
  }
  flushHeaders() { this.#maybeHeaders(); }
  write(chunk, encodingOrCb, maybeCb) {
    this.#maybeHeaders();
    if (this.#finished) return false;
    const cb = typeof encodingOrCb === 'function' ? encodingOrCb : maybeCb;
    try {
      this.#controller.enqueue(toBytes(chunk));
      if (cb) cb();
    } catch {
      /* a cancelled consumer stream swallows further writes (node: no-op) */
    }
    return true;
  }
  end(chunk, encodingOrCb, maybeCb) {
    this.#maybeHeaders();
    if (this.#finished) return this;
    const cb = typeof chunk === 'function' ? chunk : (typeof encodingOrCb === 'function' ? encodingOrCb : maybeCb);
    try {
      if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
        this.#controller.enqueue(toBytes(chunk));
      }
      this.#controller.close();
    } catch { /* consumer side already gone */ }
    this.#finished = true;
    nextTick(() => {
      this.emit('finish');
      this.emit('close');
    });
    if (cb) cb();
    return this;
  }
  destroy(error) {
    if (this.#finished) return this;
    this.#finished = true;
    try { this.#controller.error(error ?? new Error('response destroyed')); } catch { /* already closed */ }
    const hook = this.#onDestroy;
    this.#onDestroy = null;
    this.#onHeaders = null;
    if (hook) hook(error);
    this.emit('close');
    return this;
  }
}

/** createServer([options], handler): the loopback server face. The registry
 * maps host:port → the RECORD (server + handler), so the dispatcher reaches
 * the handler without poking server internals. */
export const createLoopbackServer = (optionsOrHandler, maybeHandler) => {
  const handler = typeof optionsOrHandler === 'function' ? optionsOrHandler : maybeHandler;
  const server = new EventEmitter();
  let record = null;
  server.listening = false;
  server.listen = (...args) => {
    const first = args[0];
    let port = 0;
    let host = '127.0.0.1';
    let cb;
    if (typeof first === 'number') {
      port = first;
      for (const arg of args.slice(1)) {
        if (typeof arg === 'string') host = arg;
        else if (typeof arg === 'function') cb = arg;
      }
    } else if (first && typeof first === 'object') {
      port = first.port ?? 0;
      host = first.host ?? host;
      cb = args[1];
    }
    if (record) return server; // this server is already listening — idempotent
    const boundPort = port === 0 ? nextEphemeralPort++ : port;
    // node: binding a port ANOTHER server holds emits 'error' EADDRINUSE
    // (checked AFTER the bind port resolves — an explicit port can collide
    // with any registered listener, ephemeral or not; the inspector
    // endpoint's port advance relies on this contract, W5-Q).
    const occupied = registry.get(keyFor(host, boundPort));
    if (occupied !== undefined && occupied.server !== server) {
      const error = new Error(`listen EADDRINUSE: address already in use ${host}:${boundPort}`);
      error.code = 'EADDRINUSE';
      error.errno = -98;
      error.syscall = 'listen';
      error.address = host;
      error.port = boundPort;
      nextTick(() => server.emit('error', error));
      return server;
    }
    record = { server, host, port: boundPort, handler };
    registry.set(keyFor(host, boundPort), record);
    server.listening = true;
    nextTick(() => {
      server.emit('listening');
      if (cb) cb();
    });
    return server;
  };
  server.address = () => record
    ? { address: record.host, family: record.host.includes(':') ? 'IPv6' : 'IPv4', port: record.port }
    : null;
  server.close = (cb) => {
    if (!record) {
      const error = new Error('ERR_SERVER_NOT_RUNNING');
      error.code = 'ERR_SERVER_NOT_RUNNING';
      if (cb) cb(error);
      return server;
    }
    registry.delete(keyFor(record.host, record.port));
    record = null;
    server.listening = false;
    // node's close callback carries NO argument on success (an Error only on
    // failure); cb(null) made the otel egress afterAll's
    // `error === undefined ? resolve() : reject(error)` reject with null.
    if (cb) cb();
    nextTick(() => server.emit('close'));
    return server;
  };
  server.closeAllConnections = () => { /* no sockets exist to close */ };
  server[Symbol.asyncDispose] = async () => { server.close(); };
  return server;
};

/** The fetch-side entry: dispatch `url` through a registered loopback server
 * when one matches; returns undefined so the caller keeps its own behavior
 * (fail-loud or gateway) for everything else. `options.requestUrlOverride`
 * serves the PROXY shape (undici shim): the dial goes to the proxy server's
 * host:port while the request line carries the ABSOLUTE target URL — what a
 * real HTTP proxy receives, and what the egress specs' in-test proxy records. */
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
const dispatchParsed = (parsed, init, options, bodyBytes, formDataType) => {
  const record = registry.get(keyFor(hostFor(parsed), parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port)));
  const method = String(init?.method ?? 'GET').toUpperCase();
  const headerBag = new Map();
  const addHeaders = (source) => {
    if (!source) return;
    if (typeof source.forEach === 'function') {
      source.forEach((value, name) => headerBag.set(String(name).toLowerCase(), String(value)));
      return;
    }
    for (const [name, value] of Object.entries(source)) {
      headerBag.set(String(name).toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
    }
  };
  addHeaders(init?.headers);
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
    let settled = false;
    // Headers resolve the fetch (real HTTP timing); the body stream keeps
    // living until end/destroy. See LoopbackServerResponse.#maybeHeaders.
    const response = new LoopbackServerResponse(captured, (status, headerObject) => {
      if (settled) return;
      // redirect:'error' contract: a 3xx is the fetch-level TypeError, never
      // a resolved Response (the adapter's catch classifies it as TRANSPORT).
      if (init?.redirect === 'error' && [301, 302, 303, 307, 308].includes(status)) {
        settled = true;
        reject(new TypeError(`fetch: redirect for ${requestUrl} (redirect: 'error')`));
        return;
      }
      // Default 'follow': re-dispatch through the registry to the Location
      // target. 307/308 preserve method+body; 301/302/303 degrade a non-GET
      // to GET without a body (the fetch spec's change-method rule); a host
      // change strips the credential pair. The web-search-deepseek redirect
      // spec drives exactly this face (its 307 must forward the POST body).
      const locationValue = headerObject?.location ?? headerObject?.Location;
      if ((init?.redirect ?? 'follow') === 'follow'
        && [301, 302, 303, 307, 308].includes(status) && locationValue) {
        if ((options.redirectCount ?? 0) >= 20) {
          settled = true;
          reject(new TypeError('fetch: too many redirects'));
          return;
        }
        let nextParsed;
        try {
          nextParsed = new globalThis.URL(locationValue, parsed.href);
        } catch {
          settled = true;
          reject(new TypeError(`fetch: invalid redirect location ${locationValue}`));
          return;
        }
        settled = true; // the redirect hop owns the outcome now
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
      settled = true;
      resolve(new globalThis.Response(body, {
        status,
        statusText: response.statusMessage ?? '',
        headers: headerObject,
        url: String(parsed.href),
      }));
    }, (error) => {
      // Destroyed before headers: real fetch rejects (the socket died).
      if (settled) return;
      settled = true;
      reject(error ?? new Error('response destroyed before headers'));
    });
    const request = new LoopbackIncoming({ method, url: requestUrl, headers, body: globalThis.Buffer ? globalThis.Buffer.from(bodyBytes ?? new Uint8Array(0)) : (bodyBytes ?? new Uint8Array(0)) });
    // The reset face: `connection_reset` behaviors tear the request socket
    // down (llm-mock-server's `request.socket.destroy()`), which on the wire
    // is a client-side ECONNRESET — the adapter classifies it TRANSPORT.
    request.socket = {
      destroy: (error) => response.destroy(error ?? new Error('socket hang up')),
    };
    if (signal) {
      if (signal.aborted) {
        settled = true;
        reject(abortError());
        return;
      }
      signal.addEventListener('abort', () => {
        try { captured.error(abortError()); } catch { /* body already closed */ }
        response.destroy(); // server-side 'close' — the in-test server observes this
        if (!settled) {
          settled = true;
          reject(abortError());
        }
      });
    }
    try {
      const result = record.handler(request, response);
      if (result && typeof result.catch === 'function') {
        result.catch((error) => {
          if (settled) return;
          settled = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      }
      request.beginReplay();
    } catch (error) {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
};

/** ===== The WebSocket upgrade seam (W5-Q, 2026-09-28) =====================
 * The suite's socket-seam family (gateway RemoteStreamMux, the experimental
 * inspector endpoint) runs the REAL vendored ws@8.21.0 on both ends — the
 * missing piece was the byte transport the WS handshake rides on. One
 * process (D2) still holds: a LoopbackSocket is an in-memory byte pipe
 * paired like pipe(2) — no OS socket, no thread, nothing leaves the
 * runtime; net.connect/tls.connect stay refused for every other use.
 * http.request UPGRADE-shaped calls (Upgrade: websocket) route here instead
 * of the fetch dispatch: the client half carries the serialized request head
 * to the registry record's server half, the server-side parser emits node's
 * `server.on('upgrade')(req, socket, head)`, and the 101 response head
 * flows back to the client's 'upgrade' event. After the handshake the
 * halves are plain byte pipes and the real ws framing runs.
 * ========================================================================= */

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
 * {firstLine, headers, rawHeaders} — header names lowercase in the bag (the
 * IncomingMessage contract), the last value winning per header name. */
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

/** One half of the paired in-memory byte transport. The face is what the
 * vendored ws sender/receiver/websocket touch on a net.Socket:
 * write/pause/resume/end/destroy + setTimeout/setNoDelay/setKeepAlive, and
 * 'data'/'end'/'close'/'error' emission in write order. A HANDSHAKE GATE
 * may be installed before first delivery: early bytes go to the gate
 * callback (the HTTP head parser — it returns the bytes it did not consume,
 * which re-queue and stay gated) until releaseGate turns the half into a
 * plain pipe. */
class LoopbackSocket extends EventEmitter {
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
  // node's legacy state views (ws's socketOnClose reads
  // `_socket._readableState.endEmitted` to split clean vs abrupt closes and
  // `.length` before read()-ing the tail — length mirrors the pending queue
  // so a non-empty tail is exactly what read() can pull).
  #endEmitted = false;
  #errorEmitted = false;
  #pendingLength() {
    let n = 0;
    for (const c of this.#pending) n += c.byteLength;
    return n;
  }
  get _readableState() {
    const self = this;
    return {
      get endEmitted() { return self.#endEmitted; },
      get errorEmitted() { return self.#errorEmitted; },
      get destroyed() { return self.#destroyed; },
      get length() { return self.#pendingLength(); },
    };
  }
  get _writableState() {
    const self = this;
    return {
      get needDrain() { return false; },
      get errorEmitted() { return self.#errorEmitted; },
      get destroyed() { return self.#destroyed; },
      get length() { return 0; },
      get ended() { return self.#ended; },
      get finished() { return self.#ended; },
    };
  }
  static _pair(a, b) {
    a.#peer = b;
    b.#peer = a;
    a.remotePort = b.localPort;
    b.remotePort = a.localPort;
  }
  get destroyed() { return this.#destroyed; }
  get readable() { return !this.#destroyed; }
  get writable() { return !this.#destroyed && !this.#ended; }
  write(chunk, ...rest) {
    const cb = typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : undefined;
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
      if (!peer.#destroyed) {
        peer.#endEmitted = true;
        peer.emit('end');
      }
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
    if (error !== undefined && error !== null) {
      this.#errorEmitted = true;
      peer.#errorEmitted = true;
      this.emit('error', error);
    }
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
  /** node's readable read([size]) face: pull up to `size` bytes (default:
   * one whole queued chunk) out of the pending queue — ws's socketOnClose
   * reads any tail bytes after the close (W5-Q). */
  read(size) {
    if (this.#pending.length === 0) return null;
    const first = this.#pending.shift();
    if (size === undefined || size === null || first.byteLength <= size) {
      return globalThis.Buffer ? globalThis.Buffer.from(first) : first;
    }
    const out = first.slice(0, size);
    this.#pending.unshift(first.slice(size));
    return globalThis.Buffer ? globalThis.Buffer.from(out) : out;
  }
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

/** The SERVER-side handshake: consume the client's request head off the
 * server half, emit node's `server.on('upgrade')(req, socket, head)` on the
 * registry record's server, then release the half into pipe mode. A record
 * without upgrade listeners gets node's 501 refusal. */
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
export const dispatchUpgradeRequest = (options) => {
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.destroy = () => req;
  nextTick(() => {
    const host = String(options.host ?? '127.0.0.1');
    const port = Number(options.port ?? 80);
    const record = registry.get(keyFor(host, port));
    if (!record || !record.server.listening) {
      const error = new Error(`connect ECONNREFUSED ${host}:${port}`);
      error.code = 'ECONNREFUSED';
      req.emit('error', error);
      return;
    }
    const headers = options.headers ?? {};
    const hostHeader = headers.Host ?? headers.host
      ?? `${host}${port === 80 ? '' : `:${port}`}`;
    const lines = [`${String(options.method ?? 'GET').toUpperCase()} ${options.path ?? '/'} HTTP/1.1`, `Host: ${hostHeader}`];
    for (const [name, value] of Object.entries(headers)) {
      if (name === 'Host' || name === 'host') continue;
      lines.push(Array.isArray(value) ? `${name}: ${value.join(', ')}` : `${name}: ${value}`);
    }
    const head = encodeUtf8(`${lines.join('\r\n')}\r\n\r\n`);
    const clientHalf = new LoopbackSocket();
    const serverHalf = new LoopbackSocket();
    clientHalf.localPort = port;
    serverHalf.localPort = port;
    LoopbackSocket._pair(clientHalf, serverHalf);
    serverUpgradeIngress(record, serverHalf);
    clientUpgradeAwait(clientHalf, req);
    clientHalf.write(head); // client -> server: the request head enters the server half's gate
  });
  return req;
};

/** The loopback CLIENT request (node:http request(url[, options][, cb])) —
 * the in-process counterpart of the server face: write()/end() buffer the
 * body chunks, end() dispatches through the registry exactly like fetch,
 * and the response arrives as an event-style IncomingMessage ('data'/'end'/
 * 'close', statusCode/headers). W4-N: llm-mock-server's rawChat drives its
 * in-test server this way and sends the body in TWO writes — the loopback
 * reassembles them, which is precisely the wire behavior under test. */
const createLoopbackClientRequest = (urlOrOptions, optionsOrCb, maybeCb) => {
  // node's overloads: request(url[, options][, cb]) and request(options[, cb]).
  let url = null;
  let options = optionsOrCb;
  let callback = maybeCb;
  const first = urlOrOptions;
  if (typeof first === 'string' || (first && typeof first.href === 'string')) {
    url = String(first.href ?? first);
    if (typeof optionsOrCb === 'function') { callback = optionsOrCb; options = undefined; }
  } else {
    options = first;
    if (typeof optionsOrCb === 'function') { callback = optionsOrCb; options = undefined; }
  }
  const req = new EventEmitter();
  const chunks = [];
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    // UPGRADE branch (W5-Q): an Upgrade: websocket request rides the paired
    // LoopbackSocket seam instead of the fetch dispatch — node emits
    // 'upgrade' (not 'response') for the 101, and the vendored ws client
    // owns the raw socket from there.
    const upgradeHeader = (() => {
      const h = options?.headers;
      if (h === undefined || h === null) return undefined;
      const value = h.Upgrade ?? h.upgrade;
      return value === undefined ? undefined : String(value).toLowerCase();
    })();
    if (upgradeHeader === 'websocket') {
      nextTick(() => {
        let host = String(options?.host ?? '127.0.0.1');
        let port = Number(options?.port ?? 80);
        let path = options?.path;
        if (url !== null) {
          try {
            const parsed = new globalThis.URL(url);
            host = hostFor(parsed);
            port = parsed.port === '' ? 80 : Number(parsed.port);
            path = `${parsed.pathname}${parsed.search}`;
          } catch {
            // fall through with the option-shape values
          }
        }
        const upgradeReq = dispatchUpgradeRequest({
          host,
          port,
          path: path ?? '/',
          method: String(options?.method ?? 'GET').toUpperCase(),
          headers: { ...(options?.headers ?? {}) },
        });
        upgradeReq.on('upgrade', (res, socket, head) => {
          if (callback) callback(res);
          req.emit('upgrade', res, socket, head);
        });
        upgradeReq.on('response', (incoming) => req.emit('response', incoming));
        upgradeReq.on('error', (error) => req.emit('error', error));
      });
      return;
    }
    nextTick(async () => {
      const total = chunks.reduce((n, c) => n + c.byteLength, 0);
      const body = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) { body.set(c, at); at += c.byteLength; }
      try {
        const response = await dispatchLoopback(url, {
          method: options?.method ?? 'GET',
          headers: options?.headers,
          ...(total > 0 ? { body } : {}),
        });
        if (response === undefined) {
          throw new Error(`node:http: request to ${url} has no loopback server — no socket seam`);
        }
        const headerBag = {};
        response.headers.forEach((value, name) => { headerBag[String(name).toLowerCase()] = String(value); });
        const incoming = new LoopbackIncoming({ method: String(options?.method ?? 'GET'), url: '/', headers: headerBag, body: [] });
        incoming.statusCode = response.status;
        nextTick(() => {
          if (callback) callback(incoming);
          req.emit('response', incoming);
          response.arrayBuffer().then((buffer) => {
            const bytes = new Uint8Array(buffer);
            incoming.complete = true;
            if (bytes.byteLength > 0) {
              incoming.emit('data', incoming.renderChunk(globalThis.Buffer ? globalThis.Buffer.from(bytes) : bytes));
            }
            incoming.emit('end');
            incoming.emit('close');
          }, (error) => {
            incoming.emit('error', error instanceof Error ? error : new Error(String(error)));
          });
        });
      } catch (error) {
        req.emit('error', error instanceof Error ? error : new Error(String(error)));
      }
    });
  };
  req.write = (chunk, encodingOrCb, maybeWriteCb) => {
    const cb = typeof encodingOrCb === 'function' ? encodingOrCb : maybeWriteCb;
    if (chunk !== undefined && chunk !== null) chunks.push(toBytes(chunk));
    if (cb) cb();
    return true;
  };
  req.end = (chunk, encodingOrCb, maybeEndCb) => {
    if (chunk !== undefined && chunk !== null) chunks.push(toBytes(chunk));
    const cb = typeof encodingOrCb === 'function' ? encodingOrCb : maybeEndCb;
    if (cb) cb();
    finish();
    return req;
  };
  // node's ClientRequest.destroy(error): emit 'error' ONLY with a passed
  // error — inventing one here masks the ws handshake failure text (the
  // vendored client's abortHandshake path destroys the request with the real
  // reason, W5-Q).
  req.destroy = (error) => {
    if (error !== undefined && error !== null) req.emit('error', error);
    return req;
  };
  return req;
};

/** The node:http module face: real createServer/Server over the loopback,
 * the pure-validation faces kept verbatim, the never-reachable client faces
 * still failing loud (no socket seam — see the module header). */
export const createHttpFace = () => {
  const refuse = (name) => () => {
    throw new Error(`node:http: ${name} is not served in this runtime — no socket seam (the in-process loopback is the only served face)`);
  };
  // validateHeaderName — node's contract is the RFC 7230 TOKEN charset
  // (lib/_http_common checkIsHttpToken: /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);
  // anything else throws. The old CR/LF/NUL-only check silently ACCEPTED
  // names node rejects (a space — acp bridge's mcpServers header validation
  // table then reached a real connection instead of its expected config
  // error, W5-Q 2026-09-28).
  const validateHeaderName = (name) => {
    if (typeof name !== 'string' || !name
        || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
      throw new TypeError('node:http: validateHeaderName: invalid header name');
    }
  };
  // validateHeaderValue — node rejects any char outside tab / visible ASCII
  // / latin-1 high bytes (/[^\t\x20-\x7e\x80-\xff]/), so DEL and the other
  // C0 controls are invalid here too (the old CR/LF/NUL check was looser).
  const validateHeaderValue = (name, value) => {
    if (typeof value !== 'string' || /[^\t\x20-\x7e\x80-\xff]/.test(value)) {
      throw new TypeError('node:http: validateHeaderValue: invalid header value');
    }
  };
  const createServer = (optionsOrHandler, maybeHandler) => createLoopbackServer(optionsOrHandler, maybeHandler);
  const http = {
    createServer,
    request: createLoopbackClientRequest,
    get: refuse('get'),
    Server: class Server {
      constructor(handler) { return createLoopbackServer(handler); }
    },
    ServerResponse: LoopbackServerResponse,
    IncomingMessage: LoopbackIncoming,
    Agent: class Agent {
      // Inert agent face: real node Agents pool sockets, which do not exist
      // here — the client request face ignores the agent entirely. OTel's
      // httpAgentFactoryFromOptions CONSTRUCTS one at exporter build time
      // (`new Agent({ keepAlive, lookup })`) and swallows the failure through
      // its diag logger, which left the otel egress exports silently empty —
      // hence constructible (options absorbed) + the destroy() face.
      constructor(options = {}) { this.options = options; }
      destroy(cb) { if (typeof cb === 'function') cb(); return this; }
    },
    validateHeaderName,
    validateHeaderValue,
    MAX_HEADER_COUNT: 2000,
    maxHeaderSize: 16384,
    setMaxIdleHTTP1Connections: () => {},
    globalAgent: { maxSockets: Infinity, options: {} },
  };
  return http;
};
