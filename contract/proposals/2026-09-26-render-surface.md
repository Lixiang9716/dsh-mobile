# Proposal: the render surface — a native present surface for agent-authored graphics (v1.7.0 candidate)

> **Status: DRAFT (D5 proposal — nothing frozen, nothing implemented).**
> English | [简体中文](2026-09-26-render-surface.zh.md)

## Motivation

The creation-mode clients (web-client-next, web-client-whale; #214/#218/#220/#221)
gave the agent a delivery path for visual work: `write` + `present` → creation
card → fullscreen viewer. Today the viewer renders every artifact as HTML in a
sandboxed iframe (`sandbox="allow-scripts"`) inside the Web Client — which is
the right floor, and already carries the planned first game content (the
canvas-game E2E leg is in flight as the evidence run for this proposal).

It is also a ceiling with three measured walls:

1. **The driven WebView throttles timers.** The iOS drive documents it at
   `hosts/ios/App/Source/NextWebRuntime.swift:15-17`: all waiting is Swift-side
   polling precisely because a driven WKWebView stops firing page timers. A
   game loop inside that page runs at the throttle's mercy.
2. **No sustained-frame guarantee and no 3D.** A WebView canvas competes with
   the whole page for memory and gets no vsync contract; WebGL contexts are
   lost under pressure. A native surface owns its render loop.
3. **The host's own device-plane work stops at the glass.** `haptic`,
   `keepAwake` (v1.5.0) are game-relevant but feed a WebView page that cannot
   guarantee the frame pace a game needs.

This proposal is the contract-first shape (D5) of the fix: a **native render
surface** the agent (or any plugin) can open, draw into, and close — with the
engine as a host implementation detail, never a contract name. It is a
**v1.7.0 candidate** because its input and frame plumbing sits on the v1.6.0
event-channel seam (see `2026-09-26-event-channel.md`): D8 forbids polling,
and a render loop is the densest event producer in the system.

## The primitives (three, plus two channels)

All follow the additive rule of v1.1.0–v1.5.0: a `gateway@1` host without the
seam keeps negotiating and answers each `unavailable`. The Web Client's
creation viewer remains the negotiation floor — a host that offers no native
surface still serves presented artifacts; this proposal raises the ceiling,
it does not move the floor.

### 1. `presentSurface` — open the surface (permission `surface`)

```ts
export type SurfaceRequest = {
  kind: "canvas2d";              // v0: one immediate-mode 2D kind
  title?: string;                // host chrome (navigation title, accessibility)
  pixelRatio?: "native";         // hosts default to the device scale
};
export declare function presentSurface(request: SurfaceRequest): Promise<
  { surfaceId: string; width: number; height: number; scale: number } | null>;
```

Presents a host-native fullscreen rendering surface (the same presentation
posture as the creation viewer: above the Web Client, closable by the user).
Resolves once the surface is on screen; the user dismissing it resolves
`null` (the "user dismissal is a value" rule, §3). A second
`presentSurface` while one is open resolves `null` — v0 is single-surface,
fail-soft rather than queue.

### 2. `surfaceDraw` — submit one atomic frame (permission `surface`)

```ts
export declare function surfaceDraw(surfaceId: string, ops: DrawOp[]): Promise<
  { presented: boolean }>;
```

Immediate-mode: the op list is resolved against a backing buffer and
**presented atomically** (double-buffered; a malformed op fails the whole
call, the previous frame stays). The v0 op vocabulary — `clear`, `fillRect`,
`strokePath` (move/line/quad/close), `text`, `setStyle` (fill/stroke/lineWidth/
font), `drawImage` (from a granted fs scope) — is a closed set specified at
fold time in `data-protocols.md`, versioned like every data protocol there.
Sequence numbers on each call let the host drop stale frames instead of
queuing them: a plugin that cannot keep up degrades to a lower frame rate,
never to lag.

### 3. `closeSurface` — end the surface (permission `surface`)

```ts
export declare function closeSurface(surfaceId: string): Promise<void>;
```

Idempotent: closing an already-closed (or unknown) surface resolves normally.

### Channel: `surface.frame` (host → plugin)

Delivered on the v1.6.0 channel seam, one event per requested animation
frame, **only while the plugin has asked** — `surfaceDraw` with an
`animate: true` flag on any op arms the pump, the next `surfaceDraw`
without one disarms it. No arm, no events: a static diagram costs zero
frames. The event carries `{ surfaceId, timestamp, dropped }` — nothing
else, because the plugin knows what it drew.

### Channel: `surface.input` (host → plugin)

Touch (begin/move/end with transformed surface coordinates), and — where the
platform provides it — key events. Delivered only while the surface is open.
**The audit record for input events carries kinds and counts, never
payloads** (a touch sequence can carry user-typed text the same way a
clipboard can).

## Permission and audit summary

| primitive / channel | permission flag | approval | audit payload |
| --- | --- | --- | --- |
| `presentSurface` | `surface` | — (opening a surface is itself user-visible) | kind + title length |
| `surfaceDraw` | `surface` | — | op count + sequence number |
| `closeSurface` | `surface` | — | surfaceId |
| `surface.frame` | (arm state) | — | surfaceId + timestamp only |
| `surface.input` | `surface` | — | event kind + count, never payloads |

## Host availability at fold time

iOS implements all three (SpriteKit or a CoreGraphics-backed layer for
`canvas2d`) plus both channels; Android maps them (SurfaceView + Canvas,
Choreographer for the frame pump); HarmonyOS maps them (XComponent +
Canvas, ArkTS callbacks). **No host is REQUIRED to implement any of them**
— the descriptor is the difference, the Web Client viewer is the floor,
and there is no `hostType` branch anywhere (RFC 0002 anti-pattern).

## Alternatives considered

- **Name the primitive after an engine (`cocosRun`, `spriteKitRun`)** —
  rejected: D16's recorded lesson on `ishRun` ("a platform-neutral contract
  should not name one engine"). The surface is the capability; SpriteKit,
  Skia, or anything else is the host's business.
- **Stay web-only (the status quo as ceiling, not floor)** — rejected as
  the whole answer: the three measured walls above. Kept as the
  negotiation floor every host already serves.
- **WASI graphics behind `wasmRun`** — rejected for now: the WASM seam is a
  pure-function ABI by construction (D16's alternatives section), and a
  graphics ABI on it is a program of its own (surface lifecycle, input,
  GPU addressing) — revisit only after the wasm-toolchain plan's first two
  layers land.
- **Embed a full third-party engine (Cocos, Godot) as the first
  implementation** — rejected for v0: 50–100 MB of binary, script-layer JIT
  legality needing measurement on iOS (the jitless-V8 lesson, D16), and —
  decisive for this project — engine project formats (scene files) are not
  what the creation-mode agent authors well. The agent-authored path wants
  an immediate-mode op list, not an IDE artifact.
- **A retained scene graph instead of immediate-mode ops** — deferred:
  strictly more contract surface for no v0 consumer; the op list is the
  shape the agent produces naturally (it is what `canvas2d` code compiles
  to), and a scene graph can layer on top later without breaking `gateway@1`
  negotiation (major-only).

## Evidence base

The creation chain is on all three hosts (#214/#218/#220/#221) and the
whale viewer already demonstrated the presentation posture this proposal
formalizes. The driven-timer throttling is documented in the iOS drive
source it forced into existence (`NextWebRuntime.swift:15-17`, Swift-side
`pollPage`). The canvas-game E2E leg — the first `requestAnimationFrame`
artifact in the viewer — is the in-flight evidence run that motivates the
frame pump; the upstream agent's own behavior supplies the rest: asked for
a game, it writes one, and the only place it can currently run is a
throttled WebView page.
