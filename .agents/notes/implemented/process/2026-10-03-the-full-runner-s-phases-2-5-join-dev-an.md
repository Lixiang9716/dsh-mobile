# Agent Note: the full runner's phases 2-5 join dev-android CI — DSH_PHASES makes partial execution honest

Status: implemented
Related: D3

## Problem

The contract pins that only `run-android-full.sh` executes — the binding
scenarios' descriptor demands, the manifest counts, the write-surface
endpoint list — rotted twice (#176, #332) because no CI leg ran them: each
capability-plane or tool-surface landing shifted the surfaces, and only a
local full run, sometimes months later, noticed. #332 fixed the drift and
named the process gap; this closes it. The design tension: the runner's
phase 1 duplicates `run-spike-e2e.sh` (already a dev-android step), and the
runner's ~40 minutes of local wall clock cannot land wholesale on a CI job
budgeted at 40 minutes for four other legs.

## Decision

- `run-android-full.sh` honours `DSH_PHASES`: a validated comma list
  (default `1,2,3,4,5`), checked BEFORE any side effect — unknown values
  abort with the offending name (rule 5) — and every skipped phase is
  announced up front, so a partial run can never masquerade as the full
  sweep. The guard is a mechanical `if` wrapper at column 0; reindenting
  ~400 lines would bury the real diff.
- `dev-android.yml` runs `DSH_PHASES=2,3,4,5` on the same emulator after
  the existing legs, `CAMERA` granted per the run-camera-plane discipline
  (a fresh CI AVD carries no grant state), and every artifact redirected
  off the committed evidence dirs (`DSH_WEB_ART`/`DSH_SESSION_ART`/
  `DSH_WRITE_ART` → /tmp) into the upload. Phase 1 stays exclusive to
  `run-spike-e2e.sh` — no duplication.

## Alternatives considered

- Run the whole runner including phase 1 on CI: rejected — it re-runs the
  three scenarios the step above just ran, ~3.5 minutes per push for zero
  new information.
- A nightly schedule instead of per-push: rejected — the pins drift at
  merge time; a nightly that reddens the next morning is "red on main"
  with a delay, exactly what this exists to prevent.
- A scenario-only CI leg that re-implements phases 2-5's drives: rejected —
  the runner IS the discipline (canary-pinned capture, UI driving with
  bounded retries, the occlusion probe); a subset re-implementation would
  drift from it exactly like the manifests drifted from the runtime.
- Wiring the ui.occlusion probe into dev-ios too: deferred — dev-ios has no
  WebDriverAgent leg to hang a tree dump on; bootstrapping WDA there is its
  own change with its own CI cost.

## Consequences

dev-android's wall clock roughly doubles on pushes (~11 → ~20 min, within
the job's 40-minute budget): every future capability-plane or tool-surface
landing that drifts one of these pins reddens its OWN PR instead of a
local runner months later. Locally, `DSH_PHASES` also makes reruns cheap —
a failed phase 5 reruns as `DSH_PHASES=5` instead of the full sweep. The
filtered path is proven on-device (phases 2-5 green end-to-end on a cold
AVD boot: capability-binding 35/35 + audit 16/16, officialweb-mount 14/14
+ ui.occlusion 1/1, session-live-read 46/46, composer-live-write 45/45),
and the loud paths by direct invocation.
