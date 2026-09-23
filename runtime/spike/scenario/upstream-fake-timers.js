// dsh:logging-exempt (test harness: verdicts are the product)
/**
 * upstream-fake-timers — the harness's fake-timer surface, one module on
 * purpose (the harness file rides the 500-line code-size cap): vi.
 * useFakeTimers swaps the AMBIENT setTimeout/clearTimeout (installed by
 * upstream/shims/timers.js over the v1.4.0 gateway seam) for a controlled
 * queue the spec advances by hand — deterministic timing without the
 * host's wall clock, exactly what the previously-excluded fake-timer
 * specs demand. useRealTimers restores; wall-clock mocking
 * (vi.setSystemTime) stays excluded: the seam is monotonic-only.
 */

/** Swap the ambient timer globals for the controlled queue (module level
 * to keep the exported methods object small). */
const installFakeTimers = (state) => {
  if (state.real === undefined) {
    state.real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  }
  state.clock = { now: 0, queue: [], seq: 0 };
  globalThis.setTimeout = (fn, delay = 0, ...args) => {
    if (typeof fn !== 'function') throw new TypeError('setTimeout: callback must be a function');
    const clock = state.clock;
    const at = clock.now + Math.max(0, Number(delay) || 0);
    const handle = { at, fn, args, seq: clock.seq++ };
    clock.queue.push(handle);
    clock.queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    const clock = state.clock;
    if (clock === undefined || handle === null || handle === undefined) return;
    const at = clock.queue.indexOf(handle);
    if (at >= 0) clock.queue.splice(at, 1);
  };
};

/** The vi fake-timer methods (spread into the harness's vi object; they
 * close over the harness-private state via the passed holder). */
export const fakeTimerApi = (state) => ({
  useFakeTimers: () => installFakeTimers(state),
  useRealTimers() {
    if (state.real !== undefined) {
      globalThis.setTimeout = state.real.setTimeout;
      globalThis.clearTimeout = state.real.clearTimeout;
      state.clock = undefined;
    }
  },
  isFakeTimers() {
    return state.clock !== undefined;
  },
  advanceTimersByTime(ms) {
    const clock = state.clock;
    if (clock === undefined) throw new Error('harness: advanceTimersByTime without useFakeTimers');
    const target = clock.now + Math.max(0, Number(ms) || 0);
    while (clock.queue.length > 0 && clock.queue[0].at <= target) {
      const handle = clock.queue.shift();
      clock.now = handle.at;
      handle.fn(...handle.args);
    }
    clock.now = target;
  },
  runAllTimers() {
    const clock = state.clock;
    if (clock === undefined) throw new Error('harness: runAllTimers without useFakeTimers');
    let guard = 0;
    while (clock.queue.length > 0) {
      if (++guard > 100000) throw new Error('harness: runAllTimers diverged (100k fires)');
      const handle = clock.queue.shift();
      clock.now = handle.at;
      handle.fn(...handle.args);
    }
  },
  runOnlyPendingTimers() {
    const clock = state.clock;
    if (clock === undefined) return;
    for (const handle of clock.queue.splice(0)) {
      clock.now = Math.max(clock.now, handle.at);
      handle.fn(...handle.args);
    }
  },
  getTimerCount() {
    return state.clock?.queue.length ?? 0;
  },
});
