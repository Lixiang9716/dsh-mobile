# dsh-mobile Architecture

English | [简体中文](ARCHITECTURE.zh.md)

> Version: v0.1 (foundation) · Status: reviewed, entering the contract-freeze phase
> Based on static analysis of the upstream [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) vendored runtime (285 packages) and the DSH Community Fabric draft RFCs 0001–0004.

## 1. Positioning

dsh-mobile is a **mobile host** for the DSH (DeepSeek Harness) ecosystem. Under the Fabric interoperability model, mobile and desktop are **equal peers with different capabilities**, not copies of each other:

- **Runtime** (where plugins execute) and **Presentation** (where UI renders) are independent axes — the phone is both a Runtime (QuickJS carrying the Harness core) and a carrier of Presentations (mobile-ui / desktop-ui are all plugins).
- The host declares its capability surface honestly via `RuntimeDescriptor` (no subprocesses, security-scoped filesystem, push notifications); plugins negotiate via required/optional capabilities — what fits runs, what doesn't is visible.
- Distribution is open-source outside the App Store (self-signing / TrollStore / future EU channels), independent of App Store review.

## 2. Overall Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Presentation                                                │
│  WKWebView ←─loopback HTTP/WS─→ Swift Carrier               │
│  (Web Client plugins: official React UI / mobile-ui / 3p)   │
├────────────────────────────────────────────────────────────┤
│ Harness core (QuickJS single-threaded coroutine runtime,    │
│  dedicated serial thread)                                   │
│  Upstream pure-logic packages reused as-is: agent-loop /    │
│  session / llm / settings                                   │
├────────────────────────────────────────────────────────────┤
│ System implementation plugins (JS, pluggable, implement     │
│  upstream service contracts)                                │
│  dsh-fs-ios · dsh-subprocess-quickjs · dsh-notify-ios …     │
├────────────────────────────────────────────────────────────┤
│ Capability gateway (host-fixed, never a plugin)             │
│  narrow primitive table (≤10 in v0) · capability checks ·   │
│  permissions · audit log                                    │
├────────────────────────────────────────────────────────────┤
│ iOS privileged layer (Swift, bound to the App signature)    │
│  Security-scoped bookmarks · Keychain · notifications ·     │
│  NSURLSession                                               │
└────────────────────────────────────────────────────────────┘
```

## 3. Runtime Design

- **Engine**: quickjs-ng (pure-C interpreter, no JIT). Beyond review-independence (we ship outside the App Store anyway), it wins on memory footprint and multi-runtime isolation. Rationale in ADR-1.
- **Execution model**: single-threaded event loop + async/await coroutines. Subprocess semantics are re-implemented in-process by `dsh-subprocess-quickjs` (upstream `ctx.subprocess` is already an abstract Service base class — its docs say "Subclass, implement spawn, and load the subclass as a plugin").
- **Module loading**: the host implements `JS_SetModuleLoaderFunc`, reading ESM sources from the bundle directory (code as data); compiled bytecode is cached under `cache/blobs/` (`JS_WriteObject`) for fast startup.
- **Shim surface** (measured across all 285 upstream packages): builtin-module import surface = path 67 / crypto 46 / fs 35 / os 20 / url 23 / util 11 / stream 7 / net 5 / http 4 packages; the crypto surface is only 6 APIs (randomUUID / createHash / randomBytes / timingSafeEqual / pbkdf2 / createHmac) → one Swift CommonCrypto file covers it; the 12 `child_process` packages all live in platform implementation packages and are simply not loaded in the QuickJS host; 4 `worker_threads` packages are single-point refactors. (D9 update: these remain the 285-package *static worst case*; the verbatim port measured the product-carrying closure's *actual* import surface far smaller — the exact shim table shipped is [runtime/spike/upstream/README.md](../runtime/spike/upstream/README.md), cross-referenced from §10.)
- **Lifecycle**: checkpoint/resume against background suspension — persist at event-loop quiescence points and approval-pending points; on foreground the UI reconnects (upstream `client-connection` already has reconnect semantics) and the runtime resumes from the checkpoint.

### Event-driven execution

**All inter-module communication is event-driven; no module may block another.** Streaming is
the flagship case — LLM token deltas are an event sequence, not a blocking call — but the rule
is universal:

- **Harness core**: upstream Cordis is already an event system (services + events); tool calls,
  approval requests, and token deltas flow as typed events (`dsh-typert-protocol` /
  `dsh-sdk-protocol`).
- **Streaming**: `agent-loop → session projection → carrier WS push → Presentation rendering`
  is one event pipeline. UIs never poll and never call the agent directly.
- **Capability gateway**: the Swift↔JS bridge is an async event boundary — requests go out as
  events, completions come back as events dispatched onto the runtime queue (the thread rules
  are event-delivery rules).
- **Plugins**: lifecycle hooks and `messages.observe` (Fabric RFC 0001) are events.
- **Checkpoint**: defined as "event queue drained" — a natural quiet point, not a special case.

Rules (binding for all modules, present and future):

1. Cross-module communication only via events (publish/subscribe) or explicit async interfaces.
2. No polling: a component must not watch another component's state on a timer (timers serve
   their own duty only, e.g. heartbeat).
3. No shared mutable state: state changes that cross a module boundary must be announced as events.
4. Long work streams: anything long-running (LLM stream, tool run, subagent) reports progress as
   an event sequence; no blocking whole-result APIs.
5. Backpressure is explicit: a slow consumer never silently blocks a producer — buffer/overflow
   policy is declared at the boundary.

### E2E verification: log-based assertions, no screenshots

CI end-to-end tests assert on **structured logs, never screenshots** (screenshots are a local
interactive-debugging aid only). The contract, per scenario:

- every E2E scenario carries a unique `scenario-id`;
- the runtime emits one structured log entry per expected event —
  `scenario=<id> event=<name> …` — through the unified logger (which the
  `logging` gate already enforces);
- the assertion is a **one-to-one expected ↔ logged match**: nothing missing,
  nothing extra, order as declared by the scenario;
- a failure report lists exactly the unmatched entries — that list *is* the
  diagnosis.

This keeps CI headless by construction and makes the verification surface the
same one the `logging` gate governs: the log stream.

## 4. Capability Layers

| Layer | Form | Content |
| --- | --- | --- |
| Privileged layer | Host itself, never pluggable | entitlements, bookmarks, Keychain, notification permissions — bound to the App signing identity |
| Capability gateway | Host-fixed | narrow primitive table (fsRead / fsWrite / httpFetch / notify / presentApproval / presentPicker / keychain…), each primitive with a typed signature + permission flag + audit; no god-interfaces |
| System implementation plugins | Plugin form (JS) | compose primitives into upstream contracts: `dsh-fs-ios` implements `ctx.fs`, `dsh-subprocess-quickjs` implements `ctx.subprocess`, `dsh-credentials-ios` maps to Keychain |

The gateway primitive contract is the **shared foundation of four platforms** (iOS / Android / HarmonyOS / desktop interop), versioned, frozen at the contract freeze.

## 5. Plugin System

- **Contract**: aligned with Fabric RFC 0001 — static manifest (JSON Schema), versioned capabilities, required/optional negotiation, deterministic lifecycle hooks.
- **Isolation**: one QuickJS runtime per plugin, zero sharing; all system access goes through the gateway. This makes dsh-mobile the first host in the ecosystem with *technically enforced* permissions (per the Fabric security section: only hosts with isolated execution + controlled module loading + managed IPC may claim enforcement).
- **Install = data operation**: tgz → `cache/blobs/<sha256>` (content-addressed) → verify → atomic unpack to `plugins/<pkg>@<semver>/` → write receipt (mirroring upstream `desktopPnpm.installPlugin` recovery-receipt transaction semantics).
- **Open security questions** (designed during the first on-device session): network egress control (preventing plugins from exfiltrating session data) and the trust level of UI plugins (they go through the capability model too).

## 6. UI Architecture

**Zero hardcoded UI in the host** — which Web Client is active is configuration; the official frontend is merely the default plugin.

Three fit channels:

1. **Session UI**: WKWebView loads `http://127.0.0.1:<port>`; Swift implements the carrier (static file serving + WS→QuickJS message-bus pump). The official React frontend is reused with zero changes (it only knows the HTTP/WS protocol, not the host). WKWebView runs in an Apple-privileged process where JIT is legal.
2. **Platform UI capabilities**: `ctx.ui.*` services → native Swift surfaces (approval dialogs, file pickers, share, notifications), async callbacks into the runtime. Approval doubles as a checkpoint boundary: background pending-approval → local notification → foreground resume.
3. **State contract**: UI-is-stateless — the renderer is a pure view; sessions persist host-side. The UI can die and reload at any time.

**Three plugin levels for the UI** (first-class upstream mechanisms; the desktop shell is the living proof):

| Level | Mechanism | Example |
| --- | --- | --- |
| Config | `cordis.patch.yml` layered overrides (base → host face → profile → overlay) | mobile defaults / trims |
| Component | `dsh-client-ui-slots` slot registration (typed, zero runtime deps) | bottom toolbar, approval cards |
| Whole | a plugin providing a complete Web Client | mobile-ui replacing the official UI |

Thread rules: JS lives on the runtime serial thread only; Swift↔JS is non-blocking in both directions; every callback dispatches onto the runtime queue.

## 7. Storage (code as data)

```
<container>/dsh/
├── profiles/<name>/              # self-contained data unit, migratable/syncable as a whole
│   ├── profile.json
│   ├── cordis.patch.yml          # this host's patch layer
│   ├── plugins/<pkg>@<semver>/   # manifest.json + integrity.json + bundle/ + web/
│   ├── sessions/*.jsonl          # sessions = pure data (upstream-isomorphic)
│   └── state/                    # settings / credential references / checkpoints
└── cache/blobs/<sha256>          # downloaded tgzs and QuickJS bytecode (content-addressed)
```

Backup tiers: `cache/` → Caches (regenerable); `profiles/` → Documents (backed up); external workspaces → security-scoped bookmarks. A shared checkpoint format across hosts ⇒ cross-device roaming (desktop ↔ Android runs-to-completion ↔ iOS resumption).

## 8. Multi-Platform Strategy

| | iOS (v1) | Android (the Android host) | HarmonyOS NEXT (the HarmonyOS host) |
| --- | --- | --- | --- |
| Engine | quickjs-ng | quickjs-ng (v2 optional nodejs-mobile high-fidelity mode) | quickjs-ng (NAPI) |
| Subprocess | ❌ coroutine re-implementation | ✅ Termux pattern (jniLibs) | ⚠️ designed as ❌ |
| Linux userland (`ishRun`, D16) | ✅ in-process emulated userland (iSH-arm64, vendored) | ❌ unavailable → WASM shell | ❌ unavailable → WASM shell |
| Background | suspension + checkpoint | foreground service | category-gated long tasks |
| Native shell | SwiftUI | Compose | ArkUI |

Reuse: `contract/` + `runtime/` + the `system-plugins/` semantic layer + `presentation/` are all platform-independent JS (the bulk of the code — one copy, three platforms); each platform adds only its privileged layer + primitive bindings (a few hundred lines) + native shell. All platform differences are expressed via capability negotiation; `hostType` branching is banned (RFC 0002 anti-pattern).

## 9. Repository Layout

Periphery ring around the project (D17): the outermost level carries the
project-adjacent surfaces — `build/` (the one build facade,
[BUILD.md](../BUILD.md)), `test/` (the log-verified e2e checker + scenarios +
runners), `docs/`, `packages/` (release packaging), `tools/` (govrail
checkers). Inside is the project itself — the shared core in ONE copy (the DSH
method, D9/D6) plus the three platform hosts:

```
dsh-mobile/
├── build/               # the build facade: build|test|check|sync × platform(s) — see BUILD.md
├── test/                # e2e checker (check.mjs), scenario manifests, per-platform runners
├── docs/                # architecture, decision records
├── packages/            # release packaging (version bump, tag guards)
├── tools/               # govrail gate checkers (governance tooling)
├── contract/            # the contract freeze: primitive contract + data protocols (bundle/manifest/receipt) — frozen first
├── runtime/             # quickjs-ng integration + ESM loader + shims (platform-independent, canonical closure)
├── system-plugins/      # system implementation plugins · contract adaptation (JS, shared across platforms)
├── presentation/        # mobile-ui Web Client (shared across platforms)
└── hosts/
    ├── ios/             # Swift privileged layer + gateway + carrier + SwiftUI shell
    ├── android/         # (the Android host)
    └── harmony/         # (the HarmonyOS host)
```

Each host embeds a **committed copy** of the canonical `runtime/spike` closure;
the `closures` gate byte-verifies every copy against the canonical source
(the copies are deliberate — self-contained APK/HAP — and the gate keeps them
honest; re-stage with `build/build.sh sync <platform>`).

## 10. Milestones

- **The contract freeze**: primitive contract v0 (≤10 primitives) + bundle layout + manifest schema + receipt format.
- **The runtime and host spikes**: A) quickjs-ng shim running upstream pure-logic packages (util-crypto / session-persistence); B) iOS host skeleton (QuickJS thread + carrier + WKWebView official UI lit up).
- **The first on-device session**: DONE — system implementation plugins (`dsh-fs` / `dsh-subprocess-quickjs` / `dsh-ui`), the `session.mock-llm` mock-LLM session end-to-end (CLI + on-device), the first Web Client mount rendering the live session, and the REAL LLM streaming session: `llm.live-stream` streams one OpenAI-compatible chat completion over the gateway `httpFetch` (scripted-SSE leg on the CLI, 19/19 — `runtime/spike/artifacts/macos-cli-m2-llm/`; real z.ai backend legs on the iOS simulator and the Android emulator with served-model logging and the key-leak audit asserted — `hosts/ios/artifacts/m2-llm/`, `hosts/android/artifacts/m2-llm/`).
- **The plugin system**: DONE — the install pipeline is verified as a receipt transaction (`install.verified-tarball` 22/22 on the macOS CLI: content-addressed blob → trust-record verify → strict manifest validation → staged integrity read-back → receipt commit; a tampered package is rejected before unpack), the FETCH-based installer runs the streaming httpFetch body through the same pipeline with pending-receipt startup replay ON DEVICE (`install.from-http` 46/46 + carrier evidence `install.carrier-evidence` 11/11 — `hosts/ios/artifacts/m3-complete/`; CLI leg `install.full-cycle` 41/41), install-time capability negotiation rejects under-privileged packages before unpack, and all three UI-plugin levels are verified on device (config-selected Web Client swap `ui.client-swap` 7/7 + the plugin toolbar slot registered, rendered and acked live — `hosts/ios/artifacts/m3-pluginization/`).
- **The Android and HarmonyOS hosts**: both DONE — each isomorphic host runs the headless regression trio (`boot.verification` 7/7, `gateway.bridge-smoke` 6/6, `session.mock-llm` 23/23) AND the event-driven binding phase in one launch. The Android host: loopback carrier + WebView mount + real nine-primitive binding (Keystore-sealed keychain, SAF directory picker + fsScope persist/resolve, notification + `notify.response`, `app.state` edges) — `android.capability-binding` 35/35 (evidence `hosts/android/artifacts/m4-complete/`); the Android httpFetch binding also drives the real-LLM session (`llm.live-stream` device leg, evidence `hosts/android/artifacts/m2-llm/`). The HarmonyOS host: **DONE, all nine primitives**: the isomorphic HarmonyOS host runs the regression trio (`boot.verification` 7/7, `gateway.bridge-smoke` 6/6, `session.mock-llm` 23/23) headlessly AND the event-driven binding phase in one launch — the loopback carrier (HTTP static serving of the Web Client + RFC 6455 WS pump via the shared bus seam) mounts the Web Client in ArkWeb with token deltas streaming live, the RuntimeDescriptor is 9 available / 0 unavailable and every primitive is proven on-device: notify + notification-tap `notify.response`, presentApproval dialog, fsScope, HUKS-sealed keychain (AES-256-GCM set/get/delete roundtrip), presentPicker over DocumentViewPicker (dismissal → null; grant → user scope with fsScope persist/resolve and content-matching read-back), and streaming httpFetch against the host's own loopback carrier (headers-settle then chunked body events; mid-body abort → `cancelled`) — `harmony.capability-binding` 27/27 by one-to-one log-compare (evidence `hosts/harmony/artifacts/m5-host/` and `hosts/harmony/artifacts/m5-primitives/`). The `llm.live-stream` real-LLM leg is WIRED on this host as well (launch-selected by `aa start … --ps dsh.e2e.leg llm.live-stream`, the leg running alone so the default chain spends no serve quota; the canonical `runtime/spike/scenario/llm-live-stream.js` over the same httpFetch binding; a platform-forced credential handshake — the sandbox refuses shell-side creation and this SDK's chmod is a silent no-op, so the runtime writes the 0666 placeholder, the runner overwrites it, and the app imports, reports the seal honestly and removes it when the leg ends). Its transport round trip is proven end-to-end on the emulator (the request leaves the device through this host's httpFetch and the backend answers — honest HTTP 429 code 1310, the account's exhausted coding-plan quota, reset 2026-09-22 14:43:53), so a SERVED turn is not claimed here: the served-turn records land with the quota reset by re-running `hosts/harmony/ci/run-llm-live-stream.sh` (evidence `hosts/harmony/artifacts/m5-m2-llm/`).
- **D9 upstream port**: DONE as a correction ([D9](decisions.md)) — the first in-house Harness reimplementation was replaced by the upstream DSH runtime running VERBATIM on quickjs: 26 packages pinned and sha256-verified by `runtime/spike/vendor/ensure-dsh.sh` (21 upstream DSH packages at 0.1.6-alpha.2 + 5 pinned npm deps), zero vendored edits, in-house code reduced to glue. What runs verbatim: the cordis host composition in the mobile profile boot (`runtime/spike/upstream/boot.js`, the same layer order as desktop's profile boot), the vendored dsh-llm `LlmRuntime` over the gateway `httpFetch` transport seam (`upstream.session` 31/31 on the CLI), the official client-modules web boot over the carrier's `ctx.webServer` contract with the official dist vendored, the official app shell — the 58-package application tier — mounted by the real upstream UI renderer, real `session.list`/journal, and the composer write path. The measured shim surface is far smaller than §3's 285-package static prediction: the product closure imports only what [runtime/spike/upstream/README.md](../runtime/spike/upstream/README.md) tables (9 `node:` builtins shimmed + web-shims; timers/Buffer/fetch deliberately absent and loud). Device evidence (one-to-one log-compare, consolidated in [docs/e2e-matrix.md](e2e-matrix.md)): official boot + session + write on iOS (`officialweb.mount` 14/14, `session.live-read` 46/46, `composer.live-write` 43/43), Android (`android.officialweb.mount` 14/14, `android.session.live-read` 46/46), HarmonyOS (`harmony.officialweb.mount` 17/17, `harmony.session.live-read` 43/43, `harmony.composer.live-write` 33/33).

## 11. Key Technical Decisions

The authoritative decision log lives in [docs/decisions.md](decisions.md) (D0–D9), gated by
`gov verify-decisions`: quickjs-ng over nodejs-mobile (D1), coroutines over subprocesses (D2),
UI as Web Client plugin (D3), out-of-App-Store distribution (D4), contract first (D5), pinned
upstream (D6), checkpoint as roaming (D7), all modules event-driven (D8), upstream packages
ported verbatim — never reimplemented in-house (D9). Each entry there
records the alternative it beat — read it before proposing a change to any of these.

## 12. Known Boundaries (honest statement)

The following are **declared unsupported** on this host (flagged via capability negotiation, never faked): the real-subprocess ecosystem (bash/git hooks/playwright/python PTC/SSH/Windows ACL), desktop-grade background residency (the ceiling is checkpoint/resume + notification wake), whole-disk file access (the ceiling is user-granted security-scoped directories).

The **emulated Linux userland** (contract v1.3.0 `ishRun`, D16) is the one place where a real
userland *is* supported, and it carries its own honest statement rather than hiding behind
"unsupported":

- **What it is.** A userspace AArch64 interpreter (iSH-arm64, vendored verbatim) emulates both
  the guest's instructions and its syscalls *inside the app process*. A real Alpine userland
  therefore runs with no child process and no second OS — this is why iOS can have `sh`, `apk`,
  `pip`, `npm` and a compiler at all (D2). The guest's tasks get their own host threads; the JS
  runtime's serial-queue rule (§6) is unchanged, and the gateway dispatches as it always does.
- **It is not free.** Measured on this machine against native: compute **11–34×** slower,
  jitless Node **40–108×**; a guest kernel boot is **41–79 ms** in-app, a desktop-CLI invocation
  pays ~1 s fixed before the workload. jitless Node has **no WebAssembly**, so anything on
  undici (fetch, MCP clients) needs the engine vendor's pure-JS llhttp/fetch polyfills.
- **The audit boundary moves, and that is stated, not papered over.** The guest's sockets are
  host BSD sockets (`fs/sock.c`) and its paths are host paths (`fs/real.c`), so the per-call
  permission flags and the mandatory audit records of the primitive contract do **not** reach
  inside it: a program in the guest reaches the network and the filesystem with no per-call
  record anywhere. The controls that remain are the approval policy and the userland the host
  chose to stage — policy, not enforcement. Contract §7 point 2 requires a host to say this in
  its descriptor, and this section is that statement for this host.
- **Lifecycle.** The staged userland is *data* and survives relaunch; a running guest process
  does not. Suspension freezes it and memory pressure takes it with the process (D7's checkpoint
  carries sessions, never a live userland), so background work inside the guest is not a thing to
  build on.
- **iOS only, by negotiation.** The Android and HarmonyOS hosts answer `ishRun` unavailable and
  keep the WebAssembly shell; there is no `hostType` branch anywhere — the descriptor is the
  difference.

## 13. Upstream Evidence Index

- `docs/architecture.md`: thin Electron host, carrier topology, "the desktop shell itself is an ordinary plugin with no privileges"
- `docs/plugin-development.md`: two plugin tiers, the `ctx.get('desktopProfiles')` capability-probe fallback pattern
- `vendor/dsh-runtime/0.1.6-alpha.1`: unpacked statistics over 285 packages (source of §3 shim-surface numbers)
- `@deepseek-ai/dsh-subprocess` README: "Subclass, implement spawn, and load the subclass as a plugin"
- `dsh-community-fabric/docs/rfcs/`: manifest/capability negotiation (RFC 0001), the Runtime/Presentation many-to-many model (RFC 0002)
- `agents-anywhere/dsh-bridge-next`: the official phone story is cloud-relayed, with "iOS download entry not yet available"
