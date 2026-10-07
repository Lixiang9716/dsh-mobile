// dsh:logging-exempt (adapter seam: no emission here)
/**
 * llm-retry-pacing — seam-side PACING for transport-class FAST failures
 * (loop-c2).
 *
 * The battery-r18 field round (w1-retry-lines.txt, v1-timeline.txt) exposed
 * the layer under the loop-u2 watchdog: once an attempt is cut (read-idle
 * TIMEOUT at t0+120.4s), the vendored dsh-llm-retry rhythm runs its own
 * defaults (initial 500ms, ×2, jitter — llm@lib DEFAULT_INITIAL_DELAY_MS) —
 * right-sized for an ONLINE provider hiccup, useless offline. Every
 * following attempt died at the DNS resolver / proxy connect in 0.5-4s
 * ("Unable to resolve host", "Failed to connect to /10.0.2.2:7890"), so the
 * whole 5-retry budget burned in ~7s and the turn ERRORED at t0+136s — two
 * minutes before the network came back (t_restore = t0+255s). The ask's
 * expectation "attempt 2/5 at ~4-5min" needs the attempts SPREAD across the
 * outage, and the vendored loop has no backoff input: `Config = z.object({})
 * (llm-retry@lib index.js:24), the rhythm is policy-internal.
 *
 * The wire point is the vendored contract itself, not a seam-side sleep:
 * 1. `LlmError(message, code, { providerRetryAfterMs })` — a first-class
 *    constructor option (llm@lib index.js:1599) carried on `failure`, and
 *    dsh-llm-retry's recover() adopts it VERBATIM as the wait when it is
 *    present, positive, and finite (llm-retry@lib index.js:168-172) — the
 *    same channel a provider's Retry-After rides. The failure object is
 *    OURS (this seam raised TRANSPORT), so the seam stating "wait this
 *    long" is the channel working as designed. A seam-side sleep instead
 *    would stack under the vendored localDelay, hide the cadence from the
 *    journal's llm/retry delayMs and the UI banner, and hold the attempt
 *    "running" with no guard armed — the invisible-stall shape loop-u2
 *    removed. Rejected for those reasons.
 * 2. `LlmAdapter.providerRetryPolicy()` — the registration hook
 *    (llm@lib index.js:1653-1659) whose resolved policy the runtime attaches
 *    to every agent/request-error payload. It must widen `maxDelayMs` to the
 *    widest slot: recover()'s give-up clause returns next() (NO retry at
 *    all) when providerRetryAfterMs exceeds policy.maxDelayMs
 *    (llm-retry@lib index.js:169), so an unraised default (10s) would turn
 *    every paced failure into instant budget starvation. Within a 5-retry
 *    budget the local exponential never reaches the raised cap (0.5s×2^k ≤
 *    8s), so the unpaced rhythm is bit-identical to before.
 *
 * Scope: TRANSPORT-class failures that failed FAST (under
 * FAST_TRANSPORT_FAIL_MS) — the offline reflex (instant DNS/NXDOMAIN,
 * proxy ECONNREFUSED). Slow failures stay unpaced: a read-idle TIMEOUT
 * already spent 120s of patience, and a slow connect is self-pacing —
 * both keep the snappy vendored rhythm so online recovery never loses
 * its meaning. Non-TRANSPORT codes (SERVER, RATE_LIMIT, …) are not this
 * seam's to pace. The honest budget stands: pacing only spaces the
 * attempts; the 5-retry ceiling and the exhausted-budget error are the
 * vendored loop's, and loop-u's turn-recovery still backstops the
 * queued followups.
 */

/** An attempt that failed TRANSPORT under this long is an offline-reflex
 * failure (the r18 fast fails took 0.5-1s; a real connect timeout spends
 * seconds-minutes). Failures at or over it are "slow": unpaced, and the
 * escalation resets. */
export const FAST_TRANSPORT_FAIL_MS = 5_000;

/** The pace slots for consecutive fast transport failures, in strike order.
 * ×3 geometric, capped at the read-idle budget (one guard family with
 * loop-u2's 120s): 15s absorbs a sub-15s blip (DNS blip, router failover)
 * in one retry; 45s and 120s hold the later attempts across multi-minute
 * cuts. A 5-retry chain fast-fails at most four times (the first gap
 * belongs to the initial failure's own delay; the last fast failure
 * exhausts the budget), so strikes 0..3 consume 15/45/120/120 — the chain
 * spans ~t0+300s of an outage vs ~7s before this module. Each scheduled
 * retry's llm/retry journal append re-arms ring 2 (loop-u2), and 120s <
 * ring 2's 300s silence budget, so no paced wait can starve the turn
 * watchdog. */
export const FAST_TRANSPORT_PACES_MS = Object.freeze([15_000, 45_000, 120_000]);

/** The widest slot — also the `maxDelayMs` the route's retry policy is
 * resolved with (the give-up-clause guard above). */
export const FAST_TRANSPORT_MAX_PACE_MS = FAST_TRANSPORT_PACES_MS[FAST_TRANSPORT_PACES_MS.length - 1];

/** Quiet time after the last fast failure that starts a new outage
 * episode: wider than any live chain's pacing spine (the widest slot plus
 * the vendored delays), so a fresh turn minutes later re-earns the short
 * slots instead of inheriting a burnt ladder. Within a live chain the
 * gaps are the slots themselves (≤120s) — never mistaken for an episode
 * break. */
export const FAST_TRANSPORT_EPISODE_MS = 3 * FAST_TRANSPORT_MAX_PACE_MS;

/** One pacer per adapter (per provider route). `pace(durationMs)` classifies
 * one failed attempt and answers the wait the vendored loop should honor:
 * the next slot for a FAST transport failure (strikes escalate, clamped at
 * the widest slot), or `undefined` — leave the failure unpaced — for a slow
 * one (which also resets the ladder). Time decay between calls restarts the
 * ladder when the outage episode has gone stale. `now` is injectable for
 * tests; the production clock is Date.now (the dsh runtime has it). */
export const makeFastTransportPacer = ({ now = Date.now } = {}) => {
  let strikes = 0;
  let lastStrikeAt = 0;
  return {
    pace(durationMs) {
      const at = now();
      if (lastStrikeAt !== 0 && at - lastStrikeAt > FAST_TRANSPORT_EPISODE_MS) strikes = 0;
      if (durationMs >= FAST_TRANSPORT_FAIL_MS) {
        strikes = 0; // a slow failure is its own pacing; start over
        return undefined;
      }
      const paceMs = FAST_TRANSPORT_PACES_MS[Math.min(strikes, FAST_TRANSPORT_PACES_MS.length - 1)];
      strikes += 1;
      lastStrikeAt = at;
      return paceMs;
    },
  };
};
