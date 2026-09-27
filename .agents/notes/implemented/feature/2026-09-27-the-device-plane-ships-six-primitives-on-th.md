# Agent Note: the device plane ships — six primitives + the media picker live on all three hosts

Status: implemented

## Problem

Contract v1.5.0 (folded in `5e7faf5`) defined the device plane but no host
answered it: an agent on any of the three mobile hosts could not read the
device facts, give haptic feedback, use the clipboard, hand a deliverable to
another app, hold the screen awake, or pick a photo — and the whale viewer's
keep-awake need (the proposal's evidence base) stayed unmet. The task card
T-0065 named the remaining work: privileged-layer implementations + a system
plugin mount, then E2E evidence.

## Decision

All six primitives and the `presentPicker` `mode: "media"` extension are
implemented per host and driven end-to-end by ONE platform-neutral scenario
(`runtime/spike/scenario/device-plane.js`, scenario id `device.plane`), with
per-platform manifests pinning each host's honest surface:

- **iOS** (`DevicePlanePrimitives`/`ClipboardPrimitives` Swift, PHPicker
  media branch in `UIPrimitives`): descriptor 22 available. clipboardRead
  rides the SAME alert `presentApproval` uses with a standing grant
  ("Approve & Remember" persists in UserDefaults); share files resolve
  through the fs scope registry; the media pick is COPIED into the app's
  media directory and granted read-through (the library itself stays
  unreachable). Wiring collapsed into `GatewayCore.registerStandardPrimitives()`
  (one serving table = the descriptor, three seats call it).
- **Android** (`DevicePlanePrimitives`/`ClipboardPrimitives` Kotlin,
  PhotoPicker media branch in `UiPrimitives`): descriptor 23. Share files
  stage read-only through a bare-framework `ShareFilesProvider`
  (content://; no androidx — the dependency posture forbids it); the media
  pick copies into the app scope. The whole seat (drive + serving seat +
  MainActivity routing) shares the registration.
- **HarmonyOS** (`DevicePlanePrimitives.ets`, PhotoViewPicker media branch
  in `PickerPrimitives`): descriptor 15, C forward list extended, both
  descriptor constants kept equal. `systemShare` is absent from this SDK
  image so share uses the legacy sendData want; every async host call
  settles guarded (the emulator's vibrator/pasteboard/share services can
  hang their promises forever — measured), and a pasteboard that never
  reads back rejects `unavailable` rather than pretending.
- **Plugin mount**: `system-plugins/dsh-device-plane` (the npm package)
  negotiates the six capability strings and registers the `device` service
  over the gateway shim; embedded by all three hosts' embed lists.
- **E2E**: `run-ios-device-plane.sh`, `hosts/android/ci/run-device-plane.sh`
  (deterministic logcat-snapshot capture — the streamer+canary design lost
  three ways here: zombie streamers, buffer-replay completing the run
  before launch, and an fd-orphaning file rewrite), and
  `hosts/harmony/ci/run-device-plane.sh` + `drive-device-plane.mjs`
  (surface-probed BACK presses: a blind BACK exits the app and freezes the
  in-app timers). Green: `device.plane` 16/16 + audit 14/14 (iOS),
  15/15 + audit 13/13 (Android), the harmony ladder (emulator's pasteboard
  honestly `unavailable`), receipts in
  `hosts/{ios,android,harmony}/artifacts/device-plane/`.

The security-bearing behavior lives host-side by design (the approval gate,
the sheet-as-consent, the scope discipline); the plugin only adds typed
validation above the shim. Audit detail (pattern / hold / share kind /
clipboard length) rides the ONE per-call audit line via a staged-detail seam
on both iOS and Android — never payload contents.

## Alternatives considered

- **Per-platform scenario files** — rejected: the contract surface is
  platform-neutral; one scenario with per-host manifests keeps the
  expected↔logged discipline honest about exactly one difference (the
  descriptor count and the emulator's missing services).
- **Faking the emulator's dead pasteboard** (write-time caching so reads
  return the written text) — rejected: it would lie about the platform
  service and mask a real capability gap; the host rejects `unavailable`
  and the scenario walks the approval ladder without content assertions.
- **A standing clipboard grant keyed per session** — rejected: the iOS/Android
  pattern persists the grant app-scoped (UserDefaults/SharedPreferences),
  matching how a user understands "always allow"; a session-scoped grant
  would re-prompt every launch and break the ladder's third leg.
