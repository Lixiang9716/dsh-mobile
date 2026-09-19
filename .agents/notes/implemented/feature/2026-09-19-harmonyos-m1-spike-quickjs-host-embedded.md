# Agent Note: HarmonyOS M1 spike: quickjs host embedded via NAPI, scenario verified on the emulator

Status: implemented
Related: D6

## Problem

The M1 core spike (quickjs-ng host running the pinned upstream util-crypto package)
had a desktop proof run only. The project's premise — one platform-neutral C host
embedded per platform (AGENTS.md; runtime/spike/README.md "Embedding contract") —
was unproven on HarmonyOS, the first host whose JS runtime is a pure NAPI embed with
no desktop shell to lean on. Without a second platform the spike's claim of
platform-neutrality is untested, and the E2E-by-logs verdict (rule 7) had never been
produced from a device log stream (hilog) rather than stdout.

## Decision

`hosts/harmony/` now carries a minimal hvigor HAP (bundle `com.dshmobile.spike`)
that embeds the spike: CMake compiles `runtime/spike/host/dsh_spike_host.c` plus the
pinned quickjs-ng 0.17.0 compile set via hvigor's externalNativeOptions, and CMake
runs `runtime/spike/vendor/ensure.sh` itself so every build environment materializes
the untracked vendor tree before compiling (upstream discipline D6 — the engine is
never vendored into git). `napi_init.cpp` exposes `startSpike(bundleRoot,
capturePath)`, which runs the whole new+eval+pump loop synchronously on the NAPI
caller thread (one serial JS thread, ARCHITECTURE.md §6) and forwards each canonical
`dsh.spike.log:` line byte-unmodified to hilog (domain 0xD5E0, tag `dsh.spike`,
`%{public}s`) and to a capture file under the app cache dir pulled via
`hdc file recv` (hilog is the primary checker input; the sink file is the
truncation-proof second capture). The scenario JS ships as byte-identical rawfile
copies materialized into the cache dir preserving layout. The shared
`tools/e2e/check.mjs` verdict over the hilog capture is PASS 9/9 in order; evidence
in `hosts/harmony/artifacts/m1-spike/` (logs, sink capture, scenario.jsonl, verdict,
screenshot, receipt). The emulator accepts the unsigned debug HAP, so no signing
config exists in the project.

## Alternatives considered

- Async/taskpool driving of the JS runtime: rejected — the embedding contract
  requires one serial thread, and an async pump adds thread hops for no benefit in a
  sub-second scenario; blocking the UI thread for <1s at startup is acceptable for a
  spike.
- Signing the HAP with the CLT-shipped OpenHarmony debug materials
  (OpenHarmony.p12 + profile template via hap-sign-tool): prepared for, but not
  needed — the emulator installs unsigned HAPs; adding local signing materials would
  put machine-specific config in the tree for zero functional gain.
- Bundling the scenario JS as C string literals compiled into the .so: rejected —
  byte-identical rawfile copies of the `runtime/spike/` originals keep one source of
  truth and let the same ESM loader contract (bundle_root on disk) hold on every
  platform, matching how the desktop CLI and the sink's module loader already work.
- Polling the app state from the host side to detect scenario completion: rejected —
  the completion signal is the native verdict line (`dsh.spike.verdict:`) in hilog
  and the sink capture file; event-driven, no polling loop against app state.
