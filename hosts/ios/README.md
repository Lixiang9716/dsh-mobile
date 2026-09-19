# hosts/ios/

The iOS host (M1–M3): SwiftUI shell + privileged layer + capability gateway + loopback carrier.

- QuickJS on a dedicated serial thread; Swift↔JS non-blocking in both directions; callbacks dispatch onto the runtime queue
- carrier: static file serving + WS↔message-bus pump — proven by the `m1.carrier.loopback` spike (`CarrierServer.swift` + `CarrierRuntime.swift`): NWListener-bound 127.0.0.1 HTTP server feeds the WKWebView over loopback, and the RFC6455 WS channel pumps both directions into the QuickJS bus seam; evidence under `artifacts/m1-carrier/`
- checkpoint triggers: foreground/background transitions / pending approvals

Spike notes: the app (`DSHSpike`) runs `m1.spike.boot` then `m1.carrier.loopback`
in one launch; the JS runtime must be driven from the dedicated `RuntimeThread`
(pooled dispatch threads break quickjs's per-thread stack limits once the JS
lifetime spans multiple blocks — the boot spike dodges this by keeping its
whole lifetime in one block).
