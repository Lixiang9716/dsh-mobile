# Decisions

The project's decision log: one entry per settled decision, numbered D0,
D1, … contiguously. Allocate numbers with `gov decision next` (it checks
the branch base for collisions), append with `gov decision add`, and
never renumber or reuse a row — decisions are addresses, not prose.

Every entry records what the decision BEAT under its Alternatives
heading; a decision without its alternatives invites re-litigation,
which is the exact failure this log exists to prevent.
`gov decision verify` checks numbering, the alternatives record, and
orphaned references; `gov recall` searches these entries.

## D0 — Adopt the govrail governance plane

- **Decision**: gates + notes + receipts as the working discipline
- **Alternatives**: prose-only agent rules (not checkable); ad-hoc conventions (drift silently)

## D1 — quickjs-ng as the mobile JS engine

- **Decision**: quickjs-ng (pure-C interpreter) carries the Harness core; nodejs-mobile rejected
- **Alternatives**: nodejs-mobile (V8: an order of magnitude more memory, JIT gray zones, no multi-runtime isolation)

## D2 — single-threaded coroutines replace subprocesses

- **Decision**: tool execution re-implemented in-process as coroutines behind `ctx.subprocess`
- **Alternatives**: requiring real subprocesses (physically refused on iOS); worker threads (defeats single-runtime auditability)

## D3 — UI is a Web Client plugin rendered in WKWebView

- **Decision**: official React UI is the default Web Client plugin; mobile-ui is another
- **Alternatives**: native-only UI (loses the official frontend and slot ecosystem); React Native rewrite (heavy, diverges from upstream web)

## D4 — distribution outside the App Store

- **Decision**: open-source, self-signed/TrollStore/EU channels
- **Alternatives**: App Store (guideline 2.5.2 bans downloaded code — a plugin ecosystem cannot pass); TestFlight (same review)

## D5 — contract first

- **Decision**: `contract/` (primitives + data protocols) frozen before any implementation
- **Alternatives**: code-first, freeze later (AI-era rework cost; four platforms drift before the地基 exists)

## D6 — pinned upstream + outboard implementation packages

- **Decision**: upstream DSH pinned (manifest), adaptations live in `system-plugins/`, never in vendored edits — same discipline applied to govrail itself in CI
- **Alternatives**: tracking upstream main (lineage breakage at 0.1.x velocity); wholesale fork (permanent merge debt)

## D7 — checkpoint as roaming

- **Decision**: checkpoint format shared across hosts; background suspension becomes cross-device handoff
- **Alternatives**: demanding background residency (physically refused by iOS); no persistence (tasks die at lock screen)

## D8 — all modules event-driven, including streaming

- **Decision**: inter-module communication is events or explicit async interfaces; LLM token streams are event pipelines; checkpoint = event queue drained
- **Alternatives**: direct module calls + blocking whole-result APIs (couples components, kills substitutability); polling (wasted battery, races)

## D9 — Port upstream DSH packages as verbatim plugins; never reimplement Harness behavior in-house

- **Decision**: product-carrying upstream packages (agent-loop, session, session-projection, llm, settings, cordis runners) are vendored VERBATIM (pinned tarball + sha256 + PROVENANCE, the ensure.sh pattern) and driven through adapter plugins: system plugins implement the upstream service contracts (fs / subprocess Service / ui) over the 9 gateway primitives, a transport seam maps upstream fetch onto httpFetch, and the runtime boot constructs the upstream runner with those services. In-house code is glue only (shims, adapters, scenarios) — never product behavior.

## Alternatives

- In-house reimplementation of the Harness flow on QuickJS (what the first overnight iteration drifted into: a self-authored mini agent-loop + mock LLM + in-house session flow): rejected — forks product behavior from upstream, guarantees divergence at 0.1.x velocity, and contributes none of the mobile constraints back to the ecosystem; the host would own a second Brain.
- Full nodejs-mobile to run upstream unshimmed: rejected — D1 already beat it (memory footprint an order of magnitude higher, JIT gray zones, no multi-runtime isolation); the shim surface is small and measured (ARCHITECTURE.md §3).
- Pin-and-fork upstream (vendor once, edit locally): rejected — D6's lineage discipline; verbatim + shims keeps re-pins cheap and upstream improvements flowing.

## D10 — Release-please drives the version stream

- **Decision**: one repository-wide semver version, derived from the conventional commits the `commit-format` gate already enforces. release-please keeps a standing release PR that bumps `version.txt`, writes `CHANGELOG.md` and syncs the three host manifests through `extra-files` (XML+xpath for `Info.plist`, the generic annotation for `build.gradle.kts`, JSON+jsonpath for `app.json5`); merging it tags `vX.Y.Z` and `release/packages` attaches the three host builds to that Release. The bot PR needs `RELEASE_PLEASE_TOKEN` (PAT or GitHub App token) because events created by `GITHUB_TOKEN` do not trigger workflows, so a `GITHUB_TOKEN` release PR would never receive the `gates` check that `main` requires.
- **Alternatives**:
  - Per-host version streams (three independent numbers): rejected — the three hosts ship together in ONE `release.yml` run, so three numbers mean three PRs and three changelogs for one build set; the drift already present (iOS `0.1.0` / Android `0.1.0-spike` / HarmonyOS `1.0.0`) is the manual alternative failing in place.
  - Hand-maintained versions plus `gh release create`: rejected — rule 1's standard is that a promise a command can check is a gate; a hand-cut release reintroduces exactly the drift the `commit-format` gate was adopted to prevent, and nothing would catch a forgotten host bump.
  - `skip-github-pull-request: true` (a PAT-free tagging mode): rejected — it tags HEAD without ever moving the version files, so the version source of truth does not advance and the next run computes the same tag again.
  - Admin-bypass merging of a `GITHUB_TOKEN` release PR: rejected as the default — it makes the bypass routine, contradicting AGENTS.md's "reserved for deliberate direct landings, not a default".

## D11 — Release-please authenticates with GITHUB_TOKEN; the repository must permit it to open PRs

- **Decision**: supersedes D10's `RELEASE_PLEASE_TOKEN` clause. release-please runs with `secrets.GITHUB_TOKEN`, and the required repository setting **"Allow GitHub Actions to create and approve pull requests"** (`can_approve_pull_request_reviews`) is ON — without it `POST /pulls` is refused outright with *"GitHub Actions is not permitted to create or approve pull requests"*, which is the failure the PAT had been masking. **That setting plus one explicit dispatch is the whole mechanism, and both halves are load-bearing.** The setting lets `GITHUB_TOKEN` open the PR; the dispatch supplies the check. The suppression rule that D10 reasoned about is real but *partial*, and the measurement is what settles it: on PR #107 the release PR's **first** creation did start its `pull_request` workflows (`gov` plus all three platform pipelines, all green, PR `CLEAN`), while a later **branch update** from an ordinary `push: main` run produced a suppressed run (`action_required`) and **no checks at all** — PR `BLOCKED`. The release branch is rewritten on every push to `main`, so the PR event cannot be the source of the required check. `workflow_dispatch` is a documented exception to the suppression, so the last step of `release/version` **dispatches the `gov` workflow at the release branch** (`.github/workflows/gov.yml` gains `workflow_dispatch`; the step runs `gh workflow run gov.yml --ref <release-branch>` and fails loud if refused). Its `gates` check lands on the same commit `main` protection asks about — a real gate run on the real commit, never a check fabricated through the Checks API. The `RELEASE_PLEASE_TOKEN` secret is no longer read by any workflow; it is left in place, unread. The release pipeline's workflows are named by stage and host (`release/version` prepares; `release/ios`, `release/android`, `release/harmony` package), mirroring `dev/ios`, `dev/android`, `dev/harmonyos`.
- **Alternatives**:
  - Keep the fine-grained PAT (`RELEASE_PLEASE_TOKEN`) and add `pull requests: write`: rejected — it makes the pipeline depend on a credential that fails in a way nothing local can detect. The failure it produced is instructive: the PAT authenticated, carried `contents: write`, let the action create its branch and commit, and died only at its final `POST /pulls`, so the version stream was dead for days while every visible signal looked healthy. A credential the workflow does not need cannot be misconfigured, and the repository setting it was masking is discoverable and named by the error it produces.
  - `GITHUB_TOKEN` plus admin-bypass merging: rejected by D10 already, and still rejected — it makes the bypass the routine path for every release.
  - `skip-github-pull-request: true`: rejected by D10 already, and still rejected — it tags HEAD without moving the version files, so the version source of truth does not advance.
  - Rely on the `pull_request` event alone and drop the dispatch: rejected on measurement, not on caution — the PR's first creation did get its checks from the PR event, but a branch update from an ordinary push to `main` produced `action_required` and no checks, so the required `gates` check would be absent exactly when the PR is current. The dispatch costs one ~20s run and is the only path whose behaviour does not depend on suppression semantics.
  - Put the PAT into a step output and pass it to the action, falling back to `GITHUB_TOKEN` when it cannot open pull requests: rejected — two credential paths whose PAT branch cannot be exercised from here, so half of it would ship untested.
  - Dispatch by check-run API instead of running the gates: rejected outright — a green check that did not run the gates is exactly the vacuous-check failure rules.md rule 6 exists to prevent.

## D12 — The release is triggered by the tag push, and the bot stops at the release PR

- **Decision**: supersedes D10's and D11's assumption that merging the release PR cuts the release. The three package workflows (`release/ios`, `release/android`, `release/harmony`) are triggered by **a `v*` tag push** — `git push origin vX.Y.Z` — and by nothing else automatic. `release/version` keeps only the half of release-please that computes rather than publishes: `skip-github-release: true` makes it stop at the release PR, so it never tags and never publishes; merging that PR advances `version.txt`, `CHANGELOG.md` and the three host manifests on `main`, and the human's tag push is what builds. Each package workflow **creates the Release for its tag when none exists** (`gh release create --verify-tag`, racing three hosts safely), then attaches its package. The `release: published` event is deliberately **not** a trigger: the workflows now create Releases themselves, so listening to that event would fire a second build of the same tag. `tools/release/check-tag-version.sh` runs first in every package workflow and refuses a tag that disagrees with any of the four version files, naming every mismatch at once. Cutting a release now needs only `contents: write` — none of the PR permissions, PATs or suppression semantics the package path never used.
- **Alternatives**:
  - Keep the release cut by release-please and triggered by `release: published`: rejected — it couples the release to the bot completing, which is the exact failure mode this pipeline spent days in. A token that could not open a pull request, a repository setting that forbade it, an event suppressed for `GITHUB_TOKEN`: each one stopped the release at a step that reported nothing, and each was invisible from the repository. A tag is a gesture a human makes deliberately and can retry, and the package path is the part with no moving credential.
  - Keep `release: published` **as well**, so publishing a Release by hand still builds: rejected — the package workflows now create the Release on a tag push, so that event would fire again for the same tag and build everything twice. Two triggers for one logical release is a race, not a convenience.
  - Dedupe the two triggers with a `concurrency` group keyed on the tag: rejected — it makes correctness depend on cancellation semantics to paper over there being two sources of truth for "a release happened". Better to have one trigger.
  - Have the human maintain the version files and tag by hand (release-please removed entirely): rejected by D10 already, and still rejected, but the reason is what shapes this decision — a hand-cut release reintroduces exactly the drift the `commit-format` gate exists to prevent. So the bot keeps the mechanical half (version computation and changelog, reviewed in a PR) and `check-tag-version.sh` enforces that the human's tag agrees with it. The trigger moves to the human; the bookkeeping does not.
  - Trigger on tag push with no version guard: rejected — a human-chosen tag with machine-written version files is precisely the drift this design could introduce, and it would be silent: the app installs fine under the wrong number and nothing downstream compares the two. The guard is the price of moving the trigger, and it fails before anything builds.
