# Agent Note: the device-plane proposal — six platform-SDK primitives for the contract's next minor

Status: implemented
Related: D5

## Problem

The owner's third directive (2026-09-26, after the Android and HarmonyOS
ports) is to bring the iOS system SDK functions into the system plugin.
The gateway architecture makes "adding SDK surface" a contract question
before it is a code question (D5: contract first — never reach around the
gateway), and the existing sixteen primitives cover storage, network,
secrets, presentation, and compute but none of the platform's device
surface. The creation-mode clients supplied the concrete demands: the
fullscreen whale viewer wants the screen held awake, the agent cannot
report device facts, give haptic feedback, hand a deliverable to another
app, or touch the clipboard.

## Decision

A D5 proposal lands at
`contract/proposals/2026-09-26-device-plane.md` (+ zh pair + pairing
record) — a **v1.5.0 candidate** with six primitives and one extended
shape, all following the additive rule of v1.1.0–v1.4.0 (`gateway@1`
hosts answer `unavailable`):

- `deviceInfo` (read-only facts, no permission flag; battery omittable
  where the OS hides it);
- `haptic` (permission `haptic`; seven patterns across UIKit's three
  feedback generators);
- `clipboardRead`/`clipboardWrite` (permission `clipboard`; **read is
  approval-gated by default** — the keychain's "secrets leave only
  through governed calls" rule applied to the pasteboard; the audit never
  carries the text);
- `presentShare` (permission `share`; the system share sheet IS the trust
  boundary — the host learns completion, never the destination; file
  payloads resolve through the fs scope discipline);
- `keepAwake` (permission `screen`; a boolean latch, not a lease);
- `presentPicker` gains `mode: "media"` (the platform media picker
  returning a scope handle — read-through-scope, no library access).

Deliberately OUT: location, camera, microphone, sensors, contacts, full
Photos access — each demands an OS-permission lifecycle round of its own,
and CoreMotion streams need a `timer.fire`-shaped channel (a v1.6.0
candidate once a consumer exists). Also rejected: a generic
`system.callService(name, args)` grab-bag (a second un-governed surface —
the same reasoning the contract used to refuse a global `setTimeout`).

## Alternatives considered

- **Implement first, contract later** — refused: D5 is the repo's first
  non-negotiable constraint; an implementation PR without a frozen shape
  would be reach-around.
- **One `device` primitive returning everything plus actions** — rejected:
  capabilities must be individually refusable and auditable; a grab-bag
  primitive hides which capability a call exercised.
- **Clipboard read without approval** — rejected in the strongest terms:
  that gate is the entire difference between "the agent can read what you
  copied" and "…once, with your knowledge".

## Consequences

The proposal is the first artifact of the iOS system-SDK work (task card
T-0065's contract step); the fold into `primitives.{md,d.ts}` + schemas
and the iOS privileged-layer implementation follow as their own changes
once the proposal's shapes settle. Nothing frozen, nothing implemented —
exactly what `contract/proposals/` exists for (the timer proposal's
precedent: proposal → fold → implementation, each its own review).
