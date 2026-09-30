# GitHub owner actions

The repository's agent workforce has no repository-management PAT: everything
in this runbook is a click in the GitHub web UI that only the owner can make.
Each item names **Where** (the exact settings path), **Why** (what breaks or
stays open without it), and **Done when** (the state to verify afterwards).
The agent can prepare files and workflows, but the switches below are the
owner's hands.

Repository-state facts below were verified read-only via the API on
2026-09-30 (`gh api repos/Lixiang9716/dsh-mobile` and
`gh api .../branches/main/protection`); re-check before acting if time has
passed:

- Required status checks on `main`: `gates` only.
- Dependabot alerts: **disabled** (`gh api .../vulnerability-alerts` answers
  404 "Vulnerability alerts are disabled").
- Dependabot security updates: **disabled**.
- Secret scanning: **enabled**; push protection: **enabled**.
- Discussions: **off**. Pages: **off**.
- The three package workflows declare no `environment:` yet.

---

## 1. Enable Dependabot security updates

- **Where**: Settings → **Code security** → Dependabot, in this order:
  1. **Dependabot alerts** → **Enable** — this is the prerequisite, not an
     optional extra.
  2. **Dependabot security updates** → **Enable**.
- **Why**: version updates are already wired by `.github/dependabot.yml`
  (weekly, grouped: `github-actions` over the workflows, `npm` over
  `test/upstream-suite` — the one manifest with a lockfile). That cadence
  bumps pins on a schedule; security updates open a pull request the moment
  an advisory lands against a pinned version, instead of waiting up to a week
  for the next scheduled pass. The two compose automatically — there is no
  per-ecosystem security switch to configure in the file.
- **Why alerts come first**: security updates are *triggered by* Dependabot
  alerts — GitHub's docs state the feature "is available for repositories
  where you have enabled the dependency graph and Dependabot alerts", and
  grouped security updates (which the `npm` group in `dependabot.yml` uses)
  additionally require alerts enabled. With alerts off, the security-updates
  toggle has no advisory source: whether the toggle itself refuses to enable
  could not be verified read-only, but the observable failure is worse — it
  enables, the **Security** tab stays empty, and the item looks done while
  nothing can ever fire. Enable alerts first and the tab is also the
  verification surface.
- **Current state**: both off (verified — see the facts above).
- **Done when**: Dependabot alerts reads "Enabled", the security-updates
  toggle reads "Enabled", and the **Security** tab lists Dependabot alerts
  (and their security-update pull requests) instead of nothing.

## 2. Make the `ci-verdict` check required on `main`

- **Where**: Settings → **Branches** → protection rule for `main` → edit →
  **Require status checks to pass** → add **`ci-verdict`** (keep **`gates`**;
  GitHub has been migrating this page to Settings → Rules → Rulesets — if the
  branch-protection page shows a migration banner, do the same edit there).
- **Why**: this is a long-standing backlog item. The three platform pipelines
  are path-filtered, so a docs-only pull request runs none of them — naming
  any platform pipeline as required would leave it "expected" and wedge the
  merge forever. `ci-verdict` is path-less: it always runs, and its verdict is
  derived from every check run that exists on the head commit, with the legs
  that never ran named out loud (see the header of
  `.github/workflows/ci-verdict.yml`). Requiring it closes the gap between
  "gates passed" and "everything that ran is green".
- **How**: the check name is exactly `ci-verdict` (the job id; the job sets no
  display name). If it does not appear in the picker yet, type the name
  manually — the picker lists checks that have already run at least once.
- **Merge queue — think before toggling, do not adopt casually**: with
  required status checks on, GitHub will suggest a merge queue so that
  "green at head" cannot silently become "red at merge". The honest context:
  `docs/decisions.md` **D13** records a rejection of `merge_group`/merge
  queue — but that rejection was scoped to a different problem (working
  around the release PR's check provenance: "it changes the merge model of
  the whole repository to work around one PR's provenance"). It does not
  automatically carry over, but a merge queue genuinely does change the
  repository's merge model, and this repo merges by squash on a standing
  owner authorization. Recommendation: make `ci-verdict` required now;
  reconsider the queue only if interleaved merges actually produce merged-main
  breakage, and land that as its own reviewed decision.
- **Deliberately not recommended here**: "Require review from Code Owners"
  (`.github/CODEOWNERS` now exists). Required reviews are 0 by design — the
  review routing file is a declaration, not a gate, and flipping it would put
  a human approval in front of every automated merge.
- **Done when**: `main`'s required checks list both `gates` and `ci-verdict`.

## 3. Create the `release` environment with a required reviewer

- **Where**: Settings → **Environments** → **New environment** → name:
  `release` → **Required reviewers** → add yourself → **Protect**.
- **Why**: this turns "a release needs an explicit go" from a convention into
  a mechanical approval gate — the package job pauses until the reviewer
  approves, on every tag push.
- **Sequencing warning — creating the environment alone gates nothing.** The
  three package workflows do not reference any environment yet (verified:
  `release-ios.yml` job `ios-package`, `release-android.yml` job
  `android-package`, `release-harmony.yml` job `harmony-package` carry no
  `environment:` key). An environment no job references is inert. So:
  1. Create the `release` environment with yourself as required reviewer
     (this page, owner action).
  2. Then land a small follow-up PR adding `environment: release` to the
     three package jobs.
  The order matters in both directions: the workflow change without the
  environment would red every release run (a job referencing a missing
  environment cannot start); the environment without the workflow change just
  sits there looking protective while gating nothing.
- **Done when**: the environment exists with one required reviewer AND the
  three package jobs declare `environment: release` (step 2 landed).

## 4. Turn on Discussions

- **Where**: Settings → General → **Features** → check **Discussions** →
  **Set up discussions**.
- **Why**: the beta-feedback channel. The default category set (Announcements,
  Ideas, Polls, Q&A — with Q&A as the general discussion) is enough to start;
  tune categories later if the beta traffic asks for it.
- **Current state**: off (verified).
- **Done when**: the repository's **Discussions** tab renders.

## 5. Configure Pages (before the Pages workflow lands)

- **Where**: Settings → **Pages** → **Build and deployment** → **Source** →
  **GitHub Actions**.
- **Why**: another work stream will land a Pages deployment workflow. With
  Pages unconfigured, that workflow's deploy leg cannot succeed — the
  workflow alone is not enough, which is why this is named here: flip the
  switch when (or before) that workflow merges, or its first run fails on the
  deploy step.
- **Current state**: off (verified — `has_pages: false`).
- **Done when**: the Pages settings page shows Source = GitHub Actions (an
  empty deployments list is fine until the workflow lands).

## 6. Secret scanning — no action needed

- **State**: secret scanning **and** push protection are both **enabled**
  (verified). Nothing to toggle; this item exists so nobody hunts for a
  switch that is already on. (Validity checks are off; leaving them off is
  fine — enabling them is an optional extra, not part of this runbook.)

## 7. Marketplace publish secrets and the `marketplace` environment

- **Where**: Settings → **Secrets and variables** → **Actions** (three
  secrets + one variable, below) and Settings → **Environments** →
  **New environment** → name `marketplace` → **Required reviewers** → add
  yourself → **Protect**.
- **Why**: `.github/workflows/marketplace-publish.yml` packages
  `system-plugins/` into the frozen DSH package format and signs the
  catalog index with ed25519 — the signature IS the marketplace's trust
  (the 2026-10-01 contract proposal: tampered hosting can never produce an
  installable package). With no signing secret every run fails at the
  signing step, by design: the catalog does not exist unsigned. The
  deploy secrets are what turns a real publish from a loud failure into a
  deployment; the environment is what keeps a real publish a human's
  decision.
- **What to add, in order**:
  1. Generate the signing key:
     `node tools/marketplace-rotate-key.mjs gen --key-id dsh-market-1`.
     It prints the SEED and the raw public key. The seed is shown ONCE —
     it is never stored in the repository; copy it now. (Rotation later:
     the same tool's `window-index` subcommand — its header documents the
     whole dual-sign-window runbook.)
  2. Secret **`MARKETPLACE_SIGNING_KEY`** = the seed from step 1 (base64 of
     the 32-byte ed25519 seed — exactly what the tool printed).
  3. Variable **`MARKETPLACE_BASE_URL`** = the public URL prefix the
     packages will live under (e.g. `https://dl.example.com/market`).
     Every `tgzUrl` in the signed index is built from it; with neither the
     variable nor the dispatch input set, the run FAILS on purpose — a
     signed index never carries a placeholder URL.
  4. Deploy secrets (needed only for real publishes; dry-run works without
     them): **`MARKETPLACE_DEPLOY_HOST`** (`user@host` or an ssh alias),
     **`MARKETPLACE_DEPLOY_PATH`** (absolute target directory),
     **`MARKETPLACE_DEPLOY_SSH_KEY`** (a private key authorized on that
     host), **`MARKETPLACE_DEPLOY_PORT`** (optional, default 22). A real
     publish without them fails loud, naming each missing secret.
  5. The `marketplace` environment with yourself as required reviewer. The
     publish job pauses until you approve — same mechanics as the
     `release` environment (item 3), and the same arming advice: leave
     **Prevent self-review** OFF, the solo maintainer is the only
     reviewer, so checking it deadlocks every publish run. Until the
     environment is armed the workflow reference is inert — nothing waits.
- **Done when**: a `workflow_dispatch` run of marketplace/publish with
  `dry_run: true` (the default) ends green and carries the
  `marketplace-dist` artifact with a signature-verified index inside; and a
  real publish (tag `marketplace-v*`, or a dispatch with `dry_run`
  unchecked) waits on your approval, then deploys — `deploy.sh` verifies
  the remote index digest after upload, so the run also proves the bytes
  that landed.

---
