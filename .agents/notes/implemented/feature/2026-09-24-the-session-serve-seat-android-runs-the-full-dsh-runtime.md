# Agent Note: the SessionServe seat — the Android user-facing boot runs the FULL DSH runtime

Status: implemented

## Problem

The Android release distribution mounted the official Web Client over a
compose-only carrier: no gateway, no claims, no spine — the page's mux
connection never established (`connection lost, retry #N` forever) and
every runtime-backed surface answered `gateway/unimplemented`
(issue #177, found in the overnight release walkthrough). A release user
could not pick a workspace, create a session, configure a model, or run
an agent turn. iOS had crossed the same gap the same day (#184 +
#190): its `SessionServe` seat boots the full vendored spine with the
INTERACTIVE surfaces behind a flag and folds the claims seam; the
resident `composer-web-live.js` entry (already in the shared
`runtime/spike/scenario/` source) answers the write surface, the
settings probes and the mux feeds. Android was the last host whose
user-facing boot served a dead shell.

## Decision

1. **`SessionServe.kt`** (new, the Kotlin sibling of iOS
   SessionServe.swift): carrier + official dist + `/plugins` + the
   `/api`+mux bridge + the scripted `mock-llm` endpoint, and the runtime
   half booted through `scenario/composer-web-live.js` with the FULL
   primitive descriptor (fs / httpFetch / keychain / notify / ui / timer)
   and the `SessionWriteSeam` folding `api.claim` / `mux.claim` /
   `api.respond` / `mux.*` into the bridge. The runtime.config delivers
   the workspace (`<appScope>/spike` — a REAL directory, so agent writes
   survive relaunches), `fsScopeRoot`, the staged credential when present
   (`<appScope>/llm/config.json`, shape identical to the
   `llm.live-stream` runner's; the key never reaches a record), and —
   interactive only — `commands: true` plus the skill-plane paths
   (`home`, `home/agents`, `skills` inside the workspace). The page opens
   once the composed boot wire AND the settings probes are in (or
   immediately on a runtime failure — the page renders its own honest
   state, never a dead screen). No verification drive, no verdict panel,
   no canonical records: the release half of constraint 5 / rule L4.
2. **`MainActivity.bootRelease`** constructs the seat
   (`SessionServe.loadCredential` + interactive default) instead of the
   compose-only `OfficialWebSession` serving mode; the E2E drives keep
   their own sessions untouched.
3. **`stage-spine-closure.sh`** stages `scenario/composer-web-live.js`
   into the APK assets (both the staging list and the check list — the
   entry existed only in the iOS embed until now).
4. **`FsPrimitives`** gains the contract v1.1.0 stat / list / mkdir /
   remove / rename handlers (Kotlin port of the iOS additions, same wire
   shapes and defaults; app scope over `java.io.File`, tree scopes over
   DocumentsContract). The upstream file service and the composer-web-live
   boot probes call them; the descriptor advertised them without
   handlers. `wasmRun` stays advertised-but-unregistered on Android (the
   write-live legs never call it; porting wasm3 into the Android NAPI
   build is its own round).

## Alternatives considered

- Extending `OfficialWebSession` with an `interactive` flag (the iOS
  hook-block shape) — the Android class hardwires the compose-only
  descriptor and the fail-loud "unexpected gateway call" bridge; rewiring
  it would have made the evidence drive's byte-identical-boot guarantee
  conditional on a flag instead of a file boundary. The separate seat
  mirrors what iOS actually shipped (SessionServe + SessionWriteRuntime
  as distinct files) and keeps the manifests' proof untouched.
- Hand-rolling the `llm/listProviders` answer to light up the Models tab
  — the page joins `llm/listProviders` + `llm/listConfigurableProviders`
  + `credentials/describe`, i.e. the CONFIGURABLE-provider and
  credentials management plane, a different surface from the runtime's
  built-in registry. Faking one endpoint would half-light a page whose
  writes have no backend. It stays the honest named gap (follow-up on
  issue #177).

## Consequences

Verified end-to-end on the release build, driven like a user: cold boot
→ the official client's first-run notice renders (the client module
system is live) → Continue → the composer offers `/` commands and `@`
files → the workspace picker lists the seeded `spike` workspace → a
typed message admits a REAL upstream agent-loop turn and "Hello from
upstream" streams back through the mux journal into the official UI →
the session appears in the sidebar list and persists. The mux
`connection lost` loop is gone (zero retries in the boot log). The
Models tab remains the honest `llm/listProviders` gap (structured error
+ Retry), owned as the next integration round.
