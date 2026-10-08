# Agent Note: the native card surface — PR-1 of the create-approve-hotmount-native loop

Status: implemented
Related: contract v1.4.0 §5 (the timer seam this leg doubles as proof for), the pomodoro task card

## Problem

The owner's product bar for plugin creation is explicit: a chat prompt
("生成番茄时钟插件") must end with the plugin manifesting in the APP'S OWN
chrome — real cordis plugin code, live-loaded, NATIVELY rendered — "不是
html 页面". Nothing on iOS rendered plugin UI natively: the creation flow's
end state was a fullscreen web viewer of an html artifact, and the Harmony
twin (CardPlayer.ets) renders into the whale web view. iOS needed both the
rendering surface and the contract a plugin speaks to it with.

## Decision

The plugin card contract rides BUS EVENTS — no new gateway primitives: a
plugin posts `card.present {card:{id,kind,title?,subtitle?,durationMs?}}`,
`card.state {id,state:{remainingMs?,label?}}`, `card.dismiss`, or
`card.complete {id,message?}` on the same `__dshBusPost` seam
`settings.probes.done` already rides. SessionServe forwards them to a new
`onCardEvent` hook; `CardPlayerSurface` (UIKit, a floating card over the
window with title, monospaced countdown, progress bar, subtitle) renders
them. Timer cards tick LOCALLY between authoritative `card.state` patches
(once-per-second plugin ticks render a smooth 4Hz countdown; a dropped tick
resnaps on the next patch).

The verification vehicle is the `-dsh-mode card-player` drive leg: the
serving seat with `scenarioEntry` overridable (the composer product boot
stays the default — the seat the manifests prove and the path a user runs
cannot drift apart) and `scenario/card-player.js` selected — a scenario
that presents a 25:00 pomodoro, ticks five times in a one-shot
`timerSchedule` re-arm loop (NO setInterval — the contract is one-shot),
and completes. The leg doubles as the iOS timer primitive's first
functional proof: every tick is a real arm+fire pair.

Verified end-to-end on dsh-iphone (2026-10-08): the native card renders
(screenshot evidence — 番茄时钟 · 专注, live countdown, progress bar),
`e2e: PASS card.player (11/11 events, in order)`, zero timer denials.

## Alternatives considered

- **Render the card in the web client** (the whale-view CardPlayer twin):
  rejected — the owner's explicit bar is the app's own chrome, not an HTML
  page; the web client is also a replaceable plugin (D8) and the card
  surface must survive client swaps.
- **A new gateway primitive (`cardPresent`)**: rejected for PR-1 — bus
  events already flow runtime→host with audit-free semantics appropriate to
  UI state; a primitive would add grant/audit machinery a rendering hint
  does not need. Revisit only if a card must be callable from untrusted
  callers (the PR-2 approval flow may ask for exactly that).
- **SwiftUI hosted in the UIKit window**: no lifetime bridge is worth it
  for one card; the window is UIKit-built.

## Consequences

- PR-2 (creation schema + presentApproval install flow) and PR-3
  (hot-mount) plug into this contract unchanged — the generated pomodoro
  plugin's UI will speak these exact bus lines.
- `webView`/`serve` on AppDelegate went internal (the drive family already
  touched `gateway` that way); `scenarioEntry` makes the seat's entry a
  drive decision without touching the product default.
- The scenario manifest joins the committed-evidence set; the drive leg is
  runnable on demand (`simctl launch … -dsh-mode card-player`).
