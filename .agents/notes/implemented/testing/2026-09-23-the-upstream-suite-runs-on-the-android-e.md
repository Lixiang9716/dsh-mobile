# Agent Note: the upstream suite runs ON the android emulator — the gap-fill loop and its first ledger

Status: implemented

## Problem

The suite pipeline (#161) proved upstream's tests execute through our
quickjs-shaped harness under Node; the owner's target is the emulator —
the suite running inside the app's own runtime, with every failure naming
a gap in OUR environment to fill.

## Decision

The Android leg lands end to end. The host routes `--ez dsh.suite true
--es dsh.spec <name>` to a startSuite drive (entry
scenario/upstream-suite-leg.js; the spec name rides the runtime.config bus
delivery); the runner (hosts/android/ci/run-upstream-suite.sh) stages the
whole transpiled corpus under filesDir/spike/upstream-tests/ in one tar
(copyAssetDir MERGES on launch, so staged files survive relaunches), then
drives ONE app launch per spec, streaming per-test verdicts into an
aggregate + totals evidence set. The gap-fill ledger so far, each item
found by a failing test and fixed on our side: (1) the specs compose
contexts directly, so the driver now imports the web shims FIRST
(AbortController et al.) — one import took loop.spec from 1/65 to 63/65;
(2) dsh SUBPATH imports ('@deepseek-ai/dsh-session/invariant') are
rewritten at transpile time to bundle-relative file paths (the loader's
bare map whitelists specific subpaths; its generic path route serves the
vendored bytes verbatim) — 127 files; (3) the test closure is staged into
the android assets (217 packages, .d.ts excluded per the curated staging
convention, APK 9.3→17.8 MB); (4) node:vm, koffi-bound jsonl, fast-check
suites are excluded with named reasons (a vm builtin, a native dep, an
unmapped bare specifier — each a decision, not a drop); (5) the harness
gains onTestFinished. State at landing: the 31-file core batch reports
206 tests passed on-device, loop.spec 63/65 — the two survivors are
setTimeout-based and name the ONE architectural gap: a timer seam
(contract proposal first — the plane's own rule; the 30 fake-timer
excluded specs point the same way).

## Alternatives considered

- **Batch multiple specs per launch** — rejected for now: module-level
  state in the vendored packages cannot reset between specs; one spec per
  process is the honest isolation (a batching driver can revisit this
  with resetCollection once proven safe).
- **A global setTimeout hack in the driver** — rejected: the no-timer
  design is a recorded host decision; the timer demand goes through a
  contract proposal, exactly what the two failing tests are for.
- **Keep the corpus inside the APK assets** — rejected: 667 transpiled
  files are runner-staged material (regenerated per tag), not product
  bytes; the APK already carries the closure they import.
