# Agent Note: HarmonyOS M5 isomorphic host: gateway-bridge smoke green on the emulator

Status: implemented
Related: D5

## Problem

The HarmonyOS host carried only the M1 spike: `napi_init.cpp` exposed a bare
new+eval+pump of `m1.spike.boot`, and the merged M2 gateway bridge
(`dsh_spike_set_gateway_dispatch` / `settle` / `event`) had NO embedder on this
platform. The desktop CLI driver (`main_cli.c`) answered scenario
`m2.bridge.smoke` with a smoke backend, but a platform host had never served a
real gateway dispatch from inside its own process boundary — the premise that a
mobile host is the SAME platform-neutral C host plus a thin privileged layer
(ARCHITECTURE.md §8) was unproven on the one host whose JS runtime is a pure
NAPI embed. On top of that, the M2 slimming of `m1.spike.boot` had left the
HarmonyOS rawfile copy stale (old 9-event scenario), so a naive regression run
died silently before `scenario.complete`: the embedded spike bundle had drifted
from its source of truth with nothing to catch it.

## Decision

`hosts/harmony/entry/src/main/cpp/` grows `gateway_smoke.cpp|h`, the platform
twin of `main_cli.c`'s smoke backend: it registers the dispatch and a
RuntimeDescriptor declaring fsRead/fsWrite/fsScope available (everything else
unavailable), serves fs primitives over the app files dir passed by ArkTS as
`fsRoot` (`filesDir/spike-fs`) exposed as scope `"app"`, rejects keychain with
the honest contract `unavailable` error, and rejects unknown primitives with
`invalid`. Calls are only QUEUED in the dispatch callback; settlement is
deferred to the post-pump drain pass inside a 10 s condition-driven backstop —
the later-tick pattern `m2.bridge.smoke` exists to prove. `napi_init.cpp` now
exposes `startSpike(bundleRoot, capturePath, fsRoot)` and runs BOTH scenarios in
one launch, each on its own `dsh_spike_t`: `m1.spike.boot` (regression) then
`m2.bridge.smoke`, emitting one `dsh.spike.verdict:` hilog line per scenario and
returning the combined summary to ArkTS. The rawfile spike bundle is refreshed
byte-identical to `runtime/spike/` (`gateway.js`, `scenario/m2-bridge-smoke.js`
added; the stale `scenario/m1-spike-boot.js` copy corrected). On the emulator
one launch produces both verdicts PASS — checker verdicts 7/7 and 6/6 over the
hilog capture, sink capture byte-identical to hilog after prefix-stripping —
evidence in `hosts/harmony/artifacts/m5-host/`. Threading stays as contracted:
the whole new+eval+pump+settle loop is synchronous on the NAPI caller thread.

## Alternatives considered

- Serving gateway calls synchronously inside the dispatch callback (settle
  during `js_gateway_call`): rejected — it re-enters the runtime from inside a
  host callback and recursively drains microtasks mid-dispatch; the deferred
  queue keeps the embedder out of the runtime's reentrancy and proves the same
  later-tick pattern the desktop twin implements.
- One `dsh_spike_t` running both scenarios sequentially in the same runtime:
  rejected — the scenarios share globals (`__dshComplete` flags complete/pass
  per instance) and a dispatch table scoped to the m2 backend would leak into
  the m1 run; separate instances give the regression a clean room and mirror
  how the CLI driver runs one entry per process.
- Hardcoding the fs root inside the NAPI layer (derive from bundleRoot):
  rejected — the smoke fs scope is app data, not cache; passing `filesDir`-based
  `fsRoot` from ArkTS keeps path policy in the platform layer the same way the
  iOS embedder receives its container paths, and keeps the C backend
  platform-neutral.
- Adding a mechanical byte-identity gate over platform-embedded spike copies
  (the drift this PR fixed by hand): wanted, but it is a cross-host checker
  (ios/android/harmony rawfile trees vs `runtime/spike/`) deserving its own
  change; the drift is recorded in the surprise ledger and the copies are
  re-verified byte-identical here (`cmp` in the receipt note).
