# Agent Note: the harmony mux frame order serializes, the write leg's workspace title derives from the seat, and the host E2E judge grows optional rows

Status: implemented
Related: the 2026-10-08 harmony verification round (T-0048 tail, T-0202 T3/T6,
T-0033); #402's semantic-names rename; #412's vendored-subagent boot

## Problem

The harmony user-facing host E2E (`hosts/harmony/ci/run-host-e2e.sh`) had not
run on Windows since the 2026-10-05 pass, and this round's first run surfaced
four independent defects the stale green had been hiding:

1. **Adjacent mux journal frames reached the page transposed.**
   `harmony.session.live-read` failed its frame-sequence pin with 19/19
   frames in the wrong ORDER (`agent/inbox/spliced` vs `step/start`,
   `request/header` vs `request/context` — adjacent swaps). The Android twin
   passed the identical vendored closure in CI the same day: the divergence
   is harmony's carrier pump. `CarrierServer.sendToPath` fired the platform's
   ASYNC `socket.send()` fire-and-forget — no write serialization — so two
   rapid frames raced to the wire.
2. **The write leg's pick could never find its row.**
   `harmony.composer.live-write` died at "the composer never appeared after
   the workspace pick". #402 renamed the probe's pinned title
   `spike`→`dsh` (copying the Android value) while the ACTUAL staged rt
   bundle directory renamed `spike`→`rt` (`Index.ets materializeBundle`'s
   `cacheDir + '/rt'` — the profile container whose basename the page shows
   as the workspace row). The pick waited for a row named `dsh` in a dialog
   offering `rt`.
3. **The runner pulled a renamed capture and grepped a typo.** The trio's
   sink capture renamed `dsh-dsh-capture.log`→`dsh-rt-capture.log` in #402
   (`Index.ets runSpike`'s capturePath) — the runner still pulled the old
   name, so the trio checkers judged an empty stream (logged 0). And the
   `grep'dsh.runtime'` missing-space typo (run-host-e2e.sh AND
   run-live-llm.sh) left both runners' `logs.txt` deliverables empty forever
   — the e2e-matrix EMPTY_DELIVERABLE finding on the T3 leg proved it.
4. **The D9 drive waited on a flow-controlled hilog stream.** The legs'
   terminal verdicts dropped off the `hilog` stream under burst (the
   runner's own `-Q` warning fired every run), starving drive-official's
   deadline while every leg had completed on-device — the checkers' capture
   files carried the verdicts the drive never saw.

## Decision

Four pieces, all verified on the dsh_phone emulator against today's tree:

1. **`CarrierServer.sendToPath` chains each seat's WS writes onto a
   per-connection `writeChain` promise** (catch re-resolves, so one failure
   never stalls the stream): wire order equals call order — the journal
   stream's frame order IS its contract. After the fix the b3 probe's
   sequence pin passed (19/19 in order) across four consecutive full runs.
2. **`SessionWriteProbe.probeScript(webRoot)` derives the workspace row
   title from the caller's `webRoot` basename** (OfficialPhase passes its
   own) instead of a pinned string — the pick leg matched `rt` on the next
   run and the leg completed end to end. A pinned constant drifted once; a
   derivation cannot.
3. **The runner tracks the renames and its own typo**: pulls
   `dsh-rt-capture.log`, greps `'dsh.runtime'` with the space (both
   runners), deletes the four D9 capture files before launch (they persist
   across runs in the app cache — a previous run's FAIL verdict answered the
   fresh probe until this run's leg truncated its file), and converts
   screenshots magic-byte-gated (PNG already → skip; JPEG → sips, then
   ffmpeg via temp file, else warn — ffmpeg refuses an in-place no-op, which
   killed an otherwise green run).
4. **`drive-official.mjs` greps the on-device capture files as the
   terminal-wait fallback** (the same files the checkers judge) whenever the
   stream has not delivered, and the composer manifest's page-driven burst
   becomes honest about its shape: the racing catalog probes are
   `order: "any"`; `skills/list`/`commands/list` are `optional` in position
   (the page fires ONE per boot); the boot emits
   `spine.tools.mounted` — the session toolset's real visible names — which
   log-asserts T-0048's tail truth: the 16 mounted tools are the
   spine/system-plugin face; **bash/pwsh/present/ralph are NOT mounted in
   the user-facing boot** (preset-document rows; the boot agent joins no
   preset — upstream/boot.js's documented staged gap). Staged +
   preset-resolvable is the state; mounted-in-boot is not, and the record
   keeps that on the log.

Supporting tooling: `test/e2e/check.mjs` grows the `optional` expectation
(skipped when absent, in position; composes with `order: "any"`) with
rule-6 fixtures in selftest.sh, and `test/e2e/matrix.mjs`'s count-consistency
rule turns optional-aware (logged < expected is legitimate for a passing
verdict when the manifest carries optional rows).

## Alternatives considered

- **Re-pin the probe title to `rt`**: rejected — the constant drifted once
  because it duplicated a value owned elsewhere; the derivation single-sources
  it. (The write-chain fix and this were proven independently: the frame
  order normalized in run 2, the pick succeeded in run 7.)
- **Have drive-official poll ONLY the capture files** (drop the stream):
  rejected — the stream is the fast path for the evidence screenshots
  (composer typed/reply); the fallback probes at most every 4s and only when
  the stream has not finished the job.
- **Leave `logs.txt` regeneration to a T3 re-run** (to fix the empty
  deliverable): rejected — a re-run spends real model quota twice; the
  runner's own grep against the run's retained hilog stream regenerates the
  deliverable losslessly, and the key-leak re-check ran clean on the result.
- **Pin the composer manifest's rpc burst rigidly and retry until a run
  matches**: rejected — the page's probe order and catalog-probe choice vary
  by construction; a rigid pin is the flake factory, and the checker already
  carried the `order: "any"` construct for exactly this class. The
  `optional` row completes that vocabulary for the presence half.

## Consequences

- `run-host-e2e.sh` runs green end to end on Windows (8/8 checkers, receipt
  written): the trio, the binding phase, and the four D9 legs — with the
  refreshed evidence committed (m5-host, the session-live frame pin 43/43,
  composer-live-write 41/41 including the two new records).
- T-0202's T3 leg ran the REAL bigmodel backend to a served streaming turn
  (`llm.live-stream` 14/14 device + 7/7 carrier, served model glm-5.3-flash,
  key-leak clean, credentials removed); T6 ran 5/5 cold boots (ready 2-3s,
  PSS flat 110.0-110.2 MB, 0 FAIL verdicts).
- T-0048's tail item is now log-asserted as its honest state: mounted-in-boot
  is FALSE for the four preset tools and the record says so every run; the
  card's remaining work is the preset-join (the staged gap), not evidence.
