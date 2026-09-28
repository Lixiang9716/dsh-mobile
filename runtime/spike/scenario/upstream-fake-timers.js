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
  // vi.useFakeTimers({toFake:["performance"]}): the corpus's deadline loops
  // (terminal-controller retention) compute `due = performance.now() + delay`
  // and re-arm on `remaining > 0` — a REAL monotonic clock against the fake
  // fire times never converges (terminate never lands). Fake now = clock.now
  // (R3-D, 2026-09-27).vitest toFake accepts the name; callers passing it
  // need the swap, callers not passing it keep the real clock only when the
  // option list names other members — the corpus always lists performance
  // explicitly alongside the timers it wants.
  // The perf face swaps on EVERY install: useRealTimers restores the real
  // object, so a once-only guard would leave tests 2..N on the wall clock
  // (measured 2026-09-27: retention's second test ran on real time and its
  // deadline never converged). The perf-hooks shim freezes its object ('now'
  // is read-only) and a Proxy over the frozen target violates quickjs's
  // invariant checks, so the fake face is a PLAIN copy of the real surface
  // with `now` swapped for the fake clock (R3-D, 2026-09-27).
  if (state.real.performance === undefined && globalThis.performance !== undefined) {
    state.real.performance = globalThis.performance;
  }
  if (state.real.performance !== undefined) {
    const real = state.real.performance;
    const facade = {};
    for (const key of Reflect.ownKeys(real)) {
      const value = real[key];
      facade[key] = typeof value === 'function' ? value.bind(real) : value;
    }
    facade.now = () => state.clock.now;
    globalThis.performance = facade;
  }
  globalThis.setTimeout = (fn, delay = 0, ...args) => {
    if (typeof fn !== 'function') throw new TypeError('setTimeout: callback must be a function');
    const clock = state.clock;
    const at = clock.now + Math.max(0, Number(delay) || 0);
    // Node's Timeout face: the terminal-controller retention loop calls
    // timer.unref() on the arm — identity here, exactly like the real timers
    // shim's handles (R3-D, 2026-09-27).
    const handle = { at, fn, args, seq: clock.seq++, ref() { return handle; }, unref() { return handle; }, hasRef() { return true; }, refresh() { return handle; } };
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
      if (state.real.performance !== undefined) {
        globalThis.performance = state.real.performance;
      }
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
  /** The ASYNC advance (vitest shape): fires due timers while draining the
   * microtask queue between fires, so callbacks that `await` — abort
   * listeners, promise chains scheduled by a fired timer — make progress
   * before the clock moves on (measured 2026-09-27: the tool-session-query
   * deadline test awaits vi.advanceTimersByTimeAsync). New timers armed by a
   * fired callback inside the window fire in the same advance, like vitest.
   *
   * The drain rides a REAL macrotask boundary (the pre-install setTimeout —
   * the v1.4.0 gateway seam), not a fixed microtask unroll: the host job
   * loop drains the ENTIRE microtask queue before a real 0ms timer fires,
   * while a 16-tick unroll falls arbitrarily short (measured 2026-09-28,
   * R3-H: the timeout-policy deadline chain armed its 100ms timer on tick
   * ~40 — after the advance had finished — so the deadline never fired and
   * `await pending` hung forever). */
  async advanceTimersByTimeAsync(ms) {
    const clock = state.clock;
    if (clock === undefined) throw new Error('harness: advanceTimersByTimeAsync without useFakeTimers');
    const target = clock.now + Math.max(0, Number(ms) || 0);
    const drain = async () => {
      await new Promise((resolve) => state.real.setTimeout(resolve, 0));
    };
    // vitest's async advance settles the chains pending AT CALL TIME before
    // firing due timers: a deadline armed through async middleware
    // (cordis waterfall → dsh-tools dispatchScheduledExecution) lands only
    // after a real seam hop, and firing the window first would advance
    // past an unarmed deadline (measured 2026-09-28, R3-H: the
    // timeout-policy deadline armed at fake-now=150+100 and never fired).
    await drain();
    while (clock.queue.length > 0 && clock.queue[0].at <= target) {
      const handle = clock.queue.shift();
      clock.now = handle.at;
      handle.fn(...handle.args);
      await drain();
    }
    clock.now = target;
    await drain();
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
  /** The ASYNC shape (vitest): drain the whole queue, letting callbacks'
   * promise chains settle between fires — llm-retry's backoff ladder awaits
   * this shape (R3-D, 2026-09-27). Same real-macrotask drain boundary as
   * advanceTimersByTimeAsync (R3-H, 2026-09-28): chains deeper than a fixed
   * tick unroll arm timers only after the drain gives up. */
  async runAllTimersAsync() {
    const clock = state.clock;
    if (clock === undefined) throw new Error('harness: runAllTimersAsync without useFakeTimers');
    let guard = 0;
    while (clock.queue.length > 0) {
      if (++guard > 100000) throw new Error('harness: runAllTimersAsync diverged (100k fires)');
      const handle = clock.queue.shift();
      clock.now = handle.at;
      handle.fn(...handle.args);
      await new Promise((resolve) => state.real.setTimeout(resolve, 0));
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
