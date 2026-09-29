// dsh:logging-exempt (shim layer; no logging surface in the hot path)
/**
 * shims/node-http-loopback-client.js — the HTTP upgrade seam (W5-Q) and the
 * node:http client-request face, split out of node-http-loopback.js when
 * that file crossed the code-size budget. The server registry stays the
 * single source of truth in node-http-loopback.js (imported here; call-time
 * reads keep the ESM cycle safe).
 */
import {
  registry,
  keyFor,
  hostFor,
  nextTick,
  toBytes,
  LoopbackIncoming,
  LoopbackServerResponse,
  createLoopbackServer,
  dispatchLoopback,
} from 'upstream/shims/node-http-loopback.js';
import { EventEmitter } from 'upstream/shims/events.js';

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
  #closeEmitted = false;
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
      // W8: 'end' is a once event (node's net contract) — the guard checked
      // only #destroyed, so every end() call re-emitted the peer's 'end' and
      // the ws close handshake (repeated end() on both halves) ping-ponged
      // through nextTick forever.
      if (!peer.#destroyed && !peer.#endEmitted) {
        peer.#endEmitted = true;
        peer.emit('end');
      }
      // W8: a real net socket emits 'close' once the handle is fully closed —
      // on a paired pipe, when BOTH halves have ended. ws's clean-close
      // completion (socket 'close' → socketOnClose → receiver finish →
      // emitClose) rides exactly that event; without it both websockets stay
      // in CLOSING forever after a clean handshake (destroy()-based closes
      // already emit 'close' — the guard keeps the two paths from doubling).
      if (peer.#ended && !peer.#destroyed && !peer.#closeEmitted && !this.#closeEmitted) {
        this.#closeEmitted = true;
        peer.#closeEmitted = true;
        this.emit('close');
        peer.emit('close');
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

/** Deliver the dispatched response body as IncomingMessage events
 * (module level for size): one 'data' with the whole buffer, then
 * 'end'/'close' — the loopback has no chunked-arrival semantics to
 * preserve, and llm-mock-server's rawChat asserts the reassembled body. */
const deliverIncomingBody = (req, incoming, response) => {
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
};

/** The loopback CLIENT request (node:http request(url[, options][, cb])) —
 * the in-process counterpart of the server face: write()/end() buffer the
 * body chunks, end() dispatches through the registry exactly like fetch,
 * and the response arrives as an event-style IncomingMessage ('data'/'end'/
 * 'close', statusCode/headers). W4-N: llm-mock-server's rawChat drives its
 * in-test server this way and sends the body in TWO writes — the loopback
 * reassembles them, which is precisely the wire behavior under test. */
/** The UPGRADE branch of the client finish (module level for size): an
 * Upgrade: websocket request rides the paired LoopbackSocket seam instead
 * of the fetch dispatch — node emits 'upgrade' (not 'response') for the
 * 101, and the vendored ws client owns the raw socket from there. */
const finishUpgrade = (ctx) => {
  const { req, options, url, callback } = ctx;
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
};

/** The plain dispatch branch (module level for size): reassemble the body
 * chunks, dispatch through the registry exactly like fetch, and deliver the
 * response as an event-style IncomingMessage ('data'/'end'/'close',
 * statusCode/headers). W4-N: llm-mock-server's rawChat drives its in-test
 * server this way and sends the body in TWO writes — the loopback
 * reassembles them, which is precisely the wire behavior under test. */
const finishDispatch = (ctx) => {
  const { req, options, url, callback, chunks } = ctx;
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
        deliverIncomingBody(req, incoming, response);
      });
    } catch (error) {
      req.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  });
};

/** The loopback CLIENT request (node:http request(url[, options][, cb])) —
 * the in-process counterpart of the server face: write()/end() buffer the
 * body chunks, end() dispatches through the registry exactly like fetch,
 * and the response arrives as an event-style IncomingMessage. */
/** The write face (module level for size): buffer the chunk, invoke the
 * callback, always true — the dispatch reads the chunks at end(). */
const clientWriteFace = (chunks) => (chunk, encodingOrCb, maybeWriteCb) => {
  const cb = typeof encodingOrCb === 'function' ? encodingOrCb : maybeWriteCb;
  if (chunk !== undefined && chunk !== null) chunks.push(toBytes(chunk));
  if (cb) cb();
  return true;
};

/** The end face (module level for size): optional final chunk, optional
 * callback, then the dispatch. */
/** The destroy face (module level for size). */
const clientDestroyFace = (req) => (error) => {
  if (error !== undefined && error !== null) req.emit('error', error);
  return req;
};

export const createLoopbackClientRequest = (urlOrOptions, optionsOrCb, maybeCb) => {
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
    // UPGRADE branch (W5-Q): see finishUpgrade.
    const upgradeHeader = (() => {
      const h = options?.headers;
      if (h === undefined || h === null) return undefined;
      const value = h.Upgrade ?? h.upgrade;
      return value === undefined ? undefined : String(value).toLowerCase();
    })();
    if (upgradeHeader === 'websocket') return finishUpgrade({ req, options, url, callback });
    return finishDispatch({ req, options, url, callback, chunks });
  };
  req.write = clientWriteFace(chunks);
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
  req.destroy = clientDestroyFace(req);
  return req;
};
