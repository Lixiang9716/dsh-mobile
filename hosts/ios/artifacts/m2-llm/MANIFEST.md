# Evidence — scenario `m2.llm`, REAL leg (iOS simulator)

- Runner: `tools/e2e/run-ios-m2-llm.sh` (build → stage credentials into fs
  scope "app" → launch `-dsh-mode session -dsh-scenario m2-llm` → wait
  markers → checkers → key-leak re-check)
- Verdicts: `verdict-m2-llm-device.json` PASS (14/14, in order — the delta
  runs consumed by the checker's repeat expectations),
  `verdict-m2-llm-carrier.json` PASS (7/7)
- Backend: OpenAI-compatible `POST {base}/chat/completions` (z.ai coding
  endpoint), `stream: true`, through the REAL gateway `httpFetch`
  (`llm.leg {leg: real, transport: gateway.httpFetch}`, line 12).

## streamed facts (logs.txt — one run at the final code state, post D9-merge)

- `llm.config.loaded {source: app-scope, model: glm-4.6}` — line 23
- `llm.stream.started {turn: 1}` — line 29
- 127 × `llm.reasoning.delta` (reasoning traces streamed first, token-sized)
- 9 × `llm.delta` → aggregated text: `Hello, and welcome! It's wonderful to
  see you today.` (52 chars)
- `llm.stream.completed {turn: 1, deltas: 9, reasoningDeltas: 127, chars:
  52, finishReason: stop}` — line 634
- `llm.served-model {requested: glm-4.6, served: glm-5.3-flash}` — line 635
  (the server reports a different model name; logged verbatim)
- `llm.content.asserted {text: …, chars: 52}` — line 636
- `llm.key.audit {lines: 628, leaked: false}` — line 637
- `session.completed {sessionId: s-m2-llm-0001, status: pass, deltas: 9,
  chars: 52}` — line 638

## carrier side (scenario m2.llm.carrier)

client.selected (2) → webclient.mounted (7) → ws.connected (8) →
slot.registered `llm` slot (9) → ws.token-delta first (587) →
ws.token-delta last (640) → ws.session-complete (641) — the real deltas
streamed live into the mounted Web Client.

## key-leak checks

- In-scenario: every log-sink line audited for the API key —
  `llm.key.audit {lines: 314, leaked: false}`.
- Runner: `grep -F "$ZAI_API_KEY"` over the RAW captured stdout/stderr —
  0 occurrences.

## bug found + fixed by this leg

The first run failed 401: iOS `HTTPPrimitive` read a nested `init` object
the typed gateway shim never sends (it flattens `{url, method, headers,
bodyB64}` to the top level), silently dropping EVERY request header — z.ai
answered "Header中未收到Authorization参数". Fixed in
`hosts/ios/App/Source/Gateway/HTTPPrimitive.swift` (flattened encoding read
first, nested tolerated — same dual reading as `FSPrimitives` opts);
recorded in the gov surprise ledger. A second stall surfaced on Android
(see its MANIFEST): the scenario now announces the bus subscription
(`{type: "bus.ready"}`) that the Android carrier's page-load gate waits
for; iOS drops it silently. The committed evidence is one run at the final
code state (the launch-arg parsing was also extracted to
`SessionLaunchConfig.swift` for the code-size gate and the leg re-run
green).

Files: `logs.txt` (raw captured stream), `scenario.jsonl` (canonical
`dsh.spike.log:` lines), `nslog-stderr.txt`, `verdict-*.json`, `receipt.json`,
`screens/` (human evidence only).
