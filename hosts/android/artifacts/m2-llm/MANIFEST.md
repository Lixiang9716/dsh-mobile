# Evidence — scenario `m2.llm`, REAL leg (Android emulator)

- Runner: `hosts/android/ci/run-m2-llm.sh` (boot-wait → install APK → stage
  credentials into fs scope "app" via `run-as` → launch
  `am start ... --ez dsh.llm true` → bounded logcat capture → checkers →
  key-leak re-check)
- Verdicts: `verdict-m2-llm-device.json` PASS (14/14, in order — the delta
  runs consumed by the checker's repeat expectations),
  `verdict-m2-llm-carrier.json` PASS (7/7); device verdict line:
  `m2.llm.carrier PASS | quickjs-ng 0.17.0` (`results.txt`)
- Backend: OpenAI-compatible `POST {base}/chat/completions` (z.ai coding
  endpoint), `stream: true`, through the REAL gateway `httpFetch`
  (`llm.leg {leg: real, transport: gateway.httpFetch}`).

## streamed facts (logs.txt — one run at the final code state, post D9-merge)

- `llm.config.loaded {source: app-scope, model: glm-4.6}` — line 22
- `llm.stream.started {turn: 1}` — line 28
- 139 × `llm.reasoning.delta` (reasoning traces streamed first, token-sized)
- 20 × `llm.delta` → aggregated text: `Hello, and welcome! I'm glad you're here and happy to help with whatever you need.` (82 chars)
- `llm.stream.completed {turn: 1, deltas: 20, reasoningDeltas: 139, chars:
  82, finishReason: stop}` — line 833
- `llm.served-model {requested: glm-4.6, served: glm-5.3-flash}` — line 834
  (the server reports a different model name; logged verbatim)
- `llm.content.asserted {text: …, chars: 82}` — line 835
- `llm.key.audit {lines: 829, leaked: false}` — line 836
- `session.completed {sessionId: s-m2-llm-0001, status: pass, deltas: 20,
  chars: 82}` — line 837

## carrier side (scenario m2.llm.carrier)

client.selected → webclient.mounted → ws.connected → slot.registered `llm`
slot → ws.token-delta first → ws.token-delta last → ws.session-complete —
the real deltas streamed live into the WebView-mounted Web Client. The
drive reuses the M4 completion flow (SpikeHostM4) with only the scenario id
and JS entry swapped (`--ez dsh.llm true`).

## key-leak checks

- In-scenario: every log-sink line audited for the API key —
  `llm.key.audit {lines: 829, leaked: false}`.
- Runner: `grep -F "$ZAI_API_KEY"` over the RAW captured logcat stream —
  0 occurrences.

## first run stalled, then fixed

The first drive stalled at the 180 s watchdog BEFORE any HTTP request: the
scenario never announced the bus subscription (`{type: "bus.ready"}`), and
`SpikeHostM4` gates the Web Client page load on exactly that line (its
`host.hello` carries the loopback port). The scenario now announces it at
module level — hosts without a bus sink (CLI, iOS session flow) drop it
silently. No quota was consumed by the stalled run.

Files: `logs.txt` (raw logcat stream, bounded at the first completion tag),
`scenario.jsonl` (canonical `dsh.spike.log:` lines), `results.txt`,
`verdict-*.json`, `receipt.json`, `dsh-m2-llm-stream.txt` (unbounded
capture).
