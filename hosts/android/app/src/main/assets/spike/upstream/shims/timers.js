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
 * an arm failure reports LOUD (rule 5) through the sink. */
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
    // Fail loud (rule 5): setTimeout already handed back its handle, so a
    // rethrow here reaches NOBODY — it only becomes an orphaned unhandled
    // rejection — while a quiet return would starve every timer silently.
    // Measured 2026-10-05, battery-r16 loop-z2: the serving seat dropped
    // every timer.fire, the read-idle watchdog and the retry backoff armed
    // and never fired, and the ONLY trace was behavior that never happened.
    // The sink line IS the loudness (this file carries no logger import —
    // the shim layer runs before one; the drain's immediate/throw report
    // below is the precedent). The entry is gone, so a cancelled handle
    // stays a no-op and the caller sees a timer that never fires — named
    // here, once per failed arm.
    try {
      globalThis.__DSH_LOG_SINK__?.(JSON.stringify({
        level: 'warn', scenario: 'timers', event: 'arm/failed',
        message: `setTimeout: the gateway timer arm failed — timers cannot fire on this host: ${String(error?.message ?? error).slice(0, 260)}`,
      }));
    } catch { /* best-effort, like the drain report */ }
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
  // node coerces the delay: non-numbers → 0, negatives → 0, fractions
  // TRUNCATE toward zero, values above 2^31-1 clamp to 2147483647 (measured
  // 2026-09-28, R3-G1: the inspector client's reconnect backoff computes
  // fractional multipliers — 8.859 ms — and the strict integer check threw).
  const delayMs = Math.min(2147483647, Math.max(0, Math.trunc(Number(delay) || 0)));
  const id = nextHandle++;
  // Cross-timer ALS propagation (the async-hooks shim predates the seam):
  // the context captured AT ARM TIME wraps the fire — Node's timer semantics.
  const captured = captureContext();
  const entry = { timerId: null, cancelled: false, fn, args, captured };
  // Node's setTimeout hands back a Timeout OBJECT carrying ref/unref/hasRef/
  // refresh (measured 2026-09-27: the sdk client dispose ladder calls
  // setTimeout(...).unref()). ref/unref have no runtime meaning here (the
  // gateway timer seam is the only wake source), so they are identity; the
  // object doubles as the cancellation key (identity-cleared in clearTimeout)
  // and still compares as its numeric id through Symbol.toPrimitive.
  const handle = {
    id,
    ref() { return handle; },
    unref() { return handle; },
    hasRef() { return true; },
    refresh() { armTimer(delayMs, handle, entry); return handle; },
    [Symbol.toPrimitive]() { return id; },
  };
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
//
// FIFO QUEUE (W6-U r3, 2026-09-27): one 0-delay arm drains ALL queued
// immediates in insertion order, instead of one gateway round trip per call.
// The per-call mapping broke node's check-phase ordering guarantee — each
// arm rides its own timerSchedule dispatch, and under load two immediates
// armed in the same synchronous stretch could land in different host
// dispatch batches, letting a LATER-armed immediate run FIRST (measured:
// subprocess-local's Windows Job 'post-commit termination' test armed its
// own setImmediate after the runner's and raced it, 32/3 <-> 33/2 across
// runs). The queue restores insertion-order delivery; immediates armed
// DURING a drain run in the next batch (node's next-loop-iteration rule).
// A throwing entry reports through the E2E sink and the drain continues —
// one bad callback must not silently swallow its batch-mates.
const immediateQueue = [];
let immediateArmed = false;
const drainImmediates = () => {
  immediateArmed = false;
  const batch = immediateQueue.splice(0);
  for (const entry of batch) {
    if (entry.cancelled) continue;
    try {
      runWithCapturedContext(entry.captured, () => entry.fn(...entry.args));
    } catch (error) {
      try {
        globalThis.__DSH_LOG_SINK__?.(JSON.stringify({
          scenario: 'timers', event: 'immediate/throw',
          message: String(error?.message ?? error).slice(0, 300),
        }));
      } catch { /* the sink is best-effort */ }
    }
  }
};
globalThis.setImmediate = (fn, ...args) => {
  if (typeof fn !== 'function') {
    throw new TypeError(`setImmediate: callback must be a function (got ${typeof fn})`);
  }
  const entry = { __dshImmediate: true, cancelled: false, fn, args, captured: captureContext() };
  immediateQueue.push(entry);
  if (!immediateArmed) {
    immediateArmed = true;
    globalThis.setTimeout(drainImmediates, 0);
  }
  return entry;
};
globalThis.clearImmediate = (handle) => {
  if (handle && typeof handle === 'object' && handle.__dshImmediate === true) {
    handle.cancelled = true;
    return;
  }
  globalThis.clearTimeout?.(handle);
};

// setInterval — the contract's documented re-arm pattern, implemented once
// here so callers (the webworker-runtime polyfill's installer binds the
// ambient face at init) get real repetition instead of a missing global:
// each fire re-arms the same delay until clearInterval. A fire that throws
// stops the loop (a throw inside a gateway event is a runtime fault; the
// re-arm would otherwise chase it). The re-arm handle rides the SAME
// setTimeout machinery, so clearTimeout also disarms a pending fire and
// ALS context propagation applies per fire.
const intervals = new Map(); // interval handle -> { delayMs, cancelled }
globalThis.setInterval = (fn, delay = 0, ...args) => {
  if (typeof fn !== 'function') {
    throw new TypeError(`setInterval: callback must be a function (got ${typeof fn})`);
  }
  const delayMs = Number(delay);
  if (!Number.isInteger(delayMs) || delayMs < 0) {
    throw new TypeError(`setInterval: delay must be a non-negative integer (got ${String(delay)})`);
  }
  const handle = { id: nextHandle++ };
  const state = { delayMs, cancelled: false };
  intervals.set(handle, state);
  const tick = () => {
    if (state.cancelled || intervals.get(handle) !== state) return;
    runWithCapturedContext(captureContext(), () => fn(...args));
    if (state.cancelled || intervals.get(handle) !== state) return;
    globalThis.setTimeout(tick, state.delayMs);
  };
  // node's Timeout handle face: the vendored mux's startHeartbeat calls
  // `heartbeatTimer.unref()` (stream-server.ts) — no ambient event loop to
  // opt out of here, so unref/ref are bookkeeping no-ops and refresh just
  // re-arms the loop (W5-Q 2026-09-28).
  handle.unref = () => handle;
  handle.ref = () => handle;
  handle.hasRef = () => true;
  handle.refresh = () => {
    state.cancelled = false;
    globalThis.setTimeout(tick, state.delayMs);
    return handle;
  };
  globalThis.setTimeout(tick, delayMs);
  return handle;
};
globalThis.clearInterval = (handle) => {
  const state = intervals.get(handle);
  if (state === undefined) return;
  state.cancelled = true;
  intervals.delete(handle);
};
