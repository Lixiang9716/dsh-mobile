# Agent Note: the binding manifest pins the live descriptor — phase 2 of the full Android E2E is checkable again

Status: implemented

## Problem

Phase 2 of `hosts/android/ci/run-android-full.sh` (scenario
`android.capability-binding`) has been red on latest main since the
primitive table grew past nine: the scenario itself logs
`descriptor.declared available: 17, unavailable: 0` on-device and passes,
but the checker fails the frozen manifest, which still pins
`{ "available": 9, "unavailable": 0 }` (last touched by the #145
rename-only pass). Because the runner treats a checker exit as fatal
(`set -e`), phases 3-5 — the official-web mount, the session live-read
spine and the composer live-write agent turn, the agent-critical legs —
never run in a pristine invocation. Nothing surfaced it: the dev-android
CI workflow runs only `run-spike-e2e.sh` plus the parity differential,
never phase 2+ of the full runner (found in the 2026-09-24 overnight E2E
session, issue #176).

## Decision

The manifest's `descriptor.declared` row pins the live table: 17
available, 0 unavailable — exactly `GatewayCore.PRIMITIVES` (nine
contract originals + the fs stat/list/mkdir/remove/rename additions +
`wasmRun` + the v1.4.0 timer seam `timerSchedule`/`timerCancel`). The
event stays an exact-match row; nothing else in the 35-event manifest
moved (the checker's remaining 34 rows all matched the on-device stream
before this change).

## Alternatives considered

- Relaxing the row to an event-name-only match so future primitive
  additions cannot go red — rejects the manifest's own contract: this
  scenario exists to freeze what the host declares, and a count that
  cannot fail is a vacuous check (rules.md rule 6).
- Wiring `run-android-full.sh` into the push CI so the drift is caught at
  merge time — the real systemic fix, but it doubles the workflow's
  emulator cost and needs its own scoping; filed as the follow-up on
  issue #176 rather than smuggled into a manifest refresh.

## Consequences

Phase 2 verifies green end-to-end on the refreshed tree (checker
35/35, on-device ALL PASS), and phases 3-5 run again behind it in a
pristine invocation. The next primitive addition goes red exactly once —
at manifest-update time, with the descriptor diff in the same PR.
