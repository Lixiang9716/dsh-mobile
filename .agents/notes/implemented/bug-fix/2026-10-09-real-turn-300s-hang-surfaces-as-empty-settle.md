# Agent Note: the 300s silent hang now fails fast, and an empty settle names why

Status: implemented
Related: T-0209 (the P1 track card), upstream/turn-watchdog.js (loop #323 ring 2),
upstream/llm-read-idle.js (loop-u2), upstream/llm-retry-pacing.js (loop-c2)

## Problem

A real user turn (2026-10-09, bigmodel via the BYOK route) hung for the full
turn-watchdog budget and settled with `write.turn.settled {events, text:""}` —
no error anywhere: the user watched ~5 minutes of spinner and got an empty
reply. The device capture log pinned the exact shape (session-4331764d, two
wire attempts to `https://open.bigmodel.cn/.../chat/completions`):

1. Both attempts parked BEFORE response headers — zero `http.body` events,
   each killed only by the platform's `readTimeout` (HttpFetch.ets, 300s,
   `Operation timeout`). The concurrent second session streamed ~150 SSE
   lines fine through the whole window, so the stall is per-connection, not
   a stack/host/key limit.
2. The JS read-idle watchdog (120s, loop-u2) never armed: it lives in
   `parseSse` (upstream/llm-transport.js), which starts only AFTER headers
   settle. The pre-header wait had no JS-level deadline and no caller-abort
   bridge — `openWireStream` awaited `httpFetch()` bare.
3. One attempt therefore consumed the turn watchdog's whole 300s silence
   budget; the watchdog killed the turn as an ABORT before the retry ladder
   could exhaust. The settle record carried no reason, and the vendored chat
   UI renders a failure notice only for `turn/end` reasons of kind "error"
   (dsh-client-ui-chat `failureFrom`) — a watchdog abort renders nothing.
   Every channel the page and the operator read stayed silent.

Diagnostic experiment (2026-10-09, emulator, real bigmodel route): a live
concurrent pair (two sessions prompted ~0.3s apart) both completed with full
text — no reproduction; the captured incident stands as the repro evidence
(~1-in-7 real turns that day). The host proxy (Clash/mihomo on :7890) is OUT
of the app's path (Emulator.exe holds the direct 192.168.1.3→:443 sockets,
nothing transits 7890), ruling out candidate (c); same-key concurrency and
harmony-stack concurrent SSE are ruled out by the incident's own concurrent
survivor plus the live pair.

## Decision

Three coordinated changes, one per layer of the wedge:

1. **Host stalled-read guard** (hosts/harmony/.../HttpFetch.ets): an explicit
   `STALLED_READ_TIMEOUT_MS = 120_000` timer arms at `fetch()` and re-arms on
   every delivered byte; firing flags the call `stalled` and destroys the
   request, so BOTH the pre-headers window (where the read-idle watchdog does
   not exist yet) and mid-body silence fail in ≤120s with a deterministic
   `timeout` code and a message naming the stall. 120s is the read-idle guard
   family's number and ≥3× the measured worst legitimate time-to-first-byte
   (38.1s); the platform `readTimeout` stays as the coarse backstop. Timer
   state clears on every terminal path (end/error/abort/forget).
2. **Settle-record failure fold** (runtime/dsh/web-live/turn-failure.js, new;
   wired into composer-web-live.js and harmony-composer-live-write.js
   installTurnEvidence): the `turn/end` reason plus the session's newest
   `llm/retry` journal line fold into an additive structured `error`
   `{kind, code, message, lastRetry?}` on `write.turn.settled`. Normal
   completions emit byte-identical records (the fold returns null; the E2E
   matcher pins fields by subset, verified in test/e2e/check.mjs matchOne).
3. **Retry budget review** (no constant changes): the vendored dsh-llm-retry
   ceiling stands — 5 retries, `maxRetries: 5` pinned by
   test/panel/llm-retry-pacing.test.js, exhaustion hands the error on (the
   turn errors). A stalled-read failure is a SLOW fail (≥120s ≥ the 5s
   FAST_TRANSPORT_FAIL_MS line), so it stays unpaced and each retry's
   `llm/retry` journal append re-arms ring 2 — with per-attempt ≤120s the
   ladder now always finishes inside watchdog budgets, and the turn ends
   `reason.kind === "error"`, the one shape the vendored page renders.

Plus the closure/bookkeeping rows the new module owes: vendor-official.sh's
SPINE_OURS, stage-spine-closure.sh's web-live lists (stage + check),
Index.ets BUNDLE_FILES.

## Alternatives considered

- **Lowering the platform `readTimeout`** (the 300s constant) instead of an
  explicit guard: the platform's timeout semantics are not precisely
  documented (between-bytes vs whole-read) and the 2026-10-06 measurement
  (glm-5.3-flash cut at 30s thinking) shows legitimate think-time can exceed
  short values; a host-side byte-liveness timer has exact semantics and is
  testable by inspection. The platform value stays as backstop.
- **Bridging the caller's abort signal into the pre-settle request** (so a
  watchdog cancel kills the wire immediately): the gateway shim cannot abort
  a call that has not settled (no bodyId/callId escapes before headers), so
  the JS side has no handle; only the host can bound that phase. The 120s
  guard bounds the orphan instead.
- **Fabricating a visible failure record the page renders** (e.g. appending a
  synthetic assistant/system message): pollutes the durable journal the next
  turn reads as model context. Rejected; the honest journal reason plus the
  settle record's structured `error` is the contract surface, and with (1)
  the page-visible failure notice now fires through the vendored
  kind-"error" path.
- **Pacing stall-class retries wider** (loop-c2 changes): pointless — a
  120s stall fail is already slow/unpaced, and widening would only delay
  exhaustion past the watchdog again.

## Consequences

- A headerless or mid-body dead stream now costs ≤120s per attempt instead of
  300s, so the retry ladder completes and the turn settles with a real error
  — surfaced in the capture log (structured `error` on the settled record),
  in the journal (`turn/end` reason kind "error"), and therefore in the
  vendored page's failure notice.
- Legitimate streams silent >120s between bytes (no SSE keepalive from the
  provider) now fail fast where the JS read-idle guard already would have cut
  them post-headers — the pre-header TTFB headroom (3× the 38.1s worst
  measurement) is the new trust boundary.
- The watchdog-abort rendering gap (upstream renders nothing for
  kind-"aborted") remains for genuine runtime wedges; it is the vendored
  page's design and upstream-frozen (D6) — the settle record now names those
  cases for the operator.
