// dsh:logging-exempt (node-side test vehicle: its stdout IS the product)
/**
 * fs-watch-idle-gateway — the FAKE GATEWAY of the loader-faces fs-watch
 * idle-count probe (ci/fs-watch-idle-probe.mjs). It stands where the C host
 * bridge stands for the quickjs runtime: the REAL gateway face re-exported
 * verbatim (every primitive the shim web links against — importing it is
 * host-bridge-free, the bridge binds at call time), with the TIMER SEAM
 * swapped for the counting mini host so the probe can report the
 * idle-state timerSchedule rate — the P3 timer-flood metric (measured on
 * device 2026-10-09: 126,977 timerSchedule + 17,707 timerCancel over 40
 * idle minutes, ~53/s, gateway debug lines 95% of the carrier capture).
 *
 * Fidelity notes (what makes the count honest):
 *   - the probe loads the REAL upstream/shims/timers.js, whose
 *     setTimeout/setInterval globals map every arm onto timerSchedule/
 *     timerCancel — the same mapping the device runtime uses;
 *   - this module captures Node's OWN setTimeout/clearTimeout at module
 *     evaluation, BEFORE timers.js installs its globals, so the mini host
 *     paces with real wall-clock timers exactly like the C host's
 *     sleep-to-fire pass;
 *   - fires are delivered as {event:'timer.fire', timerId} through the
 *     onEvent subscription, the §5 channel shape the real shim listens on.
 */
// The REAL gateway face (../gateway.js resolves WITHOUT the redirect — the
// hooks only rewrite the bare 'gateway.js' specifier).
export * from '../gateway.js';

const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);

const armed = new Map(); // timerId -> node handle
const listeners = new Set();
const counters = {
  schedule: 0,
  cancel: 0,
  byTag: new Map(), // tag -> arms
};
let nextTimerId = 1;

export const timerSchedule = async (delayMs, options = {}) => {
  counters.schedule += 1;
  const tag = String(options?.tag ?? 'none');
  counters.byTag.set(tag, (counters.byTag.get(tag) ?? 0) + 1);
  const timerId = nextTimerId++;
  const clamped = Math.min(2147483647, Math.max(0, Math.trunc(Number(delayMs) || 0)));
  const handle = realSetTimeout(() => {
    armed.delete(timerId);
    for (const fn of [...listeners]) fn({ event: 'timer.fire', timerId });
  }, clamped);
  armed.set(timerId, handle);
  return { timerId };
};

export const timerCancel = async (timerId) => {
  counters.cancel += 1;
  const handle = armed.get(timerId);
  if (handle !== undefined) {
    armed.delete(timerId);
    realClearTimeout(handle);
  }
};

export const onEvent = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** The probe's read-out: a snapshot of the arm counters (frozen copy). */
export const __probeCounters = () => ({
  schedule: counters.schedule,
  cancel: counters.cancel,
  byTag: Object.fromEntries([...counters.byTag.entries()].sort()),
});
