# Agent Note: the harmony staging manifest consolidates into a generated, gate-enforced list

Status: implemented
Related: D9, T-0050 (item 4, first increment), PR3

## Problem

The staging manifests were hand-maintained in four places (harmony
Index.ets BUNDLE_FILES, harmony vendor-official.sh CLOSURE/SPINE_OURS,
the android stager's hand lists, the iOS embedder's RESOURCES/TREES), and
PR #412's rounds proved the failure class: a new upstream file landed
without its harmony rows, the Windows dev host's staging checker was
structurally blind to upstream coverage (path-separator mismatch — see
the surprises ledger), and the gap surfaced only as a CI red two rounds
deep. gen-staging-manifests.mjs (Phase 2) could DERIVE the harmony
manifest and report the delta, but nothing consumed the derivation.

## Decision

- The staging tools are now platform-true: check-staging-graph.mjs
  normalizes every reached row to forward slashes (posixNormalize), and
  gen-staging-legs.mjs emits its rows likewise — the checker and the
  generator see the same coverage on Windows that CI sees on Linux. The
  Windows blindness (a whole coverage class silently skipped) is gone;
  with the system-plugins junction in place the checker's three hosts
  report zero findings on the committed tree.
- New `tools/gen-staging-emit.mjs`: `--emit` writes the generated
  manifest to `tools/generated/staging/` (harmony-BUNDLE_FILES.rows =
  (derived − excluded) ∪ policy) and splices the Index.ets array block in
  place — preserving the committed row order, only adding/removing rows,
  so the first emit on a correct tree is a no-op diff (measured: 1114
  rows, Index.ets already current). `--check` is the enforcement gate:
  the committed .rows file, the policy/exclude files, and Index.ets must
  match the derivation exactly; any drift exits 1 with the remedy line.
- The two small policy files carry the rows no derivation can see:
  `harmony-BUNDLE_FILES.policy.rows` (967 staged-without-an-edge rows —
  the vendor pins, webclient tree, shims, plugin files/manifests, runner
  files; each row must exist on disk or the gate fails) and
  `harmony-BUNDLE_FILES.exclude.rows` (derived rows the host deliberately
  does not stage — first emit captured the one pi-ai hidden-data row).
  Both are hand-DECLARED: a row's move between derived and policy is a
  staging decision, reviewable in the diff.
- gates.json gains the `staging-generated` gate (after staging-check) so
  the manifest cannot drift from the derivation again — the exact class
  PR #412 round 2 died of. The plane re-sealed (verify-plane) and the six
  standing cards re-pinned.

Scope honesty: this consolidates the HARMONY manifest (the one the
derivation covers completely). The android/iOS scenario rosters are host
POLICY (per-host staged subsets the round-trip reports as
unstaged-by-policy) and the harmony CLOSURE rawfile staging remains
CLOSURE-driven — consolidating those needs a per-host policy-input
design and is the named follow-up. The vendor-pin promotion (the emit's
derived half currently covers only the first-party graph; the vendor
rows ride the policy file) is the second named follow-up.

## Alternatives considered

- Flipping all four manifests in one PR: lost — the android/iOS rosters
  are host policy, not derivation (regenerating them would silently
  change which scenarios each device stages), and the flip's verification
  needs a Linux host (the Windows checker was blind for exactly this
  class — measured two CI rounds running). The harmony flip is fully
  verified here.
- Enforcing only derived ⊆ committed (no Index.ets equality): lost — the
  equality is what makes the generated file the single source; a
  one-directional check would still let the hand list rot independently.
- A runtime splice in the harmony build (hvigor pre-step): lost — the
  committed Index.ets stays the compiled source; the splice lives in the
  materialize step's reach (the emit, run by a developer or CI on drift)
  and the gate makes forgetting it loud.

## Consequences

A new upstream file now needs ZERO hand manifest edits on harmony: the
import lands in the graph, the gate fails until --emit runs, the splice
updates Index.ets, review + commit. The policy/exclude files only move
when a staged-without-an-edge file is added or removed by hand.
