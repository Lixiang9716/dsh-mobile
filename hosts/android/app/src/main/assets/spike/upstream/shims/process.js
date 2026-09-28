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

/** Runtime env WRITES land here (on the global — the multi-instance rule:
 * module state would fork). Reads check the overlay first, then the launch
 * snapshot; `delete process.env.X` removes the overlay entry. Measured
 * 2026-09-27: the agent-presets user-root suite repoints $DSH_HOME per test
 * (`process.env.DSH_HOME = home`), and vitest's stubEnv does the same — with
 * the old read-only proxy those writes vanished and the derived home root
 * never resolved to the test's temp home. */
const envOverlay = () => {
  if (typeof globalThis.__dshProfileEnvOverlay === 'undefined'
      || globalThis.__dshProfileEnvOverlay === null) {
    globalThis.__dshProfileEnvOverlay = {};
  }
  return globalThis.__dshProfileEnvOverlay;
};

const failNoContainer = (what) => {
  throw new Error(`process.${what}: profile container not pinned — boot.js must set `
    + 'globalThis.__dshProfileCwd before use');
};

export const env = new Proxy({}, {
  get: (_target, key) => {
    const overlay = envOverlay();
    if (Object.prototype.hasOwnProperty.call(overlay, key)) return overlay[key];
    if (key === 'PATH' && launch().PATH === undefined) {
      // The conventional container default: the boot prelude usually pins the
      // launch snapshot (which carries PATH); the suite legs do not, and the
      // subprocess scrub contract KEEPS PATH — report the standard system
      // default rather than an empty variable.
      return '/usr/local/bin:/usr/bin:/bin';
    }
    return launch()[key];
  },
  has: (_target, key) => key in envOverlay() || key in launch()
    || (key === 'PATH' && launch().PATH === undefined),
  // PATH participates in ENUMERATION too (Object.entries(process.env) — the
  // subprocess scrub walks the entries) even when the launch snapshot omits it.
  ownKeys: () => {
    const keys = new Set([...Reflect.ownKeys(envOverlay()), ...Reflect.ownKeys(launch())]);
    if (!keys.has('PATH')) keys.add('PATH');
    return [...keys];
  },
  getOwnPropertyDescriptor: (_t, key) => {
    const overlay = envOverlay();
    if (Object.prototype.hasOwnProperty.call(overlay, key)) {
      return { configurable: true, enumerable: true, value: overlay[key] };
    }
    if (key in launch()) return { configurable: true, enumerable: true, value: launch()[key] };
    if (key === 'PATH' && launch().PATH === undefined) {
      return { configurable: true, enumerable: true, value: '/usr/local/bin:/usr/bin:/bin' };
    }
    return undefined;
  },
  set: (_target, key, value) => {
    envOverlay()[key] = value;
    return true;
  },
  deleteProperty: (_target, key) => {
    delete envOverlay()[key];
    return true;
  },
});

export const argv = () => globalThis.__dshProfileArgv ?? [];
export const cwd = () => {
  const pinned = globalThis.__dshProfileCwd;
  if (typeof pinned !== 'string' || pinned.length === 0) failNoContainer('cwd');
  return pinned;
};
/** chdir(dir) — repins the profile cwd on the global (the same store cwd()
 * reads; the multi-instance rule puts the pin on globalThis, not module
 * state). Relative-path resolution rides cwd() everywhere, so a chdir is
 * observable exactly like node's. The suite's path-diff spec brackets its
 * cases with chdir("/") to make relative joins deterministic. Non-absolute
 * targets resolve against the CURRENT cwd (node's shape). */
export const chdir = (dir) => {
  if (typeof dir !== 'string') {
    throw new TypeError(`process.chdir: string required (got ${typeof dir})`);
  }
  let target = dir;
  if (!target.startsWith('/')) {
    const base = globalThis.__dshProfileCwd ?? '/';
    target = `${base.replace(/\/$/, '')}/${target}`;
  }
  const out = [];
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  globalThis.__dshProfileCwd = `/${out.join('/')}`;
  return undefined;
};
export const platform = () => globalThis.__dshProfilePlatform ?? 'mobile';
/** execPath: node reports the running node binary; this runtime's host
 * process is the spike engine, whose path is not exported to JS. The name is
 * the honest face — a non-empty string so consumers that RECORD it (lsp
 * config validation treats `command: process.execPath` as provided) see a
 * value, while any attempt to EXECUTE it hits the no-subprocess seam. The
 * spelling is ABSOLUTE (R3-G1, 2026-09-28): node's execPath is always
 * absolute and the acp bridge validates `isAbsolute(server.command)` with it
 * — the bare 'dsh' default failed that gate for the whole acp mcp family. */
export const execPath = () => globalThis.__dshProfileExecPath ?? '/usr/local/bin/dsh-spike-cli';
/** uid/gid faces: the runtime is single-user — ONE identity owns everything
 * (the spill/settings POSIX safety checks compare stat.uid against
 * process.geteuid() to detect foreign-owned directories; a single-user
 * runtime reports a fixed identity on both sides, so ownership always
 * matches and only the MODE bits can mark a directory unsafe — exactly the
 * property the VFS can model honestly). */
export const getuid = () => globalThis.__dshProfileUid ?? 0;
export const geteuid = () => getuid();
export const getgid = () => globalThis.__dshProfileGid ?? 0;
export const getegid = () => getgid();
export const nextTick = (fn, ...args) => {
  if (typeof fn !== 'function') throw new TypeError('process.nextTick requires a function');
  return globalThis.queueMicrotask(() => fn(...args));
};
export const version = () => globalThis.__dshEngineInfo?.().version ?? 'unknown';

// pid: ONE runtime process by construction (ARCHITECTURE.md §6 — a single
// serial JS thread; there is no OS process per agent). Vendored temp-name
// builders (fs-local's staging directory) mix pid into names only for
// uniqueness, and the single runtime's identity is unique by definition.
export const pid = 1;

// versions.node: packages probe the NODE major to pick runtime-specific
// internals (cordis-plugin-loader's fromInternal: >= 22 tries Node's internal
// ESM loader). This runtime is NOT node, and the honest answer is a major
// below that gate: the caller takes its documented no-internals path — no
// pretense, no crash.
const versions = { node: '20.0.0' };

const execArgv = []; // no node CLI flags exist here (loader probes read it)

/* The exit-event face: the vendored output collector registers
 * `process.once("exit", ...)` at module top (the spill-dir sweep), so the
 * listener registry must exist and accept registrations. Nothing fires it —
 * the runtime has no shutdown seam (the timers-class gap) — a spill dir
 * simply lives until the profile container goes away, which is the honest
 * in-memory behavior. */
const exitListeners = [];

const proc = {
  get env() { return env; },
  get argv() { return argv(); },
  get execArgv() { return execArgv; },
  get platform() { return platform(); },
  get execPath() { return execPath(); },
  getuid,
  geteuid,
  getgid,
  getegid,
  get pid() { return pid; },
  get version() { return version(); },
  get versions() { return versions; },
  cwd,
  chdir,
  nextTick,
  on(event, fn) {
    if (event === 'exit' && typeof fn === 'function') exitListeners.push(fn);
    return proc;
  },
  once(event, fn) {
    if (event === 'exit' && typeof fn === 'function') {
      const wrapped = () => {
        const at = exitListeners.indexOf(wrapped);
        if (at >= 0) exitListeners.splice(at, 1);
        fn();
      };
      exitListeners.push(wrapped);
    }
    return proc;
  },
  /* prependListener/prependOnceListener: cordis plugin setup registers the
   * host-exit hook through them (subprocess-local's LocalSubprocessRuntime
   * ctx.effect — measured 2026-09-27, "not a function" for the whole
   * shell/lsp family). Node orders prepended listeners FIRST; the exit
   * registry never fires here, so relative order is inert — keep the honest
   * shape anyway. */
  prependListener(event, fn) {
    if (event === 'exit' && typeof fn === 'function') exitListeners.unshift(fn);
    return proc;
  },
  prependOnceListener(event, fn) {
    if (event === 'exit' && typeof fn === 'function') {
      const wrapped = () => {
        const at = exitListeners.indexOf(wrapped);
        if (at >= 0) exitListeners.splice(at, 1);
        fn();
      };
      wrapped.listener = fn;
      exitListeners.unshift(wrapped);
    }
    return proc;
  },
  listeners(event) { return event === 'exit' ? [...exitListeners] : []; },
  rawListeners(event) { return event === 'exit' ? [...exitListeners] : []; },
  off(event, fn) {
    if (event !== 'exit') return proc;
    const at = exitListeners.findIndex((entry) => entry === fn || entry?.listener === fn);
    if (at >= 0) exitListeners.splice(at, 1);
    return proc;
  },
  removeListener(event, fn) { return proc.off(event, fn); },
  emit(event, code) {
    if (event !== 'exit') return false;
    for (const listener of [...exitListeners]) listener(code);
    return true;
  },
  listenerCount(event) { return event === 'exit' ? exitListeners.length : 0; },
  exitCode: undefined,
  /* stdout/stderr: the inherit-stdio legs pipe into them ({end: false}); the
   * spike has no console of its own — writes drain into a no-op sink (the
   * harness's processState carries the real output capture). */
  stdout: { write: () => true, end: () => {}, destroy: () => {} },
  stderr: { write: () => true, end: () => {}, destroy: () => {} },
};

export default proc;
