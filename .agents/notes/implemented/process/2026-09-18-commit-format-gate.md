# Agent Note: commit-format gate (Angular Conventional Commits)

Status: implemented

## Problem

Commit messages were pure convention-by-habit. As agent-authored commits scale (squash merges
from PRs included), an unparseable history breaks tooling that reads it: changelog generation,
release notes, selective backports, and any future automation that maps `feat`/`fix` to
releases.

## Decision

A `commit-format` hard gate (`tools/check-commit.py`) validates every commit in the unpushed
range (`origin/main..HEAD` — under `gov run`, pre-push, and CI push events that is exactly what
is about to land). Header grammar: `type(scope)!: subject` with types
feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert, scope limited to word chars and
dashes, subject not starting with an ASCII uppercase and not ending with a period, header
<= 100 chars. Squash-merge PR titles must comply too (they become the commit header).

## Alternatives considered

- **commitlint + husky (JS toolchain)**: the standard, but a Node toolchain for a 30-line
  check; the project gate reuses the govrail DAG like every other rule. Revisit if rules grow
  (body/footer conventions, subject casing per type).
- **commit-msg hook only**: covers the local machine only; the gate also runs in CI where
  squash-merge titles land, so the rule holds even when a commit is created by a merge button.
- **Chinese subjects allowed**: yes — the rule bans an ASCII-uppercase start and trailing
  period, not any language; historical Chinese subjects validate fine.

## Consequences

Every commit (and squash-merge PR title) must read `type(scope): subject`. The gate checks the
unpushed range only, so rewriting ancient history is out of scope and rebase flows are safe.
`git commit --amend` is the remedy when the gate blocks a push.
