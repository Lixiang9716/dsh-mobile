# hosts/harmony/

The HarmonyOS NEXT host (M5): ArkTS shell + NAPI bridge to quickjs-ng + ArkWeb.
Subprocesses are designed as unavailable; store-review posture to be verified in practice.

## M1 spike (landed)

A minimal HAP that embeds the merged M1 core spike
([runtime/spike/README.md](../../runtime/spike/README.md)) and verifies scenario
`m1.spike.boot` on the local HarmonyOS emulator. Evidence:
[artifacts/m1-spike/](artifacts/m1-spike/) (logs, sink capture, verdict, screenshot,
receipt).

Layout:

- `build-profile.json5` / `hvigorfile.ts` / `oh-package.json5` / `hvigor/` — project level
  (hvigor 6.x, modelVersion 5.0.0, `compatibleSdkVersion: "26.0.0"`).
- `AppScope/` — app identity (`com.dshmobile.spike`).
- `entry/src/main/cpp/` — the NAPI library (`libspike.so`): CMake compiles
  `runtime/spike/host/dsh_spike_host.c` plus the pinned quickjs-ng 0.17.0 sources
  (`dtoa.c libregexp.c libunicode.c quickjs.c`) and `napi_init.cpp` exposes
  `startSpike(bundleRoot, capturePath)`. CMake runs `runtime/spike/vendor/ensure.sh`
  first, so the vendor tree is always materialized before compiling.
- `entry/src/main/ets/pages/Index.ets` — materializes the bundled spike (byte-identical
  rawfile copies of `logger.js`, `scenario/m1-spike-boot.js`, the vendored util-crypto
  package) into the app cache dir preserving layout, then calls `startSpike` ONCE and
  shows the returned verdict.
- `entry/src/main/resources/rawfile/spike/` — the bundled spike JS (kept byte-identical
  to the `runtime/spike/` originals).

Threading (ARCHITECTURE.md §6): the whole new+eval+pump loop runs synchronously inside
the NAPI call on the caller thread — one serial JS thread, no extra threads.

Log capture: the C sink forwards each canonical `dsh.spike.log:` line unmodified to
hilog (domain `0xD5E0`, tag `dsh.spike`, `%{public}s`) AND appends it to a capture file
under the app cache dir, pulled via `hdc file recv` as the truncation-proof second
capture.

## Build and run (CLT 26.0.0.821)

```sh
CLT=/opt/homebrew/share/harmonyos-commandlinetools/command-line-tools
cd hosts/harmony
"$CLT/bin/ohpm" install --all
"$CLT/bin/hvigorw" assembleHap --mode module -p product=default -p buildMode=debug --no-daemon
# → entry/build/default/outputs/default/entry-default-unsigned.hap

HDC="$CLT/sdk/default/openharmony/toolchains/hdc"
"$HDC" install entry/build/default/outputs/default/entry-default-unsigned.hap
"$HDC" shell power-shell wakeup            # unlock the emulator screen first
"$HDC" shell uinput -T -m 400 1600 400 400 300
"$HDC" shell aa start -b com.dshmobile.spike -a EntryAbility
"$HDC" shell hilog -x | grep dsh.spike
```

No signing config is needed: the emulator accepts the unsigned debug HAP via
`hdc install` as-is.
