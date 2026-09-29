# Agent Note: the mic face lands — micStart/micStop + the mic.frame channel on all three hosts

Status: implemented
Related: D5, D8

## Problem

The capability-plane proposal (v1.10.0 candidate, T-0074/#249's stack base)
defined the microphone face — `micStart`/`micStop` control + the `mic.frame`
channel — but no host answered it: an agent on any of the three mobile hosts
could not stream audio into its session. The face needed the device-plane
posture (#229): per-host privileged-layer implementations, gateway
registration, honest descriptors, one platform-neutral scenario with
per-host expected↔logged manifests, and real simulator legs.

## Decision

- **Signatures verbatim from the proposal**: `micStart(request?):
  Promise<{ streamId } | null>`, `micStop(streamId):
  Promise<{ stopped, durationMs, bytes }>`, the `mic.frame` channel events
  `{ streamId, kind: "frame", seq, bytes }` / `{ streamId, kind: "end",
  reason: "stopped" | "revoked" | "interrupted" }` (payload bytes ride
  base64 on the wire — the frozen bridge convention — and decode to
  Uint8Array in the shim, so consumers see the proposal's shapes verbatim).
- **JS shim** (`runtime/spike/gateway.js`): `micStart` registers the
  channel state the moment the host answers (no lost end event to a late
  subscriber); `micFrames(streamId)` is an AsyncIterable (the httpFetch
  body precedent); the shim routes `mic.frame`/`mic.end` bridge events by
  streamId. The bundle manifest gains the `microphone` family grant; the
  family flag gates both rows (the v1.5.0 mechanism, one flag per family).
- **iOS** (`MicPrimitives.swift`): AVAudioEngine input tap in the node's
  NATIVE format (installTap raises an ObjC exception on format mismatch —
  input taps do not auto-convert) + an explicit AVAudioConverter to
  pcm-s16le mono; drop-oldest ring (cap 16, seq minted at capture) with a
  coalesced FIFO drain onto the runtime queue; end event exactly once,
  after the last forwarded frame; interruptions end the stream
  ("interrupted"). `NSMicrophoneUsageDescription` added.
- **Android** (`MicPrimitives.kt`): AudioRecord s16le/mono, the same ring +
  drain, RECORD_AUDIO as a runtime request (the framework check first, the
  OS prompt only when ungranted; the answer rides
  onRequestPermissionsResult → MainActivity → SpikeHostM4). Manifest adds
  `android.permission.RECORD_AUDIO`.
- **Harmony** (`MicPrimitives.ets`): AudioCapturer SOURCE_TYPE_MIC,
  S16LE mono, readData accumulator emitting at the caller's frameMs with a
  4 KB per-event cap (the hostEvent bridge buffer rule, the httpFetch
  CHUNK_LIMIT precedent); requestPermissionsFromUser is the OS layer;
  `ohos.permission.MICROPHONE` declared. The C forward list and both
  descriptor constants (HostPhase.ets + gateway_smoke.cpp) gain the mic
  pair (17 available).
- **Consent layers**: the manifest's family grant is the gateway layer
  (a caller without it is denied by the v1.5.0 gateway posture — the
  runtime-prompt-for-ungranted-callers machinery belongs to the socket
  seam's approval rule, not on this base); the OS prompt is the second
  layer, automated per host (`simctl privacy grant` / `adb pm grant` /
  the drive's allow-button tap), each recorded in its runner.
- **The arm fence (iOS)**: the input AU open (`inputFormat(forBus:)` →
  installTap → engine start) can block FOREVER where the host audio route
  is wedged — measured on the dsh-iphone 26.5 simulator, where the
  Mac-side Simulator microphone grant is absent and the route reports
  healthy (`isInputAvailable=true`, a built-in mic input) yet the node
  touch never returns. The fence bounds the arm at 8 s and answers the
  honest `unavailable` (a capability gap, the emulator posture); the
  winner of the fence settles, the loser tears the half-open graph down.
  The iOS SIMULATOR leg on this machine therefore pins the refused shape
  (`mic.refused { resolved: "unavailable" }` + the unknown-id leg) — real
  PCM frames need a host whose mic route opens, which the real-device leg
  (D-g script ready) carries.
- **Audit honesty**: one record per CALL (micStart's format/rate/frameMs/
  tag, micStop's duration+bytes); frames are never per-frame audited (the
  proposal's honesty note). A pre-existing iOS-core bug surfaced and is
  fixed: failure settles left the staged audit detail pending, leaking it
  onto the NEXT call's audit line.
- **Toolchain drift fixed en route**: the new HarmonyOS CLT 26.0.0.400
  ArkTS linter fails `CompileArkTS` on the BASE branch itself (verified on
  a pristine 84fa42c5 worktree — 15 arkts-no-any-unknown errors at the
  libspike napi call sites, the unverified-module d.ts now yielding
  `any`). The explicit `: number` annotations land here because the
  harmony leg cannot build otherwise; they are mechanical.
- **Descriptors**: iOS 24, Android 25, harmony 17 — each host's table IS
  its registration (conformance §7), all three answer the mic face.

## Alternatives considered

- **Bridging frames through the frozen httpFetch-style body stream**
  (callId-keyed) instead of a named channel — rejected: the proposal names
  the mic.frame channel one-per-stream keyed by streamId; callId keying
  would leak the control-call identity into a data plane and break the
  end-event semantics.
- **Asserting seq CONTINUITY in the scenario** — rejected: drop-oldest
  makes gaps legal under pressure; monotonicity is the only honest
  consumer-side invariant (the scenario emits `monotonic` and pins that).
- **Faking the iOS simulator's wedged mic route** (silence fixtures, a
  fake armed stream) — rejected in the strongest terms: the audit and the
  E2E would lie about the platform; the host answers `unavailable` and
  the manifest pins the shape the run actually produced.
- **A second Android emulator (dsh-mic AVD) to escape the shared-emulator
  package collision between parallel capability-plane agents** — attempted
  twice; the headless second instance died with hanging QEMU threads ~90 s
  after the mic app launched both times, so the leg runs on the shared
  emulator-5554 with a bounded clean-window retry loop instead.
- **Shipping the harmony leg as executed** — rejected: this machine's
  Emulator never attaches a hdc target (no local image; the process only
  phones home to Huawei cloud), so the harmony leg is D-g: runner + drive
  + manifest ready, the manifest marked unverified until its first green
  run, no receipt claimed.

## Consequences

- The mic frame path is proven end-to-end where the host audio route
  actually opens (the frame ladder, the stop record, the exactly-once end,
  idempotence, the unknown-id leg); the iOS simulator leg proves the
  honest-unavailable ladder on this Mac. A Mac that grants Simulator
  microphone access flips the iOS leg to the armed ladder by re-running
  the runner — no code change.
- The gateway-first runtime-prompt rule (proposal §rule 2) degrades to the
  v1.5.0 denial posture on this base; when the socket seam's approval
  machinery lands, the mic rows gain the prompt layer without shape
  changes.
- Revocation (rule 3's live settings face) has no settings surface on
  this base; session-scoped default holds (the grant dies with the
  process), and interruptions/end events carry the observable half of the
  rule.
