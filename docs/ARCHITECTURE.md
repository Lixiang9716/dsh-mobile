# dsh-mobile Architecture

English | [简体中文](ARCHITECTURE.zh.md)

> Version: v0.1 (foundation) · Status: reviewed, entering M0
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
- **Shim surface** (measured across all 285 upstream packages): builtin-module import surface = path 67 / crypto 46 / fs 35 / os 20 / url 23 / util 11 / stream 7 / net 5 / http 4 packages; the crypto surface is only 6 APIs (randomUUID / createHash / randomBytes / timingSafeEqual / pbkdf2 / createHmac) → one Swift CommonCrypto file covers it; the 12 `child_process` packages all live in platform implementation packages and are simply not loaded in the QuickJS host; 4 `worker_threads` packages are single-point refactors.
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

The gateway primitive contract is the **shared foundation of four platforms** (iOS / Android / HarmonyOS / desktop interop), versioned, frozen at M0.

## 5. Plugin System

- **Contract**: aligned with Fabric RFC 0001 — static manifest (JSON Schema), versioned capabilities, required/optional negotiation, deterministic lifecycle hooks.
- **Isolation**: one QuickJS runtime per plugin, zero sharing; all system access goes through the gateway. This makes dsh-mobile the first host in the ecosystem with *technically enforced* permissions (per the Fabric security section: only hosts with isolated execution + controlled module loading + managed IPC may claim enforcement).
- **Install = data operation**: tgz → `cache/blobs/<sha256>` (content-addressed) → verify → atomic unpack to `plugins/<pkg>@<semver>/` → write receipt (mirroring upstream `desktopPnpm.installPlugin` recovery-receipt transaction semantics).
- **Open security questions** (designed at M2): network egress control (preventing plugins from exfiltrating session data) and the trust level of UI plugins (they go through the capability model too).

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

| | iOS (v1) | Android (M4) | HarmonyOS NEXT (M5) |
| --- | --- | --- | --- |
| Engine | quickjs-ng | quickjs-ng (v2 optional nodejs-mobile high-fidelity mode) | quickjs-ng (NAPI) |
| Subprocess | ❌ coroutine re-implementation | ✅ Termux pattern (jniLibs) | ⚠️ designed as ❌ |
| Background | suspension + checkpoint | foreground service | category-gated long tasks |
| Native shell | SwiftUI | Compose | ArkUI |

Reuse: `contract/` + `runtime/` + the `system-plugins/` semantic layer + `presentation/` are all platform-independent JS (the bulk of the code — one copy, three platforms); each platform adds only its privileged layer + primitive bindings (a few hundred lines) + native shell. All platform differences are expressed via capability negotiation; `hostType` branching is banned (RFC 0002 anti-pattern).

## 9. Repository Layout

```
dsh-mobile/
├── contract/            # M0: primitive contract + data protocols (bundle/manifest/receipt) — frozen first
├── runtime/             # quickjs-ng integration + ESM loader + shims (platform-independent)
├── system-plugins/      # system implementation plugins · contract adaptation (JS, shared across platforms)
├── presentation/        # mobile-ui Web Client (shared across platforms)
├── hosts/
│   ├── ios/             # Swift privileged layer + gateway + carrier + SwiftUI shell
│   ├── android/         # (M4)
│   └── harmony/         # (M5)
└── docs/                # architecture, decision records
```

## 10. Milestones

- **M0 contract freeze**: primitive contract v0 (≤10 primitives) + bundle layout + manifest schema + receipt format.
- **M1 dual spikes**: A) quickjs-ng shim running upstream pure-logic packages (util-crypto / session-persistence); B) iOS host skeleton (QuickJS thread + carrier + WKWebView official UI lit up).
- **M2 on-device session**: DONE — system implementation plugins (`dsh-fs` / `dsh-subprocess-quickjs` / `dsh-ui`), the `m2.session` mock-LLM session end-to-end (CLI + on-device), and the first Web Client mount rendering the live session; the real LLM API is still open.
- **M3 pluginization**: install pipeline (receipt transactions) + the three UI-plugin levels + capability negotiation.
- **M4/M5**: Android and HarmonyOS hosts. M4 in progress: the isomorphic host is verified — the gateway-bridge scenario (`m2.bridge.smoke`) and the `m1.spike.boot` regression pass on the emulator (evidence `hosts/android/artifacts/m4-host/`).

## 11. Key Technical Decisions

The authoritative decision log lives in [docs/decisions.md](decisions.md) (D0–D8), gated by
`gov verify-decisions`: quickjs-ng over nodejs-mobile (D1), coroutines over subprocesses (D2),
UI as Web Client plugin (D3), out-of-App-Store distribution (D4), contract first (D5), pinned
upstream (D6), checkpoint as roaming (D7), all modules event-driven (D8). Each entry there
records the alternative it beat — read it before proposing a change to any of these.

## 12. Known Boundaries (honest statement)

The following are **declared unsupported** on this host (flagged via capability negotiation, never faked): the real-subprocess ecosystem (bash/git hooks/playwright/python PTC/SSH/Windows ACL), desktop-grade background residency (the ceiling is checkpoint/resume + notification wake), whole-disk file access (the ceiling is user-granted security-scoped directories).

## 13. Upstream Evidence Index

- `docs/architecture.md`: thin Electron host, carrier topology, "the desktop shell itself is an ordinary plugin with no privileges"
- `docs/plugin-development.md`: two plugin tiers, the `ctx.get('desktopProfiles')` capability-probe fallback pattern
- `vendor/dsh-runtime/0.1.6-alpha.1`: unpacked statistics over 285 packages (source of §3 shim-surface numbers)
- `@deepseek-ai/dsh-subprocess` README: "Subclass, implement spawn, and load the subclass as a plugin"
- `dsh-community-fabric/docs/rfcs/`: manifest/capability negotiation (RFC 0001), the Runtime/Presentation many-to-many model (RFC 0002)
- `agents-anywhere/dsh-bridge-next`: the official phone story is cloud-relayed, with "iOS download entry not yet available"
