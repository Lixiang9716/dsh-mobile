// dsh:logging-exempt (host shim: no side effects to log)
/**
 * shims/node-zlib-stream.js — the streaming face of the node:zlib shim
 * (ZstdShimStream + createZstdCompress/createZstdDecompress), split out of
 * node-zlib.js when that file crossed the code-size budget. The one-shot
 * codec cores stay the single source of truth in node-zlib.js; the imports
 * back are call-time-only (ESM-cycle safe).
 */
import {
  constants,
  intrinsic,
  asBytes,
  bytesToB64,
  b64ToBytes,
  compressOptions,
  checkFinishFlush,
  walkZstdFrame,
  decompressFlushPrefix,
  decompressLimit,
  compressBytes,
  decompressBytes,
  concatBytes,
} from 'upstream/shims/node-zlib.js';
import { zstdChecksumTrailer, validateFrameChecksum } from 'upstream/shims/node-zlib-xxh64.js';
import { DshBuffer } from 'upstream/shims/buffer.js';


/** Minimal stream face: buffers writes, one-shot codec on end(), then serves
 * the single result frame via 'data'/'end'/'close' events, read(), thenable,
 * and async iteration (the pipeline sink does `for await`). Decompress
 * streams ALSO expose the Node-private synchronous contract the vendored
 * jsonl-zstd private decoder probes (W6-V; previously declined by design,
 * which made NodePrivateZstdFrameDecoder.create() undefined and dropped its
 * four interchange/lifecycle/assembly tests): `_handle.writeSync` decodes
 * incrementally over the frame walk (complete frames whole + checksum
 * enforced; a torn tail yields its complete blocks via the E_flush rebuild),
 * `_writeState` reports [output space left, undecoded input left], the
 * `kError` symbol slot stays null until a decode failure, and
 * `_defaultFlushFlag` is ZSTD_e_continue (Node's transform default). */
/** The private decoder face's three phases (module level for size; they
 * touch no `#private` state, only the underscore-published face).
 * Accumulate the caller's slice into the pending pool. */
const privAccumulate = (stream, input, inputOffset, inputLength) => {
  if (inputLength > 0) {
    stream._privPending.push(Uint8Array.prototype.slice.call(input, inputOffset, inputLength));
    stream._privPendingBytes += inputLength;
  }
};

/** Decode pending input as far as the frame walk allows: complete frames
 * decode whole (decompressBytes validates flagged frames itself since
 * W6-V); torn tails with a complete block ride the E_flush rebuild; a
 * header-torn remainder waits for more input. Consume first, THEN consider
 * stopping: an empty complete frame (empty-header artifact) is real
 * progress — the old guard broke before consuming it, leaving
 * `inputAfter` nonzero, which the vendored decoder reads as trailing input
 * and wraps as "frame at byte 0 failed validation" (W6-V, measured). */
const privDecodePending = (stream, outputLength) => {
  for (;;) {
    if (stream._privPlainBytes >= outputLength) break;
    if (stream._privPendingBytes === 0) break;
    const pending = concatBytes(stream._privPending, stream._privPendingBytes);
    const frame = walkZstdFrame(pending);
    if (frame === null || pending.length < 5) break; // need more input for the header
    let produced;
    let consumed;
    if (frame.frameEnd !== null) {
      produced = decompressBytes(pending.subarray(0, frame.frameEnd), 0);
      consumed = frame.frameEnd;
    } else if (frame.blocksEnd > frame.headerEnd) {
      produced = decompressFlushPrefix(pending, 0);
      consumed = frame.blocksEnd;
    } else {
      break; // header visible but no complete block yet
    }
    stream._privPlain.push(produced);
    stream._privPlainBytes += produced.length;
    stream._privPending = consumed >= stream._privPendingBytes
      ? []
      : [Uint8Array.prototype.slice.call(pending, consumed)];
    stream._privPendingBytes = Math.max(0, stream._privPendingBytes - consumed);
    if (produced.length === 0 && stream._privPendingBytes === 0) break;
  }
};

/** Drain produced plaintext into the caller's output buffer; returns the
 * written count (leftover plaintext stays queued for the next call). */
const privDrainOutput = (stream, output, outputOffset, outputLength) => {
  let written = 0;
  while (written < outputLength && stream._privPlainBytes > 0) {
    const chunk = stream._privPlain[0];
    const take = Math.min(chunk.length, outputLength - written);
    output.set(chunk.subarray(0, take), outputOffset + written);
    written += take;
    if (take === chunk.length) {
      stream._privPlain.shift();
    } else {
      stream._privPlain[0] = chunk.subarray(take);
    }
    stream._privPlainBytes -= take;
  }
  return written;
};

class ZstdShimStream {
  constructor(codec, options) {
    this.codec = codec;
    const { level, checksum } = compressOptions(options);
    this.level = level;
    this.checksum = checksum;
    this.maxOutputBytes = decompressLimit(options);
    checkFinishFlush(options);
    this.chunks = [];
    this.pendingBytes = 0;
    this.result = null;
    this.finishError = null;
    this.ended = false;
    this.finished = false;
    this.destroyed = false;
    this.readConsumed = false;
    this.iterated = false;
    this.settled = null;
    this.listeners = new Map();
    if (codec === 'decompress') this.installPrivateFace();
  }

  /** Node-private synchronous decode contract (see class note). The
   * incremental decoder keeps three pieces of state: `_privPending` (input
   * bytes whose output has not been fully produced), `_privPlain` (plaintext
   * bytes produced but not yet handed to the caller's output buffer), and
   * the `kError` slot. writeSync appends the caller's slice, decodes as far
   * as the frame walk allows, drains `_privPlain` into the output, and
   * reports leftovers via `_writeState`. */
  installPrivateFace() {
    this._privPending = [];
    this._privPendingBytes = 0;
    this._privPlain = [];
    this._privPlainBytes = 0;
    this._kError = Symbol('kError');
    this[this._kError] = null;
    this._writeState = new Uint32Array(2);
    this._defaultFlushFlag = constants.ZSTD_e_continue;
    const stream = this;
    this._handle = {
      writeSync(flushFlag, input, inputOffset, inputLength, output, outputOffset, outputLength) {
        if (stream[this._kErrorRef] !== null) return; // decoder checks the slot before use
        privAccumulate(stream, input, inputOffset, inputLength);
        privDecodePending(stream, outputLength);
        const written = privDrainOutput(stream, output, outputOffset, outputLength);
        stream._writeState[0] = outputLength - written;
        stream._writeState[1] = stream._privPendingBytes;
        if (flushFlag === constants.ZSTD_e_end && stream._privPendingBytes > 0) {
          const failure = new Error('zstd: unexpected end of frame (e_end with undecoded input)');
          stream[stream._kError] = failure;
          throw failure;
        }
      },
    };
    // The vendored decoder reads the slot back through its own captured key
    // (Reflect.ownKeys finds it); keep a handle-side reference too so
    // writeSync can early-out after a failure.
    this._handle._kErrorRef = this._kError;
  }

  /** Release the private face's incremental state with the stream. */
  releasePrivateFace() {
    this._privPending = [];
    this._privPendingBytes = 0;
    this._privPlain = [];
    this._privPlainBytes = 0;
  }

  on(name, listener) {
    const list = this.listeners.get(name) ?? [];
    list.push(listener);
    this.listeners.set(name, list);
    return this;
  }

  once(name, listener) {
    const fire = (...args) => {
      this.off(name, fire);
      listener(...args);
    };
    return this.on(name, fire);
  }

  off(name, listener) {
    const list = this.listeners.get(name);
    if (list !== undefined) {
      this.listeners.set(name, list.filter((entry) => entry !== listener));
    }
    return this;
  }

  emit(name, ...args) {
    const list = this.listeners.get(name);
    if (list === undefined) {
      if (name === 'error') throw args[0];
      return this;
    }
    for (const listener of [...list]) listener(...args);
    return this;
  }

  write(chunk) {
    if (this.destroyed) throw new Error('zlib shim: cannot write to a destroyed zstd stream');
    if (this.ended) throw new Error('zlib shim: write after end');
    const bytes = asBytes(chunk, 'createZstd*().write');
    this.chunks.push(bytes);
    this.pendingBytes += bytes.length;
    return true;
  }

  /** Optional trailing chunk and/or callback, Node's `end(chunk, cb)` shape. */
  end(chunk, callback) {
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = undefined;
    }
    const cb = callback === undefined ? undefined : requireCallback(callback);
    if (chunk !== undefined && chunk !== null) this.write(chunk);
    if (this.ended || this.destroyed) {
      if (cb) cb(new Error('zlib shim: zstd stream already finished'));
      return this;
    }
    this.ended = true;
    const input = concatBytes(this.chunks, this.pendingBytes);
    let error = null;
    let result = null;
    try {
      result = this.codec === 'compress'
        ? compressBytes(input, this.level, this.checksum)
        : decompressBytes(input, this.maxOutputBytes);
    } catch (failure) {
      error = failure;
    }
    this.finish(error, result, cb);
    return this;
  }

  finish(error, result, cb) {
    this.finished = true;
    this.finishError = error;
    this.result = error === null ? DshBuffer.fromBytes(result) : null;
    if (error === null) {
      if (this.settled !== null) this.settled.resolve(this.result);
      this.emit('data', this.result);
      this.emit('end');
      if (cb) cb(null);
    } else {
      if (this.settled !== null) this.settled.reject(error);
      this.emit('error', error);
      if (cb) cb(error);
    }
    this.emit('close');
  }

  read() {
    if (this.readConsumed || !this.finished || this.finishError !== null) return null;
    this.readConsumed = true;
    return this.result;
  }

  /** Await the settled result (pipeline sinks may `await` the stream). */
  then(onFulfilled, onRejected) {
    return this.whenSettled().then(() => this.result).then(onFulfilled, onRejected);
  }

  whenSettled() {
    if (this.finished) {
      return this.finishError === null ? Promise.resolve(this.result) : Promise.reject(this.finishError);
    }
    if (this.settled === null) {
      this.settled = {};
      this.settled.promise = new Promise((resolve, reject) => {
        this.settled.resolve = resolve;
        this.settled.reject = reject;
      });
    }
    return this.settled.promise;
  }

  [Symbol.asyncIterator]() {
    return {
      next: async () => {
        if (this.iterated) return { done: true, value: undefined };
        const value = await this.whenSettled();
        this.iterated = true;
        return { done: false, value };
      },
    };
  }

  /** Release without a codec run (the private-probe decline path calls this). */
  close() {
    if (this.destroyed) return this;
    this.releasePrivateFace();
    this.destroyed = true;
    this.ended = true;
    this.emit('close');
    return this;
  }

  destroy(error) {
    if (this.destroyed) return this;
    this.releasePrivateFace();
    if (!this.finished) {
      this.finished = true;
      this.finishError = error ?? new Error('zlib shim: zstd stream destroyed before end');
      if (this.settled !== null) this.settled.reject(this.finishError);
    }
    if (error !== undefined && error !== null) this.emit('error', error);
    this.destroyed = true;
    this.ended = true;
    this.emit('close');
    return this;
  }
}

const requireCallback = (callback) => {
  if (typeof callback !== 'function') {
    throw new TypeError('zlib shim: end() callback must be a function');
  }
  return callback;
};

/** Streaming factories (options validated up front, like Node's constructors). */
export const createZstdCompress = (options) => new ZstdShimStream('compress', options);
export const createZstdDecompress = (options) => new ZstdShimStream('decompress', options);

/** CommonJS interop marker (worker.cjs require()s this module; see npm-bridges). */
