# Agent Note: the BLE face lands — eight primitives + the ble.event channel behind one radio seam

Status: implemented
Related: D5, D8

## Problem

The system capability plane proposal
(`contract/proposals/2026-09-30-system-capability-plane.md`, the stack base
of this line) specified the BLE face — eight calls over grant family
`ble` plus the `ble.event` channel — but no host answered it: negotiation
floors replied `unavailable`, no host declared an OS Bluetooth permission,
and an agent could not reach a nearby device. The implementation round had
a hard physical constraint the camera/microphone lines do not: none of the
three simulators has a usable Bluetooth radio, so the contract's own
verification plan ("an emulator without a radio answers `unavailable`
honestly") could not exercise the GATT ladder at all.

## Decision

All eight primitives live on all three hosts behind ONE radio seam
(`BleRadio` protocol/interface/`BleRadioLike`) with two drivers: the real
platform radio (CoreBluetooth / android.bluetooth.le / @ohos.bluetooth.ble)
and a deterministic **mock radio** whose two-device GATT db (180f/2a19
read+notify, fe00/fe01 write) rides the SAME gateway enforcement, consent
layers, and audit trail — the CI-verifiable mock layer verifies the
envelope without pretending a simulator has a radio. The mock's device
names carry the `DSH Mock BLE` prefix and the mock manifests pin those
names, so evidence can never pass against a radio that is not the named
mock.

- **Consent stays two-layered everywhere**: the gateway grant first (the
  caller manifest's `ble` family flag; a caller without it gets the same
  surface `presentApproval` uses — approve once / approve & remember /
  decline on iOS and Android, approve/decline session-scoped on Harmony,
  whose presenter has no third button), the OS permission second, and the
  refusal audit names the layer. The standing grant reuses the
  clipboardRead posture (app-scoped persistence; revocation = deleting the
  app) until a settings face exists.
- **Radio truth before prompting**: a missing or powered-off radio answers
  `unavailable` BEFORE any consent surface. The Android emulator turned out
  to declare a VIRTUAL controller (enabled) while its runtime permissions
  are ungranted — its honest posture is the OS layer refusing, so the
  scenario's probe accepts three answers (armed / `unavailable` /
  `denied`) and the per-host manifests pin which posture each host
  actually answered. No `hostType` branch anywhere: the scenario reads
  only what the gateway answered.
- **CBCentralManager is created lazily** (iOS): instantiating the manager
  is what surfaces the OS permission prompt, so a session that never calls
  a BLE primitive — every other drive, the serving seat — never creates
  one. Android orders its consent check the same way (radio first,
  permission second); Harmony's kit surfaces the OS layer through its own
  201 error codes.
- **Scenario `ble.plane`** (one platform-neutral file, per-host × per-mode
  manifests): the probe decides the posture; absent/denied walk the denial
  legs as values; live runs the full ladder (scan arm → advertisement
  events → stop → connect → read → write → subscribe → two notifications
  → unsubscribe → disconnect), with GATT depth only where a peer with the
  test db exists (mock always; real device by the D-g contract).
- **Legs**: `test/e2e/run-ios-ble.sh`, `hosts/android/ci/run-ble.sh`,
  `hosts/harmony/ci/run-ble.sh`, each `skip|mock|device`. The Android mock
  leg gates CI (dev-android.yml, hard); the iOS mock leg runs on the
  hosted simulator best-effort (dev-ios.yml, continue-on-error — same
  posture as the m1 stage); the harmony legs are prepared but blocked
  locally (see Consequences). `device` mode is the D-g one-click real-
  device leg: it demands real hardware (Android refuses an emulator
  serial; iOS demands a signing identity; Harmony demands a signed HAP)
  and a peer carrying the test db — never faked.
- **Descriptor honesty**: iOS 22→30, Android 23→31, Harmony 15→23 (+ the
  C forward list and fallback descriptor kept equal); every manifest that
  pins a descriptor count bumped in the same change; the OS declaration
  rows follow the proposal appendix (iOS `NSBluetoothAlwaysUsageDescription`,
  Android API-31+ runtime pair + legacy pair capped at 30, Harmony
  `ACCESS_BLUETOOTH`); the audit-honesty statement (event delivery is not
  per-call audited) lives in each host's BLE file header — the descriptor
  schema is closed and carries no prose.

## Alternatives considered

- **Mock radio as a system plugin above the shim** — rejected: the consent
  layers, token minting, and audit are host-side security surfaces; a JS
  mock would verify the plugin, not the plane.
- **Simulator Bluetooth bridging the Mac's radio as the "real" leg** —
  rejected after measurement: the dsh-iphone (iOS 26.5) simulator answers
  `.unsupported` today, but the answer is machine-dependent; treating a
  Mac-bridged radio as device evidence would make the leg flaky and lie
  about what was verified. The mock layer is the deterministic surface;
  hardware is the D-g leg.
- **A discover-services primitive to make real-device GATT general** —
  rejected: the proposal's eight-call surface is frozen for v1 and GATT
  tuples are host-validated opaque strings; discovery is a v2 design, and
  the D-g peer contract (serve the documented test db) covers the
  verification need without inventing a primitive.
- **Faking the harmony legs from the iOS/Android evidence** — rejected out
  of hand; the harmony runner is prepared and its local block (the BASE
  tree fails CompileArkLS on this machine's newer commandline-tools with
  15 pre-existing arkts-no-any errors — git-stash-verified as pre-
  existing) is recorded as a gov surprise. Harmony's build in CI uses the
  repo-pinned CLT.

## Consequences

BLE is negotiable on all three hosts; the grants gate the family; scans
and connections arm event-first (D8) and every call carries one audit
record with direction/duration/byte counts, never payload bytes. The
settings-face revocation (the proposal's rule 3 review surface) and a
discovery primitive remain named gaps for the lines that need them; the
standing grants are revocable today only by deleting the app — the same
posture clipboardRead has shipped with since v1.5.0.
