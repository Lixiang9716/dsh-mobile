# Agent Note: the version bump is a normal PR, and release-please is retired

Status: implemented
Related: D14, D13, D12, D10

## Problem

D10 chose release-please to keep a standing release PR: it read the
conventional commits, computed the next version, wrote the changelog and bumped
the four version files, and merging that PR cut the release. That worked as a
plan and never worked in practice, because the PR it opened was authored by the
bot — and a release PR opened with `GITHUB_TOKEN` cannot receive the `gates`
check that `main` requires.

D13 established why, with a measurement: the PR's own `pull_request` workflows
arrive as `action_required`, and a check produced by a `workflow_dispatch` run
does not satisfy branch protection either — on PR #111 a green `gates` check sat
on the release PR's exact head SHA, with the right context and app and its suite
linked to the PR, and the PR stayed `BLOCKED` with an empty check rollup.
Protection honours only checks from the pull request's own event flow, so
**D10's original PAT requirement was right**, and removing the PAT (D11) traded
a credential problem for a mergeability problem.

That left the question D13 named and did not answer: who authors the bump.

## Decision

**A person or an agent does, on an ordinary branch.**

`tools/release/bump-version.py X.Y.Z` rewrites all four version files and
prepends the release's `CHANGELOG.md` section, built from the conventional
commits since the last tag. It prints the version those commits imply as a hint
— a `feat` or a breaking change bumps the minor below 1.0, a `fix` the patch —
and a person decides; it refuses a partially-applied bump *before* writing
anything (an exact-match assertion per file, not one-per-run), and re-reads
every file it writes. The pull request carrying it is ordinary, so it receives
the required check the ordinary way. That is the whole point: the fix for "the
bot's PR cannot get a check" is a PR that is not the bot's.

`release-please` is removed — workflow, `release-please-config.json`,
`.release-please-manifest.json`, and the Android `// x-release-please-version`
annotation that only it read. `version.txt` stays the source of truth;
`tools/release/check-tag-version.sh` still refuses a tag that disagrees with any
of the four files; the release itself is still the tag push (D12) and still
needs nothing but `contents: write`.

Measured before landing, in a throwaway worktree: `bump-version.py 0.1.0`
derived `0.1.0` from 14 commits (correctly — a `feat` is present), wrote all
four files, produced a correct `CHANGELOG.md` grouped into Features / Bug Fixes
/ Other Changes, and left `check-tag-version.sh v0.1.0` green while
`check-tag-version.sh v0.0.1` still failed naming every mismatch.

## Alternatives considered

**Keep release-please and give it a user-attributed token.** This is what D10
prescribed and it genuinely works, so it was the real contender. Rejected
because it reintroduces precisely the dependency D12 removed — a long-lived
credential whose failure mode is invisible from the repository — in order to
save one command. The bot's actual contribution, once changelog generation
moves into the script, is computing a version from commit types; that is a
hint, and it is now a hint a human confirms in the same second they read it.

**Keep release-please and merge its PR with admin bypass.** D10 refused it and
it stays refused: a bypass that is always taken is not a gate.

**Keep release-please with both `skip-github-pull-request` and
`skip-github-release`.** A workflow that does nothing, occupying a schedule and
a cache for no effect.

**Hand-edit the four version files with no script.** Rejected: three formats,
one of them JSON5, and a missed file is invisible until the tag guard rejects
it. The guard makes it loud — but a script that cannot miss a file beats a guard
that catches the miss, and the guard stays for the tag itself.

**Let `bump-version.py` pick the version and apply it.** Rejected: the
conventional-commit derivation is a good hint and a bad authority. The release
number is the one part of this a person should own, so the script suggests and
a human decides in the same command.
