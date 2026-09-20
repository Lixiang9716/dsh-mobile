# The `ctx.webServer` contract and the Phase-B carrier alignment plan

English | [简体中文](webserver-contract.zh.md)

This document is the implementation spec for the mobile carrier's web
server surface (decision D9): the contract our carrier must satisfy so
that the OFFICIAL upstream web UI (`apps/web`, vendored verbatim under
[presentation/official-web](../presentation/official-web/)) mounts in the
mobile WebView with **zero upstream edits**. It is extracted from
upstream SOURCE at the vendored pin — not from prose — and ends with the
per-host alignment plan for `CarrierServer` and the E2E evidence plan.

**Sources** (all read at deepseek-ai/deepseek-harness
`ddefc45fbc7f8e46dd73185e68295696d1297887`, tag `dsh-v0.1.6-alpha.2` —
the pin recorded in `anywhere-labs/dsh-desktop` `upstream.json`
(channels.beta) and its `deepseek-harness` submodule gitlink, which
agree):

- `packages/host/webserver/src/index.ts` — the `ctx.webServer` service
- `packages/host/webserver/src/injections.ts` — structured index
  injection rows
- `packages/host/frontend-static/src/index.ts` — the SPA dist server on
  the fallback seat
- `packages/client/connection/src/` — the `/api` RPC transport and
  browser authentication
- `packages/api/gateway/src/` — the `/api/remote.mux` WebSocket
- `packages/client/modules/src/index.ts` — the `/plugins` bundle route
  and the boot-globals injection rows
- `packages/bundle/web-app/src/index.ts` — the shipped composition

> The one-paragraph summary: the carrier is a **loopback HTTP + WS
> endpoint with a route table**. Named routes (exact and prefix) are
> registered by feature owners; one single-owner **fallback seat** serves
> everything unmatched — in the shipped composition, the official SPA
> dist with an auth-gated, injection-rendered index; one exact-path
> **upgrade table** dispatches WebSocket connections. Matching is fixed:
> exact, then longest prefix, then fallback. The carrier carries no
> harness concepts.

## 1. The `webServer` service contract

### 1.1 Identity and configuration

Cordis service `webServer` (`ctx.webServer`), config schema (validated,
required fields abort activation):

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `host` | `'127.0.0.1' \| '0.0.0.0'` | required | Exactly two values: loopback or deliberate all-interfaces exposure. The server carries no TLS/auth of its own. |
| `port` | natural ≤ 65535 | required | `0` requests an OS-assigned port; `webServer.port` reads the bound value afterwards. |
| `compression` | `'none' \| 'gzip'` | `'none'` | Optional gzip on socket-backed responses; skips `content-range` and SSE; identity transfer for socket-less responses. |
| `compressionLevel` | int 0–9 | `1` | DEFLATE level when gzip is on. |
| `compressionThresholdBytes` | natural | `1024` | Known lengths below the threshold stay uncompressed; unknown-length streams are eligible. |

Activation **listens immediately**; a listen failure rejects
initialization and the boot reports the failed fiber. All registrations
below return a **disposer**; disposing the owning effect/fiber withdraws
the registration.

### 1.2 HTTP route registration

```ts
interface WebRoute {
  kind: 'exact' | 'prefix'   // 'prefix' p matches p and p/<anything>
  path: string               // absolute pathname, no trailing slash
  handler: (req, res) => void | Promise<void>  // owns the FULL response lifecycle
}
register(route): () => void
```

- Duplicate `(kind, path)` **throws** — route patterns are a
  composition-level contract; a collision is a misconfiguration, not a
  precedence question.
- Handlers may hold the response open (SSE, chunked streams); the
  webserver never times out or mutates a handed-off response.
- Request matching is fixed: **exact table → longest prefix wins →
  fallback**. Registration order changes nothing (routes compose to be
  disjoint).

### 1.3 Upgrade (WebSocket) registration

```ts
interface WebUpgradeRoute {
  path: string               // exact pathname, no trailing slash
  handler: (req, socket, head) => void | Promise<void>  // owns negotiation + socket
}
registerUpgrade(route): () => void
```

- Duplicate paths throw: one socket has one protocol owner.
- Upgrades match by **exact pathname only**; an unmatched upgrade socket
  is destroyed.
- The service tracks upgraded sockets and destroys them on disposal
  (they are invisible to `closeAllConnections`).
- Handler failures (sync or async) log and destroy the socket — never a
  process exit.

### 1.4 The fallback seat

```ts
registerFallback(handler): () => void
```

- **One owner only**; a second registration throws ("two fallbacks
  cannot compose").
- Answers every request no named route matched. While the seat is
  unclaimed the server answers bare **404** — what a browser sees when
  the dist owner's fiber is disposed or not yet activated.
- In the shipped composition the seat belongs to the SPA dist server
  (§2.1). For the mobile carrier this seat is where the official dist
  mounts.

### 1.5 Index rendering: structured injections + raw taps

The webserver owns no files but owns the **index render pipeline** that
the fallback owner calls for every index response:

```ts
tapIndex(transform: (html: string) => string): () => void   // raw escape hatch
collectIndexInjections(): IndexInjection[]   // one 'webserver/index-inject' emit
renderIndex(html: string): string            // rows first, then taps in order
```

- Listeners on the `webserver/index-inject` event push typed rows into a
  mutable table; rows are read **fresh per render** (live module graph,
  live theme), in listener activation order.
- Row kinds (`IndexInjection`, all placed `head` or `body`):
  `{kind:'global', name, value}` — `globalThis[name] = value` (JSON,
  `<`-escaped); `{kind:'script'|'script-src'|'script-preload'|'style'|'html', …}`.
- Rendering splices head rows after `<head…>` and body rows after
  `<body…>`, then appends the boot-readiness tail
  `globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()`.
  The client entry **awaits `__DSH_BOOT_READY__.promise` before reading
  any injected state** — an asynchronous bootstrap must settle the
  deferred after its last row.

### 1.6 Error posture

Per-request handler failures are caught: log + **400** (destroy the
response if headers were already sent). A malformed request can never
kill the process. Upgrade-path failures are logged and the socket
destroyed.

## 2. The shipped Web composition the official UI expects

What the official page consumes from the wire, in boot order. This is
the surface the Phase-B carrier must reproduce (§3).

### 2.1 Fallback seat = SPA dist server (`frontend-static`)

Config: one value, `distIndex` — absolute path of `index.html` in the
dist root (resolved by the composition, never user config; our carrier
anchors it at the vendored `presentation/official-web/dist/index.html`).

Behavior, verbatim from source:

- **Methods**: GET/HEAD only; anything else on the fallback path is
  **405** (named routes own their own method handling).
- **Traversal**: the resolved target must stay under the dist root —
  else **403**.
- **Index** (dist root or `distIndex` path): first
  `connection.authorizeIndex` (§2.2), then the body is
  `renderIndex(readFile(distIndex))` with **one extra transform: a
  `<base href="/">` spliced after `<head…>`** (the dist is built with a
  relative base; deep SPA-fallback paths would otherwise resolve assets
  under the request directory).
- **Assets**: served from the dist root with a fixed MIME table
  (`.html`, `.js`, `.css`, `.svg`, `.json`, `.map`, `.webmanifest`,
  `.gz`) and `application/octet-stream` for anything else; missing or
  non-file targets are empty **404** (ENOENT/EISDIR/ENOTDIR only).
- No caching layers, no etags — every response is computed.

### 2.2 Browser authentication (`connection.authorizeIndex`)

The shipped composition gates **index responses only** (static assets
stay public) on a process-launch token exchange:

- `authenticatedUrl(baseUrl)` appends the process launch token as the
  `?token=` query parameter — this is the URL printed/handed to the
  browser.
- A GET of `/` with exactly the valid token mints a persistent signed
  cookie (`Set-Cookie`, `cookieMaxAgeDays` default 30, authority-bound
  name) and answers **303 → clean `/`**.
- A request carrying the valid cookie serves the index (**200**).
- Everything else receives the Connection-owned minimal **401**.
- The same trust posture guards `/api`: Host/Origin checks plus
  token-or-cookie; failures are 401 (unauthenticated) or 403
  (authenticated-but-forbidden).

Mobile adaptation note: the WebView loads a carrier-controlled loopback
URL, so the full signed-cookie machinery is reducible — see §3.4(e).

### 2.3 RPC over `POST /api/<endpoint>`

`client-connection` registers one **prefix route `/api`** (after
Host/Origin + auth rejection) that bridges HTTP to the host RPC
registry:

- Request envelope (JSON body):
  `{type:'client-request', rpcId:<uuid>, method:<endpoint>, payload:{args…}}`;
  response envelope: `{type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error:{code,message,details}}}`.
- The browser caller posts to `{origin}/api/<endpoint>` with
  `content-type: application/json`; correlation is by `rpcId`; a
  mismatched envelope or `rpcId` is a client-side transport failure.
- Default body cap: **300 MiB** (`maxRequestBodyBytes`).
- The Typert API gateway intercepts `/api` endpoints and dispatches to
  the typed host services (namespaces observed in source: `session`
  — list/create/prompt/cancel/fork/rename/search/page/follow/
  selectModel/modelCatalog/attachment/updateQueue/openWorkspacePath …;
  `settings`, `credentials`, `workspace`, `terminal`, `goals`,
  `skills`, `fileReferences`, `directoryPicker`, `archive`, `typert`).
- A `connection/request` waterfall lets composition rows veto or augment
  requests before the bridge.

### 2.4 Push over `WS /api/remote.mux`

The gateway registers one **upgrade route** at the exact path
`/api/remote.mux` (auth-gated like `/api`; rejected upgrades get a
socket-level rejection, not a 101). One physical WebSocket multiplexes
N logical streams (`open`/`item`/`cancel`/`error` frames, heartbeat
ping) carrying:

- the **remote event feed** (session/agent/settings/command events — the
  projection vocabulary the UI renders),
- **session journal streams** (baseline + change frames — this is how
  token deltas reach the page),
- **snapshot streams** (state baselines), and
- `gateway/internal` control outcomes.

This is the "ws session attach" the E2E plan observes. The official
page does NOT use our M2 plugin vocabulary on `/ws`; it expects this
endpoint.

### 2.5 Module bundles over `GET /plugins/**`

`client-modules` registers a **prefix route `/plugins`** serving the
client plugin module graph: `/plugins/<id>/<file>?rev=<rev>` per bundle
(+ `.map`), and an aggregate `/plugins/??<resources>&rev=<rev>` fetch.
Anything else under `/plugins` (including `/plugins/events` when the
HMR row is absent) is an unknown resource → 404. It also contributes
the two boot-globals rows (§2.6) without which the page shows the boot
failure screen by design.

### 2.6 Index injection rows the official page requires

Subscribers to `webserver/index-inject` in the shipped composition —
the rendered index MUST contain, in this spirit:

1. `globalThis.__ModuleLoader__` (bootstrap facade: `create({boot,
   staticModules, loadBundle?})` — inlined script row from
   client-modules),
2. `globalThis.__DSH_BOOT__` (the boot manifest/plugin graph — a JSON
   `global` row from client-modules),
3. `globalThis.__DSH_CONNECTION_RECOVERY__` (reconnect timing config —
   connection),
4. theme/preview rows (ui-theme, document preview, experimental
   inspector) — optional rows the page tolerates absence of,
5. the `__DSH_BOOT_READY__` settlement tail (the webserver appends it
   automatically as the last body row).

`apps/web`'s built `index.html` is deliberately bare (module entry +
modulepreload only); **serving it unmodified boots nothing** —
`window.__ModuleLoader__` missing produces the upstream boot-failure
page with an explicit error. The index render pipeline is therefore not
optional.

### 2.7 Other named routes (full-composition surface, not MVP)

Present in upstream compositions, absent from our first carrier pass:
`/api/session/uploadFileBinary` (POST, file upload),
`/api/file` (GET, media references), `/api/changes.summary` and
`/api/present.host` (GET, deliverables), open-in-app routes
(POST open / GET apps / GET icon prefix), the dev-only HMR SSE endpoint
`/plugins/events`, and webhook endpoints in server deployments. Named
routes compose; the carrier needs the route table, not these handlers.

## 3. CarrierServer alignment plan (Phase-B implementation spec)

Current carriers (`hosts/ios/App/Source/CarrierServer.swift`,
`hosts/android/.../CarrierServer.kt`,
`hosts/harmony/entry/src/main/ets/model/CarrierServer.ets`) are the M1
spike shape: one loopback listener, GET-only, hard-coded `/ws` upgrade,
directory static serving restricted to `.html`/`.js`, one-shot
`Connection: close` responses, a hand-coded `gateway-e2e` switch, and a
single WebSocket seat. What already matches, and what each host must
add to implement §2:

### 3.1 Already satisfied

- **Loopback binding + ephemeral port** — iOS `NWListener` with
  `requiredLocalEndpoint 127.0.0.1:0`; Android/Harmony equivalents bind
  the loopback interface and report the bound port. Matches `host:
  '127.0.0.1', port: 0` (the only legal mobile posture; never expose
  `0.0.0.0`).
- **Static files from a web root with traversal rejection** — the
  `..`-check + root-relative resolution matches §2.1's security shape.
- **RFC 6455 upgrade + text frames + ping→pong** — the handshake
  (`Sec-WebSocket-Accept` = SHA1(key+magic)), frame parser (masked
  client frames, 126/127 lengths), and close/ping handling satisfy the
  transport layer of §2.4.
- **Chunked streaming** — the `gateway-e2e` endpoints already stream
  `Transfer-Encoding: chunked`, which named-route handlers may reuse.
- **Handler-owned responses, one shot per connection** — legal: the
  contract lets a handler own its lifecycle; HTTP/1.1 keep-alive is not
  required (browsers retry new connections transparently).

### 3.2 Route table (replaces hard-coded dispatch)

Implement `register`/`registerUpgrade`/`registerFallback` semantics
natively:

- Two maps (exact, prefix) + one upgrade map + one optional fallback
  slot; **duplicate (kind, path) or duplicate upgrade path is a fatal
  config error** (throw-equivalent: abort activation, fail loud).
- Request matching: exact → longest prefix (prefix matches `p` and
  `p/…`) → fallback; **no fallback registered → 404**.
- Match on the decoded URL **pathname** (strip query; percent-decode
  once; bad escapes → 400, never a crash).
- Migrate the existing `gateway-e2e` switch and the `dsh-web-client`
  static/`/ws` wiring onto named routes: `exact /ws` upgrade, `prefix
  /gateway-e2e` route, plugin `web/` dir on the fallback seat. The M2/M3
  scenarios must stay byte-green — same paths, same order of served
  paths.

### 3.3 Upgrade dispatch

- Upgrades match **exact pathname only**; unknown upgrade target →
  destroy the socket (iOS: cancel the NWConnection; Android/Harmony:
  close the socket) — never fall through to static.
- **Multiple concurrent WS seats**: the official page opens
  `/api/remote.mux` while our M2 plugin vocabulary may still hold `/ws`
  (and the official page may reconnect). Replace the single
  `wsConnection` with a set keyed by connection; broadcast APIs become
  per-path. The `send(_:)` host seam gains a path/route parameter (or a
  handle object) — a host-facing API change to schedule with the
  Phase-B carrier PR.
- On carrier stop, destroy upgraded sockets explicitly (they are not
  covered by "close listening socket" on any of the three platforms).

### 3.4 Fallback seat → official dist

- Implement §2.1 verbatim: GET/HEAD → 405 otherwise; traverse-check →
  403; index render at `/` (and any deep SPA path without a file
  behind it? — NO: upstream serves **404** for missing paths, index
  renders only at dist root and `distIndex`; deep links need no SPA
  fallback because `<base href="/">` plus the router re-anchors);
  fixed MIME table + octet-stream; empty 404 bodies.
- The dist root is the staged plugin directory
  `presentation/official-web/dist/` (vendored, hash-manifested).
- **Index render pipeline** (§2.6): per index response, splice the
  injection rows into the vendored `index.html` — head rows after
  `<head…>`, body rows after `<body…>`, `__DSH_BOOT_READY__` tail last,
  then `<base href="/">`. Phase B minimal row set: `__ModuleLoader__`
  + `__DSH_BOOT__` (from the staged module graph) +
  `__DSH_CONNECTION_RECOVERY__` (static config literal). The row
  payloads are generated by the carrier from the staged plugin set —
  the same JSON shapes upstream emits, no upstream code involved.
- **Auth-lite** (mobile adaptation of §2.2): keep the
  token-in-URL → cookie exchange shape with a per-session random token;
  on a valid `?token=` GET of `/`, set a session cookie + 303 to clean
  `/`; serve index only with the cookie. The WebView is the only client
  on loopback, so full BrowserAuth (signature rotation, 30-day cookies,
  authority binding) is deferred; document the reduction in the carrier
  PR.
- **WS auth parity**: `/api/remote.mux` upgrade requests must pass the
  same cookie check before handshake (upstream rejects with a socket
  error; on mobile a plain socket close suffices).

### 3.5 POST /api bridge + body handling

- Today's carriers read only the request head; `consumeHTTP`/equivalents
  drop request bodies. Add: read `Content-Length` bodies up to a cap
  (256 KiB is ample for page RPC; upstream allows 300 MiB for uploads
  which Phase B does not serve), honoring `req.method !== 'GET'` on
  named routes (fallback stays GET/HEAD → 405).
- Dispatch to the runtime: the RPC envelope (`client-request` /
  `server-response`) is a frozen data protocol (D5) — the carrier
  forwards `payload` onto the runtime queue (thread rule: the JS
  runtime never sees a socket) and answers with the JSON envelope. The
  endpoint→capability mapping is the Phase-B gateway work; the carrier
  contract is only: parse, forward, answer, 400 on malformed input, 401
  without a valid session cookie.
- Long-running RPCs answer when ready (the handler owns the response);
  the page awaits by `rpcId`. Progress arrives over the mux, not by
  polling — consistent with D8.

### 3.6 Static serving generalization

The official dist is 89 files: `.js`, `.css`, `.woff2`/`.woff`/`.ttf`,
`.svg`, `.webmanifest`, `index.html`. Today's iOS carrier serves only
`.html`/`.js` and 404s the rest — the page would boot unstyled with
missing fonts. Required: the §2.1 MIME table extended with
`.woff2: font/woff2`, `.woff: font/woff`, `.ttf: font/ttf`,
`.png: image/png` (webmanifest icons), HEAD support (headers only),
and directory-listing refusal (EISDIR → 404). Keep `Connection: close`.

### 3.7 Explicitly out of scope for the Phase-B carrier

`compression` (default `none`; the dist is already minified and
loopback bandwidth is free), `0.0.0.0` binding, HMR `/plugins/events`,
webhook routes, the full signed-cookie BrowserAuth (see the §3.4
reduction), and the experimental inspector rows. Named-route
composition means these can land later without touching the table.

## 4. E2E prep: log-observable official-app behaviors

The official page cannot be edited to emit `dsh.spike.log:` lines, so
the one-to-one manifest (log-based E2E, unique scenario id, expected ↔
logged) is carried by **carrier-side observations of the wire**, plus
one platform-side rendered-state probe. Proposed scenario
`b1.official-web.mount` (iOS first, then Android/Harmony), in fixed
order:

| # | event (carrier log) | source of truth |
| --- | --- | --- |
| 1 | `client.selected` = `dsh-web-official` | host config flip |
| 2 | `index.rendered` (`rows=<n>`) | fallback seat rendered index (byte count + row count deterministic) |
| 3 | `index.served` (GET /, 200) | request log |
| 4 | `asset.served` first asset path | request log (deterministic first fetch: entry chunk) |
| 5 | `upgrade.accepted` path=`/api/remote.mux` | upgrade dispatch |
| 6 | `rpc.observed` first `POST /api/<endpoint>` | request log (endpoint name pinned in the manifest) |
| 7 | `session.attached` first mux journal/snapshot stream opened | mux frame log |
| 8 | `token.delta.forwarded` | mux frame log (session journal change frame with content delta) |
| 9 | `page.rendered` (probe: platform `evaluateJavaScript`/equivalent asserts the transcript DOM grew, log the boolean) | rendered-state evidence per the M3 precedent, without editing upstream code |

Manifest rules: each event carries the scenario id in the canonical
envelope; subset field matchers; nothing missing, nothing extra. The
`rpc.observed` endpoint name is pinned per manifest — the candidate
first calls are in the `session`/`settings`/`typert` namespaces (see
§2.3); capture once, then freeze the observed name in the manifest
instead of predicting it here.

### What the official app needs beyond static+WS (startup RPC surface)

Enumerated from source at the pin (§2.3–§2.6):

- `GET /` — index with the injection rows (NOT the bare dist file),
- `GET /plugins/**` — client module bundles (aggregate
  `/plugins/??…` form included),
- `POST /api/<endpoint>` — unary RPC, envelope per §2.3; namespaces:
  `session`, `settings`, `credentials`, `workspace`, `terminal`,
  `goals`, `skills`, `fileReferences`, `directoryPicker`, `archive`,
  `typert`,
- `WS /api/remote.mux` — one multiplexed push socket (remote events +
  session journal + snapshots + `gateway/internal`),
- later (not MVP): `/api/session/uploadFileBinary` (POST),
  `/api/file`, `/api/changes.summary`, `/api/present.host` (GET).

A carrier that serves the dist unmodified with only the M2 `/ws`
upstream **cannot boot the official page**: no `__ModuleLoader__`, no
`__DSH_BOOT__`, no `/api`, no mux. That failure mode is the upstream
boot-failure screen — fail loud, by design.

## 5. References

- Vendored dist + provenance + reproducible build:
  [presentation/official-web/](../presentation/official-web/) (pin
  `ddefc45f…`, tag `dsh-v0.1.6-alpha.2`, 89 files, sha256 manifest).
- Carrier topology context: `anywhere-labs/dsh-desktop`
  `docs/architecture.md` — loopback HTTP+WS carrier, sandboxed
  renderer, same-origin page load (the WebView IS the sandbox).
- Current spike carriers: `hosts/ios/App/Source/CarrierServer.swift`,
  `hosts/android/app/src/main/java/com/dshmobile/spike/CarrierServer.kt`,
  `hosts/harmony/entry/src/main/ets/model/CarrierServer.ets`.
- E2E manifest conventions: `tools/e2e/README.md`, `docs/e2e-matrix.md`.
