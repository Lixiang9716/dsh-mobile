# Agent Note: W-INTEG PR-B: the official web app boots the live module system on-device over the contract carrier

Status: implemented
Related: D9, D5, D8

## Problem

Phase-B landed the contract carrier with carrier-GENERATED placeholder boot
rows, so the official page always died on the by-design boot-failure screen
(no `@deepseek-ai/dsh-client-modules/client.js` registration existed) and
b1's manifest honestly carried `runtime.pending`. The runtime side (sibling
PR) now composes the real boot wire — but nothing on-device consumes it: the
carrier still renders its defaults, no `/plugins` route can serve the real
browser bundle under the runtime's revisions, and the WebView never loads a
page whose facade could succeed.

## Decision

- **The web-boot closure ships inside the app.** The embedded spike bundle
  (gen_bundle_header.py + SpikeBundleStager) gains the b1-web-live scenario,
  `upstream/web-boot.js`, its shims, and the vendored npm libs the
  composition imports (cordis → cosmokit, schemastery → cosmokit, the
  client-modules node + browser faces) — ~170 KB of source, NOT the full
  agent spine. A dedicated `RuntimeThread` drives the scenario on-device;
  the drive reads the staged plugin files (Documents/web-plugins, staged by
  run-ios-b1.sh from the pinned vendor tree, fixed generation stamp) and
  delivers the `web.plugins` bus line; the runtime posts `web.boot` back.
- **The carrier consumes the runtime wire.** The index rows closure prefers
  the received `web.boot` rows (facade queue script, blocking bootstrap
  batch, `__DSH_BOOT__` graph) plus the recovery global; CarrierPlugins
  adopts the runtime's graph revisions (`applyRuntimeRevs` — the upstream
  composer's initial revisions are per-boot placeholders, so serving must
  validate against the runtime's revs, not carrier content hashes); the
  origin opens ONLY after `web.boot` is applied, so the page load can never
  race the composition.
- **b1 goes live, honestly.** The manifest grows to 13 one-to-one events:
  the JS scenario's own `runtime.booted`, the carrier's `web.boot.applied`,
  the served REAL bundle (36,040 prepared bytes at the runtime combo URL),
  `module.system.live` (the facade materialized the vendored bundle and
  flipped queue→live — the real boot progression past the failure screen),
  and `page.rendered` now reads `moduleMode: "live"` with the loader
  progress state (HARNESS + spinner, no failure text). The mux journal open
  still answers structured `gateway/unimplemented` — the embedded closure
  has no agent spine, so the leg is renamed `session.services.pending`
  (session services are the next named gap; the runtime itself is live).
  Screenshots: boot screen → live loader state.
- **Latent carrier bug fixed en route**: the `global` injection row rendered
  its name as a BARE identifier (`globalThis[__DSH_BOOT__] = …`) — a
  ReferenceError before assignment, silently harmless while no row ever
  executed in-page, fatal the moment the real bundle made create() read the
  graph. The name is now a JSON string (`globalThis["__DSH_BOOT__"]`).

## Alternatives considered

- **Embedding the full vendored agent spine to claim `session.list` and the
  journal on-device too** — deferred: ~2.8 MB of source through the C-array
  embedder (≈14 MB generated) against a same-night window, when the CLI
  scenario already proves the claimed surface against the REAL services.
  The on-device claims are the next leg, not a silent gap.
- **Keeping the carrier-generated default rows and letting the runtime
  rows race them** — rejected: a page load racing the composition would
  nondeterministically boot against placeholder rows. The origin gate makes
  the runtime wire the only wire the page can see.
- **Pinning the combo rev in the manifest** — rejected: the upstream initial
  revision is a per-boot nonce by design; the manifest pins the
  deterministic byte length (36,040) and the scenario-side `runtime.booted`
  entries instead. Derived facts, never raw nondeterminism.

## Consequences

- b1 now proves the full Phase-C seam on-device: runtime composes → carrier
  renders → official page boots the REAL client module system. The next
  named gaps, in boot order: the application-tier client bundles
  (client-web shell + ui plugins, monorepo-build artifacts), then the
  session services + journal stream (agent spine embed or host-side
  session attach).
- `run-ios-b1.sh` stages Documents/web-plugins from the pinned vendor tree;
  a missing tree fails the drive loudly at delivery.
