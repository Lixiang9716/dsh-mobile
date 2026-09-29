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
// The WHATWG URL hash-setter completion (W8): this module is the one face
// the suite leg's driver preloads before EVERY spec import (its
// preloadRealFs), which makes it the in-lease boot-chain mount that runs
// ahead of all vendored code — see boot-tail-url-mutators.js's header.
import './boot-tail-url-mutators.js';

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

/** node's stdio option → the disposition list. Strings fan out; arrays keep
 * the EXTRA entries too (W8): node's stdio array runs past fd 2 and the
 * subprocess control channel rides fd 7 — the host parses dispositions for
 * fds 3..7 ('overlapped' spells a pipe there), so truncating at 3 broke
 * every control-pipe consumer with `child.stdio[7]` undefined. Missing
 * fd-0..2 entries default to 'pipe' (node's), missing extras to 'ignore'
 * (node leaves unset extras closed; the host's /dev/null 'ignore' is the
 * same no-traffic shape). */
const CHILD_EXTRA_FDS = 5; // fds 3..7 — mirrors DSH_PROC_EXTRA in the host
const normalizeStdio = (stdio) => {
  if (stdio === undefined || stdio === null) return ['pipe', 'pipe', 'pipe'];
  if (typeof stdio === 'string') return [stdio, stdio, stdio];
  if (Array.isArray(stdio)) {
    const out = [];
    for (let i = 0; i < 3 + CHILD_EXTRA_FDS; i++) {
      const entry = stdio[i];
      out.push(entry === undefined || entry === null ? (i < 3 ? 'pipe' : 'ignore') : entry);
    }
    return out;
  }
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

/** node resolves a RELATIVE spawn cwd against its own process.cwd(); this
 * runtime's process cwd is the pinned profile container, so the same option
 * anchors there — NOT on the C host's real working directory (the checkout
 * root), which is a different tree the profile container does not cover
 * (W8 cwd/tmp-fidelity: sdk-client's relative-launch-cwd probe spawned with
 * the relative '.dsh-sdk-client-relcwd-N/worker' workdir and the child landed
 * anchored at the real CLI cwd). Absolute cwds and unset options pass
 * through untouched. */
const spawnCwd = (cwd) => {
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.startsWith('/')) return cwd;
  const pinned = globalThis.__dshProfileCwd;
  if (typeof pinned !== 'string' || pinned.length <= 1) return cwd;
  return `${pinned.replace(/\/$/, '')}/${cwd}`;
};

/** Child-output re-spelling (W8 cwd/tmp-fidelity): on darwin /tmp is a
 * symlink to /private/tmp, so every real child answers container paths in
 * the OS-RESOLVED spelling — `pwd`, `git rev-parse --show-toplevel`,
 * getcwd-echoing servers. The profile-container translation must hold
 * END-TO-END: answers crossing back into the VFS world carry the granted
 * (logical) spelling of the SAME directory, or path.relative/toBe against
 * runtime-spelled paths diverge. This re-spells the container's own
 * `/private<profileCwd>` prefix — that exact prefix only; other /private/tmp
 * content is not ours to rename. Byte-level over the ASCII prefix so both
 * the string and buffer faces translate; a prefix straddling two pump
 * chunks (atomically-written lines are the norm, pipes ≤ PIPE_BUF) is left
 * untouched rather than buffered. */
const translateChildBytes = (bytes) => {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return bytes;
  const pinned = globalThis.__dshProfileCwd;
  if (typeof pinned !== 'string' || !pinned.startsWith('/tmp/')) return bytes;
  const container = pinned.replace(/\/$/, '');
  return replaceBytePrefixAll(bytes, `/private${container}`, container);
};

const replaceBytePrefixAll = (bytes, real, logical) => {
  const realLen = real.length;
  let hits = 0;
  for (let i = 0; i + realLen <= bytes.length; ) {
    if (bytes[i] !== 47 /* / */) { i += 1; continue; }
    let match = true;
    for (let j = 1; j < realLen; j += 1) {
      if (bytes[i + j] !== real.charCodeAt(j)) { match = false; break; }
    }
    if (match) { hits += 1; i += realLen; } else { i += 1; }
  }
  if (hits === 0) return bytes;
  const grown = logical.length - realLen;
  const out = new Uint8Array(bytes.length + hits * grown);
  let read = 0;
  let write = 0;
  while (read < bytes.length) {
    if (read + realLen <= bytes.length && bytes[read] === 47) {
      let match = true;
      for (let j = 1; j < realLen; j += 1) {
        if (bytes[read + j] !== real.charCodeAt(j)) { match = false; break; }
      }
      if (match) {
        for (let j = 0; j < logical.length; j += 1) out[write + j] = logical.charCodeAt(j);
        write += logical.length;
        read += realLen;
        continue;
      }
    }
    out[write] = bytes[read];
    write += 1;
    read += 1;
  }
  return out;
};

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
    // start, end): the lsp-stdio decoder scanned through TypedArray.indexOf — W5-R).
    // Both chunk kinds are re-spelled first (translateChildBytes): a real
    // child's stdout/stderr re-enters the VFS world in the granted container
    // spelling, end to end.
    if (res.out && child.stdout) {
      const bytes = Buffer.from(translateChildBytes(fromBase64(res.out)));
      child.stdout.push(child.stdout.__dshEncoding ? bytes.toString(child.stdout.__dshEncoding) : bytes);
    }
    if (res.err && child.stderr) {
      const bytes = Buffer.from(translateChildBytes(fromBase64(res.err)));
      child.stderr.push(child.stderr.__dshEncoding ? bytes.toString(child.stderr.__dshEncoding) : bytes);
    }
    // Extra channels (fds 3..7, W8): the poll's parallel arrays surface
    // child→parent bytes (extraOut[slot], b64-or-null) and EOF per slot.
    // Only slots this spawn piped carry a stream face.
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
      // node ends the stdio streams at child EOF: 'end' once the final
      // chunks have flowed, then 'close' — consumers key flushes on those
      // edges (the sdk client pushes its unterminated stderr tail at the
      // stream 'close'; a never-ended stream hung the flush and dropped
      // the line). Already-destroyed streams (spawn-error arms) stay put.
      // The extra channels (fds 3..7, W8) do NOT join this sweep: a control
      // endpoint outlives the child on purpose — the vendored disposal
      // destroys it, and an unconsumed buffered channel must stay readable
      // (the 'disposes its paused control endpoint without draining it'
      // contract). Their EOF arrives through extraEof instead.
      try {
        for (const stream of [child.stdout, child.stderr]) {
          if (stream === null || stream === undefined || stream.destroyed === true) continue;
          stream.end?.();
          stream.destroy?.();
        }
      } catch { /* the consumer's listeners must not kill the pump */ }
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
    this.stdio = [null, null, null];
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

/** W8: keyed real-file staging for spawned suite children. A spawned child
 * may be a REAL node/python process reading the REAL disk, while the bytes
 * it needs live only in the vendored closure. When an argv names one of the
 * known shapes, the vendored/submodule files stage VERBATIM (/bin/cp, D6
 * read-only) at the bundle-root paths the host's argv remap and the
 * child's own joins compute. Keyed to the argv (nothing stages for any
 * other consumer), idempotent, desktop-only (no sync seam → no staging). */
const stageSpawnedSiblings = (args, stdio) => {
  if (typeof spawnSyncIntrinsic !== 'function') return;
  if (!args.some((a) => typeof a === 'string' && (a.includes('control-child.ts') || a.includes('check_office')))) return;
  const quiet = stdio?.length === 3 ? stdio : ['ignore', 'ignore', 'ignore'];
  const stage = (from, to) => {
    spawnSyncIntrinsic({ command: '/bin/mkdir', args: ['-p', to.slice(0, to.lastIndexOf('/'))], stdio: quiet });
    return spawnSyncIntrinsic({ command: '/bin/cp', args: [from, to], stdio: quiet }).status === 0;
  };
  // The subprocess control-pipe suite: a fixture child that imports the
  // vendored control-protocol source (both must be real files — the child
  // is a real node process).
  stage(
    'vendor/dsh-tests@dsh-v0.1.6-alpha.2/packages/subprocess/subprocess-local/tests/fixtures/control-child.ts',
    'upstream-tests/fixtures/control-child.ts',
  );
  stage(
    '../../third-party/deepseek-harness/packages/subprocess/subprocess/src/control.ts',
    'subprocess/src/control.ts',
  );
  // The skill-office checker suite: the python TEST drives the SHIPPED
  // checker script (CHECKER = parents[1] / 'assets/scripts/check_office.py')
  // — the leg's sibling staging carries the test file but not the checker
  // its subprocess runs.
  spawnSyncIntrinsic({ command: '/bin/mkdir', args: ['-p', 'assets/scripts'], stdio: quiet });
  spawnSyncIntrinsic({
    command: '/bin/cp',
    args: [
      'vendor/npm/@deepseek-ai/dsh-skill-office@0.1.6-alpha.2/assets/scripts/check_office.py',
      'assets/scripts/check_office.py',
    ],
    stdio: quiet,
  });
};

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
  stageSpawnedSiblings(args, stdio);
  // setEncoding face (node: strings instead of Buffers from the named
  // stream on): sdk-client's server tap decodes stderr with it. The pump
  // converts the chunk at push time so consumers just see strings. Declared
  // before both the failure and success arms — both hand out real streams.
  const makeOut = () => {
    const stream = new Readable();
    stream.setEncoding = (encoding) => { stream.__dshEncoding = encoding; return stream; };
    return stream;
  };
  const res = spawnIntrinsic({
    command,
    args: child.spawnargs,
    cwd: spawnCwd(options.cwd),
    env: options.env,
    detached: options.detached,
    stdio,
  });
  if (res.error) {
    const error = spawnError('spawn', command, res.error);
    const never = new Readable();
    never.destroy();
    // The failure child still carries node's STREAM API on its pipes — real
    // consumers (the sdk client's start) call setEncoding/wire listeners on
    // them before the error event lands, and a bare Readable lacks the face
    // (measured: 'spawn failure' rejected with QuickJS's bare "not a
    // function" instead of the ENOENT transport error).
    if (stdio[0] === 'pipe') child.stdin = makeStdin(child);
    if (stdio[1] === 'pipe') child.stdout = makeOut();
    if (stdio[2] === 'pipe') child.stderr = makeOut();
    child.stdio = [child.stdin, child.stdout, child.stderr, null, null, null, null, null];
    child.stdout?.destroy?.();
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
  if (stdio[0] === 'pipe') child.stdin = makeStdin(child, pendingWrites);
  if (stdio[1] === 'pipe') child.stdout = makeOut();
  if (stdio[2] === 'pipe') child.stderr = makeOut();
  // The extra channels (fds 3..7, W8): each piped entry gets a duplex-lite
  // face — a Readable the pump feeds from the poll's extraOut/extraEof plus
  // a write() over __dshProcWriteFd (slot = fd - 3) and an end() over
  // __dshProcEndFd. The subprocess control channel (child.stdio[7]) is the
  // operative consumer: the vendored spawn hands it out as handle.control.
  child.stdio = [child.stdin, child.stdout, child.stderr, null, null, null, null, null];
  for (let fd = 3; fd < stdio.length && fd < 3 + CHILD_EXTRA_FDS; fd++) {
    const mode = stdio[fd];
    if (mode !== 'pipe' && mode !== 'overlapped') continue;
    const slot = fd - 3;
    const stream = makeOut();
    // node's stream `closed` face (true once destroyed or fully ended) — the
    // control channel's disposal contract asserts it (W8).
    Object.defineProperty(stream, 'closed', {
      get: () => stream.destroyed === true || stream.readableEnded === true,
      configurable: true,
    });
    stream.write = (chunk) => {
      if (typeof writeFdIntrinsic !== 'function') needSeam('__dshProcWriteFd');
      const r = writeFdIntrinsic(child.pid, slot, toB64(chunk));
      if (r && r.error) throw new Error(`node:child_process: extra fd ${fd} write failed: ${r.error.message ?? r.error.code ?? 'unknown'}`);
      return true;
    };
    stream.endChannel = () => {
      if (typeof endFdIntrinsic !== 'function') return;
      try { endFdIntrinsic(child.pid, slot); } catch { /* already closed */ }
    };
    const originalDestroy = stream.destroy.bind(stream);
    stream.destroy = (...args) => {
      stream.endChannel();
      return originalDestroy(...args);
    };
    child.stdio[fd] = stream;
  }
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
  stageSpawnedSiblings([...args], normalizeStdio(options.stdio));
  const res = spawnSyncIntrinsic({
    command,
    args: [...args],
    cwd: spawnCwd(options.cwd),
    env: options.env,
    input: options.input !== undefined ? toB64(options.input) : undefined,
    timeoutMs: options.timeout,
    stdio: normalizeStdio(options.stdio),
  });
  const wantBuffer = options.encoding === 'buffer';
  // Output re-spelled (see translateChildBytes) before either face decodes.
  const decode = (b64) => {
    const bytes = translateChildBytes(b64 ? fromBase64(b64) : []);
    return wantBuffer ? Buffer.from(bytes) : decodeUtf8(bytes);
  };
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
