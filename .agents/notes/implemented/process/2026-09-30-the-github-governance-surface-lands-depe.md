# Agent Note: The GitHub governance surface lands: dependabot, code owners, templates, and the owner-actions runbook

Status: implemented

## Problem

The repository had zero GitHub governance surface beyond workflows:
`.github/` contained nothing but `workflows/`. Dependency updates were
unmanaged and invisible — Dependabot security updates verified disabled via
the API on 2026-09-30 — so advisory-driven bumps simply never happened.
Review routing was implicit (nothing addressed a reviewer), the frozen
contract had no review identity of its own, and the landing discipline that
AGENTS.md and .gov/rules.md carry in prose met a contributor opening a PR or
issue with no structure at all. Finally, the actions only the owner can take
in the web UI (security-updates toggle, required checks, a release approval
gate, Discussions, Pages) lived in nobody's memory and no document — the
agent workforce has no repository-management PAT, so those switches depend
entirely on the owner knowing they exist.

## Decision

Seven files land. `.github/dependabot.yml` runs two weekly, grouped
ecosystems — `github-actions` over `/`, and `npm` over `/test/upstream-suite`
only, chosen as the minimal reasonable surface by evidence: the root has no
manifest, `presentation/lynx-client` has one devDependency and no lockfile,
and the vendored shim manifests under `runtime/spike/upstream/shims/` and
their host copies are pinned by the closures gate, so npm must not point at
`/` and sweep them. Security updates stay out of the file by design — that
switch is an owner web action. `.github/CODEOWNERS` declares the owner for
the whole tree plus an explicit `/contract/` line, so a PR moving the frozen
surface always reads as a contract review, never by inheritance; it is
routing only, since required reviews stay 0 by design.
`.github/PULL_REQUEST_TEMPLATE.md` and `.github/ISSUE_TEMPLATE/` (bug with
repro steps first, feature with motivation first, `blank_issues_enabled:
false`, default labels `bug`/`enhancement` — verified to exist) put the
actual landing discipline — conventional title, gov task card, agent note,
evidence as command + output, pairing — in front of every contribution.
`docs/github-owner-actions.md` + `.zh.md` (pairing confirmed) is the owner
runbook: six items, each with entry path, why, the API-verified current
state, and done-when — including the sequencing truth that the `release`
environment gates nothing until the three package jobs
(`ios-package`/`android-package`/`harmony-package`) declare
`environment: release`, and that Pages must be configured before the Pages
workflow from the other work stream lands or its deploy leg fails.

## Alternatives considered

- **npm over `/`** (one entry, everything swept in): rejected — Dependabot
  would raise PRs against the vendored shim manifests the closures gate
  byte-verifies, exactly the drift the pin tables exist to prevent; the
  subdirectory scope is the whole point of "minimal reasonable surface".
- **Adding `presentation/lynx-client` too**: rejected for now — no lockfile
  and a single devDependency mean no verifiable resolution to update;
  adding a lockfile is a build-behavior change that belongs to its own
  reviewed change, not to a governance sweep.
- **Making a platform pipeline (`dev/ios` etc.) required instead of
  `ci-verdict`**: rejected — they are path-filtered, so a docs-only PR never
  runs them and the check stays "expected" forever; that gap is precisely
  what the path-less aggregator was built for.
- **Pre-wiring `environment: release` into the three package workflows in
  this same change**: rejected — the environment does not exist yet, and a
  job referencing a missing environment cannot start, so every release run
  would red until the owner acts; the runbook sequences the owner action
  first and the workflow PR second.
- **Enabling "Require review from Code Owners" alongside CODEOWNERS**:
  rejected — required reviews are 0 by design (merges ride on CI plus a
  standing owner authorization); the file is a routing declaration, and the
  runbook says so out loud so nobody "completes" it later by accident.
