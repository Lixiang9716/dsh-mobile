# Agent Note: the v1.5.0 device plane — six platform-SDK primitives folded into the frozen contract

Status: implemented

## Problem

The iOS host ships sixteen gateway primitives covering storage, network,
secrets, presentation and compute, but none of the platform's own device
surface. The creation-mode clients made the gap concrete on all three hosts:
the fullscreen whale viewer wants the screen held awake while it is open, the
agent cannot answer "what device am I on", cannot give haptic feedback, cannot
hand a deliverable to another app (the share sheet), and cannot read or write
the clipboard. The owner's directive (2026-09-26) was to bring the system SDK
functions into the hosts as a contract-first round (D5): the proposal landed
as `33fb61b` and this change folds it.

## Decision

The proposal is folded and frozen as **contract v1.5.0** (additive minor, §8):
`deviceInfo` (read-only facts, no flag), `haptic` (one cue per call, `haptic`
flag), `clipboardRead`/`clipboardWrite` (`clipboard` flag; read is
approval-gated by default through the `presentApproval` surface and its audit
never carries the text), `presentShare` (`share` flag; the sheet is its own
consent and the host learns only completion, never destination), `keepAwake`
(`screen` flag; a boolean latch, not a lease), and the extended shape
`presentPicker` `mode: "media"` (read-through-scope over what the user picked,
never library access). The deferred-candidates list in §8 loses clipboard and
the share sheet to the table; location/camera/sensors and a `deviceEvents`
stream stay deliberately out (each demands its own OS-permission lifecycle
round). A generic `system.callService` grab-bag stays rejected — every
capability must be a named, refusable, auditable primitive.

## Alternatives considered

- **One `system.*` RPC grab-bag (`callService(name, args)`)** — rejected in
  the proposal and upheld: a second, un-governed surface, the same reasoning
  that refused a global `setTimeout` for v1.4.0.
- **Location / camera / microphone / sensors in the same round** — deferred:
  each demands an OS permission prompt whose lifecycle (granted in Settings,
  revoked mid-session) deserves its own design round; none blocked the
  creation-mode work this plane serves. CoreMotion-style event streams would
  also need a channel shape like `timer.fire` — a v1.6.0 candidate once a
  consumer exists.
- **Clipboard read without approval** — rejected: the approval gate is the
  difference between "the agent can read what you copied" and "the agent can
  read what you copied, once, with your knowledge".
