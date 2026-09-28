// dsh:logging-exempt (host shim: no side effects to log)
/**
 * node:child_process — the REAL subprocess face for the parity leg (W5-R,
 * 2026-09-28). The host owns OS children through the __dshProc* intrinsics
 * (portable fork/exec/poll/waitpid in dsh_spike_host.c); this shim serves
 * node's API over them: spawn (stdio pipes, detached, exit/close/error and
 * the 'spawn' event), spawnSync (status:null + .error on unspawnable
 * commands — node's own contract the pwsh/systemd-run probes rely on),
 * execFile/callback + execFileSync, exec, and ChildProcess. The JS runtime
 * thread never blocks on a child: the shim pumps each child's pipes on a
 * 4ms timer and reaps through __dshProcPoll (node blocks its own loop for
 * spawnSync only, which maps to the host's blocking sync primitive).
 *
 * D2 note: children never execute JS in THIS runtime — the serial-thread
 * constitution is untouched. The product maps the same node face onto each
 * platform's privileged layer (Android: Termux-pattern jniLibs; iOS:
 * dsh-subprocess-quickjs coroutine re-implementation).
 */
import { EventEmitter } from './events.js';
import { Readable } from './node-stream.js';
import { Buffer, fromBase64, encodeUtf8, decodeUtf8 } from './buffer.js';

const spawnIntrinsic = globalThis.__dshProcSpawn;
const spawnSyncIntrinsic = globalThis.__dshProcSpawnSync;
const pollIntrinsic = globalThis.__dshProcPoll;
const writeIntrinsic = globalThis.__dshProcWrite;
const endStdinIntrinsic = globalThis.__dshProcEndStdin;
const killIntrinsic = globalThis.__dshProcKill;
const writeFdIntrinsic = globalThis.__dshProcWriteFd;
const endFdIntrinsic = globalThis.__dshProcEndFd;

/** Fail loud naming the missing host intrinsic (rule 5) at CALL time —
 * linking child_process must not kill a load that never spawns. */
const needSeam = (name) => {
  throw new Error(`node:child_process: ${name} needs the host subprocess seam (__dshProc* intrinsics absent — rebuild the host with dsh_spike_host.c W5-R or later)`);
};

const childDebugOn = (() => {
  try {
    const raw = typeof globalThis.__dshLaunchEnv === 'function' ? globalThis.__dshLaunchEnv() : null;
    return raw ? JSON.parse(raw).DSH_CHILD_DEBUG === '1' : false;
  } catch { return false; }
})();

/** Signal NUMBER → name for the numbers the C host reports in wait status
 * (raw WTERMSIG). The previous single partial list indexed num-1 and mapped
 * most numbers WRONG (signal 15 → 'SIGTTIN': the list skipped SIGILL/SIGTRAP
 * et al. while the index math assumed contiguity — measured 2026-09-27,
 * bash-local executor 'classifies a self-killed command'). darwin and linux
 * share 1-3, 9, 13-15; the rest differ, so the map is per-platform. */
const SIGNALS_DARWIN = { 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 5: 'SIGTRAP',
  6: 'SIGABRT', 7: 'SIGEMT', 8: 'SIGFPE', 9: 'SIGKILL', 10: 'SIGBUS', 11: 'SIGSEGV',
  12: 'SIGSYS', 13: 'SIGPIPE', 14: 'SIGALRM', 15: 'SIGTERM', 16: 'SIGURG', 17: 'SIGSTOP',
  18: 'SIGTSTP', 19: 'SIGCONT', 20: 'SIGCHLD', 21: 'SIGTTIN', 22: 'SIGTTOU', 23: 'SIGIO',
  24: 'SIGXCPU', 25: 'SIGXFSZ', 26: 'SIGVTALRM', 27: 'SIGPROF', 28: 'SIGWINCH', 29: 'SIGINFO' };
const SIGNALS_LINUX = { 1: 'SIGHUP', 2: 'SIGINT', 3: 'SIGQUIT', 4: 'SIGILL', 5: 'SIGTRAP',
  6: 'SIGABRT', 7: 'SIGBUS', 8: 'SIGFPE', 9: 'SIGKILL', 10: 'SIGUSR1', 11: 'SIGSEGV',
  12: 'SIGUSR2', 13: 'SIGPIPE', 14: 'SIGALRM', 15: 'SIGTERM', 16: 'SIGSTKFLT',
  17: 'SIGCHLD', 18: 'SIGCONT', 19: 'SIGSTOP', 20: 'SIGTSTP', 21: 'SIGTTIN', 22: 'SIGTTOU',
  23: 'SIGIO', 24: 'SIGXCPU', 25: 'SIGXFSZ', 26: 'SIGVTALRM', 27: 'SIGPROF', 28: 'SIGWINCH' };
const signalTable = (() => {
  try {
    const raw = typeof globalThis.__dshLaunchEnv === 'function' ? globalThis.__dshLaunchEnv() : null;
    const platform = raw ? JSON.parse(raw).DSH_HOST_PLATFORM : undefined;
    return platform === 'linux' ? SIGNALS_LINUX : SIGNALS_DARWIN;
  } catch { return SIGNALS_DARWIN; }
})();
const signalName = (num) => signalTable[num] ?? `SIG${num}`;

/** bytes → base64 (btoa is the host's latin-1 intrinsic; chunked String
 * construction keeps big stdin frames off the call stack). */
const bytesToB64 = (bytes) => {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
};
const toB64 = (data) => {
  if (typeof data === 'string') return bytesToB64(encodeUtf8(data));
  if (data instanceof Uint8Array) return bytesToB64(data);
  return bytesToB64(Buffer.from(String(data)));
};

/** node's stdio option → the 3-entry disposition list (strings pass
 * through; 'overlapped' pipes — the C layer maps it identically). */
const normalizeStdio = (stdio) => {
  if (stdio === undefined || stdio === null) return ['pipe', 'pipe', 'pipe'];
  if (typeof stdio === 'string') return [stdio, stdio, stdio];
  if (Array.isArray(stdio)) return [0, 1, 2].map((i) => stdio[i] ?? 'pipe');
  return ['pipe', 'pipe', 'pipe'];
};

/** The spawn-failure error node raises: message is `spawn <cmd> <CODE>`
 * (node composes the error message from the UV errno NAME — the bash-local
 * executor's bad-workdir test matches /ENOENT/ against the message, which
 * the previous raw.message composition never named), with the
 * syscall/code/errno/path face. */
const spawnError = (syscall, command, raw) => {
  const error = new Error(`${syscall} ${command} ${raw?.code ?? raw?.message ?? 'failed'}`);
  error.code = raw?.code ?? 'EIO';
  error.errno = raw?.errno;
  error.syscall = syscall;
  error.path = command;
  return error;
};

/** stdin: a write/close face over __dshProcWrite. The OS pipe is
 * non-blocking and the HOST buffers refused bytes, so writes report
 * backpressure (return false, callback pending) instead of blocking the
 * runtime — the abort-during-backpressured-write contract depends on the
 * callback staying pending while the pipe is full. */
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

/** One poll step: surface decoded chunks (DshBuffer face), drain pending
 * stdin writes, emit exit on reap and close on all-drained. Mutates
 * pump.exitEmitted across ticks. */
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
    // start, end): the lsp-stdio decoder scanned through TypedArray.indexOf — W5-R.
    if (res.out && child.stdout) {
      const bytes = Buffer.from(fromBase64(res.out));
      child.stdout.push(child.stdout.__dshEncoding ? bytes.toString(child.stdout.__dshEncoding) : bytes);
    }
    if (res.err && child.stderr) {
      const bytes = Buffer.from(fromBase64(res.err));
      child.stderr.push(child.stderr.__dshEncoding ? bytes.toString(child.stderr.__dshEncoding) : bytes);
    }
    if (res.flushError !== null && res.flushError !== undefined) {
      child.__stdinFlush?.(res.flushError);
    } else if ((res.pendingStdin ?? 0) === 0 && child.__stdinHasPending?.()) {
      child.__stdinFlush?.(null);
    }
    if (res.exited && !pump.exitEmitted) {
      pump.exitEmitted = true;
      child.exitCode = res.signal === null || res.signal === undefined ? res.exitCode : null;
      child.signalCode = res.signal !== null && res.signal !== undefined ? signalName(res.signal) : null;
      child.emit('exit', child.exitCode, child.signalCode);
    }
    if (res.exited && res.outEof && res.errEof) {
      child.__done = true;
      child.emit('close', child.exitCode, child.signalCode);
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

export class ChildProcess extends EventEmitter {
  constructor() {
    super();
    this.pid = undefined;
    this.stdin = null;
    this.stdout = null;
    this.stderr = null;
    this.exitCode = null;
    this.signalCode = null;
    this.spawnfile = '';
    this.spawnargs = [];
    this.killed = false;
    this.stdinEnded = false;
    this.__done = false;
  }
  kill(signal = 'SIGTERM') {
    if (this.pid === undefined || this.pid === null) return false;
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.killed = true;
    try {
      killIntrinsic(this.pid, signal);
      return true;
    } catch {
      return false;
    }
  }
  ref() { return this; }
  unref() { return this; }
}

/** spawn(command, args, options) — the node face subprocess-local's
 * normalize layer drives. On failure node still hands out stream faces and
 * reports through the 'error' event (then 'close'); pid stays undefined. */
export const spawn = (command, args = [], options = {}) => {
  const child = new ChildProcess();
  child.spawnfile = command;
  child.spawnargs = [...args];
  if (typeof spawnIntrinsic !== 'function') {
    const error = spawnError('spawn', command, { code: 'ERR_DSH_NO_SEAM', message: 'no host seam' });
    queueMicrotask(() => child.emit('error', error));
    return child;
  }
  const stdio = normalizeStdio(options.stdio);
  const res = spawnIntrinsic({
    command,
    args: child.spawnargs,
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
    stdio,
  });
  if (res.error) {
    const error = spawnError('spawn', command, res.error);
    const never = new Readable();
    never.destroy();
    if (stdio[0] === 'pipe') child.stdin = makeStdin(child);
    if (stdio[1] === 'pipe') child.stdout = never;
    if (stdio[2] === 'pipe') child.stderr = new Readable();
    child.stderr?.destroy?.();
    queueMicrotask(() => {
      child.emit('error', error);
      child.emit('close', null, null);
    });
    return child;
  }
  child.pid = res.pid;
  const pendingWrites = [];
  child.__stdinHasPending = () => pendingWrites.length > 0;
  // setEncoding face (node: strings instead of Buffers from the named
  // stream on): sdk-client's server tap decodes stderr with it. The pump
  // converts the chunk at push time so consumers just see strings.
  const makeOut = () => {
    const stream = new Readable();
    stream.setEncoding = (encoding) => { stream.__dshEncoding = encoding; return stream; };
    return stream;
  };
  if (stdio[0] === 'pipe') child.stdin = makeStdin(child, pendingWrites);
  if (stdio[1] === 'pipe') child.stdout = makeOut();
  if (stdio[2] === 'pipe') child.stderr = makeOut();
  queueMicrotask(() => child.emit('spawn'));
  startPump(child);
  return child;
};

/** spawnSync — node's blocking face (the runtime genuinely stops, node's
 * own semantics). Unspawnable commands return {status:null, error} and do
 * NOT throw: the pwsh/systemd-run probes test capability AT module scope
 * through this shape. Default encoding utf8 → strings (buffer only when
 * asked). */
export const spawnSync = (command, args = [], options = {}) => {
  if (typeof spawnSyncIntrinsic !== 'function') {
    return {
      pid: 0, status: null, signal: null, output: [null, '', ''], stdout: '', stderr: '',
      error: spawnError('spawnSync', command, { code: 'ERR_DSH_NO_SEAM', message: 'no host seam' }),
    };
  }
  const res = spawnSyncIntrinsic({
    command,
    args: [...args],
    cwd: options.cwd,
    env: options.env,
    input: options.input !== undefined ? toB64(options.input) : undefined,
    timeoutMs: options.timeout,
    stdio: normalizeStdio(options.stdio),
  });
  const wantBuffer = options.encoding === 'buffer';
  const decode = (b64) => (wantBuffer ? Buffer.from(b64 ? fromBase64(b64) : []) : decodeUtf8(b64 ? fromBase64(b64) : []));
  if (res.error) {
    return {
      pid: 0,
      status: null,
      signal: null,
      output: [null, wantBuffer ? Buffer.alloc(0) : '', wantBuffer ? Buffer.alloc(0) : ''],
      stdout: wantBuffer ? Buffer.alloc(0) : '',
      stderr: wantBuffer ? Buffer.alloc(0) : '',
      error: spawnError('spawnSync', command, res.error),
    };
  }
  const stdout = decode(res.stdout);
  const stderr = decode(res.stderr);
  const signal = res.signal !== null && res.signal !== undefined ? signalName(res.signal) : null;
  return {
    pid: res.pid,
    status: signal === null ? res.status : null,
    signal,
    output: [null, stdout, stderr],
    stdout,
    stderr,
  };
};

// The exec family lives in node-child-process-exec.js (the file crossed
// the size budget); re-exported here so every existing import and the
// default namespace below keep their shape.
import { execFile, execFileSync, exec } from 'upstream/shims/node-child-process-exec.js';
export { execFile, execFileSync, exec };

const childProcess = {
  spawn,
  spawnSync,
  execFile,
  execFileSync,
  exec,
  ChildProcess,
};

export default childProcess;
