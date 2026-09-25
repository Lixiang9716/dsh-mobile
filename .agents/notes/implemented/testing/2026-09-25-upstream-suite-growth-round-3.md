# Upstream-suite growth round 3: fixture staging + the test-face npm bridges

Status: implemented

Date: 2026-09-25 · Class: testing · Follows: the growth round 1 (testing)
and round 2 (feature) notes of the same day.

## Problem

Two queues from round 1/2's maps: the five `preset__agent-presets__tests__*`
specs loaded and ran but every test failed because the fixtures tree their
`../fixtures` joins point at existed nowhere in the staged views; and the
suite's source packages import npm test faces (`zustand/vanilla|shallow|
middleware`, `eventsource-parser/stream`) that were neither vendored nor
bridged (~21 module-gap specs, plus a `watch` class the chokidar linkage
shim surfaced). Separately, several specs died on `cannot read property
'node' of undefined` — a process-face gap, not a fixture gap.

## Decision

- **Fixture staging, end to end**: `transpile.mjs` emits a
  `<stem>.fixtures.js` data module (base64 bytes + seeded paths) for every
  spec that ships a `tests/fixtures` tree; the suite driver seeds it into
  the staged fs view (`shims/fs.js` gains the `/upstream-tests/` VFS root
  and a generic `seedStagedFiles`, the merge-semantics sibling of
  `seedWebPlugins`) BEFORE the tests run. The preset specs' `pathToFileURL
  (FIXTURES).href + "/"` baseUrl then resolves against REAL seeded files —
  17 files seeded for authoring, and the family went from 0-pass to
  28 passing tests (authoring 9, remote 13, invariant 3, user-root 2,
  shipped-root 1). One spec per runtime, so the flat
  `/upstream-tests/fixtures` namespace never collides.
- **Test-face npm bridges**: `zustand@4.4.7` and `eventsource-parser@3.1.0`
  vendored at the dsh-v0.1.6-alpha.2 lockfile's exact resolutions (the
  ACP sdk's zod peer is our own pinned 4.4.3). Five bridge rows
  (`zustand/vanilla|shallow|middleware`, `eventsource-parser/stream`,
  `eventsource-parser`) point at each package's own ESM face — the loader
  resolves concrete files, not exports maps. These faces are NEVER mounted
  by the product boot: test faces, not closure.
- **The process face completed**: `process.versions.node`/`execArgv` (the
  cordis-plugin-loader probes both on import), and `shims/globals.js` now
  delegates its ambient-process fallback to the node:process shim's FULL
  default instead of a hand-rolled subset — a partial global crashed the
  loader import in every spec that composes it.
- `fromBase64` exported from `shims/buffer.js` (the driver's fixture
  seeding needs it; it was module-private).

## Alternatives considered

- **Serving fixtures from disk through the CLI's cwd**: rejected — the
  device legs have no repo tree; bundle-embedded data modules are the only
  shape that works identically on CLI and device.
- **Vendoring `@agentclientprotocol/sdk@1.4.0` too** (8 gap specs):
  deferred — it rides `node:http` for its transport, so vendoring without
  the http seam buys a load-success and red tests; revisit with the
  gateway-seam project.
- **Preset POSIX-mode semantics** (the family's remaining ~37 failing
  tests exercise mode-tightening and copy-tree ordering): deferred — deep
  per-test behavioral work in the staged fs, honest as red.

## Consequences

The staging pipeline is generic: any future spec shipping a
`tests/fixtures` tree gets its bytes seeded with no per-spec wiring. The
npm test faces set the closure-policy precedent the owner approved (pin
at the tag's lockfile versions, serve through bridges, never mount).
Round-3 sweep numbers are recorded in the PR.
