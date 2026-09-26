# Agent Note: the self-hosted clients reach HarmonyOS (whale + next, and a latent main bug unearthed)

Status: implemented

## Problem

After the Android port (#220) the two self-hosted Web Clients —
`dsh-web-client-whale` (v0 `/ws` plane) and `dsh-web-client-next`
(official `/api`+mux plane) — still ran only on iOS and Android. HarmonyOS
had no staging for either tree, no leg selection, and no creation-row seat;
its interactive config also carried `commands:true` over a closure that
lacked the four npm-scope packages (the same latent break Android's drive
caught — every interactive boot died on the first import).

## Decision

Harmony serves both clients through its existing seats, mirroring the iOS and
Android seams:

- **Staging**: `vendor-official.sh` stages both trees into
  `rawfile/spike/webclient/dsh-web-client-{next,whale}` (whole-tree copy +
  byte-verify, its own WEBCLIENTS block — the older v0 hand-commit predates
  the discipline and stays as-is) and adds the four interactive npm packages
  (`dsh-anonymous-user-id`, `dsh-goal`, `dsh-file-reference{,-local}`) to the
  closure; `Index.ets` BUNDLE_FILES carries every new file
  (`check-bundle-files` pins 382 = 382 both directions).
- **The whale leg** (`--ps dsh.e2e.leg whale.mount`): `HostPhase.beginWhale`
  runs `scenario/session-mock-llm.js` under the whale web root with the whale
  client id in the mount records — the iOS `--client whale` / Android
  `--ez dsh.whale` legs' sibling. Evidence: `harmony.whale.mount` 7/7
  (`hosts/harmony/ci/run-whale-mount.sh`, the capture-file pull + checker).
- **The next client**: `WebDist` takes a `distRoot` (default the official
  dist); `OfficialServe.beginInteractive` accepts one and keeps the injection
  rows empty for any non-official root (the page owns its whole boot); the
  release boot reads `--ps dsh.web.client dsh-web-client-next` (unknown ids
  fail loud). The interactive config gains the **creation row**. The scripted
  model route gains the `SLOW_TURN` drip (`CarrierServer.respondDrip` — ArkTS
  timers pace ~8 slices on one connection) and the `CREATE_TURN` write+present
  pair (distinct wire indices, one-shot latch — the Android lessons applied
  verbatim).
- **The nextweb drive** (`NextWebPhase.ets` + `--ps dsh.e2e.leg
  nextweb.mount`): the ArkWeb shape — page-side async legs park their JSON in
  `window.__nextOut` (runJavaScript cannot await promises) and the drive
  polls with deadlines. Evidence: `harmony.nextweb.mount` 19/19
  (`run-next-web-mount.sh`).

The full battery re-run (forced by the port's staging changes) surfaced a
LEDGER of latent main defects, all fixed here:

0. **The carrier's HTTP body accounting was char-based, not byte-based**
   (`parseHttp`): a multibyte body — the bilingual system prompt carries
   CJK — decodes to FEWER characters than its Content-Length byte count,
   and the parser waited forever for padding bytes that never arrive. Every
   scripted turn's chat-completions POST hung to the transport's 30s
   timeout; with the fix the session/write/nextweb turns all stream.
1. **#194 conflated the mount leg's eval entry with the scenario label**
   (covered below).
2. **The harmony bundle was missing the interactive closure wholesale**:
   the SKILL row family (54 dsh packages — the full mobile-preset circle
   iOS embeds), the npm faces (yaml browser, diff libesm), the presets yaml
   tree, and `dsh-session-persistence` (agent-loop imports it at eval
   time). All staged now, with the closure's find list extended so the
   byte-verify covers them (624 BUNDLE_FILES rows, 382→624 both ways).
3. **Hand-synced rawfile copies had drifted** (npm-bridges/globals from
   #213's era) — synced + brought under the closure.
4. **The seat never delivered the `agentPresets.seed`** the interactive
   boot and the write leg's settings probes need — the iOS/Android seats'
   delivery, ported (presets tree + resolution markers, base64 over the
   bus); the interactive boot's config rides the FINAL plugins chunk (an
   earlier config delivery re-drives the spine into probes that a
   mid-composition boot answers 'not composed yet').
5. **`HostPhase.onSlotAck` had no once-guard** (below).
6. **The whale leg's `host.info` raced the page's render** (below).
7. **`run-host-e2e.sh`'s session-live checker name was mistyped**
   (`-read-read.json`) — the checker never ran; fixed and the
   session-live manifest refreshed to the current composition (43/43).
8. **Manifest-revision drift** in officialweb-mount (rows 5→6), write-live
   (rpc set + tools 6 + claim list + session/cancel), session-live — all
   refreshed to the truthful current output; the battery's D9 deadline
   600s→900s (the legs pass; the wall clock grew with the bundle).

The specific design decisions:


1. **`onSlotAck` had no once-guard** — the page re-acks on re-renders; a
   second `slot.registered` after the live deltas is an extra record the
   manifests allow exactly one of. The Android/iOS `slotAcked` guard,
   mirrored.
2. **The whale leg's `host.info` raced the page's own render** — harmony
   delivered it at page-hello, ungated; the whale page acks only after
   rendering the replay, so `slot.registered` landed after the whole session.
   `deliverHostInfo` now gates on the ack FOR THE WHALE LEG ONLY: the m5 and
   llm legs keep hello-time delivery because their scenarios gate their OWN
   slot projection on `host.seed` — an ack-gated delivery deadlocks them
   (measured: the m5 drive starved past its verdict deadline until the gate
   was made leg-conditional).
3. **A latent main bug, older than this work**: #194 changed the seat's
   mount-leg eval from `ENTRY_MOUNT` to the conflated `entry` variable that
   held the scenario LABEL — `evalEntry('harmony.officialweb.mount')` threw
   "cannot read entry" and killed the boot chain for every non-interactive
   mount leg. Nobody noticed because the harmony CI job is build-only and the
   committed D9 artifacts predate #194. The re-run this change forced caught
   it; the entry and the verdict label are now separate values. The battery's
   drive deadline also moved 600s → 900s (the four D9 legs re-materialize the
   bundle each on the CLT emulator; the legs pass, the wall clock grew).

## Alternatives considered

- **Gate `host.info` on the slot ack everywhere** (the iOS/Android semantic
  verbatim) — rejected after measurement: it deadlocks the m5/llm flows whose
  scenarios project the slot only after `host.seed`. The whale-only gate is
  the honest reconciliation.
- **`order: any` on `slot.registered` in the whale manifest** instead of the
  gate — rejected: the gate makes the record order true BY CONSTRUCTION
  (matching the sibling hosts) rather than tolerating a race.
- **Reusing OfficialPhase for the nextweb drive** — rejected: OfficialPhase
  drives four legs over ONE shared seat at 974 lines; the nextweb drive needs
  its own OfficialServe (different dist root + interactive config) and its
  own file to hold the size gate.

## Consequences

The harmony release boot's interactive configuration is now bootable (the
four packages were missing for it too), and the D9 mount legs are repaired on
main-vintage code. The whale-leg gate is the one seam where the three hosts'
readiness semantics now differ deliberately (documented in
`deliverHostInfo`); unifying them would mean changing the m5 scenarios'
wait order, which is frozen-manifest territory.
