// dsh:logging-exempt (shim layer)
/**
 * node:os shim — the profile-container view of the platform.
 *
 * Covers (upstream usage → this module):
 *   - dsh-sandbox (`tmpdir`) — the local sandbox's default temp root.
 *
 * Platform honesty: `$DSH_HOME`/os.tmpdir() do not exist on a phone; the
 * equivalent boundary is the host-granted profile container. boot.js pins
 * `globalThis.__dshProfileTmpdir` from the host-provided container (CLI: a
 * fresh directory per run); until it is pinned, tmpdir() fails loud rather
 * than inventing a path.
 *
 * Intentionally NOT supported: cpus/loadavg/freememory-style host probes
 * (absent — loud link errors); networkInterfaces (gateway's business).
 */
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
