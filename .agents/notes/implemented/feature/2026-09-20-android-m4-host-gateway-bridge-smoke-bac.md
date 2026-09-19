# Agent Note: Android M4 host: gateway bridge smoke backend green on emulator

Status: implemented
Related: D5

## Problem

The Android plane was still the M1 spike: `dsh_spike_jni.c` ran only
`m1.spike.boot` against a runtime that could not carry a real plugin — the
frozen M2 gateway dispatch bridge (`dsh_spike_set_gateway_dispatch` /
`settle` / `event`) had no Android embedder, so `m2.bridge.smoke` ran on the
macOS CLI only and the claim "the identical C host passes the identical
gateway-mediated scenario on every platform" was untested on Android. Without
an Android handler set behind the bridge, the M4 "QuickJS-isomorphic host"
milestone had no first proof.

## Decision

`hosts/android` now embeds the M2 spike JS bundle as byte-identical assets
(`gateway.js`, `scenario/m2-bridge-smoke.js` next to the existing
`logger.js`, `scenario/m1-spike-boot.js`, vendored util-crypto) and grows an
Android smoke backend, `app/src/main/cpp/dsh_spike_smoke.c`, mirroring
`main_cli.c`'s handler set over the shared C host: calls are only QUEUED in
the dispatch callback (which fires synchronously on the runtime thread) and
settled in the post-pump drain pass — the deferred later-tick settlement the
scenario proves; `fsRead`/`fsWrite` carry base64 payloads against
`filesDir/smoke-fs` as scope `app` (escape-checked, per the contract's
"invalid" for escapes); the six primitives the descriptor declares
unavailable reject with the honest `unavailable` code; anything outside the
descriptor rejects `invalid` with the offending name. The descriptor is
identical to the CLI's. One launch drives BOTH scenarios (fresh
`dsh_spike_t` per scenario, whole lifecycle on the calling thread — Kotlin
keeps that a single HandlerThread); canonical lines still fan out to logcat
AND per-scenario capture files pulled via `run-as`, and
`ci/run-spike-e2e.sh` now delivers two checker verdicts (`ALL PASS`/`ALL
FAIL` is the completion marker). Verified on the API 35 `pixel` emulator:
`m1.spike.boot` 7/7 and `m2.bridge.smoke` 6/6, evidence under
`hosts/android/artifacts/m4-host/`.

## Alternatives considered

- Settling calls directly inside the dispatch callback (settle re-enters JS
  synchronously): lost because it changes the settlement semantics the
  scenario exists to prove — the CLI backend defers to a later tick, and an
  isomorphic host must prove the same pattern, not a faster one; it also
  nests JS re-entry (settle drains microtasks) inside a gateway call.
- One shared runtime for both scenarios: lost because each scenario calls
  `__dshComplete` on its own runtime and a fresh runtime per scenario gives
  the m1 regression a clean boot path exactly like production (one runtime
  per scenario run), at zero cost — the whole lifecycle is ~50 ms.
- Hosting the handlers in Kotlin (JNI returns to Kotlin per call): lost
  because settlement is RUNTIME-THREAD-ONLY and the whole lifecycle already
  lives on one C-driven thread; a Kotlin hop per call would add a second
  dispatch layer with no capability gain for the spike.
- Waiting for an in-repo drift-check tool before embedding the new assets:
  lost on time; provenance is documented in hosts/android/README.md and the
  receipt (cmp-verified at authoring time), and the missing tool is filed as
  a gap instead of blocking the milestone.
