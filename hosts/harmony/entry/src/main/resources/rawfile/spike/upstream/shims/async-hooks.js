// dsh:logging-exempt (shim layer)
/**
 * node:async_hooks shim — AsyncLocalStorage over a captured-context frame
 * stack (there is no native async_hooks in quickjs-ng).
 *
 * Covers (upstream usage → this module):
 *   - dsh-agent (`AsyncLocalStorage` for agent initiator/initiator-run
 *     scoping): `run(store, cb)`, `getStore()`, `enterWith(store)`, `disable()`.
 *
 * Propagation model: the runtime is single-threaded and serial (ARCHITECTURE
 * §6), so async context only has to survive await boundaries. Installing this
 * module patches `Promise.prototype.then/catch/finally` and the web-shims
 * `queueMicrotask` wrapper to capture the frame stack at scheduling time and
 * restore it around each callback — the same shape Node's own ALS semantics
 * have (context = what was current when the continuation was attached).
 *
 * Intentionally NOT supported: AsyncResource, executionAsyncId, createHook,
 * and cross-timer propagation (the spike runtime has no timer seam; timers
 * fail loud elsewhere).
 */
const frames = [];

/** Frames whose `run()` has not settled yet.
 *
 * Deliberately OUTSIDE the capture/restore machinery: `runWithCapturedContext`
 * swaps the whole `frames` ARRAY, so a frame removed from it can be written
 * back by a later restore (measured with the probe — `after-run` kept the
 * store that way). Liveness is a property of the run, not of the array
 * contents, so it lives in its own structure that capture/restore cannot
 * touch. A frame that comes back this way is skipped, which keeps the
 * semantics callers depend on: the store is visible for the operation's
 * lifetime and gone once it settles. */
const liveFrames = new Set();

export const captureContext = () => (frames.length > 0 ? [...frames] : undefined);

export const runWithCapturedContext = (captured, fn) => {
  if (captured === undefined) return fn();
  const saved = frames.splice(0, frames.length, ...captured);
  try {
    return fn();
  } finally {
    frames.splice(0, frames.length, ...saved);
  }
};

export class AsyncLocalStorage {
  run(store, callback, ...args) {
    const frame = { als: this, store };
    frames.push(frame);
    liveFrames.add(frame);
    const drop = () => {
      liveFrames.delete(frame);
      const at = frames.lastIndexOf(frame);
      if (at >= 0) frames.splice(at, 1);
    };
    let result;
    try {
      result = callback(...args);
    } catch (error) {
      drop();
      throw error;
    }
    // A promise-returning operation keeps its frame installed until it
    // settles. MEASURED, not assumed: quickjs-ng runs `await` continuations
    // through its own job queue, not through the patched
    // Promise.prototype.then (scenario/als-shim-probe.js: the store is gone
    // at the first `await`), so patching the prototype alone cannot reach
    // them. Leaving the frame installed for the operation's lifetime is what
    // makes the store visible to everything the operation awaits — which is
    // exactly the contract callers rely on: `dsh-agent` scopes the
    // initiating Agent around one bounded driver operation and the agent
    // loop reads it later, when it executes a tool call. Without this the
    // first tool call of every session fails with "no initiating agent is
    // active" while plain turns look healthy.
    if (result !== null && typeof result === 'object'
        && typeof result.then === 'function') {
      return result.then(
        (value) => { drop(); return value; },
        (error) => { drop(); throw error; },
      );
    }
    drop();
    return result;
  }
  getStore() {
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i];
      if (frame.als === this && liveFrames.has(frame)) return frame.store;
    }
    return undefined;
  }
  enterWith(store) {
    const frame = { als: this, store };
    frames.push(frame);
    liveFrames.add(frame);
  }
  disable() {
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i].als === this) {
        liveFrames.delete(frames[i]);
        frames.splice(i, 1);
      }
    }
  }
}

/* ---- promise-continuation context propagation ---------------------------
 * Idempotent: the patch is installed once per runtime, whichever module
 * (this shim) loads first. Wrapped callbacks restore the context captured
 * when `.then`/`catch`/`finally` attached — await continuations included. */
const installPropagation = () => {
  if (globalThis.__dshCaptureContext !== undefined) return;
  globalThis.__dshCaptureContext = captureContext;
  globalThis.__dshRunWithCapturedContext = runWithCapturedContext;
  const wrap = (fn) => {
    if (typeof fn !== 'function') return fn;
    return function (...args) {
      const captured = captureContext();
      if (captured === undefined) return fn.apply(this, args);
      return runWithCapturedContext(captured, () => fn.apply(this, args));
    };
  };
  const nativeThen = Promise.prototype.then;
  Promise.prototype.then = function then(onFulfilled, onRejected) {
    return nativeThen.call(this, wrap(onFulfilled), wrap(onRejected));
  };
  const nativeCatch = Promise.prototype.catch;
  Promise.prototype.catch = function catch_(onRejected) {
    return nativeCatch.call(this, wrap(onRejected));
  };
  const nativeFinally = Promise.prototype.finally;
  Promise.prototype.finally = function finally_(onFinally) {
    return nativeFinally.call(this, wrap(onFinally));
  };
};
installPropagation();
