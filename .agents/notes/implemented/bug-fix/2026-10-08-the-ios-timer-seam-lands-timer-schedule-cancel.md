# Agent Note: the iOS timer seam lands — timerSchedule/timerCancel on the last host without them

Status: implemented
Related: loop-z2 (#382, the Android twin), #395 (the Harmony twin), contract v1.4.0 §5

## Problem

The owner's first Release-session log capture (2026-10-08, 15 minutes on the
serve seat) recorded **160,247 `timerSchedule` denials** and one warn per
runtime — `setTimeout: the gateway timer arm failed — timers cannot fire on
this host`. Every JS timer hung forever: the llm transport's read-idle
watchdog, the retry pacing, every deadline fuse (upstream/shims/timers.js
arms through the gateway seam; contract v1.4.0 §5). iOS was the last host
with no implementation — the loop-z2 note said so outright ("iOS/harmony:
NEITHER implements timerSchedule at all"); Harmony fixed its half in #395.

The serving seat booted anyway (the boot path is timer-free; the settings
probes ride the microtask budget), which is exactly why this was invisible
until a real session: core flows work, every timed behavior silently
degrades.

## Decision

`TimerPrimitives.swift` (hosts/ios/App/Source/Gateway/) — the Android/
Harmony twin, in the Clipboard pattern (handler closures hold the instance
strongly, `core` is weak):

- `timerSchedule {delayMs, tag?}` clamps the delay into Int32 and arms a
  DispatchSourceTimer on a private serial queue, settling `{timerId}`
  immediately (the JS shim's sync-handle contract).
- The fire delivers `{"event":"timer.fire","timerId":N}` through
  `core.emit` — the session's existing emit hop (SessionRuntime:182) lands
  it on the runtime thread, so the §6 thread rule holds with zero new
  threading.
- `timerCancel {timerId}` is the idempotent one-way cancel (an unknown or
  already-fired id still settles ok).
- `GatewayCore.primitives` gains the two names — the RuntimeDescriptor
  derives its available array from that list (SessionRuntime's
  descriptorJSON), so the descriptor now reports them available with no
  second edit; the staged manifest already required them.

Verified live on the serve seat: boot clean, **0 timerSchedule denials**
(previously thousands within seconds), **0 `arm/failed` warns**, port up,
marketplace manifest syncing. The functional fire proof rides the native
card surface (its tick is a timer) — the next PR in the
create-approve-hotmount-native series.

## Alternatives considered

- **Re-arm the watchdog in JS without timers** (a `Promise.race` sleep):
  rejected in loop-z2 already — it would bypass the contract's one timer
  seam and duplicate the wake machinery per consumer.
- ** NSTimer on the main run loop**: the DispatchSource form keeps firing
  off the main thread and needs no run-loop management; the only
  cross-thread hop is the existing `core.emit`.
- **Report the primitives unavailable instead**: dishonest — the manifest
  requires them; the honest states are "implemented" or "descriptor says
  unavailable", and Android/Harmony set the precedent.

## Consequences

- First-class behavior change: timed behaviors (llm retry pacing, read-idle
  watchdog, deadline fuses) are now LIVE on the iOS serving seat — latent
  code that armed timers and relied on them never firing becomes active.
- The denials flood (≈10k audit lines/min) is gone, which also un-noises
  the audit stream for everything else.
