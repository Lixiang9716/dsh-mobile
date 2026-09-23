// dsh:logging-exempt (shim; the spike runtime has no timer seam)
/**
 * node:timers/promises — the honest empty timer seam.
 *
 * cordis-plugin-include imports `setTimeout` (write-side backoff). The spike
 * runtime has no host timer pump — the async-hooks shim documents the same
 * boundary — so the name LINKS (a missing ESM export is a link error) and
 * REFUSES at call time, naming the boundary. Nothing in the read path calls
 * it: presets discovery does no writes, so no backoff is ever scheduled.
 */
const refuse = (name) => async () => {
  throw new Error(
    `node:timers/promises.${name}: no timer seam in the spike runtime — `
    + 'timed scheduling is a desktop host capability (see upstream/shims/async-hooks.js)');
};

export const setTimeout = refuse('setTimeout');
export const setImmediate = refuse('setImmediate');
export const setInterval = refuse('setInterval');

/** scheduler.yield() — Node's cooperative scheduler hint; on this serial
 * runtime a zero-delay timer arm IS the event-loop yield the caller wants
 * (the spine's atomic-write chain uses it between file steps). wait/timer
 * helpers ride the same seam. */
const arm = (delay) => new Promise((resolve) => { globalThis.setTimeout(resolve, delay); });
export const scheduler = {
  yield: () => arm(0),
  wait: (delay = 1) => arm(Math.max(1, delay)),
};

export default { setTimeout, setImmediate, setInterval, scheduler };
