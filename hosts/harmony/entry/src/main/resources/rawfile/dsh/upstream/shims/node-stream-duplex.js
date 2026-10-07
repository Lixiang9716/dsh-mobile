// dsh:logging-exempt (host shim: no side effects to log)
/**
 * shims/node-stream-duplex.js — the Duplex face of the node:stream shim
 * (options constructor, Duplex.from pairing with the X4 close accounting),
 * split out of node-stream-writable.js at the size budget. SinkEvents and
 * Writable stay the single source of truth in node-stream-writable.js; the
 * readable face comes from node-stream.js (call-time reads only).
 */
import { SinkEvents, Writable } from 'upstream/shims/node-stream-writable.js';
import { Readable } from 'upstream/shims/node-stream.js';

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
    duplex.end = (...args) => { face.wrapperEnded = true; writable.end(...args); return duplex; };
    duplex.destroy = (error) => {
      if (duplex.#destroyedFlag) return duplex;
      duplex.#destroyedFlag = true;
      if (error !== undefined && error !== null) duplex.emit('error', error);
      if (typeof readable.destroy === 'function') readable.destroy(error);
      if (typeof writable.destroy === 'function') writable.destroy(error);
      duplex.emit('close');
      return duplex;
    };
    // X4 (wave-7 stream semantics): node's duplexify close accounting. The
    // destroy() above pushes closure INTO the halves but must not be the
    // only close face — the PEER of a destroyed transport observes the loss
    // through THIS wrapper, and node's contract (measured against real node
    // v24.14.0, /tmp/x4-duplex-close-probe.mjs) is: a half that closes
    // without reaching its graceful end is a PREMATURE close and surfaces
    // node's eos abort on the wrapper ('error', code ABORT_ERR, once); when
    // BOTH halves have closed the wrapper is over — 'close', destroyed=true
    // — even though no destroy() was ever called on the wrapper itself.
    // Half-open parity: an 'end'-forwarded readable (host.end() on the
    // peer, the ptc-runtime test-1 path) closes only that half — the
    // wrapper stays open, non-destroyed, like node's allowHalfOpen.
    // Operative consumer: the ptc-runtime process-main runNodeMain parks on
    // the child duplex's 'close'/'error' after the host destroys its own
    // end (vendored process.ts awaits hostClosed on stream.once('close'));
    // without this accounting the run hung at `await hostClosed.promise`
    // (measured 2026-09-29: baseline stalls at test 2 with a timerSchedule
    // storm, /tmp/x4-process-main-baseline.log).
    const face = { wrapperEnded: false };
    duplex.#wireCloseAccounting(readable, writable, face);
    return duplex;
  }

  /** The X4 duplexify close accounting. node's contract (measured against
   * real node v24.14.0, /tmp/x4-duplex-close-probe.mjs): a half that closes
   * without reaching its graceful end is a PREMATURE close and surfaces
   * node's eos abort on the wrapper ('error', code ABORT_ERR, once); when
   * BOTH halves have closed the wrapper is over — 'close', destroyed=true
   * — even though no destroy() was ever called on the wrapper itself.
   * Half-open parity: an 'end'-forwarded readable (host.end() on the peer,
   * the ptc-runtime test-1 path) closes only that half — the wrapper stays
   * open, non-destroyed, like node's allowHalfOpen. Operative consumer: the
   * ptc-runtime process-main runNodeMain parks on the child duplex's
   * 'close'/'error' after the host destroys its own end (vendored
   * process.ts awaits hostClosed on stream.once('close')); without this
   * accounting the run hung at `await hostClosed.promise` (measured
   * 2026-09-29: baseline stalls at test 2 with a timerSchedule storm,
   * /tmp/x4-process-main-baseline.log). `face.wrapperEnded` is set by the
   * wrapper's own end() override (the writable-half graceful mark). */
  #wireCloseAccounting(readable, writable, face) {
    let readableClosed = false;
    let writableClosed = false;
    let readableEnded = false;
    let abortEmitted = false;
    // A half counts as gracefully over when its OWN end face ran: the
    // wrapper's end() for the writable (set in the override above), or the
    // half's readableEnded/writableEnded terminal flag for either source
    // (MiniStream and Writable both publish one; event delivery alone is
    // flowing-mode dependent, the flag is not).
    const settleHalves = () => {
      if (this.#destroyedFlag || !readableClosed || !writableClosed) return;
      this.#destroyedFlag = true;
      if ((!readableEnded || !face.wrapperEnded) && !abortEmitted) {
        abortEmitted = true;
        const abort = new Error('The operation was aborted');
        abort.code = 'ABORT_ERR';
        this.emit('error', abort);
      }
      this.emit('close');
    };
    readable.once?.('close', () => {
      readableClosed = true;
      readableEnded = readableEnded || readable.readableEnded === true;
      settleHalves();
    });
    writable.once?.('close', () => {
      writableClosed = true;
      face.wrapperEnded = face.wrapperEnded || writable.writableEnded === true;
      settleHalves();
    });
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
