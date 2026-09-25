# Agent Note: the stop button goes live — session/cancel joins the claim set

Status: implemented
Related: D9

## Problem

web-client-next's stop button (PR #214) sent `session/cancel` to a runtime
that did not claim the endpoint: every press answered
`gateway/unavailable` and surfaced as an honest "not supported" toast. A
chat UI whose stop button cannot stop is a usability gap the client cannot
fix client-side — the claim belongs to the runtime's write surface.

## Decision

The mobile write surface claims `session/cancel`, mirroring upstream
session-controller `commands.cancel` at the pin: validate the request
(`sessionId`), refuse unattached sessions (`session/not-found`), abort the
live agent turn with the user cause KEEPING the inbox
(`agent.cancel({kind:'user'}, {keepInbox:true})` — queued messages are not
dropped), and answer `{accepted:true}`. The endpoint is idempotent on an
idle agent (upstream semantics; cancel of a finished turn is a no-op that
still answers accepted). The desktop leg's subagent-ownership guard is
deliberately absent — the mobile profile attaches no subagent-owned
sessions. Claims flow to the bridge through the existing
WRITE_ENDPOINTS bus message, so the stop button goes live on every host
that serves the surface (and for the official page too, whose stop button
previously got the same unavailable refusal).

Determinism for the E2E: the scripted model boundary gained a drip script
(a prompt carrying the `SLOW_TURN` marker selects body slices sent ~220 ms
apart over one Content-Length response — HTTP-legal, and byte-identical
wire for every existing drive whose prompts never carry the marker), and
the client's stop affordance is OPTIMISTIC — the button morphs to stop the
moment a prompt is admitted, because journal frames can arrive as one
burst and the button must not wait for them (the optimistic state retires
on the fold's live running signal or a 12 s watchdog). `nextweb.mount`
grows a cancel leg (type → send → the drive polls the stop shape → press →
the 已请求停止 toast proves `accepted:true`) — 16/16 on the dsh-iphone
simulator. The probe's legs are STATELESS one-shot evaluates with all
waiting on the drive (Swift timers): a driven WKWebView throttles the
page's timers to near-zero, which made page-side polling loops unusable —
the same reason the tail renders synchronously from network events instead
of through rAF/timer coalescing.

## Alternatives considered

- **Leave cancel to the desktop shell only** — the mobile composer would
  keep a permanently broken-looking button, or hide it (losing the
  affordance real turns need). Rejected.
- **Client-side fake stop** (drop the stream locally, keep the turn
  running) — a lie: the model keeps burning tokens server-side while the
  UI shows idle. The repo's fail-loud posture refuses it.
- **Pin the abort racing the drip in the manifest** — the runtime may
  deliver turn frames as one scheduling burst, so whether the abort beats
  the last chunk is not deterministic. The manifest pins the wire facts
  (cancel forwarded + accepted) and leaves the race to the vendored
  agent-loop's own upstream tests.

## Consequences

The stop button works for both web clients on every host mounting the
write surface. `api-coverage-probe`'s honest-gaps list drops
`session/cancel` (it moved to the claimed side, asserted present). The
12 s optimistic watchdog can in principle flip the button back to send
while a burst-delivered turn is still streaming — the fold's next
structure notify corrects it, and real streaming turns report running
within their first second.
