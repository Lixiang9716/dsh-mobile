# Agent Note: loop-z2: the serving seat's timer seam was silent — wire timer.emitFn

Status: implemented

## Problem

The loop-u2 read-idle watchdog (#379) passed its 12-case panel suite and then
produced ZERO fires on the device: battery-r16 (release 105abafa, the
composer's serving seat) cut egress mid-stream for 6m17s and saw no TIMEOUT
class, no retry telemetry, no attempt 2/5 — the only warn of the whole probe
arrived 9m15s post-cut as TRANSPORT "Connection reset" (the socket's death at
network restore), and the retry banner then froze at "Retrying model request
(1/5) · 1s" for 8.5+ minutes until a manual `session/cancel` closed the turn.
The r14 black hole reproduced unchanged: 120s of wire silence armed a watchdog
that could not fire.

## Decision

The JS chain was sound end to end — the break was one Kotlin line that was
never written. On the serving seat, `SessionServe.kt` registered
`TimerPrimitive()` (SessionServe.kt:300) but never wired its `emitFn`, so
every `timer.fire` died inside `TimerPrimitive.kt:73`'s `emitFn?.invoke` —
silently, because an optional call cannot fail. The watchdog's budget rides
`setTimeout` → the timers shim → gateway `timerSchedule`/`timer.fire`
(upstream/shims/timers.js, contract v1.4.0, loaded in the serving boot via
web-shims.js:61); `llm-transport.js:307-348`'s guard armed at the first
streamed chunk and waited for a fire that the host never delivered. The M4
host wires all four event emitters (SpikeHostM4.kt:351-354); the serving seat
wired only `http.eventFn` — and the manual cancel DID unwind instantly, which
is the proof the guard was armed and its caller-abort bridge worked: only the
timer leg was dead.

Shipped:

- `SessionServe.kt` wires `timer.emitFn` with the same
  `SpikeRuntime.post { m4Event(...) }` hop as `http.eventFn` (the M4
  precedent), making the serving seat's timer seam deliver fires for the
  first time — this re-arms, at once, the read-idle watchdog, the dsh-llm-retry
  backoff (the frozen "1/5 · 1s" banner), the turn watchdog's ring 2, and
  every vendored deadline fuse on the seat users actually run.
- `upstream/shims/timers.js`: an arm the host refuses now reports LOUD through
  `__DSH_LOG_SINK__` (`arm/failed`, warn — release-visible) instead of an
  orphaned unhandled rethrow. The old `throw` could reach nobody — `setTimeout`
  hands back its handle synchronously — so a host without the seam starved
  every timer with zero trace; that silence is why r16 was diagnosable only by
  a 6-hour battery probe.
- `test/panel/timers-gateway-seam.test.js` (9 cases) pins the device timer
  seam the watchdog rides: arm → `timerSchedule` with the caller's delay
  intact (120000 unclamped), the callback runs ONLY when the fire event lands,
  both cancel races stay one-way, node's delay coercion holds, and a refused
  arm reports. The loop-u2 read-idle fixture was audited against the real
  gateway contract and stands (its `scriptedResponse` mirrors gateway.js's
  park-until-event + abort-wakes-read semantics).

Closure sync: android assets + harmony rawfile mirrors byte-identical
(`build/build.sh sync android` / `sync harmony`).

## Alternatives considered

- Re-arm the watchdog in JS without timers (a `Promise.race` sleep driven by
  microtasks, or polling `Date.now()` between reads): rejected — it would
  bypass the contract's one timer seam (v1.4.0), duplicate the host's wake
  machinery per consumer, and leave every OTHER timer consumer (retry backoff,
  ring 2, dsh-timeout fuses) starved on the seat. The seam was the defect.
- A JS-side watchdog over the watchdog (detect "armed but never fired" from
  the parser): rejected — it diagnoses the shadow, not the host gap, and adds
  a second timer to a seat whose timers do not fire.
- Also wiring `notify`/`ble`/`mic` emitFn on the serving seat (the same
  one-line class of gap, SessionServe.kt:294 registers NotifyPrimitive whose
  emitFn is likewise unwired): left OUT of this card — those surfaces need
  their own evidence (no observed failure yet), and one fix per card keeps
  the diff judgeable. Filed here as a flagged follow-up for the owner.
- iOS/harmony: NEITHER implements `timerSchedule` at all (GatewayCore answers
  `denied`), so on those hosts every `setTimeout` arm fails today — with the
  shim now reporting `arm/failed` loudly instead of dying silently. Arming the
  watchdog there needs the timer primitive implemented per host (Swift/ETS
  TimerPrimitive mirrors) — an owner decision, NOT covered by this card; until
  then the honest statement is: the watchdog cannot arm on iOS/harmony, and
  the seat now SAYS SO in the log instead of pretending.

## Consequences

- First-class behavioral change on the serving seat: timers work there now.
  Any latent code that armed timers and relied on them never firing becomes
  live; the panel + the device E2E (dev/android workflow, boots the serving
  spine) are the nets.
- `arm/failed` warn lines in logcat now mean the host's timer seam is broken
  (or absent, on iOS/harmony today) — treat them as a seat defect, not noise.
