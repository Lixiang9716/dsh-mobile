# Agent Note: the platform E2E legs get an always-running aggregator verdict

Status: implemented
Related: D13, D14

## Problem

`main` requires exactly one context, `gates`, and that is the only status check it
requires. The three platform pipelines — `dev/ios.yml`, `dev/android.yml`,
`dev/harmonyos.yml` — are **path-filtered**, so a docs-only PR triggers none of
them. Requiring any of them today would leave the required check "expected" and
block the merge forever: the platform legs are not required precisely because
they sometimes do not run.

The consequence is the wrong way round. The legs that prove a host actually
boots (`m1.spike.boot`, `m1.carrier.loopback`, the emulator E2E) are the ones
that cannot block, while the gate that always runs (`gov run`) checks no device
at all. AGENTS.md's principle — tests default to blocking, demotion needs
justification — was inverted here by an accident of trigger configuration
rather than by a decision, and nothing recorded that the demotion had happened.

## Decision

**`.github/workflows/ci-verdict.yml` ships an always-running aggregator: one job,
`ci-verdict`, path-less, whose verdict is derived from the checks that exist on
the pull request's HEAD commit.**

It reads `commits/$SHA/check-runs` (paginated, for the PR's head SHA, with
`checks: read` / `contents: read` / `pull-requests: read` and `GH_REPO` set —
this job checks nothing out, on purpose). The verdict rules:

- every one of `gates`, `ios-e2e`, `android-e2e`, `harmonyos-build` that **exists**
  on the SHA must be complete and `success` / `skipped` / `neutral`; any other
  completed conclusion (`failure`, `cancelled`, `timed_out`, `action_required`,
  `stale`) is a FAIL naming the check and the conclusion;
- a check still incomplete when the deadline passes is a FAIL naming it and the
  state it was in — a hung platform leg must not walk away with a green
  aggregator;
- a check that is **absent** is printed by name as `ABSENT … not a failure, and
  NOT a verification`, and emits a `::warning::`. It is never a failure (that
  would re-create the wedge the aggregator exists to remove) and never a pass
  (that would silently convert "not run" into "verified");
- `ci-verdict` is deliberately not in its own expected list: it is `in_progress`
  while it judges.

Two numbers are measured rather than guessed. The poll is 30 s — a condition
with a deadline, never a blind pause (rules.md rule 8). The deadline is **70
minutes**, because the legs' own job timeouts are 30/30/40 minutes and measured
PR-event runs land between 1.5 and 11 minutes plus queue time: a 25-minute
deadline would be *shorter than a leg is allowed to run*, so a legal slow run
would red the aggregator — the "flaky aggregator wedges every merge" hazard in
its most likely form. 70 min is longer than every leg's own timeout, which is
what makes the aggregator the backstop for a leg that never reports at all; the
job's own `timeout-minutes: 85` bounds the aggregator even if its poll loop
wedges. Absence gets a **120 s settling window** measured from the first poll
that could see any expected check (or from the start if nothing was ever seen):
a check run is registered seconds after the PR event fires, so an immediate
"absent" would misread a not-yet-registered leg as path-filtered-out.

Three smaller properties matter as much as the rules:

- **an unreadable check set is a failure.** A `gh api` error, a rate limit, or a
  read that returns zero rows does not decide anything — the deadline does — and
  if no usable read ever happens the verdict is FAIL. `ci-verdict`'s own check
  run exists on the SHA while it judges, so zero rows means the read is wrong,
  and "nothing exists, nothing is wrong" is exactly the silent green this job
  forbids. (The locally exercised version of the logic *did* pass an empty read
  as a green verdict before this guard; the harness caught it.)
- **the latest run per check name wins**, so a green re-run supersedes its own
  failed predecessor on the same SHA (branch protection's own semantics).
- **the aggregator does no work**: no checkout, no toolchain, one read-only API
  call per poll, transient errors retried inside the loop. Its own failure
  surface is what keeps it from becoming the repository's new single point of
  wedging, and its recovery path is a plain job re-run.

The head-SHA query is measured, not assumed: on PR #122's head commit the
check-runs API returns `gates` and `ios-e2e` (both `completed success`) and
nothing else — android and harmonyos were path-filtered out of that PR. That is
exactly the present/absent split the verdict is built on.

**Branch protection is not touched.** `ci-verdict` is not a required check yet;
making it one is the owner's decision, and the exact `gh api` call is in the PR
body. Landed in this state the workflow is inert beyond producing the check.

Why this can satisfy D13 at all: D13's finding is that branch protection accepts
a check only from the pull request's **own event flow**, and refused a
`workflow_dispatch`ed run even when it landed on the exact head SHA with the
right context. A `pull_request`-triggered aggregator is *inside* that flow, so
this is the one shape of "check produced outside the gated workflow" that D13
does not rule out — and the release PR case that motivated D13 is gone with D14,
which routes the version bump through an ordinary PR.

## Alternatives considered

**The 25-minute deadline the brief suggested as an example.** Rejected on
measurement, not on taste: `dev-android.yml`'s own `timeout-minutes` is 40, so a
25-minute aggregator deadline would fail a run GitHub itself still considers
alive and healthy. That is a red check on a green platform run — the flake class
that teaches people to ignore red, and the hazard the aggregator must not
introduce. The condition being waited on is "the legs have decided"; the clock
is only the bound, so the bound is set above the longest legal leg.

**Treating an absent check as a failure.** Rejected: absence is not evidence of
breakage, it is evidence of a path filter, and failing on it would make every
docs-only PR red until someone re-ran three platform pipelines. It would also
just re-import the wedge the aggregator exists to remove — the legs are
unrequired *because* absence is legitimate.

**Treating a still-running check as a pass, or ignoring it.** Rejected: "not yet
decided" is not "verified", and a hung macOS leg would then silently pass. The
deadline plus a named failure is the only honest reading.

**Judging every check run on the SHA rather than the four named lanes.**
Rejected: the aggregator's own run is `in_progress` while it judges (it would
wait on itself forever), and any third-party or stale check would gain the power
to wedge every merge in the repository. Checks outside the four are printed for
the operator and not judged.

**Keeping the legs unrequired and instead removing the path filters** (so all
three always run) **or requiring them with a `paths:` exception.** Rejected: the
release pipelines in this repo already show what always-running platform work
costs, and macOS minutes bill at 10x. A docs-only PR would buy three pipelines
it cannot affect. The aggregator is the cheap direction: the always-running part
is 2 seconds of `gh api`.

**`gh pr checks --watch`.** Rejected: it exits non-zero on any pending check,
prints only the PR's rollup, and cannot distinguish "absent because a path
filter said so" from "absent because nothing registered" — which is the entire
question. It would also make the verdict a function of `gh`'s exit code rather
than of a stated rule.

**A script under `tools/` holding the verdict logic, called by the workflow.**
Rejected *for this change* because this change owns exactly one file. The logic
is instead extracted verbatim from the YAML and exercised locally: nine cases
and 46 assertions over synthetic check-run pages — all-green, one-failed,
one-absent, still-running-past-deadline, a leg unregistered at poll 1 that
appears at poll 2, a failing older run plus a green re-run, an unreadable check
set, an empty one, and a real captured payload through the workflow's own `jq`
filter. The honest cost of the one-file constraint is that the harness lives in
the PR body rather than in the repository.

**A merge queue / `merge_group`.** Rejected: D13 refused changing the merge
model to work around one check's provenance, and nothing here needs it.

**What is *not* proven here.** A `pull_request`-triggered workflow cannot be
exercised without opening a PR, so the evidence is: the workflow parses
(`ruby -ryaml`), the script is syntax-clean (`bash -n`), and the extracted
verdict logic passes the nine cases above. The first run on a real PR is the
remaining proof, and it is the reason the failed-path annotations name the SHA
and the check they judged.
