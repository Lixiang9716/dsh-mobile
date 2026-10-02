# Agent Note: sessionFeedback/record answers the wire's own result union — sync-handler and request-nesting fix

Status: implemented
Related: D9

## Problem

After #311 the composer feedback dialog still could not save on the release
seat: every Submit deterministically ended in the UI's "Could not save
feedback", with the bridge answering its own
`gateway/unimplemented — endpoint sessionFeedback/record is not implemented
by the Phase-B carrier` envelope (measured: exactly 30.04s after submit —
`CarrierAPIBridge.RESPOND_TIMEOUT_MS`). The anomaly looked like a claim-layer
bug: `session/selectModel`, added to the SAME `WRITE_ENDPOINTS` list and the
SAME api map, "forwarded fine" on the same boot (probes answered ok in ~40ms),
so the working hypothesis was that `claimedEndpoints` contained selectModel
but not sessionFeedback/record. Three stacked defects were actually hiding
behind that envelope, none of them in the claim layer:

1. the #311 handler was the ONLY sync handler in the write surface's api
   map, while both seats' `onHandler` does `outcome.run().then(...)` — a
   plain-object return exploded `TypeError: not a function` inside the bus
   delivery (logcat: `FAIL serve bus deliver: TypeError: not a function |
   stack: at onHandler (scenario/composer-web-live.js)`), before any
   `api.respond` was posted;
2. the handler read `args?.sessionId` at top level, but the generated
   remote's ONE parameter is wire-named `request`
   (dsh-api-gateway `prepareInvocation` keys args by `parameter.wire`, then
   posts `payload = {args: prepared.args}`), so the page's frozen envelope
   nests the fields: `{args: {request: {sessionId, text?, category?}}}` —
   the same convention `session/prompt`'s frozen envelope already documents;
3. the answer shape was a bare `{recorded: true}`, but the wire face is the
   vendored `SessionFeedbackService.record` result union — the page's
   `recordSession` reads `carried.value.ok` / `carried.value.error.code`, so
   a bare `{recorded: true}` made the dialog's submit path throw
   `TypeError: Cannot read properties of undefined (reading 'code')` even
   with 1+2 fixed (measured on the intermediate build).

The "selectModel works" reading was an artifact of verification: every
green selectModel observation rode hand-built TOP-LEVEL payloads
(`{args: {sessionId, provider, model}}`), which matched its handler's
top-level read and its async return; the REAL dialog commits ride the
nested envelope and carried the same defects 2 (and, for any sync handler,
1).

## Decision

`web-write-catalog.js` reworks `makeSessionFeedbackHandlers` to answer the
vendored service's own contract, and `makeModelSelectionHandlers` to take
the same request unwrap:

- `sessionFeedback/record` is `async` (every handler in the map must return
  a thenable — the seats' `onHandler` awaits one);
- the args unwrap is `args?.request ?? args ?? {}`, the
  `makePromptSession`/`makeCreateSession`/`makeCancelSession` convention —
  top-level synthesized probes stay answerable;
- resolution is `ctx.agents.get(request.sessionId)` with the vendored
  IN-BAND answers: `{ok: true, value: {recorded: true}}` on success,
  `{ok: false, error: {code: 'session-not-found', sessionId}}` resolved
  (never thrown — a thrown remoteError would surface at the connection
  level with the wrong code vocabulary for this face);
- the text/category projection is `recordFeedback`'s own (trim, blank text
  absent, category absent when undefined).

`session/selectModel` takes the same unwrap (its handler body is otherwise
unchanged). Both host copies (android assets, harmony rawfile) re-staged
byte-identical by `build/build.sh sync`. Device proof on the release build
(emulator-5554, plain launch, official page): the REAL dialog submit saves —
the page's own fetch answers
`{ok: true, value: {ok: true, value: {recorded: true}}}` in ~30ms and the
recorded toast replaces "Could not save feedback"; the same-envelope probe
answers in 12ms (was 30s + carrier envelope); zero `FAIL` seat lines.

## Alternatives considered

- Hardening the seats' `onHandler` to tolerate a non-thenable `run()`
  result (wrap in `Promise.resolve()`): lost — it would have kept the sync
  row as the map's single exception and masked the next sync handler; the
  convention (async handlers, fail loud on a claimed-endpoint failure) is
  the contract the E2E discipline leans on.
- Throwing `remoteError('session/not-found', ...)` for the unknown-session
  leg (the #311 note's reading): lost — the api-remotes result schema for
  this face literals `code: "session-not-found"` as an IN-BAND member;
  a connection-level error with the slash vocabulary is outside the page's
  strict codec and the desktop service resolves it in-band.
- Keeping `WRITE_ENDPOINTS` but dropping the endpoint from the claim until
  the shape was right (unclaim → carrier answers immediately): lost — it
  regresses #311's user-visible goal and hides the defect behind the
  structured shrug the surface refuses to fake.
- Fixing only the payload unwrap (the first intermediate build): measured
  insufficient — the dialog still failed, which is what exposed defect 3;
  the three legs ship together because each alone leaves the dialog
  broken.
