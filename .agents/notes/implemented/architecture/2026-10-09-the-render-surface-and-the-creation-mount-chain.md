# The render surface and the creation-mount chain (v1.10.0 implementation)

Status: implemented

## Problem

The creation-mode chain wanted a native face: the agent authors a plugin
(the pomodoro clock), the user approves, and the plugin mounts LIVE — real
code on a native surface, never HTML in the throttled WebView. Three things
were missing: a frozen contract for a native drawing surface (the proposal
existed, unfrozen), any host implementation of it, and a runtime seam that
mounts a workspace-authored tree as a cordis plugin after boot.

## Decision

Freeze the render-surface proposal as v1.10.0 (with the event-channel seam
it rides as v1.9.0 — PR #423), then implement the chain in one vertical
slice:

- `SurfacePrimitives.ets` — presentSurface / surfaceDraw / closeSurface plus
  the `surface.frame` pump (interval-scheduled ~30 Hz while armed) and
  `surface.input` touch delivery, on the timer.fire event seam; per-op
  grammar validation of the closed `surface.ops@1` set (drawImage refuses
  loud as the one v0-unimplemented op — recorded in the header).
- `Index.ets` hosts the fullscreen native Canvas overlay (the ops
  interpreter, x-mark chrome, touch routing) above whichever seat is live —
  real ArkTS rendering, never a WebView.
- `runtime/dsh/surface.js` — the JS face, split from gateway.js at the
  code-size gate.
- `runtime/dsh/plugin-mount.js` — the LIVE mount seam: workspace tree ->
  manifest validation (the plugin_manager grammar, exported for reuse) ->
  registry upsert (dsh.plugins/1) -> `__dshModuleDefine` + `import()` ->
  cordis `ctx.plugin()` — post-boot, real code. The approval gate
  (presentApproval -> the native ApprovalDialog) runs before the mount.
- `web-live/pomodoro-plugin-template.js` — the authored-plugin reference:
  arc ring + mm:ss + start/pause/reset hit zones, 1 Hz timer redraws,
  honest no-surface refusal.
- `web-live/plugin-live-mount.js` + the composer seat — the post-turn
  creation mount hook (turn/end -> tree probe -> approve -> mount).
- `OfficialServe.pomodoroStream` — the scripted creation round -> two
  write tool calls from the staged template bytes.
- `scenario/surface-pomodoro.js` + its manifest — the device leg: open ->
  the arc frame -> malformed-op rejection -> pump arm/disarm -> close, with
  the honest `negotiation.refused` dual on surface-less hosts.

Four seat defects surfaced and were fixed along the way (each measured on
the emulator): the official seat never forwarded timerSchedule/timerCancel
although its descriptor declared them; settles from inside the C dispatch
callback must defer one event-loop turn (the no-re-entry rule);
presentApproval was descriptor-available but undispatchable on the official
seat; and the interactive seat's boot config lacked presetJoin (T-0048
wired only the drive phase) with the write surface's join option not
passed through.

## Alternatives considered

- A retained scene-graph surface instead of immediate-mode ops — deferred
  (the proposal's own reasoning: the op list is the shape the agent
  authors; a scene graph can layer on later without breaking negotiation).
- Extending the Web Client's creation viewer (HTML canvas in the
  throttled WebView) — rejected as the whole answer: the driven-WebView
  timer throttling and the no-vsync ceiling are the measured walls the
  proposal documents.
- Mounting authored plugins only at next boot — rejected: the goal is the
  LIVE cordis lifecycle; the loader seam (`__dshModuleDefine` + import)
  makes post-boot mounting the same shape as the boot-time dynamic mounts.

## Consequences

The HarmonyOS descriptor gains the three primitives (parity-gated against
the C face); the other hosts negotiate them away honestly (the creation
card viewer stays the floor). The one OPEN blocker is T-0208: the
interactive seat's MOCK-ROUTE turns journal zero records (the model round
runs, turn/end fires ~50 ms later, no user/assistant records; REAL-backend
turns journal fine per T-0047) — so the scripted pomodoro turn's write
calls never execute and the chain stops one step short of the approval
dialog. The host surface, mount seam, approval, and overlay are verified
ready for it.
