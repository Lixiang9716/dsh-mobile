# Agent Note: the mux containment test snapshots the frame counter at a quiesce point

Status: implemented

## Problem

The gov workflow on main failed once (run 37183614538, 2026-10-04, after
#360 merged) on `presentation/lynx-client/tests/mux.test.js:111` —
"malformed JSON, unknown streams and throwing handlers are contained"
asserted `expected 8 to be 6` — while the identical code was green on
PR #360's run 37183201888 nine minutes earlier. Intermittent, and the
test's own subject (hostile-frame containment in `driver/wire/mux.js`)
was untouched by both PRs.

Triage (same day, diagnosis-only round): `muxDiag` is a module-global
counter (`driver/wire/mux.js:19-21`) that accumulates across the file's
tests. The test waits `waitFor('open', () => srv.state.clientFrames.length
> 0)` — the SERVER seeing the open frame — then snapshots `framesBefore`.
The server answers the open by synchronously sending two item frames
(tests/mux.test.js:29-36), but their client-side dispatch is async, so the
snapshot races those two in-flight frames. TCP ordering guarantees that
once the third hostile frame has thrown (`waitFor('throw contained')`),
all five frames are counted — so the assert always reads residue+5, while
`framesBefore` is residue + (0, 1, or 2) depending on who won the race:
0 ⇒ expected 6 vs received 8 (the CI failure), 1 ⇒ 7 vs 8, 2 ⇒ 8 vs 8
(pass). A probe replicating the sequence against the real modules with a
tighter poll failed 2/8 rounds with exactly this shape, while the real
test (20 ms poll) passed 40/40 locally — the loaded CI runner lost the
race. Not the mux implementation: `dispatch` counts exactly one per
received frame (mux.js:127), superseded-socket frames are dropped before
counting by the generation guard (mux.js:66), ws-lite surfaces no control
frames, and #351's 64-bit-length encoder change touched only the Android
carrier (`hosts/android/.../CarrierServer.kt`), not this tree.

## Decision

`tests/mux.test.js` snapshots the counter at a quiesce point: after the
open is seen, the test now waits `waitFor('open response routed', () =>
items.length >= 2)` before capturing `framesBefore` — the same routing
wait the file's first test already used — pinning `framesBefore` at
residue+2 so the `framesBefore + 3` containment arithmetic is
deterministic. All three containment assertions (malformed JSON counted
and dropped silently, unknown stream dropped, throwing handler contained)
keep their original semantics; one line plus a comment.

## Alternatives considered

- Fix the implementation — make `muxDiag` per-instance or reset it per
  test. Lost: the global counter is deliberate (the mux.js header keeps
  it as the runner's failure-forensics print), the counting semantics
  are correct as-is, and the mobile port must match the page original's
  contract; changing shipped driver code to accommodate a test race
  inverts the blame.
- Wait for count stability (`waitFor` until `muxDiag.frames` stops
  moving for N ms) before the snapshot. Lost: a stability heuristic
  re-introduces timing dependence and can flake under load exactly like
  the original bug; `items.length >= 2` is the exact quiesce condition
  (exactly two item frames are ever sent in response to the open), not
  an estimate.
- Re-queue/retry the failed CI run. Lost: treats the symptom, leaves the
  race in place, and a flake that needs a retry is a flake that gates
  real regressions out of schedule.
