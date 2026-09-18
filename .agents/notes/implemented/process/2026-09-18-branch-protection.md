# Agent Note: main branch protection with required PR flow

Status: implemented

## Problem

Direct pushes to main bypassed every gate by construction: pre-push hooks run on the pusher's
machine and CI ran after landing. One forgotten hook (or one `--no-verify`) meant ungoverned
code on the main branch with no way to retroactively gate it.

## Decision

`main` is now protected via the GitHub API: pull requests are required (0 approving reviews —
the gate is the CI run, not peer approval), the `gov` check is a required status check, force
pushes and branch deletion are refused, and `enforce_admins` stays **false** so the owner keeps
an explicit bypass for deliberate direct landings (documented exception, not an accident).

## Alternatives considered

- **enforce_admins true**: maximally strict, but the owner is currently the only committer and
  must retain a deliberate escape hatch for hotfixes; revisit if collaborators arrive.
- **Required approving review ≥ 1**: self-review is theater in a single-committer repo; the
  govr gate DAG is the reviewer that matters. Revisit with the first external contributor.

## Consequences

Every change now lands through a PR whose `gov` check must pass — the pre-push hook becomes a
convenience, and CI becomes the enforcement point. Future agent workflows should branch, push,
open a PR, wait for `gov`, and merge.
