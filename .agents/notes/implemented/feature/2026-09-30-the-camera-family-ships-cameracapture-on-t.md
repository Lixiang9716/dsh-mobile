# Agent Note: the camera family ships — cameraCapture lives on all three hosts, the recording shapes answer honestly

Status: implemented
Related: D5, D8; the device-plane fold (v1.5.0); the system capability plane
proposal (2026-09-30, v1.10.0 candidate)

## Problem

The capability-plane proposal reserved the camera family's v1 implementation
face — the capture burst — and phased its two recording shapes. No host
answered any camera row: an agent could not see, the negotiation floor
answered nothing (the rows did not exist), and the per-host OS declarations
(NSCameraUsageDescription / android.permission.CAMERA /
ohos.permission.CAMERA) were carried by no manifest.

## Decision

`cameraCapture` is implemented per host and driven end-to-end by ONE
platform-neutral scenario (`runtime/spike/scenario/camera-plane.js`, scenario
id `camera.plane`), with the expected↔logged manifests pinning each host's
honest surface:

- **iOS** (`CameraPrimitives.swift`): AVFoundation photo session, burst
  clamped to a host-declared range (1…8), frames written into the media
  read-through scope directory (the v1.5.0 picker posture) and granted a
  user scope; the OS prompt is the second consent layer with a
  `camera-permission` ui-marker hook; an OS refusal resolves null; a camera
  absence (every simulator) rejects `unavailable`.
- **Android** (`CameraPrimitives.kt`): camera2 headless JPEG burst via
  ImageReader (no androidx — the dependency posture forbids CameraX), the
  runtime CAMERA request resumed through MainActivity's
  onRequestPermissionsResult, frames staged under
  `profiles/default/media-picks/` in the app scope.
- **HarmonyOS** (`CameraPrimitives.ets`): CameraKit PHOTO-scene session,
  frames landed under `<filesDir>/spike-fs/captures/` (the C backend's app
  scope), every settle guarded (the dead-promise posture the emulator's
  services taught us).
- **The phased rows are registered to answer `unavailable`** — never
  `denied`: `cameraRecordStart`/`Stop` carry contract shapes but no
  implementation, so each host's descriptor names them in its `unavailable`
  array AND their handlers reject with `unavailable` + the phased message
  (the audit's verdict is `granted/unavailable`, not a fake permission
  refusal). The family flag `camera` gates all three rows.
- **HarmonyOS consent layer**: the smoke backend carries no family-flag
  table, so the gateway layer's consent surface IS the custom approval
  dialog — `cameraCapture` asks through the SAME presenter presentApproval
  uses (the clipboardRead precedent, wired in HostPhase) before the OS
  permission request; a declined presenter settles null. The host carries
  no audit stream (the device-plane posture — nothing pretended).
- **E2E**: the simulator leg (iOS) walks the denial legs without content
  assertions and is green (6/6 + audit 3/3); the Android leg REALLY captures
  on the emulator's virtual camera (8/8 + audit 5/5; burst 2 frames /
  44157 bytes / 457 ms; the maxBytes leg drops both over-cap frames —
  dropped, never truncated); the harmony and iOS device legs are D-g
  one-click scripts (skip-loud with no device, no synthesized evidence).
  Audit detail (count/requested/totalBytes/dropped/flash/durationMs) rides
  the staged-detail seam; the harmony host carries no audit stream (its
  device-plane posture — nothing pretended).

## Alternatives considered

- **Registering only `cameraCapture`, leaving the record rows absent** —
  rejected: an absent row settles `denied`, which reads as a permission
  refusal; the proposal's negotiation floor says hosts without an
  implementation answer `unavailable`, and the descriptor's unavailable
  array is the honest declaration a caller can negotiate on.
- **A `dsh-camera-plane` system plugin** (the dsh-device-plane symmetry) —
  deferred: the plugin mount adds the service face for upstream consumers;
  the camera line's security-bearing behavior lives host-side (the OS
  prompt, the scope discipline) and the scenario consumes the gateway shim
  directly. The plugin lands with the first real consumer, not speculatively.
- **Driving the OS prompt on the Android emulator leg** — rejected for v1:
  the emulator's permission dialog is drivable but the burst leg's
  deterministic evidence wants a pre-granted headless run; the OS-prompt
  ladder is the device scripts' business (the `camera-permission` marker is
  already emitted for it).
- **Faking the iOS burst with a seeded library image** (the media-picker
  seed precedent) — rejected: the picker's seed proves the PICKER; a seeded
  "capture" would lie about the camera. A simulator without a camera
  answers `unavailable`, and the real burst awaits real hardware.
- **A single-slot burst accumulator** (the first draft) — rejected in
  review: the serial work queue only orders the handlers' synchronous
  heads; the AVCapture delegate tail runs elsewhere, so overlapping calls
  hung the first caller's promise and billed its frames to the second
  burst. The shipped state is PER-CALL, keyed by the photo settings'
  uniqueID, with a 20s deadline that settles `unavailable` (rule 8: the
  wait carries its deadline; a dead promise was the failure it prevents).
- **The NSCameraUsageDescription in the generated App/Info.plist** —
  silently dropped by every `gen.sh`: xcodegen REGENERATES that file from
  project.yml's `info.properties`, which is the only durable home for the
  key (the review caught the tree/body mismatch; the built app's plist is
  the proof, grep it after a build).
