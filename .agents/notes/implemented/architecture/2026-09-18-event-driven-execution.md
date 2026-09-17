# Agent Note: event-driven execution as a binding architecture rule

Status: implemented

## Problem

Module coupling was implicit. Nothing written down stopped a future module from calling another
module directly, polling its state, or exposing a blocking whole-result API — and streaming
(LLM token deltas, tool progress) is exactly the kind of feature where those shortcuts creep in
and destroy substitutability of components.

## Decision

"Event-driven execution" is now a binding section of docs/ARCHITECTURE.md (§3) and ADR D8:
all inter-module communication flows as events or explicit async interfaces — including
streaming, which is an event sequence (agent-loop → session projection → carrier WS →
Presentation). No polling of other components, no shared mutable state across boundaries,
explicit backpressure policy at every boundary. Checkpoint is defined as "event queue drained".

## Alternatives considered

- **Recommendation only (no binding text)**: rejected — soft conventions decay exactly when
  schedule pressure appears; coupling decisions are the expensive-to-reverse kind.
- **Static gate (ban sync call patterns between modules)**: deferred — cross-module call
  analysis needs real code and an import graph to have low false positives; revisit at M2
  with the code-review rubric. The rule is binding now, enforcement is partly manual.

## Consequences

Debugging shifts from stack-walking to event-flow reading — the event log (and later replay)
becomes a first-class need (feeds govrail feature wish: gate/rubric for event API shape).
Upstream alignment is free: Cordis services/events, the WS carrier, and Fabric RFC 0001's
messages.observe are all already event-shaped.
