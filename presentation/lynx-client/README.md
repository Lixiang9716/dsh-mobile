# dsh-lynx-client — the Lynx render-surface client pilot

A render-surface **client plugin** (not a system-plugin): zero gateway
calls, zero contract changes. Self-contained and wholly replaceable — the
directory is the product.

- `manifest.json` — the plugin face (id/version/surface/entry/bundle/skins)
- `theme/` — the token single source (`tokens.json`); `gen.mjs` renders it
  to both faces: `web.tokens.css` (CSS custom properties, web-client-v2
  `:root` vocabulary) and `bundle/src/theme.generated.ts` (typed Lynx
  style constants). `node theme/gen.mjs --check` gates drift.
- `shared/` — the event model: `view-events.js` (the closed view-event set
  {message-delta, tool-card-phase, session-settled} + the closed intent set
  {submit, cancel, select-session, new-session}, fail loud on the unknown)
  and `fold.js` (the pure view-events → view-state fold both skins share).
- `driver/` — the host side: the SessionServe wire client (ported verbatim
  from web-client-v2, three-layer `{args:{request}}` envelope unmoved),
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

Two evidence channels, both green (acceptance round):

- `test/e2e/run-cli-lynx-mount.sh` — the `lynx.mount` CLI leg: the full
  mock-LLM driver loop run TWICE over one flow (lynx face, then the stub
  face — the replaceability proof). 34/34 structured-log events per face,
  one-to-one against `test/e2e/scenarios/lynx-mount{,-stub}.json`; verdicts
  + receipts committed under `artifacts/cli-lynx-mount-{lynx,stub}/`.
  `npm run mock-loop` stays as the fast inner assert loop (18/18).
- vitest (`npm test`, 71 tests here; 116 across both presentation suites
  once web-client-v2's 45 at `test/web-client-v2-suite/` are counted):
  the seam contract, the fold, the adapter mapping table, and the wire
  client (live local server, real ws-lite upgrade) — plus
  `tests/driver-loop.test.js` (run-mock's 18 checks 1:1 as vitest cases
  over the same real mock loop, with the stream-error / no-sessionId /
  not-found / busy edge legs) and `tests/{wire-edge,mux}.js` for the
  envelope's malformed-answer legs and the mux's generation-tracked
  reconnect contract over real sockets. Both suites run in CI (the
  `gates` workflow's presentation step, `.github/workflows/gov.yml`).
  `npm test -- --coverage` reports the driver face honestly (the runners
  are excluded: their checks ARE the driver-loop suite now).

**Pilot boundary:** device pixels need a Lynx engine (LynxExplorer /
on-device LynxView). On the CLI host the lynx face drives the bundle's seam
core (`shared/surface-core.js` — the module compiled into the artifact) with
the artifact verified by sha256 in the same mount. The bundle ALSO renders
for real on the @lynx-js/web-core platform in headless Chrome (a
human-facing screenshot lives under the gitignored `artifacts/screens/`;
CI asserts on logs only, per the E2E contract).
