# Agent Note: Android M4: m2.session runs on-device over the gateway bridge

Status: implemented
Related: D5

## Problem

After the gateway-bridge proof (m2.bridge.smoke), the Android host still could
not carry a real plugin: the M2 foundation's `m2.session` scenario (registry +
dsh-fs / dsh-subprocess-quickjs / dsh-ui, mock-LLM streaming, a tool call
persisting through the fs service) ran on the macOS CLI and iOS only. Without
it, "QuickJS-isomorphic host" remained a bridge claim — the session-level
milestone (plugins installing, a tool call running, results persisting under
scope `app`) had no Android evidence.

## Decision

The Android app now embeds the full session bundle as byte-identical assets —
`registry.js`, `scenario/m2-session.js`, and the three system plugins from the
repo root — and the smoke backend (`dsh_spike_smoke.c`) gains the two pieces
main_cli.c grew for the session: the `host.info` readiness event
(`{"event":"host.info","port":0}`, delivered after eval on the same
gateway-event channel; runtimes without a subscriber drop it, so m1.spike.boot
and m2.bridge.smoke are unaffected) and `smoke_mkdirs` (parent directories
created on fsWrite — the platform fs primitives create intermediate
directories, and the scenario's tool result lands at
`smoke-fs/m2-session/result.txt`). `dsh_smoke_run` treats `source` as
caller-owned (freed by `dsh_run_scenario` — the first cut freed it in both
places and scudo aborted on the double free; the backtrace named
`nativeRunSpike`). One launch now drives THREE scenarios; the checker runs
m1.spike.boot 7/7, m2.bridge.smoke 6/6, and m2.session 22/22 on the emulator
(evidence `hosts/android/artifacts/m4-host/`).

## Alternatives considered

- Signalling host.info only for the session scenario (a per-scenario flag in
  the JNI table): lost because the CLI backend signals unconditionally and the
  shim's drop-without-subscriber contract makes that safe for every entry —
  a flag would fork the embedder contract for no behavioral gain.
- Teaching the JS-side fs plugin to create directories via a new primitive:
  rejected outright — it needs a new gateway primitive (contract change, D5
  freeze) where the CLI already established the backend-side mkdir -p parity.
- Keeping `free(source)` inside `dsh_smoke_run` and dropping the caller's
  free: lost — main_cli.c's `main()` owns its buffer and the smoke driver
  must not silently adopt ownership of caller memory; documenting
  caller-ownership in the header matches dsh_spike_host.h's conventions.
