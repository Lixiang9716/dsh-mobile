// dsh:logging-exempt (host shim: no side effects to log)
/**
 * shims/node-child-process-pump.js — the per-child pipe pump family of the
 * node:child_process shim (the stdin write face + the 4ms poll tick), split
 * out of node-child-process.js when that file crossed the code-size budget
 * (W9). One-way dependency: this module imports ONLY from the tables module
 * and buffer.js — it never imports node-child-process.js (a static
 * shim→shim cycle kills QuickJS at link); the original imports makeStdin/
 * startPump back and re-exports the family so every existing specifier
 * keeps working. The host intrinsics (__dshProcPoll/Write/EndStdin) and the
 * DSH_CHILD_DEBUG flag are re-read from globalThis here — the same
 * link-time snapshot the main shim takes (nothing runs before the boot
 * graph finishes linking).
 */
import { Buffer, decodeUtf8, fromBase64 } from './buffer.js';
import { CHILD_EXTRA_FDS, signalName, toB64, translateChildBytes } from './node-child-process-tables.js';

const pollIntrinsic = globalThis.__dshProcPoll;
const writeIntrinsic = globalThis.__dshProcWrite;
const endStdinIntrinsic = globalThis.__dshProcEndStdin;

const childDebugOn = (() => {
  try {
    const raw = typeof globalThis.__dshLaunchEnv === 'function' ? globalThis.__dshLaunchEnv() : null;
    return raw ? JSON.parse(raw).DSH_CHILD_DEBUG === '1' : false;
  } catch { return false; }
})();

/** The stdin write face (module level for size): fail-loud on a dead pid,
 * hand the bytes to the host seam, and report backpressure by parking the
 * callback until the pump drains (node's write-callback contract for a full
 * pipe). */
const stdinWrite = (child, pendingWrites, fail, data, cb) => {
  if (childDebugOn && globalThis.__DSH_LOG_SINK__) {
    globalThis.__DSH_LOG_SINK__(JSON.stringify({ scenario: 'upstream.suite', event: 'debug/stdin-write', pid: child.pid, bytes: data?.length ?? 0 }));
  }
  if (child.pid === undefined || child.pid === null) {
    fail(Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -1, syscall: 'write' }));
    return false;
  }
  const res = writeIntrinsic(child.pid, toB64(data));
  if (res.error) {
    fail(Object.assign(new Error(`write ${res.error.code}`), { code: res.error.code, errno: res.error.errno, syscall: 'write' }));
    return false;
  }
  if (res.buffered > 0) {
    // Backpressured: the host holds the refused bytes; the callback
    // stays pending until the pump drains them (or fails on child
    // death) — node's write-callback contract for a full pipe.
    pendingWrites.push(cb);
    return false;
  }
  if (typeof cb === 'function') queueMicrotask(cb);
  return true;
};

const makeStdin = (child, pendingWrites) => {
  const errorListeners = [];
  const fail = (error) => {
    for (const fn of [...errorListeners]) fn(error);
  };
  child.__stdinFlush = (flushError) => {
    const cbs = pendingWrites.splice(0);
    for (const cb of cbs) {
      try {
        cb(flushError ? Object.assign(new Error(`write EPIPE`), { code: 'EPIPE', errno: flushError, syscall: 'write' }) : null);
      } catch { /* a throwing write callback is the consumer's bug */ }
    }
  };
  const stdin = {
    on(event, fn) { if (event === 'error') errorListeners.push(fn); return stdin; },
    once(event, fn) { if (event === 'error') errorListeners.push((e) => { errorListeners.splice(errorListeners.indexOf(fn), 1); fn(e); }); return stdin; },
    off(event, fn) {
      const at = errorListeners.indexOf(fn);
      if (at >= 0) errorListeners.splice(at, 1);
      return stdin;
    },
    removeListener(event, fn) { return stdin.off(event, fn); },
    write(data, cb) { return stdinWrite(child, pendingWrites, fail, data, cb); },
    end(data, cb) {
      if (data !== undefined && data !== null) stdin.write(data);
      if (child.pid !== undefined && child.pid !== null) endStdinIntrinsic(child.pid);
      if (typeof cb === 'function') queueMicrotask(cb);
      return stdin;
    },
    destroy() { return stdin.end(); },
    get writableEnded() { return child.stdinEnded; },
    get destroyed() { return child.stdinEnded; },
  };
  return stdin;
};

/** Per-child pipe pump: __dshProcPoll every 4ms; chunks flow as 'data',
 * EOF ends the stream, reap emits 'exit' (node: even with pipes open),
 * and all-drained emits 'close'. A throwing consumer must not kill the
 * pump (node crashes the process on a listener throw — louder, but just as
 * fatal to the pipe chain; here the error is logged through the E2E sink
 * and the pump continues so the failure names itself instead of hanging
 * the awaited connection). */
/** The pump's debug emitter (12 lines per child when DSH_CHILD_DEBUG=1 —
 * a runaway child's 4ms poll must not flood the E2E sink). */
const pumpDebugEmitter = (child) => {
  let debugLeft = childDebugOn ? 12 : 0;
  return (fields) => {
    if (debugLeft <= 0) return;
    debugLeft -= 1;
    try {
      globalThis.__DSH_LOG_SINK__?.(JSON.stringify({ scenario: 'upstream.suite', event: 'debug/child', pid: child.pid, ...fields }));
    } catch { /* best-effort */ }
  };
};

const pumpReportError = (child, error) => {
  try {
    globalThis.__DSH_LOG_SINK__?.(JSON.stringify({
      scenario: 'upstream.suite',
      event: 'debug/child-pump-error',
      pid: child.pid,
      message: String(error?.message ?? error).slice(0, 300),
      stack: String(error?.stack ?? '').split('\n').slice(1, 4).join(' | ').slice(0, 400),
    }));
  } catch { /* the sink is best-effort */ }
};

/** One poll step's stream push: decoded stdout/stderr chunks (DshBuffer
 * face) plus the extra channels (fds 3..7, W8) — the poll's parallel arrays
 * surface child→parent bytes (extraOut[slot], b64-or-null) and EOF per
 * slot; only slots this spawn piped carry a stream face. Both chunk kinds
 * are re-spelled first (translateChildBytes): a real child's stdout/stderr
 * re-enters the VFS world in the granted container spelling, end to end. */
const pumpPushStreams = (child, res) => {
  if (res.out && child.stdout) {
    const bytes = Buffer.from(translateChildBytes(fromBase64(res.out)));
    child.stdout.push(child.stdout.__dshEncoding ? bytes.toString(child.stdout.__dshEncoding) : bytes);
  }
  if (res.err && child.stderr) {
    const bytes = Buffer.from(translateChildBytes(fromBase64(res.err)));
    child.stderr.push(child.stderr.__dshEncoding ? bytes.toString(child.stderr.__dshEncoding) : bytes);
  }
  for (let slot = 0; slot < CHILD_EXTRA_FDS; slot++) {
    const stream = child.stdio?.[slot + 3];
    if (stream === null || stream === undefined || stream.destroyed === true) continue;
    const b64 = res.extraOut?.[String(slot)];
    if (typeof b64 === 'string' && b64.length > 0) {
      const bytes = Buffer.from(translateChildBytes(fromBase64(b64)));
      stream.push(stream.__dshEncoding ? bytes.toString(stream.__dshEncoding) : bytes);
    }
    if (res.extraEof?.[String(slot)] === true && !stream.__dshExtraEof) {
      stream.__dshExtraEof = true;
      // END via end(), NOT push(null): this Readable's push queues any
      // chunk verbatim (a queued null would surface as a null VALUE to
      // for-await consumers — Buffer.from(null)-shaped failures); end()
      // sets the terminated state the iterator face answers done from.
      stream.end();
    }
  }
};

/** One poll step's stdin drain: flush pending write callbacks with the
 * poll's flushError, or with null once the host drained its backlog. */
const pumpFlushStdin = (child, res) => {
  if (res.flushError !== null && res.flushError !== undefined) {
    child.__stdinFlush?.(res.flushError);
  } else if ((res.pendingStdin ?? 0) === 0 && child.__stdinHasPending?.()) {
    child.__stdinFlush?.(null);
  }
};

/** The all-drained finish (child.__done set by the tick): node ends the
 * stdio streams at child EOF — 'end' once the final chunks have flowed,
 * then 'close' — consumers key flushes on those edges (the sdk client
 * pushes its unterminated stderr tail at the stream 'close'; a
 * never-ended stream hung the flush and dropped the line).
 * Already-destroyed streams (spawn-error arms) stay put. The extra
 * channels (fds 3..7, W8) do NOT join this sweep: a control endpoint
 * outlives the child on purpose — the vendored disposal destroys it, and
 * an unconsumed buffered channel must stay readable (the 'disposes its
 * paused control endpoint without draining it' contract). Their EOF
 * arrives through extraEof instead. */
const pumpFinish = (child) => {
  try {
    for (const stream of [child.stdout, child.stderr]) {
      if (stream === null || stream === undefined || stream.destroyed === true) continue;
      stream.end?.();
      stream.destroy?.();
    }
  } catch { /* the consumer's listeners must not kill the pump */ }
  child.emit('close', child.exitCode, child.signalCode);
};

/** One poll step: surface decoded chunks, drain pending stdin writes, emit
 * exit on reap and close on all-drained. Mutates pump.exitEmitted across
 * ticks. The whole step sits inside one try/catch: a throwing consumer is
 * logged through the sink and the pump reschedules (see the family note
 * above). */
const pumpTick = (child, pump) => {
  if (child.__done) return;
  let res;
  try {
    res = pollIntrinsic(child.pid);
    pump.debug({ outLen: res.out?.length ?? 0, errLen: res.err?.length ?? 0, exited: res.exited, outEof: res.outEof,
      // Payload heads in the debug stream (only when DSH_CHILD_DEBUG=1):
      // the pump's counters alone cannot say WHY a child is silent — the
      // hooks-cluster diagnosis (W6-U r3) turned on reading the child's
      // stderr text ('Permission denied' on a not-really-executable script).
      errHead: res.err ? String(decodeUtf8(fromBase64(res.err))).slice(0, 160) : undefined,
      outHead: res.out ? String(decodeUtf8(fromBase64(res.out))).slice(0, 160) : undefined });
    // Chunks surface as DshBuffer (Buffer.from over the decoded bytes) — plain
    // Uint8Array strips the Buffer face consumers parse with (indexOf / toString(enc,
    // start, end): the lsp-stdio decoder scanned through TypedArray.indexOf — W5-R).
    pumpPushStreams(child, res);
    pumpFlushStdin(child, res);
    if (res.exited && !pump.exitEmitted) {
      pump.exitEmitted = true;
      child.exitCode = res.signal === null || res.signal === undefined ? res.exitCode : null;
      child.signalCode = res.signal !== null && res.signal !== undefined ? signalName(res.signal) : null;
      child.emit('exit', child.exitCode, child.signalCode);
    }
    if (res.exited && res.outEof && res.errEof) {
      pumpFinish(child);
      return;
    }
  } catch (error) {
    pumpReportError(child, error);
  }
  setTimeout(() => pumpTick(child, pump), 4);
};

const startPump = (child) => {
  const pump = { exitEmitted: false, debug: pumpDebugEmitter(child) };
  setTimeout(() => pumpTick(child, pump), 4);
};

export {
  makeStdin,
  pumpDebugEmitter,
  pumpFlushStdin,
  pumpFinish,
  pumpPushStreams,
  pumpReportError,
  pumpTick,
  startPump,
  stdinWrite,
};
