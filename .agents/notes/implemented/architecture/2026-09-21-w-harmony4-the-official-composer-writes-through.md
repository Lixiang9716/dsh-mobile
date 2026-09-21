# Agent Note: W-HARMONY4 — the official composer writes through the embedded spine: the session write surface on HarmonyOS (b-harmony.write.live)

Status: implemented
Related: D9; mirrors #65 (the iOS write surface, b4.write.live) on the
harmony carrier; closes harmony's last named D9 gap left by
`2026-09-21-w-harmony3-the-session-services-behind-the.md` (whose
"claiming the write surface too" alternative this lands)

## Problem

The harmony official web mount read real session data (W-HARMONY3:
`session.list` + the mux `session/journal` claimed from the embedded
spine), but the WRITE surface stayed the named gap: the composer send
(`POST /api/session/prompt`) and the page's boot needs beyond the read
(`session/create`, the `session/follow`/`workspace/follow`/
`session/control`/`$events` streams, `settings/describe|update|mutate`)
answered the structured unavailable envelope, so no message could ever be
sent from the OFFICIAL upstream UI on HarmonyOS.

## Decision

A FOURTH leg chains after the session-live leg on the same carrier
(each leg on a fresh runtime; per-leg evidence state keeps every capture
file holding exactly its own manifest's records):

- **Scenario**: `scenario/harmony-write-live.js` (the harmony twin of
  `b4-web-live.js`, scenario id `b-harmony.write.live`) boots the FULL
  spine via `upstream/boot.js` on one ctx, then mounts
  `createWebBootRuntime` COMPOSED WITH THE WRITE SURFACE
  (`upstream/web-write.js` — already embedded by the W-HARMONY3 closure;
  `vendor-official.sh` gains the scenario file). The runtime goes
  resident and never prompts: the turn is the page's own.
  `runtime.config` rides the BUS seam; the llm transport stays the REAL
  gateway httpFetch against the carrier's SCRIPTED
  `/mock-llm/chat/completions` endpoint (real HTTP + SSE, scripted model
  output, logged as such).
- **Carrier**: `OfficialPhase.ets` gains `runWriteLeg` (fresh runtime,
  `legScenario` = the write id, `capturePath` …/dsh-write-capture.log) +
  the write probe flow. The probe (`SessionWriteProbe.ets`, the harmony
  twin of iOS SessionWriteProbe.swift) defines THREE parked page legs —
  pick the seeded workspace (after a shell-settle + 3s quiet window so
  the boot-RPC burst is fully observed before the probe's own traffic),
  type into the real Lexical composer (caret + `execCommand('insertText')`,
  verified applied value), send (send button, Enter fallback) — parks
  each leg's JSON in `window.__b4wOut.*` (ArkWeb runJavaScript cannot
  await promises) and is polled by ArkTS with a stage heartbeat. The
  carrier paces ~4s between `composer.typed` and send so the drive's
  composer screenshot lands first.
- **E2E**: `drive-official.mjs` waits for the third verdict and takes the
  write screenshots (boot / composer-typed on the `composer.typed` line /
  reply-rendered on `write.reply.rendered`); `run-host-e2e.sh` pulls
  `dsh-write-capture.log` and runs the EIGHTH checker. The manifest
  `tools/e2e/scenarios/b-harmony-write-live.json` (33 events, one-to-one)
  was frozen from observation and held on 3 consecutive full-run verdicts.
  Random per-run identities are deliberately unpinned (the minted session
  id, the mux streamId, the reply view's bodyText); the honest-first
  unavailable `rpc.observed` kept its stable endpoint identity
  (`dynamicCordisRunner/syncInspectManifest`, 3/3 runs — narrower than
  the read leg's answered-only pin, widened if it ever flips).
- **Honest gaps stay structured-unavailable** (fail loud, pinned as such
  via the burst's honest-first line): credentials, model catalog, agent/
  permission presets, subagents/commands/skills/terminal/llm listings,
  dynamicCordisRunner.

## Alternatives considered

- **Pre-creating the session runtime-side** (the b3 pattern): rejected —
  the product moment is the PAGE originating the session
  (`session/create` with the seeded workspace id) and the composer send
  admitting the turn; a runtime-seeded session would prove less (the iOS
  b4 reasoning, inherited).
- **Answering the composer send with a scripted journal**: rejected —
  D8/D9 fail-loud; the turn must be the REAL vendored agent-loop over the
  REAL transport seam (only the model output is scripted, logged as such).
- **A separate carrier class for the write leg**: rejected — route table,
  dist, plugins, bridge and probe plumbing are shared; the leg lives in
  `OfficialPhase` with per-leg evidence state (the W-HARMONY3 precedent).
- **One big parked probe function**: rejected — three parked legs give
  the drive its screenshot trigger lines (`composer.typed`) and keep
  every function under the size gate.

## Consequences

- The session write path is claimed end-to-end on-device on HarmonyOS:
  composer message → upstream session event → ctx.agentLoop turn (11
  events) → deltas/journal over the mux → official UI render, with the
  workspace picker, settings describe/update/mutate, and the
  session/follow + workspace/follow + session/control + $events
  handshakes the page's boot needs. b-harmony.write.live passed 33/33 on
  3 consecutive runs with the SEVEN regression checkers green in the same
  runs (m1 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding
  20/20, b-harmony.official-web-mount 17/17, b-harmony.httpfetch-v2 6/6,
  b-harmony.session.live 43/43) and real-PNG screenshots.
- Harmony's named D9 gap list is now empty; every unclaimed endpoint
  stays structured-unavailable (fail loud, never faked).
- The rawfile closure grows by exactly one authored file
  (`scenario/harmony-write-live.js`, +7.6 KB); `check-bundle-files.mjs`
  pins the list == tree in both directions.
