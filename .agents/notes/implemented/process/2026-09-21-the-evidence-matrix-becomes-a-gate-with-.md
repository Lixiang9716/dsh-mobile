# Agent Note: the evidence matrix becomes a gate, with the gaps it accepts counted and owned

Status: implemented
Related: D13, D12

## Problem

`tools/e2e/matrix.mjs` regenerates a cross-host inventory of every committed E2E
evidence directory and exits non-zero on a regression, and it was **deliberately
not wired into `gates.json`** because it exited non-zero on exactly ten findings.
An inventory nobody enforces rots, and a check that cannot block is not a check —
but neither can a gate be switched on while it is red, or the repository's own
push path stops working.

The ten findings were of two kinds, and only one of them is this repository's to
close. One was the checker's **own false positive**: a count-consistency notice
fired on a verdict whose `pass` was already `false` — a condition a failing
verdict can never satisfy — and its detail claimed `but pass=true` about a file
saying otherwise. The other nine need something this repository cannot synthesise:
seven `receipt.json` files that only the owning host work stream's next
device/emulator run can produce, and two verdicts blocked by an exhausted z.ai
coding-plan quota.

## Decision

**The matrix is a gate, and the gaps it accepts are a machine-read register rather
than a tolerated red.**

`tools/e2e/matrix.sh` resolves `node` (absent from this project's local PATH,
present on the CI runner) and execs the checker; the gate calls the wrapper,
because a gate command that cannot resolve is a **red** gate, not a skipped one.
The checker's false positive is fixed, with both directions pinned in
`--self-test` (now 18 assertions, up from 8).

The nine genuine gaps live in a register that the checker itself enforces: a
finding **no row names** blocks; a row whose finding has **disappeared** blocks;
a register grown past its budget blocks; an **unreadable** register is a finding.
Each row carries an owner and the command that closes it. So the gaps are not
tolerated — they are counted, owned and bounded, and the budget is what stops
them growing quietly behind a green gate.

Wiring it required `gov verify-plane --write`: `gates.json` is inside the plane
seal, and re-sealing is a recorded ritual, not an accident to be worked around.

## Alternatives considered

**Leave the gate off and keep the findings in prose.** That is the state this
change replaces: ten findings described in `docs/e2e-matrix.md` and enforced by
nothing. Prose does not fail a push.

**Delete or fabricate the nine gaps.** Rejected absolutely. A `receipt.json`
certifies a *run* and records a run-time device identity — the seven dirs contain
no simulator UDID, no `AVD|Pixel|API 35`, no `dsh_phone|hdc` token, so authoring
one would invent exactly the field the acceptance bar forbids. Deleting the
evidence to silence the checker would be the same lie with less paperwork.

**Lower the bar so the gate passes on any tree.** Rejected: a gate tuned to its
current findings is a gate that cannot fail.

**Call `node` directly in `gates.json`.** Rejected on measurement — it would have
made every local `gov run` red and every local push refused, because `node` is on
PATH only under nvm here. The wrapper resolves either way, verified with PATH
stripped.
