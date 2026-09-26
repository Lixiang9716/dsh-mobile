# Agent Note: contract v1.5.0 — the device plane folds in (six primitives + media picker mode)

Status: implemented
Related: D5

## Problem

The device-plane proposal (`contract/proposals/2026-09-26-device-plane.*`, #222)
sat as a DRAFT while the creation-mode clients it serves are already on all
three hosts: the fullscreen viewer wants the screen kept awake, the composer
cannot hand a deliverable to another app, and the upstream agent asks for
device facts it cannot obtain. D5's pipeline is proposal → fold → implementation,
each its own review — every day the fold lags, host implementations start from
a moving contract.

## Decision

The proposal folds into the contract per the v1.4.0 (timer) precedent:
`contract/primitives.{md,zh.md}` carry the v1.5.0 changelog blockquote, the
table rows #19–24, the §4 "the device plane" semantics (the curation rule, the
clipboardRead default approval gate, the share sheet's learn-nothing posture,
keepAwake's boolean latch, the `mode: "media"` picker extension and its
read-through-scope rule), and a §8 deferred list that drops the two delivered
names; `primitives.d.ts` carries the typed surface (DeviceInfo, HapticPattern,
SharePayload, the six declarations, the `PickerRequest` mode extension); the
device-plane proposal trio is deleted; `contract/README.md` rows follow.
`runtime/spike/gateway.js` gains the six call exports and
`runtime/spike/manifest.json` the four capability flags (`haptic`,
`clipboard`, `share`, `screen` — `deviceInfo` is flagless); the three host
closures are re-synced byte-identically. The fold also corrects a v1.4.0
omission: `timerSchedule`/`timerCancel` had semantics and a channel but no
§2 table rows — they are recorded now as #17–18, shapes unchanged. No host
implementation ships here: the iOS/Android/Harmony descriptors still list what
they offer and callers negotiate the rest — that is the additive rule working.

## Alternatives considered

- Keeping the proposal as DRAFT until implementations are ready: rejected —
  D5 freezes the contract before implementation code; the fold IS the freeze
  step, and the host PRs that follow review against a fixed table.
- Numbering the device primitives #17–22 (continuing from the last existing
  row): rejected — the table's own sequence left the timer primitives
  unnumbered; recording them as #17–18 first keeps the d.ts banner numbers
  (`17 · timer`) and the table consistent instead of codifying the gap.
- Bumping to v2.0.0: rejected — no frozen shape changes; §8's minor rule
  (adding primitives, optional request fields) is exactly this fold.
