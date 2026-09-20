# Agent Note: Phase-B carrier: the ctx.webServer contract subset mounts the official web app

Status: implemented
Related: D9, D5, D8

## Problem

D9 requires the mobile WebView to mount the OFFICIAL upstream web UI, and
docs/webserver-contract.md (landed in #52) freezes the exact wire surface
the carrier must satisfy for that: named routes with a single-owner
fallback seat, exact-path WebSocket upgrades with multiple concurrent
seats, POST `/api/<endpoint>` with the frozen `client-request`/
`server-response` envelope, the single multiplexed push socket
`/api/remote.mux`, `/plugins/**` module bundles including the aggregate
`??`-combine form, and an index render pipeline that injects the boot rows
(`__ModuleLoader__`, `__DSH_BOOT__`, `__DSH_CONNECTION_RECOVERY__`, the
`__DSH_BOOT_READY__` tail, `<base href="/">`) into the deliberately bare
vendored dist. The M1-spike CarrierServer had none of this: one hard-coded
`/ws` upgrade, one WS seat, GET-only, `.html`/`.js`-only static serving,
no route table, no body reading. Without the carrier side, the official
page shows its by-design boot-failure screen and no carrier work could be
verified against the real boot sequence; with it, the runtime half
(upstream packages, staged by the sibling runtime PR) has a real
contract-conformant endpoint to land on.

## Decision

- **Route table** (`CarrierServer.swift`): `register(kind:path:handler:)`,
  `registerUpgrade`, `registerFallback` per the contract's §1 semantics —
  duplicate `(kind, path)`/upgrade path throws (fatal config error, the
  drive fails loud); matching is exact → longest prefix → fallback; POST
  bodies reassemble up to a 256 KiB cap (413 over, 400 malformed);
  percent-decode failures answer 400 instead of crashing; malformed
  requests can never kill the process. Upgrades match by exact pathname
  only; an unmatched target destroys the socket.
- **Multi-seat WebSocket**: the single `wsConnection` became a seat set
  keyed by connection with per-seat receive buffers; `send(_:to:)` targets
  one path, the legacy `send(_:)` keeps addressing `/ws` only, and
  `stop()` destroys upgraded sockets explicitly (they outlive listener
  close). Ping→pong and close-echo per seat; a path-aware `onWSFrame`
  sits beside the legacy `/ws`-only `onWSMessage` so the M1–M3 drives are
  untouched consumers.
- **Legacy wiring, byte-compatible** (`CarrierRoutes.swift`): the old
  static serving is now the fallback seat installed by
  `installLegacyRoutes(webRoot:)` (same `..` check, `/`→`index.html`,
  `.html`/`.js` restriction, same served-path recording) plus the `/ws`
  upgrade and the `/gateway-e2e` prefix streams — the frozen m1/m2/m3
  manifests stay green unchanged (re-verified: run-ios-session default
  and `--client mini`, run-ios-m3).
- **Official dist fallback seat** (`CarrierWebDist.swift`): §2.1 verbatim
  with the §3.4/§3.6 Phase-B reductions — GET/HEAD else 405, traversal →
  403, fixed MIME table extended with fonts/png, empty 404s, index only
  at dist root/`index.html` (deep paths 404, no SPA fallback — `<base
  href="/">` plus the router re-anchor). Auth-lite replaces BrowserAuth:
  a per-session random token; a valid `?token=` GET of `/` mints a
  session cookie and answers 303 → clean `/`; the cookie gates index
  responses, `/api`, and the mux upgrade (documented reduction — the
  WebView is the only loopback client).
- **Index render pipeline** (`CarrierWebDist.renderIndex` +
  `CarrierBootConfig`): head rows spliced after `<head…>`, body rows
  after `<body…>`, the `__DSH_BOOT_READY__` settlement tail last, then
  `<base href="/">` immediately after `<head…>` (upstream order: base
  lands before the row markup). Default rows are carrier-generated from
  the staged plugin set in upstream shapes: the verbatim upstream
  `__ModuleLoader__` queue facade, the `WebBootGraph` JSON (entries +
  one application batch) referencing the staged bundles through the
  `/plugins` combo URLs, and the documented `__DSH_CONNECTION_RECOVERY__`
  defaults. The rows closure re-reads per render, so a runtime that
  hands a `web.boot` config over the bus seam (Phase C) replaces them
  without touching the carrier.
- **`/plugins/**`** (`CarrierPlugins.swift`): the single-resource combo
  `/plugins/??<id>/client.js&rev=<rev>`, the aggregate
  `/plugins/??<a>/client.js,<b>/client.js&rev=<comboRev>` form, and the
  `.map` identity maps, with upstream byte semantics reproduced
  (`prepareSource` trailer stripping + `;\n` per source + the combo's
  own sourceMappingURL line; `framedHash`-style length-prefixed combo
  rev; sha1-12 revisions; `cache-control: immutable`). Unknown resources
  404; non-GET/HEAD 405; HEAD answers headers only.
- **`/api` + mux** (`CarrierAPIBridge.swift`): POST `/api/<endpoint>`
  validates the frozen envelope (type/rpcId/method==endpoint/payload) and
  answers every endpoint no runtime has CLAIMED over the bus seam with
  the structured unavailable result
  (`gateway/unimplemented`, code + message + details{endpoint,
  namespaces}) — fail loud, logged as `rpc.observed`, never a hang; a
  claimed endpoint is forwarded (`api.request`) and answered whenever the
  runtime settles it (`respondAPI`). `/api/remote.mux` is an exact
  upgrade route (cookie-gated; reject = socket close); `open`/`cancel`
  frames from the page bridge to the runtime (`mux.open`/`mux.cancel`)
  and `muxItem`/`muxError`/`muxEnd` bridge back; an unclaimed stream
  endpoint answers the carrier-safe `error` frame with
  `gateway/unimplemented`. The bus-seam message schema
  (`api.claim`/`api.respond`/`mux.claim`/`mux.item|error|end`) is the
  Phase-C integration surface for the runtime PR.
- **E2E** (`OfficialWebRuntime.swift`, `-dsh-mode official-web`,
  `tools/e2e/run-ios-b1.sh`): implements the §4 evidence plan — 9
  carrier-side wire observations plus the rendered-state probe, frozen in
  `tools/e2e/scenarios/b1-official-web-mount.json` (10 rows: the doc's 9
  with an inserted `plugins.served` between `asset.served` and
  `upgrade.accepted`, and row 8 honestly emitted as `runtime.pending`
  {leg: `token.delta.forwarded`} because the journal delta leg needs the
  sibling runtime — not faked). The probe runs in the page via
  `callAsyncJavaScript` (plain evaluateJavaScript cannot await the
  promise — WKError 5): fetch of the two-resource combo URL from the
  injected graph (real same-origin fetch proving the combine form), a
  real WebSocket upgrade, `POST /api/session.list`, a mux
  `session/journal` open answered by the unavailable frame, and the
  rendered-state read of the TRUE page state (upstream boot screen
  `[data-dsh-boot]`, wordmark HARNESS, the boot-failure text naming the
  missing upstream bootstrap bundle — the documented by-design failure
  mode until the runtime lands). Screenshot saved as evidence.

## Alternatives considered

- **Serving the bare dist until the runtime lands** — rejected: that is
  the upstream boot-failure screen by design; the contract's injection
  pipeline is the carrier's job and is exactly what was missing. The
  failure mode now visible (missing upstream bootstrap bundle) is the
  CORRECT remaining gap, one the runtime PR closes.
- **Faking the full boot with a stub `@deepseek-ai/dsh-client-modules`
  bundle** — rejected outright: vendoring a fake upstream module system
  violates the never-modified-upstream rule and would lie about
  readiness. `runtime.pending` is the honest marker.
- **Raw Swift loopback client for the conformance probe** — lost to the
  in-page probe: the page's own fetch/WebSocket stack exercises the
  cookie jar, same-origin credentials, and the real upgrade path exactly
  as the future mounted app will; a Swift RFC6455 client would prove
  less while reimplementing framing.
- **Relaxing auth on the mux upgrade** (cookies in WKWebView WS
  handshakes are the riskiest link) — kept the cookie check because the
  probe proves the real stack passes it; relaxing would hide a future
  page-side regression instead of failing loud.
- **Amending docs/webserver-contract.md** to renumber the evidence plan —
  rejected: the doc's 9 planned rows all appear in manifest order; the
  manifest-level insertion is documented here and in the PR, so the
  frozen spec text stays byte-stable.

## Consequences

- The carrier is now a REAL `ctx.webServer` implementation: the runtime
  PR's boot graph, bundles, and journal streams land against existing,
  verified endpoints; Phase C only adds the bus-seam producer side.
- `rpc.observed` pins `session.list` answered `gateway/unavailable` —
  enumerated as unimplemented in Phase-B v0: ALL upstream namespaces
  (session, settings, credentials, workspace, terminal, goals, skills,
  fileReferences, directoryPicker, archive, typert) until claimed.
- Known deferred (§3.7): compression, 0.0.0.0, HMR `/plugins/events`,
  webhooks, full BrowserAuth; the legacy M1–M3 static seat intentionally
  keeps its `.html`/`.js` restriction (frozen manifests).
