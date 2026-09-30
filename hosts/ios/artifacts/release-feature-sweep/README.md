# release-feature-sweep — the Release configuration's feature surface, exercised

Every actionable control the Release build (`dsh-ios`, the user-facing
configuration) exposed on its first two screens, tapped once through the
WebDriverAgent accessibility tree, with a screenshot before and after each
tap. Produced by

```sh
test/e2e/ios-ui.py sweep hosts/ios/artifacts/release-feature-sweep
```

on dsh-iphone (iOS 26.5) during the v0.0.2 release regression's final run
(2026-09-30), from the plain launch of the Release `.app` the matrix's
release leg had just built — the same configuration the packages ship.

Two checklists, two questions:

- `checklist-first-run-dialog.json` — the first-run 内测声明 dialog (3 rows:
  the dialog surface, the dev-build banner behind it, the dialog container).
  The sweep captured it, then `ios-ui.py tap "继续"` dismissed the dialog.
- `checklist.json` — the main surface after dismissal: 49 controls exercised,
  35 with a visible effect (`changed: true` = a byte-difference between the
  before/after captures), 14 no-op. A no-op row is not automatically a
  defect — some controls are inert by design in some states (the ui-sweep
  precedent's reading rule) — so the rows are read together, not grepped.

This is human-auditable visual evidence, not a machine verdict: no
verdict*.json lives here by design (the e2e-matrix gate inventories only
verdict-bearing dirs). The machine-verified half of the Release leg is the
matrix's `simulator-matrix/release/` release-proof.json (drive machinery
absent, refusal by name, debug/info records absent). Real-device feature
legs (camera burst, mic revoked-ladder, BLE peer) stay script-ready and were
NOT run — no device was attached (D-g standby; scripts:
run-ios-camera-plane-device.sh, run-mic-plane-device.sh,
run-ios-ble.sh --mode device).
