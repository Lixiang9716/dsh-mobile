# Agent Note: session/fork: the seat forks the journal server-side — the composer Fork leg's child session

Status: implemented
Related: D9

## Problem

The composer dialog's "Fork session" already POSTs `session/fork` with
`{args: {request: {sessionId, atSeq?}}}`, but the seat never claimed the
endpoint — the fork E2E's server-side half is missing, and the api-coverage
probe still pinned `session/fork` (with the since-landed
`sessionFeedback/record`) as must-stay-unclaimed, a stale pin against the
wire contract the page already speaks. Forking is a journal operation: the
child must replay the parent's committed events up to one completed turn,
carry the fork lineage (`parentSession`, `isSeeded`, `inheritedEventCount`)
the session store's persistence and projections read, and appear live to
the runtime (a bare store session would dead-end the next prompt at
agent resolution).

## Decision

`makeSessionForkHandlers(ctx, deps)` (web-write-catalog.js, the historical
claim set beside selectModel/feedback) implements the desktop controller's
commands.fork semantics, narrowed to v0 per-conversation fork: the source
resolves through ctx.agents.get (session/not-found when unattached); the
cut is the LAST `turn/end` event — or, with `atSeq`, the first turn/end at
or after it, a position past the log's end falling back to the last, and a
position inside an uncompleted turn refusing with the controller's own
`session/fork-unavailable` code and message shapes (invalid atSeq →
gateway/bad-request). The child is created as a LIVE agent through
`agents.create({sessionId: `session-${uuid}`, seed: events.slice(0, cut),
inheritedEventCount: cut, meta: {cwd?, parentSession, isSeeded: true},
agentOptions: {provider, model} from the boot route})` — exactly the
`prepare()` facts the session store's own fork primitive writes, with the
store's seeded-prefix invariant (seed length = inheritedEventCount) holding
by construction — and is attached to the profile's one seeded workspace
(session/create's attach). The desktop's forkWorkspace copy orchestration
and preset re-composition are deliberately absent (v0: the child shares the
parent's workspace; the replayed journal keeps the dialog's model view
honest). The boundary scans use plain loops — adapter code does not assume
the embedded engine's findLast/at tail.

## Alternatives considered

- The session store's native `fork(source, boundary, childId)`: lost as the
  call target — it creates a BARE session with no live agent, so the next
  prompt to the child would fail agent resolution; its validated slice and
  meta shape are mirrored instead (and its open-turn rejection is
  unreachable for our cut, which always ends on a turn/end).
- Full desktop parity (sessionQuery.observeSession over persisted sessions,
  forkWorkspace copy, preset re-composition via composeAgent): lost for v0 —
  the mobile profile serves live agents and one seeded workspace; the
  per-conversation fork the dialog offers needs none of that, and the
  orchestration would drag persistence/copy machinery the seat does not
  mount.
- Cutting at `atSeq` literally (any event position): lost — the wire
  contract's completed-turn rule exists so a child never resumes mid-turn;
  the store's own fork rejects open-turn cuts, so honoring the desktop's
  turn/end boundary keeps the child promptable.
