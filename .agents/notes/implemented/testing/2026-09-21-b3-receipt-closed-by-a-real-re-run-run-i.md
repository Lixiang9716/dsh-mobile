# Agent Note: b3 receipt closed by a real re-run; run-ios.sh picker/WDA fixes re-diagnose the m2-gateway receipt blocker

Status: implemented
Related: D5

## Problem

The evidence matrix (tools/e2e/matrix.mjs) exited non-zero on five
MISSING_DELIVERABLE findings, two of them iOS-owned:
`hosts/ios/artifacts/b3-session-live/` and the long-standing
`hosts/ios/artifacts/m2-gateway/` both carried green verdicts, logs, and
scenario captures but no `receipt.json` — the acceptance bar's third
clause treats the receipt as a deliverable, so the findings block any
future decision to gate on the matrix. The m2-gateway receipt was
believed blocked on a degraded WebDriverAgent runtime (three recorded
evening degradations, rerun protocol note 2026-09-20); the b3 receipt
had simply never been authored after its evidence landed. Meanwhile the
committed evidence predates the current main, so a re-run had to
reproduce the scenarios green on final code before any receipt could
honestly be written — receipts are run-derived records, never
synthesized.

## Decision

b3-session-live: `run-ios-b3.sh` re-run on final main (`618f2f8`,
fresh worktree) reproduces b3.session.live 46/46 green (expected ==
logged, exit 0); the dir's logs/scenario/screens are refreshed from
that run and its `receipt.json` is authored from it in the established
evidence format (host/engine/phase/scenarios/proves/runner/screens/
regressions/exitCode). The cold-worktree run exposed a runner ordering
gap, now documented in the note-bearing surprise ledger: the app
bundle's build phase needs the vendored DSH closure
(`runtime/spike/vendor/dsh/…`), which is untracked bytes that
`run-ios-b3.sh` only materializes at step 4b — after the build at step
3; the workaround (run `runtime/spike/vendor/ensure-dsh.sh` first) is
recorded rather than papered over.

m2-gateway: the WDA blocker was half an illusion — run-ios.sh's own
`wda_up` probe was silently broken by the Sep 20 WDA rebuild, whose
`/status` payload is now pretty-printed (`"state" : "success"`) while
the probe grepped the compact form; a healthy server burned the 600s
bootstrap window twice and was pkilled mid-run. run-ios.sh now matches
both spacings, focuses the Files picker search field through a WDA
element click (coordinate taps never focus it — verified live), types
through the element `/value` endpoint, and carries re-derived
PT_SEARCH/PT_FILES_TILE constants from tonight's screenshots. With WDA
healthy, the run reproduces every leg green up to `presentPicker`
(events 0–7 one-to-one); the sole remaining blocker is the
Files-provider search index (the pre-staged notes.txt surfaces after
one staging but not when rewritten immediately before the drive). Per
the rerun protocol the stall was recorded, not retried; the m2-gateway
receipt finding stays open in docs/e2e-matrix.md ±zh with this precise
diagnosis and the next-attempt recipe (stage once, let the index
settle), and the matrix totals/coverage/inventory tables are
regenerated to the tree's truth (23 dirs / 43 verdicts / 22 of 22
manifests / 4 findings).

## Alternatives considered

- Authoring the m2-gateway receipt from the committed base run's
  artifacts instead of a re-run — rejected: the receipt's value is that
  it records a run; backfilling one from evidence its runner never
  emitted would synthesize provenance the dir does not have (and the
  doc would have to lie about where it came from).
- Retrying the picker leg until the provider index cooperated —
  rejected per the rerun protocol: each attempt costs 10+ minutes and
  the failure is environmental, not code-dependent; the protocol exists
  precisely to stop the third blind retry. The index-timing recipe is
  recorded for the next healthy attempt instead.
- Forcing the receipt gate green by relaxing matrix.mjs's
  MISSING_DELIVERABLE class for pre-convention dirs — rejected: it
  would weaken the acceptance bar for every future dir to excuse two
  known ones, and the checker is deliberately ungated until the plane
  seal decides.
