// dsh:logging-exempt (shim layer)
/**
 * node:process shim — the process facade over the profile container.
 *
 * Covers (upstream usage → this module):
 *   - boot.js/system slices reading `process.env`, `process.cwd`,
 *     `process.nextTick`, `process.platform`. The web-shims prelude installs
 *     the same object as the `process` GLOBAL (module-load-time references
 *     see it regardless of import style).
 *
 * Platform honesty: cwd() is the PROFILE CONTAINER root (the $DSH_HOME /
 * process.cwd() equivalents collapse into one host-granted directory on
 * mobile); env is the boot-provided immutable launch snapshot, not the
 * device environment. nextTick rides the promise queue (serial runtime).
 *
 * Intentionally NOT supported: exit() (a surface never kills the runtime;
 * boot reports the requested code to the host), signals, stdio streams
 * (logs ride __DSH_LOG_SINK__), process.binding/ffi anything.
 */
const launch = () => globalThis.__dshProfileLaunch ?? {};

const failNoContainer = (what) => {
  throw new Error(`process.${what}: profile container not pinned — boot.js must set `
    + 'globalThis.__dshProfileCwd before use');
};

export const env = new Proxy({}, {
  get: (_target, key) => launch()[key],
  has: (_target, key) => key in launch(),
  ownKeys: () => Reflect.ownKeys(launch()),
  getOwnPropertyDescriptor: (_t, key) => {
    if (key in launch()) return { configurable: true, enumerable: true, value: launch()[key] };
    return undefined;
  },
});

export const argv = () => globalThis.__dshProfileArgv ?? [];
export const cwd = () => {
  const pinned = globalThis.__dshProfileCwd;
  if (typeof pinned !== 'string' || pinned.length === 0) failNoContainer('cwd');
  return pinned;
};
export const platform = () => globalThis.__dshProfilePlatform ?? 'mobile';
export const nextTick = (fn, ...args) => {
  if (typeof fn !== 'function') throw new TypeError('process.nextTick requires a function');
  return globalThis.queueMicrotask(() => fn(...args));
};
export const version = () => globalThis.__dshEngineInfo?.().version ?? 'unknown';

const proc = {
  get env() { return env; },
  get argv() { return argv(); },
  get platform() { return platform(); },
  get version() { return version(); },
  cwd,
  nextTick,
};

export default proc;
