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
5. **The embed**: the five pins (dsh-web, dsh-tool-web, turndown 7.2.4,
   @mixmark-io/domino 2.2.0, @joplin/turndown-plugin-gfm 1.0.67 — shas
   mirroring the suite-side pins) sit in `ensure-dsh.sh`'s NPM_PACKAGES
   (#341 carried the rows to main first; this PR's snapshot had added them
   at a second position and the cherry-pick collapsed to main's shape).
   The dsh/tool faces stage at the `vendor/dsh/<rel>@ver` paths the
   preset-health marker seeders walk (the tool-present npm-face pattern)
   on all three hosts:
   - **android** `stage-spine-closure.sh`: `stage_npm_face_at_dsh_path`
     tool-web + the direct dsh-web/turndown/domino/joplin block (snapshot);
     this landing added the block's VERIFY twins (`verify_npm_face_at_dsh_path`
     tool-web/plugin-manager + the chain cmps) — the snapshot staged them
     outside every --check twin, a drift the closures gate was blind to —
     plus `verify_npm_face_at_dsh_path plugin-manager` for #340's face, and
     the `manager-legs-probe.js` verify-list row the #340 round missed
     (the stage/verify scenario twins had drifted; round-trip FATAL on main).
   - **harmony** `vendor-official.sh`: the same helper shape (tool-web,
     plugin-manager, direct dsh-web) sourcing the NPM_PACKAGES faces, with
     the HTML→markdown chain in the CLOSURE list (turndown row + a
     domino/joplin find segment) — all of it byte-verified by a --check twin
     with the tracked-skip rule. The snapshot's version had declared the
     faces as CLOSURE rows and a SPINE_OURS find over
     `runtime/spike/vendor/dsh/dsh-*@` trees that only `add-package.sh`
     extracts — unpinned, untracked, absent on a cold clone (the sync dies
     in the find). Those stray extracts are deleted; the stager now derives
     from the pins alone.
   - **iOS** `gen_bundle_header.py`: TREES tuples for tool-web +
     plugin-manager (the preset-riding npm-face shape), dsh-web at its own
     dir name, and the turndown/domino/joplin chain (boot.js mounts the web
     plane unconditionally — an embed without the faces dies loud at the
     mount's first dynamic import); `upstream/web-search-keyless.js` rides
     an iOS RESOURCES row and the android/harmony whole-dir mirrors.
   - harmony's `Index.ets` BUNDLE_FILES re-derived from the rawfile tree
     through `ci/check-bundle-files.mjs` (the oracle): 90 rows added, the
     313 duplicate hand rows collapsed, list re-sorted — 1051 listed =
     1051 rawfile files on disk, both directions; every row is a file the
     stagers actually stage.
   - **The device-leg pins follow the runtime** (the #339 class): the
     mounted `web_search` row grows the agent tool surface 14 → 15, read
     off the failing CI run's logged `llm/request/built` payloads —
     `android-session-live-read.json` (×2) and
     `android-composer-live-write.json` (×1). `upstream-session.json`
     keeps 14: the parity golden boots the stock upstream spine, which
     this round does not touch (its leg stayed green).

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
- **Harmony staging sourcing the `vendor/dsh/dsh-*@` extract trees** (the
  snapshot's shape: CLOSURE rows + a SPINE_OURS find over them): rejected —
  those trees exist only where `add-package.sh` ran (no pin row materializes
  them; `ensure-dsh.sh` extracts NPM_PACKAGES to `vendor/npm/@deepseek-ai/`),
  so a cold clone's `vendor-official.sh` died in the find before any check.
  The shipped block sources the pins, the only reproducible bytes.
- **Harmony staging the faces at their same-rel npm paths** (the C loader's
  third probe family resolves them there): rejected for tool-web and
  plugin-manager — the preset marker seeders walk `vendor/dsh/` dirs only,
  so an npm-rel stage would leave both roster rows reading unresolvable
  on-device (the #340/#324 lesson). dsh-web carries no roster row, but it
  rides the same block to keep one staging shape across hosts.

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
