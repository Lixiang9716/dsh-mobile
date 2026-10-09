#!/usr/bin/env node
// dsh:logging-exempt (node-side test vehicle: its stdout IS the product)
/**
 * fs-watch-idle-probe — the P3 TIMER-FLOOD metric, measured LOCALLY on the
 * shim layer (2026-10-09). The on-device symptom (40 idle minutes after the
 * creation-mode pomodoro boot): 126,977 timerSchedule + 17,707 timerCancel,
 * ~53 arms/s, gateway debug lines crowding out 95% of the carrier capture
 * and flushing hilog down to seconds of history. The mechanism: the
 * deployment-default preset join (T-0048) mounts the skill plane, the
 * vendored dsh-skill-filesystem opens its ANCESTOR watchFile watchers for
 * every MISSING skill root (up to 5: .dsh/skills, .agents/skills,
 * home/skills, home/agents/skills, the custom dir) at the default
 * watchPollIntervalMs=100, and shims/loader-faces-fs-watch.js implemented
 * node's watchFile as an unconditional setInterval poll — one gateway
 * timerSchedule round trip per tick per watcher, forever, while the watched
 * directory fingerprints can never even move (the workspace VFS stats every
 * directory with mtimeMs 0).
 *
 * What this probe measures (the reproducible metric, no device needed):
 *
 *   idleArms  timerSchedule arms tagged shim:setTimeout during a 3s IDLE
 *             window with three 100ms watchFile watchers registered — the
 *             same registration shape as the device boot. Pre-fix ~90
 *             (3 watchers x 10 ticks/s); event-driven watchFile drops it
 *             by an order of magnitude (the slow safety-net poll does not
 *             tick inside the window).
 *   file transitions detected through the watched FILE's four stat
 *             transitions (missing -> created -> changed -> removed), each
 *             bounded at 2s like the upstream differential spec.
 *   dir-heard whether mkdir of the watched PATH ITSELF reaches the
 *             watcher (the wsWatch notify gap: a created directory IS a
 *             mutation).
 *
 * The probe loads the REAL shims — timers.js (the gateway timer mapping),
 * fs-workspace.js (the VFS + the mutation registry), fs-workspace-write.js
 * (the mutating arms) and loader-faces-fs-watch.js (the module under
 * measurement) — over a counting fake gateway (ci/fs-watch-idle-gateway.mjs)
 * through the redirect hooks (ci/fs-watch-idle-hooks.mjs). What it does NOT
 * cover: the quickjs engine, the C host dispatch, the full boot — the
 * device-level count stays with the on-device legs.
 *
 * usage: node ci/fs-watch-idle-probe.mjs [--json]
 *   env: DSH_FS_WATCH_TREE=<runtime/dsh root> (default: this tree)
 */
import { register } from 'node:module';

register('./fs-watch-idle-hooks.mjs', import.meta.url);

const JSON_OUT = process.argv.includes('--json');
const log = (line) => { if (!JSON_OUT) console.log(line); };

// Node's own sleep (the globals get replaced by the timers shim below).
const nodeSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const gateway = await import('./fs-watch-idle-gateway.mjs');
// The C host's ALS intrinsics (async-hooks.js reads them at arm time) —
// a no-op store stands in: the probe asserts arm COUNTS and stat
// transitions, not context propagation.
globalThis.__asyncContextGet ??= () => undefined;
globalThis.__asyncContextSet ??= () => {};
// The REAL timer globals, mapped onto the counting gateway — the exact
// mapping the device runtime runs (upstream/shims/timers.js).
await import('upstream/shims/timers.js');
// fs.js FIRST: it sits on the fs-stat↔fs.js re-export cycle, and Node
// evaluates the cycle TDZ-free only when fs-stat finishes inside fs.js's
// own first pass (quickjs links the same cycle in that order natively).
await import('upstream/shims/fs.js');
const { mountWorkspace, wsWatch } = await import('upstream/shims/fs-workspace.js');
const { wsMkdir, wsWriteFile, wsRm } = await import('upstream/shims/fs-workspace-write.js');
const { watchFile, unwatchFile } = await import('upstream/shims/loader-faces-fs-watch.js');

const ROOT = '/probe-ws';

const fail = (message) => {
  console.error(`fs-watch-idle-probe: FAIL ${message}`);
  process.exit(1);
};

/** One watcher's stat transitions: {currentExists, previousExists, currentSize,
 * previousSize} per fire — the differential spec's StatTransition shape. */
const collectTransitions = (path, interval) => {
  const transitions = [];
  const waiters = [];
  const listener = (current, previous) => {
    const transition = {
      currentExists: current.isFile(),
      previousExists: previous.isFile(),
      currentSize: current.size,
      previousSize: previous.size,
    };
    const resolve = waiters.shift();
    if (resolve === undefined) transitions.push(transition);
    else resolve(transition);
  };
  watchFile(path, { interval, persistent: false }, listener);
  return {
    next: (boundMs = 2000) => {
      const queued = transitions.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out after ${boundMs}ms`)), boundMs);
        waiters.push((value) => { clearTimeout(timer); resolve(value); });
      });
    },
    done: () => unwatchFile(path, listener),
  };
};

/** The idle-window metric: N 100ms watchers parked for 3s, then the
 * gateway's arm counters — the flood gauge. */
const measureIdleWindow = async () => {
  const ancestors = [ROOT, `${ROOT}/home`, `${ROOT}/home/agents`];
  const idleWatchers = ancestors.map((path) => collectTransitions(path, 100));
  await nodeSleep(80); // drain the initial first-poll ticks
  const before = gateway.__probeCounters();
  await nodeSleep(3000); // the IDLE window
  const after = gateway.__probeCounters();
  for (const watcher of idleWatchers) watcher.done();
  return { idleArms: after.schedule - before.schedule, idleCancels: after.cancel - before.cancel };
};

/** The watched-file transition contract — the differential spec's
 * watchFileScenario shape: missing -> created -> changed -> removed. */
const collectFileTransitions = async () => {
  const file = `${ROOT}/watched.txt`;
  const fileWatcher = collectTransitions(file, 100);
  const missing = await fileWatcher.next();
  wsWriteFile(file, 'a');
  const created = await fileWatcher.next();
  wsWriteFile(file, 'longer');
  const changed = await fileWatcher.next();
  wsRm(file);
  const removed = await fileWatcher.next();
  fileWatcher.done();
  return [missing, created, changed, removed];
};

/** The mkdir-of-the-watched-path event (the wsWatch notify gap). */
const probeDirMkdir = async () => {
  const dir = `${ROOT}/made-dir`;
  let dirHeard = false;
  const dirUnwatch = wsWatch(dir, () => { dirHeard = true; });
  wsMkdir(dir, { recursive: true });
  await nodeSleep(50);
  dirUnwatch();
  wsRm(dir, { recursive: true });
  return dirHeard;
};

const main = async () => {
  mountWorkspace(ROOT);
  // The device shape: the workspace root, its home, and home/agents exist;
  // the skill roots under them are missing (ancestor watchFile targets).
  wsMkdir(`${ROOT}/home`, { recursive: true });
  wsMkdir(`${ROOT}/home/agents`, { recursive: true });

  const { idleArms, idleCancels } = await measureIdleWindow();
  const transitions = await collectFileTransitions();
  const dirHeard = await probeDirMkdir();

  const [missing, created, changed, removed] = transitions;
  const transitionsOk = !missing.currentExists && !missing.previousExists
    && created.currentExists && !created.previousExists && created.currentSize === 1
    && changed.currentExists && changed.previousExists && changed.currentSize === 6
    && !removed.currentExists && removed.previousExists;

  const result = {
    idleWindowMs: 3000,
    watchers: 3,
    intervalMs: 100,
    idleArms,
    idleCancels,
    idleArmsPerSecond: Number((idleArms / 3).toFixed(2)),
    transitions,
    transitionsOk,
    dirHeard,
  };
  log(`fs-watch-idle-probe: idle ${result.idleWindowMs}ms with ${result.watchers} watchFile(100ms) watchers`);
  log(`  timerSchedule arms: ${result.idleArms} (${result.idleArmsPerSecond}/s)  timerCancel: ${result.idleCancels}`);
  log(`  file transitions detected: ${transitionsOk ? 'yes (missing->created->changed->removed)' : 'NO'}`);
  log(`  wsWatch heard mkdir of the watched path: ${dirHeard ? 'yes' : 'no'}`);
  if (JSON_OUT) console.log(`PROBE_RESULT ${JSON.stringify(result)}`);

  // The regression bound: an order of magnitude under the pre-fix ~90 arms
  // (30/s x 3s). Event-driven watchers arm the slow safety net (5s) only —
  // zero-to-few arms inside a 3s window. Legacy poll paths (non-workspace
  // paths) are not exercised here and keep the caller's interval verbatim.
  if (idleArms > 9) fail(`idle arms ${idleArms} > 9 — the watchFile poll is flooding the timer seam again`);
  if (!transitionsOk) fail('the watched-file stat transitions broke');
  if (!dirHeard) fail('wsWatch never heard mkdir of the watched path');
  log('fs-watch-idle-probe: PASS');
};

main().catch((error) => fail(error?.stack ?? String(error)));
