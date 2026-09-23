// dsh:logging-exempt (shim; timer semantics ride the v1.4.0 host timer seam)
/**
 * node:timers/promises — the promise face of the host timer seam.
 *
 * The original shim REFUSED every name: the spike runtime had no timer pump,
 * so a timed backoff could only be an honest boundary error. The v1.4.0
 * timer seam (contract + host + harness fakes) replaced that premise — the
 * 0-delay arm is a real event-loop yield now (scheduler.yield below already
 * rode it) — so the promise timers resolve through the same arm instead of
 * refusing. Node's argument shapes are kept:
 *   - setTimeout(delay, value, options) → Promise<value>   (args REVERSED
 *     vs the global — node's own quirk, and what the closure's backoff
 *     callers pass)
 *   - setImmediate(value) → Promise<value>, one event-loop turn
 *   - scheduler.yield()/wait() — unchanged
 * setInterval stays a named refusal: its AsyncIterator face has no consumer
 * in the corpus or the closure, and a fake periodic iterator would lie about
 * cancellation semantics.
 */
const arm = (delay) => new Promise((resolve) => { globalThis.setTimeout(resolve, delay); });

/** setTimeout(delay[, value][, options]) → Promise<value>. */
export const setTimeout = async (delay, value, options) => {
  if (options?.signal?.aborted) {
    throw options.signal.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  }
  const ms = typeof delay === 'number' ? delay : 1;
  if (ms === undefined || ms === null || !(ms >= 0) || ms > 2147483647) {
    throw new Error(`node:timers/promises.setTimeout: delay ${String(delay)} — supported: non-negative integers <= 2^31-1`);
  }
  await arm(ms);
  if (options?.signal?.aborted) {
    throw options.signal.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  }
  return value;
};

/** setImmediate([value]) → Promise<value> — one event-loop turn. */
export const setImmediate = async (value) => {
  await arm(0);
  return value;
};

export const setInterval = () => {
  throw new Error(
    'node:timers/promises.setInterval: periodic async iterator — no consumer '
    + 'in the corpus or the closure; refuse loud instead of faking cancellation');
};

/** scheduler.yield() — Node's cooperative scheduler hint; on this serial
 * runtime a zero-delay timer arm IS the event-loop yield the caller wants
 * (the spine's atomic-write chain uses it between file steps). wait/timer
 * helpers ride the same seam. */
export const scheduler = {
  yield: () => arm(0),
  wait: (delay = 1) => arm(Math.max(1, delay)),
};

export default { setTimeout, setImmediate, setInterval, scheduler };
