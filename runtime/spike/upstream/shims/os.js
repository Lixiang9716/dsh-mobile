// dsh:logging-exempt (shim layer)
/**
 * node:os shim — the profile-container view of the platform.
 *
 * Covers (upstream usage → this module):
 *   - dsh-sandbox (`tmpdir`) — the local sandbox's default temp root.
 *   - subprocess-local (`constants`, `devNull`, `tmpdir`, `userInfo`) — the
 *     spawn argument builders (2026-09-27 suite round).
 *   - native-command (`release`) — the WSL probe (`.includes("microsoft")`).
 *
 * Platform honesty: `$DSH_HOME`/os.tmpdir() do not exist on a phone; the
 * equivalent boundary is the host-granted profile container. boot.js pins
 * `globalThis.__dshProfileTmpdir` from the host-provided container (CLI: a
 * fresh directory per run); until it is pinned, tmpdir() falls back to the
 * cwd-relative tmp the fs shim serves.
 *
 * Intentionally NOT supported: cpus/loadavg/freememory-style host probes
 * (absent — loud link errors); networkInterfaces (gateway's business).
 */
import { DshBuffer, encodeUtf8 } from 'upstream/shims/buffer.js';
import { UV_ERRNO } from 'upstream/shims/util.js';

export const tmpdir = () => {
  const pinned = globalThis.__dshProfileTmpdir;
  if (typeof pinned === 'string' && pinned.length > 0) return pinned;
  // Un-pinned callers (the suite's direct imports, which skip the boot
  // prelude) fall back to the cwd-relative tmp the fs shim serves — the
  // profile-container default, kept honest instead of throwing at callers
  // that never see the prelude.
  const cwd = globalThis.__dshProfileCwd;
  if (typeof cwd === 'string' && cwd.length > 0) {
    return cwd.replace(/\/$/, '') + '/tmp';
  }
  throw new Error('node:os.tmpdir(): no profile container pinned');
};

export const homedir = () => {
  const pinned = globalThis.__dshProfileHome;
  if (typeof pinned !== 'string' || pinned.length === 0) {
    throw new Error(
      'node:os.homedir(): profile home not pinned — boot.js must set '
      + 'globalThis.__dshProfileHome ($DSH_HOME equivalent) from the '
      + 'host-granted container');
  }
  return pinned;
};

export const platform = () => globalThis.__dshProfilePlatform ?? 'mobile';
export const EOL = '\n';
export const arch = () => 'wasm';
export const endianness = () => 'LE';
/** release() — kernel version string. There is no kernel here; the constant
 * is a non-Windows, non-WSL answer (the vendored native-command reads it only
 * to test `.includes("microsoft")` for its WSL branch). */
export const release = () => globalThis.__dshProfileOsRelease ?? 'dsh-spike 1.0';
export const type = () => 'dsh';
export const hostname = () => globalThis.__dshProfileHostname ?? 'localhost';
/** devNull — the POSIX spelling; the vendored spawn argument builders pass
 * it where node's constant goes. */
export const devNull = '/dev/null';
/** userInfo(options) — the identity the runtime actually runs as. There is
 * no uid/gid on this host (a -1 is node's documented Windows sentinel for
 * "not applicable"); the shell answer mirrors the env lookup the vendored
 * subprocess-local does before calling us, so it is only reached when SHELL
 * is unset — and then honestly empty. */
export const userInfo = (options = {}) => {
  const encoding = typeof options === 'string' ? options : options?.encoding;
  if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'buffer') {
    throw new Error(`node:os.userInfo: encoding '${encoding}' — supported: utf8, buffer`);
  }
  const asBuffer = (value) => (encoding === 'buffer' && value !== undefined ? DshBuffer.fromBytes(encodeUtf8(value)) : value);
  return {
    username: asBuffer(globalThis.process?.env?.USER ?? 'dsh'),
    uid: -1,
    gid: -1,
    shell: asBuffer(globalThis.process?.env?.SHELL),
    homedir: asBuffer((() => { try { return homedir(); } catch { return undefined; } })()),
  };
};
/** constants — node's errno / signals / priority families. The errno numbers
 * derive from util.js's UV_ERRNO table (one table, both faces — node:util's
 * getSystemErrorName answers with the same numbers); signals/priority are
 * node's own values (what an exit-status decoder compares against). */
const uvErrno = {};
for (const [name, entry] of Object.entries(UV_ERRNO)) uvErrno[name] = entry[0];

export const constants = Object.freeze({
  UV_FS_O_FILEMAP: 0,
  errno: Object.freeze(uvErrno),
  signals: Object.freeze({
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6,
    SIGIOT: 6, SIGBUS: 10, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 30, SIGSEGV: 11,
    SIGUSR2: 31, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 20,
    SIGCONT: 19, SIGSTOP: 17, SIGTSTP: 18, SIGTTIN: 21, SIGTTOU: 22,
    SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25, SIGVTALRM: 26, SIGPROF: 27,
    SIGWINCH: 28, SIGIO: 29, SIGINFO: 29, SIGSYS: 12,
  }),
  priority: Object.freeze({
    PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0,
    PRIORITY_ABOVE_NORMAL: -10, PRIORITY_HIGH: -20, PRIORITY_HIGHEST: -20,
  }),
});
