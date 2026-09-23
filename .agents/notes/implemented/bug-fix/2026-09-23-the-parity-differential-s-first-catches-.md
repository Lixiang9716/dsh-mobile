# Agent Note: the parity differential's first catches — the Kotlin mock's choices wrapper, the Android errorStream body, and the launch-env branch

Status: implemented

## Problem

The upstream parity differential (landed in the testing note immediately
before this one) went green only after it caught real defects — which
is the harness doing its job: each catch was invisible to every existing
assertion, because each sat on a seam only a differential against the
reference can see.

## Decision

Five fixes ship, three from the emulator bring-up and two from the
follow-up session that greened the macOS CLI leg and added the iOS
simulator leg. (1) The port-leg scenario's host detection now keys on
whether the launch-env snapshot CARRIES the mock facts — the shared C host
defines `__dshLaunchEnv` on every platform, so the old presence check took
the CLI branch on Android with an empty snapshot and died at
`fsScope.resolve` with `malformed ref`. (2) The on-device scripted mock's
`tool_call_success` stream wraps every chunk in the `choices` array — the
first version SSE'd bare choice objects, so the transport adapter absorbed
no choices at all (only the flat object's `usage` leaked in) and the loop
committed an `assistant/attempt` with `EMPTY_RESPONSE` instead of the
tool-call message. (3) The Android `httpFetch` primitive reads non-2xx
bodies from `conn.errorStream` — `HttpURLConnection.inputStream` throws for
>=400, so provider error bodies were dropped wholesale and the upstream
adapter's 401 diagnosis degraded from `AUTH` to `UNKNOWN` (a contract §4
dent: the body must be readable on any settled response).

(4) **The parked "macOS body-pump failure" was never a pump failure — the
two legs STARVED each other.** The runner served both legs from ONE mock
instance whose script is a one-shot sequence: the Node reference leg
consumed all four scripted behaviors, and the port leg's two calls each
received `script_exhausted` 500-JSON bodies — one `http.body` of error
object, then `http.end`. "SSE bodies end after the first chunk with no
[DONE]" is trivially true of an error body; the mock's own telemetry
(attempt 5+ = script_exhausted, chunksSent 0) named the real story. The
runner now starts ONE MOCK PER LEG (identical fresh scripts — the same
semantics the Android leg's on-device MockLlmRoute has), and the CLI step
checks the new `upstream-parity-cli.json` manifest: the headless host
mounts no Web Client, so it drops `client.selected` from the otherwise
identical expectation list (the two-manifests-per-scenario shape
`llm.live-stream` set). The dev-ios step is UN-parked: reference and port
legs both green — 25/25 records identical, 12/12 events in order.

(5) **The iOS simulator leg (the fourth host) caught a real gateway
divergence: `fsScope.resolve` rejected reserved-scope URIs.** The drive's
launch-env facts (the mock endpoint, injected via `SIMCTL_CHILD_DSH_*` →
the launch-env snapshot `SpikeHostFactory` declares — DSH_-prefixed
process environment now merges into the snapshot alongside
`DSH_ISH_ROOTFS`) put the scenario on the CLI-shaped branch, whose
`fsScope.resolve('scope://app/')` call the iOS primitive answered
`invalid: malformed ref` — iOS only accepted `bkm:` bookmarks, while the
CLI host answers the reserved-scope URI with the scope root's path.
iOS now answers `scope://<name>/` URIs through the same `rootURL(for:)`
mapping every other fs primitive uses (unknown scopes still fail loud),
and `test/e2e/run-ios-upstream-parity.sh` drives the whole leg: embed the
scenario + projector in the bundle, host-side node mock on the shared
simulator loopback, the REAL gateway httpFetch crossing to it, the
projected records diffed against the committed golden — 25/25 identical,
12/12 in order, evidence under `hosts/ios/artifacts/upstream-parity/`.
With it, the vendored spine's projected session log is proven identical
under plain Node, the macOS quickjs CLI, the Android emulator, and the
iOS simulator. CI carries the Android emulator step (dev-android) and the
macOS CLI differential (dev-ios); the iOS simulator leg stays local (CI
runners cannot drive the simulator capture), like every other iOS
UI-drive leg.

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
- **Double the mock's DSH_MOCK_SEQUENCE instead of one mock per leg** —
  rejected: any retry inside a leg shifts the alignment silently; two
  instances make each leg's script consumption independent, which is also
  what the committed evidence claims (each leg ran the same scripted
  turns).
- **Make the iOS `fsScope.resolve` change in the scenario instead** (skip
  the URI when a containerRoot arrives over the bus) — rejected: the
  CLI-shaped branch is exactly the code the CLI leg runs; forking it per
  host would erode the parity the differential exists to prove. The hosts
  already disagreed; the fix aligns the host, not the scenario.
