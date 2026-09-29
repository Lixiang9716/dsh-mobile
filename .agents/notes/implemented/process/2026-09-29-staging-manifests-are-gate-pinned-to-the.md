# Agent Note: staging manifests are gate-pinned to the real import graph (check-staging, staging-check)

Status: implemented
Related: D5

## Problem

Every host's staging manifest is a hand list (harmony's `Index.ets`
BUNDLE_FILES, android's `stage-spine-closure.sh` scenario list), and a hand
list drifts from the real import graph silently: a new `import` added to the
closure still boots green on a dev disk (the file is there) and dies only on
a fresh device install — the exact failure class of the 2026-09 `shims/`
splits. Nothing compared the lists to the graph, and nothing gated the
comparison, so the fresh-install death shipped. The triage this note
records found 23 such gaps (17 harmony, 6 android) — all REAL: static
imports of staged entries, or a dynamic import whose failure surfaces at
the call site. The android proof was byte-level: the committed
`upstream-fake-timers.js` asset had silently drifted from its
`runtime/spike` canonical because no check covered it.

## Decision

`tools/check-staging.mjs` walks the closure's import graph from the boot
entries plus every staged scenario and checks each manifest in both
directions (graph→manifest coverage, manifest→disk staleness). It gained a
`--block h1,h2` flag: named hosts are blocking (findings exit 1), all other
hosts run warn mode (findings counted and reported, exit 0) — the mode for
residuals triaged as mitigated elsewhere. The `staging-check` gate is wired
(`gov gate add`, in the `all` mode, sealed) pinning `--block
harmony,android,ios`: the 2026-09-29 triage cleared every host's REAL gaps
(17 rows into `Index.ets` BUNDLE_FILES + `vendor-official.sh` SPINE_OURS in
lockstep, rawfile re-synced 912=912→929=929; 6 scenario rows into the
android stage+byte-identity loops, assets re-staged), so no host needed the
warn-mode escape. Harmony's `vendor-official.sh` CLOSURE/SPINE_OURS surface
stays advisory (31 counted context gaps, never a verdict).

## Alternatives considered

- Leaving check-staging unwired (the tool header's original stance: report
  to the owner first): lost because an unwired verifier is the 静默 leg of
  the four ways a hand list dies — the triage existed precisely to wire it.
- A warn-only gate (no `--block`): lost because all 23 gaps were REAL and
  fixed in the same change; a gate that cannot fail is vacuous (rules.md
  rule 6) and the disease proof shows blocked mode names the row and exits 1.
- Whole-dir mirrors per host (the android `upstream/**` pattern) for
  harmony's rawfile: lost because rawfile is a committed, tracked tree
  materialized by `vendor-official.sh` — the row lists ARE the staging
  contract there, and `check-bundle-files` already pins list==tree; the
  graph walk is the third leg (list==reality), not a replacement.
- Suppression lists (skip-file annotations in the walker): lost because a
  mitigation must name its runner line in the triage record, not in a
  silent allowlist next to the checker.
