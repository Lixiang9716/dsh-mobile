# Agent Note: the composer live-write scenario pins the selectModel routing fact — a two-model roster and a wire-driven model drive

Status: implemented
Related: D9

## Problem

`session/selectModel` has committed picks to the vendored model-selection
holder since #309/#310 (journal intent + `holder.current`, applied to the
next request through `installModelSelection`'s waterfalls), but no E2E
scenario asserted any of it: across the 96 manifests `selectModel` appeared
exactly once — in android-composer-live-write's `write.surface.claimed`
endpoint list. A regression that dropped the apply leg (say, a refactor that
loses the holder's waterfall install) would keep every scenario green: the
pick would still append its journal intent, the endpoint would still be
claimed, and only the routing would silently stay on the boot model. The
gap was proof-surface, not behavior — re-implementing the apply leg was
explicitly out of scope (D9: the vendored packages own the semantics).

Two structural facts kept the pin from being a manifest-only edit. First,
the scenario staged a single-model world: the boot route and the write
surface both answered `mock-1` only, and `routeModelRows` collapses a
route without a roster to that one row — any other pick is refused
in-band as `session/model-unavailable`, and picking `mock-1` itself
cannot distinguish "routing followed the pick" from "the write landed".
Second, selectModel's failures are in-band (`{ok:false}` answers, the
#312 precedent), so an rpc-level assertion would stay green through a
refusal.

## Decision

android.composer.live-write now stages a two-model roster and drives a
second turn on the pick. The write drive's `runtime.config` carries
`llmModels` (`[{id: mock-1}, {id: mock-2}]` — the interactive seat's
config.json `models` shape); the scenario validates it through
llm-route.js's `stagedModels` (now exported — one validation home) and
hands the roster to the write surface's `models` option, which is both
the dialog's catalog and selectModel's routability check. After turn A
renders, a fourth probe leg commits the pick through the page's REAL
wire leg (`POST session/selectModel`, provider mock, model mock-2, no
reasoningEffort — the vendored waterfall clears inherited effort and the
mock adapter declares only `off`), opens one `session/follow` stream and
fires `session/prompt` only after its snapshot frame proves the
subscription live, then waits for turn B's REAL journal `turn/end`
event frame before reporting — the runtime-side emits therefore precede
the drive's finish deterministically.

The scenario emits the facts off the live journal (`ctx.on('session/event')`,
the turn-evidence precedent): `write.selection.observed` (the
`model/selection` intent — the commit evidence, never the rpc ack),
`write.header.observed` (every served route: turn A's mock-1 beside turn
B's mock-2 is the contrast that makes the routing fact readable),
`write.switch.notice.observed` (the vendored pre-step's durable
`[model changed: …]` user-role notice — desktop parity; journaled bare,
so the text reads `event.data.content`, not the `.message` envelope the
assistant events use), and — on the second settle —
`write.turn.settled.next` plus `write.projection.observed`, the raw
modelSelection fold read through `sessionProjections.stateOf`:
`lastUsed` must have adopted the pick AND `pending` must be `null`
(consumed by the matching header) — the view's `next` alone cannot tell
an honored pick from a still-pending intent. The manifest pins all of it
in walk order (60 expects): selection seq 11, notice seq 17, header seq
18 with `model: mock-2`, the wire request built on mock-2 with 5 messages
(system + history + prompt + notice — the parity fact rides the real
request), turn B's scripted deltas, the fold `{lastUsed: mock-2,
pending: null}`, and the sorted-flush `rpc.observed` row for
session/selectModel. The drive's acks are checked only to fail early on
a structured refusal — the journal rows are the evidence. Mirrors:
runtime/spike + android assets + harmony rawfile (`llm-route.js` rides
all three; the scenario is android-only).

## Alternatives considered

- Driving the composer's model DIALOG (open, pick a row, commit): the
  most user-shaped proof, but it wedges the drive to the dialog's DOM —
  the send leg already shows how much pacing the official UI needs, and
  a selector drift would mask the routing regression this leg exists to
  catch. The wire leg is the same one the dialog's commit calls.
- A CLI-spike scenario instead of the emulator seat: the mock route
  carries no roster (`llmRoute.models` only rides staged routes), so the
  CLI drive could not express the switch without widening llm-route
  anyway — and it would leave the only selectModel-claiming scenario
  still unproven on device.
- Asserting only the projection view (`next === mock-2`): cheaper, but
  `next = pending ?? lastUsed` reads the same under a honored pick and a
  still-pending one; the raw `stateOf` fold separates them.
- Emitting the projection fact on a host→runtime "evidence settled" bus
  message to order the Kotlin flush: new protocol surface in a
  manifest-pinned seam; the follow-stream settle marker orders the same
  facts with zero protocol change.
