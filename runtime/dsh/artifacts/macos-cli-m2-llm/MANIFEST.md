# Evidence — scenario `m2.llm`, SCRIPTED leg (macOS CLI)

- Run: `runtime/spike/build/dsh-spike-cli runtime/spike . scenario/m2-llm.js > logs.txt`
- Checker: `node tools/e2e/check.mjs --manifest tools/e2e/scenarios/m2-llm.json --log logs.txt --out verdict.json` → PASS (19/19, in order)
- The desktop CLI descriptor honestly declares `httpFetch` unavailable, so the
  scenario negotiated the SCRIPTED leg (`llm.leg`): the real client code path
  (`runtime/spike/llm.js`) is fed by a scripted SSE transport with the gateway
  `httpFetch` response shape. The REAL-backend legs are the device evidence:
  `hosts/ios/artifacts/m2-llm/` and `hosts/android/artifacts/m2-llm/`.

## expected ↔ logged (one-to-one, in order; logs.txt line references)

| # | expected event | logged line (logs.txt) |
| --- | --- | --- |
| 1 | `gateway.negotiated` version gateway@1 | 1 |
| 2 | `host.ready` signalled true | 6 |
| 3 | `llm.leg` leg=scripted transport=scripted-sse | 8 |
| 4 | `llm.config.loaded` source=scripted-fixture model=scripted | 9 |
| 5 | `session.created` s-m2-llm-0001 scope=app | 10 |
| 6 | `agent.started` model=scripted tools=0 | 12 |
| 7 | `llm.stream.started` turn 1 | 15 |
| 8 | `llm.reasoning.delta` index 0 "Pondering the greeting." | 56 |
| 9–14 | `llm.delta` index 0–5: "Hello", " from", " the", " real", " LLM", " backend." | 75, 98, 121, 144, 170, 190 |
| 15 | `llm.stream.completed` turn 1, deltas 6, reasoningDeltas 1, chars 32, finishReason stop | 213 |
| 16 | `llm.served-model` requested=scripted served=scripted-fixture | 214 |
| 17 | `llm.content.asserted` "Hello from the real LLM backend." (32 chars) | 215 |
| 18 | `llm.key.audit` leaked=false (214 sink lines scanned) | 216 |
| 19 | `session.completed` status pass, deltas 6, chars 32 | 217 |

## Negative checks

- The fixture key `sk-scripted-fixture-key-not-a-secret` (used in the scripted
  Authorization header) appears NOWHERE in `logs.txt` (`grep -c` = 0) — the
  in-scenario sink audit (`llm.key.audit` leaked=false) matches the artifact.

Files: `logs.txt` (raw CLI stdout), `scenario.jsonl` (the canonical
`dsh.spike.log:` stream), `verdict.json` (checker verdict), `receipt.json`
(run facts).
