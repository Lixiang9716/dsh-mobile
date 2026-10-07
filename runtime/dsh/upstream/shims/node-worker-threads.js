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
 *
 * W4-N (2026-09-28) — the IN-PROCESS Worker face for the single verifier
 * spawn shape: session-persistence-jsonl's migration verifier runs its
 * worker entry (`worker.js` — the staged ESM twin of `worker.cjs`, same
 * translation unit per the shared worker.js.map) on THIS thread. No OS
 * thread and no subprocess exist (D2 holds: one serial JS thread); the
 * entry is a dynamic import whose top level reads `parentPort`/`workerData`
 * through live bindings that this module swaps in for the import window
 * (spawns serialize on a promise chain so two windows never overlap). The
 * module registry evaluates an entry ONCE per realm — but quickjs caches
 * module defs by NAME, so a repeat spawn RE-IMPORTS the same file under a
 * `./`-padded alias (the specifier-space cache-busting seam the first
 * Worker round named as a host need): `/vendor/…/lib/worker.js`, then
 * `/vendor/…/lib/./worker.js`, then `././`, … each alias compiles the same
 * bytes as a fresh module whose top level re-runs inside the swap window.
 * Node's message discipline holds: the entry posts one response then
 * closes its port; the parent's 'message' drains before 'exit'.
 */
/** The refused OS-thread spawn (the constructor face for entries that the
 * in-process face cannot serve — see the header). */
const failThread = (why) => {
  throw new Error(`worker_threads: Worker spawn refused (D2, single process) — ${why}`);
};

/* parentPort/workerData are LIVE bindings (export let): the in-process
 * Worker's import window swaps them in for the worker entry's top level and
 * restores the main-thread values (null/undefined) after. The default-export
 * snapshot below reads them through getters for the same reason. */
export let parentPort = null;
export let workerData = undefined;
export const isMainThread = true;

/** Spawns served per resolved entry: spawn 0 imports the plain specifier,
 * spawn N pads the file's last segment with N copies of './' so quickjs
 * sees a module NAME it has never evaluated (the registry caches by name,
 * not by file). Each alias re-runs the entry's top level — the vendored
 * verifier entry's entire behavior lives there (parse workerData, verify,
 * post, close). */
const spawnCounts = new Map();
/** The alias face: insert `n` './' segments before the file name. open(2)
 * ignores interior './' segments, so the alias resolves to the same file. */
const bustSpecifier = (s, n) => {
  const at = s.lastIndexOf('/');
  return `${s.slice(0, at + 1)}${'./'.repeat(n)}${s.slice(at + 1)}`;
};
/** Serialization of the parentPort/workerData swap window. */
let spawnChain = Promise.resolve();

/** The worker entry's importable specifier: node passes a URL (the built
 * worker.cjs sibling of the importing chunk); the staged closure serves the
 * bundle-root path, and the ESM twin (.js) is the loadable face of a .cjs
 * entry (worker.cjs/worker.js share one translation unit here). */
const entrySpecifier = (entry) => {
  let s = typeof entry === 'string' ? entry : String(entry?.href ?? entry);
  if (s.startsWith('data:')) {
    failThread('the data: bootstrap face needs tsx/esm registration (source-closure spawns), not served in this runtime');
  }
  if (s.startsWith('file://')) s = decodeURIComponent(s.slice('file://'.length));
  if (s.endsWith('.cjs')) s = s.slice(0, -'.cjs'.length) + '.js';
  return s;
};

/** The `{eval: true}` face (W8 source-entry-bootstrap): node compiles the
 * entry STRING as a CommonJS script inside the worker. In-process, the
 * evaluation runs on this thread inside the same parentPort/workerData
 * swap window the import face uses, with node's CJS eval-worker frame:
 * require / module / exports / process / __filename / __dirname. Two
 * scoped adaptations stand in for the OS-thread boundary node gives every
 * worker for free (single realm — D2):
 *   - `process` is a derivative of the runtime's process whose exit(code)
 *     ends only THIS worker (emits 'exit' with the code); node's worker
 *     process.exit never takes down the parent.
 *   - async callbacks the source schedules through setImmediate (the
 *     crash-probe idiom) are wrapped so an UNCAUGHT throw surfaces as the
 *     worker 'error' event followed by 'exit' 1 — the boundary the real
 *     thread's uncaughtException channel provides. There is no second
 *     thread to crash, so the worker face owns the error surface.
 * `require` serves the worker-threads namespace (the live parentPort /
 * workerData bindings — the same face the import window swaps), which is
 * the one specifier the corpus's eval sources ask for. */
const runEvalWorker = (source, workerPort, emit) => {
  let exited = false;
  const exit = (code) => {
    if (exited) return;
    exited = true;
    emit('exit', code);
  };
  const scopedProcess = Object.create(globalThis.process ?? {});
  scopedProcess.exit = (code = 0) => exit(code);
  const scopedSetImmediate = (fn, ...rest) => {
    return setImmediate(() => {
      try {
        fn(...rest);
      } catch (error) {
        emit('error', error instanceof Error ? error : new Error(String(error)));
        exit(1);
      }
    }, ...rest);
  };
  const workerFace = {
    get parentPort() { return parentPort; },
    get workerData() { return workerData; },
    get threadId() { return 1; },
    isMainThread: false,
    MessageChannel,
    MessagePort,
    setEnvironmentData,
    getEnvironmentData,
  };
  const requireFace = (specifier) => {
    if (specifier === 'node:worker_threads' || specifier === 'worker_threads') return workerFace;
    throw new Error(`eval worker: require('${specifier}') is not served in this runtime (the corpus's eval sources require only node:worker_threads)`);
  };
  const fn = new Function('require', 'module', 'exports', 'process', '__filename', '__dirname', 'setImmediate', source);
  fn(requireFace, { exports: {} }, {}, scopedProcess, 'eval-worker.js', '.', scopedSetImmediate);
  // The sync body ran; yield a turn so the top-level scheduled callbacks
  // (setImmediate probes) surface before the window closes.
  return new Promise((resolve) => setImmediate(resolve));
};

export class Worker {
  #workerPort;
  #parentEnd;
  #listeners = new Map();
  #terminated = false;

  constructor(entry, options = {}) {
    // The {eval: true} arm: the entry STRING is source code, not a path —
    // node compiles it as CJS inside the worker (runEvalWorker below).
    const evalSource = options?.eval === true && typeof entry === 'string' ? entry : null;
    const base = evalSource !== null ? null : entrySpecifier(entry);
    const spawnIndex = base === null ? 0 : (spawnCounts.get(base) ?? 0);
    if (base !== null) spawnCounts.set(base, spawnIndex + 1);
    const specifier = base === null ? null : (spawnIndex === 0 ? base : bustSpecifier(base, spawnIndex));
    const workerPort = new MessagePort(); // the entry's parentPort end
    const parentEnd = new MessagePort(); // the main-thread end
    MessagePort._pair(parentEnd, workerPort);
    this.#workerPort = workerPort;
    this.#parentEnd = parentEnd;

    const emit = (event, ...args) => {
      for (const fn of [...(this.#listeners.get(event) ?? [])]) fn(...args);
    };
    workerPort.on('close', () => emit('exit', 0));
    parentEnd.on('message', (value) => emit('message', value));
    parentEnd.on('close', () => emit('exit', 0));

    // The import window: serialize so two spawns never swap the live
    // bindings concurrently (the single JS thread makes each window atomic
    // once started; the chain keeps the awaits from interleaving).
    spawnChain = spawnChain.then(async () => {
      parentPort = workerPort;
      workerData = structuredClonePort(options?.workerData, []);
      try {
        if (evalSource !== null) await runEvalWorker(evalSource, workerPort, emit);
        else await import(specifier);
      } catch (error) {
        emit('error', error instanceof Error ? error : new Error(String(error)));
        emit('exit', 1);
      } finally {
        parentPort = null;
        workerData = undefined;
      }
    });
  }
  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, []);
    this.#listeners.get(event).push(fn);
    return this;
  }
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
  /** Main→worker post: the MAIN-side end sends, so the entry's parentPort
   * (the worker-side end) receives (W8 — the in-process Worker's first
   * consumer drove only worker→main, so this direction posted on the
   * worker's own end and never arrived; the lifecycle stop() handshake
   * needs it). */
  postMessage(value) { this.#parentEnd.postMessage(value); }
  /** node resolves with the exit code; the corpus only awaits settlement. */
  terminate() {
    this.#terminated = true;
    if (!this.#workerPort) return Promise.resolve(0);
    this.#workerPort.close();
    return Promise.resolve(0);
  }
}

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
// parentPort/workerData read through getters: the default-import face must
// observe the live swap window like the named bindings do.
export default { Worker, MessageChannel, MessagePort, get parentPort() { return parentPort; }, get workerData() { return workerData; }, isMainThread, setEnvironmentData, getEnvironmentData };
