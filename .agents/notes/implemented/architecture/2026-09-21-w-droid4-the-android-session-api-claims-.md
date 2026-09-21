# Agent Note: W-DROID4: the Android session /api claims go live — the full upstream spine boots on-device and answers session.list + the mux journal with real data

Status: implemented
Related: D9 (upstream port), D6 (pinned upstream), D8 (event-driven); the
Android sibling of W-SESS (#62, b3.session.live); contract
docs/webserver-contract.md §2.3/§2.4/§3.5

## Problem

The Android carrier served the official upstream web app with the runtime-
composed boot wire (W-DROID #63), but the embedded closure carried only the
web-boot packages: every `/api` endpoint answered the structured
`gateway/unimplemented` envelope and the mux `session/journal` stream
answered the structured unavailable error frame — pinned in the b-android
manifest as `session.services.pending`. The upstream agent spine
(`ctx.sessions` / `agents` / `agentLoop` / `tools` / `systemPrompt` /
projections + the vendored `dsh-llm` service) existed only in the iOS embed
(#62) and the CLI proof runs; on Android the loader's vendor trees carried
no spine packages, so the session surface the official app's boot calls had
no on-device truth — Android's named D9 gap.

## Decision

- **Stage, don't embed — and stay untracked.** `hosts/android/ci/stage-spine-closure.sh` copies
  the #62 spine closure into the app assets — the 14 vendored spine
  packages (LICENSE + package.json + lib/**, docs/bin/.d.ts pruned, the
  same lean rule the web-boot closure follows), the pinned zod classic
  runtime closure (81 files), the spine boot layer (upstream/boot.js,
  llm-transport.js, settings-memory.js) and the shims beyond the web-boot
  set (async-hooks, util, util/types, os, process, dsh-session-persistence)
  — then verifies byte-identity against the runtime pins. The vendored
  trees are UNTRACKED (the #62 discipline: untracked upstream code,
  sha256-pinned by ensure-dsh.sh); the Gradle build materializes them via
  the `stageSpineClosure` task before packaging, so a fresh clone builds.
  The port layer (upstream/*.js, the scenario) stays tracked — it is ours.
  MainActivity's materialization lands the files at the C loader's
  bundle-relative paths (`vendor/dsh/<pkg>@<ver>/lib/**`,
  `vendor/npm/zod@4.4.3/...`).
- **The compose is platform-neutral.** `scenario/b-android-session-live.js`
  is the b3-web-live sibling: the FULL spine boots on ONE ctx
  (upstream/boot.js), one REAL scripted-llm turn runs through the REAL
  agent loop (the journal baseline), then the web-boot producer mounts the
  official wire on the SAME ctx and posts `api.claim` (session.list) +
  `mux.claim` (session/journal) + `web.boot`. Only the scenario id, the
  session identity, and one transport fact differ: logcat's ~4KB line
  budget keeps `runtime.booted` at `entryCount` (iOS logs the full 58-id
  array).
- **Claims fold into the existing bridge seams.** SessionLiveSession drives
  the runtime through the frozen M4 bridge with the gateway wired
  (fs + httpFetch; anything else settles denied) and folds the bus
  protocol into CarrierAPIBridge: `api.claim`/`mux.claim` arm the bridge,
  `api.request` forwards onto the runtime, `api.respond` /
  `mux.item|error|end` come back. MockLlmRoute is the scripted
  `/mock-llm/chat/completions` boundary (the vendored dsh-llm-mock-server's
  success stream + 401 leg byte-for-byte; real loopback HTTP + SSE, only
  the model output scripted — logged as such in `llm/runtime`).
- **Carrier fix (fail loud, connection lifecycle):** the carrier is
  connection-per-request and closed the socket when the route handler
  returned — but a CLAIMED endpoint's answer arrives asynchronously from
  the runtime thread, so every claimed response raced a closed socket (the
  write threw, killing the runtime thread). tryForward now PARKS the
  connection thread until the runtime's answer arrives (RpcWaiter,
  30s deadline → structured unavailable envelope; respondAPI is handoff
  only, never a socket write off the connection thread).
- **Evidence normalization:** the page fires its boot-RPC burst in
  parallel, so the unavailable witnesses' arrival ORDER races across runs
  (the SET is stable). SessionLiveSession holds them and flushes SORTED at
  the first claimed call — the one-to-one manifest stays deterministic
  without losing a witness. The probe settles on the shell's
  workspace-selection state in EITHER upstream locale (zh 选择工作区 / en
  Choose workspace — the emulator's WebView resolved en) with a 60s bound
  (the emulator's recovery backoff is slower than the iOS device's 20s).

Canonical run: b-android.session.live 46/46 with the full regression green
in the same invocation (m1.spike.boot, m2.bridge.smoke, m2.session,
m4.host-binding 35/35, m2.gateway.audit 16/16, b-android.official-web.mount
14/14). The official shell reaches the workspace-selection state on REAL
session data; the probe receives the real session.list answer and 19 real
journal frames (11-event baseline + the 8-event live second turn, contiguous
seqs). REAL screenshots under hosts/android/artifacts/android-session-live/.

## Alternatives considered

- **Embedding the spine as C byte arrays (the iOS gen_bundle_header tree
  mode)**: rejected — the Android embed is the assets tree (Gradle packs
  it); the same closure staged as files keeps the embed model the web-boot
  closure uses, and the script's byte-identity check gives the embedder's
  guarantee without a code generator in the build.
- **Committing the staged spine trees (the #63 web-boot closure's
  choice)**: rejected — the syntax-class checker judges every TRACKED file,
  and the pinned zod's `export { _instanceof as instanceof }` (valid ES
  module syntax node accepts) does not parse under the shipped JS grammar —
  a checker false positive that could only be silenced by editing vendored
  bytes (forbidden) or untracking the trees. Untracked + Gradle-staged is
  the #62 discipline (vendored code stays out of every content gate; the
  ensure-script pin is the tracked provenance).
- **Claiming the write surface too** (`session.prompt` etc.): rejected for
  this slice, mirroring #62 — the official UI's input path needs more RPC
  surface than the spine composition implements; claiming half of it would
  trade structured-unavailable honesty for a half-working write path. The
  read path is fully live.
- **Pinning the boot burst's inline arrival order** (as iOS's manifest
  does): rejected — three observation runs showed the middle four
  unavailable witnesses racing (dynamicCordisRunner inventory/
  syncInspectManifest, credentials/modelCatalog) on the emulator's
  parallel page traffic; inline order would flip the manifest run to run.
  The sorted flush keeps every witness and makes the stream deterministic.
- **In-memory scripted LlmAdapter** (no HTTP): rejected — the transport
  seam is the thing under test; the scripted endpoint keeps real HTTP + SSE
  over loopback with only the model output scripted (the CLI mock-server
  semantics).
- **Extending b-android.official-web.mount in place**: rejected — that
  manifest pins the unavailable answers of the pre-spine carrier
  (`session.services.pending`); a sibling scenario keeps that regression
  frozen while b-android.session.live pins the claimed reality.
