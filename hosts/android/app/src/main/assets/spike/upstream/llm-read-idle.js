// dsh:logging-exempt (adapter seam: all emission rides caller-provided hooks)
/**
 * llm-read-idle — the attempt-level READ-IDLE watchdog for the gateway LLM
 * transport (loop-u2; the W-LLM leg's stall ring, after tool-deadline's
 * ring 1 and turn-watchdog's ring 2).
 *
 * The battery-r14 field rounds proved the gap twice: a socket that
 * black-holes mid-attempt (airplane mode) parks the transport's read side
 * on the gateway bridge forever — last stream frame 18:49:44, the
 * Connection reset surfaced 8.6 minutes later, `llm/retry 1/5` fired, and
 * the RETRY's own attempt froze for good (no turn/end, retries never
 * advanced, queued followups stranded). Ring 2's cancel cannot unwind that
 * await: the pre-fix parser observed the caller's abort signal only after a
 * chunk ARRIVES, and a byteless stall delivers none.
 *
 * One guard per attempt, two arms, both ending in `response.abort()` — the
 * one primitive that unwinds a read parked on the gateway bridge (abort
 * marks the stream errored and wakes the parked nextChunk):
 * - READ-IDLE: `idleTimeoutMs` of wire silence aborts the attempt; the
 *   parser maps the fired flag to the RETRYABLE TIMEOUT code, so
 *   dsh-llm-retry's 1/5..5/5 rhythm runs and an exhausted budget errors the
 *   turn (loop-u's turn-recovery continues the followups).
 * - CALLER-ABORT BRIDGE: the caller's signal aborts are bridged to
 *   response.abort() EAGERLY. Maps to the non-retryable ABORTED code — a
 *   deliberate cancel (ring-2 watchdog, user stop) must not retry.
 *
 * The default budget sits in the #326 guard family: ≥ the measured
 * legitimate lull (the seat's own time-to-first-byte was 38.1s —
 * battery-r14 w1b-follow-frames.log — so 120s keeps ~3× headroom), < ring
 * 2's 300s silence budget (a stall must resolve as the retryable leg, not
 * ring 2's non-retryable cancel; each retry's llm/retry journal append
 * re-arms ring 2), and numerically ring 1's per-tool budget. Worst case for
 * a sustained black hole: 6 attempts × 120s + ~35s of retry backoff ≈
 * 12.5 min to an honest errored turn (vs forever before this guard).
 */

/** The default read-idle budget (see the module rationale above). */
export const DEFAULT_READ_IDLE_TIMEOUT_MS = 120_000;

/** Validate the configured budget (rule 5: a bad config is a defect now). */
export const parseReadIdleTimeoutMs = (value) => {
  if (value === undefined) return DEFAULT_READ_IDLE_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `llm-read-idle: readIdleTimeoutMs must be a positive finite number, got ${JSON.stringify(value)}`);
  }
  return value;
};

/** Arm one attempt's guard over `response` (the gateway httpFetch shape:
 * an abortable streaming body). `signal` is the caller's abort signal —
 * optional; absent, only wire silence disarms the attempt. Lifecycle: the
 * guard is armed on construction, re-armed by `touch()` (a delivered chunk
 * is wire liveness), paused around consumer-side yields (the budget
 * measures the WIRE, not consumer pace), and retired by `dispose()` in the
 * parser's finally. `fired` is sticky once the budget lapses — the attempt
 * is dead regardless of a racing last chunk. */
export const makeReadIdleGuard = (response, idleTimeoutMs, signal) => {
  let timer = null;
  let fired = false;
  const onCallerAbort = () => response.abort?.();
  const arm = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      response.abort?.();
    }, idleTimeoutMs);
  };
  const disarm = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  if (signal === undefined) arm();
  else {
    // an already-aborted signal never fires its listener again
    if (signal.aborted) onCallerAbort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
    arm();
  }
  return {
    touch: arm,
    pause: disarm,
    get fired() {
      return fired;
    },
    dispose() {
      disarm();
      signal?.removeEventListener('abort', onCallerAbort);
    },
  };
};
