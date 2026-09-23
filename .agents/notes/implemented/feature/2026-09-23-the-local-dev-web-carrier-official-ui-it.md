# Agent Note: the local dev web carrier — official UI iteration at desktop speed

Status: implemented
Related: D9, D15

## Problem

Iterating on carrier-side UI decisions — index injection rows, the boot
graph the official page consumes, the settings-dialog phone adaptation
CSS — required the full on-device loop: gradle build → emulator boot →
install → launch the drive → eyeball the screenshot. Minutes per CSS
tweak, and the only feedback surface was a screencap. The desktop CLI
host could not shorten this loop: it has no HTTP/WS carrier at all (bus
posts have no sink; `--bus-inject` is a one-shot startup file), so a
desktop browser had no way to reach the runtime's wire.

## Decision

`tools/dev-web-carrier/` ships a Node dev carrier that mounts the
vendored official Web Client (`presentation/official-web/dist`, zero
upstream edits) in a desktop browser:

- **Boot wire is composed, not hand-built**: the vendored
  `@deepseek-ai/dsh-client-modules` Node half (`ClientModuleRegistry` +
  `bootInjections`) composes the same graph the mobile runtime composes,
  over the same staged inputs (client-bundles roster + the sha256-pinned
  vendored bootstrap). The Node mount ports `web-boot.js`'s
  `mountClientModules` loader decoration over real file trees
  (QuickJS stages a VFS because that runtime has no fs; Node reads the
  committed trees directly), and cross-parses the graph through the
  vendored browser bundle — 58 entries / 2 batches, identical to the
  on-device `m2.upstream-boot` numbers.
- **The carrier surface follows the platform siblings**
  (docs/webserver-contract.md §2): `/plugins` serves revisioned combos
  at the composed graph's revs (CarrierPlugins.kt port incl. framedHash
  revs and identity maps); the fallback seat renders the index pipeline
  (rows + `<base href="/">` + `__DSH_BOOT_READY__` tail) behind
  auth-lite token→cookie (CarrierWebDist.kt port); `/api` and
  `WS /api/remote.mux` answer the mobile runtime's honest claim surface
  — `session.list` from a fixture, `session/journal` as a fixture
  replay, structured `gateway/unimplemented` envelopes elsewhere,
  `workspace/follow` and `$events` accepted and held quiet.
- **Cold start to a booted, interactive official UI: ~0.5 s** (boot-wire
  composition 158 ms), verified headlessly: full app chrome renders,
  the settings dialog opens (800×800 desktop), and at a 390 px viewport
  the injected phone adaptation measures full-bleed 390×844 with the
  nav flipped to a row — the exact SETTINGS_PHONE_CSS case that
  previously needed an emulator cycle.
- **It is a local iteration tool, not an E2E oracle**: CI assertions
  stay log-based with scenario ids (AGENTS.md "E2E by logs"); this
  layer buys the edit → reload loop only. What it serves is honest
  about what it is: fixture-backed claims, loud unimplemented
  envelopes, never a faked success.

## Alternatives considered

- **A live bus on the spike CLI** (C change: bus sink → stdout) — the
  real runtime answering the page, but it drags the full local C build
  (including the vendored ish userland) into every iteration and only
  covers the CLI's claim surface anyway; deferred as the follow-up path
  for live sessions, while composition alone already reproduces the
  devices' boot wire byte-for-byte in shape.
- **Hand-built boot rows** (a CarrierBootConfig.default-style carrier
  graph: one application batch) — simpler, but it drifts from what the
  devices actually serve and breaks silently on upstream re-pins;
  rejected for fidelity.
- **Replaying recorded artifacts** — the committed artifacts carry
  event summaries, not the full wire (the CLI drops bus posts); replay
  would go stale on every re-pin. Rejected.
- **`adb reverse` to a device host** — real everything, but the
  emulator stays in the loop; the speed ceiling remains minutes. This
  remains the right tool for device-integration questions.

## Consequences

The Node mount duplicates ~40 lines of `web-boot.js`'s loader
decoration — deliberate (the adapter is QuickJS-hosted; the dev carrier
is Node-hosted), documented at the duplication site. The mux's quiet
`workspace/follow` / `$events` acceptance clears the reconnect badge
without fabricating event shapes the fixtures do not honestly have;
when the write surface (upstream/web-write.js) is ever composed in
Node, those streams get real answers and the fixtures shrink.
