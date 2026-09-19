# Agent Note: M1 spike batch landed on four surfaces; cards retired; README status flipped

Status: implemented
Related: D1

## Problem

The M1 spike batch (core runtime + three platform embeds) landed across
four PRs, and three task cards were left open by the workers. Two pieces
of bookkeeping had to land with or after the batch: the cards needed a
recorded exit, and the README milestone table had to stop claiming M1 is
"Planned" (rule 12: the change that completes a phase updates every
status surface). Neither could be done by the platform workers: card
close is structurally broken upstream (govrail #329), and one wrinkle
made even void impossible from the workers' seats.

## Decision

- All three platform cards are retired. The two id-twin card files
  (ios/harmony) were git-removed and the surviving android card voided
  via `gov task void` with the recorded exit: all three worktrees had
  allocated id `T-0003` independently (per-worktree high-water mark —
  govrail #332), so on main the id was ambiguous, the cards were
  unaddressable by the tool ("'T-0003' is ambiguous"), and no prefix
  could disambiguate. Removing the duplicates restores id uniqueness;
  the removed files remain fully auditable in git history (they were
  committed by merged PRs #22/#23).
- README/README.zh milestone table: M1 → "In progress (runtime spike
  verified on iOS/Android/HarmonyOS + macOS)" — honest, because the M1
  scope item "local carrier" is not started; the spike half is what
  landed.

## Alternatives considered

- Voiding all three via the tool: impossible — the resolver matches on
  the card's `id` field only; three identical ids are permanently
  ambiguous, and no flag exists to select by filename (upstream, folded
  into #332's scope).
- Leaving the cards open until a govrail patch: rejected — open cards
  mean "work in progress" to every reader of `.gov/tasks/`, which is now
  false, and the task gate/pre-push surface would carry the stale-open
  state into every future push.
- Flipping M1 to "Done": rejected — the "local carrier" scope item has
  not started; a phase is done when its scope is done, not its first
  spike.
