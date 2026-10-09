// dsh:logging-exempt (shim layer)
/**
 * shims/loader-faces-fs-watch.js — the node:fs STAT-WATCHER face
 * (watchFile/unwatchFile) the vendored closure imports at link time:
 * @deepseek-ai/dsh-skill-filesystem@0.1.6-alpha.2/lib/index.js
 * (`import { unwatchFile, watchFile } from "node:fs"`, its ancestor
 * poll-watcher) and the webworker-runtime fs-watch-stream spec (which diffs
 * ITS OWN StatWatcher against the native faces it imports as
 * watchFile-as/unwatchFile-as). Without the exports the modules fail the
 * LINK ("Could not find export 'unwatchFile' in module 'node:fs'") — a
 * loader-face gap, not a watch seam.
 *
 * CHANGE DETECTION (P3, 2026-10-09): a write IS the event — D8. For a
 * path inside the writable workspace the mutation registry
 * (fs-workspace's wsWatch — the same seam the chokidar linkage shim rides)
 * re-stats and fires on every VFS mutation of the watched path, and the
 * wall-clock poll degrades to a slow SAFETY NET (max(interval, 5s)) whose
 * only job is mutations the registry cannot see: out-of-band real-disk
 * writes by child processes (statSync's real-disk fallback observes them;
 * the registry does not). The unconditional caller-interval poll this
 * file used before was the P3 timer flood's feed: every tick is one
 * gateway timerSchedule round trip through the timers shim, the
 * deployment-default preset join (T-0048) mounts the skill plane, and the
 * vendored skill-filesystem opens one ancestor watchFile per MISSING
 * skill root at watchPollIntervalMs=100 — measured on device 2026-10-09,
 * 40 idle minutes: 126,977 timerSchedule + 17,707 timerCancel (~53/s,
 * gateway debug lines 95% of the carrier capture, hilog history flushed
 * to seconds); measured on the node-side probe (ci/fs-watch-idle-probe.mjs)
 * at the same registration shape: 28.3 arms/s for three 100ms watchers,
 * detecting nothing the whole time (workspace VFS directories stat with
 * mtimeMs 0, so an ancestor directory's fingerprint NEVER moves — the
 * poll could not even fire). A path OUTSIDE the workspace (the seeded
 * test worlds, real-disk faces) keeps the caller's interval verbatim:
 * there is no registry over those worlds, and the differential spec's
 * cadence must stay node's.
 *
 * Semantics are node's statWatchers contract, read off the spec's own
 * differential harness (upstream-tests/...fs-watch-stream.spec.mjs
 * watchFileScenario):
 *   - watchFile(path, {interval, persistent}, listener) — one SHARED
 *     StatWatcher per path; each listener registered with .on('change').
 *     The first stat check runs on the initial tick and the listener fires
 *     immediately with (current, previous) where previous === current
 *     (node's first-poll shape — the spec's first transition reads
 *     currentExists:false AND previousExists:false for a missing file).
 *   - Subsequent checks fire only when the stat fingerprint (size +
 *     mtimeMs) moved; a vanished file reports the zeroed Stats shape
 *     (every predicate false, size 0) exactly like the spec's expected
 *     removed-transition (currentExists:false, previousExists:true,
 *     currentSize:0).
 *   - unwatchFile(path[, listener]) removes the named listener (or all);
 *     the watch (events AND safety net) stops and the watcher leaves the
 *     registry when its last listener goes (the shared-watcher test
 *     asserts the sibling listener keeps firing afterwards, then that
 *     unwatchFile(path) ends everything).
 *
 * The Stats objects passed to listeners carry the FULL predicate set the
 * differential harness reads (isFile/isDirectory/isSymbolicLink/isFIFO/
 * isSocket/isBlockDevice/isCharacterDevice + size/mtimeMs) — the workspace
 * statFace carries only the first three, so this file builds its own face
 * over statSync rather than reusing it.
 */
import { statSync } from 'upstream/shims/fs-stat.js';
import { EventEmitter } from 'upstream/shims/events.js';
import { wsAt, wsWatch } from 'upstream/shims/fs-workspace.js';

/** The evented watcher's safety-net cadence: the registry misses only
 * out-of-band real-disk mutations (child processes writing straight to
 * the container), and no watchFile consumer needs those inside 100ms —
 * the vendored ancestor watcher's response is a skill re-discovery. */
const EVENTED_NET_POLL_MS = 5000;

/** A zeroed Stats face (node's stat-of-a-missing-file shape): every type
 * predicate false, sizes/times 0. */
const zeroedStats = () => Object.assign(Object.create({
  isFile: () => false,
  isDirectory: () => false,
  isSymbolicLink: () => false,
  isFIFO: () => false,
  isSocket: () => false,
  isBlockDevice: () => false,
  isCharacterDevice: () => false,
}), { size: 0, mtimeMs: 0 });

/** Augment one statSync result with the predicate surface the poll face
 * hands its listeners (the workspace statFace carries only
 * file/dir/symlink). Non-object results (defensive) fall to zeroed. */
const fullStats = (stats) => {
  if (stats === undefined || stats === null || typeof stats !== 'object') return zeroedStats();
  return Object.assign(Object.create({
    isFile: () => stats.isFile(),
    isDirectory: () => stats.isDirectory(),
    isSymbolicLink: () => stats.isSymbolicLink(),
    isFIFO: () => false,
    isSocket: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
  }), stats);
};

/** The stat fingerprint a tick compares (existence + size + mtime). */
const fingerprint = (stats) => `${stats.isFile() ? 1 : 0}:${stats.size}:${stats.mtimeMs}`;

/** One shared per-path watcher. Extends EventEmitter so listeners ride
 * .on('change') and unwatchFile rides removeListener — the exact surface
 * node's internal statWatchers share with this face. Inside the workspace
 * the change detector is the mutation registry (a write IS the event) and
 * the wall-clock loop is the slow safety net; outside it, the caller's
 * interval polls verbatim (see the file header). */
class StatWatcher extends EventEmitter {
  constructor(path, interval) {
    super();
    this.path = path;
    this.interval = Math.max(1, Number(interval) || 5000);
    this.previous = undefined;
    this.stopped = false;
    this.unwatchEvents = null;
    let pollMs = this.interval;
    const at = wsAt(path);
    if (at !== null) {
      // Event-driven (D8): the registry's notify re-stats synchronously
      // inside the mutation — a listener sees the change the same tick
      // the write lands, faster than any poll could.
      this.unwatchEvents = wsWatch(at.path, () => this.#tick(false));
      pollMs = Math.max(this.interval, EVENTED_NET_POLL_MS);
    }
    // The initial check rides a 0-delay timer (not synchronous): the spec
    // registers the watcher then awaits the first event, so ordering is
    // preserved while registration stays reentrancy-free.
    this.timer = setTimeout(() => this.#tick(true), 0);
    this.looper = setInterval(() => this.#tick(false), pollMs);
  }
  #tick(initial) {
    if (this.stopped) return;
    let current;
    try {
      current = fullStats(statSync(this.path));
    } catch {
      current = zeroedStats();
    }
    if (this.previous === undefined) {
      // First-poll shape: previous === current (node fires the listener on
      // the initial stat with no delta).
      this.previous = current;
      this.#emit(current);
      return;
    }
    if (!initial && fingerprint(current) === fingerprint(this.previous)) return;
    const previous = this.previous;
    this.previous = current;
    this.#emit(current, previous);
  }
  #emit(current, previous) {
    this.emit('change', current, previous === undefined ? current : previous);
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.looper);
    this.unwatchEvents?.();
    this.unwatchEvents = null;
    this.emit('stop');
  }
}

/** path → the shared StatWatcher (the spec's shared-watcher assertion:
 * watchFile twice for one path returns the SAME watcher object). */
const statWatchers = new Map();

export const watchFile = (path, optionsOrListener, maybeListener) => {
  const options = typeof optionsOrListener === 'function' ? {} : optionsOrListener;
  const listener = typeof optionsOrListener === 'function' ? optionsOrListener : maybeListener;
  if (typeof listener !== 'function') {
    throw new TypeError('The "listener" argument must be of type function');
  }
  const key = String(path);
  let watcher = statWatchers.get(key);
  if (watcher === undefined) {
    watcher = new StatWatcher(key, options?.interval);
    watcher.once('stop', () => { statWatchers.delete(key); });
    statWatchers.set(key, watcher);
  }
  watcher.on('change', listener);
  return watcher;
};

export const unwatchFile = (path, listener) => {
  const key = String(path);
  const watcher = statWatchers.get(key);
  if (watcher === undefined) return;
  if (listener === undefined) watcher.removeAllListeners('change');
  else watcher.removeListener('change', listener);
  if (watcher.listenerCount('change') === 0) watcher.stop();
};

export default { watchFile, unwatchFile };
