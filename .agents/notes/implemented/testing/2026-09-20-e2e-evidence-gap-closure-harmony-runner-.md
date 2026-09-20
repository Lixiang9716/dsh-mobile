# Agent Note: E2E evidence-gap closure: harmony runner emits scenario.jsonl and real PNGs, CLI bridge-smoke evidence lands

Status: implemented

## Problem

The 2026-09-20 acceptance-bar audit (docs/e2e-matrix.md) recorded four
gaps: the harmony m5-host evidence dir had no `scenario.jsonl`; two of
its screenshots were JPEG bytes under `.png` names; m2.bridge.smoke —
whose canonical host is the macOS CLI per the e2e README — had no
committed CLI evidence; and the iOS m2-gateway dir predates the
receipt.json convention. Every evidence dir is supposed to meet the
bar: green one-to-one verdicts, real PNGs for their extensions, and
the full deliverable set (logs.txt + scenario.jsonl + verdicts +
receipt). Until they close, `tools/e2e/matrix.mjs` exits non-zero and
the matrix cannot become a gate.

## Decision

- `hosts/harmony/ci/run-host-e2e.sh` now extracts
  `scenario.jsonl` from the run's own capture files
  (`grep -h '^dsh.spike.log:'` over sink + binding captures — the
  Android runner's convention, harmony m1-spike's spelling), and after
  the drive converts both `snapshot_display` screenshots in place with
  a documented `sips -s format png` step (the emulator emits JPEG;
  evidence screenshots must be real PNGs for their names). The full
  re-run on this tree re-matched the committed manifests exactly
  (7/7, 6/6, 23/23, 20/20) and refreshed the m5-host dir + receipt.
- `runtime/spike/artifacts/macos-cli-bridge-smoke/` lands the CLI
  canonical-host evidence: real headless run of
  `scenario/m2-bridge-smoke.js` via `build/dsh-spike-cli`, logs.txt +
  scenario.jsonl + verdict.json (6/6 one-to-one) + receipt.json,
  mirroring the sibling macos-cli dirs.
- The m2-gateway receipt stays open as the matrix's single documented
  finding: the iOS WDA runtime is in its third recorded degradation
  (process note `2026-09-20-run-ios-sh-rerun-protocol-under-a-degrad`;
  its HTTP bridge refused connections again at the closure attempt),
  and that protocol says skip the re-run rather than force it.
- docs/e2e-matrix.md ± zh regenerated to the new truth (18 dirs, 33
  verdicts, 30 PNGs, 1 finding) and the pairing re-stamped.

## Alternatives considered

- Extracting m5-host's scenario.jsonl from the already-committed
  logs.txt of the old run: rejected — the audit explicitly calls that
  evidence fabrication; the extraction must run against a real run's
  captures, so the runner gained the step and the re-run produced the
  file.
- Renaming the JPEGs to `.jpeg` and fixing references: rejected —
  converting to real PNGs keeps every doc link and the
  `.png`-extension contract intact at one documented sips line; a
  rename would churn references for zero evidentiary gain.
- Hand-authoring a receipt.json for m2-gateway from its committed
  facts (no re-run): rejected — a receipt documents a run; without a
  healthy-WDA run to cite it would be a self-report, exactly what the
  acceptance bar's clause 3 is not. Left as the documented finding.
- Wiring matrix.mjs into gates.json now that only one finding remains:
  rejected — the wiring decision belongs to the plane seal; this PR
  only shrinks the findings list.
