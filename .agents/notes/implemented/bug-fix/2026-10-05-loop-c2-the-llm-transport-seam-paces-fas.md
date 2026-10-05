# Agent Note: loop-c2: the llm transport seam paces fast-failing offline retries through the vendored dsh-llm-retry injection point

Status: implemented
Related: D9

## Problem

The battery-r18 field round (w1-retry-lines.txt, v1-timeline.txt VERDICTS (b),
w1-verdicts.json) proved the loop-u2 watchdog works — attempt 1/5 was cut as a
retryable TIMEOUT at t0+120.4s, inside the 120-180s window, where r16 had
nothing — and exposed the layer under it: every attempt AFTER the cut died at
the offline reflex (DNS "Unable to resolve host", then "Failed to connect to
/10.0.2.2:7890") in 0.5-4s, back-to-back, because the vendored
`@deepseek-ai/dsh-llm-retry` rhythm runs its online defaults (initial 500ms,
×2, jitter — llm@lib `DEFAULT_INITIAL_DELAY_MS`, exactly the gaps the field
log shows). The whole 5-retry budget burned in ~7 seconds and the turn ERRORED
at t0+136s — two minutes before the network returned (t_restore = t0+255s).
A turn that stayed alive across the cut would have recovered on its own; the
pacing to do that did not exist, and the vendored plugin takes no input for it
(`Config = z.object({})`, llm-retry@lib index.js:24 — loop-u2's note already
refuted wiring a config key for the same reason).

## Decision

The seam paces transport-class FAST failures through the vendored injection
point — no vendored bytes, no seam-side sleep:

1. **`upstream/llm-retry-pacing.js`** — `makeFastTransportPacer()`: one ladder
   per provider route. A TRANSPORT failure whose attempt spent under
   `FAST_TRANSPORT_FAIL_MS` (5s; the r18 reflexes took 0.5-1s) is an
   offline-reflex failure and draws the next slot of
   `FAST_TRANSPORT_PACES_MS = [15s, 45s, 120s]` (×3 geometric, capped at
   loop-u2's read-idle 120s — one guard family; 120s < ring 2's 300s silence
   budget, and each scheduled retry's `llm/retry` journal append re-arms ring
   2, so no paced wait can starve the turn watchdog). A slow failure
   (≥5s — a read-idle TIMEOUT by construction, or a connect that spent real
   seconds) draws nothing and RESETS the ladder, and >`FAST_TRANSPORT_EPISODE_MS`
   (6min = 3× the cap) of quiet restarts it, so a fresh turn re-earns the
   short slots. Non-TRANSPORT codes are not this seam's to pace.
2. **`llm-transport.js` wires it at the two TRANSPORT construction sites**
   (`openWireStream`'s httpFetch leg and `parseSse`'s stream leg): a paced
   failure carries `providerRetryAfterMs` on the LlmError — the field
   dsh-llm-retry's `recover()` adopts VERBATIM as the retry wait
   (llm-retry@lib index.js:168-172), the same channel a provider's
   Retry-After rides. The adapter class is hoisted to a route-bound
   `GatewayLlmAdapter` (the class expression was pushing
   `createGatewayLlmAdapter` over the code-size function budget).
3. **`providerRetryPolicy()` widens `maxDelayMs` to the widest slot**
   (resolved by the VENDORED `resolveRetryPolicy` — validated, defaulted,
   frozen): recover()'s give-up clause returns next() — NO retry at all —
   when `providerRetryAfterMs > policy.maxDelayMs` (llm-retry@lib
   index.js:169), so an unraised default (10s) would turn every paced failure
   into instant budget starvation. `maxRetries` stays 5 and `initialDelayMs`
   stays 500, so the unpaced rhythm and the honest budget are bit-identical.
4. **Field visibility**: `retry-telemetry.js` carries `delayMs` in the warn's
   data, so the next battery round reads the cadence off logcat.

Net effect on the r18 shape: the chain's scheduled waits become
0.5 + 15 + 45 + 120 + 120 ≈ 300s of outage coverage (panel-pinned: the REAL
staged dsh-llm-retry recover() schedules 15/45/120/120s for retries 2..5) —
attempt 5 of the replayed r18 cut lands ~t0+302s, after the 255s restore, so
the turn survives; a cut that outlasts the ladder still errors honestly and
loop-u's turn-recovery continues the queued followups.

Panel pins (`test/panel/llm-retry-pacing.test.js`): the ladder and its resets
(clamp, slow-reset, episode decay, the field shape where the TIMEOUT consumes
no strike); the route policy values; and the REAL vendored consumer (the
tracked android staged bytes, vitest-aliased; its bare `zod` import stands in
via a file-local vi.mock since no zod bytes are tracked) — paced waits land in
`llm/retry delayMs` verbatim, a slow failure keeps the ~500ms local rhythm, a
non-retryable code passes through, and the exhaustion attempt hands the error
to `next()`. Closures re-synced (android wholesale; harmony SPINE_OURS +
Index.ets rows for the new module), `dsh-llm-stub.js` grew the two faces the
seam now imports (`providerRetryAfterMs` on LlmError, `resolveRetryPolicy`),
mirroring the vendored shapes.

**The staging-check activation (collateral, in the same PR).** Adding the new
module's rows to `Index.ets` / `vendor-official.sh` put this PR inside the
staging-check gate's path scope for the first time since its triage — until
then the gate had been passing vacuously ("0 files in scope"; #385 an hour
earlier), and once live it reported 25 PRE-EXISTING harmony gaps (7 scenario
files + 8 plugins' files, shipped in the committed rawfile but never named in
`vendor-official.sh`'s CLOSURE/SPINE_OURS, so CI never refreshed them) plus
this PR's own real iOS gap. The PR carries the repair: the 25 rows joined
their surfaces (plugin manifest.json rows alongside, per the dsh-device-plane
pair precedent — all byte-identical no-ops), `upstream/llm-retry-pacing.js`
joined `hosts/ios/Tools/gen_bundle_header.py`, and one file was a genuine
drift catch: harmony's committed `dsh-shell-wasm/index.js` was the #139-era
bytes (the starter set grew in #338; android re-synced, harmony never did) —
the SPINE row now stages canonical over it, and the committed rawfile copy is
the refresh. Recorded as a surprise (rule 11): a gate whose scope is
diff-activated accumulates silent debt that charges whoever touches the
surface next.

Honest limits: (a) the escalation state lives on the adapter and decays on
episode time only — a SUCCESS does not reset it, so a fast blip shortly after
a recovered outage can draw one rung wider than strictly needed (bounded by
the episode decay); (b) the first paced wait (15s) also applies to a fast
TRANSPORT failure online (a transient DNS blip now waits out its slot instead
of retrying in 0.5s) — that is the trade the ask orders, and SERVER/RATE_LIMIT
failures keep the snappy rhythm; (c) pacing is deterministic (no jitter) —
the escalation itself provides the spread.

## Alternatives considered

- **Seam-side sleep before handing the failure over** (the ask's option a):
  rejected. The sleep would stack UNDER the vendored localDelay
  (double-waiting), hold the attempt "running" with no guard armed — the
  invisible-stall shape loop-u2 removed — and hide the cadence from the
  journal's `llm/retry delayMs` and the UI banner. The vendored injection
  point made it unnecessary.
- **Raise the provider backoff wholesale** (`initialDelayMs` 500 → 15s in the
  retry policy, no seam code): rejected — it paces EVERY failure class,
  slowing online transient recovery (a fast 5xx would wait 15s) and putting
  the slow-failure rhythm's minimum at the ladder's height. Only
  transport-class fast failures are paced; the policy change here is the minimal
  `maxDelayMs` widening the give-up clause forces.
- **A new gateway/contract primitive for backoff input** (contract-first D5):
  rejected — none is needed; the vendored contract already carries the two
  hooks this fix uses, and no gateway surface changes.
- **Teach the vendored loop the outage state** (e.g. a network-reachability
  feed): rejected — new cross-module state for something the failure objects
  already express, and polling network state contradicts the event-driven
  rule (D8).
