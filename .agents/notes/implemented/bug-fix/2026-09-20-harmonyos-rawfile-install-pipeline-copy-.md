# Agent Note: HarmonyOS rawfile install-pipeline copy went stale when the M3 canonical moved on main

Status: implemented
Related: D6

## Problem

PR #39 (M3 completion) rewrote `runtime/spike/install-pipeline.js` (+136
lines: install-time capability negotiation, receipt journal, config layer)
while the M5 status-flip PR and the carrier/binding PR were in flight. The
byte-identical rawfile copy inside the HarmonyOS app
(`hosts/harmony/entry/src/main/resources/rawfile/spike/install-pipeline.js`)
was synced in my local reconciliation but that commit missed the merge
window: the reconciled tree's push lost the race against the PR merges, so
`main` carried a 163-line drift between the canonical and the bundled
copy. Every next HarmonyOS build would bundle the OLD install pipeline
next to the NEW canonical — silent drift, the exact failure mode the
surprise ledger already recorded for the M1 spike copy.

## Decision

The rawfile copy is refreshed from the post-M3 canonical (cmp-identical;
no other copy drifted — the full rawfile closure is re-verified against
`runtime/spike/`, `system-plugins/`, and `presentation/web-client` in the
same change). The full on-emulator E2E is re-run green on exactly this
tree: `m1.spike.boot` 7/7, `m2.bridge.smoke` 6/6, `m2.session` 23/23 —
which doubles as the on-device proof that the NEW pipeline's install-time
capability negotiation accepts the dsh-notes manifest under the smoke
descriptor (required `fsRead`/`fsWrite`, both declared available) — and
`m5.host-binding` 20/20. The regenerated artifacts land with the fix.
`ci/run-host-e2e.sh` also gains the launch-retry hardening from the
status-flip branch (a cold-booted emulator can sit on the lock screen and
silently swallow an unchecked `aa start`; the runner now wakes, unlocks,
and retries until the launch reports success within a deadline).

## Alternatives considered

- A CI gate that diffs every rawfile copy against its canonical on every
  push: the right long-term fix (drift is silent and today relies on
  discipline); filed as a wish rather than shipped here because the
  canonical↔copy mapping lives in `BUNDLE_FILES` + the staging layout and
  deserves its own design pass.
- Rebasing the merged status-flip branch to carry the sync: rejected —
  the PR was already merged; a fresh minimal fix on top of main is the
  honest corrective change (rules.md rule 12: drift found later is fixed
  as its own immediate change).
- Leaving the copy stale until the next harmony feature work: rejected —
  the whole point of the byte-identity constraint is that drift is silent;
  shipping a known-stale engine-side module is a time bomb for the next
  scenario run.
