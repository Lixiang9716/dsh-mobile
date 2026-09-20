# Agent Note: run-ios.sh emits receipt.json on green; stage-once pre-stage protects the provider index

Status: implemented
Related: D5

## Problem

`hosts/ios/artifacts/m2-gateway/` is the last evidence-matrix finding
(gap 1): four green verdicts, logs, and scenario captures, but no
`receipt.json`, because the dir predates the #26 receipt convention and
the acceptance bar forbids synthesizing a receipt — it must come from a
real run. Two runner defects kept blocking that run:

1. The pre-stage REWROTE the picker target (`Documents/gateway-e2e/
   notes.txt`) unconditionally on every run. Observed live 2026-09-21:
   the file staged at 04:52 surfaced as a picker-search tile at 04:55;
   the 04:58 run rewrote it immediately before the drive and the search
   returned 未找到相关结果 — a rewrite knocks the target out of the
   Files-provider search index until re-index completes (surprise
   `run-iossh-attempt-with-correct`). The documented next-attempt
   recipe is "stage once, let the index settle, then run".
2. Nothing in `run-ios.sh` produced a receipt even on a green run, so
   every future green run would still close the finding only by hand,
   inviting the synthesis the acceptance bar forbids.
3. The picker drive never EXECUTED the search it typed: on the iOS 26.5
   sheet, delivering "notes" through the proven WDA focus+/value path
   renders only the 名称包含 suggestion row — the results view appears
   only after the keyboard return (observed live: caret up, field
   filled, suggestion row only, and the blind tile press hit blank
   space until the scenario watchdog expired).
4. The summary could PASS on STALE verdicts: `run_check ... || true`
   masked a checker failure, and the summary greps whatever verdict
   file is on disk — in a non-interactive shell (nvm-managed node off
   PATH) every checker no-op'd with "node: command not found" while the
   summary PASSed all four scenarios on the PREVIOUS run's verdict
   files.

## Decision

- `run-ios.sh` now STAGES ONCE: it creates `notes.txt` only when the
  file is missing and logs "already staged — untouched" otherwise, so a
  pre-settled, provider-indexed copy survives the pre-stage.
- `drive_picker` SUBMITS the search between typing and the tile press:
  a new `wda_submit_search` appends "\n" through the same locale-independent
  element /value endpoint (keyboard return = submit; the results view
  rendered immediately when verified live), with a
  `05b-picker-results.png` screenshot marking the submitted state.
- The checker path FAILS LOUD: the runner aborts before the drive when
  node is not on PATH, and `run_check` removes its target verdict first
  so a failed checker can never leave the previous run's verdict behind.
- After the summary loop (which already `die`s on any failing checker),
  the runner machine-authors `receipt.json` into the artifacts dir in
  the established evidence format (host/engine/phase/launch
  Configuration/tree/scenarios/runner/screens/regressions/timestamp/
  exitCode), with scenario id/event-count/pass pulled from the four
  verdict JSONs of THIS run and the tree line citing the exact commit
  the runner executed. The step is reachable ONLY after all four
  checkers passed, so a receipt can never exist without a real green
  run.

## Alternatives considered

- Polling the Files app search inside the runner to "verify the index
  settled" before the drive: lost — the Files-app global search and the
  app's document-picker search are different surfaces (the global search
  stayed 未找到 for a file the picker surfaced minutes after staging),
  so the probe's verdict would be unreliable while adding a fragile
  second UI drive to the runner. Stage-once + a settled copy reproduces
  the observed-green conditions directly.
- Authoring the receipt by hand after the run (the b3 closure's
  approach): lost for this dir — b3's receipt was written once from one
  run's facts by the agent; the m2-gateway runner is the recurring
  full-drive entry point, so baking emission into the green path makes
  every future receipt run-derived by construction.
- Keeping the unconditional rewrite but sleeping before the drive:
  lost — rule 8 forbids clock-waits over conditions, and a rewrite plus
  a timed pause still races the provider's re-index.
