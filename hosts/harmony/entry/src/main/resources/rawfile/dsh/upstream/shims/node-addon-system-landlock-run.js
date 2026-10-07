// dsh:logging-exempt (host shim: no side effects to log)
/**
 * @deepseek-ai/node-addon-system/landlock-run — the JS API over the prebuilt
 * `landlock-run` launcher (native/system/packages/entry/src/index.ts at the
 * pinned tag), ported to the runtime's seams. The launcher BINARY is a
 * per-platform native artifact (@deepseek-ai/node-addon-system-<platform>-
 * <arch>, exec'd through spawnSync) — no socket, but a real subprocess (D2)
 * and Linux-only (Landlock LSM), so the runtime mounts the API with the
 * source's own absence semantics: `launcherPath()` takes the source's
 * unresolvable-platform fallback ("nonexistent exactly when the package is
 * absent") and `probe()` classifies a missing binary as `unusable` without
 * spawning — the source's own contract ("a missing binary probes `unusable`
 * the same way an unenforcing kernel does"). `grantArgs` is pure and served
 * verbatim. No vendored byte is edited (D6); the consumers (bash-sandbox,
 * sandbox-local, spill-policy) read the same constants and build the same
 * argv they would on a Linux host, and every probe answers `unusable`.
 */

/** The launcher binary's file name inside each platform package's `bin/`. */
export const LAUNCHER_BIN = 'landlock-run';

/**
 * The exit code for every launcher-level failure (usage error, unenforcing
 * kernel, unopenable grant root, failed exec) — part of the CLI contract.
 */
export const LAUNCHER_FAILURE_EXIT = 125;

/**
 * Path of the launcher binary for this host: the platform package never
 * resolves in this runtime (no npm platform packages are vendored), so this
 * is the source's own fallback spelling — absolute, package-boundary-bound,
 * and nonexistent. Existence is deliberately not checked here either: the
 * source's contract makes `probe` the single availability signal.
 */
export function launcherPath() {
  const platformPackage = `@deepseek-ai/node-addon-system-${process.platform}-${process.arch}`;
  return `/vendor/npm/${platformPackage}/node_modules/${platformPackage}/bin/${LAUNCHER_BIN}`;
}

/**
 * The launcher grant arguments for one set of filesystem grants — everything
 * before the `--` argv separator. A caller spawns
 * `[launcherPath(), ...grantArgs(grants), '--', ...command]`; read-only
 * roots first, in the caller's order. Pure — ported verbatim.
 */
export function grantArgs(grants) {
  return [
    ...(grants.readOnly ?? []).flatMap((root) => ['--ro', root]),
    ...(grants.readWrite ?? []).flatMap((root) => ['--rw', root]),
  ];
}

/**
 * Functional probe, classified against this host: the launcher binary does
 * not exist here (no platform package), and the source's contract maps a
 * missing binary to `unusable` — without the spawn the native launcher would
 * need (D2: no subprocess seam; Landlock is a Linux LSM this runtime never
 * enforces). Synchronous, like the source's.
 */
export function probe() {
  return 'unusable';
}

export default { LAUNCHER_BIN, LAUNCHER_FAILURE_EXIT, launcherPath, grantArgs, probe };
