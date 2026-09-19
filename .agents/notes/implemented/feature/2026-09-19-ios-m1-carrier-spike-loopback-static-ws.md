# iOS M1 carrier spike: loopback static+WS carrier pumping WS↔QuickJS

Status: implemented
Related: D8

## Problem

M1's scope item "local carrier" (loopback static file serving + WS→QuickJS
message-bus pump) was the last unstarted piece keeping the milestone at
"In progress" (ARCHITECTURE.md §6/§10: WKWebView loads
`http://127.0.0.1:<port>` from a host-implemented carrier; the page knows
only the HTTP/WS protocol). Nothing proved the topology end to end: no
transport, no JS-side seam to receive transport events, no log-based E2E
scenario for it, and no evidence that the pump respects the single-runtime-
thread rule on a real host.

## Decision

- **Bus seam in the shared C host** (`runtime/spike/host`):
  `dsh_spike_set_bus_sink`/`dsh_spike_bus_deliver` — one JSON line per
  crossing, JS→host via `__dshBusPost`, host→JS via the scenario's
  `__dshBusOnMessage` handler plus a microtask drain. Platform-neutral, so
  Android/HarmonyOS can reuse it later; the message vocabulary is
  spike-local and documented as not-for-reuse (M2 replaces it).
- **New E2E scenario** `m1.carrier.loopback`
  (`runtime/spike/scenario/m1-carrier-loopback.js` + manifest): 7 events,
  one-to-one log match, all canonical lines emitted by JS only (transport
  facts enter the log as delivered-message fields, never as host-side
  prints — single-logger discipline). Proves: listening on loopback, static
  serving of both assets, WS connect, page→JS echo (nonce match), JS→page
  unsolicited push acked by the page.
- **iOS carrier** (`hosts/ios`): `CarrierServer.swift` — NWListener bound
  to 127.0.0.1 (ephemeral port), minimal HTTP/1.1 static serving from the
  staged `web/` dir, RFC6455 text-frame WS with CommonCrypto/CryptoKit
  accept (verified against the RFC 6455 test vector). `CarrierRuntime.swift`
  — owns the C runtime session with the bus seam and marshals every
  crossing between the server queue and the runtime thread. The app now
  drives `m1.spike.boot` then `m1.carrier.loopback` in one launch, shows
  the served page in a WKWebView, and prints a final `spike: sequence`
  marker the CI poll waits on.
- **RuntimeThread**: quickjs computes its JS stack limit from the thread
  that created the runtime and checks it on every JS call, so a runtime may
  never be driven from pooled dispatch threads (each block can land on a
  different thread → spurious "Maximum call stack size exceeded").
  Boot is safe by construction (whole JS lifetime in one block); the
  carrier's event-driven delivers need a real dedicated thread (4 MB stack).
- Evidence: simulator run on dsh-iphone (iOS 26.5) — checker PASS 9/9 boot +
  7/7 carrier in one launch — committed under
  `hosts/ios/artifacts/m1-carrier/`. `dev-ios.yml` runs both checkers on the
  same captured log. README/README.zh M1 flipped to Done in the same change
  (rule 12).

## Alternatives considered

- `WKScriptMessageHandler` instead of a real WebSocket: rejected — it would
  fake the carrier topology the spike exists to prove (the architecture's
  "it only knows the HTTP/WS protocol" rule is the point).
- Third-party HTTP/WS server (Swifter etc.): rejected — new dependency for
  ~200 lines of well-bounded Network.framework code, against the spike's
  zero-dependency discipline.
- Dispatching bus delivers on the existing serial DispatchQueue: tried and
  rejected — quickjs stack limits are per-thread, so pooled threads fail
  nondeterministically (this burned a full debug cycle; see RuntimeThread
  above). The C host header now states the single-thread requirement for
  `dsh_spike_bus_deliver` explicitly.
- Emitting carrier transport events as canonical lines from Swift: rejected
  — breaks the one-logger contract; transport facts ride into JS as bus
  message fields and the scenario logs them.
- Landing the carrier on all four platforms before flipping M1: rejected —
  M1 spike B names iOS as the carrier surface (ARCHITECTURE.md §10); the
  seam is shared, other platforms follow in M4/M5.

## Consequences

- The `dsh_spike_host.h` embedding contract grew the bus seam; embedders
  that don't use it are unaffected (the global binds as a no-op without a
  sink).
- The spike app now needs ATS local networking (Info.plist
  `NSAllowsLocalNetworking`) and WebKit — both scoped to the spike app.
- `m1.spike.boot` regression-runs on the simulator in every `dev/ios` run
  next to the carrier, so C-host changes stay covered on-device.
- M2 must replace the spike bus vocabulary with the real session projection
  protocol; the seam itself (line in / line out, drain on deliver) is the
  part worth keeping.
