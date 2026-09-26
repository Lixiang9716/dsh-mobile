# Agent Note: the render-surface proposal — presentSurface and the surface channels (v1.7.0 candidate)

Status: implemented
Related: D5

## Problem

The creation-mode chain (write + present → creation card → fullscreen viewer)
delivers agent-authored visual work only through a WebView iframe. Three
measured walls cap it: the driven WKWebView throttles page timers (the iOS
drive polls from Swift for exactly this reason, NextWebRuntime.swift:15-17),
a WebView canvas has no sustained-frame/vsync guarantee and loses WebGL
contexts under pressure, and the v1.5.0 device-plane primitives (`haptic`,
`keepAwake`) feed a page that cannot promise the frame pace a game needs.
Without a contract shape for a native render surface, any host that added
one would do it off-contract — the exact outcome D5 exists to prevent.

## Decision

`contract/proposals/2026-09-26-render-surface.{md,zh.md}` proposes (DRAFT,
v1.7.0 candidate — after the v1.6.0 event-channel seam it depends on) three
primitives — `presentSurface` (open a native fullscreen surface, single-surface
v0, user dismissal resolves `null`), `surfaceDraw` (immediate-mode closed op
vocabulary, atomic double-buffered present, sequence numbers so the host drops
stale frames instead of queuing them), `closeSurface` (idempotent) — plus two
channels on the v1.6.0 seam: `surface.frame` (armed only while the plugin's
draw ops ask to animate; zero cost for static content) and `surface.input`
(touch/key in surface coordinates; audit carries kinds and counts, never
payloads). Permission flag `surface` throughout. The Web Client creation
viewer stays the negotiation floor; no host is required to offer the surface;
engines (SpriteKit/Skia/XComponent) are host implementation details, never
contract names.

## Alternatives considered

- Engine-named primitives (`cocosRun`, `spriteKitRun`): rejected — D16's
  recorded lesson that a platform-neutral contract must not name one engine.
- Web-only forever (status quo as ceiling): rejected — the three measured
  walls; kept as the floor every host already serves.
- WASI graphics behind `wasmRun`: rejected for now — the seam is a
  pure-function ABI by construction; a graphics ABI there is its own program.
- Embedding Cocos/Godot as the first backend: rejected for v0 — 50–100 MB,
  script-layer JIT legality unmeasured on iOS, and engine scene-file formats
  are not what the creation-mode agent authors well; the agent path wants an
  immediate-mode op list.
- A retained scene graph instead of immediate-mode ops: deferred — more
  contract surface with no v0 consumer; layers on later without breaking
  `gateway@1` negotiation.
