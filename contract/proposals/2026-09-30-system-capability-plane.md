# Proposal: the system capability plane — camera, microphone, and BLE behind one OS-permission model (v1.10.0 candidate)

> **Status: DRAFT (D5 proposal — nothing frozen, nothing implemented).**
> English | [简体中文](2026-09-30-system-capability-plane.zh.md)

## Motivation

The contract reserved this round twice. The device-plane fold (v1.5.0) named the
deferred surface in its own §8: *"Location, camera, microphone, sensors, contacts
and full Photos-library access remain out — each demands an OS permission prompt
whose lifecycle deserves its own design round."* The event-channel proposal
(v1.6.0 candidate) repeated the curation for its source table: sensor sources
that demand OS permission prompts are *"explicitly out — each permission
lifecycle deserves its own design round."* The design round is now.

The consumer is the same one every other seam answered: an agent that can *see*
(capture what the camera points at into its session), *hear* (stream audio to an
in-session transcriber), and *reach* (talk to the BLE devices next to the phone)
has no primitive for any of it — the media picker (v1.5.0) reaches only the
photos the user hand-picks, and one-shot `deviceInfo` cannot carry a camera
frame, a microphone sample, or a nearby device. The v1.6.0 seam already carries
the delivery discipline for device streams; what is missing is the capability
layer underneath it.

This proposal adds the **system capability plane**: three OS-permission-backed
capability families — camera, microphone, BLE — over one authorization model,
everything through the gateway audit. The owner directive (2026-09-30) sets the
v1 scope at all three families, full surface:

1. **Camera** — the capture **burst** (`cameraCapture`) is the v1 implementation
   face. The **continuous frame stream** and **video recording** have their
   interface shapes specified here and are **phased**: the shapes land with this
   contract, their implementations follow as their own changes — the shape is
   not cut, only the delivery date.
2. **Microphone** — streaming audio frames over the v1.6.0 event-channel seam:
   `micStart`/`micStop` control + a frame event sequence (D8: no polling, no
   blocking whole-result API).
3. **Bluetooth** — **BLE only**: scan, connect, GATT read/write, and notify
   (notify as events). Classic Bluetooth is a named non-goal.

## The authorization model (five rules)

1. **One grant family per capability, reusing the v1.5.0 family-flag mechanism.**
   Three capability strings — `camera`, `microphone`, `ble` — are siblings, not
   copies of anything: holding one implies nothing about the others, and a
   profile declares them in its manifest (`capabilities.required` /
   `capabilities.optional`) exactly as every flag since v1.0.0. The gateway
   checks before dispatch.
2. **Two consent layers, gateway first.** The gateway grant and the OS
   permission are distinct layers. A caller without the family grant gets the
   runtime approval prompt (the same surface `presentApproval` uses — the
   socket seam's "out-of-scope call raises a prompt" rule); only a caller the
   user approved at the gateway layer reaches the OS prompt. The host maps an
   OS-level refusal to `denied` and the audit record says which layer refused —
   neither layer is a substitute for the other.
3. **Session-scoped by default; revocation is live.** A grant dies with the
   session; a persistent grant requires the user's explicit "remember" (the
   clipboardRead standing-grant posture, v1.5.0). The user can review and
   revoke per profile in settings (the socket seam's third grant source), and
   revocation takes effect immediately: open streams are closed (microphone
   stopped, camera work ended, BLE connections dropped), later calls reject
   `denied` — fail loud, never silently degraded.
4. **Everything through the gateway audit.** Every call logs one record
   (caller identity, permission verdict, outcome) extended with the three
   fields this plane exists to carry: **direction** (what flows where —
   capture-in, audio-in, GATT read vs write, scan), **duration** (mic streams
   and scans log their wall-clock span at stop), and **byte counts** (frames,
   GATT payloads, photo sizes as counts — never contents). Pixels, audio
   samples and GATT values are payload bytes; the audit carries their numbers,
   not their bytes.
5. **Foreground sessions only.** No background capture of any kind: a host
   suspends delivery and capture while backgrounded (the event-channel seam's
   no-delivery-while-suspended rule, extended from delivery to capture), D7
   checkpoints carry sessions, never live streams, and no host-mode entitlement
   (background audio, bluetooth-central) is asked for. A user sees the OS
   capture indicator exactly while a session holds the capability.

## The primitives (eleven, plus two channels — two more shapes phased)

All follow the additive rule of v1.1.0–v1.5.0: a `gateway@1` host without the
plane keeps negotiating and answers each `unavailable`. Capability negotiation
stays the only platform difference — there is no `hostType` branch anywhere.

### 1. `cameraCapture` — one capture burst (grant `camera`) — v1 implementation face

```ts
export type CameraCaptureRequest = {
  count?: number;          // burst size, default 1; host clamps to a declared range
  format?: "jpeg";         // v0: one closed format, specified at fold time
  flash?: "off" | "auto" | "on";   // host may honor, clamp, or ignore with honest metadata
  maxBytes?: number;       // per-frame cap; a frame over it is dropped, not truncated
  tag?: string;            // caller-chosen audit tag, the timer precedent
};
export type CapturedPhoto = {
  scope: ScopeHandle;      // host-owned capture scope, read back via the fs primitives
  path: string;            // scope-relative, the fsRead discipline
  bytes: number;           // size for the audit's byte count
  width: number;
  height: number;
  format: "jpeg";
  capturedAt: string;      // ISO-8601 UTC
};
export declare function cameraCapture(request?: CameraCaptureRequest): Promise<
  { photos: CapturedPhoto[] } | null>;
```

Captures a burst of `count` photos from the device camera and lands each in the
host's capture scope — the same read-through-scope posture the v1.5.0 media
picker uses (`mode: "media"`): the pixels are ordinary files the fs primitives
can read, the camera is never a raw pixel pipe. Resolves once every frame is
captured; user refusal at either consent layer resolves `null`; a device
without a camera rejects `unavailable` (a capability gap negotiation should
have caught). The whole burst is one call, one audit record (count, total
bytes, duration, flash decision).

### 2. `cameraFramesOpen` / `cameraFrameClose` — continuous preview frames (grant `camera`) — shape now, implementation phased

The stream rides the v1.6.0 seam's own subscription pair, not new control
primitives: `channelOpen` gains a `"camera"` **source** in its closed, versioned
source table, with `hz` clamped to a host-declared range and the per-source
closed schema (a timestamped, sized frame reference — frame *handles* into the
capture scope, not raw pixels through the channel) specified at fold time in
`data-protocols.md`, exactly as `motion` and `battery` are. `cameraFrameClose`
is `channelClose`. **The shape is part of this proposal; the implementation is
phased after the capture burst** — a `gateway@1` host answers `unavailable`
for the `"camera"` source until then, and nothing else about the seam moves.

### 3. `cameraRecordStart` / `cameraRecordStop` — video recording (grant `camera`) — shape now, implementation phased

```ts
export type CameraRecordRequest = {
  maxDurationMs?: number;  // host clamps to a declared range
  withAudio?: boolean;     // requires the `microphone` grant too when true
};
export declare function cameraRecordStart(request?: CameraRecordRequest): Promise<
  { recordingId: string } | null>;
export declare function cameraRecordStop(recordingId: string): Promise<
  { recording: CapturedPhoto }>;   // one file, same scope discipline
```

Shapes only — **phased implementation, non-goal for the first implementation
line**. Recorded with them now so the v1 shape does not foreclose the v2 one:
the recording is one file in the capture scope (the fs discipline), audio
recording requires BOTH grants (the two-layer rule applied twice), `cameraRecordStop`
carries the duration and byte count the audit logs, and a revoked grant stops
an in-flight recording (rule 3).

### 4. `micStart` / `micStop` — streaming audio (grant `microphone`) — v1

```ts
export type MicStartRequest = {
  format?: "pcm-s16le";    // v0: one closed format, specified at fold time
  sampleRate?: number;     // host clamps to a declared range
  channels?: number;       // default 1
  frameMs?: number;        // chunking, default host-declared
  tag?: string;            // the audit tag
};
export declare function micStart(request?: MicStartRequest): Promise<
  { streamId: string } | null>;
export declare function micStop(streamId: string): Promise<
  { stopped: boolean; durationMs: number; bytes: number }>;
```

`micStart` resolves when the stream is **armed**, not when audio flows — the
`timerSchedule` posture. `micStop` is idempotent (`{ stopped: false }` for an
unknown or already-stopped id, the `timerCancel` shape) and is the record that
carries the stream's duration and byte count for the audit. Revocation (rule 3)
stops the stream host-side; the consumer observes the `end` event.

### 5. The `mic.frame` channel (the v1.6.0 event-channel seam) — v1

One channel per stream, carrying:

- `{ streamId, kind: "frame", seq, bytes }` — one audio chunk per event,
  decoded by the consumer per the negotiated format;
- `{ streamId, kind: "end", reason: "stopped" | "revoked" | "interrupted" }` —
  published exactly once when the stream ends.

The seam's delivery rules apply with one honest adaptation: audio chunks are
order-sensitive samples, so the coalescing rule degenerates to **drop-oldest
under pressure** — the host keeps a bounded ring, `seq` advances past dropped
frames, and a consumer that cannot keep up sees honest gaps in `seq`, never a
growing queue. No delivery while suspended (rule 5); events dispatch onto the
caller's serial queue like every host event (D2, D8).

### 6. The BLE face — scan, connect, GATT (grant `ble`) — v1

Eight calls, each one audit record (direction + byte counts where bytes flow):

```ts
export type BleScanRequest = {
  serviceUuids?: string[]; // advertised-service filter; omit = all
  timeoutMs?: number;      // host clamps; the scan also ends itself at timeout
  tag?: string;
};
export declare function bleScanStart(request?: BleScanRequest): Promise<
  { scanId: string } | null>;
export declare function bleScanStop(scanId: string): Promise<{ stopped: boolean }>;

export declare function bleConnect(deviceId: string): Promise<
  { connectionId: string } | null>;
export declare function bleDisconnect(connectionId: string): Promise<
  { closed: boolean }>;

export declare function bleRead(connectionId: string, service: string,
  characteristic: string): Promise<{ bytes: Uint8Array }>;
export declare function bleWrite(connectionId: string, service: string,
  characteristic: string, bytes: Uint8Array,
  opts?: { response?: boolean }): Promise<{ written: boolean }>;
export declare function bleSubscribe(connectionId: string, service: string,
  characteristic: string): Promise<{ subscribed: boolean }>;
export declare function bleUnsubscribe(connectionId: string, service: string,
  characteristic: string): Promise<{ subscribed: boolean }>;
```

- **Scan** is armed, not performed: `bleScanStart` resolves when the radio scan
  is armed (the `micStart` posture), devices arrive as events, and the scan
  ends at `timeoutMs` or `bleScanStop`. `deviceId` is an opaque string minted
  by the host from the scan — a token, never an address the caller parses.
- **Connect** resolves `{ connectionId }` once the GATT link is up, `null` on
  user refusal or a device that walked away; `bleDisconnect` is idempotent.
- **GATT** read/write address `(connectionId, service, characteristic)` —
  opaque UUID strings, host-validated; `bleWrite`'s `opts.response` picks
  write-with-response vs write-without-response. `bleSubscribe` arms
  notifications; values arrive as events, never polled (D8).
- **Revocation** (rule 3) drops every connection and stops every scan the
  profile holds; the consumer observes `disconnect` events.

### 7. The `ble.event` channel (the v1.6.0 event-channel seam) — v1

One channel per BLE session object (a scan or a connection, the socket seam's
one-channel-per-server posture), carrying:

- `{ scanId, kind: "device", deviceId, name?, rssi, serviceUuids? }` — one
  advertisement batch per event, the scan's data face;
- `{ connectionId, kind: "notify", service, characteristic, bytes }` — one
  notification payload per event;
- `{ connectionId, kind: "disconnect", reason }` — published exactly once when
  the link drops (peer walked away, host revoked, radio lost).

No polling anywhere (D8); events dispatch onto the serial queue (D2).

## Permission and audit summary

| primitive / channel | grant family | consent | audit record |
| --- | --- | --- | --- |
| `cameraCapture` | `camera` | gateway prompt → OS prompt | count, total bytes, duration, flash |
| `channelOpen("camera")` | `camera` | gateway prompt → OS prompt | source + hz + tag |
| `cameraRecordStart` / `Stop` | `camera` (+`microphone` when `withAudio`) | gateway prompt → OS prompt | duration, byte count at stop |
| `micStart` / `micStop` | `microphone` | gateway prompt → OS prompt | duration + bytes at stop |
| `mic.frame` | (arm state) | — | **not audited per frame** — see the honesty note |
| `bleScanStart` / `Stop` | `ble` | gateway prompt → OS prompt | scan span at stop |
| `bleConnect` / `Disconnect` | `ble` | gateway prompt → OS prompt | device token, outcome |
| `bleRead` / `bleWrite` | `ble` | — (connection grant) | direction + byte count |
| `bleSubscribe` / `Unsubscribe` | `ble` | — (connection grant) | characteristic tuple |
| `ble.event` | (arm state) | — | **not audited per event** — see the honesty note |

**Audit honesty (the `ishRun` rule, §6; the event-channel's per-event rule).**
Per-frame and per-notification audit does not exist and must not be pretended:
a microphone at host-clamped rates and an active BLE link produce more records
per second than any audit sink should carry. The trail is the open/close,
start/stop, connect/disconnect and subscribe records — with duration and byte
counts — plus the `seq`/event continuity the consumer observes. A host offering
this plane states in its descriptor that event *delivery* is not per-call
audited; the grants gate the *capability*, and every *call* is what carries a
record.

## Host availability and the OS declarations

No host is REQUIRED to implement any family — the descriptor is the difference,
and there is no `hostType` branch anywhere. A host that offers a family must
carry that family's OS declarations below; a host missing one declares the
capability absent in its descriptor (absence is information, §7), because a
missing declaration is a build-time fact, not a runtime error to crash on.

**Appendix: per-host OS permission declaration checklist**

| capability | iOS (`Info.plist`) | Android (manifest + runtime) | HarmonyOS (`module.json5`) |
| --- | --- | --- | --- |
| `camera` | `NSCameraUsageDescription` | `android.permission.CAMERA` (runtime request) | `ohos.permission.CAMERA` |
| `microphone` | `NSMicrophoneUsageDescription` | `android.permission.RECORD_AUDIO` (runtime request) | `ohos.permission.MICROPHONE` |
| `ble` | `NSBluetoothAlwaysUsageDescription` (legacy `NSBluetoothPeripheralUsageDescription` only where the deployment target still reads it) | API 31+: `android.permission.BLUETOOTH_SCAN` + `android.permission.BLUETOOTH_CONNECT` (runtime request); legacy API ≤ 30: `BLUETOOTH` + `BLUETOOTH_ADMIN` | `ohos.permission.ACCESS_BLUETOOTH` (plus the location permission the OS ties to discovery, where the SDK image demands it) |

The repo's hosts today declare none of these (`hosts/ios/App/Info.plist` has no
usage-description keys; the Android manifest carries `INTERNET`,
`POST_NOTIFICATIONS`, `VIBRATE`; the Harmony module carries `INTERNET`,
`VIBRATE`, `READ_PASTEBOARD`) — each implementation line adds exactly its own
rows, and the strings a user reads at the OS prompt are host-owned chrome, not
contract surface.

## What v1 deliberately excludes (named non-goals)

- **Video-recording implementation**: the shape is specified above (phased);
  the first implementation line ships the capture burst only.
- **Classic Bluetooth** (SPP/SCO/A2DP profiles): a different grant class with a
  different risk shape — audio routing and raw byte pipes to non-discoverable
  peers; named, not designed. BLE only.
- **Background / persistent capture**: no background modes are requested and no
  stream outlives its session (rule 5) — capture while backgrounded is
  suspension, not a feature.
- **Raw camera control** (manual exposure, focus, RAW formats): the burst is
  the v1 face; a dials-and-knobs API is a different proposal.
- **location, sensors, contacts, full Photos-library access**: the **v2
  queue** — each named for its own OS-permission design round, none designed
  here. This proposal deliberately does not size them; restraint is the point
  of the narrow table (§8).

## Alternatives considered

- **One grab-bag primitive (`systemCapture(action, args)`)** — rejected in the
  strongest terms, the device-plane's own reasoning: capabilities must be
  individually refusable and auditable; a grab-bag hides which capability a
  call exercised.
- **Microphone and BLE as `channelOpen` sources only** (no dedicated
  start/stop/connect primitives) — examined and rejected: the seam's
  `channelOpen` opts (`{ hz, tag }`) cannot carry an audio format, a scan
  filter, or a GATT tuple, and permission prompts with OS lifecycle want
  explicit control calls to audit. The forkpty face set the precedent this
  proposal follows: a dedicated control face over the seam's delivery rules.
- **Photo bytes through the gateway response** — rejected: payload bytes ride
  the fs scope discipline (the media-picker precedent); the audit carries
  counts, never pixels.
- **Including Classic Bluetooth for completeness** — rejected for v1: it
  doubles the permission surface for capabilities nothing in the creation-mode
  demand asks for; naming it a non-goal keeps the round honest.
- **Waiting for v2 to design all six families at once** — rejected: three
  families have standing demand and a settled delivery seam today; the queue
  stays queued, and its designs will cite their own evidence when their round
  comes.

## Verification plan

- Negotiation floors first: all three hosts answer `unavailable` for every
  family until implemented; no current behavior changes. The three
  implementation lines (camera, microphone, BLE) branch off this proposal as
  their stack base and land per family with per-platform manifests pinning each
  host's honest surface (the device-plane scenario pattern: one
  platform-neutral scenario, per-host expected↔logged manifests).
- Each family's E2E asserts on structured logs with a unique `scenario-id`:
  capture burst (frames land in the capture scope and read back through
  `fsRead`), mic stream (`start → seq-continuous frames → stop` with the
  stop record's duration/bytes), BLE (scan → connect → read/write/notify
  ladder; an emulator without a radio answers `unavailable` honestly and the
  ladder walks the denial legs without content assertions — the harmony
  pasteboard posture).
- The consent ladder is exercised per host: manifest-declared grant, runtime
  prompt, session scope, settings revocation mid-stream — the five rules, each
  observed in a log line.

## Version

v1.10.0 candidate (additive: eleven primitives + two event channels + two
phased shapes; the grant families reuse the v1.5.0 family-flag mechanism and
the event channels sit on the v1.6.0 seam). The numbering follows the frozen
v1.5.0 fold and the draft candidates on record: event channel v1.6.0, render
surface v1.7.0, socket seam v1.8.0, forkpty face v1.9.0 — v1.10.0 is the next
free additive number.
