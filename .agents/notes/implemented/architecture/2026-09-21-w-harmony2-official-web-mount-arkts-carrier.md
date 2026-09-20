# Agent Note: W-HARMONY2 — the ArkTS carrier implements the ctx.webServer subset; the official web app mounts on HarmonyOS

Status: implemented
Related: D9, D5

## Problem

The HarmonyOS host was the only one of the three mobile hosts still stuck at
its M5 shape: a hard-coded loopback carrier (static dir + one `/ws` seat)
mounting only the m2 Web Client, with `httpFetch` declared honestly
`unavailable` in the binding descriptor while iOS/Android stream real
bodies. The `ctx.webServer` contract subset that the OFFICIAL upstream web
UI needs (docs/webserver-contract.md §2) existed only on iOS
(CarrierServer/CarrierWebDist/CarrierPlugins/CarrierAPIBridge.swift) — the
official app had never mounted on HarmonyOS, and the platform-primitive gap
(honest-unavailable httpFetch) was still open there.

## Decision

The ArkTS carrier now implements the contract subset (Phase-B), and ONE
emulator launch proves the whole stack in three event-driven phases:

- **Route table first (contract §1.2–§1.4)**: `CarrierServer.ets` is
  rewritten from the M1 hard-coded dispatch into the fixed matching order —
  exact table → longest prefix → fallback → bare 404, exact-path-only
  upgrade dispatch (unmatched upgrade sockets are destroyed, never
  fall through to static), one-owner fallback ("two fallbacks cannot
  compose" throws), duplicate registrations throw, request-body
  reassembly up to the §3.5 cap. The legacy m5 wiring (static fallback +
  always-accept `/ws`) moves verbatim to `CarrierRoutes.ets` on the new
  table, byte-compatible — the frozen m5 manifest stays green unchanged.
- **The official seats**: `WebDist.ets` (fallback) serves the vendored
  upstream dist straight from rawfile bytes — GET/HEAD + 405, traversal
  403, the fixed MIME table, the auth-lite token→cookie exchange (303 to
  clean `/`), and the §1.5 index render pipeline (head rows after
  `<head…>`, body rows after `<body…>`, `__DSH_BOOT_READY__` tail,
  `<base href="/">`). `WebPlugins.ets` (prefix `/plugins`) reproduces the
  upstream combo byte semantics (`prepareSource` trailer strip, `;\n`
  joins, combo sourceMappingURL, framedHash combo rev over the hand-rolled
  SHA-1, identity per-line maps) for single + aggregate forms.
  `ApiBridge.ets` (prefix `/api` + exact `/api/remote.mux`) parses the
  frozen client-request envelope, forwards CLAIMED endpoints over the bus
  seam, answers UNCLAIMED ones with the structured
  `gateway/unimplemented` envelope, and multiplexes
  open/cancel→item/error/end frames — the compose-only closure claims
  nothing, so the honest gap stays loud (logged, never a hang).
- **The official boot (b-harmony.official-web-mount)**: a fresh NAPI
  runtime runs the canonical `runtime/spike/scenario/b1-web-live.js`
  (rawfile copy cmp-verified by `ci/vendor-official.sh`); its `web.boot`
  bus post carries the runtime's rows/graph/revs, which
  `OfficialPhase.ets` swaps into the render pipeline and the /plugins
  revs BEFORE the origin opens — the page's facade `create()` then
  materializes the real upstream browser bundle (module system live) and
  boots the real client module system. Mount evidence is carrier-side
  observation (single-emission pins in manifest order) plus the same-
  origin probe through ArkWeb `runJavaScript` (module.system.live /
  app.shell.rendered / page.rendered, polled with a deadline — ArkWeb
  does not await promises, so the probe parks its JSON in
  `window.__b1Out` and ArkTS polls).
- **httpFetch v2 (b-harmony.httpfetch-v2)**: `HttpFetch.ets` serves the
  primitive over `@ohos.net.http` `requestInStream` — headers settle the
  call `{status, headers, bodyId}`, the body streams as `http.body`
  chunks (≤16 KB base64) + `http.end`, abort answers `cancelled`, closed
  ports reject `network` — the platform twin of iOS
  Gateway/HTTPPrimitive.swift, so gateway.js's AsyncIterable shim sees
  one contract. `gateway_smoke.cpp` forwards `httpFetch`/`httpFetch.abort`
  instead of rejecting them; the descriptor flips to 6 available / 3
  unavailable for the official phase only (frozen m5 keeps 5/4). After
  the mount completes, a FRESH runtime runs the proof scenario against
  the live carrier (loopback fetch of the real entry chunk + abort +
  refused legs).
- **E2E**: `ci/drive-official.mjs` tails hilog for the boot-screen /
  final screenshots and the terminal verdicts;
  `ci/run-host-e2e.sh` drives all six checker verdicts (m1.spike.boot,
  m2.bridge.smoke, m2.session, m5.host-binding,
  b-harmony.official-web-mount, b-harmony.httpfetch-v2) from pulled
  capture files, with the force-stop-verified relaunch (pidof check —
  the resident-app trap is recorded in the surprise ledger) and the
  sips JPEG→PNG conversion per screenshot.

## Alternatives considered

- **Serving the official dist from the materialized cache dir** (like the
  m5 web client) instead of rawfile bytes: rejected — it doubles the
  staging logic and the vendor script would need a per-launch copy step;
  rawfile bytes are read directly (`getRawFileContentSync`), so the HAP is
  self-contained after one hvigor build.
- **Porting the whole desktop webserver (gzip, SSE, disposers)**: rejected
  for Phase-B — the contract subset the official page consumes is the
  route table + the four seats; compression/SSE have no consumer in the
  compose-only closure. The route table is the seam the rest hangs on.
- **Bridging /api and the mux only when claimed, silently dropping
  unclaimed calls**: rejected — a silent drop starves the page's RPC
  waterfall with no evidence; the structured `gateway/unimplemented`
  envelope (200, error inside) keeps the honest gap visible in the
  manifest (`rpc.observed` answered `unavailable`).
- **Running the httpFetch proof on the same runtime instance as the mount**:
  rejected — the b1 scenario latches its verdict on completion
  (`__dshComplete`), and a second completion on one phase runtime would
  reuse spent verdict state; the proof leg gets a fresh `hostStart` on a
  later tick (never inside an NAPI call stack — ARCHITECTURE.md §6).

## Consequences

- The official upstream app shell mounts on HarmonyOS with zero upstream
  edits; the session/agent services behind the mux remain the next named
  gap (first stream open answers `gateway/unimplemented`, pinned in the
  manifest as `session.services.pending`).
- `rawfile/spike/officialweb/` stays UNTRACKED (upstream bundled JS must
  never be judged by the content gates — iOS surprise ledger, 5087
  violations); `ci/vendor-official.sh` materializes + cmp-verifies it
  inside the build step. The web-boot closure copies ARE committed (ours
  or `/vendor/`-excluded) and drift-checked by the same script.
- The m5 phase's completion now chains into the official phase through
  `HostPhase.onPhaseComplete` (fired once, off the NAPI stack), so one
  launch exercises carrier v1 (legacy routes) AND carrier v2 (contract
  subset) back to back.
- Platform facts this work pinned about the HarmonyOS emulator SDK (each
  cost a failed run to find; recorded so the next host work skips them):
  - `util.TextEncoder.encodeInto('')` returns `undefined` — every
    empty-body response (303/401/404/405) crashed the app until the
    encode helpers grew empty guards (jscrash `Cannot read property
    buffer of undefined`).
  - `requestInStream`'s promise resolves only at completion (observed:
    the full body streams through `dataReceive` first, the status lands
    with `dataEnd`), so `HttpFetch` queues body/end events per call and
    flushes them right after the settle — the shim sees the contractual
    headers → chunks → end order regardless.
  - `TCPSocketConnection.send()` truncates large buffers (the peer saw
    ~16 KB of a 604 KB body and stalled) — the carrier now sends in
    bounded sequential 64 KB writes and closes after the last.
  - ArkTS `Web({src})` does not re-navigate on a state change after
    mount, and `loadUrl` from inside a NAPI re-entry stack is silently
    swallowed — the official origin remounts the Web with the new
    initial src on a later tick, with an explicit `loadUrl` backstop.
  - `aa start` reports success while the BMS is still settling a fresh
    `install -r` and no process ever appears — the runner's launch loop
    waits for the PID, not the exit code.
  - NAPI mutators with fixed string buffers (`hostEvent` 2 KB) must stay
    dynamic when new traffic flows through them: the 16 KB http.body
    chunks are ~22 KB base64 lines and threw `event too long` as an
    uncaught ArkTS exception (jscrash). `hostBusDeliver` (inherited),
    `hostCarrierLine`, and `hostEvent` are all dynamically sized now.
