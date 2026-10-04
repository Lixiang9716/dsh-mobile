# Agent Note: loop-u2: the llm transport seam arms a read-idle watchdog — a byteless stall becomes a retryable TIMEOUT attempt failure

Status: implemented
Related: D9

## Problem

The battery-r14 field rounds (round-summary.txt, w1-verdict.txt) confirmed
twice on the seat that an LLM attempt whose socket black-holes mid-stream
(airplane mode during an in-flight turn) never fails: the transport's read
side parks on the gateway bridge forever. The round-1 timeline
(w1-journal-timeline.txt, w1b-follow-frames.log): last stream frame 18:49:44
(rev387), the `gateway SSE stream failed: Connection reset` only surfaced at
18:58:20 — 8.6 minutes later — then `llm/retry 1/5` fired, the retry's own
attempt froze for good (running=True ≥17 min, no turn/end, the 2/5 retry
never scheduled), and the queued followup stranded behind the running turn.

Three guard layers all miss this await:

- Ring 1 (`upstream/tool-deadline.js`, 120s) covers tool dispatch only.
- Ring 2 (`upstream/turn-watchdog.js`, 300s) does cancel the agent, but the
  cancel rides the caller's abort signal — and `parseSse` observed that
  signal only via `throwIfAborted()` after a chunk ARRIVES (llm-transport.js
  pre-fix line 296). On a byteless stall no chunk ever arrives, so the
  parked `for await` never observes the abort: the watchdog's cancel cannot
  unwind it (its own documented limit).
- The vendored `@deepseek-ai/dsh-llm-retry` never sees a failure at all — it
  recovers from `agent/request-error`, and no error is ever raised.

## Decision

The attempt-level guard lives beside the transport seam
(`runtime/spike/upstream/llm-read-idle.js`, driven by
`upstream/llm-transport.js`'s SSE parser — the read side's owner), extracted
as its own module because the file-size gate (the one that split boot.js)
bounds llm-transport.js at 500 lines:

1. **Read-idle watchdog** in `parseSse`: a timer re-arms on every body chunk
   (any bytes are wire liveness — keepalive comments included) and is
   disarmed while a delivered payload sits with the consumer, so the budget
   measures wire silence, not consumer pace. On lapse it calls
   `response.abort()` — the one primitive that unwinds a read parked on the
   gateway bridge (gateway.js abort marks the stream errored and wakes the
   parked `nextChunk`) — and the attempt fails with the RETRYABLE `TIMEOUT`
   code (message: `no bytes for <N>ms — read-idle watchdog aborted the
   attempt`). dsh-llm-retry then owns the rhythm (1/5..5/5), and an
   exhausted budget errors the turn, where loop-u's turn-recovery continues
   the queued followups.
2. **Caller-abort bridge**: the caller's signal is bridged to
   `response.abort()` eagerly (listener at generator start, removed in
   `finally`). Signal aborts now unwind a byteless stall and still map to
   the non-retryable `ABORTED` code — a deliberate cancel (ring-2 watchdog,
   user stop) must not retry. This un-blocks ring 2 for exactly the stall
   class its header documented as uncovered.
3. **Budget**: `readIdleTimeoutMs` adapter option, default
   `DEFAULT_READ_IDLE_TIMEOUT_MS = 120_000`, validated fail-loud (rule 5).
   Grounds, in the #326 guard family: ≥ the measured legitimate lull (the
   seat's own time-to-first-byte was 38.1s — w1b stream start 18:49:06.430 →
   first chunk 18:49:44.497 — 120s keeps ~3× headroom); < ring 2's 300s, so
   a stall resolves as the retryable leg rather than the watchdog's
   non-retryable cancel, and each retry's `llm/retry` journal append re-arms
   ring 2; numerically the ring-1 tool budget — one family. Worst case for a
   sustained black hole: 6 attempts × 120s + ~35s backoff ≈ 12.5 min to an
   honest errored turn (vs forever). boot.js forwards
   `llm.readIdleTimeoutMs` so hosts can tune without code changes.
4. **Panel pins** (test/panel/llm-transport-read-idle.test.js, 12 cases over
   a scripted fake that mirrors the real gateway contract — parked
   `next()`, abort-wakes-rejection): frozen mid-stream attempt → TIMEOUT at
   exactly the budget (one tick short stays patient); the failure carries
   TIMEOUT in `.code`/`.failure` and names the watchdog; sub-budget lulls
   (repeated 0.6–0.7× pauses) never trip; the guard is per-attempt (a
   timed-out attempt does not leak into the retry's stream); zero-byte
   signal abort unwinds as ABORTED via the bridge; mid-stream abort reads
   ABORTED not TIMEOUT; TRANSPORT and STREAM_CLOSED legs unchanged; the
   120s default is live behavior; six bad-config values fail loud. The
   suite's `@deepseek-ai/dsh-llm` stub grew the four adapter-seam faces
   (`LlmError`/`LlmAdapter`/`attributionHeaders`/`isAgentLoopRequest`),
   mirroring the vendored shapes.

Closures re-synced (build.sh sync android + sync harmony, both byte-verified;
the iOS embed regenerated locally — the bundle itself is gitignored, CI's
macOS leg regenerates from the committed list). The new module rode every
closure list: android's stager picks up `upstream/` wholesale, harmony got
rows in `vendor-official.sh`'s SPINE_OURS and `Index.ets`'s BUNDLE_FILES
(the anti-drift check caught the missing row — its FAIL is the gate
working), and iOS a row in `gen_bundle_header.py`. The sync also lands
android's `dsh-llm-retry@0.1.6-alpha.2` staged copy as TRACKED bytes: the
loop-u PR pinned the package, but the android assets copy existed only as an
untracked dev-tree leftover, so fresh checkouts staged without it.

Honest limits: (a) the initial `httpFetch` await (the response-headers phase)
has no JS-reachable abort id in the gateway contract — a stall BEFORE the
first byte of any response remains unabortable without a new gateway
primitive; both field stalls were read-side-after-bytes, in scope here.
(b) A provider that goes truly byte-silent >120s mid-generation would be cut
off; live providers emit reasoning deltas or keepalives well inside that
(mseat evidence: deltas every few ms), and the failure is retryable, so the
worst case is one wasted attempt.

## Alternatives considered

- **Wire a vendored timeout parameter** (the queue row's option b) —
  refuted by the pin: `dsh-llm-retry@0.1.6-alpha.2` exposes no attempt
  timeout at all (`Config = z.object({})`; it is purely an
  `agent/request-error` recovery interceptor), and the vendored LlmRuntime's
  stream path has no deadline hook. The attempt is owned by the adapter —
  the seam is the only place that can both arm the budget and reach
  `response.abort()`.
- **Race the body iterator against a timeout promise** (Promise.race per
  read) — rejected: it abandons the parked gateway read instead of unwinding
  it (the socket stays half-open, the runtime queue keeps the dead
  generator), and loses the honest `response.abort()` teardown.
- **Map the idle failure to TRANSPORT** (reuse the existing wrap) —
  rejected: dishonest journaling. The retry policy retries both codes, but
  the battery forensics read `failure.code` to attribute stalls; TIMEOUT is
  the accurate class and is explicitly in the vendored
  DEFAULT_RETRYABLE_CODES.
- **Fix at the turn-watchdog layer** (teach ring 2 to force-abort the
  response) — rejected: the watchdog has no handle to the transport's
  response; it would need a registry of in-flight attempts, a second seam —
  and its cancel is deliberately NON-retryable, so the 1/5..5/5 rhythm
  (the upstream answer) would never run.
