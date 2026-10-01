# Agent Note: Duplicate task-card ids renumber past the high-water mark (B20, issue #261)

Status: implemented
Related: issue #261, T-0087, govrail #352 (colliding ids), govrail #327 (high-water allocation)

## Problem

The parallel night fleets each ran `gov task new` in overlapping windows
and govrail's per-process id allocation handed several of them the same
"next" number (the #352 shape). The ledger carried **34 duplicate-id
groups over 152 cards — 66 cards sharing an id another card already
held**, worst case `T-0078` ×11, then `T-0082` ×6, `T-0013` ×5, `T-0072`
and `T-0010` and `T-0008` ×4 each. Issue #261 recorded the `T-0072`
group; the same defect ran through the whole ledger. The cost is
`_resolve`: `gov task tick/show/close T-0072` aborts with "ambiguous"
whenever more than one match is non-open, so history commands on those
ids depend on which card happens to still be open. govrail 0.48.0 ships
no rename subcommand (`task: new/check/tick/show/close/list/claim/
release/repin/void`), so the repair has to be a hand edit of
`.gov/tasks/` — exactly the directory whose mutations the gates watch.

## Decision

All 66 non-earliest duplicates were renumbered to fresh ids strictly
beyond the git-history high-water mark (86), landing as `T-0088` through
`T-0153`, assigned in global chronological order of the cards' `created`
timestamps. The earliest card of each group (by `created`, filename as
tiebreak) **keeps the original id**, because a bare-id citation most
plausibly names the first card minted under it. Each rename is
`git mv` plus a single-line rewrite of the card's `"id"` field — nothing
else in the file moves, so every embedded receipt (`status: done` +
`receipt.green` + rules pin) stays byte-identical and `_check_receipt`
keeps validating them: the receipt never references the card id or
filename, only the gate records and the rules hash. The renumbered set
includes one open card (`T-0078-byok…` → `T-0142`), whose handle
unambiguously resolves from now on. Verification ran on the renamed
tree: 153 cards / 153 unique ids / 0 duplicate groups / 0
filename↔id mismatches, `gov task check` green (exit 0), `gov
self-test` green (exit 0, tools 56 + project 9) after the CI-equivalent
local materialization, and `gov task show T-0142` / `T-0153` resolve the
renamed cards.

## Alternatives considered

- **Only the `T-0072` group, per issue #261's literal ask** — leaves 33
  groups ambiguous; #261's own acceptance ("exactly one card" per id)
  generalizes, and this change closes all of it. #261 can close when
  this lands.
- **Keep the latest card instead of the earliest** — no: citations and
  the fleet narrative reference the first card that existed under an
  id; keeping the earliest maximizes the number of historical
  citations that still point at the card they meant.
- **Void the duplicates instead of renumbering** — destroys evidence:
  voided cards are the audit trail (63 already are, each with a
  recorded reason); renumbering preserves every card, receipt, and
  void record byte-for-byte.
- **Wait for a govrail `task rename`** — nothing to wait on exists in
  0.48.0; the hand edit is constrained enough (one JSON field + one
  `git mv`) that the gate verdict on the renamed tree is the proof.

## Consequences

- The id space is contiguous `T-0001..T-0153` with zero gaps;
  `_next_id`'s high-water walk now sees the renamed-away ids only in
  git history, so the next `gov task new` allocates `T-0154` and no
  freed slot is ever reused (#327 holds).
- Bare-id citations in historical notes/docs (56 sites across 23 notes
  + 4 docs) were deliberately **not** rewritten: they cite ids that
  still exist (now held by the group's earliest card), and pre-change
  they were already ambiguous in exactly the same direction. The PR
  diff is the durable old→new map.
- `gov self-test` on a fresh checkout is red (3 project rejection
  cases) until the CI materialization steps run — recorded as surprise
  `fresh-checkout-gov-self-test`; it is a materialization gap, not a
  product or tool defect.
