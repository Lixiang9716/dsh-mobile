# Agent Note: BYOK onboarding — the first-run credential panel grows on the existing credential machinery

Status: implemented

Related: D5 (contract first — no new gateway primitive), D8 (event-driven), D9 (the coverage plane)

## Problem

Beta users of the release builds have no API key preinstalled. The only way
to point a release app at a real model today is to hand-place
`profiles/default/llm/config.json` into the app container (Files.app on iOS) —
a developer move, not a product flow. With no credential staged, the seat
boots the scripted mock route: the whole UI serves, but every turn answers
from the loopback script, and nothing in the product tells the user why or
offers a way in. The gap: 首次打开 → 配自己的 key → 跑通第一回合.

## Decision

The onboarding grows entirely on existing mechanisms; no gateway primitive is
added (the round's red line held — `contract/` is untouched):

1. **Storage = the keychain, nothing else.** The panel's save persists the
   credential `{provider, baseURL, apiKey, model}` under the keychain ref
   `dsh.llm/byok-route` through the frozen `keychainSet` (contract v1.0.0
   rows 8-9). Never a plaintext file, never a log line; values never cross
   the wire back (the credential plane's own rule, web-write-llm.js).
2. **The boot reads the keychain.** `upstream/llm-route.js` is the one home
   of route resolution: staged (the seat's runtime.config credential, the
   pre-existing shape) → byok (keychain) → mock (the carrier's scripted
   loopback). A corrupt stored credential degrades to "no credential" — the
   seat's `loadCredential` precedent — it never bricks a boot. A saved
   credential therefore resurrects across relaunch with zero host-side
   changes on any host that implements the frozen keychain (iOS SecItem,
   Android, HarmonyOS).
3. **The test connection is the REAL transport.** `onboarding/test` (a
   coverage mux stream, fullCoverage-gated like the rest of the plane) runs
   one minimal chat-completions through `llm.js streamChat` over the gateway
   `httpFetch` — the same path a turn takes. Progress rides mux items
   (open → delta → done); failures surface as one mux error whose
   `{code, message}` the page maps to readable bilingual copy.
4. **The save rebinds the live route.** boot.js hands its adapter
   registration's disposer to llm-route.js; save disposes it and registers
   the user's adapter through the vendored registry's own API, then mutates
   the write surface's llmRoute (read at session/CREATE time) — NEW sessions
   route to the user's endpoint without a relaunch. First turn = the page's
   own wire (session/create → session/prompt).
5. **The panel is web-client-next.** `onboarding-core.js` (pure: provider
   presets, draft validation, status decision, error mapping — vitest-covered
   at test/panel/) + `onboarding.js` (DOM wiring) + bilingual copy throughout
   (EN + ZH, the page's first bilingual surface). Configured users
   (byok/staged) never see it; an older seat without the coverage plane is a
   capability gap (`gateway/unimplemented`), not an error.
6. **The CLI dev host now implements the frozen keychain primitives** (one
   0600 file per ref under the smoke tmpdir — the same trust domain as its
   fs scopes, not encryption, and disclosed as such in the receipt). Before
   this round the CLI *declared* keychain unavailable, which made the
   flow's save leg untestable on the CLI; `gateway.bridge-smoke` is
   re-pinned to the set→get→delete roundtrip (7/7, evidence regenerated) —
   the declared-unavailable conformance path stays covered by the
   primitives the descriptor still names unavailable. Device verdicts
   captured before the flip keep their historical 6-event shape (the matrix
   gate reports manifest drift; it does not fail on it).
7. **A latent `llm.js` defect this leg exposed, fixed:** `drainSse` returned
   early at the [DONE] fold, orphaning a pending `next()` whose continuation
   fired on the trailing bytes and hard-aborted the CLI engine (empty error,
   `complete=0`). The drain now runs to EOF and stops FOLDING; `statusError`'s
   bounded drain lost its early break for the same reason.

Evidence: `onboarding.flow` 9/9 (`run-onboarding-e2e.sh`, dir
`runtime/spike/artifacts/macos-cli-onboarding/`, key audit green); vitest
20/20 (test/panel); the pre-existing CLI legs re-run green (upstream-boot,
upstream-session, models-directory, gateway-bridge-smoke); matrix gate PASS
(71 dirs / 145 verdicts / 0 unregistered).

## Alternatives considered

- **A new gateway primitive (an `llm/probe` or a credential-wire primitive)**:
  rejected — the frozen keychain + httpFetch + the mux stream surface already
  cover the flow; D5 says stop only when they don't. `contract/` untouched.
- **Riding the settings page's `credentials/set` store** (the plaintext
  `credentials.json` in the app container): rejected — the boot transport
  never reads that store (display-only shadowing, the api-full-coverage
  note's honest-gap rationale), and the credential would live in plaintext,
  which the flow forbids.
- **Host-side keychain read at boot (three hosts of native changes)**:
  rejected for this round — the runtime-side keychainGet at boot achieves the
  relaunch persistence in one place, over the frozen primitive, with zero
  host changes.
- **Doing the probe from the page with `fetch`**: rejected — WebView CORS
  makes arbitrary provider endpoints unreliable, and the gateway httpFetch is
  the sanctioned network path (the same one turns take).

## Consequences

- Removal (unset) is deliberately absent in v1: the boot adapter's key is
  not reachable from the write surface, so an in-process un-rebind would be
  a lie. Named follow-up: an `onboarding/clear` leg + boot-route restore.
- The models 设置页 directory still answers the BOOT provider row; a saved
  byok provider does not appear there (display-only mismatch, the turn path
  is unaffected). Named follow-up with `onboarding/clear`.
- Real-key end to end (api.deepseek.com from a device) is owner manual test:
  the CLI e2e proves the flow against the vendored mock LLM; the PR names
  the leftover.
- The iOS/Android/Harmony device legs for the new scenario are staged (the
  canonical closure syncs) but not yet captured — device evidence awaits the
  owners' hardware runs; nothing synthesized.
