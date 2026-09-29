# Agent Note: the staging-manifest generator lands as evidence first, replacement second

Status: implemented
Related: D5, the staging-check note (check-staging, 2026-09-29)

## Problem

The per-host staging manifests (harmony BUNDLE_FILES + CLOSURE/SPINE_OURS,
android stage-spine-closure lists, iOS RESOURCES/TREES) are hand lists, and a
missed hand row freezes a shim on a fresh device install — the exact class the
2026-09 shims/ splits died of. check-staging (the ledger's step one) proves
graph→list in ONE direction; the hand list itself remains the source of truth,
so the write path (a human remembering to edit four files in three syntaxes)
stays the failure point. The ledger's step two asked for a generator: derive
the lists from the actual import graph. But flipping a hand list to generated
output in one PR means the same change both builds the derivation AND rewrites
four manifests across three hosts — if the derivation has a hole, the PR that
introduces it also hides it (the manifests would newly say whatever the
generator says), and every other in-flight PR editing those lists (sharp/
socket work was in flight) collides twice over.

## Decision

Two steps. This PR (step two of the ledger) ships ONLY the generator,
`tools/gen-staging-manifests.mjs` (+ `gen-staging-legs.mjs`), plus the
round-trip delta report it produces (`docs/research/staging-manifest-roundtrip`
pair): it derives each manifest's rows from reality — check-staging's own
walkGraph, the stager-declared dsh pin roster expanded over the materialized
trees, subtree walks, zod's import closure recomputed from the pin — and
diffs against the committed manifests with every not-derivable row classified
(host-loader namespace, runtime-data, vendor-shape, e2e-harness, policy). The
committed manifests are NOT replaced; exit 1 fires only when a derived graph
row is missing from a manifest (the freeze-fatal direction), which makes the
tool a real rejection case on day one (proven by a controlled mutation: a
shim added to the boot graph outside the manifests trips FATAL, reverting
restores green). Replacing the lists from the generator's output, and wiring
it into the stagers, is the follow-up after this evidence has cooled.

## Alternatives considered

- Generate AND replace in one PR: lost — the derivation and the flip would
  validate each other in the same change (circular), the diff would bury the
  derivation review inside 900-row list churn, and the parallel sharp/socket
  manifest edits would turn one conflict into four.
- Generator with no delta report: lost — without the itemized,
  attribution-carrying delta (312 duplicate hand rows, the util-crypto
  one-off pin shape, the host-loader-namespace blind spot), the round-trip
  claim is unfalsifiable prose; the delta IS the deliverable's evidence.
- Deriving the vendor rows by globbing every materialized pin (no roster):
  lost — the tree also holds the test-closure pins (cordis-host-runner,
  hook-protocol, invariants, llm-mock-server, sdk-protocol) that no runtime
  manifest stages; globbing derived 21 rows too many. The roster the stagers
  themselves declare is the policy source; the tree is only the expansion.
- Hard-coding a NEW pin roster inside the generator: lost — a fourth copy of
  the pin policy is exactly the drift this effort exists to kill; the
  generator extracts the rosters from the stagers' own declarations
  (SPINE_PKG_DSH, the android for-pkg loops, the iOS TREES comprehension).

## Consequences

The generator is now the executable statement of "what the manifests must
name"; `staging-generate: round-trip holds` is checkable on any tree. The
known blind spot (the C-side bare map: 17 shim rows + 10 on-disk shims the JS
tree cannot justify) is now NAMED in a committed document instead of living
in tribal memory — the Phase 3 flip needs a declared shim-namespace policy
before it can close it.
