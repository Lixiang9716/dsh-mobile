# Agent Note: the capability-plane close-out lands the status surfaces in one PR and reconciles the trailing m5-llm drift

Status: implemented
Related: D5

## Problem

Five PRs of one program merged back to back — the system capability plane
contract proposal (#249), the simulator matrix (#250), and the three
capability faces, camera (#252), BLE (#254), microphone (#255) — but the
status surfaces they touch were updated piecemeal by whichever line landed
last: the README milestone table had neither the capability plane nor the
simulator matrix, ARCHITECTURE.md §4/§10 did not know the plane existed,
and docs/e2e-matrix.md's tables had never carried `device.plane`,
`mic.plane`, or `ble.plane` rows at all even though the checker's totals
counted them. Rule 12 makes a phase complete only when every status
document agrees in the same change; this close-out is that change, and it
found the rule's own failure mode already in the tree: the quota-blocked
`m5-m2-llm` evidence was re-run GREEN on 2026-09-28 as
`m5-llm-live-stream` (commit `64889c54`) in the upstream-suite follow-up,
which struck the red dirs and the register rows but left the matrix doc's
cells, the known-gaps prose, and the README/ARCHITECTURE harmony claims
saying the served turn was NOT claimed.

## Decision

One docs-only PR reconciles every surface against the tool's own
inventory on this tree (72 dirs / 148 verdicts, all green, 72 of 72
scenario ids, 65 manifests, checker `--accept-known-gaps` exit 0):

- README + zh: two new milestone rows (simulator matrix; system
  capability plane v1.10.0 candidate, harmony legs implemented with
  receipts staged behind the D-g one-click contract — no evidence
  synthesized), the harmony row's served-turn clause flipped to the green
  `m5-llm-live-stream` facts, and the D9 section's counts refreshed.
- ARCHITECTURE + zh: §4 gains the capability-plane pointer (grant-family
  flag first, OS permission second, audited refusals — never a hostType
  branch), §10 gains the capability-plane and simulator-matrix bullets,
  the harmony served-turn clause flips, and the decision-log range is
  corrected to D0–D18.
- e2e-matrix + zh: a new currency block, totals re-run, and the tables
  made FULLY coextensive with the checker's inventory — the coverage
  matrix enumerates all 72 scenario ids (the review round added the 23
  rows the tables never carried, and renamed the stale
  `m2.upstream-session`/`m2.upstream-boot` rows to the ids the re-captured
  dirs actually declare: `upstream.session`/`upstream.web-boot`), the
  evidence-dir inventory lists every one of the 72 checker dirs in both
  languages (the review round also fixed the en `m5-host` row to the
  12 green verdicts / 11 screenshots the tree carries — the zh row had
  been updated while en kept the old 4-verdict line, a divergence this
  change created and then closed), and every coverage cell is now
  machine-checked against the verdict JSONs (568 cells, 0 mismatches;
  the `upstream.parity` "+ differential" cells are the documented
  differential-prose convention, not verdict data). The m2.llm harmony
  FAIL cells are struck, and the known-gaps section is coherent with the
  register's actual eight rows (the quota gaps moved to a dated closed
  subsection; the Android camera audit's self-inconsistent verdict
  documented as gap 8).

Scope discipline: only merged work with committed evidence is written
down. The harmony legs of all three faces are stated as implemented
awaiting real hardware (D-g scripts staged), never as run.

## Alternatives considered

- **Leave the m5-llm reconciliation to a separate corrective PR** —
  rejected: this close-out's currency block asserts "every committed
  verdict is green" and re-runs the totals; carrying the red 8/9 prose
  beside it would make this PR self-contradictory, and rule 12's point is
  precisely that remembered second changes rot. Reconciled here, with the
  trailing-flip pattern recorded in the closed subsection so it is
  visible next time.
- **Fold the capability-plane proposal into primitives.md (bump the
  frozen contract) while at it** — rejected: the implementing PRs
  deliberately kept v1.10.0 candidate status; folding a proposal is a
  contract-freeze decision (D5), not a docs close-out's side effect.
  contract/README.md's proposals cell still says "nothing implemented",
  which is now loose — left as the contract owner's deliberate state,
  flagged in the PR description.
- **Hand-write only the mic/ble rows the ask literally names** (the first
  round's actual scope) or **declare the tables an intentional partial
  enumeration** — both rejected after the review round: the totals line
  asserts "72 of 72", so a partially enumerated table underneath it is
  the exact self-disagreement rule 12 kills, and a declaration would have
  frozen the ambiguity the document's own "REGENERATED" label denies.
  Full enumeration won because it is mechanical (every cell is derived
  from the committed verdict JSONs and re-verified programmatically), it
  ended the curated-subset ambiguity, and it caught a real conflation in
  the first round: the simulator-matrix gateway-drive dir declares NEW
  scenario ids (`carrier.loopback` / `gateway.audit` / `gateway.binding`),
  whose cells had briefly been appended to the OLD ids' rows
  (`m1.carrier.loopback` / `m2.gateway.audit` / `m2.gateway.binding`).
