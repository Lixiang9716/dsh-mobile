# Agent Note: the pairing gate covers the contract directory

Status: implemented

## Problem

`.gov/pairing.json`'s include list carried only `docs/**/*.md` and the root
`README.md`, so every bilingual pair under `contract/` — the primitives table,
data protocols, and all seven D5 proposals — sat outside the pairing gate's
jurisdiction. The gate reported "11 pair(s) ok" while the directory held eight
uncovered pairs; a single-sided edit to any of them would not have turned any
gate red, and AGENTS.md rule 8's guarantee ("a PR never lands one language of
a pair alone") held only as long as the author remembered to run
`gov verify pairing --write` by hand. The independent review on PR #249
flagged this (medium): the new system-capability-plane proposal pair was
honest, but only by discipline, not by enforcement — and the socket-seam
proposal had no `.i18n.yaml` record at all.

## Decision

The include list gains `contract/**/*.md`. Turning the gate on surfaced four
real violations, each fixed in the same change:

- `contract/proposals/2026-09-28-socket-seam.md` — missing record, baselined
  with `gov verify pairing --write`;
- `contract/data-protocols.md` + zh — both sides moved (the 4c444acd era)
  after their 2026-09-19 confirmation without a re-confirm; re-confirmed;
- `contract/README.md` — no zh side existed; translated into
  `contract/README.zh.md` (with the both-ways language links the
  doc-crosslinks gate requires), the only contract artifact that was
  English-only.

The pairing gate now reports **20 pair(s) ok** (was 11). Because
`.gov/pairing.json` is a plane-sealed file, the change went through the
sanctioned re-baseline (`gov verify-plane --write --confirm-unattended`,
reason naming the PR #249 review as the authority), which appended the
consent to `.gov/rituals.jsonl` — the same ritual path the 2026-09-17/18 and
2026-09-23 rebaselines used.

## Alternatives considered

- **Excluding `contract/README.md` instead of translating it** — rejected:
  the exclusion list exists for records deliberately kept single-language
  (decisions, the postmortem index); a status surface that anchors the
  contract deliverable is exactly what rule 8's pairing convention is for,
  and the translation is 30 lines.
- **Fixing only the new proposal's record and leaving the include list
  alone** — rejected: that is the discipline-over-enforcement posture the
  review rejected; the gate existed precisely to catch the drift class the
  four violations represent (one of them, the stale data-protocols pair, had
  already happened).
- **Extending the record set without re-baselining the seal** — impossible
  honestly: the `plane` gate hashes `pairing.json`; a hand edit without
  `verify-plane --write` would fail the seal it exists to protect.

## Consequences

Single-sided edits to any contract pair now fail the pairing gate in the
default DAG (and the pre-commit content gates on staged files). Future
proposals inherit the enforcement automatically — the three-file pair
convention the proposals already follow now has teeth.
