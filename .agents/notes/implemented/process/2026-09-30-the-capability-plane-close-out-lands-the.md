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
- e2e-matrix + zh: a new currency block, totals re-run, the missing
  coverage rows (ble/boot/device/mic/session.mock-llm/gateway.bridge-smoke/
  llm.live-stream) and inventory rows (14), the m2.llm harmony FAIL cells
  struck, the known-gaps section made coherent with the register's actual
  eight rows (the quota gaps moved to a dated closed subsection; the
  Android camera audit's self-inconsistent verdict documented as gap 8),
  and the zh twin brought to the same tree state instead of staying
  phases behind.

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
- **Hand-write only the mic/ble rows the ask literally names** —
  rejected: the totals re-run this PR performs contradicts every stale
  cell it sits above (socket.seam 17/17, whale.mount 16/16, b4 43/43,
  the quota FAIL cells); a status table that disagrees with its own
  totals line is the drift rule 12 exists to kill. All cell fixes are
  backed by the committed verdicts, enumerated in the PR body.
