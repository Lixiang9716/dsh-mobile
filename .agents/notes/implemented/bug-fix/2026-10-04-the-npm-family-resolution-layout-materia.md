# Agent Note: the npm-family resolution layout materializes with the tests and refreshes stale links — a cold re-materialization no longer ships Cannot-find-package ×264 (#328)

Status: implemented
Related: D6

## Problem

#327 fixed the raw upstream-suite vitest face by pinning the missing
registry faces into `vendor/npm/` — but the layout that makes them
RESOLVABLE (the `vendor/node_modules` links and the per-package nested
seats) is built by `runtime/spike/ci/parity-node-modules.sh` alone, and no
materialization path ran it. #327's after-numbers (532→424 failed files,
Cannot-find-package 264→31) were measured on a tree where that script had
been run by hand. Every cold re-materialization — `rm vendor` + ensure.sh +
ensure-dsh.sh + ensure-dsh-tests.sh + suite `npm ci`, exactly #328's repro —
shipped the layout empty again: js-yaml ×63, tsx ×34,
@deepseek-ai/node-addon-system/flock ×24, chokidar ×16,
@agentclientprotocol/sdk ×10 Could-not-find-package, reproducible on main at
d3e13ea. Worse, the script's own generic loop skipped ANY existing link —
including a dangling one whose target a re-pin had removed — so even on a
tree where the layout had been built, present-but-stale links stayed stale
forever (rule 5's exact forbidden shape), and a named link whose target face
was absent silently claimed its name, blocking any later pin of the same
name from ever linking.

## Decision

Three pieces, one contract: **a fresh materialization resolves the named
faces, and nothing stale survives a rebuild.**

- `ensure-dsh-tests.sh` ends by invoking `../ci/parity-node-modules.sh` —
  the layout is now a product of materializing the tests, so every refresh
  path that runs the script (#328's repro included, plus the suite runners
  and the reproducibility proof) rebuilds it. Idempotent by construction
  (the script already was; the proof's second-run leg now exercises the
  layout rebuild too).
- `parity-node-modules.sh` refreshes what rots and stops claiming what is
  absent: the generic loop deletes a link whose target vanished before the
  skip check (dangling → relinked from the current materialization); the
  named product links (cordis and friends, zod, diff) go through a guard
  that leaves the name UNLINKED with a loud notice when the target face is
  absent — a dangling claim would silently block a later test-face pin of
  the same name; the three closure seats whose consumers live in
  `vendor/dsh/` degrade with the same named notice on a tests-only tree
  (the standalone `ensure-dsh-tests.sh` path in run-ios-upstream-suite.sh
  legitimately lacks that tree), while `--parity-only` keeps its hard
  closure requirement.
- `ci/check-parity-resolution.mjs` (new) is the gate assertion #328 asked
  for: it resolves the issue's named specifiers from their real importer
  sites — js-yaml from the cordis-plugin-include lib (the ×63 instance),
  tsx and @agentclientprotocol/sdk and the flock subpath from the dsh-tests
  tree — and verifies the nested seats including their LINKED MAJOR
  (chokidar 4 vs 5 per consumer, readdirp per chokidar major). Resolution
  proves two ways per row: real `createRequire(...).resolve` for CJS faces,
  an ancestor `node_modules` walk for ESM-only exports maps
  (ERR_PACKAGE_PATH_NOT_EXPORTED is an exports-map fact, not the layout
  fact this gate judges). Wired into `reproducibility-proof.sh`: the full
  scope (weekly vendor-repro workflow) asserts it on a cold clone; the
  per-PR gate scope gains a `--parity-only` fresh-clone smoke.

## Alternatives considered

- Fixing the layout inside the ensure scripts (linking inline as each pin
  materializes): rejected — two homes for the resolution contract would
  drift exactly like the pin tables did before parity-node-modules.sh
  existed; one script, invoked at the end of materialization, keeps one
  place that knows the layout.
- Deleting-and-rebuilding the whole `vendor/node_modules` on every run:
  rejected — it would also drop the deliberate product-face links and the
  pre-seeded collision choices the script documents, for no gain over
  targeted dangling-refresh (the layout has no other staleness vector: all
  other writes are `ln -sfn`, idempotent by nature).
- Teaching the generic loop to resolve multi-version names by declared
  range (instead of first-glob-order + explicit pre-seeds): rejected this
  round — it re-implements npm's resolver for a case no fresh tree hits
  (a cold materialization pins exactly one version per name); the dev-tree
  artifact (stale extra version dirs win glob order, observed locally:
  js-yaml@4.1.0 leftover beside the pinned 4.3.1) is the vendoring skill's
  documented copy-never-prunes trap, solved by cold regeneration, not by
  resolver logic in a link script.
