# Agent Note: session/selectModel install-or-returns the selection holder — a page-created session's first pick no longer kills the spine

Status: implemented
Related: D9
Supersedes-one-claim-of: the feature note 2026-10-02-session-selectmodel-applies-its-pick-to- (its "a boot that installed none refuses the pick fail-loud" leg)

## Problem

On the interactive seat (release build, main @ add4782, the staged
two-model credential), the composer model dialog's first commit killed the
whole spine: turn A served on the boot route, the dialog's
`session/selectModel` POST got the carrier's structured unimplemented after
exactly the 30s respond window, turn B still completed on the BOOT route,
and `SessionServe: FAIL the spine scenario failed` then fired on every
later bus delivery (each m4 settle/event/bus call re-reports a completed
scenario's status). Two gaps compounded:

1. The runtime DID run the selectModel handler — the endpoint was claimed —
   but the handler refused the pick with `gateway/internal: model-selection
   holder is not installed for this session`. The holder is installed at
   boot for the CONFIGURED agent only (`mountModelSelectionHolder(ctx,
   agentRoute, sessionId)`), while the dialog names the session the PAGE
   created through `session/create` → `agents.create` — a different agent
   whose WeakMap entry never exists. The desktop controller this module
   mirrors is install-or-return per agent (`selectionFor(agent)`: "Install
   or return the Session-local model selection"), and `selectForNextRequest`
   works for ANY live session; the mobile port deviated by refusing.
2. The scenario's fail-loud contract turned that refusal into death, and
   `js_complete` discarded `__dshComplete`'s reason argument, so the FAIL
   line carried no cause and the on-device logs (release strips the JS
   logger's debug/info) could not say why.

## Decision

- `runtime/spike/upstream/web-write-catalog.js`: the selectModel handler
  install-or-returns the holder like the controller's `selectionFor` —
  `sessionModelSelection(agent) ?? installSessionModelSelection(ctx, agent,
  {provider, model})`. The lazy fallback is the agent's own creation route
  (the write surface's llm route, effort omitted — `makeCreateSession`
  passed exactly that), so a created session's first request config is
  byte-identical whether or not a holder got installed; the configured
  agent's boot-installed holder is untouched (the boot mount stays, and the
  projection unit still registers there).
- `runtime/spike/host/dsh_spike_host.c`: `js_complete` keeps a failing
  scenario's reason (the `__dshComplete(false, reason)` string) in the
  host's error slot, so every embedder that reads `dsh_spike_error()` at
  completion — the android m4 status-2 branch, the harmony napi !pass legs,
  the iOS drive's onComplete message — reports WHY.
- `hosts/android/.../cpp/dsh_spike_m4.c` + `SessionServe.kt`: the status-2
  branch copies the reason into the m4 last-error slot and the FAIL line
  reads it: `the spine scenario failed: <reason>`. Verified on device: the
  next failing run named the refusal verbatim, which is what pointed at the
  root cause.

## Alternatives considered

- Installing the holder for every created session at `session/create`
  (an `agents.create` listener or inline after create). Beat by the lazy
  install: one call site, and sessions that never select stay holder-less
  (byte-identical turns), where a create-time install would register the
  assemble/request/pre-step waterfalls for every conversation whether or
  not its dialog is ever used.
- Seeding the lazy holder's `picked` from the modelSelection projection's
  `pending` like the controller does: lost — on this host a `pending` can
  only exist if a pick was already journaled, and the only writer journals
  through this same handler after it holds the holder; the state the
  controller seeds from cannot arise here.
- Answering claimed-endpoint failures with the structured wire error
  instead of failing the scenario (the 30s carrier timeout the page sees
  before the FAIL): deliberately kept as is — the scenario's fail-loud
  contract treats a claimed endpoint's failure as a defect, and with the
  holder fixed the defect class this note covers is gone; weakening the
  contract would hide future handler bugs behind a page-visible shrug.
- Kotlin-only diagnosability (parsing the scenario's `scenario.failed` log
  line): rejected — release strips logger debug/info, so the line never
  reaches logcat; the reason has to ride the native completion path.
