# Evidence — scenario `m2.llm`, REAL leg (HarmonyOS emulator)

**Status: TRANSPORT PROVEN end-to-end, SERVED TURN BLOCKED ON ACCOUNT QUOTA.**
The leg ran on the device exactly as designed and the request left the
emulator through this host's real `httpFetch`; the z.ai backend REFUSED it —
`HTTP 429`, code `1310`, "Weekly/Monthly Limit Exhausted. Your limit will
reset at 2026-09-22 14:43:53" — so the served-turn records
(`llm.reasoning.delta` → `llm.delta` → `llm.stream.completed` →
`llm.served-model` → `llm.content.asserted` → `llm.key.audit` →
`session.completed`) did not happen and **the checkers FAIL by design**: their
verdict JSONs below are the precise, committed diagnosis, not a green claim.
A 429 from the real backend is itself evidence: the request crossed the
device's network stack inside the real primitive and a real server answered
it. One re-run of the same command closes the served-turn line once quota is
back.

## The one command (reproducible)

```sh
# leg selection is a launch parameter — harmony has no scenario list:
"$HDC" shell aa start -b com.dshmobile.spike -a EntryAbility --ps dsh.e2e.leg m2.llm
# the whole leg, one launch, bounded capture, checkers, key audit:
DSH_SKIP_BUILD=1 hosts/harmony/ci/run-m2-llm.sh
# emulator: dsh_phone (hdc target 127.0.0.1:5557), HarmonyOS 7.0.0 / 26.0.0,
# engine quickjs-ng 0.17.0, bundle com.dshmobile.spike
```

Exit code: **1** — the leg did not serve a turn, and the runner refuses to
report that as anything else.

## What this run DID prove (expected ↔ logged, line refs into `capture.txt`)

`capture.txt` is the app's own sink capture, pulled from the sandbox (the
truncation-proof second capture); `logs.txt` is the same run's raw hilog
stream, bounded at the completion tag. Record line numbers agree between the
two (the carrier/scenario lines sit at the same offsets).

| # | manifest expectation | captured (capture.txt line) | state |
|---|---|---|---|
| 1 | `m2.llm.carrier client.selected {client: dsh-web-client}` | 6 | ✅ the carrier chose the Web Client for this launch |
| 2 | `m2.llm.carrier webclient.mounted {path: /index.html}` | 7 | ✅ ArkWeb fetched the client from the loopback carrier |
| 3 | `m2.llm.carrier ws.connected {protocol: session-projection@0}` | 8 | ✅ the page's WS hello completed the mount |
| 4 | `m2.llm.gateway.negotiated {version: gateway@1}` | 9 | ✅ gateway@1 negotiated over the NAPI bridge |
| 5 | `m2.llm.host.ready {signalled: true}` | 14 | ✅ `host.info` reached the scenario |
| 6 | `m2.llm.llm.leg {leg: real, transport: gateway.httpFetch}` | 16 | ✅ **capability negotiation picked the REAL leg** — the descriptor offers `httpFetch`, and this host's binding serves it |
| 7 | `m2.llm.llm.config.loaded {source: app-scope}` | 25 | ✅ the credentials came from fs scope "app" through the handshake below |
| 8 | `m2.llm.session.created` / `agent.started` | 26 / 28 | ✅ the scenario reached the turn |
| 9 | `m2.llm.llm.stream.started {turn: 1}` | 31 | ✅ the turn opened |
| 10 | `m2.llm.carrier slot.registered {label: llm, by: m2-llm}` | 37 | ✅ the mounted page rendered and ACKED the projected slot |
| 11 | `m2.llm.reasoning.delta` … `session.completed` | — | ❌ **blocked: the backend answered 429** (see line 53) |

The device-side HTTP traffic (same run, `logs.txt`): the gateway logged the
request `POST https://api.z.ai/api/coding/paas/v4/chat/completions`, the body
streamed back as `http.body` + `http.end` (lines 43/49), and `llm.js` drained
a non-200 status into its own failure (`status error drain {status: 429}`)
before the scenario failed loud:

```
line 53: {"scenario":"m2.llm","event":"scenario.failed","reason":"uncaught:
chat/completions status 429: {\"error\":{\"code\":\"1310\",\"message\":\"
Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-09-22 14:43:53\"}}"}
line 54 (results.txt): dsh.spike.verdict: m2.llm FAIL engine=quickjs-ng
version=0.17.0 complete=1 pass=0 logLines=53
```

The same refusal reproduces off-device with the same key (`curl` from the
host, 2026-09-21 13:13 CST), so the blocker is the account, not the host:
`glm-4.6`/`glm-4.5`/`glm-4.5-air` → 429/1310; `glm-4.5-flash` → 429/1305
(overloaded); `glm-4.6-flash` → 403/1220 (not permitted); the standard paas
endpoints → 429/1113 (insufficient balance).

## The credential handshake (why it is inverted on this host)

`hosts/android` stages with `run-as`, `hosts/ios` writes into the simulator
container. Neither exists here — and the sandbox refuses the obvious path
outright. Measured on the emulator (surprise ledger, three attempts):

* `hdc shell` cannot CREATE a file in the app sandbox (refused even in a
  0777 app directory), but it CAN open an existing, others-writable file;
* an ArkTS-side `fs.openSync` create lands mode `0660` — unopenable by the
  shell user, who is neither owner nor in the app's group;
* `@ohos.fileio.chmodSync` (the only permission API this SDK ships) is a
  **silent no-op** here: the file stays `0666` and the call returns normally
  — so the app RE-READS the mode and logs the truth
  (`stage-seal ineffective (platform chmod no-op) mode=666 wanted=600`), and
  the credential's lifetime is bounded by DELETION, not by permission bits;
* the C-side app-scope `fsWrite` (fopen) DOES land `0666` — that is the one
  writer whose file the runner can open.

So the runtime creates the placeholder (`e2e-stage.js` →
`{"event":"...", "message":"placeholder write begin"}` in `logs.txt`), the
runner overwrites it (`placeholder mode -rw-rw-rw-`), the app imports and
validates it (`stage-loaded bytes=129 model=glm-4.6`), and the app removes it
when the leg ends (`stage-cleanup removed …`, asserted by the runner:
`credentials removed by the app after the run`). The runner's own copy is a
`0600` temp file deleted at the handoff.

## Key-leak audit (RAW streams, both)

* In-scenario: `llm.key.audit` never ran — it is the scenario's LAST record
  and the turn was refused. Recorded honestly as a blocked record.
* Runner, out of band, over the raw captures — **0 occurrences** of the
  staged key in `logs.txt` (54 lines) and `capture.txt` (53 lines), the
  strongest form of the check (it audits what the device actually emitted):
  `run-m2-llm: key-leak re-check clean (raw hilog stream + raw capture carry
  no API key)`.

## How to close the served-turn line (no code change)

1. wait for the quota reset (2026-09-22 14:43:53 +08:00) or provide a key
   with balance;
2. `DSH_SKIP_BUILD=1 hosts/harmony/ci/run-m2-llm.sh` — it must exit 0 with
   both verdict JSONs green, then commit the refreshed evidence here and flip
   the README M5 row's trailing clause.

## Files

* `capture.txt` — the app's sink capture for this run (the checkers read
  this); `scenario.jsonl` — its canonical `dsh.spike.log:` lines;
* `logs.txt` — the raw bounded hilog stream of the same run;
* `results.txt` — the scenario verdict line;
* `verdict-m2-llm-device.json` / `verdict-m2-llm-carrier.json` — the checker
  verdicts for this blocked run (8/14 device, 4/7 carrier, with the precise
  missing/mismatched records inside);
* `m2-llm-live-page.png` — supplementary screenshot of the mounted page with
  the projected `llm` slot (evidence only, never an assertion);
* `receipt.json` — the machine-readable summary.
