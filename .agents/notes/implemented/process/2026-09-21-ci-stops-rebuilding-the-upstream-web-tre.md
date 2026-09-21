# Agent Note: CI stops rebuilding the upstream web tree, and stale runs cancel

Status: implemented
Related: D12, D9

## Problem

Measured per-step across the pipeline (durations from the Actions API, not
estimated), the repository's most expensive single item was not a test: it was
**rebuilding the upstream web tree**, three times over.

`tools/e2e/ensure-official-dist.sh` + `ensure-client-bundles.sh` build the 58-package
upstream monorepo behind `official-web/dist` and `client-bundles/npm`. Every
workflow that needed those trees paid for the build on every run:

| Workflow | Step | Measured |
| --- | --- | --- |
| `release/ios` | Materialize the official Web Client the release build embeds | **602 s / 779 s** (macOS, billed at 10×) |
| `release/android` | Materialize the vendored web app + DSH closure | **465 s / 463 s** |
| `dev/android` | Materialize the vendored official web app | **334 s / 452 s** |

A `push: main` followed by a `v*` tag push paid that build at least three
times, and one of the copies ran on the most expensive runner in the set. The
trees are untracked by design (upstream discipline D6 — the content gates must
never judge verbatim upstream JS), so nothing in git could supply them, and no
workflow cached them: `dev/android` had no `actions/cache` step at all.

Separately, **no workflow except `gov.yml` declared `concurrency`**. Two pushes
to `main` in quick succession therefore did not cancel each other: every run
finished, each holding a macOS runner and two Ubuntu runners for work whose
verdict was already superseded.

## Decision

**Cache the materialized tree on the provenance that decides its bytes, and
cancel superseded dev runs.**

The three workflows that build it (`dev/android`, `release/android`,
`release/ios`) gain an `actions/cache` step restoring
`presentation/official-web/dist` and `presentation/official-web/client-bundles/npm`,
keyed on `hashFiles()` over the provenance set: both `MANIFEST.sha256` files,
both build recipes, the roster, and the two verifiers. Any pin or recipe change
changes the key and the tree is rebuilt.

This is safe because **both scripts are already idempotent** — verified by
reading them, not assumed: present-and-MANIFEST-verified means `exit 0`, and a
present-but-mismatched tree is deleted and rebuilt. So a cache hit turns a
build into a verify, and a stale cache cannot ship a wrong tree: the verifier
decides, not the cache. The key is written as a single-line expression
deliberately — a folded multi-line scalar would risk resolving to a literal
string, giving a cache step that never hits and quietly optimizes nothing.

The dev pipelines gain `concurrency` with `cancel-in-progress: true`. The
release pipelines gain `concurrency` with `cancel-in-progress: false`, keyed
per host: three hosts build one tag and each ends in `gh release upload
--clobber`, so cancelling mid-upload would leave whichever finished last, and a
re-dispatch for the same tag must not race the run it is repairing.

## Alternatives considered

**Commit the dist and the client bundles so CI never builds them.** Rejected —
that is the decision D9/D6 already made and it would undo it: the content gates
would judge verbatim upstream JS (a previously measured 5087 violations on the
same class of tree), and the tracked provenance record is deliberately the
MANIFEST + the reproducible recipe rather than the bytes.

**Cache with a key derived from a hash of the built tree itself.** Rejected as
circular: the tree is what the cache is for, and hashing it requires building
it.

**Use a static key**, as the existing caches do (`dev-ios-deriveddata-v2`,
`hos-clt-linux-unpacked-26.0.0.821`). Rejected here: a static key would freeze
the tree at the first pin it was built from, and the failure would be a *stale
verifiable tree* — the script would reject it, so the build would re-run anyway
and the cache would silently never help. Note this is a live latent issue in
the iOS DerivedData cache, which has no `restore-keys` and a static key.

## Follow-up: the remaining free levers, and the reason the npm half missed

**The client-bundles cache miss is a reproducibility defect, not a caching
one.** `client-bundles/build-client-bundles.sh` REGENERATES `MANIFEST.sha256`
from its own output, and `ensure-client-bundles.sh` verifies against the
committed one. So a cold run builds, rewrites the manifest, and verifies
against its own fresh output — it cannot fail, and it cannot detect
non-reproducibility. A warm run restores the tree and checks it against the
*committed* manifest, which disagrees — hence "npm tree present but MANIFEST
mismatch — rebuilding". The `dist` half is genuinely reproducible and its cache
works. Measured net effect of the output cache on `dev/android`: **456 s →
251 s** (the dist half; the npm half still rebuilt). Caching build output was
the wrong target; the store is the right one.

**Added, all free:** the **pnpm store** is cached for the three workflows that
run the upstream build — content-addressed with no path assumptions, unlike
`node_modules` or build output whose symlinks point at paths that only exist on
the machine that made them (pnpm#6374, #10081) — with the path *resolved* by
`pnpm store path` rather than guessed, so a wrong guess cannot silently cache
nothing. The iOS `DerivedData` cache gains `restore-keys`, because its static
key with no fallback is written once and never refreshed. And `dev/ios`
gains a **background simulator prewarm** plus a **portable deadline** on
`simctl launch` (perl's `alarm`, since macOS ships no `timeout`), because that
single call was measured taking **385 s of silence** on a cold runner —
indistinguishable from a hang. The deadline reports exit 142 as its own
diagnosis rather than as a launch failure.

**Deliberately not taken, because they cost money:** larger runners (worth it
only above a measured 1.5× wall-clock gain, and wasted on single-threaded
steps), and anything that raises the macOS share of the bill.

**Still open, and it is the larger number.** Not done here, and it
should be done next: `dev/ios` spent 652 s + 69 s — 87.8 % of its wall clock —
in two `continue-on-error: true` steps that **both failed** on a run the API
reports as green (`verdict never appeared`; the m2 verdict files were missing).
That is both the biggest remaining cost and a correctness signal: the pipeline
is green while the E2E produced no verdict. It needs a decision rather than a
drive-by edit — either the 385 s of silence between `simctl bootstatus`
succeeding and `simctl launch` returning is a hang worth fixing, or the step
should not run on CI at all.
