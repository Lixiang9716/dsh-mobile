// dsh:logging-exempt (shim layer)
/**
 * shims/node-socket-tcp.js — the REAL-TCP face over the loopback socket seam
 * (contract v1.8.0, decision D-d): the JS side of socketListen/socketConnect,
 * plus the 4ms pump that turns the host's poll intrinsic into the node
 * data/close event sequence (the same child-process/pty pump contract — the
 * host dispatches every event onto the serial runtime queue, so no JS ever
 * runs on a second thread, D2; the consumer sees events, never a polling API
 * of another component, D8).
 *
 * The five-rule model in one place: `socketSeamAvailable()` is the
 * negotiation read (descriptor-declared grants, zero prompts — the loopback
 * scope is the narrowest by construction); listen and connect are separate
 * gateway primitives (direction grading); the host audits every
 * listen/connect/accept; grants die with the session (this runtime's
 * lifetime).
 *
 * In-process loopback traffic (the webserver/spec registry) NEVER enters
 * here — node-http-loopback-net.js keeps its paired-pipe dispatch and only
 * falls through to this module when the registry misses (i.e. the peer is
 * another OS process), which is the exact shape the seam exists for.
 */
import { EventEmitter } from 'upstream/shims/events.js';
import { Buffer, encodeUtf8 } from 'upstream/shims/buffer.js';
import {
  socketListen,
  socketConnect,
  socketWrite,
  socketEnd,
  socketClose,
} from 'gateway.js';

const pollIntrinsic = globalThis.__dshSocketPoll;

/** The negotiation read: the host's descriptor declares BOTH loopback grants
 * and the pump intrinsic exists. False on a host without the seam — callers
 * answer the honest node-shaped failure (ECONNREFUSED / EACCES) instead of a
 * fake (rule 5), which is also the negotiation floor: zero behavior change
 * where the seam is absent. */
export const socketSeamAvailable = () => {
  if (typeof pollIntrinsic !== 'function') return false;
  try {
    const raw = typeof globalThis.__dshGatewayDescriptor === 'function'
      ? globalThis.__dshGatewayDescriptor()
      : 'null';
    const descriptor = JSON.parse(raw);
    const available = descriptor?.available;
    return Array.isArray(available)
      && available.includes('socketListen')
      && available.includes('socketConnect');
  } catch {
    return false;
  }
};

/** node's chunk argument face: string → UTF-8 bytes; Buffer/Uint8Array pass
 * through as bytes. */
const toBytes = (chunk) => {
  if (typeof chunk === 'string') return encodeUtf8(chunk);
  return chunk;
};

/** 'data' carries the DshBuffer face (toString(enc)/indexOf/...), the same
 * discipline the child-process pump keeps — a bare Uint8Array strips the
 * face consumers parse with. Imported directly from the buffer module: the
 * globalThis spelling is not guaranteed to be the face in every boot order. */
const asBuffer = (bytes) => Buffer.from(bytes);

const PUMP_TICK_MS = 4;

/** One duplex TCP stream over a seam connectionId. Constructed two ways:
 * `connect()` dials (the 'connect' event fires once the host completes the
 * non-blocking dial); the server pump builds the SERVER half of each
 * accepted connection directly on the connectionId. */
class TcpSocket extends EventEmitter {
  #id = null;
  #pending = [];
  #draining = false;
  #paused = false;
  #ended = false; // our write side half-closed
  #destroyed = false;
  #eof = false;
  remoteAddress = '127.0.0.1';
  remotePort = 0;
  localPort = 0;

  get destroyed() { return this.#destroyed; }
  get readable() { return !this.#destroyed && !this.#eof; }
  get writable() { return !this.#destroyed && !this.#ended; }

  /** Adopt an already-established connectionId (the server pump's accept
   * path, or socketConnect's resolve — both start the pump immediately). */
  __adopt(id, peerPort) {
    this.#id = id;
    if (peerPort !== undefined) this.remotePort = peerPort;
    this.__schedule();
    return this;
  }

  __connectionId() {
    return this.#id;
  }

  connect(options, callback) {
    if (typeof callback === 'function') this.once('connect', callback);
    const port = Number(options?.port ?? 0);
    const host = String(options?.host ?? '127.0.0.1');
    this.localPort = port;
    socketConnect({ scope: 'loopback', host, port }).then((res) => {
      if (this.#destroyed) {
        if (res) socketClose({ connectionId: res.connectionId }).catch(() => {});
        return;
      }
      if (!res) {
        this.__fail(Object.assign(new Error(`connect EACCES ${host}:${port}`), {
          code: 'EACCES', errno: -13, syscall: 'connect', address: host, port,
        }));
        return;
      }
      this.remotePort = port;
      this.__adopt(res.connectionId);
    }, (error) => {
      if (this.#destroyed) return;
      const err = Object.assign(new Error(`connect ECONNREFUSED ${host}:${port} (${error?.message ?? error})`), {
        code: 'ECONNREFUSED', errno: -61, syscall: 'connect', address: host, port,
      });
      this.__fail(err);
    });
    return this;
  }

  /** The dial/seam failure face: 'error' then 'close' (node's connect
   * failure sequence — never a silent hang). */
  __fail(error) {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.emit('error', error);
    this.emit('close');
  }

  write(chunk, encodingOrCb, maybeCb) {
    const cb = typeof encodingOrCb === 'function' ? encodingOrCb : maybeCb;
    if (this.#destroyed || this.#ended) {
      const error = Object.assign(new Error('write after end'), { code: 'EPIPE' });
      if (cb) queueMicrotask(() => cb(error));
      else this.emit('error', error);
      return false;
    }
    if (this.#id === null) {
      // Bytes offered before the dial resolves park in order (node buffers
      // pre-connect writes the same way).
      this.#pending.push({ bytes: toBytes(chunk), cb });
      return true;
    }
    this.#writeNow(toBytes(chunk), cb);
    return true;
  }

  #writeNow(bytes, cb) {
    const id = this.#id;
    socketWrite(id, bytes).then((res) => {
      if (cb) cb(null);
      return res;
    }, (error) => {
      if (cb) cb(error);
      else this.emit('error', error);
      this.destroy(error);
    });
  }

  cork() {}
  uncork() {}
  setNoDelay() {}
  setKeepAlive() {}
  setTimeout() { return this; }
  unref() {}
  ref() {}
  address() { return { address: this.remoteAddress, family: 'IPv4', port: this.localPort }; }

  end(chunk, cb) {
    if (chunk !== undefined && chunk !== null) this.write(chunk);
    const finish = () => {
      this.#ended = true;
      if (typeof cb === 'function') cb();
      if (this.#id !== null) {
        socketEnd(this.#id).catch(() => {});
        this.__maybeRetire();
      }
    };
    if (this.#id === null) this.#pending.push({ bytes: null, finish });
    else finish();
    return this;
  }

  pause() { this.#paused = true; return this; }
  resume() {
    this.#paused = false;
    this.__drain();
    return this;
  }

  destroy(error) {
    if (this.#destroyed) return this;
    this.#destroyed = true;
    const id = this.#id;
    this.#id = null;
    this.#pending.length = 0;
    if (id !== null) socketClose({ connectionId: id }).catch(() => {});
    if (error !== undefined && error !== null) this.emit('error', error);
    this.emit('close');
    return this;
  }

  /** EOF after our own half-close retires the whole socket (both directions
   * done — the slot releases, the pump stops). */
  __maybeRetire() {
    if (this.#eof && this.#ended && !this.#destroyed && this.#id !== null) {
      const id = this.#id;
      this.#id = null;
      this.#destroyed = true;
      socketClose({ connectionId: id }).catch(() => {});
      this.emit('close');
    }
  }

  __schedule() {
    if (this.#draining) return;
    this.#draining = true;
    setTimeout(() => {
      this.#draining = false;
      this.__tick();
    }, PUMP_TICK_MS);
  }

  /** A failed dial is TERMINAL, and the host releases the slot with the
   * same poll (dialError carries the SO_ERROR errno): emit the node
   * connect-failure face — 'error' ECONNREFUSED, then 'close' — so a dead
   * port never hangs an awaiter, the pump stops re-arming, and the
   * negotiation floor (ECONNREFUSED, not a hang) holds with the seam on. */
  __failDial(res) {
    this.__fail(Object.assign(
      new Error(`connect ECONNREFUSED 127.0.0.1 (errno ${res.dialError ?? -61})`),
      { code: 'ECONNREFUSED', errno: res.dialError ?? -61, syscall: 'connect' },
    ));
  }

  __tick() {
    if (this.#destroyed) return;
    if (this.#id === null) return; // dial still in flight — write() re-arms
    let res;
    try {
      res = pollIntrinsic(this.#id);
    } catch (error) {
      this.__fail(error);
      return;
    }
    if (this.#destroyed) return;
    if (res.kind !== 'connection') return;
    if (!res.connected && res.eof) {
      this.__failDial(res);
      return;
    }
    if (res.connected && !this.__announced) {
      this.__announced = true;
      this.emit('connect');
      this.emit('ready');
      // Parked pre-connect writes flow in order now.
      const parked = this.#pending.splice(0);
      for (const entry of parked) {
        if (entry.bytes !== null) this.#writeNow(entry.bytes, entry.cb);
        else entry.finish();
      }
    }
    if (res.flushError !== null && res.flushError !== undefined) {
      this.emit('error', Object.assign(new Error(`write EPIPE`), {
        code: 'EPIPE', errno: res.flushError, syscall: 'write',
      }));
    }
    if (res.chunkB64) {
      this.__chunk = this.__chunk || [];
      this.__chunk.push(res.chunkB64);
    }
    if (!this.#paused) this.__drain();
    if (res.eof && !this.#eof) {
      this.#eof = true;
      this.__drain();
      this.emit('end');
      this.__maybeRetire();
    }
    if (!this.#destroyed && this.#id !== null) this.__schedule();
  }

  /** Surface buffered chunks as 'data' (Base64 → bytes → Buffer — the same
   * DshBuffer face discipline the child-process pump keeps: consumers parse
   * with the Buffer face, a bare Uint8Array strips it).
   * Index-consumed ON PURPOSE: a 'data' handler that pauses() mid-drain (the
   * standard node flow-control shape — pause on a backpressure threshold,
   * resume on drain) must leave every UNDELIVERED tail in the queue. A
   * take-all-then-unshift-current spelling would orphan chunks[at+1..] and
   * silently drop bytes on a TCP stream (rule 5). */
  __drain() {
    const chunks = this.__chunk;
    if (!chunks || chunks.length === 0) return;
    let at = 0;
    while (at < chunks.length) {
      if (this.#destroyed) {
        this.__chunk = chunks.slice(at);
        return;
      }
      if (this.#paused) {
        this.__chunk = chunks.slice(at);
        return;
      }
      this.emit('data', asBuffer(fromB64(chunks[at])));
      at += 1;
    }
    this.__chunk = [];
  }
}

/** Minimal strict base64 decoder (the gateway bridge's wire encoding; the
 * vendored upstream ships an encoder only — the same gap gateway.js fills). */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const fromB64 = (text) => {
  const clean = String(text).replace(/=+$/, '');
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const rem = clean.length - i;
    const v = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1] ?? 'A') << 12)
      | (B64.indexOf(clean[i + 2] ?? 'A') << 6) | B64.indexOf(clean[i + 3] ?? 'A');
    out.push((v >> 16) & 255);
    if (rem > 2) out.push((v >> 8) & 255);
    if (rem > 3) out.push(v & 255);
  }
  return new Uint8Array(out);
};

/** One loopback listener over a seam serverId: listen() resolves the gateway
 * grant (the resolved port is the source of truth), the pump turns accepts
 * into 'connection' events carrying SERVER-half TcpSockets, close() shuts
 * the listener (live connections stay addressable — node's semantics). */
class TcpServer extends EventEmitter {
  #id = null;
  #pumping = false;
  listening = false;

  listen(...args) {
    let port = 0;
    let host = '127.0.0.1';
    let callback;
    for (const arg of args) {
      if (typeof arg === 'number') port = arg;
      else if (typeof arg === 'string') host = arg;
      else if (typeof arg === 'function') callback = arg;
      else if (arg && typeof arg === 'object') {
        if (arg.port !== undefined) port = Number(arg.port);
        if (arg.host !== undefined) host = String(arg.host);
      }
    }
    if (typeof callback === 'function') this.once('listening', callback);
    if (host !== '127.0.0.1' && host !== 'localhost') {
      const error = Object.assign(new Error(`listen EACCES: address not in the loopback scope ${host}`), {
        code: 'EACCES', errno: -13, syscall: 'listen', address: host,
      });
      queueMicrotask(() => this.emit('error', error));
      return this;
    }
    socketListen({ scope: 'loopback', port }).then((res) => {
      if (res === null || res === undefined) {
        this.emit('error', Object.assign(new Error('listen EACCES: the socket.listen grant was refused'), {
          code: 'EACCES', errno: -13, syscall: 'listen', address: host,
        }));
        return;
      }
      this.#id = res.serverId;
      this.boundPort = res.port;
      this.listening = true;
      this.emit('listening');
      this.__schedule();
    }, (error) => {
      const code = error?.code === 'unavailable' ? 'EACCES' : 'EADDRINUSE';
      this.emit('error', Object.assign(new Error(`listen ${code}: ${error?.message ?? error}`), {
        code, errno: code === 'EACCES' ? -13 : -48, syscall: 'listen', address: host,
      }));
    });
    return this;
  }

  address() {
    return this.listening ? { address: '127.0.0.1', family: 'IPv4', port: this.boundPort } : null;
  }

  get listeningPort() { return this.boundPort; }

  close(callback) {
    if (typeof callback === 'function') this.once('close', callback);
    if (!this.listening) {
      queueMicrotask(() => this.emit('close'));
      return this;
    }
    this.listening = false;
    const id = this.#id;
    this.#id = null;
    if (id !== null) socketClose({ id }).catch(() => {});
    this.emit('close');
    return this;
  }

  unref() {}
  ref() {}

  __schedule() {
    if (this.#pumping) return;
    this.#pumping = true;
    setTimeout(() => {
      this.#pumping = false;
      this.__tick();
    }, PUMP_TICK_MS);
  }

  __tick() {
    if (!this.listening || this.#id === null) return;
    let res;
    try {
      res = pollIntrinsic(this.#id);
    } catch (error) {
      this.emit('error', error);
      return;
    }
    if (!this.listening) return;
    const accepted = res?.accepted ?? [];
    for (const entry of accepted) {
      const socket = new TcpSocket();
      socket.localPort = this.boundPort;
      socket.remotePort = entry.peerPort;
      socket.__adopt(entry.connectionId, entry.peerPort);
      this.emit('connection', socket);
    }
    this.__schedule();
  }
}

/** `net.createServer([options][, connectionListener])` over the seam. */
export const createTcpServer = (...args) => {
  const server = new TcpServer();
  for (const arg of args) {
    if (typeof arg === 'function') server.on('connection', arg);
    else if (arg && typeof arg === 'object' && typeof arg.connectionListener === 'function') {
      server.on('connection', arg.connectionListener);
    }
  }
  return server;
};

/** `new net.Socket()` face: an unconnected socket the caller drives with
 * connect(); fd-style construction ({ fd }) is NOT served — a host fd was
 * never in the v1.8.0 grant class (named non-goal, honest throw). */
export const TcpSocketFace = class Socket extends TcpSocket {
  constructor(options) {
    super();
    if (options && options.fd !== undefined) {
      throw new Error('node:net: Socket({ fd }) is not served — the v1.8.0 seam grants loopback dials, not host fds');
    }
  }
};

export { TcpSocket, TcpServer, toBytes, fromB64 };
