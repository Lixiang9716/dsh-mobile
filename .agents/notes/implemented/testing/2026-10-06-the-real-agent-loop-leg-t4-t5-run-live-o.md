# Agent Note: The real-agent-loop leg: T4/T5 run live on glm-5.3-flash — fs shapes verbatim, web_search answered

Status: implemented
Related: D5

## Problem

The windows-test-plan's T4/T5 probes (the fs boundary's four shapes and the
web_search reality check) were queued behind a harness gap: the harmony
write probe drives the composer with SCRIPTED model output, so no path made
a REAL model call the tools through the host's gateway seams. The T4
assertions are about the host fs primitive's refusal/absence/pin semantics
under the same shim bytes every host ships — but the plan's vehicle is the
model-driven creation loop, and a deterministic tool-only harness would not
prove what the plan asks (the model's own round trip through
gateway → shim → primitive → session log).

## Decision

- New scenario `runtime/spike/scenario/real-agent-loop.js` (scenario id
  `real.agent.loop`, the harmony-session-live-read spine-boot shape): the
  FULL upstream spine mounts with tools, the llm route is the gateway
  transport pointed at the STAGED credential (`llm-live-stream/config.json`
  — the llm.live-stream handshake reused verbatim, `userEndpoint: true`
  declared per llm-transport's named exception), and glm-5.3-flash drives
  five probe turns itself. Assertions read the session's `tool/call` /
  `tool/result` records: anchored refusal (T4-a), relative-spelling
  resolution against a scenario-seeded registry fixture (T4-b), plain
  absence (T4-c), in-root pin (T4-d), and web_search ANSWERED on the
  proxy-free network (T5 — best case; challenged also passes, silent empty
  success fails).
- ArkTS: `HostPhase.beginRealAgent` (the parity leg's eval-then-deliver
  shape: staging entry eval → scenario eval → runtime.config delivery) and
  `Index.runRealAgentLeg` (the llm leg's credential choreography verbatim,
  headless — no page, no carrier records). BUNDLE_FILES + the rawfile copy
  ride the existing bundle-files/closures gates.
- `ci/run-real-agent.sh` (the live-llm runner's choreography, one manifest,
  the verdict deadline at 480s for five real turns).
- Windows-host facts the build surfaced, now in the plan doc: the staging
  entry must eval BEFORE the scenario (the placeholder writer), the
  config poll must validate CONTENT (the `{}` placeholder parses clean)
  and must NEVER await a timer (this host's timerSchedule denial hangs it —
  the poll yields through failed fsRead round trips instead), the staging
  handshake needs `llmLeg = true` (its stage.ready conversion), and
  `onWire`/`onSse` stay unwired (the wire stream would interleave hundreds
  of records between the probe expectations).
- Result: manifest 21/21, scenario verdict PASS, receipt on the live host
  line — T4/T5 come OFF the plan's queue; the coverage matrix gains the
  `real.agent.loop` row (94 dirs / 206 verdicts).

## Alternatives considered

- A deterministic tool-only harness (executing the fs tool face directly
  through ctx.tools, no model): lost — the plan's vehicle is the model's
  own round trip; a tool-only harness would not prove the creation loop's
  gateway seam under a real model's tool-call shapes.
- Widening llm-transport's loopback guard for everyone: lost — the seam's
  `userEndpoint: true` is the designed named exception and this scenario's
  credential file IS a user-supplied endpoint; the guard stays as strict
  as it was for every other caller.
- Polling the staged credential with an awaited setTimeout: measured and
  rejected — this host's timers never fire (the timerSchedule denial), the
  poll hung; the fsRead round-trip poll yields the runtime thread to the
  host pump without timers.
