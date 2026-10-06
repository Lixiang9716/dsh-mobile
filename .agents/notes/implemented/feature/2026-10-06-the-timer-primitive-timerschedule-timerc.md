# Agent Note: The timer primitive: timerSchedule/timerCancel live on the harmony host

Status: implemented
Related: D5

## Problem

The gateway timer seam (contract v1.4.0 §5) was never implemented on the
harmony host: the dispatch answered timerSchedule with `invalid`, the
runtime's timers shim warned once per runtime (`arm/failed`) and every
`setTimeout` hung forever. The upstream machinery that depends on timers —
the llm retry pacing (loop-c2), the read-idle watchdog (loop-u2), every
deadline fuse (dsh-timeout) — armed and never fired. Measured on the
CREATE-mode demo: an llm request timeout scheduled its retry
(attempt 1/5) and the retry never ran — the turn hung silently; reproduced
across three runs and two models.

## Decision

- `TimerPrimitive.ets`: timerSchedule arms an ArkTS-side timeout and
  settles `{timerId}` immediately (the JS shim's sync-handle contract);
  when it fires, `{event:"timer.fire","timerId":N}` is delivered onto the
  runtime's gateway event channel (the http.body seam — the host dispatches
  it onto the serial runtime queue, D2-safe); timerCancel is the
  idempotent one-way cancel.
- `gateway_smoke.cpp`: timerSchedule/timerCancel join the forward set —
  the smoke backend forwards them to the ArkTS capability layer like
  notify/keychain/httpFetch.
- `HostPhase.onDispatch`: the two branches; the TimerPrimitive member's
  sink is `deliverEvent` (the runtime event channel).
- `OFFICIAL_DESCRIPTOR`: the seam is offered (8 available / 3 unavailable).
- `HttpFetch.ets`: the platform read timeout (the BETWEEN-BYTES gap)
  30s → 5min — a reasoning model's first SSE byte exceeded it three
  consecutive times on the creation payload.
- `real-create` demo scenario: the container root stages through a file
  (the bus delivery raced the runtime boot), `readIdleTimeoutMs: 300s` on
  the reasoning route.

After this change the vendored retry machinery runs for real on this host:
attempts schedule, pace, and fire; 5/5 exhaustion surfaces as an honest
turn error instead of a silent hang.

## Alternatives considered

- Implementing the timer in C (a sleep thread in the smoke backend):
  rejected — ARCHITECTURE.md §6 forbids threads touching the JS runtime;
  the timer callback must arrive through the host's event dispatch onto the
  serial runtime queue, which is exactly the ArkTS-primitive shape.
- A blanket "fire on the next runtime tick" fallback in the timers shim
  when the arm is denied: rejected — the shim cannot distinguish a retry
  wait (wants immediate fire) from a deadline fuse (must NOT fire while the
  request is healthy); an immediate fire would abort every in-flight
  request the fuse guards. The real primitive keeps both semantics correct.
- Raising only the scenario's readIdleTimeoutMs without the transport
  timeout: measured and rejected — the cut happened at the httpFetch layer
  (30s between-bytes), before the read-idle guard was ever consulted.
