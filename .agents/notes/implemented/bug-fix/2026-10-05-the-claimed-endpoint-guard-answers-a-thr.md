# Agent Note: the claimed-endpoint guard answers a thrown handler in band before any verdict (loop-w2)

Status: implemented

## Problem

A malformed-but-valid-JSON `POST /api/session/prompt` envelope (payload
missing the `{args:{request:…}}` wrapper) black-holed the HTTP caller for
the full `RESPOND_TIMEOUT_MS` — 30.0s measured (three probes,
2026-10-05 battery-r14 seat, emulator-5556 @ 318fb22e) — and was then
answered by the carrier's `gateway/unimplemented` timeout envelope, while
well-formed payloads answered `{accepted:true}` in 21–33ms. Mechanism:
`makePromptSession`'s shape check (`args?.request ?? args` unwrap,
upstream/web-write.js:316) rejected the envelope with the structured
`remoteError('gateway/bad-request', …)`, but the drive legs in the three
write scenarios (composer-web-live.js, android-composer-live-write.js,
harmony-composer-live-write.js) routed EVERY handler rejection to the
scenario `fail()` WITHOUT posting any `api.respond`. On the resident seat
the drive has long completed by then, so the suppressed fail lands
nowhere (scenario/scenario-verdict.js), no error frame ever reaches
CarrierAPIBridge.kt's forward wait (:302), and the connection dies on the
carrier timeout.

## Decision

`scenario/api-handler-respond.js` (new) is the shared claimed-endpoint
runner: a thrown handler ALWAYS answers its caller first — the same
`api.respond` frame shape a resolution posts, with the `ok:false` error
half from `errorOf` — before any verdict question. Only then: a STRUCTURED
rejection (`remote:true` adapter shape or `isDSHRemoteError` vendored
marker, the same two pass-throughs `errorOf` maps) is an answered client,
not a defect — the drive stays alive; an UNSTRUCTURED throw still fails
the drive through the untouched #366/#371 gate semantics, now with the
caller answered instead of black-holed. The runner defers
`outcome.run()` through `Promise.resolve().then(...)`, so a handler that
throws SYNCHRONOUSLY (a shape the every-handler-async discipline forbids
but the guard no longer trusts) lands in the same rejection leg. The
three write drives use the shared runner; the staged-closure hand lists
gain `api-handler-respond.js` (android stage-spine-closure.sh both loops,
harmony vendor-official.sh CLOSURE + SPINE_OURS, harmony Index.ets
BUNDLE_FILES; iOS rides the whole-`scenario/` tree row). Panel suite
`api-handler-respond.test.js` pins the bad-envelope in-band answer, the
untouched good envelope, the fail-loud unstructured leg, the sync-throw
leg, and the `isWireError` classification.

## Alternatives considered

- Make the session/prompt (and friends) handlers RETURN in-band error
  values instead of throwing: lost — it would fork the handlers' result
  unions (`{accepted:true}` vs `{ok:false,…}`) per endpoint and push the
  classification into every handler; the thrown `remoteError` IS the
  handlers' existing, tested contract (sessionFeedback/record's
  return-value union exists only because the vendored service's OWN face
  is a result union, web-write-catalog.js:262).
- Respond in band AND fail the drive for every rejection (the historical
  read-drive shape, gateway/unavailable for everything): lost twice —
  flattening a structured refusal through `gateway/unavailable` hides the
  client's real error class, and a stranger's malformed curl from the LAN
  would kill a live E2E drive for a non-defect.
- Fix only composer-web-live.js (the measured seat): lost — the Android
  write drive and the Harmony write drive share the identical leg, and
  the guard as a shared module is one reviewable home for the
  classification rather than three inline copies.
