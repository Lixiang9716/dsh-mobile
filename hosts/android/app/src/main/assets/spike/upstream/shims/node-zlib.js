// dsh:logging-exempt (host shim: no side effects to log)
/**
 * node:zlib shim — the Zstandard surface the vendored session-persistence
 * family reads (session-persistence-jsonl's concatenated-frame session log:
 * named imports in lib/{zstd,zstd-public-decoder,zstd-private-decoder,
 * generation,index}.js plus `require("node:zlib")` in worker.cjs).
 *
 * Everything rides the host intrinsics, read LAZILY AT CALL TIME (never at
 * import time — the intrinsics may not exist under plain Node):
 *   - __zstdCompressB64(b64String, level = 3) -> b64String
 *   - __zstdDecompressB64(b64String, maxOutputBytes = 0) -> b64String
 * Bytes cross the bridge as base64 through btoa/atob (binary-string safe),
 * built in 32 KiB slices so a multi-MB session-log frame stays O(n).
 *
 * Surveyed call shapes this file serves:
 *   - promisify(zstdCompress)(buf, { params: { [ZSTD_c_checksumFlag]: 1 } })
 *   - promisify(zstdDecompress)(buf) and (buf, { finishFlush: ZSTD_e_flush })
 *   - zstdDecompressSync(frame) per complete frame (public one-shot decoder)
 *   - createZstdDecompress({ chunkSize }) — probed for Node's private
 *     `_handle` shape, then `close()`d when the probe declines: the returned
 *     object deliberately LACKS `_handle`/`_writeState`/the `kError` symbol,
 *     so the corpus falls back to zstdDecompressSync (by design).
 *   - createZstdCompress(opts) inside pipeline(Readable.from(rows), stream,
 *     async sink): the stream buffers writes and compresses ONE-SHOT on end
 *     (zstd frames are self-contained), then serves the single frame through
 *     'data'/'end' events and async iteration.
 *
 * Node-semantic judgment calls (deltas, stated up front):
 *   - ZSTD_c_checksumFlag is accepted but not expressed: the intrinsic ABI
 *     exposes only the level, so frames carry no XXH64 checksum. The corpus
 *     scanner reads the checksum bit from each frame descriptor and decoders
 *     validate only when present, so the container stays well-formed; what is
 *     lost vs Node is that extra integrity check. Any OTHER param name fails
 *     loud (rule 5).
 *   - finishFlush is validated against the ZSTD_e_* table but the one-shot
 *     intrinsic cannot surface partial plaintext from a torn frame: where
 *     Node's ZSTD_e_flush recovers a prefix, this shim rejects — and the
 *     corpus's torn-tail recovery already treats rejection as "no
 *     recoverable prefix" (decodeStreamingMigration swallows it).
 *   - Results are DshBuffer (a Uint8Array subclass from shims/buffer.js), so
 *     consumers get Node-Buffer encodings (`toString('utf8')`) on decompressed
 *     plaintext — exactly what the corpus calls on it.
 *   - Callback forms defer via microtask (Node defers to its threadpool);
 *     argument/option validation stays synchronous, as in Node.
 */
import { DshBuffer, encodeUtf8 } from 'upstream/shims/buffer.js';

/** Node 24 zlib.constants, Zstandard + flush faces (values verbatim). */
export const constants = {
  Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4, Z_BLOCK: 5,
  Z_MIN_CHUNK: 64, Z_MAX_CHUNK: Infinity, Z_DEFAULT_CHUNK: 16384,
  ZSTD_COMPRESS: 10, ZSTD_DECOMPRESS: 11,
  ZSTD_e_continue: 0, ZSTD_e_flush: 1, ZSTD_e_end: 2,
  ZSTD_fast: 1, ZSTD_dfast: 2, ZSTD_greedy: 3, ZSTD_lazy: 4, ZSTD_lazy2: 5,
  ZSTD_btlazy2: 6, ZSTD_btopt: 7, ZSTD_btultra: 8, ZSTD_btultra2: 9,
  ZSTD_c_compressionLevel: 100, ZSTD_c_windowLog: 101, ZSTD_c_hashLog: 102, ZSTD_c_chainLog: 103,
  ZSTD_c_searchLog: 104, ZSTD_c_minMatch: 105, ZSTD_c_targetLength: 106, ZSTD_c_strategy: 107,
  ZSTD_c_enableLongDistanceMatching: 160, ZSTD_c_ldmHashLog: 161, ZSTD_c_ldmMinMatch: 162,
  ZSTD_c_ldmBucketSizeLog: 163, ZSTD_c_ldmHashRateLog: 164,
  ZSTD_c_contentSizeFlag: 200, ZSTD_c_checksumFlag: 201, ZSTD_c_dictIDFlag: 202,
  ZSTD_c_nbWorkers: 400, ZSTD_c_jobSize: 401, ZSTD_c_overlapLog: 402,
  ZSTD_d_windowLogMax: 100, ZSTD_CLEVEL_DEFAULT: 3,
  ZSTD_error_no_error: 0, ZSTD_error_GENERIC: 1, ZSTD_error_prefix_unknown: 10,
  ZSTD_error_version_unsupported: 12, ZSTD_error_frameParameter_unsupported: 14,
  ZSTD_error_frameParameter_windowTooLarge: 16, ZSTD_error_corruption_detected: 20,
  ZSTD_error_checksum_wrong: 22, ZSTD_error_literals_headerWrong: 24,
  ZSTD_error_dictionary_corrupted: 30, ZSTD_error_dictionary_wrong: 32,
  ZSTD_error_dictionaryCreation_failed: 34, ZSTD_error_parameter_unsupported: 40,
  ZSTD_error_parameter_combination_unsupported: 41, ZSTD_error_parameter_outOfBound: 42,
  ZSTD_error_tableLog_tooLarge: 44, ZSTD_error_maxSymbolValue_tooLarge: 46,
  ZSTD_error_maxSymbolValue_tooSmall: 48, ZSTD_error_stabilityCondition_notRespected: 50,
  ZSTD_error_stage_wrong: 60, ZSTD_error_init_missing: 62, ZSTD_error_memory_allocation: 64,
  ZSTD_error_workSpace_tooSmall: 66, ZSTD_error_dstSize_tooSmall: 70, ZSTD_error_srcSize_wrong: 72,
  ZSTD_error_dstBuffer_null: 74, ZSTD_error_noForwardProgress_destFull: 80,
  ZSTD_error_noForwardProgress_inputEmpty: 82,
};

const COMPRESS_INTRINSIC = '__zstdCompressB64';
const DECOMPRESS_INTRINSIC = '__zstdDecompressB64';
const B64_SLICE_BYTES = 0x8000;
const PARAM_CHECKSUM = String(constants.ZSTD_c_checksumFlag);
const PARAM_LEVEL = String(constants.ZSTD_c_compressionLevel);

/** Look up a host intrinsic at CALL time; a missing seam fails loud (rule 5). */
const intrinsic = (name) => {
  const fn = globalThis[name];
  if (typeof fn !== 'function') {
    throw new Error(`zlib shim: host intrinsic ${name} is not available on this runtime`);
  }
  return fn;
};

const describe = (value) => (value === null ? 'null' : typeof value);

/** Node's zlib convenience face accepts Buffer/typed arrays AND strings
 * (utf8-encoded). The corpus hands the jsonl spine's event-line strings to
 * zstdCompress; anything else non-bytes stays loud. */
const asBytes = (input, caller) => {
  if (typeof input === 'string') return encodeUtf8(input);
  if (!(input instanceof Uint8Array)) {
    throw new TypeError(`zlib shim: ${caller} expects a Uint8Array/Buffer/string, got ${describe(input)}`);
  }
  return input;
};

/** Uint8Array -> base64: binary string in 32 KiB slices, one btoa (O(n)). */
const bytesToB64 = (bytes) => {
  const slices = [];
  for (let at = 0; at < bytes.length; at += B64_SLICE_BYTES) {
    const end = Math.min(at + B64_SLICE_BYTES, bytes.length);
    slices.push(String.fromCharCode.apply(null, bytes.subarray(at, end)));
  }
  return btoa(slices.join(''));
};

/** base64 -> Uint8Array: one atob, one charCodeAt loop (O(n)). */
const b64ToBytes = (b64) => {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) out[at] = binary.charCodeAt(at);
  return out;
};

/** Level from options.level or params[ZSTD_c_compressionLevel]; the checksum
 * param is the one accepted-but-unexpressible name (module header); rest loud. */
const compressLevel = (options) => {
  const params = options?.params;
  if (params !== undefined && (typeof params !== 'object' || params === null)) {
    throw new TypeError(`zlib shim: options.params must be an object, got ${describe(params)}`);
  }
  let level = options?.level;
  if (level !== undefined && (!Number.isInteger(level) || level < 1 || level > 22)) {
    throw new RangeError(`zlib shim: zstd level must be an integer in [1, 22], got ${String(level)}`);
  }
  for (const key of Object.keys(params ?? {})) {
    if (key === PARAM_CHECKSUM) continue;
    if (key === PARAM_LEVEL && level === undefined) level = params[key];
    else if (key !== PARAM_LEVEL) {
      throw new Error(`zlib shim: unsupported zstd params[${key}] — the host intrinsic exposes only the compression level`);
    }
  }
  return level;
};

/** finishFlush must name a real ZSTD_e_* flush mode; partial recovery of torn
 * frames is not expressible through the one-shot intrinsic (module header). */
const checkFinishFlush = (options) => {
  const flag = options?.finishFlush;
  if (flag === undefined) return;
  const known = [constants.ZSTD_e_continue, constants.ZSTD_e_flush, constants.ZSTD_e_end];
  if (!known.includes(flag)) {
    throw new RangeError(`zlib shim: unknown finishFlush ${String(flag)}`);
  }
};

/** maxOutputLength -> the intrinsic's maxOutputBytes (0 = unlimited, Node's default). */
const decompressLimit = (options) => {
  const max = options?.maxOutputLength;
  if (max === undefined) return 0;
  if (!Number.isInteger(max) || max < 0) {
    throw new RangeError(`zlib shim: maxOutputLength must be a non-negative integer, got ${String(max)}`);
  }
  return max;
};

/** Sync codec cores; intrinsic failures ("zstd: ...") propagate unchanged. */
const compressBytes = (bytes, level) => (
  b64ToBytes(intrinsic(COMPRESS_INTRINSIC)(bytesToB64(bytes), level ?? constants.ZSTD_CLEVEL_DEFAULT))
);
const decompressBytes = (bytes, maxOutputBytes) => (
  b64ToBytes(intrinsic(DECOMPRESS_INTRINSIC)(bytesToB64(bytes), maxOutputBytes ?? 0))
);

/** One-shot forms; results are DshBuffer (Uint8Array subclass with encodings). */
export const zstdCompressSync = (buffer, options) => (
  DshBuffer.fromBytes(compressBytes(asBytes(buffer, 'zstdCompressSync'), compressLevel(options)))
);

export const zstdDecompressSync = (buffer, options) => {
  const bytes = asBytes(buffer, 'zstdDecompressSync');
  checkFinishFlush(options);
  return DshBuffer.fromBytes(decompressBytes(bytes, decompressLimit(options)));
};

/** Split (buffer, options, callback) vs (buffer, callback); Node validates the
 * callback synchronously. Returns [options, callback]. */
const splitArguments = (options, callback, caller) => {
  if (typeof options === 'function') return [undefined, options];
  if (typeof callback !== 'function') {
    throw new TypeError(`zlib shim: ${caller} requires a callback function`);
  }
  return [options, callback];
};

/** Callback forms: argument validation is synchronous (like Node); codec work
 * and its failures reach the callback from a microtask, never a sync throw. */
export const zstdCompress = (buffer, options, callback) => {
  const [opts, cb] = splitArguments(options, callback, 'zstdCompress');
  const bytes = asBytes(buffer, 'zstdCompress');
  const level = compressLevel(opts);
  Promise.resolve().then(() => {
    try {
      cb(null, DshBuffer.fromBytes(compressBytes(bytes, level)));
    } catch (error) {
      cb(error);
    }
  });
};

export const zstdDecompress = (buffer, options, callback) => {
  const [opts, cb] = splitArguments(options, callback, 'zstdDecompress');
  const bytes = asBytes(buffer, 'zstdDecompress');
  checkFinishFlush(opts);
  const maxOutputBytes = decompressLimit(opts);
  Promise.resolve().then(() => {
    try {
      cb(null, DshBuffer.fromBytes(decompressBytes(bytes, maxOutputBytes)));
    } catch (error) {
      cb(error);
    }
  });
};

const concatBytes = (chunks, total) => {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
};

/** Minimal stream face: buffers writes, one-shot codec on end(), then serves
 * the single result frame via 'data'/'end'/'close' events, read(), thenable,
 * and async iteration (the pipeline sink does `for await`). Deliberately has
 * NO `_handle`/`_writeState`/`kError` symbol so the corpus's private-stream
 * probe declines and it falls back to the public one-shot decoder. */
class ZstdShimStream {
  constructor(codec, options) {
    this.codec = codec;
    this.level = compressLevel(options);
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
        ? compressBytes(input, this.level)
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
    this.destroyed = true;
    this.ended = true;
    this.emit('close');
    return this;
  }

  destroy(error) {
    if (this.destroyed) return this;
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
export const __esModule = true;

/** Default export: the full face for `import zlib from 'node:zlib'` callers. */
export default {
  constants,
  zstdCompress,
  zstdDecompress,
  zstdCompressSync,
  zstdDecompressSync,
  createZstdCompress,
  createZstdDecompress,
  __esModule,
};
