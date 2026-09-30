# Agent Note: The smoke hosts implement the keychain — the re-pinned bridge-smoke leg demanded it

Status: implemented
Related: PR #280, contract v1.0.0 rows 8-9 (keychainGet/keychainSet)

## Problem

PR #280 re-pinned `gateway.bridge-smoke` from the declared-unavailable
conformance path (keychainGet answers `unavailable`) to a real roundtrip
(set → get bytes-equal → delete → get null), because the BYOK onboarding
flow stores credentials in the keychain and the CLI dev host
(`runtime/spike/host/main_cli.c`) now implements the primitives as
0600-per-ref files. Only the CLI host was taught. The scenario JS is a
byte-identical committed copy on every host, so on Android the staged copy
called `keychainSet` against `dsh_spike_smoke.c`, which still rejected it
`unavailable` — the promise never settled, the scenario died after 4 of 7
expected events with no `scenario.failed` line, and the `android-e2e` CI
leg (and with it `ci-verdict`) went red on the PR's own head. Harmony's
`gateway_smoke.cpp` regression mode carried the same mismatch: its
`run_m2` drives the same scenario with `dsh_smoke_new` (no forward hook),
so the same leg would die on device parity even though `harmonyos-build`
(build-only) stayed green.

## Decision

Both smoke hosts now mirror the CLI twin: `keychainGet`/`keychainSet` move
into the descriptor's `available` array and are served as one file per ref
under `<fs_root>/keychain/` — base64 payloads, mode 0600 per file, the
store directory tightened to 0700 at creation (the review finding carried
over: the 0700 mkdir runs BEFORE `smoke_mkdirs`, whose 0755 pass would
otherwise win the race on an existing dir). `keychainSet(ref, null)` stays
the documented delete; an unset ref settles JSON `null`. Binding mode on
Harmony is untouched — keychain rides the forward hook to the ArkTS
capability layer before the C table is ever consulted. Stale header
comments that promised "keychain honestly unavailable" were updated to
match the code.

## Alternatives considered

- **Skip the keychain leg when the descriptor declares it unavailable**
  (a conditional in the scenario JS). Rejected: it re-teaches the
  scenario to pass on a host that cannot run the flow the PR ships — the
  BYOK panel saves credentials through `keychainSet`, so a smoke host
  that rejects it cannot exercise the feature at all, and the E2E assert
  would silently degrade back to the pre-PR shape.
- **Android-only fix.** Rejected: harmony's regression-mode m2 leg would
  keep dying off-CI (device parity / simulator matrix), the exact
  "verified on one host only" trap the GNU-tar note (2026-09-30)
  documents. Same defect, both twins, one change.
