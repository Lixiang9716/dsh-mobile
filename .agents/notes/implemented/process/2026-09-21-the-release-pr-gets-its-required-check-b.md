# Agent Note: the release PR gets its required check by dispatch, so no PAT is needed

Status: implemented
Related: D11, D10

## Problem

`release/please` had been red on every push to `main` for days, and the
version stream was dead: `v0.0.2` could not even be proposed. The proximate
cause was a credential — a fine-grained PAT that authenticated, carried
`contents: write`, let release-please create its release branch and commit,
and then died at its final `POST /pulls` with `Resource not accessible by
personal access token`.

The first repair (PR #105) made that failure legible rather than silent: a
third pre-flight probe submitted the write itself (`POST /pulls` with an empty
body — a validation error that creates nothing) and failed loud with the
missing permission named. Verified live on run `35597056914`, where GitHub's
own `X-Accepted-GitHub-Permissions: pull_requests=write` header confirmed the
diagnosis.

That repair left the pipeline **still broken**, one web-UI click away from
working: it told the operator to add `pull requests: write` to the PAT at
github.com. A pipeline that stays dead until someone remembers a settings page
is not fixed, and the underlying question had not been asked — *why does this
workflow need a credential at all?*

The answer was one sentence of GitHub's rules: `GITHUB_TOKEN`-created events do
not trigger workflows, and `main` requires the `gates` check. That is the
entire reason for the PAT.

## Decision

**The workflow needs no PAT: it produces the required check itself, by
dispatching the gate workflow.**

`workflow_dispatch` is a documented *exception* to that suppression, so
`.github/workflows/gov.yml` gains a `workflow_dispatch` trigger, and the last
step of `release/please` runs `gh workflow run gov.yml --ref <release-branch>`.
The dispatched run executes the gates on the release branch and reports the
`gates` check on the release PR's own head commit — the exact context, from
the exact app (`15368`), that `main` protection requires, and a real gate run
rather than a check fabricated through the Checks API. `actions: write` is
added to the workflow's permissions; a refused dispatch fails the job, so a
release PR that cannot be merged announces itself.

The PAT path, its three probes, and the `RELEASE_PLEASE_TOKEN` requirement are
removed. The secret is left in place, unread. `docs/release.md` and
`docs/release.zh.md` document the one remaining prerequisite, which is a
repository setting rather than a credential.

**One thing had to be measured rather than predicted, and the prediction was
wrong.** Removing the PAT exposed the failure it had been masking: with
`GITHUB_TOKEN` the action reached its final API call and was refused with
*"GitHub Actions is not permitted to create or approve pull requests"*. The
repository setting that lifts this, **"Allow GitHub Actions to create and
approve pull requests"** (`can_approve_pull_request_reviews`), was off; it was
enabled through the API. It is the operative fix.

This note originally claimed — and D11 with it — that without a PAT the three
platform pipelines would not run on the release PR. That is false, and the
measurement says so: on PR #107, `gov` and all three platform pipelines
(`dev/ios`, `dev/android`, `dev/harmonyos`) reported green checks from
`pull_request` events, and the PR reached `CLEAN` and mergeable with no
operator intervention. The dispatch is therefore a **guarantee, not the
mechanism**: it costs one ~20s run and makes the single check `main` requires
independent of the PR-event path, which is why it stays.

That step also needed a fix once it ran for real. The job never checks anything
out — release-please does not need a working tree — so `gh` could not resolve
the repository and the step died with `fatal: not a git repository`. It now
passes `GH_REPO: ${{ github.repository }}` rather than cloning the repository
for a single API call. Worth recording because the first version of the step
was written from the local test, which happened to run inside a git checkout.

Before any of this, the release path was measured rather than assumed: a
release-please-shaped commit (version bump across `version.txt`, `CHANGELOG.md`
and the three host manifests, under the generated `chore(main): release X.Y.Z`
message) was built on a scratch branch and run through the full DAG — **8
gates, 8 pass**. The `note-presence` gate, which looked like the obvious
blocker for a mechanical release commit, is advisory (`gov note presence`
exits 0 with "advisory; --strict to enforce"), so the PR flow was already
viable and only the credential was in the way.

## Alternatives considered

**Keep the PAT and add `pull requests: write`.** This was the first repair's
recommendation, and it is rejected on the evidence that produced it: a
credential that fails in a way nothing local can detect. Every visible signal
said healthy — the token authenticated, the branch and commit were created —
and the only symptom was the step that mattered failing. The repo paid that
cost once; a credential the workflow does not need cannot be misconfigured.
Keeping the probes and the PAT as a *fallback* was also rejected: it means two
credential paths, and the PAT branch cannot be exercised from here, so half of
it would ship untested.

**`skip-github-pull-request: true`.** Already rejected in D10 and still
rejected: it tags HEAD without moving the version files, so the version source
of truth does not advance and the next run computes the same tag.

**`GITHUB_TOKEN` plus admin-bypass merging.** Already rejected in D10 and still
rejected: it makes the bypass the routine path for every release, which is
what AGENTS.md says the bypass is not for.

**Dispatch by creating a check run through the Checks API.** Rejected outright,
and worth naming because it would have been easy: `GITHUB_TOKEN` belongs to the
Actions app, so a `POST /check-runs` with the name `gates` would satisfy branch
protection exactly as well as a real run does. It would also be a green check
that never ran the gates — the vacuous-check failure rules.md rule 6 exists to
prevent.

**Amend D10 instead of adding D11.** Rejected: decisions are addresses, not
prose, and D10's alternatives are what made this choice checkable — its
rejection of `skip-github-pull-request` and of admin-bypass ruled out both
shortcuts before any code was written. Rewriting the entry would have destroyed
the reasoning that constrained the new one.
