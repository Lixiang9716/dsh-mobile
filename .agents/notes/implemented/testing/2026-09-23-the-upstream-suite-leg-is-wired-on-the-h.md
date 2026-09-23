# Agent Note: the upstream suite leg is wired on the harmony host — extras-HAP staging, the dsh.e2e.spec launch param, and the CI suite build

Status: implemented

## Problem

The upstream DSH suite runs on the Android emulator (#162); the owner's
next target is the HarmonyOS host. Harmony's bundle model differs
fundamentally: the rawfile tree is COMMITTED and pinned one-to-one by
BUNDLE_FILES (check-bundle-files.mjs, both directions), and
materializeBundle copies ONLY that list to the device-writable root — so
the generated corpus and the 192-package test closure have no lawful path
into the bundle, and admin merges had already drifted the list (four
scenario files landed in rawfile without list entries — the check was red
on main).

## Decision

The leg is wired end to end within that model. The drift is fixed (the
four files listed; check green both directions). Launch selection mirrors
the llm leg: `--ps dsh.e2e.leg upstream.suite --ps dsh.e2e.spec <file>`
(EntryAbility parks both params in E2eLeg; Index dispatches runSuiteLeg;
HostPhase.beginSuite evals the canonical driver and hands it the spec over
the hostBusDeliver runtime.config — the same handoff shape as Android's
startSuite). The corpus/closure delivery rides a SEPARATE build:
vendor-official.sh --suite-extras stages the transpiled corpus + the test
closure into rawfile (untracked, regenerated per tag) behind a
fixed-name manifest (upstream-tests/__files.txt) that
materializeSuiteExtras walks — recursive rawfile listing has no stat API,
so the manifest IS the directory truth; a standard HAP simply has no
manifest and the leg fails loud naming the spec. The dev-harmonyos
workflow builds the extras HAP after the standard one and uploads it
(dsh-spike-suite-hap) — runnable by hosts/harmony/ci/run-upstream-suite.sh
on any hdc-connected environment. Execution proof deliberately rides the
SAME vehicle every harmony E2E leg awaits (the workflow's own M5 note:
the emulator leg is the standing TODO); no local proof exists by
constraint — this machine has no DevEco CLT (the local-toolchains note).

## Alternatives considered

- **List the corpus in BUNDLE_FILES** — rejected: the check pins a
  COMMITTED tree; 667 generated files would make the drift gate guard
  garbage and re-run transpile on every sync.
- **Push the corpus into the materialized root via hdc** — rejected: no
  hdc-into-app-sandbox precedent on this host (the llm leg stages through
  in-app code for exactly this reason); the extras-HAP keeps one staging
  mechanism.
- **Recursive rawfile walk via getRawFileList probing** — rejected on
  measurement-in-design: the resource API has no directory stat and its
  read refusals are async (a probe-then-recurse cannot fail loud
  synchronously); the fixed-name manifest is one read, honestly absent on
  standard builds.
