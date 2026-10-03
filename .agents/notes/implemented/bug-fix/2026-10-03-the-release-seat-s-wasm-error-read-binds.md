# Agent Note: the release seat's wasm error read binds its JNI symbol

Status: implemented
Related: #335 (B4 shell realism), #312 (fail in-band, never throw across the serial skeleton)

Date: 2026-10-03 · Class: bug-fix

## Problem

Every release boot of the Android host died before the carrier server ever
listened. The seat's spine calls a shell program at boot (`dsh-shell-wasm`,
the #338/#335-B4 starter set); when that `wasmRun` fails, `WasmPrimitive`
reads the error slot — `SpikeRuntime.wasmLastError()` → `nativeWasmLast()`
— and the JNI lookup finds no symbol: #338 declared the Kotlin external
`nativeWasmLast` but exported the C function as
`Java_com_dshmobile_spike_SpikeRuntime_nativeWasmLastError`. JNI binds at
first call, so CI never saw it (debug scenarios only run the successful
echo/wc legs); on the device the `UnsatisfiedLinkError` crossed the gateway
callback onto the `dsh-spike-js` HandlerThread and took the process down —
exactly the throw-across-the-serial-skeleton failure #312 bans, reached
through the error path that exists to report failures in-band. Observed on
emulator-5558, release build of 30cf8808: `FATAL EXCEPTION: dsh-spike-js …
No implementation found for … nativeWasmLast`, pid gone, uid 10210 never
binds a LISTEN socket.

## Decision

The C export is renamed to `nativeWasmLast`
(`hosts/android/app/src/main/cpp/dsh_spike_jni.c`), matching the Kotlin
external and restoring the seam's own naming pattern — the M4 seam pairs
`nativeM4Last()` with the public `m4LastError()` wrapper, and the wasm seam
now pairs `nativeWasmLast()` with `wasmLastError()`. A failing `wasmRun`
again answers in-band (`GatewayError("io", "wasmRun", <slot>)`) and the
runtime survives to serve it.

The mismatch class gets a gate:
`test/panel/android-jni-surface.test.js` parses every `external fun` in
`SpikeRuntime.kt` and every `Java_com_dshmobile_spike_SpikeRuntime_*`
symbol under `hosts/android/app/src/main/cpp/`, and fails in both
directions — a Kotlin external with no C symbol (a future
`UnsatisfiedLinkError` on a device, not in CI) and a C export no Kotlin
external declares (drift from the same rename family). The test's teeth
are verified in-tree: with the export renamed back to the drifted name
both assertions fail naming `nativeWasmLast`; restored, the full panel
suite passes 12 files / 157 tests.

## Alternatives considered

- **Rename the Kotlin external to `nativeWasmLastError`** (keep the C
  name): one word either way, but it makes the Kotlin side the odd one out
  against the established `nativeXxxLast` pattern (`nativeM4Last`,
  `nativeWasmRun`) and churns the newer file for the older file's slip.
- **Catch `UnsatisfiedLinkError` in `WasmPrimitive`**: treats the symptom —
  the symbol is still missing, the wasm error slot stays unreadable, and
  rule 5's fail-loud is converted into a silent degraded seam.
- **Register natives in a `JNI_OnLoad` table**: a registration layer for
  exactly one symbol slip; more surface to keep in sync, no additional
  guarantee over the name-matched export plus the new closure gate.
