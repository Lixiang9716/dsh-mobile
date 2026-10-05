# Agent Note: The host runners emit green-path receipts and the Android E2E suite closes its three receipt gaps on a Windows host

Status: implemented
Related: D5

## Problem

The known-gaps register (docs/e2e-matrix.md) carried seven receipt rows that
were structurally unclosable: `run-ios.sh` machines its receipt on the green
path (step 7), but the android and harmony runners had no such step, so no
re-run of theirs could ever satisfy acceptance-bar clause 3 — a gap whose own
closure recipe named a runner step that did not exist. Beyond the register,
the E2E toolchain silently assumed a POSIX host: a Windows checkout could not
stage the client-bundles records (binary-mode `shasum`, CRLF-mangled record
lines, backslash walk keys), could not resolve `bash` from Gradle
(System32's WSL launcher wins over PATH), and the composer surface refused
the turn on any device whose WebView reports a bare-"GMT" timezone. A
Windows-hosted re-run was also blocked by multi-device ambiguity once a
second emulator instance appears (`adb get-state` fails loud with no serial
pin).

## Decision

- `test/e2e/write-receipt.sh` (the shared receipt writer) grows a
  `DSH_RECEIPT_HOST` face: a non-simctl host passes its host line — the
  android runner derives serial + AVD + API from `adb`, the harmony runner
  target + HarmonyOS build from `hdc` — and the writer skips the xcrun
  query; the iOS lookup is unchanged when the variable is unset. It also
  accepts both screenshots layouts (`screens/` or loose PNGs) and pins the
  manifest-stem convention in its header (bare stems; the `f"verdict-{sid}"`
  path is the contract).
- `hosts/android/ci/run-android-full.sh` emits a receipt at the end of each
  evidence-bearing phase (officialweb-mount, session-live-read,
  composer-live-write), reachable only because `set -eu` already died on any
  failing checker. It also re-grants POST_NOTIFICATIONS after the phase-1
  install (the pre-install grant is refused on a fresh device — the notify
  leg then answers "refused by user policy"), and pins the device timezone
  to an IANA Area/Location name after `adb root` (the composer's
  session/prompt envelope carries the WebView's clientTimeZone and the
  upstream util-time wire contract admits only UTC or Area/Location — the
  AOSP default "GMT" made the turn refused with `session/invalid-time-zone`).
- `hosts/harmony/ci/run-host-e2e.sh` emits its receipt on the green path,
  recording the hdc target and HarmonyOS build the run happened on.
- The client-bundles record chain survives a Windows checkout:
  `build-client-bundles.sh` writes the computed record in TEXT mode
  (`shasum -a 256 -t` — a no-op on Unix, no `*` binary marker on Windows),
  `verify-manifest.mjs` strips a trailing CR before matching (an
  autocrlf checkout hands the committed record over CRLF) and normalizes the
  tree walk's keys via `path.sep`, and `.gitattributes` exempts
  `*.sha256` from eol conversion outright.
- `hosts/harmony/ci/check-bundle-files.mjs` normalizes its disk walk the same
  way (`split(sep)`), and the iOS bundle generator
  (`hosts/ios/Tools/gen_bundle_header.py`) pins `newline` on its writes and
  `as_posix()` on its labels — its output is byte-identical across hosts.
- `test/e2e/matrix.mjs` carries every internal path in POSIX spelling (the
  Windows join/relative backslashes broke the verdict-name test and made the
  whole inventory read as zero dirs).
- The real full `run-android-full.sh` run on the current tree (Windows host,
  local dsh-e2e AVD, API 35, `ANDROID_SERIAL` pinned) is green end to end —
  the regression trio, capability-binding, and the three evidence phases
  re-captured green with their receipts committed (`android.official-web.mount`
  14/14, `b-android.session.live` 46/46, `b-android.write.live` 45/45) — and
  the register strikes the three Android receipt rows in the same change
  (7 → 4 rows, 0 register defects).

## Alternatives considered

- Emitting the receipts from a separate post-run script instead of inside
  the runners: lost because a receipt authored outside the green path is
  exactly the synthesized receipt the acceptance bar forbids — the emission
  point IS the guarantee, so it belongs in the runner after the checkers.
- Teaching the runtime's narrowed `canonicalTimeZone` to accept bare "GMT"
  (canonicalizing it to UTC): lost because upstream's own util-time makes
  the same strict wire contract — loosening the runtime copy would diverge
  from the pinned upstream the narrowing exists to mirror. The device zone
  is environment, not contract; the runner pins it.
- Pre-seeding the emulator grant via a devices.xml snapshot or booting with
  a provisioned userdata: lost because the runner must work on a freshly
  created AVD; an idempotent `pm grant` after install is the smallest
  ordering fix.
- Hand-editing the three receipts from the committed evidence's fields: not
  a candidate — clause 3's "a receipt can never exist without a real green
  run" is the register's own reason for existing.
- Killing the duplicate emulator instance from the runner: lost because the
  second instance is a host-environment condition, not a runner defect;
  `ANDROID_SERIAL` pinning is the honest scoping (the receipt records the
  serial that actually ran).
