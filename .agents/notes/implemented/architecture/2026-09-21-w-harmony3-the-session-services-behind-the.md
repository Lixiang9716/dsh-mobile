# Agent Note: W-HARMONY3 — the session services behind the mux: real session.list + the real journal stream from the embedded spine (b-harmony.session.live)

Status: implemented
Related: D9, D5

## Problem

The harmony official web mount ended at a named gap: the mux's first stream
open answered the structured `gateway/unimplemented`, pinned in the
b-harmony.official-web-mount manifest as `session.services.pending` — the
web-boot closure embedded no agent spine, so `session.list` and the
`session/journal` journal stream had no on-device truth on HarmonyOS. iOS
closed the same gap in #62 (b3.session.live 46/46) by booting the FULL
upstream agent spine from the embedded bundle; the harmony host carried only
the compose-only web-boot closure, so the session surface the official page
actually calls stayed honest-unavailable.

## Decision

The spine closure travels in the harmony rawfile and a third D9 leg boots it
on-device, mirroring the iOS reference:

- **Embed**: `ci/vendor-official.sh` extends the rawfile closure with the
  W-SESS spine set — the authored spine files (`upstream/boot.js`,
  `settings-memory.js`, `llm-transport.js`, `scenario/harmony-session-live.js`,
  the async-hooks/util/util-types/os/process/session-persistence shims), the
  14 vendored spine packages (verbatim lib/ trees + package.json each), the
  pinned zod classic closure, and the npm package.jsons — byte-identical to
  the runtime/spike canonicals, cmp-verified per copy (~1.73 MiB across 182
  files). `Index.ets` BUNDLE_FILES carries the full materialization list, and
  `ci/check-bundle-files.mjs` pins the list == the rawfile tree in both
  directions (the #56-class drift guard; dsh-mobile#57 proposes the gate).
  The rawfile zod closure is gitignored verbatim bytes: the syntax-class
  checker cannot parse `export { _instanceof as instanceof }` (valid ES
  module syntax, a tree-sitter false positive) and D6 forbids editing
  upstream bytes to satisfy a checker — the same posture as officialweb/.
- **Scenario**: `scenario/harmony-session-live.js` (the harmony twin of
  `b3-web-live.js`, scenario id `b-harmony.session.live`) takes
  `runtime.config` over the bus seam (mockLlmUrl/apiKey/containerRoot),
  boots the FULL spine via `upstream/boot.js`, drives one REAL scripted-llm
  turn (the 11-event journal baseline), then mounts `createWebBootRuntime`
  on the SAME ctx — `api.claim`/`mux.claim` answer from `ctx.sessions`. The
  runtime half stays resident (never `__dshComplete`): the verdict is the
  carrier-side probe's, exactly like iOS.
- **Carrier**: `OfficialPhase.ets` gains the scripted
  `/mock-llm/chat/completions` endpoint (real loopback HTTP + SSE mirroring
  the vendored dsh-llm-mock-server's success stream byte-for-byte, fixed
  401 leg) and the session-live leg: after the httpfetch verdict (polled off
  `hostStatus`, bounded), a fresh runtime boots the spine, `runtime.config`
  rides the BUS seam (never the gateway event seam), the claims flip
  `session.list` to forwarded and the journal open to a REAL attach, and
  `api.respond`/`mux.item|error|end` fold into the `ApiBridge`. Per-leg
  evidence state (scenario label + once-guards reset) keeps each leg's
  capture file holding exactly its own manifest's records.
- **Probe**: `SessionLiveProbe.ets` (the harmony twin of iOS
  SessionLiveProbe.swift) parks `__b3Run`'s JSON in `window.__b3Out` (ArkWeb
  runJavaScript does not await promises): shell settle at the
  workspace-selection state + one quiet window, the REAL session.list RPC
  through the official envelope, the mux `session/journal` open addressed to
  the reported session, frame collection until two assistant/message events
  quiet down (11-event baseline + the 8-event live turn 2, contiguous seqs
  0..18), then the TRUE rendered read. The drive unfolds the verdict into
  `session.list.real` / `session.journal.real` / `module.system.live` /
  `page.rendered` and logs `dsh.spike.verdict: b-harmony.session.live`.
- **E2E**: `ci/drive-official.mjs` waits for all three phase verdicts and
  takes the two session-live screenshots; `ci/run-host-e2e.sh` pulls
  `dsh-session-capture.log` and runs the seventh checker.
- **Robustness (found by the run series, kept)**: the single-shot
  `web.plugins` delivery (one ~6.9 MB bus line) blocked the ArkTS main
  thread past the platform's 6s watchdog — run 3 appfreezed
  (THREAD_BLOCK_6S) and was killed under emulator load after the same
  delivery had passed twice. `web-boot.js` now accepts a CHUNKED delivery
  (`chunked: true`, `final: true` on the last chunk): the drive sends
  4-package chunks with event-loop yields between them; each chunk merges
  into the VFS (`shims/fs.js` `mergeWebPlugins`) and only the final one
  composes. The iOS drive's single-delivery shape is untouched (legacy
  path stages-and-composes in one step), so no sibling host changes.
  Two smaller finds: the b1 probe's poll loop swallowed its own deadline
  rejection at the recursion level (a hung probe starved the leg
  silently) — the rejection now propagates and the session probe adds a
  `__b3Stage` heartbeat so a hang names its stage; and the unavailable
  boot burst's internal rpc order is ArkWeb fetch scheduling that RACED
  between two runs (dynamicCordisRunner inventory/syncInspectManifest
  swapped), so `rpc.observed` pins the burst's honest FIRST only plus the
  first call of each CLAIMED endpoint (`session.list` forwarded).

## Alternatives considered

- **Claiming the write surface too** (`session.prompt` etc.): rejected —
  the same boundary iOS drew; the read path is fully live, the write surface
  stays the named gap.
- **A separate SessionLivePhase class with its own carrier**: rejected — the
  route table, dist, plugins, bridge and probe plumbing are shared; a second
  carrier would duplicate the mount leg's wiring for no behavioral gain. The
  leg lives in `OfficialPhase` with per-leg scenario labeling instead.
- **A C-side verdict from a completing JS scenario**: rejected — the probe
  (the assertion) runs in the WebView AFTER turn 2; the scenario cannot
  observe it, so a resident runtime + drive-owned verdict line is the
  honest shape.
- **Per-endpoint rpc.observed pins for the whole boot burst** (the iOS b3
  manifest's shape): rejected — the burst's internal order is ArkWeb fetch
  scheduling and raced between two runs; only the burst's first member and
  the claimed surface's per-endpoint firsts are deterministic pins.
- **Keeping the whole spine closure tracked like the web-boot closure**:
  rejected for zod only — `v4/classic/schemas.js` does not parse in
  tree-sitter-javascript (`as instanceof`), the check gate is a false
  positive there, and editing the bytes is upstream tampering. Untracked +
  materialized + cmp-verified keeps the gates honest without touching
  upstream code.

## Consequences

- `session.list` and `session/journal` are claimed end-to-end on-device on
  HarmonyOS with real spine data; every other endpoint and non-journal mux
  stream stays structured-unavailable (fail loud, pinned in the manifest).
  b-harmony.session.live passed 43/43 TWICE consecutively (m1 7/7,
  m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20,
  b-harmony.official-web-mount 17/17, b-harmony.httpfetch-v2 6/6 in the
  same runs) with real-PNG screenshots.
- The harmony HAP carries ~1.73 MiB more embedded JS (182 files committed;
  the zod closure rides the gitignored-but-materialized set).
- The mount manifest's `session.services.pending` pin stays frozen (the
  compose-only b1 leg is unchanged); the session-live manifest pins the
  claimed reality alongside the remaining honest boundary
  (workspace/follow still answers gateway/unimplemented).
- The chunked `web.plugins` delivery is now the harmony drive's shape; the
  shared runtime accepts both shapes, so the iOS/Android drives and the
  CLI scenarios are untouched.
- The `check` gate cannot judge the rawfile zod bytes — if upstream zod
  gains load-bearing files beyond the classic closure, extend the
  vendor-official.sh list and re-freeze the manifests.
