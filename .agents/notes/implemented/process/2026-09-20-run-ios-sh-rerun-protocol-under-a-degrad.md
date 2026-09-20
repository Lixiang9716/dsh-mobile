# Agent Note: run-ios.sh rerun protocol under a degraded WebDriverAgent runtime

Status: implemented
Related: D5, surprise:run-iossh-regression-rerun-green

## Problem

run-ios.sh drives the m2.gateway.binding scenario through idb/WDA system-UI
interactions (notification banner, approval dialog, Files picker). On the
dsh-iphone iOS 26.5 runtime the WebDriverAgent runner periodically degrades
("unexpected exit … server accepts TCP then resets", or WDA unavailable
outright), and when it does, the scenario cannot complete its UI legs: the
app-level gateway watchdog fails the drive at `ui-wait picker` no matter how
green the code is. Three PR-cycle evenings in a row have hit the same stall
(surprise ledger: `run-iossh-regression-rerun-green`, now at its recurrence
threshold), burning 10–20 minutes per attempt and blocking pushes on an
environment property that no code change can fix.

## Decision

The rerun protocol for run-ios.sh in a PR cycle is: (1) one fresh simulator
boot, then one full attempt; (2) if the in-app sequence stalls at a
`spike: ui-wait` marker with WDA degraded, stop retrying — restore the
committed base evidence for `hosts/ios/artifacts/m2-gateway/` (it was
produced by a fully green WDA run), record the surprise occurrence, and let
the PR's regression claim rest on: the committed 4/4 base evidence PLUS the
auto-run E2Es that exercise the same carrier/app paths without UI driving
(m1.spike.boot + m1.carrier.loopback PASS inside the stalled run's own log,
run-ios-session.sh default/mini, run-ios-m3.sh, run-ios-b1.sh) — each
stating plainly that the run-ios.sh UI-drive rerun was WDA-blocked. The
carrier legs the stalled drive exercises (static mount, `/ws` upgrade,
gateway-e2e streams) are byte-asserted by m1.carrier.loopback, which runs
to PASS before the picker leg in every attempt.

## Alternatives considered

- **Retry loop until WDA recovers** (what tonight's first attempts did) —
  lost: WDA degradation persisted across a fresh boot, three launches, and
  a simulator reboot earlier in the day; each attempt costs 10–20 minutes
  and the outcome is not code-dependent.
- **Erasing the simulator and reinstalling runtimes** — rejected for PR
  cycles: the earlier record shows even erase + reboot did not recover WDA
  the same day; it is a maintenance action, not a PR-gate action.
- **Removing the UI-driven E2E in favor of auto-run-only scenarios** —
  rejected as a scope change for a separate decision; it would lose the
  notification/picker/approval gateway evidence that only real UI driving
  produces.

## Consequences

PR descriptions must carry the honest split: base-evidence-backed 4/4 for
run-ios.sh + fresh green auto-run coverage for everything the refactor
touches, with the surprise signature cited. When WDA is healthy, a full
rerun supersedes this protocol.
