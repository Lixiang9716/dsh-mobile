// dsh:logging-exempt (shim layer; no logging surface in the hot path)
/**
 * shims/node-http-loopback-dispatch.js — the fetch-side dispatch of the
 * loopback shim (dispatchLoopback + the request/response exchange), split
 * out of node-http-loopback.js when that file crossed the code-size budget.
 * The upgrade ingress/await helpers and the raw net.connect face moved one
 * split further, to node-http-loopback-net.js (re-exported below — the
 * boot-tail globalThis wiring imports them from HERE). The server registry
 * and the Incoming/Response classes stay the single source of truth in
 * node-http-loopback.js (imported here; the cycle is call-time-only).
 */
import {
  registry,
  keyFor,
  toBytes,
  hostFor,
  LoopbackIncoming,
  LoopbackServerResponse,
  pinnedHttpLookups,
} from 'upstream/shims/node-http-loopback.js';
import { encodeFormData } from 'upstream/shims/web-multipart.js';
import { gunzipSync } from 'upstream/shims/node-zlib.js';

/** Assemble the buffered chunks and serve the whole gunzipped payload on
 * close (module level for size — keeps the pump one block shallower). */
const enqueueGunzipped = (controller, chunks, total) => {
  if (total > 0) {
    const whole = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) { whole.set(chunk, at); at += chunk.byteLength; }
    const out = gunzipSync(whole);
    const bytes = out instanceof Uint8Array ? out : new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
    controller.enqueue(globalThis.Buffer ? globalThis.Buffer.from(bytes) : bytes);
  }
  controller.close();
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
        if (done) return enqueueGunzipped(controller, chunks, total);
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

/** The exchange half of the dispatch (module level for size): builds the
 * request/response pair over one registry record and runs the handler inside
 * a promise the headers/destroy/abort outcomes settle. `settled` is a tiny
 * gate object — the header callback and the abort listener both own the
 * outcome. */
const runLoopbackExchange = (record, ctx) => {
  const { parsed, init, options, method, headers, requestUrl, bodyBytes, formDataType } = ctx;
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
      onLoopbackHeaders({ ...ctx, body, settled, resolve, reject, response })(status, headerObject);
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
    if (init?.signal) wireLoopbackAbort(init.signal, captured, response, settled, reject, abortError);
    runLoopbackHandler(record, request, response, settled, reject);
  });
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
  return runLoopbackExchange(record, {
    parsed, init, options, method, bodyBytes, formDataType,
    requestUrl, headers: Object.fromEntries(headerBag),
  });
};

// The HTTP upgrade + client-request face lives in node-http-loopback-client.js
// and the upgrade/raw-net transport in node-http-loopback-net.js (this file
// crossed the size budget twice); re-exported so boot-tail-loopback-globals
// (globalThis wiring) and bare-importers keep shape.
export {
  serverUpgradeIngress,
  serializeRefusalHead,
  clientUpgradeAwait,
} from 'upstream/shims/node-http-loopback-net.js';
