// dsh:logging-exempt (shim layer)
/**
 * node:async_hooks shim — AsyncLocalStorage over the ENGINE's async-context
 * slot (quickjs-ng fork, dsh-async-context): the engine snapshots the slot
 * into every enqueued job and restores it around the job's execution, which
 * is the propagation Node implements natively (async_hooks) and a JS-level
 * Promise patch cannot reach — quickjs runs `await` continuations through
 * its own job queue, never through the visible Promise.prototype.then
 * (measured with scenario/als-shim-probe.js, 2026-09-23).
 *
 * Covers (upstream usage → this module):
 *   - dsh-agent (`AsyncLocalStorage` for agent initiator/initiator-run
 *     scoping): `run(store, cb)`, `getStore()`, `enterWith(store)`, `disable()`.
 *
 * Model: the frame stack IS the engine slot's value (read through
 * __asyncContextGet, written through __asyncContextSet). Every mutation is
 * COPY-ON-WRITE — a new array per change — so the engine's by-reference job
 * snapshots are immutable point-in-time views.
 *
 * Intentionally NOT supported: AsyncResource, executionAsyncId, createHook
 * (no engine surface for them; the corpus does not use them).
 */
const liveFrames = new Set();

const getFrames = () => {
  const value = globalThis.__asyncContextGet();
  return value === undefined ? [] : value;
};
const setFrames = (frames) => {
  globalThis.__asyncContextSet(frames === undefined ? undefined : frames);
};

export const captureContext = () => getFrames();

export const runWithCapturedContext = (captured, fn) => {
  const saved = getFrames();
  setFrames(captured === undefined ? [] : captured);
  try {
    return fn();
  } finally {
    setFrames(saved);
  }
};

export class AsyncLocalStorage {
  run(store, callback, ...args) {
    const frame = { als: this, store };
    const before = getFrames();
    setFrames([...before, frame]);
    liveFrames.add(frame);
    const drop = () => {
      liveFrames.delete(frame);
      setFrames(getFrames().filter((f) => f !== frame));
    };
    let result;
    try {
      result = callback(...args);
    } catch (error) {
      drop();
      throw error;
    }
    // A promise-returning operation keeps its frame installed until it
    // settles (MEASURED, not assumed — the dsh-agent initiator scope is
    // read by tool calls the operation awaits; dropping eagerly fails the
    // first tool call of every session with "no initiating agent is
    // active"). The engine snapshots hand every continuation the
    // with-frame view; continuations attached AFTER settle see it dropped.
    if (result !== null && typeof result === 'object'
        && typeof result.then === 'function') {
      // Node restores the caller's context when the CALLBACK RETURNS — the
      // operation's continuations keep the store through the ENGINE's
      // attach-time capture, not by holding the sync slot dirty (measured
      // 2026-09-23: the dirty slot leaked the driver's initiator run into
      // the test's subsequent sync code, and restart's teardown then
      // released the run early — the whole agent-initiator quartet).
      setFrames(before);
      return result.then(
        (value) => { drop(); return value; },
        (error) => { drop(); throw error; },
      );
    }
    drop();
    return result;
  }
  getStore() {
    const frames = getFrames();
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i];
      if (frame.als === this && liveFrames.has(frame)) return frame.store;
    }
    return undefined;
  }
  enterWith(store) {
    const frame = { als: this, store };
    setFrames([...getFrames(), frame]);
    liveFrames.add(frame);
  }
  disable() {
    const mine = new Set();
    for (const frame of getFrames()) {
      if (frame.als === this) { mine.add(frame); liveFrames.delete(frame); }
    }
    if (mine.size > 0) setFrames(getFrames().filter((f) => !mine.has(f)));
  }
}
