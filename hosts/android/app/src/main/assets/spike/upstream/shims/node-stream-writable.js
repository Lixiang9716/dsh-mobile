// dsh:logging-exempt (host shim: no side effects to log)
/**
 * shims/node-stream-writable.js — the sink half of the node:stream shim
 * (SinkEvents/Writable/Duplex + pipeline), split out of node-stream.js at
 * the size budget. The readable faces stay the single source of truth in
 * node-stream.js; the cycle is call-time-only (Duplex.from pairs a readable
 * with a writable at construction time, never at module evaluation).
 */
import { MiniStream, PassThrough, Readable } from 'upstream/shims/node-stream.js';

export class SinkEvents {
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
    const wrapped = function (...args) { this.off(event, wrapped); fn.apply(this, args); };
    wrapped.listener = fn;
    return this.prependListener(event, wrapped);
  }
  listenerCount(event) { return this._listeners.get(event)?.length ?? 0; }
  /** node's removeAllListeners([event]) — the vendored ws receiver teardown
   * calls it on socket close (websocket.js emitClose). No event removes
   * every listener; with one, only that event's list (W5-Q). */
  removeAllListeners(event) {
    if (event === undefined) this._listeners.clear();
    else this._listeners.delete(event);
    return this;
  }
  /** emit binds `this` to the emitter (node's EventEmitter contract) — the
   * vendored ws receiver's handlers read `this[kWebSocket]`, which is
   * undefined when listeners are invoked unbound (W5-Q 2026-09-28). */
  emit(event, ...args) {
    for (const fn of [...(this._listeners.get(event) ?? [])]) fn.apply(this, args);
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
  #errorEmitted = false;
  writableNeedDrain = false;
  writableEnded = false;
  writableFinished = false;
  destroyed = false;

  constructor(options = {}) {
    super();
    // node's SECOND construction protocol: a subclass overriding _write/
    // _final on its prototype (vendored ws's Receiver is the operative
    // case: `class Receiver extends Writable { _write(chunk, encoding, cb) }`
    // — the W4 corpus only used the options face). options.write keeps
    // priority; the prototype override drives when it is absent.
    const hasOptionsWrite = typeof options.write === 'function';
    const hasOptionsWritev = typeof options.writev === 'function';
    const hasProtoWrite = typeof this._write === 'function';
    if (!hasOptionsWrite && !hasOptionsWritev && !hasProtoWrite) {
      throw new TypeError('node:stream Writable: options.write(chunks, encoding, callback) or a _write(chunk, encoding, callback) override is required');
    }
    this.#writeImpl = hasOptionsWrite
      ? options.write
      : (hasProtoWrite
        ? (chunk, encoding, callback) => this._write(chunk, encoding, callback)
        : undefined);
    this.#finalImpl = typeof options.final === 'function'
      ? options.final
      : (typeof this._final === 'function'
        ? (callback) => this._final(callback)
        : undefined);
    this.#highWaterMark = typeof options.highWaterMark === 'number' && options.highWaterMark > 0
      ? options.highWaterMark
      : 16 * 1024;
    // node's LEGACY `_writableState` view (W5-Q): the vendored ws reads
    // `_writableState.length` (bufferedAmount), `.needDrain` (its resume
    // gate) and `.errorEmitted` (close accounting) straight off a
    // receiver/stream subclass. Live getters over the same state — routed
    // through real class getters because quickjs-ng cannot resolve private
    // names from a closure inside a constructor (measured: bare
    // `self.#errorEmitted` in the view getter is a SyntaxError there).
    const self = this;
    this._writableState = {
      get length() { return self.__writableStateQueued(); },
      get needDrain() { return self.__writableStateNeedDrain(); },
      get errorEmitted() { return self.__writableStateErrorEmitted(); },
      get ended() { return self.__writableStateEnded(); },
      get finished() { return self.writableFinished; },
      get destroyed() { return self.__writableStateDestroyed(); },
      autoDestroy: true,
      objectMode: options.objectMode === true,
    };
  }

  /** The _writableState view's read faces (private-field access from real
   * class methods is the quickjs-supported shape). */
  __writableStateQueued() { return this.#queuedBytes; }
  __writableStateNeedDrain() { return this.#needDrain; }
  __writableStateErrorEmitted() { return this.#errorEmitted; }
  __writableStateEnded() { return this.#ended; }
  __writableStateDestroyed() { return this.#destroyed; }

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
    if (error !== undefined && error !== null) {
      this.#errorEmitted = true;
      this.emit('error', error);
    }
    this.#close();
    return this;
  }

  close() { return this.destroy(); }
}

/** Duplex — the readable face of MiniStream fused with the Writable sink
 * face. The options constructor serves `{ read, write, final }` (ptc-runtime
 * channels); `Duplex.from({readable, writable})` pairs two ends into one
 * transport (the same object the vendored runtime hands its JsonChannel). */

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
