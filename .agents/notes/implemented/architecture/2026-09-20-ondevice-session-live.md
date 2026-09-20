# Agent Note: The upstream agent spine boots on-device; the session `/api` + mux journal streams answer real data (b3.session.live)

Status: implemented
Related: D9 (upstream port); contract `docs/webserver-contract.md` §2.3/§2.4/§3.5

## Problem

The embedded QuickJS runtime carried only the client-modules closure: the
official web app booted through the real upstream boot wire, but every
`/api` endpoint answered the structured `gateway/unimplemented` envelope
and the mux `session/journal` stream answered the structured unavailable
error frame. The upstream agent spine (`ctx.sessions` / `agents` /
`agentLoop` / `tools` / `systemPrompt` / projections + the vendored
`dsh-llm` service) existed only in the CLI proof runs
(`m2.upstream-session`), so the session surface the official app's boot
actually calls had no on-device truth — the second enumerated D9 gap.

## Decision

The b3.session.live drive (`-dsh-mode session-live`) boots the FULL spine
on-device and claims the read surface over the bus seam:

- **Embed**: `gen_bundle_header.py` gains a tree mode — the vendored spine
  packages (14 verbatim `lib/` trees + each package's `package.json` for
  the upstream attribution `require`) and the pinned zod's classic-closure
  file list are embedded whole (172 files, ~1.7 MiB raw JS) and staged back
  at the bundle-relative paths the C loader's bare map already resolves.
  Single-file rows cover the mobile profile boot, the settings backend,
  the gateway llm transport, and the shims beyond the web-boot set.
- **Scenario**: `scenario/b3-web-live.js` boots `upstream/boot.js` on the
  runtime (profile container = the host-granted staged root delivered via
  `runtime.config`; llm route = the carrier's SCRIPTED chat-completions
  endpoint, logged as such in `llm/runtime`), drives one REAL scripted-llm
  turn (the journal baseline), then mounts `createWebBootRuntime` on the
  SAME context — the claims (`api.claim` / `mux.claim`) answer from
  `ctx.sessions`. A second turn streams live journal frames into the
  attached page.
- **Carrier**: `CarrierRoutes.swift` gains the scripted
  `/mock-llm/chat/completions` endpoint mirroring the vendored
  dsh-llm-mock-server's success stream byte-for-byte (5-char deltas,
  terminal chunk with finish_reason + usage, `[DONE]`, fixed 401 leg).
  `SessionLiveRuntime` folds `api.respond` / `mux.item|error|end` into the
  `CarrierAPIBridge` and wires `deliverToRuntime` onto the drive.
- **Host fix (fail loud)**: `dsh_spike_eval` now drains jobs and inspects
  the module evaluation promise — an exception inside a module graph is
  captured as the promise's REJECTION, not a thrown error, so eval used to
  report success while the scenario body never ran. The rejection now
  surfaces naming its reason.
- **Gateway fix (frozen-contract alignment)**: `HTTPPrimitive` read
  method/headers/body from a nested `init` dict the frozen shim never
  sends (gateway.js sends flat `{url, method, headers, bodyB64}`) — every
  iOS httpFetch silently degraded to a headerless GET. The gateway llm
  transport is the first POST caller; args are now read flat per
  contract/primitives.md.

The probe (`SessionLiveProbe`) drives the read path through the official
envelope: `POST /api/session.list` (real answer: the configured agent
session, non-blank), the mux upgrade, the `session/journal` open
addressed to the reported session — 19 REAL log frames (11-event turn-1
baseline + the 8-event live turn-2), contiguous seqs — then reads the
rendered state. The official shell stays at its plugin-loading state (the
app shell needs more plugin bundles than the mobile profile serves) and
the probe reports that state as-is.

## Alternatives considered

- **Claiming the write surface too** (`session.prompt` etc.): rejected for
  this slice — the official UI's input path needs more RPC surface than
  the spine composition implements; claiming half of it would trade the
  structured-unavailable honesty for a half-working write path. The read
  path is fully live; the write surface stays the named gap.
- **In-memory scripted LlmAdapter** (no HTTP): rejected — the transport
  seam is the thing under test; the scripted endpoint keeps real
  HTTP + SSE over loopback (mirroring the CLI's node mock-server
  semantics) with only the model output scripted.
- **Extending b1 in place**: rejected — b1's 13-event manifest pins the
  unavailable answers of the pre-spine carrier; a sibling scenario keeps
  that regression frozen while b3 pins the claimed reality.

## Consequences

- `session.list` and `session/journal` are claimed end-to-end on-device;
  every other endpoint still answers structured-unavailable (fail loud).
- The embedded bundle grows by ~1.7 MiB of pure JS (byte arrays committed);
  the syntax-class checker never judges the vendored trees (untracked
  upstream code, sha256-pinned by ensure-dsh.sh).
- `WebBootRuntimeDrive` is now parameterized (scenario, gateway wiring,
  config delivery, completion reporting); b1's call site is unchanged.
- The renderer-side probe assertions are frozen from observation (the
  journal shape 11+8), not prediction — re-freeze if upstream's turn
  vocabulary changes at the pin.
