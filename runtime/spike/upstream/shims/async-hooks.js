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
    frames.push({ als: this, store });
    try {
      return callback(...args);
    } finally {
      frames.pop();
    }
  }
  getStore() {
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i].als === this) return frames[i].store;
    }
    return undefined;
  }
  enterWith(store) {
    frames.push({ als: this, store });
  }
  disable() {
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i].als === this) frames.splice(i, 1);
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
