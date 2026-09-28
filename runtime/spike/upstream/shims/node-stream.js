// dsh:logging-exempt (host shim: no side effects to log)
/**
 * node:stream — the subset the vendored spine consumes: Readable.from
 * (iterable source), pipeline (serial pump, callback and promise forms),
 * PassThrough (a buffered identity segment), Writable (the sink face the
 * ssh protocol specs drive: user `write` impl, highWaterMark backpressure,
 * 'drain', destroy), and Duplex (both faces: the options constructor the
 * ptc-runtime channel drives, plus `Duplex.from({readable, writable})`
 * pairing). Streams here are the one-shot-on-end shapes the node:zlib shim
 * exposes — the pipeline drains async iterators in order, which is exactly
 * how the corpus composes generation.js's rows -> zstd -> sink.
 */
class MiniStream {
  #listeners = new Map();
  #ended = false;
  #chunks = [];
  #waiters = [];
  #error = undefined;
  #flowing = false;
  on(event, fn) {
    this.#push(event, fn);
    if (event === 'data' && !this.#flowing) this.#startFlowing();
    return this;
  }
  once(event, fn) {
    const wrapped = (value) => { this.#drop(event, wrapped); fn(value); };
    this.#push(event, wrapped);
    if (event === 'data' && !this.#flowing) this.#startFlowing();
    return this;
  }
  off(event, fn) { this.#drop(event, fn); return this; }
  removeListener(event, fn) { return this.off(event, fn); }
  /** node's flowing-mode switches; a resumed stream with no 'data' listener
   * discards (the ssh peers resume their output taps before collecting). */
  resume() {
    this.#flowing = true;
    this.#flushQueued();
    return this;
  }
  pause() { this.#flowing = false; return this; }
  #startFlowing() {
    this.#flowing = true;
    this.#flushQueued();
    if (this.#ended) this.emit('end');
  }
  #flushQueued() {
    if (this.#ended) { this.emit('end'); return; }
    const queued = this.#chunks.splice(0);
    const dataListeners = this.#listeners.get('data')?.length ?? 0;
    if (dataListeners === 0) return; // resumed with no tap: node discards
    for (const chunk of queued) this.emit('data', chunk);
  }
  #push(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, []);
    this.#listeners.get(event).push(fn);
  }
  #drop(event, fn) {
    const list = this.#listeners.get(event) ?? [];
    const at = list.indexOf(fn);
    if (at >= 0) list.splice(at, 1);
  }
  listenerCount(event) { return this.#listeners.get(event)?.length ?? 0; }
  emit(event, value) {
    for (const fn of [...(this.#listeners.get(event) ?? [])]) fn(value);
    return this.#listeners.has(event);
  }
  push(chunk) {
    // Flowing chunks go straight to 'data' listeners; the queue keeps a copy
    // for the iterator face (nothing in the corpus consumes both on one
    // stream — node would route exclusively, we over-deliver rather than
    // ever stall a consumer).
    if (this.#flowing && (this.#listeners.get('data')?.length ?? 0) > 0) {
      this.emit('data', chunk);
    }
    this.#chunks.push(chunk);
    this.#wake();
  }
  /** end([chunk][, callback]) — node's readable.end pushes the FINAL chunk
   * before ending (ptc-runtime's drainOutput test ends a PassThrough with
   * 'last output'; the old body dropped the argument so the data listener
   * saw nothing). */
  end(chunk, ...rest) {
    if (typeof chunk === 'function') { rest.unshift(chunk); chunk = undefined; }
    if (chunk !== undefined && chunk !== null) this.push(chunk);
    this.#ended = true;
    if (this.#flowing) this.emit('end');
    const callback = typeof rest[0] === 'function' ? rest[0] : undefined;
    if (callback !== undefined) queueMicrotask(callback);
    this.#wake();
  }
  fail(error) { this.#error = error; this.#wake(); }
  #wake() { for (const w of this.#waiters.splice(0)) w(); }
  #next() {
    if (this.#chunks.length > 0) return Promise.resolve({ value: this.#chunks.shift(), done: false });
    if (this.#destroyed && this.#error === undefined && !this.#ended) return Promise.resolve({ value: undefined, done: true });
    if (this.#error !== undefined) return Promise.reject(this.#error);
    if (this.#ended) return Promise.resolve({ value: undefined, done: true });
    // Wake re-evaluates the state; the promise ALWAYS settles with an
    // iterator result (a bare undefined would break the async-iterator
    // protocol quickjs enforces).
    return new Promise((resolve, reject) => {
      this.#waiters.push(() => {
        try { resolve(this.#next()); } catch (error) { reject(error); }
      });
    });
  }
  read() { return this.#chunks.length > 0 ? this.#chunks.shift() : null; }
  [Symbol.asyncIterator]() {
    // return/throw present: a `for await` that breaks (or a consumer's
    // throw) calls them, and quickjs rejects an iterator that lacks them.
    return {
      next: () => this.#next(),
      return: (value) => {
        this.#waiters.splice(0);
        return Promise.resolve({ value, done: true });
      },
      throw: (error) => Promise.reject(error),
    };
  }
  then(resolve, reject) {
    return this.#drain().then(resolve, reject);
  }
  async #drain() {
    const out = [];
    for (;;) {
      const { value, done } = await this.#next();
      if (done) return out;
      out.push(value);
    }
  }
  /** PassThrough write: chunks route through immediately; a trailing
   * completion fires from a microtask (node's receipt timing) — the framed
   * RPC writers hang their send promises on it. */
  write(chunk, ...rest) {
    this.push(chunk);
    const callback = typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : undefined;
    if (callback) queueMicrotask(callback);
    return true;
  }
  /** node's pipe: source flowing → destination.write; source 'end' ends the
   * destination unless `{end: false}`; destination backpressure pauses the
   * source until 'drain' (the subprocess-ssh transport wiring pipes its
   * stdin/stdout/control legs through). Returns the destination. */
  pipe(destination, options = {}) {
    this.on('data', (chunk) => {
      const wantsMore = destination.write(chunk);
      if (!wantsMore && typeof this.pause === 'function') {
        this.pause();
        destination.once?.('drain', () => this.resume());
      }
    });
    this.once('end', () => {
      if (options.end !== false) destination.end?.();
    });
    return destination;
  }
  #destroyed = false;
  /** node's destroy(error): 'error' only when an error was passed, then
   * 'close' — the ssh peers wire output.on('error'/'close') to connection
   * loss, so the events (not just the iterator state) must move. A CLEAN
   * destroy terminates the iterator face WITHOUT marking a graceful end:
   * node keeps readableEnded false on a destroyed-never-ended stream (the
   * ptc-runtime bounds test drains a destroyed stream and expects false),
   * and #next returns done for a destroyed queue so for-await still
   * finishes. */
  destroy(error) {
    if (this.#destroyed) return this;
    this.#destroyed = true;
    if (error !== undefined && error !== null) {
      this.emit('error', error);
      this.fail(error);
    }
    this.#wake();
    this.emit('close');
    return this;
  }
  get destroyed() { return this.#destroyed; }
  /** node's terminal-state getters: drainOutput re-drains an already-ended
   * stream and short-circuits on readableEnded — without the getter the
   * second call arms a fresh 1s timer and resolves false (measured
   * 2026-09-28, ptc-runtime output-stream). */
  get readableEnded() { return this.#ended; }
  get writableEnded() { return this.#ended; }
  close() { this.end(); }
}
export class PassThrough extends MiniStream {}
export class Readable extends MiniStream {
  static from(iterable) {
    const stream = new Readable();
    (async () => {
      try {
        for await (const chunk of iterable) stream.push(chunk);
        stream.end();
      } catch (error) {
        stream.fail(error);
      }
    })();
    return stream;
  }
}

/** Shared listener plumbing for the Writable/Duplex sinks (the events.js
 * subset they need: on/once/off/emit/listenerCount — `events.once(stream,
 * 'drain')` rides the same face). */
class SinkEvents {
  _listeners = new Map();
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, []);
    this._listeners.get(event).push(fn);
    return this;
  }
  once(event, fn) {
    // Same wrap shape as events.js: the stored wrapper exposes the original
    // as .listener, so off()/removeListener(original) unwraps (the vendored
    // peers once('drain') then off('drain', sameHandler) on close).
    const wrapped = (...args) => { this.off(event, wrapped); fn(...args); };
    wrapped.listener = fn;
    return this.on(event, wrapped);
  }
  off(event, fn) {
    const list = this._listeners.get(event);
    if (list !== undefined) {
      const at = list.findIndex((entry) => entry === fn
        || (entry !== undefined && entry.listener === fn));
      if (at >= 0) {
        list.splice(at, 1);
        if (list.length === 0) this._listeners.delete(event);
      }
    }
    return this;
  }
  removeListener(event, fn) { return this.off(event, fn); }
  prependListener(event, fn) {
    const list = this._listeners.get(event) ?? [];
    this._listeners.set(event, list);
    list.unshift(fn);
    return this;
  }
  prependOnceListener(event, fn) {
    const wrapped = (...args) => { this.off(event, wrapped); fn(...args); };
    wrapped.listener = fn;
    return this.prependListener(event, wrapped);
  }
  listenerCount(event) { return this._listeners.get(event)?.length ?? 0; }
  emit(event, ...args) {
    for (const fn of [...(this._listeners.get(event) ?? [])]) fn(...args);
    return this._listeners.has(event);
  }
}

/** Writable — the sink face over a user `write(chunk, encoding, callback)`:
 * `write()` returns the highWaterMark verdict and flips `writableNeedDrain`;
 * the user callback retires the queued bytes and emits 'drain' when the
 * backpressure clears (the ssh protocol specs' backpressure bound is exact
 * against this). destroy()/close() emit 'close'; end() settles 'finish'. */
export class Writable extends SinkEvents {
  #writeImpl;
  #finalImpl;
  #highWaterMark;
  #queuedBytes = 0;
  #needDrain = false;
  #ended = false;
  #destroyed = false;
  writableNeedDrain = false;
  writableEnded = false;
  writableFinished = false;
  destroyed = false;

  constructor(options = {}) {
    super();
    if (typeof options.write !== 'function' && typeof options.writev !== 'function') {
      throw new TypeError('node:stream Writable: options.write(chunks, encoding, callback) is required');
    }
    this.#writeImpl = options.write;
    this.#finalImpl = options.final;
    this.#highWaterMark = typeof options.highWaterMark === 'number' && options.highWaterMark > 0
      ? options.highWaterMark
      : 16 * 1024;
  }

  get highWaterMark() { return this.#highWaterMark; }

  #corked = false;
  #corkQueue = [];

  /** node's cork/uncork: writes while corked buffer (header+body framing —
   * the ptc-runtime channel corks a frame together) and flush in order on
   * uncork. */
  cork() { this.#corked = true; return this; }
  uncork() {
    this.#corked = false;
    const queued = this.#corkQueue.splice(0);
    for (const [chunk, encoding, callback] of queued) this.write(chunk, encoding, callback);
    return this;
  }

  /** node: write() returns whether the stream wants more (false = over hwm,
   * 'drain' fires once the queued bytes retire). The callback form is the
   * same call with a trailing completion.
   *
   * Writes are SERIALIZED node-style: the user write impl sees one chunk at
   * a time and chunk N+1's impl runs only after chunk N's callback retires
   * (the sdk-protocol flush() contract queues an empty barrier chunk behind
   * the pending frame — measured 2026-09-27: parallel impl invocation let
   * the barrier overtake the frame). */
  #writeQueue = []; // pending [chunk, encoding, callback, length] — FIFO
  #inFlight = false; // the head's impl is running, its callback pending

  write(chunk, ...rest) {
    if (this.#destroyed) {
      const error = new Error('write after destroy');
      this.emit('error', error);
      if (typeof rest[0] === 'function') rest[0](error);
      return false;
    }
    if (this.#ended) throw new Error('write after end');
    if (this.#corked) {
      const callback = typeof rest[rest.length - 1] === 'function' ? rest.pop() : undefined;
      const encoding = typeof rest[0] === 'string' ? rest.shift() : undefined;
      this.#corkQueue.push([chunk, encoding, callback]);
      return !this.#needDrain;
    }
    const callback = typeof rest[rest.length - 1] === 'function' ? rest.pop() : undefined;
    const encoding = typeof rest[0] === 'string' ? rest.shift() : undefined;
    const length = chunk?.length ?? 0;
    this.#writeQueue.push([chunk, encoding ?? 'buffer', callback, length]);
    this.#queuedBytes += length;
    this.#needDrain = this.#queuedBytes >= this.#highWaterMark;
    this.writableNeedDrain = this.#needDrain;
    this.#pump();
    return !this.#needDrain;
  }

  /** Drive the FIFO: the head chunk's impl is in flight; a synchronous
   * callback lets the loop continue, an async one re-enters via #pump when
   * it retires. */
  #pump() {
    if (this.#inFlight) return;
    while (this.#writeQueue.length > 0) {
      const [chunk, encoding, callback, length] = this.#writeQueue[0];
      let retired = false;
      const done = (error) => {
        if (retired) return;
        retired = true;
        this.#inFlight = false;
        this.#writeQueue.shift();
        this.#queuedBytes = Math.max(0, this.#queuedBytes - length);
        if (this.#needDrain && this.#queuedBytes < this.#highWaterMark) {
          this.#needDrain = false;
          this.writableNeedDrain = false;
          this.emit('drain');
        }
        // A write-callback error destroys the stream and emits 'error'
        // (node's write-callback contract — measured 2026-09-28: the
        // sdk-jsonrpc-server flush-failure spec watches output.on('error')).
        if (error !== undefined && error !== null) {
          this.#destroyed = true;
          this.destroyed = true;
          this.emit('error', error);
        }
        if (typeof callback === 'function') callback(error);
        if (this.#writeQueue.length > 0 && !this.#destroyed) this.#pump();
        else this.#settleEnded();
      };
      this.#inFlight = true;
      this.#writeImpl(chunk, encoding, done);
      if (!retired) return; // async callback — resume from its done()
      // synchronous callback — the entry retired; keep draining in-tick
    }
  }

  /** end() defers finish until every queued write retired (node flushes
   * first); re-checked from #pump's done path. */
  #pendingFinish = null;
  #settleEnded() {
    const settle = this.#pendingFinish;
    if (settle === null) return;
    this.#pendingFinish = null;
    settle();
  }

  /** Optional trailing callback, node's `end(chunk, cb)` shape. */
  end(chunk, callback) {
    if (typeof chunk === 'function') { callback = chunk; chunk = undefined; }
    if (this.#corked) this.uncork();
    if (chunk !== undefined && chunk !== null) this.write(chunk);
    if (this.#ended || this.#destroyed) return this;
    this.#ended = true;
    this.writableEnded = true;
    const settle = () => {
      this.writableFinished = true;
      if (typeof this.#finalImpl === 'function') {
        this.#finalImpl((finalError) => {
          if (finalError) this.emit('error', finalError);
          else this.emit('finish');
          this.#close();
          typeof callback === 'function' && callback(finalError);
        });
      } else {
        this.emit('finish');
        this.#close();
        typeof callback === 'function' && callback();
      }
    };
    // A queued write retires before the finish event (node flushes first):
    // the queue drives settle through #pump's done path; an empty queue
    // settles immediately.
    if (this.#writeQueue.length > 0) this.#pendingFinish = settle;
    else settle();
    return this;
  }

  #close() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.destroyed = true;
    this.emit('close');
  }

  destroy(error) {
    if (this.#destroyed) return this;
    if (error !== undefined && error !== null) this.emit('error', error);
    this.#close();
    return this;
  }

  close() { return this.destroy(); }
}

/** Duplex — the readable face of MiniStream fused with the Writable sink
 * face. The options constructor serves `{ read, write, final }` (ptc-runtime
 * channels); `Duplex.from({readable, writable})` pairs two ends into one
 * transport (the same object the vendored runtime hands its JsonChannel). */
export class Duplex extends SinkEvents {
  #readImpl;
  #writeSink;
  #chunks = [];
  #ended = false;
  #error = undefined;
  #flowing = false;
  #reading = false;

  constructor(options = {}) {
    super();
    this.#readImpl = typeof options.read === 'function' ? options.read : null;
    // Duplex.from has no user write impl — the sink face is replaced by the
    // paired writable; a storing no-op keeps the constructor honest.
    this.#writeSink = new Writable({
      ...options,
      write: typeof options.write === 'function'
        ? options.write
        : (_chunk, _encoding, callback) => callback(),
    });
    // The sink's events surface on the duplex (JsonChannel listens here).
    this.#writeSink.on('drain', () => this.emit('drain'));
    this.#writeSink.on('finish', () => this.emit('finish'));
    this.#writeSink.on('close', () => this.emit('close'));
    this.#writeSink.on('error', (error) => this.emit('error', error));
  }

  /** Pair a readable and a writable end into one transport object: reads
   * proxy the readable's data/end, writes proxy the writable. */
  static from(streams) {
    if (streams && typeof streams.write === 'function' && typeof streams.read === 'function' && streams.on) {
      return streams; // already duplex-shaped
    }
    const { readable, writable } = streams ?? {};
    if (!readable || !writable || typeof readable.on !== 'function' || typeof writable.write !== 'function') {
      throw new TypeError('node:stream Duplex.from: a {readable, writable} pair is required');
    }
    const duplex = new Duplex({});
    readable.on('data', (chunk) => duplex.#deliver(chunk));
    readable.once?.('end', () => duplex.#finishReadable());
    readable.once?.('error', (error) => duplex.emit('error', error));
    duplex.write = (chunk, ...rest) => writable.write(chunk, ...rest);
    duplex.end = (...args) => (writable.end(...args), duplex);
    duplex.destroy = (error) => {
      if (duplex.#destroyedFlag) return duplex;
      duplex.#destroyedFlag = true;
      if (error !== undefined && error !== null) duplex.emit('error', error);
      if (typeof readable.destroy === 'function') readable.destroy(error);
      if (typeof writable.destroy === 'function') writable.destroy(error);
      duplex.emit('close');
      return duplex;
    };
    return duplex;
  }

  #destroyedFlag = false;

  #deliver(chunk) {
    if (this.#flowing) this.emit('data', chunk);
    else this.#chunks.push(chunk);
  }

  #finishReadable() {
    this.#ended = true;
    this.emit('end');
  }

  /** Flowing-mode attach: deliver queued chunks, then ask the user read()
   * for more (node schedules _read; re-armed after each delivered chunk). */
  on(event, listener) {
    super.on(event, listener);
    if (event === 'data' && !this.#flowing) {
      this.#flowing = true;
      const queued = this.#chunks.splice(0);
      for (const chunk of queued) this.emit('data', chunk);
      if (!this.#ended) this.#pull();
    }
    return this;
  }

  /** One user read() round; re-arms only while a consumer is attached and
   * data keeps arriving (a read() that never pushes stops the loop). */
  #pull() {
    if (this.#readImpl === null || this.#reading || this.#ended) return;
    this.#reading = true;
    try {
      this.#readImpl();
    } finally {
      this.#reading = false;
    }
  }

  /** The user-facing push (the options.read body calls it). While flowing
   * the chunk goes straight out; a null push ends the readable side. */
  push(chunk) {
    if (chunk === null || chunk === undefined) {
      this.#finishReadable();
      return false;
    }
    this.#deliver(chunk);
    if (this.#flowing && !this.#ended) this.#pull();
    return true;
  }

  read() { return this.#chunks.length > 0 ? this.#chunks.shift() : null; }

  /** The sink face, delegated to the internal Writable (length accounting,
   * backpressure verdicts and the user write impl stay in one place). */
  write(chunk, ...rest) { return this.#writeSink.write(chunk, ...rest); }
  cork() { this.#writeSink.cork(); return this; }
  uncork() { this.#writeSink.uncork(); return this; }
  end(...args) { this.#writeSink.end(...args); return this; }
  get writableNeedDrain() { return this.#writeSink.writableNeedDrain; }
  get writableEnded() { return this.#writeSink.writableEnded; }
  get writableFinished() { return this.#writeSink.writableFinished; }
  get highWaterMark() { return this.#writeSink.highWaterMark; }

  destroy(error) {
    this.#writeSink.destroy(error);
    this.#error = error ?? this.#error;
    if (!this.#ended) this.#finishReadable();
    return this;
  }
  /** Same pipe contract, reading from the duplex's own readable side (the
   * ptc/process transports pipe a duplex into a plain stream). */
  pipe(destination, options = {}) {
    this.on('data', (chunk) => {
      const wantsMore = destination.write(chunk);
      if (!wantsMore) {
        this.#writeSink.pause?.();
        destination.once?.('drain', () => this.#writeSink.resume?.());
      }
    });
    this.once('end', () => {
      if (options.end !== false) destination.end?.();
    });
    return destination;
  }
  get destroyed() { return this.#writeSink.destroyed || this.#destroyedFlag; }
  close() { return this.destroy(); }

  /** Thenable drain (a pipeline sink may await the stream). */
  then(resolve, reject) {
    const out = [];
    this.on('data', (chunk) => out.push(chunk));
    return new Promise((res, rej) => {
      this.once('end', () => res(out));
      this.once('error', rej);
    }).then(resolve, reject);
  }
}
/** Output a transform has ALREADY buffered, drained synchronously. Never
 * waits: read() === null means "nothing buffered now", not "data will
 * arrive" — only more writes or end() produce more output. */
const drainNow = (t) => {
  const out = [];
  for (;;) {
    const v = t.read();
    if (v === null || v === undefined) break;
    out.push(v);
  }
  return out;
};

export async function pipeline(...parts) {
  const callback = typeof parts[parts.length - 1] === 'function' ? parts.pop() : undefined;
  const stages = parts.slice(1);
  try {
    let source = parts[0];
    if (!(source && typeof source[Symbol.asyncIterator] === 'function')) {
      source = Readable.from(source);
    }
    const streams = stages.filter((s) => s !== null && typeof s === 'object' && typeof s.write === 'function');
    // node's sink shape: plain function stages consume the stream before
    // them ONCE (as an AsyncIterable), never per chunk.
    const sinks = stages.filter((s) => typeof s === 'function');
    for await (const chunk of source) {
      let value = chunk;
      for (const t of streams) {
        t.write(value);
        // Incremental faces emit per write — hand buffered output to the
        // next stage now. Buffered faces (zlib zstd streams) produce
        // nothing until end(); the old per-chunk read poll re-armed a
        // 0-timer forever against them (the session-persistence-jsonl
        // generation/multi-edge hang).
        const out = drainNow(t);
        if (out.length > 0) value = out.length === 1 ? out[0] : out;
      }
    }
    for (const t of streams) {
      if (typeof t.end === 'function') t.end();
    }
    let current = streams.length > 0 ? streams[streams.length - 1] : source;
    for (const sink of sinks) current = await sink(current);
    if (callback) callback(undefined, current);
    return current;
  } catch (error) {
    if (callback) return callback(error);
    throw error;
  }
}
/** duplexPair([options]) — two cross-wired duplexes ([client, server]):
 * writes to one arrive as reads on the other (node:stream's convenience
 * pair, the subprocess-ssh transports' fixture). */
export const duplexPair = (options) => {
  const first = new PassThrough();
  const second = new PassThrough();
  const client = Duplex.from({ readable: first, writable: second });
  const server = Duplex.from({ readable: second, writable: first });
  return [client, server];
};

export default { Readable, PassThrough, Writable, Duplex, pipeline, duplexPair };
