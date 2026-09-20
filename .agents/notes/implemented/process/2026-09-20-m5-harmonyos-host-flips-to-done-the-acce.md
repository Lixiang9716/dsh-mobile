# Agent Note: M5 HarmonyOS host flips to Done: the acceptance bar and its evidence

Status: implemented
Related: D5

## Problem

The milestone table still read "M5 In progress" after the carrier and
binding work landed, so the status documents disagreed with reality — a
reader opening README.md or ARCHITECTURE.md §10 could not tell that the
HarmonyOS host meets the M5 "Done" bar, and rule 12 makes exactly that
drift a defect: a status flip that trails the work is a second change
someone has to remember.

## Decision

README.md + README.zh.md (milestone table) and docs/ARCHITECTURE.md +
docs/ARCHITECTURE.zh.md (§10 milestones) now record M5 as Done, justified
by the on-device evidence in `hosts/harmony/artifacts/m5-host/` (PR #40,
regenerated green on the final bytes of this stack): the regression trio
(`m1.spike.boot` 7/7, `m2.bridge.smoke` 6/6, `m2.session` 23/23 — the
23-event `notes.installed` manifest) plus the event-driven binding phase
`m5.host-binding` 20/20 — loopback carrier (HTTP static + RFC 6455 WS pump
over the shared bus seam), ArkWeb mounting the Web Client with token
deltas streaming live, notify + presentApproval real, fsScope app-scope
v1, `app.state`/`notify.response` channels, and the descriptor-declared
honest `unavailable` set (presentPicker/keychainGet/keychainSet/
httpFetch). The rows name the honest v2 leftovers (HUKS keychain,
user-scope picker fs, httpFetch streaming) so "Done" cannot be read as
"nothing open". The duplicate superseded M4/M5 status rows accumulated in
§10 (a leftover from the #38 table dedupe, which covered only the README
table) are consolidated to one M4 line and one M5 line in both languages.
Pairing for both document pairs is re-confirmed via
`gov verify-pairing --write` in the same change.

## Alternatives considered

- Flipping M5 to Done inside the carrier/binding PR itself: rejected —
  that PR is reviewed on its code; the status flip is the completion
  record and lands as its own reviewed change citing the merged-state
  evidence (and the PR-A run had to be regenerated once more before the
  final push, which would have made the flip trail its own evidence).
- Writing "Done" without the still-open v2 list: rejected — the honest
  `unavailable` decisions (contract §7: absence is information) are part
  of the conformance claim; a bare "Done" would invite assuming full
  nine-primitive parity with iOS.
- Deleting the stale duplicate M4/M5 rows outright without replacing
  them: rejected — the section keeps one M4-in-progress line because M4
  (Android) is a sibling work stream still open; consolidating to zero
  would erase a live status.

## Consequences

- Every status surface (README table, ARCHITECTURE §10, host README,
  artifacts receipt) now agrees that M5 is Done; the remaining M5 v2
  surface is named in the rows themselves rather than a tracker.
- The mission task card for this work is exited (`gov task void --reason`)
  in the same push, per the receipt-closure dead-end precedent.
