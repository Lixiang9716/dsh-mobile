# dsh-lynx-client — the Lynx render-surface client pilot

A render-surface **client plugin** (not a system-plugin): zero gateway
calls, zero contract changes. Self-contained and wholly replaceable — the
directory is the product.

- `manifest.json` — the plugin face (id/version/surface/entry/bundle/skins)
- `theme/` — the token single source (`tokens.json`); `gen.mjs` renders it
  to both faces: `web.tokens.css` (CSS custom properties, web-client-next
  `:root` vocabulary) and `bundle/src/theme.generated.ts` (typed Lynx
  style constants). `node theme/gen.mjs --check` gates drift.
- `shared/` — the event model: `view-events.js` (the closed view-event set
  {message-delta, tool-card-phase, session-settled} + the closed intent set
  {submit, cancel, select-session, new-session}, fail loud on the unknown)
  and `fold.js` (the pure view-events → view-state fold both skins share).
- `driver/` — the host side: the SessionServe wire client (ported verbatim
  from web-client-next, three-layer `{args:{request}}` envelope unmoved),
  the adapter (domain records → view events), the orchestration driver
  (single subscription point, seed bursts, intent execution), and the two
  skins over one `RenderSurfaceClient` seam (`mount` / `pushViewEvent` /
  `onIntent` / `teardown`): `skin-stub.js` (plain-text transcription) and
  `skin-lynx.js` (mounts the ReactLynx bundle).
- `bundle/` — the ReactLynx face (pure presentation: zero network, zero
  gateway, zero business logic). `npm run build` (rspeedy) produces
  `dist/main.lynx.bundle`; the template section carries JSX text as
  UTF-16LE — that is the format, not corruption.

## Run

```sh
npm install --prefix bundle   # once
npm run mock-loop             # the full loop over loopback HTTP+WS (stub skin)
npm run lynx-mode             # verify the built bundle + the engine wall
npm run theme:check           # token single source in sync
```

The mock loop (`driver/run-mock.mjs`) is the build round's green criterion:
cold-start shell → select/new-session → streaming turn (all three tool-card
states live) → mid-history seed rebuild → cancel → fail-loud legs.

**Pilot boundary:** pixels need a Lynx engine (LynxExplorer / on-device
LynxView). On plain Node the lynx skin verifies the artifact (sha256) and
refuses mount, naming the wall — nothing pretends to render.
