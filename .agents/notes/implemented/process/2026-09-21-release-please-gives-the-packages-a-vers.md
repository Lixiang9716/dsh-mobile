# Agent Note: release-please gives the packages a version stream and the releases their builds

Status: implemented
Related: D10

## Problem

The repository could build its three host apps but could not name what it
built. `release/packages` was dispatch-only, so a "release" was a set of
workflow artifacts under a run — unaddressable, and expiring with the run —
while nothing anywhere carried a version: no tag, no GitHub Release, no
CHANGELOG, no version file. The three hosts had already drifted apart on their
own (iOS `CFBundleShortVersionString` `0.1.0`, Android `versionName`
`0.1.0-spike`, HarmonyOS `versionName` `1.0.0`), which is what hand-maintained
versions do when nothing derives them.

The input release-please needs was, unusually, already in place: every commit
is a conventional commit, enforced by the `commit-format` gate
(`tools/check-commit.py`) — 97 commits at the time of writing, zero exceptions.
What was missing was everything downstream of that.

## Decision

One version for the whole repository, derived from the commits that already
land, and attached builds.

`release-please-config.json` + `.release-please-manifest.json` + `version.txt`
sit at the repository root (never under `.gov/`, which is inside the
plane seal's tamper-evidence scope). The `simple` strategy owns `version.txt`
and `CHANGELOG.md`; the three host manifests are synced by `extra-files`:

| Host | File | Updater | Why that one |
| --- | --- | --- | --- |
| iOS | `hosts/ios/App/Info.plist` | `xml` + an xpath predicate | release-please ships no `plist` updater; the predicate rewrites a clean plist, so no annotation enters the source file |
| Android | `hosts/android/app/build.gradle.kts` | `generic` + `// x-release-please-version` | no Kotlin/Gradle updater exists; the annotation replaces the semver on its line and drops the `-spike` suffix with it |
| HarmonyOS | `hosts/harmony/AppScope/app.json5` | `json` + `jsonpath` | the file is valid JSON but the `.json5` extension is not auto-detected, so the type must be explicit or the updater silently matches nothing |

`.github/workflows/release-please.yml` runs on push to `main` and keeps one
standing release PR. It requires a `RELEASE_PLEASE_TOKEN` secret (fine-grained
PAT or GitHub App installation token) and **fails loud** when it is absent,
because `GITHUB_TOKEN`-created events do not trigger workflows: a release PR
opened with it would never receive the `gates` check that `main` requires, so
it could never be merged. Degrading to that token silently would have produced
a pipeline that looks wired and cannot complete a single release.

`release.yml` gained a second trigger (`release: published`). On that path the
three user-facing packages build and are attached to the release as assets via
`gh release upload`, so a tag is a downloadable build set. The harness
packages are guarded explicitly (`github.event_name == 'workflow_dispatch' &&
inputs.include_harness`) rather than relying on `inputs` being empty outside a
dispatch — an accident that would have been true but unexplained.

Build numbers stay hand-set on purpose: `CFBundleVersion`, the Android
`versionCode` and the HarmonyOS `versionCode` are monotonic integers, which
semver cannot express. The `x-release-please-major|minor|patch` annotations
substitute a single integer each and cannot compose `major*10000+minor*100`, so
routing them through this stream would have been a lie.

`bootstrap-sha` is pinned to the commit this landed on, so the first release
does not digest 97 commits of internal churn into a changelog; the stream
starts from the next releasable commit.

Behaviour was proven before wiring by driving release-please's own updater
classes (and its `extra-files` dispatch, read from
`strategies/base.js`) against the real repository files offline — all three
host files plus `version.txt` reach the next version, and the config validates
against release-please's shipped JSON schema.

## Alternatives considered

- **Per-host version streams.** Rejected: the three hosts ship together in one
  `release.yml` run, so three numbers mean three PRs and three changelogs for a
  single build set — and the drift already present in the tree is that
  alternative failing in place.
- **Hand-maintained versions plus `gh release create`.** Rejected: rule 1's
  standard is that a promise a command can check is a gate. A hand-cut release
  reintroduces exactly the drift `commit-format` was adopted to prevent, with
  nothing to catch a forgotten host bump.
- **`skip-github-pull-request: true` (the PAT-free tagging mode).** Rejected:
  it creates the tag at HEAD without ever moving the version files, so the
  version source of truth never advances and the next run recomputes the same
  tag. Viable only where something else owns the bump.
- **Admin-bypass merging of a `GITHUB_TOKEN` release PR.** Rejected as the
  default: it works, but it makes the bypass routine, contradicting AGENTS.md's
  "reserved for deliberate direct landings, not a default".

## Consequences

`main` now carries two release-shaped surfaces: `release/please` (the version
stream) and `release/packages` (the builds). A release is a merge of a
generated PR, so the changelog is the only part a human has to actually read.

Two follow-ups are deliberately left open and are visible rather than papered
over: the first release change normalises the three hosts to one number (that
is where the existing `1.0.0` / `0.1.0-spike` drift disappears), and the
`RELEASE_PLEASE_TOKEN` secret is an owner-side action — until it exists, the
workflow is red by design, and the first release (`v0.0.1`) is therefore cut by
hand rather than by the bot.
