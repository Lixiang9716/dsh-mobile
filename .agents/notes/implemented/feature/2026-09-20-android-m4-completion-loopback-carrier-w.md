# Agent Note: Android M4 completion: loopback carrier + WebView mount + real nine-primitive gateway binding

Status: implemented
Related: D5

## Problem

The M4 Android host ran the shared C spike host with a SMOKE gateway backend
(`dsh_spike_smoke.c`): fs only, six primitives honestly `unavailable`, no
carrier, no UI surface — the `smoke-fs` analogue of the CLI, not a phone
host. The contract (contract/primitives.md v1.0.0, frozen, D5) requires a
conforming `gateway@1` host to implement all nine primitives (or declare
absence honestly), enforce permission flags from the caller's manifest, emit
a structured audit record per call, deliver the `app.state` /
`notify.response` channels, and settle every completion onto the runtime
queue. Without a real binding the Android host could not carry a mounted Web
Client, could not stream a session projection, and no plugin could treat
Android as a negotiable platform — the milestone's "Done" row was blocked on
exactly this.

## Decision

The app now hosts the full completion session (launch `--ez dsh.m4 true`,
scenario `m4.host-binding`), modeled 1:1 on hosts/ios SessionRuntime.swift +
GatewaySession.swift:

- `CarrierServer.kt` — one loopback HTTP + WebSocket endpoint on a raw
  `ServerSocket` (the Kotlin sibling of the iOS NWListener carrier): static
  serving of the embedded Web Client, RFC6455 text-frame pump with SHA-1
  accept via `MessageDigest`, the `/gateway-e2e/bytes|slow` chunked streams,
  and the platform-neutral bus seam (`dsh_spike_set_bus_sink` /
  `dsh_spike_bus_deliver`) as the only crossing into JS. Transport-only:
  carrier threads never touch the runtime; every crossing hops via
  `SpikeRuntime.post` onto the single `dsh-spike-js` HandlerThread.
- A real `WebView` mounts `http://127.0.0.1:<port>/` (the presentation/
  web-client files ride in assets, cmp-identical to the canonicals) and
  renders the session live: toolbar slot, token deltas, session-complete.
- `GatewayCore.kt` + one primitive file per surface (ports of hosts/ios
  Gateway/): descriptor before eval, manifest permission check
  (`<name>`/`<name>@<major>` grammar), mandatory structured audit on its own
  logcat tag (`dsh.spike.audit`, `dsh.gateway.audit: ` prefix, never payload
  contents). All nine primitives are real: fsRead/fsWrite over a scope
  registry (`app` = `filesDir/profiles/default`; user scopes = SAF tree
  URIs, reads and writes through DocumentsContract child resolution, 8 MiB
  read cap); fsScope.persist/resolve over a file-backed scope registry
  (`bkm:` refs — the SAF analogue of security-scoped bookmarks, survives
  relaunch); httpFetch over HttpURLConnection settling `{status, headers,
  bodyId}` at headers with ≤16 KB `http.body` events, `http.end`, abort →
  `cancelled`; notify via NotificationManager (POST_NOTIFICATIONS enforced,
  contentIntent → `notify.response` THEN `app.state foreground`, frozen
  order); presentApproval (AlertDialog) / presentPicker
  (ACTION_OPEN_DOCUMENT_TREE, persistable permission) on the UI thread with
  `Done` settled back through the runtime queue; keychainGet/keychainSet
  sealing secrets with a hardware-backed AndroidKeyStore AES-256-GCM key
  (AndroidKeyStore stores keys, not blobs, so the ciphertext persists
  app-privately under `<filesDir>/keychain/` — same trust level as an iOS
  SecItem). `app.state` rides activity lifecycle edges, deduped.
- `dsh_spike_m4.c` — the JNI bridge (sibling of dsh_spike_jni.c): frozen
  bridge order (descriptor → dispatch → bus sink → eval → pump), settle/
  event/bus-deliver re-entry the Kotlin driver hops onto the runtime queue,
  and the M4Bridge object callbacks while the runtime drives eval/pump.
- `run-android-full.sh` — regression (run-spike-e2e.sh, untouched) + the m4
  phase: stages the SAF target, pre-grants POST_NOTIFICATIONS, drives the
  SAF picker / approval dialog / notification banner via `uiautomator dump`
  + `input tap` under polled deadlines, line-buffers the logcat capture
  (stdio block buffering starved the marker greps — recorded as surprise
  `backgrounded-adb-logcat-file`), bounds the stream at the first
  `dsh.spike.result: ALL`, and screenshots each UI stage. The
  `m2.gateway.audit` manifest is reused verbatim: the m4 scenario keeps the
  m2-gateway-binding call order, so one audit run proves the §6 record
  sequence.
- The scenario canonical lives at `runtime/spike/scenario/m4-host-binding.js`
  (byte-identical asset copy) with a 35-event manifest
  (`tools/e2e/scenarios/m4-host-binding.json`) covering carrier mount, the
  session leg, and every primitive; every await rejection lands in a
  top-level catch that fails loud (a stalled promise must never masquerade
  as a hang). CI keeps running the three-scenario regression;
  run-android-full.sh is the full local regression runner.

All five checkers green on the emulator in one run: m1.spike.boot 7/7,
m2.bridge.smoke 6/6, m2.session 23/23, m4.host-binding 35/35,
m2.gateway.audit 16/16. Evidence: `hosts/android/artifacts/m4-complete/`.

## Alternatives considered

- Keeping the smoke backend and adding primitives ad hoc in C: lost because
  UI primitives (dialogs, SAF, notifications) need the Android framework and
  an Activity — unreachable from the C backend without forking the seam;
  the frozen bridge already specifies on_call → off-thread handler → settle
  onto the runtime queue, so the dispatch belongs on the platform side.
- keychainGet/keychainSet as honest `unavailable`: lost because the Android
  Keystore makes a real credential store straightforward (AES-GCM under a
  non-extractable key); declaring unavailable would understate the platform
  and break descriptor parity with iOS (0 unavailable).
- presentPicker as ACTION_OPEN_DOCUMENT (file mode, like iOS' file pick):
  lost because a document URI grants only that document, while the contract
  maps a pick to a scope the caller can use for sibling reads;
  ACTION_OPEN_DOCUMENT_TREE grants the directory and takes a persistable
  permission — the honest SAF mapping of fsScope persist. API 35 refuses
  tree picks of Download/Documents ("protect your privacy"), so the E2E
  stages a dedicated `/sdcard/dsh-e2e` target.
- WebView loading the web client from file:///android_asset: lost because
  the Web Client must talk to the carrier over the SAME loopback origin it
  is served from (location.host → ws://127.0.0.1:<port>/ws), matching the
  iOS mount topology exactly.
- Extending run-spike-e2e.sh (and CI) with the m4 phase in the same PR:
  deferred — the shared-layer CI must stay green while the m4 UI
  choreography (SAF + shade automation) soaks; run-android-full.sh is the
  full local regression and the CI extension can follow once proven.
