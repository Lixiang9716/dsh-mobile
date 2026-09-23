# Agent Note: the parity differential's first catches — the Kotlin mock's choices wrapper, the Android errorStream body, and the launch-env branch

Status: implemented

## Problem

The upstream parity differential (landed in the testing note immediately
before this one) went green only after it caught three real defects — which
is the harness doing its job: each catch was invisible to every existing
assertion, because each sat on a seam only a differential against the
reference can see.

## Decision

Three fixes ship: (1) the port-leg scenario's host detection now keys on
whether the launch-env snapshot CARRIES the mock facts — the shared C host
defines `__dshLaunchEnv` on every platform, so the old presence check took
the CLI branch on Android with an empty snapshot and died at
`fsScope.resolve` with `malformed ref`; (2) the on-device scripted mock's
`tool_call_success` stream wraps every chunk in the `choices` array — the
first version SSE'd bare choice objects, so the transport adapter absorbed
no choices at all (only the flat object's `usage` leaked in) and the loop
committed an `assistant/attempt` with `EMPTY_RESPONSE` instead of the
tool-call message; (3) the Android `httpFetch` primitive reads non-2xx
bodies from `conn.errorStream` — `HttpURLConnection.inputStream` throws for
>=400, so provider error bodies were dropped wholesale and the upstream
adapter's 401 diagnosis degraded from `AUTH` to `UNKNOWN` (a contract §4
dent: the body must be readable on any settled response). With the three
fixed, the emulator leg is green end to end: the manifest 13/13 in order,
the differential 25/25 records identical to the committed Node golden, and
the scenario verdict ALL PASS. CI carries the Android emulator step in
dev-android; the macOS CLI step is wired but PARKED (continue-on-error)
for a handoff — the vendored engine builds there now (an `_np`
compile-time shim in our host/ish/CMakeLists.txt; the vendored source
stays verbatim) but the CLI port leg's SSE bodies end after the first
chunk (http.end with no [DONE] → STREAM_CLOSED), suspected in the CLI
--http loopback backend's body pump. The e2e-matrix gains the
`upstream-parity` evidence row for the green emulator leg.

## Alternatives considered

- **Mask the error-leg code in the manifest and ship** — rejected: the
  AUTH→UNKNOWN degradation was exactly the kind of compatibility dent the
  harness exists to catch; masking it would have turned the differential
  into theater on its first day.
- **Fix the adapter to tolerate missing error bodies** — rejected: the
  adapter is upstream-verbatim code (D6/D9); the defect is on OUR side of
  the seam (the primitive), and the fix is one branch in the primitive.
- **Drop the on-device mock route and adb-reverse to the node mock** —
  rejected for this leg: the carrier's scripted route keeps the emulator
  leg self-contained in CI (no host-side port plumbing), and the golden
  diff holds the two mock implementations honest — the choices-wrapper bug
  was caught precisely because the node reference refused to agree.
