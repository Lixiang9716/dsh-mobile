# Agent Note: the composer feedback dialog saves — sessionFeedback/record lands in the mobile seat

Status: implemented
Related: D9

## Problem

The composer's feedback dialog (Add → Feedback) rendered fully — categories,
comment, Submit — but Submit hit `sessionFeedback/record`, which the Phase-B
carrier did not implement: the UI answered "Could not save feedback" and the
feedback was lost (found by the interactive functional battery, round 5).

## Decision

`web-write-catalog.js` gains `makeSessionFeedbackHandlers` claiming
`sessionFeedback/record` (the wire face of dsh-command-feedback): it resolves
the live agent for the wire's `sessionId` (liveAgent's `session/not-found` is
that face's own error code), appends a `feedback/record` journal event
(`{category, text?}` — the type is in the session event vocabulary), and
answers the wire's `{recorded: true}` envelope. `WRITE_ENDPOINTS` claims the
endpoint so the surface serves it on interactive and non-coverage boots alike.
Minimal by design: the journal record IS the v0 persistence (the desktop's
feedback storage rides the same session log).

## Alternatives considered

- Writing feedback to a profile-container file (a feedback "store"): rejected —
  the journal is the session's durable record and the desktop replay reads it;
  a second store would fork the feedback truth for no v0 consumer.
- Routing through the /feedback command (commands/execute): rejected — the
  dialog is a direct wire caller, not a slash-command flow; the command path
  adds the command/run lifecycle without adding durability.
