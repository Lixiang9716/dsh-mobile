# Agent Note: ci-verdict becomes the second required status check on main

Status: implemented
Related: D13, PR #124 (the aggregator's design note), T-0033 (its last open item)

## Problem

`main` required exactly one status check — `gates`. The three platform E2E
pipelines are path-filtered, so a docs-only PR triggers none of them, and naming
a path-filtered check as required leaves it "expected" forever: the merge stays
blocked on a check that will never report. That inversion is why the legs that
prove a host actually boots could not block anything. PR #124 closed the
mechanism half of the gap with `.github/workflows/ci-verdict.yml` — a path-less
aggregator whose verdict is "every check run that exists on this commit is
green", with absent legs named as absent — and left the protection half, the
owner action, un-run. T-0033 carried that item since 2026-09-21; the platform
legs still could not block a merge.

## Decision

`ci-verdict` is now a required status check on `main`, alongside `gates`, with
the GitHub Actions app pinned (`app_id: 15368`) exactly as `gates` already was.
`strict` stays `false` — the branch is not required to be up to date, unchanged
from before. Every other protection field is byte-identical: the whole-object
GET before/after diff names exactly two changed fields
(`required_status_checks.checks` and `.contexts`), both being the required-set
addition itself (evidence: `protection-before-after.diff`).

The endpoint from PR #124's recorded command —
`PUT .../branches/main/protection/required_status_checks`, the sub-endpoint that
replaces only the required set — returns **404 on this credential** while its
own GET succeeds (`required-status-checks-put-subendpoint-404.json`; the token
is the gh CLI OAuth token with `repo` scope, admin on the repo). The landing
route is the ask's general method instead: GET the whole
`branches/main/protection` object, add the one context, PUT the whole object
back. One intermediate finding worth keeping: that PUT rejects object-shaped
flags — `{"enabled": false}` is refused with a 422 anyOf validation error and
**mutates nothing**; the endpoint takes plain booleans for
`enforce_admins`, `required_linear_history`, `allow_force_pushes`,
`allow_deletions`, `block_creations`, `required_conversation_resolution`,
`lock_branch`, `allow_fork_syncing`, and does not take `required_signatures` at
all (it is already false; its own sub-endpoints own it). The rejected first body
is kept as `protection-put-body.attempt1-rejected-422.json`.

The check context name is verified live: `gh run list --workflow=ci-verdict.yml`
shows the check reporting as exactly `ci-verdict` on every recent PR including
docs-only ones, success on the landed ones (`ci-verdict-recent-runs.txt`) — so
the required check is one that always runs, never one that stays "expected".

Evidence set (this note's `.evidence/` directory): `protection-before.json`
(GET before), `protection-put-body.json` (the exact accepted PUT body),
`protection-put-response.json` (the PUT response), `protection-after.json`
(GET after), `required-status-checks-readback.json` (the independent sub-endpoint
read-back: `strict=false`, checks `gates@15368` + `ci-verdict@15368`),
`protection-before-after.diff` (two changed fields, both the addition).

## Alternatives considered

- PR #124's sub-endpoint PUT (`PUT .../protection/required_status_checks`):
  preferred — least invasive, replaces only the required set — but it 404s on
  the gh CLI OAuth credential while its GET works, so it is unrunnable here
  without a different token class. Recorded, not silently swapped.
- The settings web UI (the owner's 2026-09-29 plan per the T-0033 repin note):
  lost — it leaves no machine-checkable evidence of the before state, and the
  API route lets the diff prove "nothing else changed".
- A ruleset instead of classic branch protection: not needed — classic
  protection exists on `main` and the ask was to extend it in place; introducing
  a ruleset would migrate the whole protection surface for one context.
- Making the three platform legs required directly: still wrong for the same
  path-filter reason PR #124 records; the aggregator remains the one shape that
  can block without wedging docs-only PRs.
