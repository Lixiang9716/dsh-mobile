// dsh:logging-exempt (shim layer: no transport, no I/O of its own)
/**
 * source-bootstrap-ipc.js — the 'ipc' stdio face over the subprocess seam
 * (W8 source-entry-bootstrap). node's `stdio: [...,'ipc']` gives a child a
 * real IPC channel (process.send / 'message' events over fd 3); the
 * subprocess shim predates the need — its normalizeStdio keeps the first
 * three entries and the win32-dialog driver's spawned worker therefore
 * died on `process.send === undefined` before any protocol frame existed.
 *
 * The seam already carries the fd-3+ socketpairs (dsh_proc_fork_exec wires
 * piped extras as socketpairs, "libuv's own shape") with poll surfaces
 * (extraOut/extraEof) plus __dshProcWriteFd/__dshProcEndFd, so the face is
 * a thin NDJSON protocol over slot 0:
 *   - spawn-side: stdio[3] === 'ipc' maps to a piped extra + the
 *     NODE_CHANNEL_FD=3 environment real node's channel boot reads;
 *   - the pump polls the extra channel on a 4ms timer (the same cadence as
 *     the stdio pump) and emits each JSON line as a 'message' event;
 *   - child.send(frame) writes JSON + '\n' through __dshProcWriteFd;
 *     child.disconnect() ends the channel (the child sees EOF and — node's
 *     own contract — exits).
 * Frames shaped {"cmd":"node:…"} are node-internal channel control and are
 * dropped, like a plain-JSON channel consumer sees.
 */

import { fromBase64, encodeUtf8, decodeUtf8 } from 'upstream/shims/buffer.js';

const IPC_CHANNEL_FD = '3';
const IPC_SLOT = 0;

/** Per-pid siphoned extra-channel bytes. The child_process shim's own pump
 * calls __dshProcPoll every 4ms and the C poll DRAINS the extra channel
 * into its answer — a second poller would starve, so the siphon wraps the
 * intrinsic once at BOOT (before the shim captures it) and copies each
 * poll's extraOut[0] aside for the IPC pump to drain. */
const channelRegistry = () => {
  if (typeof globalThis.__DSH_IPC_CHANNELS__ === 'undefined') {
    globalThis.__DSH_IPC_CHANNELS__ = new Map();
  }
  return globalThis.__DSH_IPC_CHANNELS__;
};

let siphonInstalled = false;
export const installPollSiphon = () => {
  if (siphonInstalled) return true;
  const poll = globalThis.__dshProcPoll;
  if (typeof poll !== 'function') return false;
  globalThis.__dshProcPoll = (pid) => {
    const res = poll(pid);
    try {
      const chunk = res?.extraOut?.[IPC_SLOT];
      if (typeof chunk === 'string' && chunk.length > 0) {
        const entry = channelRegistry().get(pid) ?? { buffer: '', eof: false };
        entry.buffer += decodeUtf8(fromBase64(chunk));
        channelRegistry().set(pid, entry);
      }
      if (res?.extraEof?.[IPC_SLOT] === true) {
        const entry = channelRegistry().get(pid) ?? { buffer: '', eof: false };
        entry.eof = true;
        channelRegistry().set(pid, entry);
      }
    } catch { /* the siphon stays best-effort */ }
    return res;
  };
  siphonInstalled = true;
  return true;
};

const bytesToB64 = (bytes) => {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
};

/** The channel-registry entry for one pid (create-if-missing). */
const entryOf = (pid) => {
  const entry = channelRegistry().get(pid) ?? { buffer: '', eof: false };
  channelRegistry().set(pid, entry);
  return entry;
};

/** Emit every complete NDJSON frame in state.buffer as a 'message' event
 * (module level for size). Node-internal channel control frames
 * ({"cmd":"node:…"}) stay below the message surface, exactly like a
 * plain-JSON channel consumer sees; a malformed line is not a message. */
const emitIpcFrames = (child, state) => {
  let at;
  while ((at = state.buffer.indexOf('\n')) >= 0) {
    const line = state.buffer.slice(0, at);
    state.buffer = state.buffer.slice(at + 1);
    if (line.length === 0) continue;
    try {
      const frame = JSON.parse(line);
      if (frame !== null && typeof frame === 'object' && typeof frame.cmd === 'string' && frame.cmd.startsWith('node:')) continue;
      child.emit('message', frame);
    } catch { /* a malformed line is not a message */ }
  }
};

/** The channel-EOF flush: a trailing frame without a newline still delivers
 * (node's channel semantics), then 'disconnect'. */
const flushIpcEof = (child, state) => {
  if (state.buffer.trim().length > 0) {
    try { child.emit('message', JSON.parse(state.buffer)); } catch { /* partial frame dropped */ }
    state.buffer = '';
  }
  child.emit('disconnect');
};

/** The receive pump (module level for size): drain the siphoned channel
 * bytes into 'message' events; 'disconnect' follows channel EOF or child
 * exit, node's own channel lifecycle. `state.buffer` carries a partial
 * frame across pumps. */
const pumpIpc = (child, state) => {
  if (child.__done || child.exitCode !== null) {
    child.emit('disconnect');
    return;
  }
  const entry = entryOf(child.pid);
  state.buffer += entry.buffer;
  entry.buffer = '';
  emitIpcFrames(child, state);
  if (entry.eof) {
    flushIpcEof(child, state);
    return;
  }
  setTimeout(() => pumpIpc(child, state), 4);
};

/** The send face (module level for size): one JSON frame per send through
 * the fd-3+ write intrinsic; a closed channel errors the callback (or
 * throws when the caller passed none), EPIPE reports through it too. */
const wireIpcSend = (child) => {
  child.send = (message, callback) => {
    if (!child.connected || child.pid === undefined || child.pid === null) {
      const error = new Error('channel closed');
      error.code = 'ERR_IPC_CHANNEL_CLOSED';
      if (typeof callback === 'function') queueMicrotask(() => callback(error));
      else throw error;
      return false;
    }
    const frame = `${JSON.stringify(message)}\n`;
    let res;
    try {
      res = globalThis.__dshProcWriteFd(child.pid, IPC_SLOT, bytesToB64(encodeUtf8(frame)));
    } catch (error) {
      res = { error: { code: 'EPIPE' } };
    }
    const ok = !res?.error;
    if (typeof callback === 'function') queueMicrotask(() => callback(ok ? null : new Error(res?.error?.code ?? 'EPIPE')));
    return ok;
  };
};

/** Attach the IPC pump to one spawned child (the caller saw an 'ipc'
 * entry and armed NODE_CHANNEL_FD). Frames come from the siphon registry
 * (the shim's stdio pump does the polling). */
const wireIpc = (child) => {
  const state = { buffer: '' };
  setTimeout(() => pumpIpc(child, state), 4);
  child.connected = true;
  child.disconnect = () => {
    if (!child.connected) return;
    child.connected = false;
    try { globalThis.__dshProcEndFd(child.pid, IPC_SLOT); } catch { /* already gone */ }
  };
  wireIpcSend(child);
};

/** The spawn face wrap: everything without an 'ipc' entry is untouched. */
export const wrapChildProcessFace = (face) => {
  const wrapped = Object.create(face);
  wrapped.spawn = (command, args = [], options = {}) => {
    const stdio = Array.isArray(options?.stdio) ? options.stdio : undefined;
    const ipcAt = stdio?.indexOf('ipc') ?? -1;
    if (ipcAt < 0) return face.spawn(command, args, options);
    // The C seam defaults every extra (fd 3+) to a piped socketpair, so no
    // stdio rewrite is needed — only the channel-boot env for real node.
    const child = face.spawn(command, args, {
      ...options,
      env: { ...(options.env ?? {}), NODE_CHANNEL_FD: IPC_CHANNEL_FD },
    });
    wireIpc(child);
    return child;
  };
  return wrapped;
};
