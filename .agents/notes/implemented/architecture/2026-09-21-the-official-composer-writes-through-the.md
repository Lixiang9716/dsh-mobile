# Agent Note: The official composer writes through the spine: the session write surface over the mux journal (b4.write.live)

Status: implemented
Related: D9 (upstream port); contract `docs/webserver-contract.md` §2.3/§2.4; supersedes the "write surface stays the named gap" boundary of `2026-09-20-ondevice-session-live.md`

## Problem

The D9 product moment was still missing: a real message typed in the
OFFICIAL upstream web UI's composer had no on-device truth. b3.session.live
claimed the read surface (`session.list` + the mux `session/journal`), so
the official shell rendered, but the composer send (`POST /api/session/prompt`)
answered the structured `gateway/unavailable` envelope — the write path was
the named gap. Worse, the page's own boot RPC burst (settings describe, the
session control + forwarded-event mux streams) hit unimplemented endpoints,
and the workspace picker rendered empty: the app UI never reached the
composer at all.

## Decision

The b4.write.live drive (`-dsh-mode session-write`) composes the web-boot
producer WITH a write surface (upstream/web-write.js) over the SAME spine
ctx, mirrored from the vendored api/session-controller + api/workspace-
controller + settings-controller CLIENT faces at the pin (the generated
Typert remote descriptors + zod request/result schemas in the client
bundles are the wire truth; every shape was extracted from them):

- **RPC**: `session/create` (mint → `agents.create` with the profile llm
  route + meta.cwd → the seeded workspace's upsert), `session/prompt`
  (admission per upstream commands.prompt: `{accepted:true}` without
  awaiting the turn; `source:{kind:'user', rpcId}`; followup/steer by
  mode), `settings/describe` + `settings/update` + `settings/mutate`
  (the REAL vendored provider; the mobile `ui-onboarding` namespace is
  registered with a real schemastery schema so the page's welcome
  acknowledgement can persist — volatile, in-memory). The dot alias
  `session.list` stays claimed for the b3 probe.
- **Mux**: `session/follow` (snapshot opening frame → live `{event}` entry
  frames → `assistant-stream` notification frames with strictly monotonic
  revisions, `startedAfterSeq` stamped on start), `workspace/follow`
  (baseline + upserts), `session/control` (empty jobs/projections
  baseline), `$events` (the gateway-internal forwarded-event stream's
  `ready` handshake — without it the official client declares the
  connection lost and reconnect-loops).
- **Honest gaps stay structured-unavailable**: `dynamicCordisRunner/*`,
  `credentials/describe`, `session/modelCatalog`, `agentPresets/list`,
  `permissionPresets/catalog`, `subagents/list`, `commands/list`,
  `skills/list`, `terminal/list`, `llm/list*` — the manifest pins them as
  unavailable (fail loud, never faked).
- **Wire envelope fact (extracted, load-bearing)**: both the unary
  `client-request` payload AND the mux stream `open` payload carry the
  request under `args` (`{args:{request:{…}}}`); the event envelopes pass
  through the store's `surfaceOp` / `sourceEventSeqs` / `ignorable`
  metadata — the page's `assertSessionWireEvent` rejects surface-eligible
  events without their `surfaceOp` marker ("history load failed").
- **Scenario + drive**: scenario/b4-web-live.js boots the spine, composes
  the write surface, and goes resident — it never prompts; the turn is
  the page's own. SessionWriteRuntime + SessionWriteProbe drive the REAL
  UI: pick the seeded workspace, type into the Lexical composer, click
  the send button; a REAL agent-loop turn streams over the mux journal
  and the assistant reply renders in the official DOM. `tools/e2e/
  run-ios-b4.sh` + a 43-event one-to-one manifest frozen from observation
  (5 consecutive identical-verdict runs). Screenshots are saved artifacts;
  the verdict is logs only.
- **Reproducibility fix (W-SHELL inheritance)**: build-client-bundles.sh
  cloned into a `mktemp` dir, but the upstream build embeds the absolute
  source path in its outputs (css-module class-name hashes + `//#region`
  comments) — every rebuild produced different bytes and the committed
  MANIFEST.sha256 could never verify. #62 had re-stamped the manifests to
  a rebuild instead. The build now clones into the FIXED path
  `/tmp/dsh-harness-src` and reproduces the original W-SHELL bytes
  byte-identically; the manifests are restored to the reproducible
  records (verified: rebuild == committed truth, 116 files).

## Alternatives considered

- **Answering the composer send with a scripted/fake journal**: rejected —
  D8/D9 fail-loud; the turn must be the REAL vendored agent-loop over the
  REAL transport seam (only the model output is scripted, logged as such).
- **Pre-creating the session runtime-side (b3 style)**: rejected — the
  product moment is the PAGE originating the session (`session/create`
  with its workspace id, the minted identity adopted by the page); a
  runtime-seeded session would prove less.
- **Serving `$events` with real forwarded Cordis events**: deferred with
  the narrowed handshake (ready + no events) — the desktop gateway's
  forwarding filter is not derivable from the vendored client faces, and
  the UI's session data rides the REAL journal streams; forwarding
  guesses would fake surface the gateway does not own. Named gap.
- **Registering `ui-onboarding` with a hand-written schema validator**:
  rejected — the vendored schemastery is already embedded; a hand-rolled
  validator would reimplement Harness validation behavior (D9 forbids).
- **Keeping b3's claims by patching the b3 manifest**: rejected — the
  actual defect was a `null` vs `undefined` write-surface check leaking
  the write claims into the b3 shape; fixed at the source, b3 stays
  46/46 with its original claims.

## Consequences

- The session write path is claimed end-to-end on-device: composer send →
  upstream session event → agent-loop turn → deltas/journal → official UI
  render, with the workspace picker, settings describe/mutate, and the
  session control + event-stream handshakes that the page's boot needs.
- Still structured-unavailable (named): the dynamicCordisRunner inventory/
  inspect surface, credentials, model catalog, agent presets, permission
  presets, subagents/commands/skills/terminal/llm listings, and the
  forwarded-event payload beyond the ready handshake.
- The client-bundles build is reproducible again; `ensure-client-bundles.sh`
  verifies against the committed manifest on every E2E run.
