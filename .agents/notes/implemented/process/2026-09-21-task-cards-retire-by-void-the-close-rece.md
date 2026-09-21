# Agent Note: Task cards retire by void: the close receipt is structurally unsatisfiable in this plane

Status: implemented
Related: D5, surprise:gov-task-close-stamps

## Problem

Every worker in this repository reaches the same dead end at the end of
a card's life, and it is not a mistake any of them made: `gov task
close` reports success — "closed T-0022 with an all-green all run (13
gates)" — and stamps a receipt, then the very next `task` gate run
rejects that same receipt: `T-0022: receipt run is not all-green
(verify-decisions)`. The writer computes green over the SELECTED gates;
the reader (`_check_receipt`) demands a strict PASS for every recorded
gate. `verify-decisions` exists only in the `governance` mode list while
the plane's default is `all`, so no single mode selects all 13 enabled
gates and a satisfying receipt cannot be produced by any invocation
(govrail #329 / #339). The cost is not the failed gate, it is the
session it burns: the closer usually discovers the trap *after* the card
is already `done`, where `void` refuses a done card and hand-editing
`.gov/` is forbidden — leaving no sanctioned exit at all. T-0022 is the
third recorded instance of this exact signature (`gov-task-close-stamps`,
promoted by `gov surprise record`), on top of the T-0001..T-0021 cards
that each rediscovered it and retired as void.

## Decision

Task cards in this plane exit by **void with a reason**, not by close,
and the PR is the audit trail. Concretely: a card is worked to
completion, its evidence lands and merges through the normal branch →
PR → `gates` → squash-merge flow, and then the card is retired with
`gov task void <id> --reason "<what landed, where, and why void rather
than close>"` — the reason names the merged PR and its squash commit.
`gov task close` is attempted only as a deliberate probe, and when its
receipt is rejected the recovered sequence is: `git restore` the close's
card mutation, then `gov task void` with the PR as the recorded exit
(rule 11's escalation is already satisfied by this note, and the
`surprise:gov-task-close-stamps` signature is the standing signal that
the upstream writer/reader disagreement has not been fixed). The void
ledger is not a workaround papered over the failure: the reason field
carries the full acceptance statement, so a reader of `.gov/tasks/`
sees what landed and where to verify it. Both the plane's own rules
adoption and the upstream tracker keep the real fix — a receipt reader
that agrees with the writer about non-selected gates — outside this
repository's reach.

## Alternatives considered

- **Fix the plane locally** (add `verify-decisions` to the `all` mode,
  or drop it): rejected — `gates.json` is sealed constitution, so the
  change is a re-baseline ritual, and it would silently redefine what
  "all gates green" means for a repository whose CI is the evidence.
  The disagreement is upstream's to settle; #329/#339 already carry it.
- **Keep closing and accept a red `task` gate**: rejected — it makes
  `gov run` permanently red, which destroys the gate's value as a
  regression signal for every other change and invites the parked-gate
  anti-pattern the rules name.
- **Never open cards (avoid the ritual entirely)**: rejected — rule 9's
  card is a contract with the caller that a checklist was honoured, and
  the void ledger only has meaning because the card existed first.
- **Hand-edit the card JSON to `voided`**: rejected — `.gov/` is
  append-only by design and hand-editing it is the one move the skill
  names as never acceptable; the `git restore` + `gov task void`
  sequence keeps every mutation command-authored and attributable.
- **Stamp a synthetic `PASS` for `verify-decisions`**: rejected —
  fabricating a gate outcome to satisfy its reader is the same class of
  error as fabricating evidence.
