# Agent Note: OfficialServe goes interactive — the harmony user-facing boot runs the FULL DSH runtime

Status: implemented

## Problem

The harmony release boot mounted the official DSH Web Client through the
compose-only seat (`OfficialServe` + `scenario/officialweb-web-live.js`):
the runtime composed the boot wire but claimed nothing, so — exactly like
Android before #193 and iOS before #184 — every runtime-backed surface
answered structured-unavailable, the page's mux could not attach, and a
release user could not pick a workspace, create a session, or run an
agent turn. iOS (#184) and Android (#193) both crossed the gap by booting
the FULL vendored spine through the resident
`scenario/composer-web-live.js` entry with the claims seam and the
interactive surfaces; harmony was the last host on the compose-only boot.

## Decision

`OfficialServe` gains an INTERACTIVE mode rather than a second seat class
— the harmony file-boundary precedent is this exact file, and the
compose-only mount (`begin`) stays byte-for-byte what the evidence drive's
manifest pins:

- `beginInteractive(ctx, webRoot, capturePath, fsRoot, credentialJson)`:
  the mount entry becomes `scenario/composer-web-live.js` (the resident
  spine: claims the write surface, the settings describe and the mux
  streams, mounts the commands registry + the skill plane, and never
  pre-plays a turn); the carrier registers the scripted
  `/mock-llm/chat/completions` route (the byte-for-byte
  'Hello from upstream' stream — the no-credential fallback); and the
  runtime.config carries the workspace (`<fsRoot>/workspace` — a REAL
  directory, so agent writes survive relaunches), `fsScopeRoot`, the
  interactive rows (`commands: true` + `skills` dshHome/agentsHome/
  customSkillDirs all INSIDE the workspace — the fs views refuse anything
  outside it, the iOS-measured constraint), and the staged credential's
  llm rows when `loadCredential` finds
  `<filesDir>/profiles/default/llm/config.json`.
- `Index.ets`'s release branch constructs it via `beginInteractive` with
  `loadCredential`; the E2E legs (OfficialPhase) keep their own
  `begin`/`startLeg` flow untouched.
- `vendor-official.sh`'s CLOSURE and `Index.ets`'s BUNDLE_FILES stage
  `scenario/composer-web-live.js` (the entry previously rode only the iOS
  embed and the Android stager — #193).

The gateway surface is intentionally unchanged: harmony's fs legs are
answered by the C host natively against `fsRoot` (only httpFetch crosses
NAPI here), so the spine's file service works without new ArkTS
handlers; `wasmRun` stays unadvertised on this host.

## Alternatives considered

- A separate `SessionServe.ets` class (the Android shape) — rejected: the
  harmony precedent is OfficialServe's file boundary with hook defaults,
  and the claims folding + chunked web.plugins delivery already live here;
  a second seat would have forked the carrier plumbing this file owns.
- Hand-rolling the Models tab's `llm/listProviders` answer — the page
  joins it with `llm/listConfigurableProviders` + `credentials/describe`
  (the configurable-provider and credentials management plane); faking
  one leg would half-light a page whose writes have no backend. It stays
  the honest named gap for the next round (issue #177).

## Consequences

The harmony release HAP boots the full vendored DSH runtime with the
interactive surfaces: workspace picking, real composer turns, session
persistence and the "/" surfaces ride the same proven entry the Android
(#193) and iOS seats run, with the scripted route as the no-credential
fallback. Compile proof rides the `dev-harmonyos` CI check on this PR
(this machine has no HarmonyOS CLT — the ArkTS cannot compile locally,
the same verification limit every harmony PR here carries); the
on-device emulator pass belongs to the owner's hdc environment.
`closures` stays green locally: the rawfile byte-verifies with the new
entry staged.
