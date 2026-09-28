// dsh:logging-exempt (host shim: no side effects to log)
/**
 * node:worker_threads — the single-process shim. This runtime is
 * single-process by constitution (D2): there is no thread to spawn. The
 * vendored spine's own browser path makes the same move ("the browser
 * worker stubs the native flock entry to immediate success: it is
 * single-process, so the in-process write claim already excludes every
 * writer" — session-persistence-jsonl/lease). Construction fails LOUD
 * naming the in-process alternative; module-level imports (Worker,
 * parentPort, workerData) resolve so the importing module loads.
 *
 * The 2026-09-27 suite round added the MESSAGE-CHANNEL face: the browser
 * use and inspector families drive `MessageChannel`/`MessagePort` pairs
 * as the RPC transport (`import { MessageChannel } from
 * "node:worker_threads"`, worker-rpc + inspector hosts). A channel is
 * linked in-memory ports: postMessage structured-clones the value
 * (functions throw — the clone seam the specs assert with /clone/) and
 * delivers it to the peer as a microtask; a transferred port in the
 * transfer list rides by reference (single process — there is no wire to
 * move it over); close() emits 'close' on BOTH ends (node: either side
 * closing ends the channel). Messages queue until the first 'message'
 * listener or start(), node's delivery discipline.
 */
const failLoud = () => {
  throw new Error(
    'worker_threads: this runtime is single-process (D2) — Worker spawn is '
    + 'unavailable; upstream\'s browser path replaces the worker with an '
    + 'in-process equivalent (see session-persistence-jsonl/lease)');
};
export class Worker {
  constructor() { failLoud(); }
  postMessage() { failLoud(); }
  terminate() { return Promise.reject(new Error('worker_threads: unavailable')); }
  once() { return this; }
  on() { return this; }
}
export const parentPort = null;
export const workerData = undefined;
export const isMainThread = true;

/* getEnvironmentData/setEnvironmentData — node's cross-worker KV. One
 * process here (D2), so the honest transport is a module-global Map (the
 * multi-instance rule: the map lives on globalThis so a node:face import
 * and a bundle-relative import of this file share it). Structured-clone
 * semantics preserved: values clone on SET like a postMessage payload would.
 */
const envData = () => {
  if (typeof globalThis.__DSH_WORKER_ENV_DATA__ === 'undefined') {
    globalThis.__DSH_WORKER_ENV_DATA__ = new Map();
  }
  return globalThis.__DSH_WORKER_ENV_DATA__;
};
export const setEnvironmentData = (key, value = undefined) => {
  if (value === undefined && arguments.length === 1) {
    envData().delete(key); // node: setEnvironmentData(key) with no value deletes
    return;
  }
  envData().set(key, structuredClonePort(value, []));
};
export const getEnvironmentData = (key) => {
  const value = envData().get(key);
  return value === undefined ? undefined : structuredClonePort(value, []);
};

/** node's MessagePort: an EventEmitter-shaped endpoint. on('message')
 * implicitly starts delivery (node's contract), so `start()` is only
 * spelled out by callers that attach listeners before posting. */
export class MessagePort {
  #peer = null;
  #queue = []; // { message, ports } awaiting start / listener attach
  #listeners = new Map();
  #started = false;
  #closed = false;
  onmessage = undefined;

  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, []);
    this.#listeners.get(event).push(fn);
    if (event === 'message') this.start();
    return this;
  }
  addEventListener(event, fn) { return this.on(event, fn); }
  once(event, fn) {
    const wrapped = (...args) => { this.off(event, wrapped); fn(...args); };
    return this.on(event, wrapped);
  }
  off(event, fn) {
    const list = this.#listeners.get(event);
    if (list !== undefined) {
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    }
    return this;
  }
  removeListener(event, fn) { return this.off(event, fn); }
  removeEventListener(event, fn) { return this.off(event, fn); }
  listenerCount(event) { return this.#listeners.get(event)?.length ?? 0; }
  /** node's inspectors read a port's listeners like any emitter's
   * (events.getEventListeners dispatches on the listenerCount+listeners
   * pair), so the raw list face is part of the port contract. */
  listeners(event) { return [...(this.#listeners.get(event) ?? [])]; }
  emit(event, ...args) {
    for (const fn of [...(this.#listeners.get(event) ?? [])]) fn(...args);
    return this.#listeners.has(event);
  }

  /** Begin delivering queued messages (idempotent, node's shape). */
  start() {
    if (this.#started || this.#closed) return;
    this.#started = true;
    if (this.#queue.length > 0) queueMicrotask(() => this.#drain());
  }

  /** node's unref() counterpart; nothing to release in-memory. */
  unref() { return this; }
  ref() { return this; }

  #drain() {
    while (this.#queue.length > 0) {
      const { message } = this.#queue.shift();
      if (typeof this.onmessage === 'function') this.onmessage({ data: message });
      this.emit('message', message);
    }
  }

  /** postMessage on the PEER receives a structured clone; a function
   * anywhere in the value throws (the worker boundary the specs assert
   * with /clone/); ports in the transfer list ride by reference. */
  postMessage(value, transferList) {
    if (this.#closed) throw new Error('worker_threads: postMessage failed — the port is closed');
    const cloned = structuredClonePort(value, transferList ?? []);
    if (this.#peer === null || this.#peer.#closed) return;
    this.#peer.#queue.push({ message: cloned });
    if (this.#peer.#started) queueMicrotask(() => this.#peer.#drain());
  }

  /** Close this end: messages stop, and both ends observe 'close' (node
   * emits it on each port of a channel once either side closed). */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.length = 0;
    this.#peer?.#peerClosed();
    this.emit('close');
  }

  /** The peer closed: messages the peer posted BEFORE closing still deliver
   * (node's discipline — 'close' fires only after the queued incoming
   * messages drain; worker-rpc's answer() posts the response then closes,
   * and the requester must observe that response, never the close), then
   * this end closes too. */
  #peerClosed() {
    if (this.#closed) return;
    this.#started = true; // allow the final drain without a start() gate
    this.#drain();
    this.#closed = true;
    this.#queue.length = 0;
    this.emit('close');
  }

  /** Wire a peer (MessageChannel's constructor only). */
  static _pair(a, b) {
    a.#peer = b;
    b.#peer = a;
  }
}

/** Structured-clone the plain-data subset the RPC frames carry; MessagePort
 * values pass through by reference (a transfer is a wire concept). */
const structuredClonePort = (value, transferList) => {
  if (value instanceof MessagePort) return value;
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function') throw cloneError();
    return value;
  }
  if (value instanceof MessagePort) return value;
  const out = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value)) {
    out[key] = structuredClonePort(value[key], transferList);
  }
  return out;
};
const cloneError = () => new Error('worker_threads: value could not be cloned — functions have no structured-clone face');

export class MessageChannel {
  port1 = new MessagePort();
  port2 = new MessagePort();
  constructor() {
    MessagePort._pair(this.port1, this.port2);
  }
}
export default { Worker, MessageChannel, MessagePort, parentPort, workerData, isMainThread, setEnvironmentData, getEnvironmentData };
