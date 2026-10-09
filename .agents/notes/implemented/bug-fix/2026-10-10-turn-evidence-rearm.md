# The second turn's settle was never lost on the wire — the accumulator latched per session; the fix is the per-turn re-arm

Status: implemented
Related: T-0210

## Problem

The 2026-10-10 final-sweep burst (4 concurrent sessions on the harmony
official serve) showed alpha/beta's SECOND rounds completing — the spine
journal held every record — while their `write.turn.settled` e2e lines
appeared NOWHERE: not in hilog, not in the truncation-proof capture
(`D:/tmp-android/final-sweep/`, all three captures plus the hilog dumps).
The working hypothesis was b4.bus emit loss under high concurrency.

The emit chain is lossless: the scenario's `emit` is a synchronous
`log.info` → `__DSH_LOG_SINK__` (dsh_runtime_host.c js_log_sink) → the
embedder sink (napi_init.cpp phase_sink_on_log → OH_LOG_INFO + capture
fputs, no queue, no drop). Reading the capture instead showed the real
shape: every session had EXACTLY ONE settle ever — alpha/beta's first
rounds and the fresh gamma/delta sessions' burst rounds. The loss was
deterministic, not concurrent: `installTurnEvidence`'s accumulator
(composer-web-live.js / harmony-composer-live-write.js) latched `settled`
and `prompt` per SESSION forever, so any session's second `turn/end`
was silently skipped. The burst was merely the first drive to run a
second turn on pre-existing sessions.

## Decision

The accumulator moves to `web-live/turn-evidence.js` (the house split
pattern: turn-failure, probe-respond-await) with the RE-ARM: a
`user/message` arriving on a settled record opens a FRESH page — every
turn prompts, accumulates, and settles on its own. The re-arm rides the
PROMPT, not the settle, so a duplicate `turn/end` for the same turn still
settles once (the old latch's one safe property, pinned by test). The
per-record `events` window keeps the pinned single-turn e2e records
byte-identical (the first record still opens at the session's first
event — the manifests' `events:11` / `seq:5` stand), while each later
turn's settle counts its own window from its prompt. The scripted-text
demand rides every settle on the scripted route (the loopback answers the
same text every turn); real-endpoint and creation-mode routes keep
`demand: null` and report verbatim.

Reproduction is a plain unit suite (`test/panel/turn-evidence.test.js`):
the OLD latched shape is pinned verbatim as the regression face (second
turn settles NOTHING), and the new accumulator is driven through the
measured burst — 4 sessions × 2 turns with the second round maximally
interleaved — asserting all 8 settles and 8 prompt observations land with
per-turn windows.

## Alternatives considered

- **Chase the concurrency hypothesis (unbounded queues, emit
  serialization, debounce)** — no queue exists anywhere on the chain;
  the loss reproduced in a single-threaded unit test with zero
  concurrency. Hardening the wrong layer.
- **Emit a second distinct record for later turns (the android variant's
  `write.turn.settled.next`)** — android's shape latches again after its
  second record (a third turn is silent) and pins a cumulative `events`
  count; the manifest-pinned android drive runs exactly two turns, so it
  is left as-is and flagged as the same latent class. A bounded `next`
  on the harmony faces would re-create the defect one turn later.
- **Reset the record at `turn/end` (re-arm on settle)** — a duplicate
  `turn/end` would land on the virgin page and settle a spurious empty
  record; the prompt is the turn boundary, so the re-arm rides it.
