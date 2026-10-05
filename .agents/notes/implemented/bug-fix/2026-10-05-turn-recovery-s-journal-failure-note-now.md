# Agent Note: turn-recovery's journal failure note now carries the surface append marker

Status: implemented
Related: D9

## Problem

The loop-u turn-failure supervisor (battery-r18 W1, d2ad04b9, seat
emulator-5556) wanted to append its honest "Turn failed: …" note to the
session journal after the offline retry budget exhausted — and the append was
rejected: `session event "system/message" is surface-eligible and requires a
surfaceOp marker` (09:08:30.429, session-619cf8ec). The user-visible failure
banner survived because it rides the live bus, but the durable journal record
was never written: history and audit lose the failure note for every errored
turn, silently (the supervisor's catch logs a warn and moves on — the
degradation was by design, the rejection was not).

The vendored session log's contract (`@deepseek-ai/dsh-session`
lib/index.js `Session.append`) makes `surfaceOp` a REQUIRED third-argument
option on the four message-producing event types (`system/message`,
`user/message`, `assistant/message`, `tool/result` — surface.js's
`SURFACE_EVENT_TYPES`): every event that joins the model-visible surface must
declare how it joins. The supervisor's append passed only `(type, data)`.

## Decision

`runtime/spike/upstream/turn-recovery.js` appends the failure note with
`{ surfaceOp: 'append' }` — the plain append op, because the note is a NEW
surface node at its own log position (it shadows no existing range, so the
replace shape would be a semantics lie). This is the same marker the vendored
driver itself stamps on every `user/message` it commits (dsh-agent-loop
lib/index.js sendMessage), so the note now lands in the journal exactly the
way every other chat message does — durable, and rendered by the client that
folds journal messages. The banner bus path is untouched; the catch-and-warn
guard stays as the never-mask-the-recovery backstop.

The validation was NOT loosened: it is upstream code (vendored trees are
never edited, D9), and it is correct — the caller's shape was wrong.

Pinned by `test/panel/turn-recovery.test.js`: every appended note must carry
`{ surfaceOp: 'append' }` (the fake records the append's opts argument), and
a rejected append still re-arms the driver — plus a throwaway probe (run in
the fixing session, not committed) proved against the real vendored
`Session.append` that the marker-less shape throws exactly the field error
and the new shape is accepted.

## Alternatives considered

- **Switch the note to a non-surface event type** (e.g. a lifecycle or
  log-only record): loses nothing in validation terms, but there is no such
  type that carries a chat-visible message — `system/message` IS the journal's
  user-readable record, and the loop-u design contract is "one durable system
  message on the session journal, visible in chat". Downgrading the event kind
  would trade an audit-record bug for a lost user-visible record.
- **Default `surfaceOp: 'append'` into the vendored `Session.append`** when a
  surface-eligible type arrives marker-less: an edit to vendored upstream code
  (D9 forbids) and a validation relaxation that would let future callers
  append surface events without deciding how they join the surface — the
  explicit marker is the contract's point.
- **Catch the rejection and re-append with the marker** (compat shim at the
  call site): keeps a dead first append in the path and teaches future readers
  the wrong shape works; the direct fix makes the one call correct.
