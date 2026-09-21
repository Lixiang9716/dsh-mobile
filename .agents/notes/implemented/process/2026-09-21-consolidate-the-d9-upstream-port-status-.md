# Agent Note: Consolidate the D9 upstream-port status across the bilingual status docs

Status: implemented
Related: D9

## Problem

The overnight D9 correction (#47 and the PRs it seeded: #53/#54/#55/#58/#60–#67/#70/#71)
changed what this project IS — the Harness layer went from in-house reimplementation to the
upstream DSH runtime running verbatim — but the status documents a newcomer reads first
(README ±zh, ARCHITECTURE ±zh, docs/e2e-matrix ±zh) still described the project as of the
M5 milestone era. Worse, the matrix doc's committed totals (25 dirs / 51 verdicts, as-of
`052587e`) had already been made stale by #70's `d9-write-live` evidence dir, and §10 of
ARCHITECTURE carried a byte-identical duplicated "M3 pluginization" bullet (a #51 merge
accident: the bullet replaced the old one-liner instead of deleting it) while §11 still
said "D0–D8". Anyone auditing the morning after would find three documents telling three
different stories about the same tree.

## Decision

A docs-only consolidation PR (W-DOCS) re-stamps the three bilingual pairs against the
a536277 tree, every number sourced from a tool run on that tree:

- README ±zh gains an "Upstream port (D9)" subsection under Milestones: upstream DSH runs
  verbatim on quickjs (26 packages pinned + sha256-verified by
  `runtime/spike/vendor/ensure-dsh.sh`: 21 upstream DSH @ 0.1.6-alpha.2 + 5 pinned npm
  deps), the official web boot / app shell / session / composer write path live on all
  three hosts through the contract carrier, evidence linked to docs/e2e-matrix.md (26
  evidence dirs, 59 green verdicts) and the per-host artifact dirs. The milestone table
  rows are untouched — their Done claims stand on their own evidence.
- ARCHITECTURE ±zh §10 gains the D9 port bullet after M5 (what runs verbatim, the measured
  shim surface vs §3's static prediction, the official UI mount, the write path, evidence
  links); §3's shim-surface claims stay intact with a cross-reference marking them the
  285-package static worst case; §11's decision list becomes D0–D9; the duplicated M3
  bullet is deduped.
- docs/e2e-matrix ±zh are re-run against the tree (`node tools/e2e/matrix.mjs`): as-of
  `a536277`, 26 dirs / 59 verdicts / 25-of-25 manifests / 64 PNGs / 6 findings (the new
  sixth finding is the `d9-write-live` receipt owned by #70's host work stream); the
  coverage matrix gains `b-harmony.write.live` 33/33; the inventory's rcpt gap labels are
  aligned to the known-gaps list numbering (1–6) they had silently drifted from.

The card exits as void before push per the standing #329/#339 receipt-closure precedent;
the PR is the audit trail.

## Alternatives considered

- **Fold D9 into the milestone table as an "M6" row** — rejected: the table's rows each
  carry their own frozen evidence claims; rewriting one or appending a milestone row is
  mission-scope creep for a status pass, and D9 is a DECISION correction, not a new
  milestone phase. A short subsection under Milestones keeps the narrative without
  touching the frozen rows.
- **Regenerate the matrix doc verbatim from matrix.mjs output** — rejected for now: the
  checker emits JSON, not prose, and the doc's value is the editorial layer (ownership of
  findings, closed-gap history, honesty notes). Numbers were transcribed from the run;
  the prose stays hand-curated.
- **Leave the duplicated M3 bullet for a later cleanup** — rejected: it sat in the exact
  section being edited, was provably a merge accident (git -L shows #51 replacing a
  one-liner instead of deleting it), and leaving a known falsehood ("IN PROGRESS" twice)
  beside a fresh D9 status claim would undercut the consolidation's whole point.
