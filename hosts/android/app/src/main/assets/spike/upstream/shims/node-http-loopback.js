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
export const registry = new Map();
/** Ephemeral port allocator (listen(0)); IANA dynamic range start. */
let nextEphemeralPort = 49152;

export const keyFor = (host, port) => `${String(host).toLowerCase()}:${port}`;

/** The registry host spelling of a parsed URL. WHATWG `hostname` strips the
 * IPv6 brackets ('[::1]' → '::1'); the URL shim keeps them, so strip here —
 * a listen record is keyed by the bare host spelling (W4-N: the mock-server
 * IPv6 listener test dials `http://[::1]:port`). */
export const hostFor = (parsed) => {
  const h = parsed.hostname;
  return typeof h === 'string' && h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
};

export const nextTick = (fn) => {
  if (typeof globalThis.setTimeout === 'function') setTimeout(fn, 0);
  else Promise.resolve().then(fn);
};

export const toBytes = (value) => {
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
export class LoopbackIncoming extends EventEmitter {
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
export class LoopbackServerResponse extends EventEmitter {
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
    // The on-headers contract (npm compression's hook point): listeners run
    // AFTER the handler's writeHead arguments are merged into the header set
    // and BEFORE the headers reach the dispatch (which resolves fetch with
    // getHeaders()) — so a listener may add Content-Encoding / Vary and drop
    // Content-Length (W8: the webserver gzip arm's compression middleware).
    this.emit('headers', this.statusCode, this.getHeaders());
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
/** Parse a listen() argument list (module level for size): the (port,
 * host, cb) and (options, cb) spellings. */
const parseListenArgs = (args) => {
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
  return { port, host, cb };
};

/** The listen face (module level for size): idempotent, EADDRINUSE-checked
 * (AFTER the bind port resolves — an explicit port can collide with any
 * registered listener, ephemeral or not; the inspector endpoint's port
 * advance relies on this contract, W5-Q), registry-backed. */
const serverListenFace = (server, registry, keyFor, takeEphemeralPort, handler, recordRef) => (...args) => {
  const { port, host, cb } = parseListenArgs(args);
  if (recordRef.current) return server; // this server is already listening — idempotent
  const boundPort = port === 0 ? takeEphemeralPort() : port;
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
  recordRef.current = { server, host, port: boundPort, handler };
  registry.set(keyFor(host, boundPort), recordRef.current);
  server.listening = true;
  nextTick(() => {
    server.emit('listening');
    if (cb) cb();
  });
  return server;
};

export const createLoopbackServer = (optionsOrHandler, maybeHandler) => {
  const handler = typeof optionsOrHandler === 'function' ? optionsOrHandler : maybeHandler;
  const server = new EventEmitter();
  const recordRef = { current: null };
  server.listening = false;
  // node's construction protocol: createServer(handler) registers the
  // handler AS a 'request' listener, so the in-test swap
  // (removeAllListeners('request') + on('request', ...)) takes effect — the
  // web-fetch-http proxy spec's cross-origin redirect test drives exactly
  // this face (W7-Y2). The record keeps the constructor handler as the
  // zero-listener dispatch fallback.
  if (typeof handler === 'function') server.on('request', handler);
  server.listen = serverListenFace(server, registry, keyFor, () => nextEphemeralPort++, handler, recordRef);
  server.address = () => recordRef.current
    ? { address: recordRef.current.host, family: recordRef.current.host.includes(':') ? 'IPv6' : 'IPv4', port: recordRef.current.port }
    : null;
  server.close = (cb) => {
    if (!recordRef.current) {
      const error = new Error('ERR_SERVER_NOT_RUNNING');
      error.code = 'ERR_SERVER_NOT_RUNNING';
      if (cb) cb(error);
      return server;
    }
    registry.delete(keyFor(recordRef.current.host, recordRef.current.port));
    recordRef.current = null;
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
import { dispatchUpgradeRequest, createLoopbackClientRequest } from 'upstream/shims/node-http-loopback-client.js';
import { dispatchLoopback, connectLoopbackNet } from 'upstream/shims/node-http-loopback-dispatch.js';
export { dispatchUpgradeRequest, connectLoopbackNet };

/** The node:http module face: real createServer/Server over the loopback,
 * the pure-validation faces kept verbatim, the never-reachable client faces
 * still failing loud (no socket seam — see the module header). */
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

/** The pinned-connection resolvers (W8): node:http Agents constructed with a
 * DNS `lookup` (OTLP's httpAgentOptions pinning — the session-telemetry
 * egress suite's `otel-direct.invalid → 127.0.0.1` shape) hand that resolver
 * to every connect they make. There are no sockets here, so the pin rides
 * the dispatch instead: a registry MISS consults the registered resolvers
 * and, when one answers a loopback address that HAS a live in-process server
 * on the same port, the dispatch re-dials that address — what a real
 * connect would have dialed. registerPinnedHttpLookup is wired by the
 * Agent face below; dispatchLoopback (node-http-loopback-dispatch.js)
 * consumes the set. */
export const pinnedHttpLookups = new Set();

export const createHttpFace = () => {
  const refuse = (name) => () => {
    throw new Error(`node:http: ${name} is not served in this runtime — no socket seam (the in-process loopback is the only served face)`);
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
      // The agent face: options absorbed (OTel's httpAgentFactoryFromOptions
      // CONSTRUCTS one at exporter build time and swallows construction
      // failures through its diag logger). A DNS `lookup` option — node's
      // top-level http.Agent spelling and the connect:{lookup} spelling
      // alike — REGISTERS the resolver with the dispatch (see
      // pinnedHttpLookups); destroy() unregisters. Everything else stays
      // inert (real Agents pool sockets, which do not exist here — the
      // client request face has no sockets to pool).
      constructor(options = {}) {
        this.options = options;
        const lookup = options?.lookup ?? options?.connect?.lookup;
        if (typeof lookup === 'function') {
          this.__dshPinnedHttpLookup = lookup;
          pinnedHttpLookups.add(lookup);
        }
      }
      destroy(cb) {
        if (this.__dshPinnedHttpLookup !== undefined) pinnedHttpLookups.delete(this.__dshPinnedHttpLookup);
        if (typeof cb === 'function') cb();
        return this;
      }
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
export { dispatchLoopback };
