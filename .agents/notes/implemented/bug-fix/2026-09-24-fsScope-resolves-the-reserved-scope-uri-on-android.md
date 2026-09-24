# Agent Note: fsScope.resolve answers the reserved `scope://` URIs on Android — the upstream suite leg un-blocks

Status: implemented

## Problem

The upstream DSH test suite (the agent-loop regression vehicle) has been
100% red on the Android emulator since #170: every spec launch dies before
importing its spec with `GatewayError: malformed ref` (58/58 no-summary in
the overnight E2E session of 2026-09-24, issue #175). The trigger is
`runtime/spike/scenario/upstream-suite-leg.js:74` (added by #170), which
pins the profile cwd with an unguarded `fsScope.resolve('scope://app/')`.
The Android host's `FsPrimitives.resolveRef` — unchanged since #41 —
accepted ONLY persisted SAF bookmark refs (`bkm:` prefix) and answered
everything else with `invalid("fsScope.resolve", "malformed ref")`. The
same call succeeds on the other two hosts: the CLI driver resolves any
`fsScope.resolve` to the profile container (`main_cli.c`, "the profile
container IS the scope root"), and iOS's `FSPrimitives.swift` has carried
an explicit reserved-scope branch since its session serve landed ("the
same way the CLI host answers them"). Android was the only host where the
upstream scenarios could not pin a profile cwd. The parity drive masked
the gap because its host-facts branch supplies a non-null root and never
calls resolve; the suite leg's runtime.config carries only `spec` +
`containerRoot`, so the resolve always runs.

## Decision

`FsPrimitives.resolveRef` gains the iOS-shaped reserved-scope branch: a
ref of the form `scope://<name>/` with `name == "app"` settles
`{"scope": "app", "path": <filesDir>/profiles/default}` — the same
reserved root the Android fs primitives already map `scope: "app"` to.
Any other reserved name still falls through to the bookmark path and
keeps failing `malformed ref` (fail-loud, rule 5). No contract change:
`fsScope` stays in the descriptor as-is, and the settled payload shape
(`scope` + absolute `path`) is exactly what iOS and the CLI return.

## Alternatives considered

- Guarding the resolve in the suite leg and falling back to the
  `containerRoot` it already receives over runtime.config — fixes the one
  caller that tripped, but leaves the host the odd one out among the
  three hosts and breaks the next scenario that resolves the reserved
  URI (upstream-session, upstream-web-boot, settings-surfaces and
  upstream-parity all carry the same call shape behind their guards).
- Widening `BOOKMARK_PREFIX` handling to accept arbitrary URI shapes —
  blurs the two ref families (persisted user scopes vs reserved
  namespaces) the contract keeps separate.

## Consequences

The upstream suite runs again on the emulator (verified on-device: the
previously fatal first resolve now settles and the driver proceeds into
the spec). `git grep "scope://app"` scenario call sites need no change.
Issue #175 carries the discovery evidence; the suite's CI-visibility gap
(nothing runs it on push) remains open as a follow-up beyond this fix.
