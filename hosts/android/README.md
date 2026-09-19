# hosts/android/

The Android host (M4). v1 is isomorphic with iOS (quickjs-ng + Kotlin gateway); v2 may add a
nodejs-mobile high-fidelity mode (V8 JIT + Termux-pattern subprocesses), with the difference
expressed via RuntimeDescriptor capabilities.

## M4 status: isomorphic host verified — gateway bridge scenario green on emulator

The app embeds the shared M2 spike host (`runtime/spike/host/dsh_spike_host.c`) with its REAL
gateway dispatch bridge (no canned responses — the M1 single-call slot is gone) and runs BOTH
scenarios in one launch, judged by the shared checker:

- `m1.spike.boot` — boot regression, 7/7 canonical events.
- `m2.bridge.smoke` — the gateway bridge end to end, 6/6 canonical events: fsWrite/fsRead of 17
  base64-carried bytes, the scope-escape `invalid` rejection, and `keychainGet` rejected with the
  honest `unavailable` code.

Evidence (one run, final code state): `artifacts/m4-host/` — `logs.txt` (logcat `-s dsh.spike`),
`scenario.jsonl` (canonical `dsh.spike.log:` lines), `verdict-m1-spike-boot.json` + 
`verdict-m2-bridge-smoke.json` (checker PASS), `screenshot.png` (human evidence only — never a
checker input), `receipt.json`.

## How it works

- `app/src/main/cpp/dsh_spike_smoke.c` — the Android smoke backend, sibling of
  `runtime/spike/host/main_cli.c`'s: calls are only QUEUED inside the dispatch callback (which
  fires synchronously on the runtime thread) and settled in the post-pump drain pass — the
  deferred later-tick settlement the scenario proves. `fsRead`/`fsWrite` run base64 payloads
  against `filesDir/smoke-fs` (scope `app`, escape-checked); the six primitives the descriptor
  declares unavailable (`keychainGet`, `keychainSet`, `httpFetch`, `notify`, `presentApproval`,
  `presentPicker`) reject with `unavailable`; anything else rejects `invalid` with the offending
  name. The descriptor is identical to the CLI's. NO new primitives, NO contract changes.
- `app/src/main/cpp/dsh_spike_jni.c` — one fresh `dsh_spike_t` runtime per scenario, whole
  lifecycle on the CALLING thread; Kotlin (`SpikeRuntime`) keeps that caller a single
  `HandlerThread("dsh-spike-js")` (logcat pid/tid columns prove the split from the UI thread).
- `app/src/main/assets/spike/` — the spike bundle as byte-identical copies of `runtime/spike/`
  (`gateway.js`, `scenario/m1-spike-boot.js`, `scenario/m2-bridge-smoke.js`, `logger.js`,
  `vendor/dsh/util-crypto@0.1.6-alpha.1`), cmp-verified at authoring time; unpacked to
  `filesDir/spike` at first run because the C host fopen()s real paths. The repo has no
  drift-check tool for these copies yet — provenance is this paragraph (and the receipt).
- Capture: every canonical line goes UNMODIFIED to logcat (tag `dsh.spike`) AND to
  `filesDir/spike-capture-<scenario>.log` (pulled via `adb exec-out run-as com.dshmobile.spike
  cat ...` — the truncation-proof cross-check); per-scenario verdicts land on tag
  `dsh.spike.result`, terminated by the `ALL PASS` / `ALL FAIL` line.

## How to run

```sh
# SDK root /opt/homebrew/share/android-commandlinetools, JDK17, AVD `pixel` (API 35 arm64)
export JAVA_HOME=/Library/Java/JavaVirtualMachines/microsoft-17.jdk/Contents/Home
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
echo "sdk.dir=$ANDROID_HOME" > hosts/android/local.properties
$ANDROID_HOME/emulator/emulator -avd pixel -no-window -no-audio -no-boot-anim -no-snapshot -port 5554 &
(cd hosts/android && ./gradlew assembleDebug --no-daemon)
bash hosts/android/ci/run-spike-e2e.sh   # boot-wait -> install -> launch -> poll -> both checker verdicts
```

CI (`.github/workflows/dev-android.yml`) runs the same script against an API 35 x86_64 emulator.
