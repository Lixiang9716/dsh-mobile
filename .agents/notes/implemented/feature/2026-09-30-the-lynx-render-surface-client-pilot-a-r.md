# Agent Note: the lynx render-surface client pilot — a replaceable Lynx skin over the RenderSurfaceClient seam

Status: implemented
Related: D5

## Problem

The presentation plane's clients (web-client-next, web-client-whale) all
ride a WebView. The pilot product needs a LYNX render surface — a native
skin a host can swap in wholesale — but nothing defined what such a client
IS in this repo: where the wire lives, what the engine-facing artifact may
touch, and how a stub (which can run in CI) and a real Lynx bundle (which
cannot, off-device) stay behaviorally identical. Without that shape, the
first Lynx client would have grown gateway calls and business logic into
the render layer — the exact coupling the presentation plane exists to
keep out — and its contract-first duty (D5) would have been met by
editing `contract/` instead of staying off it.

## Decision

`presentation/lynx-client/` is a self-contained, wholly replaceable
render-surface CLIENT plugin (not a system-plugin): zero gateway calls,
zero contract changes. The seam is `RenderSurfaceClient`
(mount/pushViewEvent/onIntent/teardown) in `driver/render-surface-client.js`;
two skins implement it — `skin-lynx.js` (mounts the rspeedy-built
ReactLynx bundle; on a runtime without a Lynx engine it verifies the
artifact by sha256 and refuses mount, naming the wall) and `skin-stub.js`
(a plain-text transcription that runs anywhere Node runs). The bundle is
pure presentation; the driver owns the wire (SessionServe client ported
verbatim from web-client-next, three-layer `{args:{request}}` envelope
unmoved) and the event model: one subscription point, an adapter
translating journal records + assistant-stream frames into the closed
view-event set {message-delta, tool-card-phase, session-settled}, a pure
fold shared by both skins, cold start as a seed burst bracketed
seed-start/seed-end, and intents {submit, cancel, select-session,
new-session} that fail loud on the unknown. Theme tokens are single-sourced
in `theme/tokens.json`, generated to BOTH faces (web CSS custom properties
+ typed Lynx constants) by `theme/gen.mjs --check`. `driver/run-mock.mjs`
drives the full loop over real loopback HTTP+WS (18/18 checks green);
`driver/run-lynx.mjs` is the opt-in lynx mode (next-mode.mjs precedent).

## Alternatives considered

- A system-plugin with gateway primitives (`presentSurface` on the
  2026-09-26 render-surface proposal): not this round — that proposal is a
  DRAFT (D5, nothing frozen) and the pilot is a client-side skin; touching
  the frozen `contract/` for a pilot was out of bounds. The proposal's
  native-surface line remains the on-device path this pilot feeds.
- A generic skin loader (dynamic module resolution by convention):
  rejected — the next-mode.mjs precedent is named, opt-in modes; a loader
  is a second un-governed surface. Two concrete skins, one interface.
- Folding the view state in the driver and pushing rendered view-models:
  rejected — the bundle would render driver-owned shapes, and the stub
  could not prove the bundle's fold; the fold lives in `shared/` and both
  faces consume the same file.
- Hand-writing the Lynx palette beside the web one: rejected — two palettes
  drift; `tokens.json` + generator keeps theme as data (the chat→theme.json
  ladder plugs in there later).
