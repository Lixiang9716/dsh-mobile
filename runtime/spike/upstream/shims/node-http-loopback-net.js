// dsh:logging-exempt (shim layer; no logging surface in the hot path)
/**
 * shims/node-http-loopback-net.js — the loopback's RAW-TRANSPORT half: the
 * HTTP upgrade ingress/await helpers (shared with the http.request UPGRADE
 * branch in node-http-loopback-client.js) and the net.connect face over the
 * loopback registry. Split out of node-http-loopback-dispatch.js when that
 * file crossed the code-size budget; the registry and the request/response
 * faces stay the single source of truth in node-http-loopback.js (imported
 * here; the cycle is call-time-only).
 */
import { EventEmitter } from 'upstream/shims/events.js';
import { encodeUtf8, decodeUtf8 } from 'upstream/shims/buffer.js';
import {
  registry,
  keyFor,
  toBytes,
  nextTick,
  LoopbackIncoming,
} from 'upstream/shims/node-http-loopback.js';
import { TcpSocketFace, socketSeamAvailable } from 'upstream/shims/node-socket-tcp.js';

/** ===== Upgrade-gate helpers ==============================================
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

/** node's connect() argument forms: connect(port[, host][, cb]),
 * connect(path) (a unix path is never a loopback dial — ECONNREFUSED), and
 * connect(options[, cb]). Module-level for size; returns
 * `{ port, host, path?, callback }`. */
const parseConnectArgs = (args) => {
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
  return {
    port: Number(options.port ?? 0),
    host: String(options.host ?? '127.0.0.1'),
    callback,
  };
};

/** The net.connect face over the loopback registry: connect(port[, host]),
 * connect(path) (a unix path is never registered — ECONNREFUSED), and
 * connect(options[, callback]). The 'connect'/'ready' pair fires on the
 * next macrotask like a real dial.
 *
 * v1.8.0 (the socket seam): a registry MISS used to be ECONNREFUSED
 * unconditionally — the peer can now be another OS process (the v1.5.0
 * subprocess seam's children, an in-test server's real listener), so a miss
 * dials REAL loopback TCP when the host negotiated the seam. The in-process
 * dispatch (registry HIT) is byte-for-byte unchanged — every existing spec
 * keeps its paired-pipe behavior; without the seam the honest ECONNREFUSED
 * stays (the negotiation floor, zero regression). */
export const connectLoopbackNet = (...args) => {
  const { port, host, callback } = parseConnectArgs(args);
  const record = registry.get(keyFor(host, port));
  if ((!record || !record.server.listening) && host === '127.0.0.1'
      && socketSeamAvailable()) {
    const tcp = new TcpSocketFace();
    tcp.localPort = port;
    if (typeof callback === 'function') tcp.once('connect', callback);
    tcp.connect({ host, port });
    return tcp;
  }
  const socket = new LoopbackNetSocket();
  socket.localPort = port;
  if (typeof callback === 'function') socket.once('connect', callback);
  nextTick(() => {
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
