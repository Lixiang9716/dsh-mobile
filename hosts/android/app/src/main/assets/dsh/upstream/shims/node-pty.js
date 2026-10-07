// dsh:logging-exempt (host shim: the PTY face over the forkpty seam)
/**
 * shims/node-pty.js — the node-pty API face over the host's forkpty seam
 * (decision D-b, 2026-09-29; contract/proposals/2026-09-29-forkpty-face.md).
 *
 * The vendored `@deepseek-ai/dsh-subprocess-local` terminal path loads its
 * backend through `createLazyRequire('node-pty')` and spawns REAL children
 * on REAL pseudo-terminals (echo, job control, a foreground process group,
 * TERM, SIGWINCH window sizes). The host grew the __dshPty* intrinsics
 * (forkpty(3) in dsh_runtime_host.c) and this module serves node-pty's IPty
 * surface over them: spawn/onData/onExit/write/resize/kill plus the
 * pause/resume flow-control pair the vendored handle drives.
 *
 * Events, never polls (D8): the C seam never calls JS; this side runs the
 * same 4ms pump the node:child_process shim runs (the ordinary timer seam
 * re-entering the serial queue — D2's one runtime thread is untouched) and
 * turns each poll into the pty.event sequence — data chunks and one exit.
 * The face registers into the cjs-loader's builtin-face table
 * (npm-bridges.js), which is what `createRequire(...)('node-pty')` resolves
 * through; a host whose toolchain lacks forkpty fails the spawn loud at its
 * own intrinsic (the honest `unavailable`, never a fake).
 */
import { encodeUtf8, decodeUtf8, fromBase64 } from './buffer.js';
import { signalName, toB64 } from './node-child-process-tables.js';

const spawnIntrinsic = globalThis.__dshPtySpawn;
const pollIntrinsic = globalThis.__dshPtyPoll;
const writeIntrinsic = globalThis.__dshPtyWrite;
const resizeIntrinsic = globalThis.__dshPtyResize;
const killIntrinsic = globalThis.__dshPtyKill;

/** One pseudo-terminal child: node-pty's IPty face over the host slot. */
class DshPty {
  constructor(pid, cols, rows) {
    this.pid = pid;
    this._cols = cols;
    this._rows = rows;
    this._dataCbs = [];
    this._exitCbs = [];
    this._exit = null;        // { exitCode, signal } once reaped
    this._paused = false;
    this._parked = [];        // data chunks withheld while paused
    this._pumpAlive = true;
  }

  /** node-pty: subscribe to output (UTF-8-decoded strings) — returns a
   * disposable, which is all the vendored handle keeps. */
  onData(cb) {
    this._dataCbs.push(cb);
    return { dispose: () => this._off(this._dataCbs, cb) };
  }

  /** node-pty: subscribe to the one-shot exit ({ exitCode, signal }). */
  onExit(cb) {
    if (this._exit) {
      // node-pty publishes exit exactly once; a subscriber that arrives
      // after the fact gets the recorded event synchronously (the vendored
      // handle subscribes before any reap can land — this is belt).
      this._fireExit(cb);
      return { dispose: () => { /* already fired */ } };
    }
    this._exitCbs.push(cb);
    return { dispose: () => this._off(this._exitCbs, cb) };
  }

  /** node-pty: keystrokes into the master (string or bytes). */
  write(data) {
    writeIntrinsic(this.pid, toB64(typeof data === 'string' ? data : data));
  }

  /** node-pty: window resize — TIOCSWINSZ on the master; the kernel
   * delivers SIGWINCH to the child's foreground group. */
  resize(cols, rows) {
    this._cols = cols;
    this._rows = rows;
    resizeIntrinsic(this.pid, cols, rows);
  }

  /** node-pty: signal the child (default SIGHUP — the vendored cleanup
   * ladder escalates SIGTERM/SIGKILL explicitly). */
  kill(signal) {
    killIntrinsic(this.pid, signal ?? 'SIGHUP');
  }

  /** node-pty flow control: gate the onData delivery. The host keeps
   * reading (the child never deadlocks on a full pipe); withheld chunks
   * park here until resume(). */
  pause() { this._paused = true; }

  resume() {
    this._paused = false;
    const parked = this._parked.splice(0);
    for (const chunk of parked) this._deliver(chunk);
  }

  get cols() { return this._cols; }
  get rows() { return this._rows; }

  _off(list, cb) {
    const at = list.indexOf(cb);
    if (at >= 0) list.splice(at, 1);
  }

  _deliver(chunk) {
    for (const cb of [...this._dataCbs]) {
      try { cb(chunk); } catch (error) {
        // a throwing consumer must not kill the pump (the pump's contract
        // since the child-process seam): name it through the E2E sink.
        globalThis.__DSH_LOG_SINK__?.(JSON.stringify({
          scenario: 'upstream.suite', event: 'debug/pty-data-error',
          pid: this.pid, message: String(error?.message ?? error).slice(0, 200),
        }));
      }
    }
  }

  _fireExit(cb) {
    try { cb(this._exit); } catch (error) {
      globalThis.__DSH_LOG_SINK__?.(JSON.stringify({
        scenario: 'upstream.suite', event: 'debug/pty-exit-error',
        pid: this.pid, message: String(error?.message ?? error).slice(0, 200),
      }));
    }
  }

  /** One pump tick: poll → data events + the single exit event; re-arms
   * while the terminal is live. The intrinsic answers a settled shape for
   * a released slot, so a late tick is harmless. */
  _tick() {
    if (!this._pumpAlive) return;
    const res = pollIntrinsic(this.pid);
    if (res.out) {
      const text = decodeUtf8(fromBase64(res.out));
      if (this._paused) this._parked.push(text);
      else this._deliver(text);
    }
    if (res.exited && !this._exit) {
      // node-pty's exit shape, adapted to the vendored consumer: signal as
      // a NUMBER (0 = none) — signalName(0) → null on the outcome path.
      this._exit = { exitCode: res.exitCode === null ? -1 : res.exitCode, signal: res.signal ?? 0 };
      this._pumpAlive = false;
      for (const cb of [...this._exitCbs]) this._fireExit(cb);
      this._exitCbs.length = 0;
      return;
    }
    if (res.outEof && res.exited) { this._pumpAlive = false; return; }
    setTimeout(() => this._tick(), 4);
  }
}

/** node-pty: `spawn(file, args, options)` → IPty. The env carries TERM
 * (mirrors node-pty: options.env verbatim, TERM=name when it lacks one). */
const spawn = (file, args, options = {}) => {
  if (typeof spawnIntrinsic !== 'function') {
    throw new Error('node-pty: no forkpty seam on this host (the pty face is unavailable here)');
  }
  const argList = Array.isArray(args) ? args : [];
  const cols = options.cols ?? 80;
  const rows = options.rows ?? 24;
  const env = { ...options.env };
  const term = options.name ?? 'xterm-256color';
  if (!env.TERM) env.TERM = term;
  const res = spawnIntrinsic({ file, args: argList, cwd: options.cwd, env, cols, rows });
  if (res && typeof res.error === 'object' && res.error !== null) {
    const e = new Error(`node-pty: spawn failed: ${res.error.message ?? res.error.code}`);
    e.code = res.error.code;
    e.errno = res.error.errno;
    throw e;
  }
  const pty = new DshPty(res.pid, cols, rows);
  setTimeout(() => pty._tick(), 4);
  return pty;
};

/** node-pty's master-fd `open` face is a named non-goal of the v0 seam
 * (the fd stays host-owned behind the ptyId): loud refusal, never a fake. */
const open = () => {
  throw new Error('node-pty: open() is not served — the master fd face is a named non-goal of the forkpty seam');
};

export { spawn, open };
export default { spawn, open };
