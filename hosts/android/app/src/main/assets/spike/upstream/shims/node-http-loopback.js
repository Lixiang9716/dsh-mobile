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

/** host:port → server record. Key spelling: lowercased host, numeric port. */
const registry = new Map();
/** Ephemeral port allocator (listen(0)); IANA dynamic range start. */
let nextEphemeralPort = 49152;

const keyFor = (host, port) => `${String(host).toLowerCase()}:${port}`;

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
    this.statusCode = undefined;
    this.complete = false;
    this.readable = true;
    this.#body = body;
    this.#replayed = false;
  }
  #body;
  #replayed;
  setTimeout() { return this; }
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
      if (this.#body.length > 0) this.emit('data', this.#body);
      this.complete = true;
      this.emit('end');
      this.emit('close');
    });
  }
  [Symbol.asyncIterator]() {
    const source = this;
    let consumed = false;
    return {
      next: async () => {
        if (consumed) return { value: undefined, done: true };
        consumed = true;
        // One tick so an event-style consumer registered first is served by
        // its own channel, not by this iterator.
        await new Promise((resolve) => nextTick(resolve));
        if (source.#body.length > 0) return { value: source.#body, done: false };
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
    if (record) return server; // already listening (node throws; idempotent is safer here)
    const boundPort = port === 0 ? nextEphemeralPort++ : port;
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
    if (cb) cb(null);
    nextTick(() => server.emit('close'));
    return server;
  };
  server.closeAllConnections = () => { /* no sockets exist to close */ };
  server[Symbol.asyncDispose] = async () => { server.close(); };
  return server;
};

/** The fetch-side entry: dispatch `url` through a registered loopback server
 * when one matches; returns undefined so the caller keeps its own behavior
 * (fail-loud or gateway) for everything else. */
export const dispatchLoopback = (input, init = {}) => {
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
  const record = registry.get(keyFor(parsed.hostname, port));
  if (!record || !record.server.listening) return undefined;

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

  const requestUrl = `${parsed.pathname}${parsed.search}`;
  const bodyBytes = toBytes(init?.body);
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
      settled = true;
      // redirect:'error' contract: a 3xx is the fetch-level TypeError, never
      // a resolved Response (the adapter's catch classifies it as TRANSPORT).
      if (init?.redirect === 'error' && [301, 302, 303, 307, 308].includes(status)) {
        reject(new TypeError(`fetch: redirect for ${requestUrl} (redirect: 'error')`));
        return;
      }
      resolve(new globalThis.Response(body, {
        status,
        statusText: response.statusMessage ?? '',
        headers: headerObject,
        url: urlString,
      }));
    }, (error) => {
      // Destroyed before headers: real fetch rejects (the socket died).
      if (settled) return;
      settled = true;
      reject(error ?? new Error('response destroyed before headers'));
    });
    const request = new LoopbackIncoming({ method, url: requestUrl, headers, body: globalThis.Buffer ? globalThis.Buffer.from(bodyBytes) : bodyBytes });
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

/** The node:http module face: real createServer/Server over the loopback,
 * the pure-validation faces kept verbatim, the never-reachable client faces
 * still failing loud (no socket seam — see the module header). */
export const createHttpFace = () => {
  const refuse = (name) => () => {
    throw new Error(`node:http: ${name} is not served in this runtime — no socket seam (the in-process loopback is the only served face)`);
  };
  const validateHeaderName = (name) => {
    if (typeof name !== 'string' || !name || /[\r\n\0]/.test(name)) {
      throw new TypeError('node:http: validateHeaderName: invalid header name');
    }
  };
  const validateHeaderValue = (name, value) => {
    if (typeof value !== 'string' || /[\r\n\0]/.test(value)) {
      throw new TypeError('node:http: validateHeaderValue: invalid header value');
    }
  };
  const createServer = (optionsOrHandler, maybeHandler) => createLoopbackServer(optionsOrHandler, maybeHandler);
  const http = {
    createServer,
    request: refuse('request'),
    get: refuse('get'),
    Server: class Server {
      constructor(handler) { return createLoopbackServer(handler); }
    },
    ServerResponse: LoopbackServerResponse,
    IncomingMessage: LoopbackIncoming,
    Agent: class { constructor() { refuse('Agent')(); } },
    validateHeaderName,
    validateHeaderValue,
    MAX_HEADER_COUNT: 2000,
    maxHeaderSize: 16384,
    setMaxIdleHTTP1Connections: () => {},
    globalAgent: { maxSockets: Infinity, options: {} },
  };
  return http;
};
