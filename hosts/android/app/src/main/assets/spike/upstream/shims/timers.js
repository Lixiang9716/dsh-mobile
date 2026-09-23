// dsh:logging-exempt (shim layer)
/**
 * timers shim — the mapping from `setTimeout`-shaped code to the gateway's
 * timer seam (contract v1.4.0), and the ONLY place the ambient globals come
 * from. The vendored upstream runtime calls bare `setTimeout`/
 * `clearTimeout` (dsh-timeout's deadline fuses arm one per await race); the
 * contract deliberately defines no global timer — this shim installs the
 * globals, negotiates through the ordinary gateway call (unavailable hosts
 * fail LOUD on the first arm, naming the primitive), and bridges the
 * synchronous-handle world of the JS timer idiom onto the async
 * timerSchedule/timerCancel pair:
 *
 *   - setTimeout hands out a synthetic handle IMMEDIATELY (callers expect a
 *     synchronously usable id); the gateway arm resolves async and the
 *     handle keeps `timerId` pending meanwhile. A clearTimeout that beats
 *     the arm marks the entry cancelled; the late arm resolves into an
 *     immediate timerCancel (the idempotent one-way race the contract
 *     defines).
 *   - `timer.fire` events (the §5 channel) invoke the callback inline in
 *     the event delivery — which the host already dispatches onto the
 *     serial runtime queue, so a timer callback never runs on a second
 *     thread (D2) and never reenters a running job.
 *   - NO setInterval: v1.4.0 is one-shot by contract; repetition is the
 *     caller's re-arm loop. An accidental `setInterval` stays the loud
 *     ReferenceError it has always been on this runtime.
 */
import { timerSchedule, timerCancel, onEvent } from 'gateway.js';
import { captureContext, runWithCapturedContext } from './async-hooks.js';

const pending = new Map(); // handle -> { timerId, cancelled, fn, args }
const firing = new Map(); // timerId -> handle
let nextHandle = 1;

/** Arm one timer for a setTimeout entry — extracted to keep the sync face
 * flat (the shape gate): the cancel-beat-arm race disarms the late arm, a
 * suppressed fire finds the entry already deleted (idempotent one-way), and
 * an arm failure fails loud (rule 5 — swallowing it would hang every await
 * racing the fuse; a host without the seam names the primitive). */
const armTimer = async (delayMs, handle, entry) => {
  try {
    const { timerId } = await timerSchedule(delayMs, { tag: 'shim:setTimeout' });
    if (entry.cancelled) {
      timerCancel(timerId).catch(() => {});
      return;
    }
    entry.timerId = timerId;
    firing.set(timerId, handle);
  } catch (error) {
    pending.delete(handle);
    throw error;
  }
};

onEvent((ev) => {
  if (ev?.event !== 'timer.fire') return;
  const handle = firing.get(ev.timerId);
  if (handle === undefined) return;
  firing.delete(ev.timerId);
  const entry = pending.get(handle);
  pending.delete(handle);
  if (entry !== undefined && entry.cancelled !== true) {
    runWithCapturedContext(entry.captured, () => entry.fn(...entry.args));
  }
});

globalThis.setTimeout = (fn, delay = 0, ...args) => {
  if (typeof fn !== 'function') {
    throw new TypeError(`setTimeout: callback must be a function (got ${typeof fn})`);
  }
  const delayMs = Number(delay);
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    throw new TypeError(`setTimeout: delay must be a non-negative integer (got ${String(delay)})`);
  }
  const handle = nextHandle++;
  const entry = { timerId: null, cancelled: false, fn, args,
                   // Cross-timer ALS propagation (the async-hooks shim
                   // predates the seam): the context captured AT ARM TIME
                   // wraps the fire — Node's timer semantics.
                   captured: captureContext() };
  pending.set(handle, entry);
  armTimer(delayMs, handle, entry);
  return handle;
};

globalThis.clearTimeout = (handle) => {
  const entry = pending.get(handle);
  if (entry === undefined) return;
  entry.cancelled = true;
  pending.delete(handle);
  if (entry.timerId !== null) {
    firing.delete(entry.timerId);
    timerCancel(entry.timerId).catch(() => {});
  }
};

// setImmediate — the other ambient timer idiom the upstream code uses
// (tool-call scheduler's quiescence drain). A macrotask: the 0-delay timer
// arm is the honest mapping (microtask-only would starve the drain loop's
// interleaving with gateway events).
globalThis.setImmediate = (fn, ...args) => {
  if (typeof fn !== 'function') {
    throw new TypeError(`setImmediate: callback must be a function (got ${typeof fn})`);
  }
  return globalThis.setTimeout(fn, 0, ...args);
};
globalThis.clearImmediate = globalThis.clearTimeout;
