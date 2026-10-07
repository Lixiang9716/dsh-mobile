# The product web-live boot producers leave scenario/

Status: implemented

## Problem

`runtime/dsh/scenario/` carried two populations under one roof: pure E2E
drivers (boot-verification.js, session-mock-llm.js, the planes, the
upstream-suite legs) and the PRODUCT boot entries the hosts' production code
loads directly — the official web seat's mount/read/write trio
(officialweb-web-live.js, session-web-live.js, composer-web-live.js), the
android-*/harmony-* platform twins, and the write-surface options assembly
(write-surface-options.js) the product write plane composes through. The
layering was inverted: production code (upstream/web-write.js's write
surface) had its options/workspaceRegistry assembled by a file living in the
E2E layer, and that seam had just produced a dangling-reference incident.
Every host constant pointing at `scenario/<product file>` deepened the
confusion — an E2E-layer purge or rename could take the product seat down
with it.

## Decision

The 14 product-side files moved to a new sibling directory
`runtime/dsh/web-live/` (single responsibility: the official web seat's
product boot producers):

- the neutral trio: officialweb-web-live.js, session-web-live.js,
  composer-web-live.js
- the platform twins: android-officialweb-web-live.js,
  android-composer-live-write.js, android-session-live-read.js,
  harmony-composer-live-write.js, harmony-session-live-read.js,
  harmony-httpfetch-streaming.js (production-referenced via
  OfficialPhase.ets ENTRY_HTTPFETCH)
- the write-surface assembly: write-surface-options.js
- the four shared pieces: api-handler-respond.js, scenario-verdict.js,
  probe-respond-await.js, manager-legs-probe.js

The four shared pieces moved WITH the products (dependency direction: the
E2E layer and the panel tests may import product code; product code never
imports from the E2E layer). api-handler-respond and scenario-verdict were
already product-only imports; probe-respond-await and manager-legs-probe
keep one E2E importer each (settings-surfaces.js now imports
`web-live/...`), which is the clean direction and leaves web-live/
self-contained — no `scenario/` specifier survives inside web-live/.

Everything downstream followed the move mechanically:

- host constants: OfficialPhase/OfficialServe (ets ENTRY_*), Index.ets
  BUNDLE_FILES rows, the four Kotlin ENTRY constants, the three iOS
  scenarioPath strings + project.yml inputFiles
- iOS embedder: gen_bundle_header.py RESOURCES rows re-pointed (accessor
  suffixes keep their historical names — the Swift link sites are
  unchanged) and a whole-dir `web-live` TREES row joined `scenario`
- stagers: stage-spine-closure.sh carries a second scenario-kind list pair
  for web-live (and android-officialweb-web-live.js joins the staged list —
  it had been a committed-only asset row, the embed-list trap);
  vendor-official.sh CLOSURE/SPINE_OURS rows re-prefixed and the rawfile
  sweep gained its web-live twin loop
- tools: check-staging-graph (BUNDLE_DIRS + SCOPE_PREFIXES),
  check-staging-hosts (android parses both list pairs; harmony/ios roots
  include web-live rows), gen-staging-manifests (android facts classify
  the eight for-in lists by dir×role; the roster counts both dirs)
- panel tests: three test imports + vitest aliases re-pointed
- the bundle-files rejection case's fixture follows the file (plane
  re-sealed; unattended consent recorded in rituals.jsonl)

Frozen by design: test/e2e/matrix.mjs LEGACY_STEMS keys, scenario ids
(the SCENARIO constants inside the files), manifest filenames, committed
evidence under hosts/*/artifacts, and the AOCI index (aoci rebind follows
separately).

## Alternatives considered

- Keep the four shared pieces in scenario/ and import them from web-live/:
  rejected — that preserves product→E2E imports, the exact dependency
  direction this move exists to remove.
- Move only the boot entries and leave write-surface-options.js behind:
  rejected — the write surface's options assembly IS product code (the
  upstream/web-write.js seam imports through it); leaving it would keep the
  cross-layer reference the task set out to kill.
- Prefix-merge both rosters into one for-in loop in the android stager:
  rejected — the staging tools derive rows from list shape plus the loop's
  cp/cmp anchor; one mixed list would mislabel web-live rows as scenario/
  rows. Two explicit list pairs keep every tool's derivation honest.

## Consequences

scenario/ is now purely the E2E scenario layer; web-live/ is product. A
future scenario-layer rename cannot dangle a product reference, and the
panel/staging tooling has one more declared bundle dir to keep honest.
