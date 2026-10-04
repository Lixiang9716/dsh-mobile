# Agent Note: the turn watchdog's activity test goes semantic — the think phase can no longer starve the rescue

Status: implemented
Related: #346 (item 1), #323 (residual), #326 (the rings this extends), D8

Date: 2026-10-04 · Class: bug-fix

## Problem

The real-model device battery (2026-10-04, #346 item 1) measured a turn that
sat open for >15 minutes at the "Deep diving…" status with zero rescue: no
turn completion, no failure, no user-visible way out. The #326 guards cover
tool runs (ring 1: 120 s tool deadline) and SILENT turns (ring 2: the
300 s turn watchdog) — but this stall was in the model's think/stream
phase, and ring 2 never tripped.

Root cause, in the sources: ring 2 fed its re-armable timer from the raw
event list `['session/event', 'agent/assistant-stream', 'agent/status']`
(`upstream/turn-watchdog.js`, `PROGRESS_EVENTS`) with no payload
inspection. But the vendored agent loop emits one `agent/assistant-stream`
event per stream FRAME — the `start`/`end` markers and every chunk
(vendored dsh-agent-loop `lib/index.js`: `live.start()`, and
`for await (const chunk of stream) live.push(chunk)` →
`dispatch.emit("agent/assistant-stream", { frame })`). The think phase is
exactly a long drip of `reasoning-delta` frames (the mobile transport maps
`delta.reasoning_content` 1:1, `upstream/llm-transport.js`), and those
frames are TRANSIENT — nothing durable is appended until the attempt
settles. So a model that thinks for 15 minutes re-arms the 300 s timer on
every reasoning frame and the watchdog — built to catch a quiet spine —
never sees silence. The device evidence matches: the turn timer kept
running while workspace writes stopped entirely after the last tool call.

## Decision

The watchdog's activity test is SEMANTIC (`upstream/turn-watchdog.js`):

- `session/event` (durable turn messages: turn boundaries, user/system/
  assistant messages, tool events) and `agent/status` (change-only status
  transitions) stay unfiltered feeds — semantic by construction.
- `agent/assistant-stream` is filtered through the new
  `isSemanticStreamFrame` predicate: only frames naming ANSWER TEXT
  (`text-delta`; text/tool-call `block-start`/`block-end`) or a TOOL CALL
  (`tool-call-delta`) re-arm the budget. Stream markers (`start`/`end`),
  reasoning deltas and blocks, and accounting frames (`usage`, `finish`)
  are wire liveness and never do. A provider keepalive or an endless think
  phase now leaves the budget intact; a full silent-budget window on a
  running agent fails the turn in-band exactly as before — same `watchdog`
  cause, same `keepInbox`, same journal abort (the existing failure
  vocabulary, unchanged).

Not a vendored-package change: the watchdog is an outboard mobile module
(`upstream/turn-watchdog.js`), so no upstream copy moved (D6). Boot order
is untouched (ring 2 still mounts after `agent-loop`, `upstream/boot.js`).
The regression tests pin both directions: a keepalive-only stream
(markers + reasoning deltas forever) is rescued within the budget, and an
answer-text stream still re-arms through 4x the budget without a cancel.

## Alternatives considered

- **Count reasoning deltas as progress** (any content-bearing frame
  re-arms) — rejected: the #346 stall WAS reasoning traffic; this is the
  exact starvation shape, and a model with an unbounded think budget would
  keep the turn wedged forever with the watchdog watching it happen.
- **A separate, longer think-phase timer** (e.g. 15 min for reasoning,
  300 s elsewhere) — rejected: two budgets for one spine invites drift and
  a second mystery constant; one semantic rule with the existing budget
  covers every phase, and a genuinely productive turn re-arms on its own
  text and tool calls.
- **Kill the stream at the transport on a wire-idle timer** (ring 0.5 in
  `llm-transport.js`) — rejected: the transport cannot tell a stalled wire
  from a slow provider, and dropping the connection there bypasses the
  loop's own cancellation/settlement path; the watchdog's agent cancel
  rides the abort signal so the attempt settles (interrupted blocks are
  committed) and the journal records the cause.
- **A user-facing stall breaker only (Stop button hardening)** — rejected
  as necessary-but-insufficient: the runtime must rescue itself; a button
  is the human fallback, not the guard.

## Consequences

- A legitimately >5-minute pure-think turn (no text, no tool call) now
  fails in-band at the budget instead of hanging indefinitely. That is the
  intended trade: an honest failure the model/user can retry beats a
  15-minute silent wedge; `keepInbox` preserves queued user messages.
- The mounted log line names the feed policy
  (`assistantStreamFeed: 'semantic-only ...'`) so a future reader of a
  device log can see which activity test armed the watchdog.
