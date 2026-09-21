# Agent Note: the release is cut by a tag push, and a guard keeps the tag honest

Status: implemented
Related: D12, D11, D10

## Problem

Every release this pipeline attempted went through release-please's *publish*
step: merging the standing release PR made the bot create a tag and a GitHub
Release, and the `release: published` event was what built the packages.

That made an outward-facing act — shipping a release — depend on a chain of
things that report nothing when they break. Over one session the chain failed
at three different links, each invisible from the repository:

- a fine-grained PAT that authenticated and carried `contents: write` but not
  `pull requests: write`, so the action created its branch and commit and died
  at its final API call;
- a repository setting (`can_approve_pull_request_reviews`) that forbade
  `GITHUB_TOKEN` from opening a pull request at all — the failure the PAT had
  been masking;
- a `pull_request` event suppressed for `GITHUB_TOKEN`-created branch updates,
  so a release PR that was current had no checks and sat `BLOCKED`.

None of these is hard to fix once named. The problem is that all three gate the
same human intent — "ship this" — behind machinery that has nothing to do with
whether the build is good. The eventual fix for the first two was to stop
needing the credential (D11), which raised the question this note answers: if
the check has to be produced explicitly, why is the *release itself* still
waiting on the bot?

## Decision

**The tag push is the release trigger, and release-please stops at the PR.**

`git push origin vX.Y.Z` fires the three package workflows. They build their
host, create the Release for that tag if it has none (`gh release create
--verify-tag`, with the three hosts racing safely on one tag), and attach the
package. Cutting a release now needs only `contents: write` — none of the PR
permissions, PATs or suppression semantics it used to ride on.

`release/version` keeps the half of release-please that computes rather than
publishes: `skip-github-release: true` makes it keep the release PR — bumping
`version.txt`, `CHANGELOG.md` and the three host manifests, reviewed like any
other change — and never tag. The `release: published` event is deliberately
**not** a trigger, because the workflows now create Releases themselves and
that event would fire a second build of the same tag.

**The guard is the price of moving the trigger.**
`tools/release/check-tag-version.sh` runs first in every package workflow and
refuses a tag that disagrees with any of the four version files, naming every
mismatch in one run rather than one per attempt. Without it this design would
reintroduce exactly the drift D10 was adopted to prevent — and would do it
*silently*: `git tag v0.0.3` on a tree whose `version.txt` says `0.0.2` builds
cleanly and installs cleanly, with `CFBundleShortVersionString`, Android
`versionName` and `app.json5` all saying something the tag does not. Nothing
downstream compares the two.

So the trigger moves to the human and the bookkeeping does not. The bot
computes; the human decides when; the guard refuses to let the two disagree.

## Alternatives considered

**Keep `release: published` as the trigger.** Rejected: it is the bot's event,
and the whole point is to stop gating a release on the bot completing.

**Keep both triggers** so that publishing a Release by hand still builds.
Rejected, and this was the tempting one: the workflows now create the Release
themselves, so `release: published` would fire a second build of the same tag.
Two triggers for one logical release is a race, not a convenience.

**Dedupe the two triggers with a `concurrency` group keyed on the tag.**
Rejected: it makes correctness depend on cancellation semantics in order to
paper over there being two sources of truth for "a release happened".

**Drop release-please entirely and have the human maintain the version files.**
Rejected by D10 and still rejected — but its rejection is what shapes this
decision rather than merely forbidding it. A hand-cut release reintroduces the
drift the `commit-format` gate exists to catch, so the bot keeps the mechanical
half and the guard enforces agreement. Removing the bot would have been the
simpler-looking change, and it would have traded one silent failure for
another.

**Trigger on the tag with no guard.** Rejected: a human-chosen tag over
machine-written version files is precisely the drift this design can introduce,
and it fails silently in the one place nobody looks — the version the installed
app reports.
