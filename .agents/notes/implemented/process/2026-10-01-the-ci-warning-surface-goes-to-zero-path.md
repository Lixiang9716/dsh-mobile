# Agent Note: the CI warning surface goes to zero — path-filtered absences announce at notice level

Status: implemented
Related: the ci-verdict design note (2026-09-21, the platform E2E legs get an
always-running aggregator verdict) — this note amends its annotation level, not
its verdict logic.

## Problem

CI carried a systematic warning annotation on nearly every PR. `ci-verdict`'s
verdict loop announces each `EXPECTED` leg that is absent with a `::warning::`
workflow command, and `pages-demo` (plus the path-filtered platform legs) are
absent by design on most diffs — so most commits got a warning-level annotation
saying, in effect, "nothing is wrong". A GitHub warning annotation is the
"something to look at" signal; a path-filtered absence is the designed state.
That made "zero warnings on CI" unreachable no matter how clean the tree, and
diluted the signal for the warnings that do matter. Measured over the last 30
runs (6 unique head SHAs, 40 check runs): 55 annotations — 43 notice, 8
failure, 4 warning, all four from this one line. Two adjacent surfaces had
findings too: the workflow lint (actionlint + shellcheck over `run:` blocks)
flagged SC2034's unused loop counters in `dev-ios.yml`, and a shellcheck sweep
of the 69 shell scripts CI calls found 36 warning-grade + 1 error-grade
findings.

## Decision

Three changes, in that order. (1) `dev-ios.yml`'s two unused loop counters
become `_` — the last workflow-lint finding. (2) `ci-verdict.yml`'s
path-filtered ABSENT announcement drops from `::warning::` to `::notice::`: the
message text, the ABSENT log line and the step-summary line are unchanged, so
hazard (b) ("absent must never silently become verified") keeps its teeth —
absence is still named, per leg, on every run. The poll-read-failure
`::warning::` stays a warning: that one signals a real anomaly (API error, rate
limit) and fired on none of the last 30 runs. (3) The 37 warning/error-grade
shellcheck findings across 23 CI entry scripts are fixed minimally: dead
variables and unused loop counters removed (`for _ in`), `cd || exit 1` guards,
SC2155 declare/assign splits, POSIX dialect repairs for the `sh`-invoked
scripts (`local` dropped, `status='done'` quoted, the `ls` loop over
`$RAW/scenario` becomes a glob, and `build/build.sh`'s ios leg carries
xcodebuild's status explicitly through a temp log instead of `set -o pipefail`,
which dash does not define). The 38 info/style findings are deliberately
untouched — style is not a CI warning.

Review correction (PR #289 round 1): one of those "dead" variables was not
dead — `SPINE_PKG_DSH` in `hosts/harmony/ci/vendor-official.sh` is machine-read
by `tools/gen-staging-manifests.mjs` (`SHELL_ASSIGN('SPINE_PKG_DSH')`, fail
loud at :132); deleting it red'd CI's tools-face vitest leg (exit 2, the one
status the test rejects). It is restored byte-identical with a scoped
`# shellcheck disable=SC2034` and a comment naming the reader — SC2034's
"verify use (or export if used externally)" includes parsers that read the
script's text, and the correct silence for such an interface is a documented
disable, never deletion. Every other removed name was audited against
`SHELL_ASSIGN` readers and repo-wide greps: no other external consumer.

## Alternatives considered

- Dropping the absent legs from `EXPECTED` — lost: it guts hazard (b); the
  verdict's whole point is naming what did not run, by leg, on every run.
- Keeping `::warning::` and accepting one standing warning annotation — lost: a
  by-design absence is not "something to look at", and the repo-wide
  zero-warnings goal stays unreachable.
- Removing `pages.yml`'s path filter so the leg always runs — lost: burns
  macOS/pages minutes on every docs-only PR to silence an informational line.
- Downgrading the read-failure warning too — lost: that annotation fires only
  on a genuinely unexpected API failure; silencing it would hide the one case
  where a human should look.
- `# shellcheck disable` comments over the script findings — lost: hides real
  defects; almost every fix here hardens the script (cd guards, `${STAGE:?}`,
  explicit status propagation), which a suppression would not. The one
  exception is the machine-read interface above: there the disable IS the
  honest fix, because the "finding" is shellcheck's in-file view missing an
  out-of-file reader.

## Consequences

New commits get zero warning-level annotations from `ci-verdict`; absence
reporting is unchanged in wording and visibility. The shellcheck sweep over CI
entry scripts is clean at warning grade and above (38 info findings remain, by
choice). `build/build.sh`'s ios leg is now dash-safe without weakening failure
detection — xcodebuild's exit status propagates on every POSIX shell, with the
last 30 log lines printed on both paths. The evidence lesson from the review
round: the local `gov run` DAG does not run CI's tools-face vitest suite
(`gov.yml` "Run the tools-face vitest suite", `tools/test/run-tools-tests.sh`
— the gen-staging real-repo leg), so a shell-interface break slipped past a
green local receipt; that suite now runs locally before any CI-warnings claim.
