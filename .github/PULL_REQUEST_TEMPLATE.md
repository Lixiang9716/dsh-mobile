<!--
Landing discipline (AGENTS.md, "Landing changes"; .gov/rules.md):
branch → commit → push → gh pr create → wait for the `gates` check →
squash merge. main is protected; the owner bypass is reserved for
deliberate direct landings, never a default.
-->

## Summary

<!-- What changed and why, in a few sentences. The behavior story lives in the Agent Note; this section is the PR-level orientation. -->

## Task card

<!-- Multi-step work is gate-enforced, not a todo: gov task new → gov task tick → gov task close with a green receipt (rules.md rule 9). -->

- [ ] Tracked by task card: `.gov/tasks/<id>.json` — or state why no card (single-step, no omission-silent step)

## Agent Note

<!-- rules.md rule 2: every change that alters behavior, architecture, a cross-file contract, process or tooling, or a decision a maintainer may revisit carries one. Notes live at .agents/notes/implemented/<class>/<date>-<topic>.md with Problem / Decision / Alternatives considered filled. Purely mechanical edits are exempt. -->

- [ ] Note: `.agents/notes/implemented/<class>/<file>.md` — or state why exempt (typo/format/local-mechanical)

## Acceptance evidence

<!-- Evidence is a command and its real output, per item. A claim without a run is not evidence; a check that could not run is reported as not run, never as passed. -->

| # | What this proves | Command | Output |
| --- | --- | --- | --- |
| 1 |  |  |  |

## Bilingual pairing

<!-- rules.md rule 7: a PR never lands one language of a pair alone. After BOTH sides of a human-facing doc pair moved: gov verify pairing --write <repo-relative stem> — never hand-edit the .i18n.yaml record. -->

- [ ] No human-facing doc changed, or pairing re-confirmed: `gov verify pairing --write docs/<stem>`

## Checklist

- [ ] PR title (and the future squash-merge subject) is a Conventional Commit: `type(scope): subject`
- [ ] `gov run` green with a receipt; the `gates` check is expected green on this PR
- [ ] Contract-first respected: any new gateway primitive was proposed in `contract/` first — nothing reaches around the gateway
