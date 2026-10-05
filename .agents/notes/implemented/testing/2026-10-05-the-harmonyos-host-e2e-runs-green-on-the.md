# Agent Note: The HarmonyOS host E2E runs green on the Windows emulator — the three harmony receipt gaps close

Status: implemented
Related: D5

## Problem

The register's three harmony receipt rows were unclosable on this machine:
no DevEco Studio, no SDK, no `hdc`, no `hvigor` — the host E2E had never
executed here (docs/windows-test-plan.md recorded exactly that boundary).
Once the toolchain landed, the first real run still failed three ways, each
invisible to CI (dev/harmonyos compiles but never executes the suite): the
picker drive tapped the wrong top-right control on the 7.0.0.107 image
(a new-folder icon now sits left of the save ✓ in the confirm region — the
starved drive left the m5 phase dead at its first leg); the write leg's boot
drove an ok:true envelope through OfficialPhase's session.list observer
whose value is not a sessions record, and the TypeError killed the whole
ArkTS process mid-leg (app gone home, 900s deadline starved); and the three
scenario manifests pinned the tree as of the last macOS run — the pinned
tree has since grown (two more available primitives, ten more mock tools, a
longer claimed-endpoint roster, dynamicCordisRunner legs answered forwarded
instead of unavailable), so even a fully green run failed its checkers on
counts the code no longer produces.

## Decision

- `hosts/harmony/ci/drive-binding.mjs`: `findInRegion` now prefers the
  RIGHTMOST clickable candidate inside the confirm region (the ✓ is always
  the rightmost of the corner controls); ties on clickable-ness broke DFS
  order before.
- `hosts/harmony/entry/src/main/ets/model/OfficialPhase.ets`:
  `observeRespond` shape-checks the envelope (object, non-null, `items`
  array) before reading it — every non-sessions shape returns instead of
  throwing out of a bus callback and killing the process.
- The three manifests follow the pinned tree's real behavior, each delta
  backed by this run's captures: `harmony-capability-binding` descriptor
  available 24→26; `harmony-session-live-read` mock tools 6→16 (both
  llm/request/built records); `harmony-composer-live-write` the 29-endpoint
  claimed roster, syncInspectManifest forwarded, the new
  dynamicCordisRunner/inventory and subagents/list rpc.observed records.
- The environment itself (CLT 26.0.0.851 extracted to
  D:\harmonyos-commandlinetools, the HarmonyOS 7.0.0(26.0.0) phone image,
  the dsh_phone instance on D:, the Emulator license accepted once, the
  x86_64 abiFilters applied locally per build) is host setup, not repo
  state — documented in docs/windows-test-plan.md's P0 and the Windows E2E
  memory; the repo-side runner needed no path changes beyond what #389
  already landed.
- The three d9 dirs were refreshed by their own real runs on this emulator
  (each EXIT=0, 8/8 checkers, `receipt.json` machine-authored by the
  runner's green-path emission — host line `HarmonyOS emulator
  (127.0.0.1:5559, HarmonyOS emulator 7.0.0.107…)`). The register strikes
  the three harmony rows in the same change: 4 → 1 findings (only iOS b4
  remains), 0 register defects, 93 dirs / 211 verdicts.

## Alternatives considered

- Copying the windows-t1 run's artifacts into the three d9 dirs instead of
  re-running: not a candidate — a receipt certifies the run that produced
  its dir; the register's closure rows name the re-runs, so the re-runs
  happened.
- Widening `PICKER.closeRegion` or special-casing the folder icon by
  description: lost — the region is already correct; the selection rule
  (rightmost clickable) is the image-independent fact, and descriptions are
  empty in this image's locale so they cannot be keyed on.
- Making the manifest accept either value (24 or 26, forwarded or
  unavailable): lost — a one-to-one manifest that tolerates two truths
  verifies nothing; the manifest pins THIS tree's behavior, and the older
  pinned behavior remains verifiable by the committed historical verdicts.
- Catching the observer TypeError with a bare try/catch: lost — the shape
  check documents exactly which envelopes the observer ignores, and a wide
  catch on a bus callback would silently eat future real defects.
