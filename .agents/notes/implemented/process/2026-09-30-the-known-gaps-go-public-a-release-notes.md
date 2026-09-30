# Agent Note: the known gaps go public: a release-notes draft plus a labeled issue register

Status: implemented
Related: D5

## Problem

The release line's honest gaps lived in three unrelated places — PR bodies
("Follow-ups named" in #251), the fleet reports (`tmp/ROADMAP-2026-09-29.md`
leftovers, not in the repo), and the owners' heads (the theme ladder and the
profile-as-app-manifest frames come from a 2026-09-28 design-spec session that
left no repository trace). A reader of the v0.0.2 release notes could not
verify any of it: no number was citable, no gap had a home that survives the
PR merge, and "宁短勿假" degraded into either silence or unverifiable prose.
Meanwhile the fleet ledger (night convoys, 2026-09-29) recorded that three
task cards had been opened under the same id `T-0072` by parallel fleets —
the "same number is harmless" open-time claim now makes `gov task tick
T-0072` ambiguous, and nothing tracked that either.

## Decision

`docs/release-notes-v0.0.2.md` + `.zh.md` + `.i18n.yaml` ship as a bilingual
pairing-confirmed draft whose facts cite only merged PRs (#240–#254); the
suite residual numbers point at the not-yet-merged regression report PR
rather than guessing. Every named gap becomes a GitHub issue under a new
`known-gap` label (#257–#268), each with its entry point, repro, and a
one-line acceptance — the register is now linkable from the release notes and
survives them. The two design-session frames (theme ladder rung 2 = token
editor; the profile-as-app-manifest D5 proposal) were scoped by escalation to
the run owner before filing, and #268 states explicitly that the owner's go
is not yet given. The T-0072×4 id collision is itself filed as a chore
(#261): renumber three of the four cards, receipts intact.

## Alternatives considered

- **Keeping the gaps inside the release notes prose only**: rejected — a
  release document is a snapshot; issues are the living register with state
  (open/closed) and a dedupe surface. The notes now carry a Known issues
  section that summarizes and cites, not owns.
- **Filing the two design-session items from the ask's shorthand alone**
  ("主题阶梯第二级", "def profile-manifest"): rejected — repo-wide search
  found no referent for either, and a public issue with a guessed scope is
  permanent. The escalation cost one round-trip and produced the actual
  frames (five-rung ladder, profile-as-app-manifest) the shorthand had
  compressed.
- **Filing the T-0072 renumber as four silent `git mv`s**: rejected — the
  cards are governance records with receipts; renumbering without a tracked
  decision invites exactly the "why was this done?" the notes exist to
  answer, and the collision itself is a govrail observation worth surfacing
  (parallel `task new` in one window assigns duplicate ids by design).
