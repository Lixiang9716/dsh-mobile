# hosts/harmony/

The HarmonyOS NEXT host (M5): ArkTS shell + NAPI bridge to quickjs-ng + ArkWeb.
Subprocesses are designed as unavailable; store-review posture to be verified in practice.

## M5 host (in progress — isomorphic host verified)

The M1 spike HAP grew into the isomorphic M5 host: ONE launch on the emulator drives
BOTH spike scenarios synchronously on the NAPI caller thread and both verdicts are
green — `m1.spike.boot` (regression, 7/7) and `m2.bridge.smoke` (6/6) over the REAL
gateway dispatch bridge. Evidence: [artifacts/m5-host/](artifacts/m5-host/) (logs,
sink capture, scenario.jsonl, per-scenario verdicts, screenshot, receipt).

- `entry/src/main/cpp/gateway_smoke.cpp|h` — the platform twin of the desktop CLI
  smoke backend (`runtime/spike/host/main_cli.c`): it answers the dispatched calls of
  `m2.bridge.smoke` — fsRead/fsWrite/fsScope over the app files dir exposed as scope
  `"app"` (`filesDir/spike-fs`, passed by ArkTS as the `fsRoot` argument), keychain
  honestly `unavailable` (declared so in the RuntimeDescriptor served to
  `__dshGatewayDescriptor()`), unknown primitives `invalid`. Calls are only QUEUED
  in the dispatch callback; settlement is deferred to the post-pump drain pass (the
  later-tick pattern the scenario exists to prove), inside a 10 s condition-driven
  backstop loop.
- `entry/src/main/cpp/napi_init.cpp` — `startSpike(bundleRoot, capturePath, fsRoot)`
  runs `scenario/m1-spike-boot.js`, then `scenario/m2-bridge-smoke.js`, each on its
  own `dsh_spike_t` instance, and emits one `dsh.spike.verdict:` line per scenario.

Threading (ARCHITECTURE.md §6): the whole new+eval+pump+settle loop runs
synchronously inside the NAPI call on the caller thread — one serial JS thread, no
extra threads. Gateway settlement rides the same thread (the bridge is
RUNTIME-THREAD-ONLY by contract).

## M1 spike (landed)

The original carrier spike that embedded the merged M1 core spike
([runtime/spike/README.md](../../runtime/spike/README.md)) and verified scenario
`m1.spike.boot` on the local HarmonyOS emulator. Evidence:
[artifacts/m1-spike/](artifacts/m1-spike/) (logs, sink capture, verdict, screenshot,
receipt).

Layout:

- `build-profile.json5` / `hvigorfile.ts` / `oh-package.json5` / `hvigor/` — project level
  (hvigor 6.x, modelVersion 5.0.0, `compatibleSdkVersion: "26.0.0"`).
- `AppScope/` — app identity (`com.dshmobile.spike`).
- `entry/src/main/cpp/` — the NAPI library (`libspike.so`): CMake compiles
  `runtime/spike/host/dsh_spike_host.c`, `gateway_smoke.cpp`, plus the pinned
  quickjs-ng 0.17.0 sources (`dtoa.c libregexp.c libunicode.c quickjs.c`) through
  hvigor's externalNativeOptions. CMake runs `runtime/spike/vendor/ensure.sh`
  first, so the vendor tree is always materialized before compiling.
- `entry/src/main/ets/pages/Index.ets` — materializes the bundled spike (byte-identical
  rawfile copies of `logger.js`, `gateway.js`, both scenarios, the vendored util-crypto
  package) into the app cache dir preserving layout, then calls `startSpike` ONCE and
  shows the returned verdict.
- `entry/src/main/resources/rawfile/spike/` — the bundled spike JS (kept byte-identical
  to the `runtime/spike/` originals; the m1-spike-boot.js copy was found stale after the
  M2 slimming landed upstream and is refreshed here — drift in these copies is silent
  otherwise, see the surprise ledger).

Log capture: the C sink forwards each canonical `dsh.spike.log:` line unmodified to
hilog (domain `0xD5E0`, tag `dsh.spike`, `%{public}s`) AND appends it to a capture file
under the app cache dir (`haps/entry/cache/dsh-spike-capture.log`), pulled via
`hdc file recv` as the truncation-proof second capture.

## Build and run (CLT 26.0.0.821)

```sh
CLT=/opt/homebrew/share/harmonyos-commandlinetools/command-line-tools
cd hosts/harmony
"$CLT/bin/ohpm" install --all
"$CLT/bin/hvigorw" assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
# → entry/build/default/outputs/default/entry-default-unsigned.hap

HDC="$CLT/sdk/default/openharmony/toolchains/hdc"
"$CLT/emulator/Emulator" -list                 # instance dsh_phone
"$CLT/emulator/Emulator" -start dsh_phone      # wait for `hdc list targets`
"$HDC" install entry/build/default/outputs/default/entry-default-unsigned.hap
"$HDC" shell power-shell wakeup            # unlock the emulator screen first
"$HDC" shell uinput -T -m 400 1600 400 400 300
"$HDC" shell hilog -r                      # clear, then launch
"$HDC" shell aa start -b com.dshmobile.spike -a EntryAbility
"$HDC" shell hilog -x | grep dsh.spike     # two `dsh.spike.verdict:` lines expected
"$HDC" file recv /data/app/el2/100/base/com.dshmobile.spike/haps/entry/cache/dsh-spike-capture.log .
"$HDC" shell snapshot_display -f /data/local/tmp/m5-screenshot.jpeg
"$HDC" file recv /data/local/tmp/m5-screenshot.jpeg .

node ../../tools/e2e/check.mjs --manifest ../../tools/e2e/scenarios/m1-spike-boot.json --log logs.txt
node ../../tools/e2e/check.mjs --manifest ../../tools/e2e/scenarios/m2-bridge-smoke.json --log logs.txt
```

No signing config is needed: the emulator accepts the unsigned debug HAP via
`hdc install` as-is.
