# hosts/ios/

The iOS host: SwiftUI shell + privileged layer + capability gateway + loopback carrier.

- QuickJS on a dedicated serial thread; Swift↔JS non-blocking in both directions; callbacks dispatch onto the runtime queue
- carrier: static file serving + WS↔message-bus pump — proven by the `carrier.loopback` spike (`CarrierServer.swift` + `CarrierRuntime.swift`): NWListener-bound 127.0.0.1 HTTP server feeds the WKWebView over loopback, and the RFC6455 WS channel pumps both directions into the QuickJS bus seam; evidence under `artifacts/m1-carrier/`
- checkpoint triggers: foreground/background transitions / pending approvals
- Real gateway binding (done): the nine-primitive privileged layer behind the capability gateway — fsRead/fsWrite/fsScope (security-scoped bookmarks), httpFetch (URLSession streaming), notify (UNUserNotificationCenter), presentApproval/presentPicker, keychainGet/keychainSet (SecItem) — with permission checks, a mandatory audit stream (`dsh.gateway.audit:` prefix) and the `app.state` / `notify.response` event channels; `gateway.binding` passes 19/19 canonical events + 16/16 audit records on the simulator, evidence under `artifacts/gateway/`

Spike notes: the app (`DSHSpike`) runs `boot.verification` then `carrier.loopback`
in one launch; the JS runtime must be driven from the dedicated `RuntimeThread`
(pooled dispatch threads break quickjs's per-thread stack limits once the JS
lifetime spans multiple blocks — the boot spike dodges this by keeping its
whole lifetime in one block).
