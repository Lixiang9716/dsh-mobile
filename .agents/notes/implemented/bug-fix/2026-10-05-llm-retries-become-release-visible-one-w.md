# Agent Note: llm retries become release-visible: one warn per scheduled retry at the recovery-ring mount (loop-x2)

Status: implemented
Related: D9

## Problem

The mobile runtime schedules provider-policy LLM retries (the loop-u answer:
`@deepseek-ai/dsh-llm-retry` answers `agent/request-error`), but the retry's
only emission is `agent.session.append('llm/retry', …)` inside the vendored
plugin's `backoff()` (dsh-llm-retry lib/index.js:141) — a journal event with
no log call. On the seat, a retry is therefore observable only through the
mux `session/follow` WS stream; the "Retrying model request" string lives in
the dsh-client-ui-chat banner component, so a release or headless seat shows
ZERO retry trace in logcat while retries schedule. Measured 2026-10-05 on
emulator-5556, release 318fb22e, during the battery-r14 W1 airplane-mode
drive: `grep -i retry` across the whole logcat buffer held no DSH line, while
the session journal recorded `llm/retry 1/5` (provider bigmodel, TRANSPORT
"gateway SSE stream failed: Connection reset") at 02:50:59 (session-24caad84)
and 02:58:20 (session-cea11420) — evidence
`/home/lx/dsh-mobile-artifacts/battery-r14/w1b-follow-frames.log:18-23`.

This is the loop-x principle's blind spot (#371 taught new failure classes
stay release-visible; llm retries were a failure class nobody could see in a
release build). Retry telemetry belongs to the operator signal the release
strip deliberately keeps (logger.js `RELEASE_CRITICAL_LEVELS` = warn/error),
not to the per-event debug stream.

## Decision

One mobile-layer plugin, `runtime/spike/upstream/retry-telemetry.js`, mounted
in boot.js's `mountRecoveryRings` between the vendored retry plugin and the
turn-failure supervisor. It rides dsh-session's `session/event` append
dispatch (the same fan-out the model-selection holder and the mux streams
already subscribe) and converts every `llm/retry` journal append into ONE
`log.warn` — warn survives the L4 release strip, so the scheduled retry is
visible exactly where a release seat looks. The message carries the attempt
ordinal and the failure category, e.g.
`llm request retry scheduled — attempt 1/5: TRANSPORT gateway SSE stream
failed: Connection reset`; the structured data field names provider/turn/
step/retryId for correlation with the journal. Bounded by the provider policy
(maxRetries, 5 on the shipped route), one chain is at most maxRetries warns —
never a storm. The always-retry mode (no ceiling) renders a bare "attempt N".
Scope guard: this is retry telemetry on the unified sink, not a scenario-
verdict concern (#371's suppressed-fail warn is a different seam) and not a
recovery-flow change — a warn-listener failure is contained by the journal's
per-listener containment.

Closure discipline: the android assets mirror stages `upstream/*.js` whole
(stage-spine-closure.sh), so the new file rides it; harmony stages from the
explicit `vendor-official.sh` closure list, which gained the
`upstream/retry-telemetry.js` row, mirrored in Index.ets's BUNDLE_FILES
(check-bundle-files pins both directions). Panel pin:
`test/panel/retry-telemetry.test.js` — one llm/retry event → exactly one
warn with ordinal and category; non-retry traffic silent; malformed payloads
never throw into the journal dispatch.

## Alternatives considered

- **A warn inside the vendored dsh-llm-retry `backoff()`** — the most direct
  line, but vendored upstream files are never edited in this repo (D6):
  adaptations live in the mobile layer. Lost to the outboard plugin shape.
- **Subscribing `agent/request-error` instead of `session/event`** — that
  waterfall fires for EVERY request failure, including non-retryable codes
  that never schedule a retry and terminal failures the turn supervisor
  already reports; a warn there would announce retries that never happen and
  double-report deaths. The journal append is the exact "a retry was
  scheduled" fact, so the telemetry keys on it.
- **Riding the UI banner string** — the "Retrying model request" text lives
  in dsh-client-ui-chat (a web client), absent from release/headless seats
  by construction; the whole defect is that it is not a runtime signal.
- **log.error instead of warn** — a scheduled retry is the system working as
  designed, not a failure; warn keeps it in the release-critical set without
  inflating the error surface.

## Consequences

Release logcat now shows one line per scheduled retry (grep `llm request
retry`), closing the loop-x2 observability gap; debug/info streams stay
stripped. The next battery's airplane-mode drive can assert retry scheduling
from logcat alone.
