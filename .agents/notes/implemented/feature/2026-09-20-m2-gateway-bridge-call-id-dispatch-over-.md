# Agent Note: M2 gateway bridge: call-id dispatch over the C spike host

Status: implemented
Related: D5

## Problem

The M1 spike host could not carry a real plugin: `__dshGatewayCall` parked
exactly ONE call at a time in host state and settled it with canned
responses invented inside `dsh_spike_host.c` itself (`dsh_settle_pending`
switched on the primitive name). That proved the pump loop but violated the
point of the capability gateway (contract v1.0.0, D5): results must come
from the platform embedder across an async boundary, multiple calls must be
in flight simultaneously (an httpFetch body streams while other calls
run), and there is no channel at all for bridge events (`app.state`,
`notify.response`, stream chunks). Without a real bridge, no platform host
can be built against the spike, and no M2 E2E scenario can assert
gateway-mediated behavior.

## Decision

`runtime/spike/host/dsh_spike_host.c|h` grows the frozen bridge surface:
`dsh_spike_set_gateway_dispatch` (each call gets a monotonic call_id from 1
and is dispatched synchronously on the runtime thread; the promise
capability is parked in a growable id→resolve/reject table, so calls
overlap freely), `dsh_spike_set_descriptor` (stored pre-eval, read back by
`__dshGatewayDescriptor()`), `dsh_spike_gateway_settle` (parses the payload
as JSON and resolves/rejects by id; unknown or already-settled ids return
-1, fail loud) and `dsh_spike_gateway_event` (invokes
`__dshGatewayOnEvent` when subscribed, drops otherwise, mirroring
bus_deliver). Both are documented RUNTIME-THREAD-ONLY; both drain pending
jobs after delivery. `__dshGatewayAbort(callId)` dispatches an
`httpFetch.abort` call. The single-call guard and the entire canned-settle
path are deleted; `dsh_spike_pump` now only drains microtasks. Above it
sits `runtime/spike/gateway.js`, a typed shim exposing all nine
contract primitives with frozen shapes (base64 bytes both directions —
decode implemented in-shim since upstream ships only encode —
GatewayError rejections, httpFetch body as an AsyncIterable fed by
http.body/http.end/http.error, abort()). Two scenarios drive it:
`m2-bridge-smoke.js` headless against a new smoke backend in
`main_cli.c` (fs primitives over a temp dir, deferred post-pump
settlement, everything else declared-unavailable per descriptor), and
`m2-gateway-binding.js` for the full iOS embedder (19 frozen events).
The M1 scenario is slimmed to its 7-event boot list. Fixing the bridge for
binary payloads also required making the host's `btoa` seam latin-1-safe:
JS_ToCStringLen hands back UTF-8, so bytes ≥ 0x80 were silently re-encoded
as two bytes — the seam now decodes UTF-8 back to char codes 0..255 and
fails loud on anything wider.

## Alternatives considered

- Extending the M1 single-call slot with a "pending queue" inside the host
  and settling from pump: lost because settlement must come from the
  embedder thread/queue, not from inside the runtime loop — that just
  re-creates canned responses with extra steps and keeps no event channel.
- Skipping the call-id table by mapping ids to JS Promise objects in a JS
  side Map (all state in gateway.js, C passes only opaque ids): lost
  because the C API is the cross-platform contract other embedders (Swift,
  future NAPI) link against — resolving promises requires the host to own
  the JSValue capabilities anyway.
- Keeping btoa ASCII-only and forbidding non-ASCII byte payloads in the
  spike: lost because keychainSet of 32 random bytes is a frozen M2 E2E
  step; a seam that corrupts 1-in-256 bytes would make the roundtrip
  scenario flaky by construction.
