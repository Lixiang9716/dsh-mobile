# Agent Note: the plane moves to govrail 0.48.0, and the verbs it ships retire the card ledger's dead end

Status: implemented
Related: D0

## Problem

Card T-0032 was blocked on a coupling, not on a checkbox. Adding a gate through
the sanctioned `gov gate add` re-seals the plane, the seal recomputes the
combined `rules@` hash, and **every open card's pin goes stale** — by design
(rule 9). On the pinned 0.47.1 the cards that went stale could not be recovered:
`task` accepts an id or a unique prefix, the ledger has duplicate ids by
history, and there was no way to advance a pin at all. So a legitimate
constitution change turned the DAG red unrecoverably, and the previous attempt
at wiring the matrix gate had to be reverted with the seal restored — the
`e2e-matrix` gate has been sitting unwired in `docs/register` ever since
(govrail #368, filed from this repository, and the reason the last re-baseline
message reads the way it does).

The upgrade that fixes it is 0.48.0, which reached PyPI on 2026-09-21.

## Decision

**The plane is on govrail 0.48.0**, applied as one deliberate migration:
`.gov/manifest.json` 0.47.1 → 0.48.0, `.gov/pairing.json` adopted (it is part of
the plane now, so the seal covers 7 files instead of 6), four uncustomized
template files re-adopted (the `notes` README and the `govrail` /
`recall-first` / `pre-push-checks` skills), the CI pin refreshed to `==0.48.0`,
and the plane re-baselined over the result — a recorded ritual in
`.gov/rituals.jsonl`, taken deliberately and with the diff reviewed, not to make
a red go green.

What the version ships that this repository needed:

- **`gov task repin <id|slug> --reason <why>`** — advances a stale pin as a
  recorded act, which is exactly the exit the coupling above denied. It accepts
  a **card-file slug**, which is also the only handle that resolves a
  duplicate-id card at all.
- **`gov task tick <id|slug> <n>`** and **`gov task show`** — the checklist is
  editable through the CLI (hand-editing card JSON stays forbidden) and a card
  renders whole, so `task check` can stay one line per card.
- **`gov task close --refresh-receipt`** — the exit for a bricked done card
  (#329), the state every card from T-0021 to T-0029 was retired *void* to
  escape.
- **The pre-push hook scopes to what the push carries** (#363): a new branch
  resolves its fork point, declares it in `GOV_CHANGE_BASE`, and a ranged base
  lists committed content only — so a foreign untracked scratch file can no
  longer block a push it is not part of. The hook is re-wired to this template.

The migration also surfaced four real size violations, fixed in the same branch
and recorded as T-0034 (the change that makes them visible carries their fix,
rather than leaving the DAG red for whoever pushes next).

Two behaviours of the migration path are worth recording, because both cost
time to establish and neither is what the tool says it will do: `gov update
--apply` reported the hook drift and promised `--apply` re-wires it, but the
hook was untouched (`gov init --hooks` is what does it — and it additionally
installs a `.claude/settings.json` for a platform this plane never adopted,
which was removed here and reported upstream). Both are field feedback to
govrail, not silent workarounds.

## Alternatives considered

**Stay on 0.47.1 and retire the duplicate-id cards by hand.** Rejected: it
destroys ledger history to work around a missing verb, and the next gate wiring
would hit the same wall — the coupling is in the tool, not in the cards.

**Bump the pin alone (no migration) and keep the old hook.** Rejected: the
manifest, the seal, the CI pin and the installed hook are one state; leaving the
hook behind keeps the #363 failure mode the repository keeps paying for (its own
memory records pushing from a detached worktree as the workaround, ~6 times in
one session).

**Wire the e2e-matrix gate in the upgrade commit.** Rejected as an ordering: the
upgrade must be green on its own before a second constitution change lands on
top of it, and the two together are already one review of the same surface.
They land in this branch as two commits.
