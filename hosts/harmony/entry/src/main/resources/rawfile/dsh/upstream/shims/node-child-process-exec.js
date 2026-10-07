// dsh:logging-exempt (host shim: no side effects to log)
/**
 * shims/node-child-process-exec.js — the exec family of the node:child_process
 * shim (execFile / execFileSync / exec), split out of node-child-process.js
 * when that file crossed the code-size budget. One-way dependency: this
 * module imports spawn/spawnSync from node-child-process.js, which
 * re-exports these faces so every existing import keeps its specifier.
 */
import { Buffer, encodeUtf8, decodeUtf8 } from 'upstream/shims/buffer.js';
import { spawn, spawnSync } from 'upstream/shims/node-child-process.js';

/** execFile(file, args, options?, callback?) — callback form over ONE async
 * spawn (node runs the child exactly once; the previous double-run — async
 * spawn discarded + spawnSync in setTimeout — leaked a live twin of every
 * command and re-executed non-idempotent helpers). Node faces served here:
 * signal (abort kills with SIGTERM, callback gets the ABORT_ERR AbortError),
 * timeout (SIGTERM, killed:true), maxBuffer (SIGTERM + ENOBUFS), encoding
 * 'buffer'|utf8, and the non-zero exit error face (code = exit number,
 * `Command failed: <cmd>` message, killed/signal/cmd). The bare call (no
 * callback) returns the child for destructor use; promisify(execFile) drives
 * the synthesized-callback path. */
const ABORT_ERROR = () => Object.assign(new Error('The operation was aborted'), {
  name: 'AbortError', code: 'ABORT_ERR',
});

/** Fold one side's collected chunks into the node result shape (string join
 * in utf8 mode, a single Buffer in encoding:'buffer' mode). */
const collectExecOutput = (chunks, side, wantBuffer) => {
  const list = chunks[side];
  if (wantBuffer) {
    const parts = list.map((c) => (c instanceof Uint8Array ? c : encodeUtf8(String(c))));
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return Buffer.from(out);
  }
  return list.map((c) => (typeof c === 'string' ? c : decodeUtf8(c instanceof Uint8Array ? c : encodeUtf8(String(c))))).join('');
};

/** The termination wiring of one execFile child (module level for size):
 * abort listener, timeout arm, maxBuffer growth watch, and the paired
 * error/close handlers that settle the callback. `state` carries the
 * mutable flags the original closures shared. */
const wireExecTermination = (ctx) => {
  const { state, child, file, argv, options, maxBuffer, chunks, settle, onAbort } = ctx;
  if (options.signal) {
    if (options.signal.aborted) queueMicrotask(onAbort);
    else options.signal.addEventListener('abort', onAbort, { once: true });
  }
  if (typeof options.timeout === 'number' && options.timeout > 0) {
    state.timer = setTimeout(() => {
      if (state.settled || state.abortFailure) return;
      state.abortFailure = null;
      child.kill('SIGTERM');
      child.__timedOut = true;
    }, options.timeout);
  }
  const watchGrowth = () => {
    let total = 0;
    for (const side of [1, 2]) for (const c of ctx.chunks[side]) total += c.length ?? 0;
    if (total > maxBuffer && !state.oversized && !state.settled) {
      state.oversized = true;
      child.kill('SIGTERM');
    }
  };
  child.stdout?.on?.('data', watchGrowth);
  child.stderr?.on?.('data', watchGrowth);
  child.once('error', (error) => {
    // spawn failure (ENOENT & co): node hands the spawn error to the
    // callback with empty streams; the paired 'close' is absorbed by settled.
    if (state.abortFailure) { settle(state.abortFailure); return; }
    settle(error);
  });
  child.once('close', (code, signal) => {
    if (state.oversized) {
      settle(Object.assign(new Error('stdout maxBuffer length exceeded'), {
        code: 'ENOBUFS', killed: true, signal: 'SIGTERM', cmd: `${file} ${argv.join(' ')}`,
      }));
      return;
    }
    if (state.abortFailure) { settle(state.abortFailure); return; }
    if (code !== 0 || signal !== null && signal !== undefined) {
      const error = new Error(`Command failed: ${file}${argv.length > 0 ? ` ${argv.join(' ')}` : ''}`);
      error.code = code ?? undefined;
      error.killed = child.killed || child.__timedOut === true;
      error.signal = signal ?? null;
      error.cmd = `${file} ${argv.join(' ')}`;
      settle(error);
      return;
    }
    settle(null);
  });
};

export const execFile = (file, args = [], optionsOrCallback = {}, maybeCallback) => {
  const options = typeof optionsOrCallback === 'function' ? {} : (optionsOrCallback ?? {});
  const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
  const argv = Array.isArray(args) ? args : [];
  const child = spawn(file, argv, { cwd: options.cwd, env: options.env, stdio: options.stdio });
  if (typeof callback !== 'function') return child;
  const wantBuffer = options.encoding === 'buffer';
  const chunks = { 1: [], 2: [] };
  if (child.stdout) child.stdout.on('data', (chunk) => { chunks[1].push(chunk); });
  if (child.stderr) child.stderr.on('data', (chunk) => { chunks[2].push(chunk); });
  const state = { settled: false, abortFailure: null, oversized: false, timer: null };
  const maxBuffer = typeof options.maxBuffer === 'number' && options.maxBuffer >= 0
    ? options.maxBuffer
    : 1024 * 1024;
  const settle = (error) => {
    if (state.settled) return;
    state.settled = true;
    if (state.timer !== null) { clearTimeout(state.timer); state.timer = null; }
    options.signal?.removeEventListener?.('abort', onAbort);
    callback(error, collectExecOutput(chunks, 1, wantBuffer), collectExecOutput(chunks, 2, wantBuffer));
  };
  const onAbort = () => {
    if (state.settled || state.abortFailure) return;
    state.abortFailure = ABORT_ERROR();
    child.kill('SIGTERM');
  };
  wireExecTermination({ state, child, file, argv, options, maxBuffer, chunks, settle, onAbort });
  return child;
};

/** execFileSync(file, args, options?) — sync run; node throws on nonzero
 * status with the process facts riding the error. */
export const execFileSync = (file, args = [], options = {}) => {
  const res = spawnSync(file, args, options);
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const error = new Error(`Command failed: ${file}${Array.isArray(args) && args.length > 0 ? ` ${args.join(' ')}` : ''}`);
    error.status = res.status;
    error.signal = res.signal;
    error.stdout = res.stdout;
    error.stderr = res.stderr;
    throw error;
  }
  return res.stdout;
};

/** exec(command, options?, callback?) — /bin/sh -c over spawnSync. */
export const exec = (command, optionsOrCallback = {}, maybeCallback) => {
  const options = typeof optionsOrCallback === 'function' ? {} : (optionsOrCallback ?? {});
  const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
  return execFile('/bin/sh', ['-c', command], options, callback);
};
