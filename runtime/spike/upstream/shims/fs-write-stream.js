// dsh:logging-exempt (shim layer)
/**
 * shims/fs-write-stream.js — node:fs's createWriteStream (W5-T), split out of
 * fs.js when that file crossed the code-size budget. The descriptor table is
 * the sync faces' own (fs-writes.js: one store, three spellings); behavior
 * is the fs.js block verbatim, machinery hoisted to module scope.
 */
import {
  lexical,
  wsWriteFile,
} from 'upstream/shims/fs-workspace.js';
import { DshBuffer, encodeUtf8 } from 'upstream/shims/buffer.js';
import { EventEmitter } from 'upstream/shims/events.js';
import { nextTick, readAnyBytes } from 'upstream/shims/fs.js';
import { fdTable, openSync, closeSync } from 'upstream/shims/fs-writes.js';

/** createWriteStream (W5-T) — the WriteStream face over the SAME descriptor
 * table the sync faces own (one store, three spellings). Models node's
 * WriteStream observable sequence: async 'open', write() hwm accounting
 * (false + a later 'drain' when the buffered bytes reach the high-water
 * mark; the VFS flush itself is synchronous, so the buffer empties on the
 * next tick), bytesWritten, end() → 'finish' → autoClose 'close'. The
 * fs-watch-stream spec uses this face as the NATIVE oracle against the
 * webworker-runtime's own WriteStream port, so the node semantics here are
 * load-bearing, not decorative. */
/** The createWriteStream state machine (module level for size; the mutable
 * writer locals ride one state object). flushOne folds a chunk into the
 * staged file bytes (append or positional), wsWriteFile persists. */
const wsFlushOne = (st, chunk, callback) => {
  try {
    if (st.fd === null) throw new Error('node:fs.createWriteStream: write after close');
    const record = fdTable().get(st.fd);
    const bytes = typeof chunk === 'string' ? encodeUtf8(chunk) : chunk;
    if (!(bytes instanceof Uint8Array)) {
      throw new TypeError(`node:fs.createWriteStream: chunk must be a string or Uint8Array, got ${typeof chunk}`);
    }
    const current = (() => {
      try { return readAnyBytes(st.stream.path); } catch { return DshBuffer.fromBytes(new Uint8Array(0)); }
    })();
    const at = record.append ? current.length : Math.min(st.pos, current.length);
    const merged = new Uint8Array(Math.max(current.length, at + bytes.length));
    merged.set(current, 0);
    merged.set(bytes, at);
    wsWriteFile(st.stream.path, merged, undefined);
    if (!record.append) st.pos = at + bytes.length;
    st.bytesWritten += bytes.length;
    callback(null);
    return bytes.length;
  } catch (error) {
    callback(error);
    return 0;
  }
};

const wsPump = (st) => {
  const { stream } = st;
  while (st.writing === false && st.queue.length > 0) {
    const job = st.queue.shift();
    st.writing = true;
    const len = wsFlushOne(st, job.chunk, (error) => {
      st.writing = false;
      st.buffered -= job.len;
      stream.writableLength = st.buffered;
      if (error !== null && error !== undefined) {
        st.fail(error);
        return;
      }
      if (job.callback) job.callback(null);
      stream.emit('flush');
      if (st.buffered < st.highWaterMark && stream.writableNeedDrain) {
        stream.writableNeedDrain = false;
        stream.emit('drain');
      }
      wsPump(st);
    });
    st.buffered += len;
    stream.writableLength = st.buffered;
  }
};

/** The write face (module level for size): after-end fails, chunks queue by
 * encoded length, and the hwm decides the backpressure answer. */
const wsWriteFace = (st) => (chunk, encodingOrCb, maybeCb) => {
  const callback = typeof encodingOrCb === 'function' ? encodingOrCb
    : typeof maybeCb === 'function' ? maybeCb : null;
  const { stream } = st;
  if (st.ended) {
    const error = new Error('write after end');
    if (callback) callback(error);
    else st.fail(error);
    return false;
  }
  const size = typeof chunk === 'string' ? encodeUtf8(chunk).length : (chunk?.byteLength ?? 0);
  st.queue.push({ chunk, len: size, callback });
  wsPump(st);
  const needDrain = st.buffered >= st.highWaterMark;
  stream.writableNeedDrain = needDrain;
  return !needDrain;
};

/** The end face: 'finish' after the queue drains (a poll rides nextTick),
 * then autoClose. */
const wsEndFace = (st, destroyNow) => (chunkOrCb, maybeCb) => {
  const { stream } = st;
  const callback = typeof chunkOrCb === 'function' ? chunkOrCb : maybeCb;
  st.ended = true;
  const finishWrite = () => {
    stream.writable = false;
    stream.emit('finish');
    if (callback) callback();
    if (stream.autoClose) destroyNow();
  };
  if (st.queue.length > 0 || st.writing) {
    const poll = () => { if (st.queue.length > 0 || st.writing) nextTick(poll); else finishWrite(); };
    nextTick(poll);
  } else {
    finishWrite();
  }
  return stream;
};

/** The open-then-pump boot (module level for size): the async 'open'
 * sequence — fd, optional start offset, 'open' event, first pump — with
 * failures routed to the stream's error face. */
const wsOpenAndPump = (st) => {
  const { stream } = st;
  nextTick(() => {
    try {
      st.fd = openSync(stream.path, typeof st.opts.flags === 'string' ? st.opts.flags : 'w', st.opts.mode);
      if (typeof st.opts.start === 'number') st.pos = st.opts.start;
      stream.emit('open', st.fd);
      wsPump(st);
    } catch (error) {
      st.fail(error);
    }
  });
};

export const createWriteStream = (path, options = {}) => {
  const opts = typeof options === 'string' ? { encoding: options } : (options ?? {});
  const highWaterMark = typeof opts.highWaterMark === 'number' && opts.highWaterMark > 0
    ? opts.highWaterMark : 64 * 1024;
  const stream = new EventEmitter();
  const st = {
    fd: null, pos: 0, bytesWritten: 0, buffered: 0, writing: false,
    ended: false, closed: false, errored: null, queue: [],
    opts, highWaterMark, stream,
  };
  stream.path = typeof path === 'string' ? lexical(path) : path;
  stream.writable = true;
  stream.writableHighWaterMark = highWaterMark;
  stream.writableLength = 0;
  stream.writableNeedDrain = false;
  stream.autoClose = opts.autoClose !== false;
  stream.closed = false;
  const destroyNow = () => {
    if (st.closed) return;
    if (st.fd !== null) { try { closeSync(st.fd); } catch { /* already closed */ } st.fd = null; }
    st.closed = true;
    stream.closed = true;
    stream.writable = false;
    nextTick(() => stream.emit('close'));
  };
  const fail = (error) => {
    st.errored = error;
    stream.emit('error', error);
    if (stream.autoClose) destroyNow();
  };
  st.fail = fail;
  wsOpenAndPump(st);
  stream.write = wsWriteFace(st);
  stream.end = wsEndFace(st, destroyNow);
  stream.destroy = (error) => {
    if (error) { st.errored = error; stream.emit('error', error); }
    destroyNow();
    return stream;
  };
  stream.close = () => destroyNow();
  Object.defineProperty(stream, 'bytesWritten', { get: () => st.bytesWritten });
  return stream;
};

/** The chunk generator behind createReadStream (module level for size):
 * yields DshBuffer windows over [start, end] (node's INCLUSIVE byte window),
 * aborting through the signal with an AbortError-shaped throw. */
const iterateReadStream = async function* (path, options, start, end, CHUNK) {
  const bytes = readAnyBytes(path);
  const last = Math.min(end, bytes.length - 1);
  for (let at = start; at <= last; at += CHUNK) {
    if (options.signal?.aborted) {
      const error = new Error('read aborted');
      error.name = 'AbortError';
      throw error;
    }
    yield DshBuffer.fromBytes(bytes.subarray(at, Math.min(at + CHUNK, last + 1)));
  }
};

/** createReadStream — the async-iterable face fs-local iterates (`for await
 * (const chunk of stream)`). Bytes are yielded as DshBuffer chunks in file
 * order; `start`/`end` are the node INCLUSIVE byte window; aborting the
 * signal stops the iteration with an AbortError-shaped throw. */
export const createReadStream = (path, options = {}) => {
  const start = typeof options.start === 'number' ? options.start : 0;
  const end = typeof options.end === 'number' ? options.end : Number.MAX_SAFE_INTEGER;
  const CHUNK = 64 * 1024;
  const iterator = iterateReadStream(path, options, start, end, CHUNK);
  return {
    [Symbol.asyncIterator]: () => iterator,
    // The Readable cleanup face the closure's finally blocks call
    // (attachment-local's readFileStreamVerbatim destroys the stream after
    // the drain; a missing member surfaced as 'not a function', R3-G1
    // 2026-09-28). The generator holds no OS resource — cleanup is a no-op.
    destroy: () => {},
    close: async () => {},
  };
};