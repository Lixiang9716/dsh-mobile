# Agent Note: Android M1 spike — quickjs host verified on emulator via logcat

Status: implemented
Related: D1, D2, D5

## Problem

The M1 core spike (`runtime/spike/`) had exactly one proof environment: the
macOS CLI. The Android plane had no Gradle project at all, so the claim
"every platform host links the identical C and passes the identical log
verdict" was untested on the platform with the harshest constraints: a
mobile OS that forbids subprocesses, hides the filesystem behind app
sandboxes, and whose bionic headers hide `arc4random_buf` below API 28
while the spike's minSdk is 26.

## Decision

`hosts/android/` lands a minimal single-module Gradle app
(`com.dshmobile.spike`) that embeds the M1 core spike and verifies scenario
`m1.spike.boot` on the local emulator, judged by the shared checker:

- Native: CMake compiles `runtime/spike/host/dsh_spike_host.c` plus the
  vendored quickjs-ng 0.17.0 library sources via relative paths into the
  `runtime/` tree — the Android build owns zero engine code of its own.
  `vendor/ensure.sh` is wired as the `ensureSpikeVendor` Gradle Exec task
  (absolute path; an Exec task inherits the launcher cwd, which must never
  decide whether engine sources are found) and runs before preBuild and
  every CMake task.
- bionic gap: `android_compat.{h,c}` force-included via `-include` restores
  the `arc4random_buf` declaration for API < 28 and defines it over
  getrandom(2)/`/dev/urandom` (abort on no kernel RNG — never fake entropy).
  It links inside our `.so` only, so API 28+ bionic is untouched.
- Threading: `SpikeRuntime` (Kotlin object) owns one `HandlerThread`
  ("dsh-spike-js") started once per process; bundle materialization and the
  full `dsh_spike_new/eval/pump/complete` lifecycle run posted on its
  looper, never on the UI thread — the single-serial-thread rule (D2) is
  load-bearing, and logcat pid/tid columns prove the split.
- The JNI sink forwards each canonical line UNMODIFIED to both logcat (tag
  `dsh.spike`) and `filesDir/spike-capture.log`; the two captures are
  byte-identical, so the logcat stream is the CI assertion and the pulled
  file is the verbatim cross-check.
- The spike bundle (scenario JS, logger.js, vendored dsh package) ships as
  byte-identical copies under `app/src/main/assets/spike/` (cmp-verified
  against `runtime/spike/`), unpacked to `filesDir/spike` at first run
  because the C host fopen()s real paths.
- Evidence under `hosts/android/artifacts/m1-spike/` mirrors the macOS
  layout: logs.txt, sink-capture.log, scenario.jsonl, verdict.json
  (checker PASS 9/9), screenshot.png (human evidence only), receipt.json.
- CI: `.github/workflows/dev-android.yml` builds the APK, boots the API 35
  x86_64 emulator (KVM), captures `logcat -d -s dsh.spike`, and lets
  `tools/e2e/check.mjs` deliver the verdict; completion is polled with a
  120s deadline, never a blind wait.

## Alternatives considered

- Vendoring the quickjs-ng sources into `hosts/android/` — rejected: D6
  upstream discipline and the shared untracked vendor tree exist precisely
  so every platform compiles the identical pinned bytes; a second copy
  would fork the pin silently.
- Running the JS lifecycle on the UI thread (an android.os.AsyncTask-era
  shortcut) — rejected outright: violates the single-serial-thread rule's
  spirit and blocks the UI thread on pump; the HandlerThread costs ~10
  lines and is the pattern the real runtime will use.
- Emitting verdict JSON from JNI and parsing it in Kotlin — rejected: JSON
  escaping of arbitrary JS exception text in C is a bug factory; a plain
  verdict line is sufficient for the TextView (the log is the assertion).
- Driving the scenario from an instrumented test (androidx.test) instead
  of the activity — rejected for M1: the activity proves a real user-facing
  host process boots the engine; the CI harness can adopt instrumentation
  later without touching the scenario or checker.

## Consequences

Every future Android runtime work starts from a green `m1.spike.boot` on
emulator; the JNI bridge is throwaway by design (it will be replaced by the
capability-gateway host layer), but the threading skeleton, vendor wiring,
and log-assertion pipeline carry forward. The `arc4random_buf` shim can be
retired by raising minSdk to 28 — tracked as a deliberate bump, not a
drive-by.
