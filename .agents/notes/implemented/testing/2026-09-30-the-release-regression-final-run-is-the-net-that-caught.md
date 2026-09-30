# Agent Note: the release regression final run is the net — five stale verification-surface pins and one dead drive path it caught

Status: implemented
Related: AGENTS.md constraint 7 (E2E by logs), the office-plane lesson (e2e-matrix audits committed evidence only; manifest drift is structurally invisible to CI; the local full rerun is the only net), docs/e2e-matrix.md

## Problem

v0.0.2's release gate is the local full regression: the simulator matrix
(#250), the upstream-suite sweep, and the Release-configuration feature pass.
Five capability/CI PRs (#251–#255, #271–#272) landed after the matrix did,
and nothing structural re-runs it — exactly the hole the office-plane lesson
names. The final run existed to catch what slipped through. It caught:

1. **The matrix's no-argument default never worked** (`f361d009`): the
   default initialized the literal three-word list, which the validator
   rejects — a bare `run-simulator-matrix.sh` (the usage line's bracket
   form) died before booting anything. Every earlier run passed
   `--platform` explicitly, so the default shipped unexercised in #250.
2. **gateway.binding demanded an all-available descriptor** (`3b7f08d4`):
   the camera family (#252) honestly declares the phased recording rows
   unavailable by contract, so the scenario died on every host before
   emitting a single event. The scenario now pins what it meant — every
   unavailable row must be a KNOWN phased row — and the manifest pins the
   session seat's true descriptor 33/2.
3. **The selftest boot fixture never gained `shims.selftest`** (`3b7f08d4`):
   #210 added the expectation to the manifest without regenerating the
   fixture; `selftest.sh` failed on clean HEAD.
4. **The iOS device-plane descriptor pin read 31** (`86abcf58`):
   #255's microphone rows completed the serving table; the seat emits 33
   now. The pin followed the measured payload.
5. **The gateway picker drive's SEARCH path is dead on this machine**
   (`e30361bc`, `26c15cc8`, plus the stdin fix): the app rewrote the staged
   target at every launch (knocking it out of the file-provider search
   index), and even after that was fixed stage-once, the search never
   surfaced the file again — not at file age ~2, ~5 or ~26 minutes, through
   an erase, reboots and two settle-window bets. The drive now WALKS the
   browse hierarchy (浏览 → DSH Spike → gateway-e2e → notes cell),
   label-addressed through WDA's tree, which reads the filesystem directly
   and needs no index at all.

## Decision

The release regression runs all three legs locally on the actual release
candidate, and any real failure is either fixed in a named separate commit
(all of the above) or listed as a release blocker. The verification surface
is allowed to lag the product ONLY until someone actually runs it — this run
is that moment, once per release. Findings 1-4 are manifest/fixture drift;
finding 5 is a test-drive choreography whose assumption (a working search
index) quietly expired.

## Alternatives considered

- **Let CI catch these** — rejected: CI runs only the committed-evidence
  audit plus the dev-pipeline scenarios; a stale manifest pin against fresh
  logs is invisible to it BY DESIGN (the office-plane lesson), and the
  matrix is deliberately not gate-wired (a release ritual, per its note).
- **Fix the file-provider index instead of abandoning search** — rejected:
  after stage-once there is no invalidator left to remove, and the index
  still answered 未找到相关结果 at 26 minutes on a freshly erased simulator;
  no CLI inside the runtime can even query it (no mdfind). Browse reads the
  filesystem directly — the deterministic substrate.
- **Widen the scenario's 180s watchdog so search could surface during the
  drive** — rejected: that is a product-scenario change bought for test
  infrastructure, and the measurement said the window is unbounded anyway.

## Consequences

`run-ios.sh`'s picker leg depends on WDA's accessibility tree exposing the
Files browse cells (verified live twice); a Files-app redesign that hides
them fails the walk loudly (shot 08 + a missing `ui-done picker`), not
silently. The matrix remains a manual release ritual — and this run is the
record that its full green is load-bearing for v0.0.2.
