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

const pending = new Map(); // handle -> { timerId, cancelled, fn, args }
const firing = new Map(); // timerId -> handle
let nextHandle = 1;

onEvent((ev) => {
  if (ev?.event !== 'timer.fire') return;
  const handle = firing.get(ev.timerId);
  if (handle === undefined) return;
  firing.delete(ev.timerId);
  const entry = pending.get(handle);
  pending.delete(handle);
  if (entry !== undefined && entry.cancelled !== true) {
    entry.fn(...entry.args);
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
  const entry = { timerId: null, cancelled: false, fn, args };
  pending.set(handle, entry);
  timerSchedule(delayMs, { tag: 'shim:setTimeout' })
    .then(({ timerId }) => {
      if (entry.cancelled) {
        // The cancel beat the arm: disarm the now-armed timer (idempotent
        // one-way race — a suppressed fire may still race in and finds the
        // entry already deleted).
        timerCancel(timerId).catch(() => {});
        return;
      }
      entry.timerId = timerId;
      firing.set(timerId, handle);
    })
    .catch((error) => {
      pending.delete(handle);
      // Fail loud (rule 5): a host without the seam names the primitive;
      // swallowing an arm failure would hang every await racing the fuse.
      throw error;
    });
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
