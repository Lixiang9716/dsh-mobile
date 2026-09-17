# hosts/ios/

The iOS host (M1–M3): SwiftUI shell + privileged layer + capability gateway + loopback carrier.

- QuickJS on a dedicated serial thread; Swift↔JS non-blocking in both directions; callbacks dispatch onto the runtime queue
- carrier: static file serving + WS↔message-bus pump
- checkpoint triggers: foreground/background transitions / pending approvals
