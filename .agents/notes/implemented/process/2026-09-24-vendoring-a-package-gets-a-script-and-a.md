# Agent Note: vendoring a package gets a script and a skill — the tribal knowledge lands

Status: implemented

## Problem

Introducing a vendored package is the repo's most accident-prone flow: the
pin tables, the tracked mirror, and THREE hosts' hand-edited embed lists
(iOS TREES, harmony CLOSURE/BUNDLE_FILES, android wholesale stager) plus the
preset roster must all agree, and nothing forced them to. The 2026-09-24
PR-206 round alone burned on the rel-vs-src face split (npm-face bytes must
stage at a vendor/dsh rel for the marker seeder), the silent-empty rglob,
harmony's missing rows (T-0048), and the closures gate's commit-before-gate
ordering — all rules that lived in session memory and commit messages, not
in the repo.

## Decision

Two layers, split by what needs judgment:

1. `runtime/spike/vendor/add-package.sh` — the mechanics. `fetch` downloads
   the registry tarball (deterministic: the hash matched the committed zod
   pin exactly on first run), places it in the tracked mirror, prints the
   pin row. `rows` detects which face the package materialized at and
   prints per-host embed rows in house format (verified byte-for-byte
   against the landed tool-bash TREES tuple and the dsh-goal in-place
   rows). `regen` = build/build.sh sync minus compiles; `verify` = the
   closures gate subset. The script PRINTS rows instead of editing the
   embed lists: text-editing committed Python/ArkTS/shell list literals is
   the fragile path, and which rows to paste IS the judgment.
2. `.agents/skills/vendor-package/SKILL.md` — the judgment: face choice,
   staged-rel rule (preset-riding → vendor/dsh rel for the marker seeder),
   per-host list mapping, roster-row timing (embed exists BEFORE the roster
   row, since preset health hard-fails unresolvable rows), the two-commit
   ordering, the fresh-clone determinism proof, and the trap list with the
   PR numbers that paid for them.

## Alternatives considered

- One script that auto-edits all five embed files and runs everything —
  rejected: it would text-merge generated/hand-held lists (the exact
  "never text-merge" trap), hide the per-host judgment the skill must
  teach, and turn every review into diff-archaeology.
- A single generated closure manifest consumed by all three hosts — the
  real structural fix for embed-list lag, but a cross-host refactor; noted
  as the follow-up direction, not smuggled into this change.
- Nothing (memory files only) — the status quo that produced four red
  rounds; the knowledge was one context-loss away from gone.

## Consequences

The next 引入包 round starts from `fetch` and follows the skill; the rules
that previously lived in session memory are repo-owned and gate-checked
where checkable. Known gap stays honest: harmony cannot stage npm-face
bytes at a vendor/dsh rel until T-0048's mapping exists — the skill says so
in flow, the script's rows output names it.
