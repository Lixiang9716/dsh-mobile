# Agent Note: Milestone completion updates every status document

Status: implemented
Related: D0

## Problem

The M0 gateway primitive contract froze at v1.0.0 (PR #17), but the
README milestone tables — the project's primary status surface, in both
languages — still read "In progress / 进行中". Keeping status documents
in sync was carried by memory and goodwill, not by any standing order:
the change that completes a phase carries no obligation to flip the
status its completion invalidates, so every phase transition risks a
stale table that a reader or the next agent trusts. This one drifted
within hours of the freeze.

## Decision

`.gov/rules.md` gains rule 12: the PR that completes a phase of work —
a milestone delivered, a contract frozen, a work stream closed —
updates, in the same change, every status surface it touches (README
milestone table, architecture milestones, roadmap or plan files, task
cards that tracked the work); drift found later is fixed as an
immediate corrective change, never deferred. The rule lands with its
first application: both README milestone tables now read M0 as Done
(frozen v1.0.0). The plane was re-baselined over the rules.md edit
(`gov verify-plane --write`, recorded UNATTENDED with this note as the
cited authority).

## Alternatives considered

- Automating the check as a gate instead of prose (rule 1 prefers
  checkable promises): rejected for now — "which documents record this
  phase's status" is a judgment call with no stable machine-readable
  surface to diff against; a heuristic gate (grep milestone rows on
  contract-version bumps) would false-positive across unrelated bumps.
  Revisit if status drift recurs — the third recurrence is a process
  defect (rule 11).
- Putting the rule in AGENTS.md's constraint list instead of
  `.gov/rules.md`: rejected — rules.md is the single source of truth
  for standing orders and agents are directed there before starting
  work; AGENTS.md carries engineering constraints, not governance
  process rules.
- Fixing only the README row without a rule: rejected — repairs the
  symptom; M1's completion would re-run the same failure mode.
