# Proposal: the event channel seam — device sources over one subscription primitive (v1.6.0 candidate)

> **Status: DRAFT (D5 proposal — nothing frozen, nothing implemented).**
> English | [简体中文](2026-09-26-event-channel.zh.md)

## Motivation

The contract has three fixed event channels (§5: `app.state`, `notify.response`,
`timer.fire`) and one device-source class it cannot carry at all. The
device-plane proposal (v1.5.0, folded) named the gap in its own Alternatives
section: *"CoreMotion event streams would also need a channel shape like
`timer.fire` — a good v1.6.0 candidate once there is a consumer."* The
consumer now exists twice over:

1. **The render surface** (`2026-09-26-render-surface.md`, v1.7.0 candidate)
   is specified ON this seam: its `surface.frame` pump and `surface.input`
   stream are channels, not calls — D8 forbids polling, and a render loop is
   the densest event producer in the system.
2. **The agent itself.** Asked about the device's motion, orientation or
   battery over time, the upstream agent can only answer from a one-shot
   `deviceInfo`. A game it authors cannot read tilt at all.

This proposal is the contract-first shape (D5) of the fix: **one subscription
primitive pair** over a closed, versioned source table — not one primitive per
source, and never a second, un-governed event surface.

## The primitives (two, plus one channel)

All follow the additive rule of v1.1.0–v1.5.0: a `gateway@1` host without the
seam keeps negotiating and answers each `unavailable`.

### 1. `channelOpen` — subscribe to a source (permission `channel`)

```ts
export type ChannelSource = "motion" | "battery";
export declare function channelOpen(source: ChannelSource, opts?: {
  hz?: number;      // motion only; host clamps to its declared range
  tag?: string;     // caller-chosen audit tag, the timer precedent
}): Promise<{ channelId: number }>;
```

Resolves when the subscription is **armed**, not when data flows — the
`timerSchedule` posture exactly. `channelId` is an opaque integer, unique
among live subscriptions. A second `channelOpen` on the same source is a new
subscription (fan-out is legal); v0 caps live subscriptions per caller at a
host-declared small number and rejects the rest as `invalid`.

### 2. `channelClose` — unsubscribe (permission `channel`)

```ts
export declare function channelClose(channelId: number): Promise<{ closed: boolean }>;
```

Idempotent, the `timerCancel` shape: `{ closed: false }` for an unknown or
already-closed id.

### Channel: `channel.event` (host → plugin, §5 table extension)

`{ channelId, source, seq, payload }` — delivered onto the caller's serial
queue like every host event. Payloads are **per-source closed schemas**
specified at fold time in `data-protocols.md`: `motion` carries a timestamped
acceleration/rotation sample; `battery` carries level and state on change.
Two load-bearing delivery rules:

- **Latest-wins under load, with visible gaps.** If the serial queue falls
  behind, the host coalesces pending samples and delivers the newest,
  advancing `seq` past the dropped ones. A consumer that cannot keep up
  degrades to a lower *effective* rate with honest sequence numbers — never
  to a growing queue (the `surfaceDraw` sequence-number rule, generalized).
- **No delivery while suspended.** A backgrounded host pauses delivery and
  says so in its descriptor prose; D7's checkpoint carries sessions, never
  live subscriptions — the caller re-opens after resume.

## Permission and audit summary

| primitive / channel | permission flag | approval | audit payload |
| --- | --- | --- | --- |
| `channelOpen` | `channel` | — (sources with OS permission prompts are out of scope, see §8) | source + hz + tag |
| `channelClose` | `channel` | — | channelId |
| `channel.event` | (arm state) | — | **not audited per event** — see the honesty note |

**Audit honesty (the `ishRun` rule, §6/§7).** Per-event audit does not exist
and must not be pretended: a motion stream at host-clamped rates produces more
records per second than any audit sink should carry. The trail is the
open/close records plus the `seq` continuity the consumer observes. A host
offering this primitive states in its descriptor that event *delivery* is not
per-call audited — the flag gates the *subscription*, which is the control.

## Host availability at fold time

iOS implements both sources (CoreMotion device motion — no OS permission
prompt for unfiltered accelerometer/gyro — and battery via
`UIDevice.batteryState` notifications); Android maps both (`SensorManager`
and sticky `BatteryManager` broadcasts); HarmonyOS maps both (the sensor and
battery-info kits). **No host is REQUIRED to implement any source** — the
descriptor is the difference, and there is no `hostType` branch anywhere.

## Alternatives considered

- **One primitive per source (`motionRead`, `batteryWatch`, …)** — rejected:
  N primitives for one shape; the source table is the versioned surface, the
  primitive pair is stable across it.
- **Polling (`motionRead()` per frame)** — rejected outright: D8 (wasted
  battery, sampling races), and it would make the render surface's frame
  pump a polling loop in disguise.
- **A general `onEvent(handler)` global** — rejected: a second, un-governed
  surface (the same reasoning that refused a global `setTimeout` in v1.4.0);
  every stream must be an opened, refusable, auditable subscription with a
  closed source table.
- **Folding this into the render-surface proposal** — rejected: the surface
  depends on the seam; the seam does not depend on the surface. Ordering the
  channel first keeps each fold's review the size of its own idea, and lets
  sources (motion, battery) land without any UI dependency.
- **Sensor sources that demand OS permission prompts (location, camera,
  microphone, activity)** — explicitly out: the device plane's curation rule
  applies, and each permission lifecycle deserves its own design round (§8
  of the v1.5.0 fold). `motion` here is the un-permissioned device-motion
  class only.

## Evidence base

The demand is recorded in the v1.5.0 fold itself (the Alternatives deferral
quoted above), and the consumer is specified: the render-surface proposal's
`surface.frame`/`surface.input` channels are this seam's first callers, and
the canvas-game E2E leg in flight is the first end-to-end run that motivates
a frame pump at all. The upstream agent's own behavior supplies the rest: it
asks about device motion and battery over time and has no primitive to read
either.
