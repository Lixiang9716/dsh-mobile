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
} from 'upstream/shims/node-http-loopback.js';
import { encodeFormData } from 'upstream/shims/web-multipart.js';

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
  resolve(new globalThis.Response(body, {
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
