# Agent Note: the event-channel proposal — channelOpen/channelClose over a closed source table (v1.6.0 candidate)

Status: implemented
Related: D5

## Problem

The contract's §5 has three fixed channels (`app.state`, `notify.response`,
`timer.fire`) and no way to carry a device data stream. The v1.5.0 fold's own
Alternatives section deferred exactly this ("CoreMotion event streams would
also need a channel shape like `timer.fire` — a good v1.6.0 candidate once
there is a consumer"). The consumers now exist: the render-surface proposal
(v1.7.0 candidate) specifies its frame pump and input stream ON the seam, and
the upstream agent cannot read motion or battery-over-time at all. Without a
contract shape, per-source ad-hoc primitives or a global event emitter would
grow into a second, un-governed surface.

## Decision

`contract/proposals/2026-09-26-event-channel.{md,zh.md}` proposes (DRAFT,
v1.6.0 candidate) a two-primitive pair — `channelOpen(source, opts)` (resolves
when armed, the `timerSchedule` posture; per-caller live-subscription cap;
`hz` host-clamped for motion) and `channelClose(channelId)` (idempotent, the
`timerCancel` shape) — over a closed, versioned source table (`motion`,
`battery`), delivering on the §5 `channel.event` channel. Two load-bearing
delivery rules: latest-wins coalescing under load with `seq` gaps visible
(the `surfaceDraw` sequence rule generalized — degrade rate, never grow a
queue), and no delivery while suspended (D7: checkpoint carries sessions,
never live subscriptions). Permission flag `channel`. Audit honesty is stated
per the `ishRun` rule: events are NOT audited per record; the open/close
records plus `seq` continuity are the trail. Sources needing OS permission
prompts (location/camera/mic/activity) are explicitly out.

## Alternatives considered

- One primitive per source: rejected — N primitives for one shape; the source
  table is the versioned surface.
- Polling (`motionRead()` per frame): rejected — D8 (battery, sampling
  races); would make the render surface's pump a polling loop in disguise.
- A general `onEvent(handler)` global: rejected — a second, un-governed
  surface (the v1.4.0 no-global-`setTimeout` reasoning).
- Folding into the render-surface proposal: rejected — the surface depends on
  the seam, not vice versa; separate folds keep reviews the size of their own
  ideas and let sources land without UI dependencies.
- Permissioned sensor sources now: rejected — the device plane's curation
  rule; each OS permission lifecycle deserves its own design round.
