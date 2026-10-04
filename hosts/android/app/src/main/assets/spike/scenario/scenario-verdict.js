// dsh:logging-exempt (verdict plumbing; the logger arrives injected — the
// scenario mounts the real one)
/**
 * scenario/scenario-verdict.js — the scenario's one-verdict fail gate
 * (split from composer-web-live.js at loop-x). #366 made `fail` first-only:
 * a completed-fail verdict is STICKY — js_complete keeps the reason in the
 * host's error slot (dsh_spike_host.c) and every later bus crossing
 * re-reports it (m4_status reads the completed flag) — so a second
 * __dshComplete only multiplies the FAIL lines, never the facts.
 *
 * THE BLIND SPOT FIRST-ONLY BUYS (loop-x): a suppressed fail whose message
 * DIFFERS from the recorded verdict is a genuinely new failure class, and it
 * was invisible on every observable — the JS gate dropped it before
 * __dshComplete, the seat's runtimeFailed gate (SessionServe.fail) would
 * drop the re-report anyway, and the release strip (logging rule L4) removes
 * debug/info, the levels the canonical record rides. This gate gives such a
 * delta ONE release-visible line — log.warn, a level the strip keeps —
 * naming both messages, once per DISTINCT message; the same message stays
 * silent forever (that repeat is the storm body #366 fixed: demand's
 * fail-then-throw lands here twice with one message and stays one verdict).
 */

/**
 * Build the scenario's `fail(reason)`.
 * @param log - the scenario's logger (`warn` must survive the release strip).
 * @param emit - the scenario's canonical e2e record (carries the first
 *   verdict's `scenario.failed` event).
 * @param complete - the embedder completion (globalThis.__dshComplete on the
 *   seats; late-bound by the caller — the drive injects it after eval).
 * @returns (reason) => void — the first call records the verdict (debug +
 *   e2e event + complete(false, message|short-stack)); a later call whose
 *   message was never seen warns once and stays otherwise silent.
 */
export const makeFailGate = ({ log, emit, complete }) => {
  /** The recorded verdict's message (null until then — String(reason) is
   * never null, so the sentinel cannot collide). */
  let recorded = null;
  /** Every message this gate already surfaced, recorded verdict included —
   * a message's second appearance is a repeat, never a new class. */
  const seen = new Set();
  return (reason) => {
    const error = reason instanceof Error ? reason : null;
    const message = error ? error.message : String(reason);
    if (recorded !== null) {
      if (!seen.has(message)) {
        seen.add(message);
        log.warn('a suppressed fail names a new failure class', {
          recorded, reason: message,
        });
      }
      return;
    }
    recorded = message;
    seen.add(message);
    const withStack = error?.stack
      ? `${message} | ${error.stack.split('\n').slice(0, 4).join(' / ')}`
      : message;
    log.debug('scenario failed', { reason: withStack });
    emit('scenario.failed', { reason: withStack });
    complete(false, withStack);
  };
};
