# Agent Note: HarmonyOS M5: loopback carrier, ArkWeb mount, real binding primitives (m5.host-binding)

Status: implemented
Related: D5

## Problem

The HarmonyOS host (PRs #28/#31) ran the spike scenarios headlessly — no
carrier, so no Web Client could ever mount, and the gateway primitives were
a smoke subset (fs + honest keychain unavailability). The M5 "Done" bar
demands the isomorphic proof on-device: a local carrier (loopback HTTP + WS
pump), ArkWeb mounting the Web Client with token deltas streaming live, the
remaining gateway primitives bound for real or declared honestly
`unavailable`, and the `app.state` / `notify.response` event channels — all
verified by one-to-one log-compare on the emulator, without breaking the
regression trio (now the 23-event `m2.session`) that must keep running
under any host change.

## Decision

ONE launch now runs two phases. The regression trio stays synchronous
(`startSpike`: m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23 on
the NAPI caller thread). The NEW binding phase is event-driven: the same
runtime exposed through fine-grained NAPI mutators (`hostStart`/`hostEval`/
`hostEvent`/`hostBusDeliver`/`hostSettle`/`hostCarrierLine`/`hostStatus`/
`hostFree`) that ArkTS calls per event — every mutator still executes on
the ArkTS main thread, which stays the ONE serial JS runtime thread
(ARCHITECTURE.md §6); the drive loop alternates pump and smoke-drain until
the scenario completes or parks on the embedder. On top of it:
`CarrierServer.ets` (loopback HTTP/1.1 static serving of the materialized
presentation/web-client files + minimal RFC 6455 WS text frames at /ws on
one port, accept via a hand-rolled SHA-1 in `Sha1.ets`, documented there);
`HostPhase.ets` shuttles session-projection@0 lines across the shared bus
seam (`dsh_spike_set_bus_sink`/`dsh_spike_bus_deliver`), emits the
carrier's own evidence (carrier.listening / webclient.mounted /
ws.connected / ws.token-delta / ws.session-complete) in the canonical
envelope as module `dsh.carrier`, and hosts the capability layer: notify
REAL (@ohos.notification publish with a wantAgent; the notification-center
tap routes `onNewWant` -> `notify.response`), presentApproval REAL (custom
ArkUI dialog), fsScope app-scope v1 (persist = resolve to the app files
scope, ref `bkm:app`), app.state from the UIAbility lifecycle edges, and
presentPicker/keychainGet/keychainSet/httpFetch honestly `unavailable`
(descriptor 5 available / 4 unavailable). Scenario
`scenario/m5-host-binding.js` + manifest (`m5.host-binding`, 20 events,
JS and carrier records in one stream, checker-filtered by scenario) prove
the whole story; `ci/run-host-e2e.sh` + `ci/drive-binding.mjs` drive
build -> install -> launch -> uitest UI automation (Approve, notification
consent Allow, Home, notification-center tap; every wait a polled
deadline) -> capture pull -> four checker verdicts + screenshots. Evidence:
`hosts/harmony/artifacts/m5-host/` (verdicts 7/6/23/20, screenshots of the
live session render, receipt).

## Alternatives considered

- One blocking NAPI call for the binding phase (like startSpike): lost —
  a synchronous call would occupy the ArkTS event loop while the scenario
  waits on the page's WS hello and the UI dialogs, deadlocking the pump;
  per-event mutators keep the runtime on one thread AND the loop free.
- WKWebView-style direct bridge (ArkWeb `javaScriptProxy` or a
  `Script` handler) instead of a real WebSocket: rejected — it would fake
  the carrier topology the milestone exists to prove (the page knows only
  HTTP + WS; ARCHITECTURE.md §4/§6).
- cryptoFramework MD('SHA1') for the WS accept: lost to the hand-rolled
  SHA-1 — the digest API is promise-based and its algorithm availability
  varies by API level, while the accept needs one synchronous 20-byte
  digest; the hand-rolled version documents its RFC vectors in-file (and
  the on-device handshake is the real proof).
- presentPicker for real (DocumentViewPicker): deferred to v2, honestly
  `unavailable` — a picker grant only pays off with the user-scope fs
  surface (fsRead over content URIs + persistence bookkeeping), which is
  exactly the v2 package with the HUKS keychain; shipping a picker that
  grants an unreadable scope would be worse than honest absence
  (contract/primitives.md §7: absence is information, never faked).
- httpFetch for real (@ohos.net.http): deferred to v2 — the frozen bridge
  streams the body as ≤16 KB `http.body` events with abort semantics; the
  binding scenario does not exercise it and the descriptor declares it
  unavailable rather than half-implementing the contract.
- Checking the binding manifest against the combined hilog capture: lost —
  the runner checks the pulled capture FILES (truncation-proof), with the
  regression trio against the sync-run capture and the binding phase
  against its own; the checker's scenario filter keeps one stream
  well-defined even with carrier and JS records interleaved.

## Consequences

- `hosts/harmony/entry/src/main` gains `ohos.permission.INTERNET` (loopback
  carrier) — scoped to the spike app; the m2.session regression keeps
  running headless in the same launch, so future C-host changes stay
  covered on-device.
- The BUNDLE_FILES list in `Index.ets` grows by
  `scenario/m5-host-binding.js` and the `webclient/dsh-web-client/` files
  (byte-identical to `presentation/web-client`); extend it whenever the
  import closure grows (drift is silent — see the surprise ledger).
- The binding phase is single-instance per process (`hostStart` fails loud
  on a second activation), matching one binding scenario per launch.
