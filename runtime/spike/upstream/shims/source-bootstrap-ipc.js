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

/** Attach the IPC pump to one spawned child (the caller saw an 'ipc'
 * entry and armed NODE_CHANNEL_FD). Frames come from the siphon registry
 * (the shim's stdio pump does the polling); 'disconnect' follows channel
 * EOF or child exit, node's own channel lifecycle. */
const wireIpc = (child) => {
  let buffer = '';
  const entryOf = () => {
    const entry = channelRegistry().get(child.pid) ?? { buffer: '', eof: false };
    channelRegistry().set(child.pid, entry);
    return entry;
  };
  const pump = () => {
    if (child.__done || child.exitCode !== null) {
      child.emit('disconnect');
      return;
    }
    const entry = entryOf();
    buffer += entry.buffer;
    entry.buffer = '';
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.length === 0) continue;
      try {
        const frame = JSON.parse(line);
        // Node-internal channel control ({"cmd":"node:…"}) stays below the
        // message surface, exactly like a plain-JSON channel consumer sees.
        if (frame !== null && typeof frame === 'object' && typeof frame.cmd === 'string' && frame.cmd.startsWith('node:')) continue;
        child.emit('message', frame);
      } catch { /* a malformed line is not a message */ }
    }
    if (entry.eof) {
      if (buffer.trim().length > 0) {
        try { child.emit('message', JSON.parse(buffer)); } catch { /* partial frame dropped */ }
        buffer = '';
      }
      child.emit('disconnect');
      return;
    }
    setTimeout(pump, 4);
  };
  setTimeout(pump, 4);
  child.connected = true;
  child.disconnect = () => {
    if (!child.connected) return;
    child.connected = false;
    try { globalThis.__dshProcEndFd(child.pid, IPC_SLOT); } catch { /* already gone */ }
  };
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
