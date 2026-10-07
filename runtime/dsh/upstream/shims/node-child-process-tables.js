// dsh:logging-exempt (host shim: no side effects to log)
/**
 * shims/node-child-process-tables.js — the pure-data half of the
 * node:child_process shim, split out of node-child-process.js when that file
 * crossed the code-size budget (W9). One-way dependency: this module imports
 * ONLY from buffer.js — it never imports node-child-process.js (a static
 * shim→shim cycle kills QuickJS at link); the original imports these names
 * back and re-exports them so every existing specifier keeps working.
 *
 * Contents: the per-platform signal tables + signalName (the C host reports
 * raw WTERMSIG numbers), the b64 encoding helpers, node's stdio
 * normalization (+ CHILD_EXTRA_FDS for fds 3..7), the spawn-failure error
 * face, the profile-anchored cwd resolution, and the child-output
 * /private-prefix re-spelling.
 */
import { Buffer, encodeUtf8 } from './buffer.js';

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

export {
  CHILD_EXTRA_FDS,
  SIGNALS_DARWIN,
  SIGNALS_LINUX,
  bytesToB64,
  normalizeStdio,
  replaceBytePrefixAll,
  signalName,
  signalTable,
  spawnCwd,
  spawnError,
  toB64,
  translateChildBytes,
};
