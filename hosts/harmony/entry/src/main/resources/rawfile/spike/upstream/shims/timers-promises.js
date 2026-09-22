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

export default { setTimeout, setImmediate, setInterval };
