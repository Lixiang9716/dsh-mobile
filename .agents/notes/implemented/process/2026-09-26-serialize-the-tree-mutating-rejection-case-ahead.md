# Agent Note: serialize the tree-mutating rejection case ahead of the tree-reading gates

Status: implemented

## Problem

The `closures` gate flaked on CI twice in one morning (main @ `433a97b` 12:04,
PR #223 13:06) with the same impossible-looking finding: `rawfile closure
drift: scenario/composer-web-live.js` on trees where the committed rawfile was
byte-identical to the canonical (verified by direct `git show` comparison of
both blobs). The gate's own remedy ("re-run build/build.sh sync") was a red
herring — re-staging changed nothing, and a re-run of the same tree passed.

Root cause: `gates.json` sets `concurrency: 4`, and `gov run` executes the
gate DAG on a `ThreadPoolExecutor`. `self-test` runs the project rejection
case `.gov/rejections/case-bundle-files.sh`, which — by design, to prove the
bundle-files checker catches a missing rawfile copy — `mv`s
`hosts/harmony/.../rawfile/spike/scenario/composer-web-live.js` away for the
~1s window of a node run and restores it afterwards. Scheduled concurrently,
the `closures` gate's `cmp` of that exact file lands inside the window and
reports "drift" for a file that is merely momentarily absent.

## Decision

`closures` and `bundle-files` (the two gates that read the harmony rawfile
tree) now declare `"needs": ["self-test"]`, serializing them after the only
gate that mutates the live tree. The other four project cases are
sandbox-clean (`mktemp -d` fixtures with restore traps), so no other edges are
needed. Verified against the failure signature: the mv window can no longer
overlap either reader.

## Alternatives considered

- **Sandbox the case into a temp-tree copy** — rejected for this round: the
  case's contract is "runs the checker against the REAL tree", and
  `check-bundle-files.mjs` hardcodes the repo's rawfile/index paths; a
  redirect seam would be a checker change riding an infra fix.
- **A govrail-level fix (self-test runs project cases under an exclusive
  lease)** — the durable home for this, filed upstream; the `needs` edge is
  the local, effective-today guardrail and stays correct even after govrail
  changes.
- **Drop concurrency to 1** — rejected: slows every gate run to pay for one
  case's window.
