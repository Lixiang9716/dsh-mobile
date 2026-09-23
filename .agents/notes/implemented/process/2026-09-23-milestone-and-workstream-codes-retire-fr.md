# Agent Note: milestone and workstream codes retire from the documentation

Status: implemented

## Problem

PR #145 retired milestone codes from the live surfaces (scenario and runner
names), but the human-facing documentation still spoke in codes: the README
milestone table's Phase column was literally `M0`–`M5`, ARCHITECTURE §10
titled every bullet with one, and workstream codes (`W-LLM`, `W-INTEG`,
`W-SHELL`, `W-GR`, `FILE-TOOLS`, `PR-A`/`PR-B`) peppered the carrier
contract, the e2e guides, the vendored-port README, and the hosts' READMEs.
A reader meeting "the M4 httpFetch binding" had to recover the mapping from
git history. Worse, the Chinese ARCHITECTURE milestone section had drifted
independently: its second-milestone bullet still said the real LLM API was
open (the English side says DONE with evidence), a stale duplicate
third-milestone bullet sat after the Android/HarmonyOS one, that bullet
carried a copy-paste duplication inside itself, and the D9 upstream-port
bullet was missing entirely.

## Decision

Every human-facing markdown file names milestones and workstreams in words —
the contract freeze, the runtime and host spikes, the first on-device
session, the plugin system, the Android host, the HarmonyOS host; the LLM
transport / web integration / application-shell legs; "the file-tools row";
follow-up phases instead of PR-A/PR-B. Three classes of identifier are
deliberately kept verbatim: artifact-directory and scenario-id citations
that quote on-disk records (`m2.llm 19/19` in the e2e evidence tables,
`hosts/*/artifacts/m4-complete/`), decision addresses (D9), and task-card
addresses (T-0035) — renaming those would falsify citations to records that
still exist under those names. The Chinese milestone section is rewritten to
parity with the English side, which absorbs the four drift defects listed
above. 21 files across README, ARCHITECTURE, the carrier contract, the
desktop-plugins and e2e-matrix pairs, AGENTS.md, the contract headers, the
three host READMEs, the runtime and system-plugins and presentation
READMEs, and the client-bundles PROVENANCE.

## Alternatives considered

- **Keep the codes and add a legend table mapping them to names** — rejected:
  a legend is one more indirection and still makes every reader translate;
  the names are not longer than the codes plus the legend hop.
- **Rename the artifact directories and historical scenario ids too** —
  rejected: they are evidence records cited by receipts, past runs, and the
  e2e-matrix tables; renaming them falsifies citations to records that exist
  under those names on disk. The docs quote them; they do not adopt them.
- **Fix only the English side and leave the Chinese drift** — rejected: the
  pairing rule requires both sides of a pair to move together, and the
  drifted state (stale statuses, duplicated bullet, missing D9 entry) was
  misinformation, not just style.
