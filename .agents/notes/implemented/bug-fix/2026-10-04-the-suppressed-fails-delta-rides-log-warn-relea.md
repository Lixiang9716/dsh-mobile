# Agent Note: the suppressed fail's delta rides log.warn — a new failure class stays release-visible

Status: implemented

## Problem

#366 (loop-q) made the scenario's `fail()` first-only, and that trade was
right: the completed-fail verdict is sticky — `js_complete` keeps the reason
in the host's error slot (dsh_spike_host.c:448), every later bus crossing
re-derives status 2 from the completed flag (`m4_status`,
dsh_spike_m4.c:206), and the seat's `runtimeFailed` gate
(SessionServe.kt:468) dropped the per-frame re-reports that churned 14,037
logcat lines. But the JS-side gate (composer-web-live's `scenarioFailed`)
swallowed ALL later `fail()` calls, including ones whose message differed
from the recorded verdict — a genuinely NEW failure class. That delta was
invisible on every observable: the JS gate dropped it before
`__dshComplete`, the Kotlin gate would drop the re-report anyway, and the
release strip (logging rule L4) removes debug/info — the levels the
canonical record rides. A second, different defect after the first verdict
left no trace in a release build's log.

## Decision

The fail gate moves to `scenario/scenario-verdict.js` (`makeFailGate`,
split from composer-web-live.js like the probe waiter at loop-q) and keeps
first-only for the verdict, but a suppressed call whose message was never
seen emits ONE `log.warn` naming both messages (`recorded` + `reason`) —
warn is in `RELEASE_CRITICAL_LEVELS` (runtime/spike/logger.js:30), so the
delta survives the release strip. Once per DISTINCT message: the same
message repeating stays silent forever, so the demand fail-then-throw
double landing (one message, two calls) remains exactly the one verdict
#366 shipped, and a repeating new message cannot start a warn storm.
composer-web-live.js wires the factory with `log`, `emit`, and a late-bound
`complete` (the drive injects `__dshComplete` after eval); the Kotlin gate
and the C host are untouched. Panel suite pins all three faces: the first
verdict byte-verbatim (debug + `scenario.failed` event + `complete(false,
message|short-stack)`), same-message repeats silent, a different message
exactly one warn carrying both strings (6 new tests; suite 215/215).

## Alternatives considered

- Warn on EVERY suppressed call (no per-message memory): simpler, but a
  repeated different message recreates a (smaller) storm in release logs —
  the exact shape #366 exists to prevent; per-distinct-message costs one
  line per failure class, which is the operator signal L4 keeps warn/error
  for.
- Fix at the Kotlin gate (SessionServe.fail compares messages): the re-report
  only ever carries the FIRST verdict (js_complete's error slot), so the
  Kotlin side can never see the delta — the suppression happens in JS before
  the host; no seat-side comparison can recover a message that never crossed.
- Also strip the stack from the comparison key: rejected — the message IS
  the identity here; the demand double landing shares one message by
  construction, and two distinct failures with byte-identical messages are
  one class for logging purposes anyway.
