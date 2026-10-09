# The watchdog kill renders as an error on the page-facing wire

Status: implemented
Date: 2026-10-10 · Class: bug-fix · Track: AR (abort-render seam) · Card: T-0210

## Problem

A watchdog-killed turn rendered as a BLANK reply. The measured chain: the
vendored agent-loop classifies EVERY cancel as `aborted` — the kill rides
`agent.cancel(cause)` → `phase.abort.abort(cause)` and the loop's catch turns
any aborted signal into `turn/end {kind:'aborted', reason: cause}`
(agent-loop@0.1.6-alpha.2 lib/index.js, the `signal.aborted` arm of the turn
catch). The vendored chat page renders a failure notice only for
`kind:'error'` reasons (dsh-client-ui-chat failureFrom; the P1 #432 round
established this) and silence for `aborted` — so the turn watchdog's honest
kill (a system failure the user did not choose, `cause {kind:'watchdog',
message:'no turn progress for Nms'}`) reached the page as nothing at all.
The journal recorded the truth, but the journal is not what the user reads.

## Decision

`upstream/web-write-streams.js` — the ONE page-facing serialization of
journal records, shared by the `session/follow` snapshot, the live event
fan, and `session/page` — now projects the turn/end reason through
`wireTurnEndReason`: an aborted reason whose CAUSE kind is `watchdog` (the
class our watchdog chooses; the user's cancel chooses `{kind:'user'}`) is
presented as `{kind:'error', error:{code:'watchdog',
message:'turn aborted: <cause.message>'}}` — the shape the vendored page CAN
render, with the watchdog's own message kept readable. Every other abort
class passes through untouched: a USER cancel keeps its correct aborted
silence, `disposed` stays aborted (a teardown, not a mid-turn failure — and
a post-restart error banner for every app update would be a false alarm),
and non-abort reasons (completed/max-tokens/blocked) are untouched.

The rewrite is presentation-only and one-sided: the journal keeps the honest
`aborted`+watchdog record, and the settle evidence fold
(`web-live/turn-failure.js`, which reads the spine event, not the wire) is
unchanged — pinned by the new spine suite
(`test/panel/spine/watchdog-abort-wire.test.mjs`), which drives the REAL
makeTurnWatchdog at a 400ms budget over the REAL vendored closure and
asserts all three page faces (live fan, reopened snapshot, session/page)
read `error` while the spine record stays `aborted`.

## Alternatives considered

- **Fix the classification at the source** (make the watchdog kill produce
  a kind-error turn end): rejected — the classification happens inside the
  vendored loop's catch, where `signal.aborted` admits no error-shaped
  outcome; changing it means editing vendored bytes (the D6 red line).
- **Rewrite in the settle projection** (`installTurnEvidence`, the P1 fold):
  rejected as the primary seam — it is log/evidence-facing; the page does
  not read the settled record's error object. It also reads the spine
  event, so it would not have changed what the user sees. Kept honest and
  unchanged on purpose.
- **Rewrite the journal record itself** (a `session.append` interception):
  rejected — the journal is the durable record of what happened; falsifying
  it to please a renderer corrupts every future consumer.
- **Broader class rewrite** (any non-user abort → error): rejected for now —
  `disposed` kills ride app teardowns; rendering them as errors would show
  spurious failure banners on every restart. Revisit if a mid-turn system
  kill class beyond `watchdog` appears.

## Consequences

The page can now distinguish "you stopped it" (silent) from "the runtime
stopped it" (error notice with the watchdog's reason). The vendored gap for
the user-cancel UX (aborted renders nothing at all) remains upstream's —
that silence is correct semantics, and if it ever needs an indicator it is
an upstream page change, not a runtime one.
