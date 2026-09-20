# Agent Note: W-DROID: the official upstream web boot mounts in the Android carrier's WebView

Status: implemented
Related: D9, D5, D6, D8

## Problem

The Android host ended at M4: its loopback carrier served the embedded demo
Web Client with carrier-generated placeholder boot rows, so the official
upstream web app (the W-SHELL dist + client bundles iOS already mounts) had
no Android face — no fallback seat for the vendored dist, no `/plugins`
route that can serve the real browser bundle under the runtime's revisions,
no `/api` transport, and no WebView load whose facade could succeed. The
iOS carrier had crossed this bridge in W-INTEG PR-B; the Kotlin host still
verified none of the webserver contract, and D9's Android leg (the official
UI booting on the carrier) was open.

## Decision

- **The carrier becomes a real `ctx.webServer` implementation.**
  CarrierWebDist is the fallback seat (GET/HEAD, traversal → 403, fixed
  MIME table, empty 404s, token→cookie auth-lite gating the index only)
  with the full index render pipeline: head rows after `<head…>`, body rows
  after `<body…>`, the `__DSH_BOOT_READY__` tail last, `<base href="/">`
  first. CarrierPlugins serves the staged 58-package application tier as
  revisioned single combos, `??`-aggregates, and identity maps, and adopts
  the runtime's graph revisions (`applyRuntimeRevs`) — the same JSON/URL
  shapes upstream emits, carrier-generated (contract §3.4). CarrierAPIBridge
  parses the frozen `client-request` envelope, validates endpoint segments,
  and answers every unclaimed endpoint with the structured
  `gateway/unimplemented` envelope (200; the error rides inside); the
  `/api/remote.mux` upgrade opens the single mux seat whose `open`/`cancel`
  frames bridge over the bus seam, and unclaimed streams get the
  structured error frame — the honest services gap, never a hang.
- **The web-boot drive is the iOS composition, ported.** The b-android-web-live
  scenario embeds the web-boot closure only (upstream/web-boot.js + shims +
  vendored cordis/cosmokit/schemastery/dsh-client-modules — NOT the agent
  spine), receives `web.plugins` (staged files, sorted package order =
  deterministic graph tie-break), and posts `web.boot`; OfficialWebSession
  swaps the rows into the render pipeline, overrides the `/plugins` revs,
  and opens the origin ONLY after the runtime wire lands. The WebView then
  boots the REAL upstream module system: facade queue→live, application
  tier mounts, boot page disposes, official shell renders. The same-origin
  probe (OfficialWebProbe, via a `dshProbe` JavascriptInterface because
  WebView cannot await a Promise from evaluateJavascript) verifies combo
  fetch, mux upgrade, one unary RPC, and reads the TRUE rendered state.
- **Everything upstream stays verbatim (D6/D9).** The vendored `lib/` bytes
  in assets are identical to the runtime/spike pins (only docs/bin pruning
  differs, to keep the APK lean); the dist and client bundles ride the
  provenance-verified ensure scripts; the Gradle build fails loud when a
  tree is missing (the check is a plain task — a Copy whose source is
  absent skips as NO-SOURCE before any doFirst can fire).
- **Two Android-transport facts shaped the evidence.** logcat truncates
  lines at ~4KB, so `runtime.booted` emits `entryCount` instead of the
  58-id list (iOS logs the full array; no such cap there); and the
  entry-chunk evidence filter pins `/assets/index-*.js` — the dist also
  ships `index-*.css`, and which the page fetches first is a browser race
  a 5-run soak caught flipping. The manifest stays 14 one-to-one events in
  a soak-stable order; `/api` namespaces and mux streams remain
  structured-unavailable (no agent spine embedded — session services are
  the next named gap).

## Alternatives considered

- **Serving the runtime's `web.boot` wire from carrier defaults only
  (no runtime composition on-device)** — rejected: it would re-fork the
  boot graph in Kotlin, exactly what D5/D9 forbid; the graph's revs must
  come from the same composer the runtime uses or `/plugins` validation
  diverges.
- **Embedding the agent spine to claim `session.list` + the journal like
  W-SESS did on iOS** — deferred: the official-shell milestone does not
  need claimed services, and carrying the spine through the Android
  embedder is its own leg; until then the carrier answers structured-
  unavailable, which the manifest pins as evidence, not a silent gap.
- **A system WebView via Chrome custom tabs or an external browser** —
  rejected: the milestone is the app carrying its presentation in-process
  over the loopback carrier; an external browser cannot be an E2E target
  and breaks the single-process session model.
- **Screen-of-truth assertions on the rendered shell** — rejected per the
  E2E-by-logs contract; screenshots stay human evidence alongside the
  one-to-one log verdict.
