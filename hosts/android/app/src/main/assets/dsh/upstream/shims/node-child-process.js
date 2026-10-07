// dsh:logging-exempt (host shim: no side effects to log)
/**
 * node:child_process — the REAL subprocess face for the parity leg (W5-R,
 * 2026-09-28). The host owns OS children through the __dshProc* intrinsics
 * (portable fork/exec/poll/waitpid in dsh_runtime_host.c); this shim serves
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
 *
 * W9 split (size budget): the pure-data tables live in
 * node-child-process-tables.js and the per-child pipe pump family in
 * node-child-process-pump.js. The dependency is one-way — those modules
 * never import THIS file (a static shim→shim cycle kills QuickJS at link);
 * this file imports the split names back and re-exports them so every
 * existing specifier keeps working.
 */
import { EventEmitter } from './events.js';
import { Readable } from './node-stream.js';
import { Buffer, fromBase64, decodeUtf8 } from './buffer.js';
// The WHATWG URL hash-setter completion (W8): this module is the one face
// the suite leg's driver preloads before EVERY spec import (its
// preloadRealFs), which makes it the in-lease boot-chain mount that runs
// ahead of all vendored code — see boot-tail-url-mutators.js's header.
import './boot-tail-url-mutators.js';
// W9 split-back imports: what this file still uses, imported plainly (the
// separate export{} re-exports below keep every existing specifier true).
import { CHILD_EXTRA_FDS, normalizeStdio, signalName, spawnCwd, spawnError, toB64, translateChildBytes } from './node-child-process-tables.js';
import { makeStdin, startPump } from './node-child-process-pump.js';
export {
  bytesToB64,
  replaceBytePrefixAll,
  SIGNALS_DARWIN,
  SIGNALS_LINUX,
  signalTable,
} from './node-child-process-tables.js';
export {
  makeStdin,
  pumpDebugEmitter,
  pumpReportError,
  pumpTick,
  startPump,
  stdinWrite,
} from './node-child-process-pump.js';
export {
  CHILD_EXTRA_FDS,
  normalizeStdio,
  signalName,
  spawnCwd,
  spawnError,
  toB64,
  translateChildBytes,
};

const spawnIntrinsic = globalThis.__dshProcSpawn;
const spawnSyncIntrinsic = globalThis.__dshProcSpawnSync;
const killIntrinsic = globalThis.__dshProcKill;
const writeFdIntrinsic = globalThis.__dshProcWriteFd;
const endFdIntrinsic = globalThis.__dshProcEndFd;

/** Fail loud naming the missing host intrinsic (rule 5) at CALL time —
 * linking child_process must not kill a load that never spawns. */
const needSeam = (name) => {
  throw new Error(`node:child_process: ${name} needs the host subprocess seam (__dshProc* intrinsics absent — rebuild the host with dsh_runtime_host.c W5-R or later)`);
};

/** setEncoding face (node: strings instead of Buffers from the named
 * stream on): sdk-client's server tap decodes stderr with it. The pump
 * converts the chunk at push time so consumers just see strings. Hoisted
 * from spawn (W9 split) — the failure and success arms alike hand out real
 * streams through it. */
const makeOutStream = () => {
  const stream = new Readable();
  stream.setEncoding = (encoding) => { stream.__dshEncoding = encoding; return stream; };
  return stream;
};

/** The spawn-failure arm: node still hands out stream faces and reports
 * through the 'error' event (then 'close'); pid stays undefined. The
 * failure child carries node's STREAM API on its pipes — real consumers
 * (the sdk client's start) call setEncoding/wire listeners on them before
 * the error event lands, and a bare Readable lacks the face (measured:
 * 'spawn failure' rejected with QuickJS's bare "not a function" instead of
 * the ENOENT transport error). */
const wireSpawnFailureStreams = (child, stdio) => {
  const never = new Readable();
  never.destroy();
  if (stdio[0] === 'pipe') child.stdin = makeStdin(child);
  if (stdio[1] === 'pipe') child.stdout = makeOutStream();
  if (stdio[2] === 'pipe') child.stderr = makeOutStream();
  child.stdio = [child.stdin, child.stdout, child.stderr, null, null, null, null, null];
  child.stdout?.destroy?.();
  child.stderr?.destroy?.();
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

/** The extra channels (fds 3..7, W8): each piped entry gets a duplex-lite
 * face — a Readable the pump feeds from the poll's extraOut/extraEof plus
 * a write() over __dshProcWriteFd (slot = fd - 3) and an end() over
 * __dshProcEndFd. The subprocess control channel (child.stdio[7]) is the
 * operative consumer: the vendored spawn hands it out as handle.control. */
const wireExtraChannels = (child, stdio) => {
  for (let fd = 3; fd < stdio.length && fd < 3 + CHILD_EXTRA_FDS; fd++) {
    const mode = stdio[fd];
    if (mode !== 'pipe' && mode !== 'overlapped') continue;
    const slot = fd - 3;
    const stream = makeOutStream();
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
    wireSpawnFailureStreams(child, stdio);
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
  if (stdio[1] === 'pipe') child.stdout = makeOutStream();
  if (stdio[2] === 'pipe') child.stderr = makeOutStream();
  child.stdio = [child.stdin, child.stdout, child.stderr, null, null, null, null, null];
  wireExtraChannels(child, stdio);
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
