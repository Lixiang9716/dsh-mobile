// dsh:logging-exempt (host shim: no side effects to log)
/**
 * node:zlib shim — the Zstandard surface the vendored session-persistence
 * family reads (session-persistence-jsonl's concatenated-frame session log:
 * named imports in lib/{zstd,zstd-public-decoder,zstd-private-decoder,
 * generation,index}.js plus `require("node:zlib")` in worker.cjs), and —
 * since the 2026-09-27 suite round — the gzip one-shot face the
 * webworker-runtime image loader imports (`gzipSync`), bridged over the
 * vendored fflate (see the import note below).
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
 *   - ZSTD_c_checksumFlag is expressed STRUCTURALLY: the flag sets the
 *     descriptor bit and appends the 4-byte frame trailer (zeros — no
 *     intrinsic computes XXH64), and the decompress route strips that
 *     trailer instead of validating it. The container's byte layout
 *     matches Node's (the corpus scanner and its torn-tail truncations
 *     walk the trailer); what is lost vs Node is the integrity CHECK
 *     itself. Any OTHER param name fails loud (rule 5).
 *   - finishFlush:ZSTD_e_flush recovers a torn frame's complete-block
 *     prefix WITHOUT a streaming decoder: the shim walks the frame's block
 *     headers (RFC 8878 layout, same walk the vendored scanZstdFrames
 *     validates), drops the incomplete tail, clears the checksum
 *     descriptor bit, and closes the copy with a synthetic 0-byte Raw
 *     Last_Block so the one-shot intrinsic accepts it. E_continue/E_end
 *     keep the plain full-frame decode.
 *   - Results are DshBuffer (a Uint8Array subclass from shims/buffer.js), so
 *     consumers get Node-Buffer encodings (`toString('utf8')`) on decompressed
 *     plaintext — exactly what the corpus calls on it.
 *   - Callback forms defer via microtask (Node defers to its threadpool);
 *     argument/option validation stays synchronous, as in Node.
 */
import { DshBuffer, encodeUtf8 } from 'upstream/shims/buffer.js';
// The gzip family rides the VERBATIM vendored fflate tree (the office row's
// pinned 0.8.2; zero deps, ESM) — the same no-second-hand-rolled-copy
// discipline as sha256. The zstd face stays on the host intrinsics: the
// gateway has no zstd primitive the JS layer could substitute, and gzip has
// no host intrinsic at all (checked against gateway.js before bridging).
import {
  gzipSync as fflateGzipSync,
  gunzipSync as fflateGunzipSync,
} from '/vendor/npm/fflate@0.8.2/esm/browser.js';

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
 * param is EXPRESSED (structurally — see compressBytes); the rest fail loud. */
const compressOptions = (options) => {
  const params = options?.params;
  if (params !== undefined && (typeof params !== 'object' || params === null)) {
    throw new TypeError(`zlib shim: options.params must be an object, got ${describe(params)}`);
  }
  let level = options?.level;
  let checksum = false;
  if (level !== undefined && (!Number.isInteger(level) || level < 1 || level > 22)) {
    throw new RangeError(`zlib shim: zstd level must be an integer in [1, 22], got ${String(level)}`);
  }
  for (const key of Object.keys(params ?? {})) {
    if (key === PARAM_CHECKSUM) {
      if (params[key] !== 0 && params[key] !== 1) {
        throw new RangeError(`zlib shim: zstd params[ZSTD_c_checksumFlag] must be 0 or 1, got ${String(params[key])}`);
      }
      checksum = params[key] === 1;
    } else if (key === PARAM_LEVEL && level === undefined) {
      level = params[key];
    } else if (key !== PARAM_LEVEL) {
      throw new Error(`zlib shim: unsupported zstd params[${key}] — the host intrinsic exposes only the compression level`);
    }
  }
  return { level, checksum };
};

/** finishFlush must name a real ZSTD_e_* flush mode; the E_flush face is
 * served by the prefix-recovery walk below (module header note). */
const checkFinishFlush = (options) => {
  const flag = options?.finishFlush;
  if (flag === undefined) return;
  const known = [constants.ZSTD_e_continue, constants.ZSTD_e_flush, constants.ZSTD_e_end];
  if (!known.includes(flag)) {
    throw new RangeError(`zlib shim: unknown finishFlush ${String(flag)}`);
  }
};

/** Walk one frame's RFC 8878 layout (magic, descriptor, header fields, block
 * sequence) — the same structure the vendored scanZstdFrames validates.
 * Returns null when not even magic+descriptor are present; otherwise
 * { blocksEnd, frameEnd, hasChecksum, lastSeen }: blocksEnd = end of the
 * last COMPLETE block (or end of header), frameEnd = end of the whole frame
 * including the checksum trailer when present, or null when the frame is
 * torn, lastSeen = whether the frame's own Last_Block was reached. */
const walkZstdFrame = (bytes) => {
  if (bytes.length < 5) return null;
  const descriptor = bytes[4];
  const contentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 0x20) !== 0;
  const hasChecksum = (descriptor & 0x04) !== 0;
  const dictionaryFlag = descriptor & 0x03;
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
  const headerEnd = 5 + (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
  if (bytes.length < headerEnd) {
    return { blocksEnd: bytes.length, frameEnd: null, hasChecksum };
  }
  // Field offsets for header re-serialization (W6-V torn recovery): the
  // window descriptor (only when !singleSegment) sits right after the
  // descriptor byte, then the dictionary id, then the content size.
  const windowDescriptorAt = singleSegment ? -1 : 5;
  const dictIdAt = singleSegment ? 5 : 6;
  const contentSizeAt = dictIdAt + dictionaryBytes;
  let at = headerEnd;
  let lastSeen = false;
  while (!lastSeen) {
    if (bytes.length - at < 3) break; // torn block header
    const blockHeader = bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
    const blockType = (blockHeader >>> 1) & 0x03;
    const payloadBytes = blockType === 0x01 ? 1 : blockHeader >>> 3;
    if (bytes.length - at - 3 < payloadBytes) break; // torn payload
    lastSeen = (blockHeader & 1) !== 0;
    at += 3 + payloadBytes;
  }
  const blocksEnd = at;
  let frameEnd = null;
  if (lastSeen) {
    const trailer = hasChecksum ? 4 : 0;
    frameEnd = bytes.length - blocksEnd >= trailer ? blocksEnd + trailer : null;
  }
  return {
    headerEnd,
    blocksEnd, frameEnd, hasChecksum, lastSeen,
    descriptor, singleSegment, dictionaryFlag, dictionaryBytes, contentSizeBytes,
    windowDescriptor: windowDescriptorAt >= 0 ? bytes[windowDescriptorAt] : null,
    dictIdBytes: dictionaryBytes > 0 ? bytes.slice(dictIdAt, dictIdAt + dictionaryBytes) : null,
  };
};

/** Re-serialize a frame header with the content-size field DROPPED (flag 0)
 * and the checksum bit cleared: a torn-frame recovery decodes FEWER blocks
 * than the original header declares, and the one-shot intrinsic enforces
 * the declared size ("Data corruption detected", measured W6-V). Layout per
 * RFC 8878: descriptor, [window descriptor], [dictionary id], [content
 * size]. A singleSegment original carries no window descriptor byte; the
 * replacement derives one from the declared content size so the decode
 * window still spans every backward reference the kept blocks can make. */
const rebuildPrefixHeader = (frame, bytes) => {
  const newDescriptor = frame.dictionaryFlag; // flag 0, checksum 0, singleSegment 0
  let windowDescriptor = frame.windowDescriptor;
  if (windowDescriptor === null || windowDescriptor === undefined) {
    // Single-segment original: window size was implied by the content size
    // (RFC 8878: min(contentSize, window)). Re-derive a windowLog that
    // covers the declared size, clamped to the zstd range [10, 27].
    let log = 10;
    if (frame.contentSizeBytes > 0) {
      let declared = 0;
      for (let i = 0; i < frame.contentSizeBytes; i++) declared = declared * 256 + bytes[5 + (frame.singleSegment ? 0 : 1) + frame.dictionaryBytes + i];
      while (log < 27 && (1 << log) < declared) log += 1;
    }
    windowDescriptor = (log - 10) << 3;
  }
  const parts = [DshBuffer.fromBytes(Uint8Array.of(0x28, 0xB5, 0x2F, 0xFD, newDescriptor, windowDescriptor))];
  if (frame.dictIdBytes !== null) parts.push(DshBuffer.fromBytes(frame.dictIdBytes));
  return parts;
};

/** Node's finishFlush:ZSTD_e_flush over a one-shot decoder: recover the
 * plaintext of every COMPLETE block of a (possibly torn) frame. The
 * intrinsic runs ZSTD_decompress, which requires a frame-complete input —
 * but the frame is self-describing, so walkZstdFrame finds the truncation
 * point, the incomplete tail is dropped, and a synthetic 0-byte Raw block
 * with the Last_Block bit closes the copy. The header is RE-SERIALIZED with
 * the content-size field dropped (flag 0) and the checksum bit cleared:
 * the kept blocks decode fewer bytes than the original header declares and
 * the one-shot intrinsic enforces the declared size (W6-V: "zstd: Data
 * corruption detected" on every mid-block cut of a multi-block frame before
 * the rebuild). Mirrors Node's ZSTD_decompressStream flush semantics:
 * complete blocks out, no frame completion required. */
const decompressFlushPrefix = (bytes, maxOutputBytes) => {
  const frame = walkZstdFrame(bytes);
  if (frame === null || frame.headerEnd === undefined) return decompressBytes(bytes, maxOutputBytes);
  if (frame.frameEnd !== null) {
    // Frame-complete input: E_flush decodes it whole (original header — its
    // declared size still matches).
    return decompressBytes(bytes, maxOutputBytes);
  }
  const parts = [];
  if (frame.lastSeen) {
    // Every block survived (the tear hit the checksum trailer): keep the
    // ORIGINAL header but clear the checksum bit — the body alone is a
    // valid frame whose declared content size still matches its output.
    const body = bytes.slice(0, frame.blocksEnd);
    body[4] = bytes[4] & ~0x04;
    parts.push(body);
  } else {
    // Blocks were dropped: rebuild the header without the content-size
    // field (the declared size no longer matches the kept blocks' output),
    // then close the copy with a synthetic last block — Last_Block=1, type
    // Raw(0), size 0 → header 0x000001 LE.
    parts.push(...rebuildPrefixHeader(frame, bytes));
    parts.push(bytes.slice(frame.headerEnd, frame.blocksEnd));
    parts.push(DshBuffer.fromBytes(Uint8Array.of(0x01, 0x00, 0x00)));
  }
  const rebuilt = parts.length === 1 ? parts[0] : DshBuffer.concat(parts);
  return decompressBytes(rebuilt, maxOutputBytes);
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

/** XXH64 (seed 0) — the Zstandard frame checksum digest (RFC 8878 §3.1.1:
 * frame checksum = low 32 bits of XXH64 over the ORIGINAL content). Pure-JS
 * BigInt form; the host intrinsic family has no digest face. Vector-checked
 * against the canonical set ("" → 0xEF46DB3751D8E999). */
const XXH64 = (() => {
  const P1 = 0x9E3779B185EBCA87n, P2 = 0xC2B2AE3D27D4EB4Fn, P3 = 0x165667B19E3779F9n;
  const P4 = 0x85EBCA77C2B2AE63n, P5 = 0x27D4EB2F165667C5n;
  const M64 = (1n << 64n) - 1n;
  const rotl = (x, r) => ((x << r) | (x >> (64n - r))) & M64;
  const mul = (a, b) => {
    const aL = a & 0xFFFFFFFFn, bL = b & 0xFFFFFFFFn;
    return (((aL * bL) & M64) + ((((a >> 32n) * bL) & M64) << 32n) + ((((aL * (b >> 32n)) & M64) << 32n))) & M64;
  };
  const round = (acc, input) => mul(rotl((acc + mul(input, P2)) & M64, 31n), P1);
  const mergeRound = (acc, val) => (mul(acc ^ round(0n, val), P1) + P4) & M64;
  return (bytes) => {
    const len = bytes.length;
    let at = 0;
    let v1 = (P1 + P2) & M64, v2 = P2 & M64, v3 = 0n, v4 = (0n - P1) & M64;
    const read64 = (p) => {
      let x = 0n;
      for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(bytes[p + i]);
      return x;
    };
    const read32 = (p) => BigInt((bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0);
    let h;
    if (len >= 32) {
      const limit = len - 32;
      do {
        v1 = round(v1, read64(at)); at += 8;
        v2 = round(v2, read64(at)); at += 8;
        v3 = round(v3, read64(at)); at += 8;
        v4 = round(v4, read64(at)); at += 8;
      } while (at <= limit);
      h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & M64;
      h = mergeRound(h, v1); h = mergeRound(h, v2); h = mergeRound(h, v3); h = mergeRound(h, v4);
    } else {
      h = P5 & M64;
    }
    h = (h + BigInt(len)) & M64;
    while (at + 8 <= len) {
      h = (mul(h ^ round(0n, read64(at)), P1) + P4) & M64;
      at += 8;
    }
    while (at + 4 <= len) {
      h = (h ^ mul(read32(at), P1)) & M64;
      h = (mul(rotl(h, 23n), P2) + P3) & M64;
      at += 4;
    }
    while (at < len) {
      h = (h ^ mul(BigInt(bytes[at]), P5)) & M64;
      h = mul(rotl(h, 11n), P1);
      at += 1;
    }
    h ^= h >> 33n; h = mul(h, P2); h ^= h >> 29n; h = mul(h, P3); h ^= h >> 32n;
    return h & M64;
  };
})();

/** The 4-byte frame checksum trailer for `content` under the flag bit. */
const zstdChecksumTrailer = (content) => {
  const digest = XXH64(content) & 0xFFFFFFFFn;
  return Uint8Array.of(Number(digest & 0xFFn), Number((digest >> 8n) & 0xFFn), Number((digest >> 16n) & 0xFFn), Number((digest >> 24n) & 0xFFn));
};

/** Validate a frame-complete checksummed frame against its decoded plaintext
 * (the one-shot route strips the trailer before the intrinsic — which WOULD
 * natively enforce it — so the shim owns the comparison; W6-V upgraded the
 * trailer from the old zero placeholder to the real XXH64, and the vendored
 * corruption tests flip on exactly this). */
const validateFrameChecksum = (frameBytes, plaintext) => {
  const expected = zstdChecksumTrailer(plaintext);
  const at = frameBytes.length - 4;
  for (let i = 0; i < 4; i++) {
    if (frameBytes[at + i] !== expected[i]) {
      throw new Error(`zstd: frame checksum mismatch (stored ${frameBytes[at + i].toString(16)}, computed ${expected[i].toString(16)} at trailer byte ${i})`);
    }
  }
};

/** Sync codec core (compress): one intrinsic shot, then — when the caller
 * requested ZSTD_c_checksumFlag — the checksum bit is SET in the descriptor
 * and a real XXH64 trailer is appended (RFC 8878 layout; W6-V replaced the
 * old zero placeholder, which made every flagged frame a silently-unchecked
 * checksum claim). */
const compressBytes = (bytes, level, checksum) => {
  const frame = b64ToBytes(intrinsic(COMPRESS_INTRINSIC)(bytesToB64(bytes), level ?? constants.ZSTD_CLEVEL_DEFAULT));
  if (checksum !== true) return frame;
  const out = new Uint8Array(frame.length + 4);
  out.set(frame, 0);
  out[4] |= 0x04; // Frame_Header_Descriptor bit 2: Content_Checksum_flag
  out.set(zstdChecksumTrailer(bytes), frame.length);
  return out;
};

/** Sync codec core (decompress): a checksum-flagged frame is first stripped
 * to its block body with the descriptor bit cleared (the intrinsic WOULD
 * natively enforce the XXH64 trailer; the shim owns the comparison because
 * it owns the stripped decode) and validated against the decoded plaintext —
 * real digest since W6-V, so corrupt trailers fail loud. Non-checksum frames
 * pass through byte-identical. */
const decompressBytes = (bytes, maxOutputBytes) => {
  const frame = walkZstdFrame(bytes);
  if (frame !== null && frame.hasChecksum && frame.frameEnd === bytes.length) {
    const body = bytes.slice(0, frame.blocksEnd);
    body[4] = bytes[4] & ~0x04;
    const plain = decompressBytes(body, maxOutputBytes);
    validateFrameChecksum(bytes, plain);
    return plain;
  }
  return b64ToBytes(intrinsic(DECOMPRESS_INTRINSIC)(bytesToB64(bytes), maxOutputBytes ?? 0));
};

/** One-shot forms; results are DshBuffer (Uint8Array subclass with encodings). */
export const zstdCompressSync = (buffer, options) => (
  DshBuffer.fromBytes((() => {
    const bytes = asBytes(buffer, 'zstdCompressSync');
    const { level, checksum } = compressOptions(options);
    return compressBytes(bytes, level, checksum);
  })())
);

/** gzip/gunzip — the one-shot face the webworker-runtime image loader drives
 * (`gzipSync(tar)` builds the fixture; the product decoder walks the gzip
 * member). Options: fflate's `{ level, mtime }` subset; node's memLevel/
 * strategy names fail loud. Results are DshBuffer like the zstd face. */
export const gzipSync = (buffer, options) => {
  if (options !== undefined && options !== null
      && typeof options !== 'object') {
    throw new TypeError(`zlib shim: gzipSync options must be an object, got ${describe(options)}`);
  }
  for (const key of Object.keys(options ?? {})) {
    if (key !== 'level' && key !== 'mtime' && key !== 'finishFlush') {
      throw new Error(`zlib shim: unsupported gzipSync options[${key}] — the fflate bridge exposes level/mtime only`);
    }
  }
  return DshBuffer.fromBytes(fflateGzipSync(asBytes(buffer, 'gzipSync'), options));
};

export const gunzipSync = (buffer, options) => {
  const limit = decompressLimit(options);
  const out = fflateGunzipSync(asBytes(buffer, 'gunzipSync'));
  if (limit > 0 && out.length > limit) {
    throw new RangeError(`zlib shim: gunzipSync output exceeds maxOutputLength ${limit}`);
  }
  return DshBuffer.fromBytes(out);
};


/** The decode route options take: ZSTD_e_flush recovers complete-block
 * plaintext (the prefix walk); everything else is the plain one-shot. */
const decompressWithOptions = (bytes, options) => (
  options?.finishFlush === constants.ZSTD_e_flush
    ? decompressFlushPrefix(bytes, decompressLimit(options))
    : decompressBytes(bytes, decompressLimit(options))
);

export const zstdDecompressSync = (buffer, options) => {
  const bytes = asBytes(buffer, 'zstdDecompressSync');
  checkFinishFlush(options);
  return DshBuffer.fromBytes(decompressWithOptions(bytes, options));
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
  const { level, checksum } = compressOptions(opts);
  Promise.resolve().then(() => {
    try {
      cb(null, DshBuffer.fromBytes(compressBytes(bytes, level, checksum)));
    } catch (error) {
      cb(error);
    }
  });
};

export const zstdDecompress = (buffer, options, callback) => {
  const [opts, cb] = splitArguments(options, callback, 'zstdDecompress');
  const bytes = asBytes(buffer, 'zstdDecompress');
  checkFinishFlush(opts);
  Promise.resolve().then(() => {
    try {
      cb(null, DshBuffer.fromBytes(decompressWithOptions(bytes, opts)));
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
        // 1. Accumulate the caller's slice.
        if (inputLength > 0) {
          stream._privPending.push(Uint8Array.prototype.slice.call(input, inputOffset, inputOffset + inputLength));
          stream._privPendingBytes += inputLength;
        }
        // 2. Decode pending input as far as the walk allows.
        for (;;) {
          if (stream._privPlainBytes >= outputLength) break;
          if (stream._privPendingBytes === 0) break;
          const pending = concatBytes(stream._privPending, stream._privPendingBytes);
          const frame = walkZstdFrame(pending);
          if (frame === null || pending.length < 5) break; // need more input for the header
          let produced;
          let consumed;
          if (frame.frameEnd !== null) {
            // Complete frame: whole decode with the checksum enforced
            // (decompressBytes validates flagged frames itself since W6-V).
            produced = decompressBytes(pending.subarray(0, frame.frameEnd), 0);
            consumed = frame.frameEnd;
          } else if (frame.blocksEnd > frame.headerEnd) {
            // Torn tail with at least one complete block: E_flush rebuild
            // recovers the blocks' plaintext; the header-torn remainder waits
            // for more input.
            produced = decompressFlushPrefix(pending, 0);
            consumed = frame.blocksEnd;
          } else {
            break; // header visible but no complete block yet
          }
          // Consume first, THEN consider stopping: an empty complete frame
          // (empty-header artifact) is real progress — the old guard broke
          // before consuming it, leaving `inputAfter` nonzero, which the
          // vendored decoder reads as trailing input and wraps as "frame at
          // byte 0 failed validation" (W6-V, measured).
          stream._privPlain.push(produced);
          stream._privPlainBytes += produced.length;
          stream._privPending = consumed >= stream._privPendingBytes
            ? []
            : [Uint8Array.prototype.slice.call(pending, consumed)];
          stream._privPendingBytes = Math.max(0, stream._privPendingBytes - consumed);
          if (produced.length === 0 && stream._privPendingBytes === 0) break;
        }
        // 3. Drain produced plaintext into the caller's output buffer.
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
export const __esModule = true;

/** Default export: the full face for `import zlib from 'node:zlib'` callers. */
export default {
  constants,
  zstdCompress,
  zstdDecompress,
  zstdCompressSync,
  zstdDecompressSync,
  gzipSync,
  gunzipSync,
  createZstdCompress,
  createZstdDecompress,
  __esModule,
};
