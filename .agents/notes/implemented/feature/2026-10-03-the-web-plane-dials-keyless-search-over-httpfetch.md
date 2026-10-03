# Agent Note: the web plane dials — the keyless search leg mounts the vendored tool-web closure over gateway httpFetch (issue #335 B5)

Status: implemented
Related: T-0172 (B5), #335

## Problem

The `tool-web` preset row (the vendored `@deepseek-ai/dsh-tool-web` —
`web_search`/`web_fetch` over the `ctx.web` capability seam) sat in
`preset-mobile-rows.js`'s MOBILE_ABSENT_ROW_IDS under a two-part wall:

1. **Link time** (the 2026-09-24 closure note): `dsh-tool-web` statically
   imports `turndown`, whose ESM face `require()`s the CJS-only
   `@mixmark-io/domino` at module top — "no require seam, package skipped".
2. **Transport**: every vendored search provider (`dsh-web-search-deepseek`,
   `-exa`, `-perplexity`) calls the global `fetch`, which in this runtime is
   a fail-loud value — the gateway's `httpFetch` is the only network seam.
   Even with the closure loadable, a mounted `web_search` had nothing to
   dial with.

Wall (1) has been false since the W4-P suite round: the shims' cjs-loader
serves domino per-file and the npm-bridges rows (`turndown`,
`@joplin/turndown-plugin-gfm`, the `dsh-bridge-setup/globals` require arm)
already load the full HTML→markdown chain — the vendored tool-web specs run
inside quickjs-ng. Only the product closure never carried the bytes.

## Decision

The web plane mounts, and the row un-disables:

1. **`upstream/web-search-keyless.js`** — the mobile search provider per the
   vendored `WebSearchProvider` contract ({id, available(), search(request,
   signal)} → {sources[], truncated}): a DuckDuckGo HTML-endpoint scraper
   whose transport is INJECTED `httpFetch` (tests pass a mock; boot.js passes
   the gateway). The parser is a pure function — title anchors (`result__a`,
   lite's `result-link`), uddg-redirect decoding, `result__snippet`/
   `result-snippet` text, two-pass entity decode (DDG double-escapes snippet
   text), duplicate-URL collapse — unit-tested against fixed samples in
   `test/panel/web-search-keyless.test.js`. Keyless is honest about its
   class: the provider DETECTS DDG's anti-bot challenge (HTTP 202 / the
   "bots use DuckDuckGo" marker — measured 2026-10-03 from a datacenter
   egress on html, lite, POST, and the IA API) and fails the call in-band
   with a coded error (`WEB_SEARCH_KEYLESS_CHALLENGED`) that names the
   escape hatches, instead of parsing a challenge page into fake results.
2. **Config** (the marketplaceIndex opt-in pattern): the endpoint resolves
   `globalThis.__dshWebSearch.endpoint` → launch env
   `DSH_WEB_SEARCH_ENDPOINT` → the public endpoint; a non-string value fails
   loud. A seat behind a permanent challenge points the endpoint at an
   unchallenged mirror without code changes.
3. **boot.js** mounts the plane in mountSpine (after the tool rows, before
   file tools): the vendored `@deepseek-ai/dsh-web` seam, the keyless
   provider registered into it, and `@deepseek-ai/dsh-tool-web` with
   `search: true, fetch: false` — search only, because no fetch provider
   exists over httpFetch and a row without one would fail every `web_fetch`
   at call time. `spineInventory` carries the `web` service and `tool-web`
   rows so the 插件 panel reports mounted truth.
4. **The row un-disables**: `tool-web` leaves MOBILE_ABSENT_ROW_IDS (the
   standard/cordis/ptc documents keep their row), the mobile preset
   (`presets-mobile/mobile/agent.cordis.yml`) gains the row with
   `fetch: false`, and its description drops 网页检索 from the walled list.
5. **The embed**: the five pins joined `ensure-dsh.sh`'s NPM_PACKAGES
   (dsh-web, dsh-tool-web, turndown 7.2.4, @mixmark-io/domino 2.2.0,
   @joplin/turndown-plugin-gfm 1.0.67 — shas mirroring the suite-side pins;
   `ensure-dsh.sh` re-materialized and stamp-verified them). The dsh pair
   stages at the `vendor/dsh/<stripped>@ver` rel path the preset-health
   marker seeder walks (the tool-present npm-face pattern) on all three
   hosts: iOS TREES (+ regenerated SpikeBundle.c, build-time artifact),
   android `stage-spine-closure.sh` (run; assets byte-verified), harmony
   `vendor-official.sh --closure-only` (run; `check-bundle-files` clean,
   1018 = 1018 both directions). `upstream/web-search-keyless.js` rides the
   android/harmony whole-dir mirrors and an iOS RESOURCES row.

## Alternatives considered

- **Vendored keyed providers (exa/deepseek/perplexity)**: rejected for v1 —
  all dial the global `fetch` (fail-loud here); serving them means building
  a real egress surface over httpFetch (streaming body both directions,
  TLS via the host) — a transport project, not a provider mount. Recorded
  as the owner-key follow-up: when the seat gains a keyed provider, it
  mounts beside the keyless leg and pins `searchProvider` on the seam.
- **DDG Instant Answer API** (JSON, no scraping): rejected — it answers
  instant answers/related topics, not web search results, and measured 202
  from the same egress anyway.
- **Keep the row disabled, cockpit-side /api only**: rejected — the ask's
  own branch condition ("上游包存在 → 按 vendored 工具的 provider 接口实现
  provider,解禁行") resolves the other way: the tool closure is loadable
  and proven by the suite, so a cockpit-side shadow endpoint would duplicate
  the seam the vendored tool already owns.
- **A DOMParser shim instead of the cjs-loader**: not needed — domino IS the
  DOM implementation; the cjs-loader serves it with node's cycle semantics.

## Consequences

- `web_search` works keylessly wherever the device's egress IP passes DDG's
  bot wall (carrier/residential typically); where it does not, the tool
  fails with a structured, self-explaining error — never silent, never
  faked. `web_fetch` stays unregistered until a fetch provider lands over
  httpFetch (the natural next leg: the same injected-transport shape over
  domino/turndown, which now ride the closure).
- The closure grew ~680 KB of embed bytes (domino's 53-file CJS graph is
  the bulk) — the price of the verbatim upstream tool; the W4-P round
  already paid it in the test closure.
- The mobile preset description and the absent-row comments now match the
  mounted truth; the standard composition's `fetch: true` row shape stays
  upstream-verbatim (an enabled-but-unavailable fetch tool fails in-band,
  the state the vendored tool contract documents).
