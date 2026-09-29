# Agent Note: the system capability plane proposal — camera, microphone, and BLE behind one OS-permission model

Status: implemented
Related: D5, D8

## Problem

The contract reserved an OS-permission design round twice: the v1.5.0 device-plane
fold deferred "location, camera, microphone, sensors, contacts and full
Photos-library access" (primitives.md §8), and the v1.6.0 event-channel
proposal excluded OS-permissioned sources from its closed table for the same
reason. An agent on any host still cannot see (capture), hear (stream audio),
or reach (BLE) — the media picker only reaches hand-picked photos, and the
delivery seam exists without the capability layer under it. The owner
directive (2026-09-30) decided the round: all three families in v1, full
surface, with camera's continuous stream and video recording phased in shape
but not cut.

## Decision

A D5 proposal lands at
`contract/proposals/2026-09-30-system-capability-plane.md` (+ zh pair + pairing
record) — a **v1.10.0 candidate** (verified: frozen v1.5.0, drafts v1.6.0–v1.9.0
on record, so v1.10.0 is the next free additive number). v1 surface:

- **Camera**: `cameraCapture` (burst) as the v1 implementation face, photos
  landing in the host's capture scope (the media-picker read-through posture);
  continuous frames ride the v1.6.0 seam as a `channelOpen` `"camera"` source
  and video recording as `cameraRecordStart`/`Stop` — both shapes specified,
  implementations phased.
- **Microphone**: `micStart`/`micStop` + a `mic.frame` channel, the forkpty
  precedent (dedicated control face over the seam's delivery rules), with the
  seam's coalescing rule honestly adapted to drop-oldest (audio is
  order-sensitive) and visible `seq` gaps.
- **BLE**: eight calls (scan/connect/GATT read-write-subscribe) + a `ble.event`
  channel; Classic Bluetooth is a named non-goal.

Authorization reuses the v1.5.0 family-flag mechanism with three new sibling
grants (`camera`/`microphone`/`ble`), two consent layers with the gateway
prompt FIRST and the OS prompt second (the audit names which layer refused),
session-scoped by default with live settings-face revocation, and per-call
audit records extended with direction/duration/byte counts — never payload
bytes. The appendix pins the three-host OS declaration checklist (iOS
`NS*UsageDescription` keys, Android runtime permissions, Harmony
`module.json5`), grounded in the repo's current state: no host declares any of
them today. The v2 queue (location, sensors, contacts, full Photos) is named,
not designed.

## Alternatives considered

- **A grab-bag `systemCapture(action, args)` primitive** — rejected in the
  strongest terms (the device-plane's own rule): capabilities must be
  individually refusable and auditable.
- **Microphone and BLE as `channelOpen` sources only** — examined and
  rejected: the seam's `{ hz, tag }` opts cannot carry an audio format, a scan
  filter, or a GATT tuple; the forkpty face is the precedent for a dedicated
  control face over the seam's delivery rules.
- **Photo bytes through the gateway response** — rejected: payload bytes ride
  the fs scope discipline (media-picker precedent); the audit carries counts,
  never pixels.
- **Waiting for v2 to design all six families at once** — rejected: three
  families have standing demand and a settled delivery seam; the queue stays
  queued.

## Consequences

The proposal is the stack base for three implementation lines (camera,
microphone, BLE), each landing per family with per-platform manifests and
E2E-by-logs scenarios; negotiation floors answer `unavailable` until then, so
no current behavior changes. The contract/README proposal list gains the
fifth draft.
