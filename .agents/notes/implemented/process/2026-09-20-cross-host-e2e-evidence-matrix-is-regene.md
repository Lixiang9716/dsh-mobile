# Agent Note: Cross-host E2E evidence matrix is regenerated, not maintained

Status: implemented
Related: D5

## Problem

E2E evidence accumulated across four hosts (iOS, Android, HarmonyOS,
macOS CLI) in per-host artifacts dirs with no consolidated view: whether
every E2E claim meets the acceptance bar — a green one-to-one log
verdict, screenshots only as debugging artifacts, and complete
deliverables (`logs.txt` + `scenario.jsonl` + `verdict*.json` +
`receipt.json`) — could only be answered by manually opening dozens of
files. Nothing cross-checks that each verdict's scenario id has a
manifest, that committed PNGs really are PNGs, or that a supposedly
complete dir is complete; the known `m2-gateway` receipt gap was
tribal knowledge. Without a machine-checkable inventory, the next
"are we actually green?" question re-incurs the whole audit.

## Decision

`tools/e2e/matrix.mjs` (stdlib-only) regenerates the inventory from the
working tree: every dir carrying `verdict*.json` is an evidence unit,
checked for deliverables, PNG magic bytes, and a `tools/e2e/scenarios/`
manifest per verdict scenario id; it exits non-zero on a failed verdict,
missing/empty deliverable, broken PNG, malformed verdict/receipt, or a
scenario without a manifest. Manifest-revision drift is reported
(`drift`), not failed — the verdict is the capture-time record. Its
`--self-test` mode proves every rejection class with 8 fixture
assertions (rule 6), documented in `tools/e2e/README.md`.
`docs/e2e-matrix.md` + `.zh.md` (bilingual pair) carry the consolidated
scenario × platform × verdict table, the acceptance bar, and the honest
gap list; the matrix states its as-of commit and that it is REGENERATED
(`node tools/e2e/matrix.mjs`), never hand-edited. Four real findings are
listed, not fixed: `hosts/ios/artifacts/m2-gateway/` without
`receipt.json` (pre-#26 shape, iOS-owned), `m5-host` without
`scenario.jsonl`, two harmony JPEGs named `.png`, and no committed
macOS-CLI `m2.bridge.smoke` evidence. The checker is deliberately NOT
wired into `gates.json` — the plane seal owns that decision after the
owned gaps close.

## Alternatives considered

- Hand-maintained markdown table without a checker: rejected — a matrix
  that cannot be regenerated from the tree rots on the first landed PR
  (main moved three times while this was written); the doc even says so
  and points at the command.
- Wiring `matrix.mjs` into `gates.json` immediately: rejected — four
  real findings sit in owned/in-flight areas, so gating now means a
  permanently red gate or parking it; both are worse than an honest
  documented gap list. The tool is gate-ready by construction.
- Auto-fixing the gaps (renaming the JPEGs, synthesizing
  `scenario.jsonl` from `logs.txt`): rejected — renaming breaks doc
  links in merged docs, and synthesizing an evidence file without the
  device run is fabrication; only the owning stream may re-emit
  evidence.
- A bash inventory script like `selftest.sh`: rejected — the report
  needs structured JSON (per-verdict drift fields, findings with codes)
  that shell quoting makes fragile; 259 lines of node beat a brittle
  pipeline, and `--self-test` keeps the rejection proof in-process.

## Consequences

- The acceptance bar is now answerable in one command; new evidence PRs
  can be reviewed against `node tools/e2e/matrix.mjs` output.
- The checker currently exits 1 on main (the four gaps) — intended,
  documented, and temporary: each fix flips a finding without touching
  the tool.
- When the three in-flight dirs land, regenerating the matrix folds
  them (and any new gaps) in automatically.
