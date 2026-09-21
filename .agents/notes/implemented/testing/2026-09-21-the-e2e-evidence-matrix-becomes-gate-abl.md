# Agent Note: The E2E evidence matrix becomes gate-able: a machine-read known-gaps register and a two-invocation exit contract

Status: implemented
Related: D0

## Problem

`tools/e2e/matrix.mjs` audits every committed E2E evidence dir against the
acceptance bar and exits non-zero on any finding — and on this tree it exits
non-zero on exactly ten of them. A check that cannot run green and block is
not a check: the inventory was therefore deliberately NOT wired into
`gates.json`, and the ten findings sat in a document where nothing enforced
their number, their owners or their closure. Two things were wrong at once:
an unenforced inventory (it rots silently — a *new* missing receipt produces
exactly the same red as the ten known ones, so nobody could tell a regression
from the backlog), and one finding that was the checker's own false positive.

Classifying the ten honestly split them cleanly. Seven are a missing
`receipt.json` in dirs landed by #63/#64/#65/#66/#67/#70/#72 (android x3,
harmony x3, iOS b4) and two are the quota-blocked `hosts/harmony/artifacts/
m5-m2-llm/` verdicts (`HTTP 429`/`1310`, reset 2026-09-22 14:43:53) — none of
those nine can be closed from a docs/checker branch. The tenth was the
checker's derived `VERDICT_MALFORMED` notice firing on the *failed* carrier
verdict, claiming "but pass=true" about a verdict that says `pass: false`.

Why the seven receipts cannot be authored from the committed artifacts, which
is what makes them bucket (b) rather than (a): the receipt certifies a run,
and its `host` field names the machine that ran it — the iOS simulator UDID
and runtime (`xcrun simctl` at run time), the android emulator instance with
its AVD and API level, the harmony hdc target. None of that is in the
committed evidence: grep for the device tokens over the seven dirs returns
nothing, while the green verdicts, captures and the engine line are all
there. Acceptance-bar clause 3 and the `run-ios.sh` receipt step (green path
only, step 7) both forbid synthesizing the rest.

## Decision

`tools/e2e/matrix.mjs` keeps one truth and gains a second invocation:

- default — every finding is printed and the run exits 1 on any of them,
  registered or not: the unvarnished list, unchanged in spirit.
- `--accept-known-gaps` — exits 0 while every finding is a row of the
  known-gaps register, and 1 on (a) a finding no row names (a NEW
  regression), (b) a row whose finding is gone (a closed gap is struck from
  the register in the same change), (c) a register grown past
  `KNOWN_GAP_BUDGET = 9` (accepting a new gap is a deliberate edit), or (d) a
  register that cannot be read at all. This is the command a gate wires in.

The register is machine-read from the `| code | file | owner | closes with |`
table of `docs/e2e-matrix.md`, so the human honest list is the only copy and
cannot drift from the checker; an unreadable or malformed table is a finding
of its own, never a silent empty set (rule 5). A table-less doc, a
three-cell row and a blocked backlog each ship a rejection assertion in
`--self-test`, alongside the four new register assertions and the fixed
count-consistency pair (18 assertions total).

The tenth finding is closed in the checker, not in the evidence: the
count-consistency notice now requires `v.pass === true && v.expected !==
v.logged`, because on a FAIL verdict the differing counts ARE the failure,
already reported by `VERDICT_FAIL`, and the notice's detail line asserted
`pass=true` about a verdict saying otherwise. `--self-test` proves both
directions: a FAIL verdict draws one finding and no notice; a passing verdict
with differing counts is still rejected.

Finding paths become root-relative (`relative(root, …)` instead of
`relative(process.cwd(), …)`) — the register keys are paths, and a path that
moves with the cwd cannot key a register. The doc's numbers are regenerated
from the tool's own output on this tree (unchanged: 32 dirs / 75 verdicts /
81 PNGs); the register's nine rows are byte-identical to the nine findings'
`code` + `file`, so `--accept-known-gaps` is green with 0 blocking findings,
and `gates.json` is untouched (the seal is not this change's to re-cut).

## Alternatives considered

- Keep the checker red and document the ten findings (the status quo): lost —
  an always-red check is not wireable at all, so the inventory has no
  enforcement, and a new missing receipt cannot be told apart from the
  backlog. This is exactly the rot the change exists to stop.
- Make the ten findings advisory (`--allow-failure` on the gate): lost per
  the same rule the task rests on — an advisory gate reports but never
  blocks, so the first real regression passes silently. The register is the
  opposite: every *unregistered* finding blocks immediately.
- Keep the register as a hardcoded const in `matrix.mjs`: lost — the doc and
  the code would then be two copies of the same list, free to drift, and the
  honest list would stop being the source of truth. Reading it from the doc
  makes an unregistered gap impossible to accept without editing the page a
  human reads.
- Put the register in a new `tools/e2e/known-gaps.json`: lost for the same
  reason plus one more — a machine-only file invites silent edits (accepting
  a regression shows up as a JSON diff nobody reads), while the doc table
  puts the acceptance in the same diff a reviewer is already reading.
- Close the seven receipts by authoring them from the committed captures
  (the bucket-(a) reading of the task): lost — the device identity is not in
  the captures, so the `host` field would be invented; that is precisely the
  synthesis the receipt convention forbids, and a fabricated receipt is
  worse than an owned gap.
- Leave the tenth finding registered instead of fixing it: lost — it is the
  checker's own false positive, and registering it would make the register
  carry a lie ("gap" implies the world is broken; here the checker was). It
  is closed in code with a rejection proof instead.
- No budget (`KNOWN_GAP_BUDGET`): lost — without it a new regression could be
  accepted by adding a row in the same PR, so the backlog would be free to
  grow silently. With it, accepting a new gap requires editing the checker
  too: two deliberate, visible acts.
