# Agent Note: M2 E2E contracts: gateway binding manifest + audit stream + simulator runner

Status: implemented

## Problem

M2's "real gateway binding" milestone needs its E2E verification surface
before the scenario code and the Swift privileged layer land: without a
frozen expected-event manifest there is no one-to-one contract for workers
to code against, and the gateway's audit stream — a different log format
from the unified logger — had no assertion path at all. The existing
checker assumed every record carries the logger envelope
(`{"level",…,"data":[{scenario,…}]}`) and filtered on `data[0].scenario`,
so it could not even parse the flat audit records. Additionally, the M2
iOS scenario is UI-driven (permission alert, Files picker, approval
dialog, notification banner): CI runners cannot tap, so the full E2E needs
a local simulator driver, while CI must keep the build as the hard gate
without pretending the UI leg ran.

## Decision

`tools/e2e/` carries the M2 E2E contracts and the local driver:

- Manifests freeze the ordered contracts: `m2-gateway-binding.json`
  (19 events, subset field matchers), `m2-gateway-audit.json` (15 flat
  audit records over the `dsh.gateway.audit:` prefix), `m2-bridge-smoke.json`
  (6 events, macOS CLI), and the slimmed 7-event `m1-spike-boot.json`.
- `check.mjs` gains a minimal `extract.envelope: "flat"` mode: records are
  matched at top level on `primitive` + `match` fields, with no scenario
  filter; logger-envelope behavior is unchanged (proven by the selftest).
- `run-ios.sh` is the local simulator driver (vendor → build → install →
  launch with truncated log capture → react to `spike: ui-wait` markers via
  idb → terminal `spike: sequence` marker → run all four checkers → summary
  table, non-zero exit on any failure). Every wait polls a condition with a
  deadline (rule 8); screenshots are saved artifacts, never checker inputs.
  UI steps try `idb ui describe-all` first and fall back to named
  calibration constants (`PT_*`) for the iOS 26.5 describe-all failures.
- `dev-ios.yml` keeps the build as the hard gate; the m1 step additionally
  accepts the first `spike: ui-wait` stall as its stop condition so m1
  checks still run on CI, and the new m2 step honestly warns and skips
  (continue-on-error) since the UI-driven leg cannot complete there.
- `selftest.sh` + `testdata/` prove the checker against synthetic fixtures:
  one positive log passes both m2 checkers, two negative logs fail at
  named indices.

## Alternatives considered

- **Separate audit checker script** instead of extending check.mjs: two
  matchers to keep in sync, and the one-to-one failure report (first
  mismatched index with both sides) would be duplicated or lost. The
  envelope is a 10-line extraction difference; one checker serves both.
- **Screenshots as the m2 assertion** on CI: rejected — they violate the
  frozen "log-based assertions, no screenshots" contract and are
  non-deterministic across runner images. Screenshots remain local
  debugging artifacts under `<art-dir>/screens/`.
- **A blocking whole-result wait (fixed sleep for the scenario duration)**
  in the driver: rejected per rule 8 — markers arrive at unpredictable
  times (notification delivery, picker navigation), so the driver follows
  the log and polls each condition with a deadline, failing loud with the
  last 50 log lines.
- **XCUITest instead of idb**: a second UI-test target and bundle id
  plumbing for a spike; idb drives the existing app from outside with no
  app-side test hooks, and its tap primitive doubles as the manual
  debugging path.
