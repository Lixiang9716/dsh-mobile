# Agent Note: the v1.4.0 timer seam — contract frozen, Android host live, the loop suite fully green on the emulator

Status: implemented

## Problem

The vendored upstream runtime calls bare `setTimeout` (dsh-timeout arms a
deadline fuse per await race); the spike runtime deliberately had no timer
surface, so 22 suite tests failed `setTimeout is not defined`, 2 hung
awaiting a fuse-armed abort, and 100+ corpus specs were excluded at
transpile time purely because fake timers / vi.waitFor presume a clock
exists. The proposal (round two of the gap-fill loop) argued the timer is a
capability — a future host re-entry onto the serial queue — that belongs in
the gateway, not a global polyfill.

## Decision

The proposal is folded and frozen as **contract v1.4.0** (additive minor,
§8): `timerSchedule(delayMs, opts?) → {timerId}` arms one wake-up and
resolves when ARMED; `timerCancel(timerId) → {cancelled}` is idempotent;
the fire arrives on the new `timer.fire` event channel (§5), delivered onto
the serial queue — never a second thread (D2), never blocking (D8); one
`timer` permission flag gates both rows; NO global `setTimeout` in the
contract — the mapping is the shim's. Implementation: gateway.js carries
the two rows; `upstream/shims/timers.js` installs the ambient globals and
bridges the synchronous-handle idiom onto the async pair (a cancel that
beats the arm resolves through the idempotent one-way race); Android's
`TimerPrimitive` schedules on the main-looper Handler, settles arm-first
(strict enqueue order before any fire), and the fire/cancel race resolves
at exactly one map removal — never both; the manifest gains the timer
grants. The harness gains **fake timers** over the seam's own globals
(`useFakeTimers/advanceTimersByTime/runAllTimers/runOnlyPendingTimers`,
module-split for the file-size gate), and the transpiler's timer-class
exclusions are REMOVED (583 transpiled, +47 vs before; wall-clock mocking
stays excluded — the seam is monotonic-only). Measured on the emulator:
loop.spec **65/65** (was 63/65 — the two timer survivors now pass through
the real seam), and the core batch's fresh tally rides the artifacts.

## Alternatives considered

- **A global setTimeout polyfill in the host** — rejected by the proposal
  and upheld: no negotiation, no audit, no permission gate; a global
  surface can never be reclaimed.
- **Timers as notify with an empty payload** — rejected: notify is the
  user-visible permission story; invisible wakes would pollute it.
- **sleep()-only primitive** — rejected: cannot express arm-then-cancel
  watchdogs, which is precisely the suite's hang class.
- **Keep excluding the timer classes** — rejected as terminal: the class
  was the largest exclusion bucket and hid the agent loop's abort fuses.
