# Upstream DSH anatomy — packages, execution flow, and the dsh-mobile integration map (2026-09-23)

English | [简体中文](upstream-dsh-anatomy.zh.md)

This document organizes what the upstream **deepseek-harness** (DSH) monorepo
contains, how one agent conversation flows through it, and where dsh-mobile
plugs into it. Sources: the upstream clone at `tmp/deepseek-harness`
(tag `dsh-v0.1.7-alpha.2`, merge `00102833d`) and our vendored pin
`0.1.6-alpha.2` (`runtime/spike/vendor/`). It complements
[upstream-capability-mounting.md](upstream-capability-mounting.md) (the sibling
-project capability patterns and adoption decisions) and
[`runtime/spike/upstream/README.md`](../../runtime/spike/upstream/README.md)
(the shim table); neither of those walks the upstream flow itself, which is
this file's job.

## 1. The monorepo at a glance

**307 packages under `packages/` in 54 groups, 4 apps, 9 vendored framework
packages, one native system package.** All product packages are scoped
`@deepseek-ai/dsh-*`. The layering signal that matters to a host port: the
tree builds in two faces — `host` and `client`, selected by
`DSH_BUILD_FACE` (`tsdown.config.ts`) — because the two faces merge cordis
`Context` under the same keys with *different* services and one TypeScript
program cannot see both (`tsconfig.host.json` / `tsconfig.client.json`).

The taxonomy rule the whole tree follows (from `packages/README.md`, and the
one dsh-mobile inherits verbatim): **extension plugins depend on Service
Definitions, never concrete providers.**

| Group | Pkgs | What it is |
| --- | --- | --- |
| `core/` | 8 | The Brain: agent, agent-loop, session, system-prompt, tools, scope, agent-default-model, agent-tool-presentation |
| `llm/` | 7 | LlmRuntime + provider adapters + retry + token meter |
| `session/` | 22 | Event-sourced session: persistence, formats v0–v4, projections, titles, telemetry |
| `fs/` | 7 | fs seam + local/sandbox backends + file tools (read/write/edit/search) |
| `shell/` | 11 | bash/pwsh executors + shell tools (one-shot and persistent PTY) |
| `subprocess/` | 3 | The spawn seam (`ctx.subprocess`) + local implementation |
| `sandbox/` | 4 | Per-call confinement contract + OS backends (bwrap/Landlock/Seatbelt/ACL) |
| `api/` | 9 | Remote controllers (session/job/terminal/workspace/settings/account) + typert gateway |
| `client/` | 60 | The whole browser tier: connection, module system, store, ~45 `ui-*` plugins |
| `boot/` | 5 | app-boot, cmdline, config-editor, hmr, plugin-manager |
| `bundle/` | 6 | Profile layers: base, web-app, headless, sdk-app, sdk-minimal, acp-app |
| `preset/` | 3 | agent-preset declarations + registry + persona |
| `host/` | 9 | webserver, frontend-static, directory pickers, telemetry, plugin inventory |
| `web/` | 6 | web search/fetch seam + providers + web tools |
| `extensions/` | 4 | cordis-host-runner / cordis-client-runner (dual-half plugins) + tool/ui rows |
| `subagent/` | 11 | Child-agent delegation: in-process, fork, ACP, SDK, Claude Code, Codex |
| `context/` | 6 | AGENTS.md instructions, @file/@session references, time/tmux context |
| `compaction/` | 5 | Token-budget compaction policies + slash command |
| `jobs/` `todo/` `goal/` `plan/` `workflow/` | 3+1+4+1+4 | Background jobs, todo tool, goals, plan mode, JS orchestration |
| `interaction/` | 4 | user-approval, user-questions, ask_user tool, permission presets |
| `credentials/` | 5 | Credential seam + local provider + DeepSeek account/auth |
| `settings/` `storage/` `spill/` | 1+4+3 | Settings seam; JSON/SQLite KV; oversized-output spill |
| `terminal/` `ssh/` `lsp/` `mcp/` | 3+4+3+2 | PTY tools; SSH trios (fs/subprocess/sandbox); language servers; MCP |
| `acp/` `sdk/` `typert/` | 1+3+4 | ACP server; TS/Python SDK (JSON-RPC); RPC reflection/generation |
| `experimental/` `test-support/` `runtime-diagnostics/` | 20+7+1 | Agent teams, browser/computer use, speech; test vehicles; invariants |
| `util/` | 17 | Browser-safe shared primitives (shared face, zero-dep by design) |

Apps: `apps/cli` (the `dsh` binary), `apps/desktop` (Electron shell) +
`apps/desktop-host` (the private Node host process behind it), `apps/web`
(Vite frontend). `vendor/` holds the cordis framework layer
(cordis 4.0.0-rc.7, loader, include, group, timer, hmr, logger-console,
schemastery, cosmokit) rescoped to `@deepseek-ai/*` with a 22-entry
local-modification log — the framework is owned, auditable, pinned.
`native/system` ships prebuilt `landlock-run` + POSIX flock bindings.

The upstream docs most worth reading, in dependency order:
`docs/cordis-primer.md` → `docs/capability-seams.md` →
`docs/architecture.md` → `docs/agent-lifecycle.md` →
`docs/tool-execution-pipeline.md` → `docs/api-gateway.md`.

## 2. The execution flow

### 2.1 Launch — profile boot

There is **no in-process plugin-mounting API**; every application launches
through named profiles (`dsh --profile <name>`), and extension is "a profile
plus ordered patch files" (`scripts/verify-application-entrypoints.ts` rejects
bypasses). The flow (`apps/cli/src/bin.ts` → `apps/cli/src/profile-boot.ts` →
`packages/boot/app-boot/src/index.ts`):

1. Resolve the profile (`$DSH_HOME/profiles/<name>`, whose `dsh.profile`
   lists bundles) and stack its patch layers: each bundle's
   `cordis.patch.yml` in declared order → the profile's own patch → the
   home-level patch → `--patch` CLI overlays.
2. The root `cordis.yml` is always the **empty list** — the whole plugin tree
   is composed as patches over it (rewritten every boot, because the Loader's
   write-back can bake rows in).
3. `boot()` creates the cordis `Context`, mounts the vendored cordis
   **Loader** + `cordis:include` + `cordis:group`, mounts the tree, and waits
   for settlement.
4. `auditStartupEntries()` fails loud if required entries (`agent-loop`,
   `webserver`, `modules`, `connection`, …) did not mount.

A patch row is a YAML object with an `id` and a `config`; `!!js` expression
nodes interpolate `ctx.<service>`, `process.env`, `dshHomePath` at mount
time. `dsh-base` (`packages/bundle/base/cordis.patch.yml`, ~90 rows) is the
shared first layer of every profile but `sdk-minimal`.

### 2.2 The context model — cordis and the service seams

Cordis (`docs/cordis-primer.md`) is the plugin meta-framework: a plugin is
`{ inject?, apply(ctx) }` or a `Service` subclass; a context is a service
repository (`ctx.<key>`); `inject` declares dependencies so load order is
service-availability driven, not boot-sequenced; events are typed with five
dispatch modes (emit / waterfall / parallel / serial / bail); every
registration is a reversible effect. The **Service Definition / Provider /
Consumer** trio is the capability vocabulary: an abstract `Service` subclass
declares `ctx.<key>`, a provider plugin implements it, consumers `inject` it.

The services that carry a conversation, and their desktop providers:

| `ctx.*` | Definition | Desktop provider |
| --- | --- | --- |
| `llm` | `packages/llm/llm` (`LlmRuntime`) | itself + `llm-deepseek` adapter |
| `sessions` | `packages/core/session` (`SessionStore`) | itself |
| `sessionPersistence` | `packages/session/session-persistence` | `session-persistence-jsonl` |
| `sessionProjections` | `packages/session/session-projection` | itself |
| `agents` | `packages/core/agent` (`AgentRegistry`) | itself |
| `agentLoop` | `packages/core/agent-loop` (`AgentLoop`) | itself |
| `tools` | `packages/core/tools` (`ToolRuntime`) | itself |
| `systemPrompt` | `packages/core/system-prompt` | itself |
| `fs` | `packages/fs/fs` (abstract `FileSystem`) | `fs-sandbox` over `fs-local` |
| `subprocess` | `packages/subprocess/subprocess` | `subprocess-local` |
| `shell` | `packages/shell/shell` (`ShellExecutor`) | `bash-sandbox` / `pwsh-sandbox` |
| `sandbox` | `packages/sandbox/sandbox` (`SandboxProvider.confine`) | `sandbox-local` (or `sandbox-windows-acl`) |
| `web` | `packages/web/web` (search/fetch registries) | `web-search-deepseek` + `web-fetch-http` |
| `webServer` | `packages/host/webserver` | itself (web profile) |
| `settings` | `packages/settings/settings` | settings backends |
| `agentPresets` | `packages/preset/agent-preset-registry` | itself (web profile) |
| `sessionController` etc. | `packages/api/*` | Remote controllers (web profile) |

### 2.3 One turn, end to end

The unit of state is the **Session** (`packages/core/session/src/index.ts`):
an append-only array of frozen `SessionEvent`s (`seq` = index, contiguity
contract), an ordered surface over message-producing events, and folds
(`requestHeader()`, `deriveMessages()`) that project LLM history from the
log. **Model-visible means logged** — there is no side state.

The driver is `ReactLoopAgent` (`packages/core/agent-loop/src/agent.ts`):

1. **Input** — `Agent.send/followup/steer` lands in the `ReactLoopInbox`
   (`inbox.ts`), a durable projection-backed inbox (next-turn vs next-step
   queues).
2. **Turn** — `turn()` appends `turn/start`, then loops steps.
3. **Pre-step** — `preStep()` claims inbox input, assembles the system prompt
   (`ctx.systemPrompt.assemble`), projects runtime context, and runs the
   `agent/pre-step` waterfall (which may rewrite messages or reject).
4. **Request** — `prepareRequest()` seeds config from agent options and the
   persisted header, runs the `agent/request` waterfall, and
   `ctx.llm.prepareCall()` binds the adapter. The prompt is committed as
   `system/message` events; claimed user input as `user/message`. Then
   `buildRequest()` logs `request/header` + `request/context` and freezes
   `session.deriveMessages()` into immutable `GenerateOptions` — the request
   is a pure function of the log.
5. **Stream** — `AssistantStreamAttempt` wraps
   `preparedCall.stream(request)`: each `StreamChunk` folds into a block
   assembler and re-emits as a live `agent/assistant-stream` frame; on
   success one `assistant/message` event commits the exact stream; a failed
   attempt commits `assistant/attempt` (not model-visible), and the
   `agent/request-error` waterfall decides retries.
6. **Tool calls** — `message.content` tool-call blocks go to
   `executeToolCalls()` (`tool-calls.ts`): grouped by the tool's execution
   mode (exclusive barrier vs bounded parallel pool,
   `maxParallelToolCalls`), each logs a `tool/call` event, runs through the
   `ToolRuntime` scheduler (`prepare → dispatch → finalize`), and commits
   model-ordered `tool/result` events linked back by `sourceEventSeqs`.
7. **Loop** — tool results feed the next step; no tool calls ends the turn
   (`completed`); abort produces synthetic results for skipped calls and
   `turn/end {kind:'aborted'}`; errors produce `turn/end {kind:'error'}`.

Tools are declarative rows in the `ToolRuntime` registry
(`name/description/parameters/output {schema, render}/execute`), with scoped
layers shadowing globals (`dsh-scope`), per-agent masks, and a pipeline of
`tools/pre-execute` (the approval gate) / `tools/execute` /
`tools/post-execute` events (`docs/tool-execution-pipeline.md`).

### 2.4 The LLM layer

`LlmRuntime` (`packages/llm/llm/src/index.ts`) is a provider-keyed adapter
registry. The contract is small and Node-free: an adapter implements
`stream(options: GenerateOptions): AsyncIterable<StreamChunk>`, plus
`prepareCall()` returning a generation-bound call so capabilities and
endpoint cannot mix mid-flight. `StreamChunk` is the wire-neutral streaming
protocol: `block-start` / `text-delta` / `reasoning-delta` /
`tool-call-delta` / `block-end` / `usage` / `finish`. Everything is wrapped
in the `llm/stream` waterfall; adapter throws normalize into terminal
`finish` chunks.

**Wire drift alert (see §4)**: the official `DeepSeekAdapter`
(`packages/llm/llm-deepseek/src/adapter.ts`) at 0.1.7 speaks an
**Anthropic-Messages-shaped** protocol — `POST {baseURL}/messages`,
`anthropic-version: 2023-06-01`, SSE — while our pin's era (and our
`llm-transport.js`, and the 0.1.6 mock server) spoke OpenAI-style
`/chat/completions`.

### 2.5 Events — durable log vs live stream, and projections

Two distinct mechanisms:

- **Durable session events** (`turn/*`, `step/*`, `system|user|assistant/
  message`, `tool/call`, `tool/result`, `request/*`) — appended to the log,
  broadcast as `session/event`. These are the persistence and replay unit.
- **Live agent events** (`agent/*`) — process-local; token-level
  incrementality exists only as `agent/assistant-stream` frames.

**session-projection** (`packages/session/session-projection`) lets domain
plugins register pure `ProjectionDefinition { key, init, apply }` units that
fold every committed event; readers get consistent snapshots. The loop
registers `turnBoundary` and `inbox`; others: `sessionStats`, `turnOutline`,
`agentPreset`.

### 2.6 How clients observe

`remotes → gateway → connection → webserver` (`docs/api-gateway.md`). The
`webServer` service serves the built frontend; RPC is **typert** —
build-time-generated Host/Client contracts over `@Remote`-decorated methods.
Unary calls are `POST /api/<namespace>/<method>`; streaming Remotes
multiplex over the `/api/remote.mux` WebSocket. The `SessionController`
exposes `create/prompt/cancel/page/projections/…` plus the two streams that
drive a UI: `follow` (snapshot then gap-free events + assistant-stream
frames) and `control`. The browser side builds its module table from
`window.__DSH_BOOT__` (`packages/client/modules`) before cordis exists.

### 2.7 The execution world

One seam family carries all OS reach, each with a per-call policy and honest
capability facts: `SandboxProvider.confine(argv, policy)` wraps argv
(read-only / workspace-write / danger-full-access, fails closed); shell
executors wrap argv through `confine` before spawning via `ctx.subprocess`;
`FileSystem.sandboxMode` (and `ShellExecutor.sandboxMode`) are honest getters
so the tool layer can advertise escalation. Approval is its own seam
(`tools/pre-execute` + `user-approval`).

### 2.8 Presets

`AgentPresetRegistry` (`packages/preset/agent-preset-registry`): a preset is
a YAML-declared plugin entry list mounted into a dedicated scope per
activation — persona rows, tool rows, prompt sections — so per-session
composition never edits the host plane. Sessions bind their preset durably
via the header; on web, model-facing tools move behind presets.

### 2.9 What a host must provide (the embedding facts)

For any port, the load-bearing properties: the loop's request is a pure
function of the session log; streaming is a plain `AsyncIterable` with no
Node types on the contract; **all I/O reaches the OS only through the
fs/subprocess/shell/sandbox/llm-adapter provider seams**; and composition
happens by mounting providers onto a context — the desktop host itself is
"just another profile" (`desktop-host` runs the web profile with extra
capabilities).

## 3. How dsh-mobile mounts it

### 3.1 The rule

D9 + D6: product-carrying upstream packages are vendored **verbatim**
(pinned tarball + sha256, `runtime/spike/vendor/ensure-dsh.sh`), driven
through adapter plugins; in-house code is glue only. Platform differences
live **below** the upstream contracts — never `hostType` branches above them.

### 3.2 The vendored closure

29 `dsh-*` packages + 9 npm packages at `0.1.6-alpha.2` / pinned versions:
the spine (`session`, `agent`, `agent-loop`, `tools`, `system-prompt`,
`session-projection`, `llm`, `settings`, `scope`, `sandbox`, …), the file
tools (`fs-local`, `tool-fs`, `tool-str-replace-editor`), the shell-family
substrate, `agent-presets`, and the test vehicles (`llm-mock-server`).
**Deliberately out**: provider adapters (`llm-deepseek`/`llm-pi-ai` — the
gateway transport replaces them), `session-persistence-jsonl` (koffi),
`subagent`, `tool-fs-search` (ripgrep binary), `base` (the patch bundle —
replaced by the in-memory composition below).

### 3.3 The mobile profile boot

`runtime/spike/upstream/boot.js` — `bootUpstream(options)` reproduces the
desktop entry shape with an empty root and in-memory layer composition (no
disk Loader; the host module loader maps specifiers into the vendor
closure). Mount order:

1. `web-shims.js` (Web-API globals) → pin the profile container
   (`$DSH_HOME`/cwd/tmpdir collapse into the host-granted container).
2. `new Context()` + cordis logger wired to the unified sink.
3. **`llm` first**: the vendored `LlmRuntime` with the gateway transport
   adapter (`upstream/llm-transport.js`) registered for the caller's
   provider route — the desktop's `llm` service over `httpFetch`.
4. The dsh-base spine: `SessionStore` → `AgentRegistry` → `SystemPrompt` →
   `ToolRuntime` → `SessionProjectionRegistry` → `SettingsMemory` (the one
   in-house row) → tool rows (`tool-todo`, `shell-wasm`, `shell-ish`) → the
   file-tools row (vendored `fs-local` + `tool-fs` +
   `tool-str-replace-editor` over the in-memory workspace VFS) →
   `AgentLoop` (one configured agent).
5. The preset plane: the real cordis `Loader` + `AgentPresets` over the
   staged presets VFS (also serving the web-boot composition).
6. `demandServices` fails loud on any missing spine service; the boot
   emits `upstream/profile`, `llm/runtime`, `upstream/services` records.

### 3.4 The seam table — upstream service → our provider → gateway primitives

| Upstream contract | Desktop provider | dsh-mobile provider | Rides |
| --- | --- | --- | --- |
| `llm` adapter (`stream`) | `llm-deepseek` (direct fetch) | `upstream/llm-transport.js` | `httpFetch` |
| `fs` Service | `fs-sandbox` on disk | today: vendored `fs-local` over the in-memory workspace VFS (`shims/fs.js`); disk route: `system-plugins/dsh-fs` | `fsRead/fsWrite/fsScope` (+v1.1 ops) |
| `subprocess` Service | `subprocess-local` (OS processes) | `system-plugins/dsh-subprocess-quickjs` — in-process coroutine executor | none (pure runtime) |
| `ui` (notify/approval/picker) | Electron dialogs | `system-plugins/dsh-ui` | `notify`, `presentApproval`, `presentPicker` |
| `shell` executor family | `bash-sandbox`/`pwsh-sandbox` | `system-plugins/dsh-shell-wasm` (wasm programs), `system-plugins/dsh-shell-ish` (Alpine userland) | `wasmRun` / `ishRun` + fs primitives |
| `webServer` + client tier | Node webserver + browser | carrier loopback (HTTP+WS) + `web-boot.js` composing the official client modules | carrier seam (docs/webserver-contract.md) |

Contract totals at v1.3.0: **16 primitives** (9 frozen at v1.0 + 5 fs
operations at v1.1 + `wasmRun` at v1.2 + `ishRun` at v1.3), with structured
`GatewayError` rejections and a flat audit stream.

### 3.5 The client tier

`upstream/web-boot.js` mounts the vendored `ClientModuleRegistry` over the
staged web-plugin VFS and hands the composed wire plus the `/api` + mux
journal surface to the carrier. `presentation/official-web` is the official
upstream web UI, vendored verbatim at `0.1.6-alpha.2` with PROVENANCE +
MANIFEST, plus the **58-package application tier** (api-gateway, connection,
`ui-*` plugins) materialized and manifest-verified. The live legs
(`composer-live-write` family) drive real `session/create` →
`session/prompt` → agent-loop turns rendered in the official DOM.

### 3.6 The hosts

Three platform hosts (`hosts/ios`, `hosts/android`, `hosts/harmony`) embed
committed copies of the canonical `runtime/spike` closure (byte-verified by
the `closures` gate) and provide: the serial runtime thread + module loader
(`dsh_spike_host.c`), the gateway bridge, platform primitives (SAF /
security-scoped-bookmark scopes, streaming httpFetch, keychain, notify),
and the carrier server. Platform differences surface only as capability
negotiation answers (e.g. `ishRun` available on iOS only).

### 3.7 How E2E pins it

The scenario families in `test/e2e/scenarios/` assert the whole chain by
structured logs: `upstream-session` (vendored spine + gateway LLM turn),
`upstream-web-boot` / `officialweb-mount` (+ android/harmony variants),
`session-live-read` / `composer-live-write` (official app with real data),
`llm-live-stream` (real streaming over `httpFetch`), `userland-shell-local`
(`ishRun`). One-to-one expected ↔ logged matching per `scenario-id`
(docs/ARCHITECTURE.md §3).

## 4. Drift watch — our pin (0.1.6-alpha.2) vs upstream 0.1.7-alpha.2

The capability-mounting study already names the preset wave
(`agent-preset-registry`, `config-editor`, account/job Remote controllers,
duplex `RemoteStream`s, registry-fallback plugin manager). The flow-level
additions to that list:

1. **The LLM wire switched after our pin.** Upstream commit `99e22ebbe`
   (2026-09-19, "make the official DeepSeek adapter Messages-only") moved
   the official adapter to an Anthropic-Messages protocol (`POST /messages`,
   `anthropic-version` header). Our `llm-transport.js` and the 0.1.6
   mock-server speak `/chat/completions`. **A re-pin must either port the
   transport to the Messages wire or pin the mock-server era with it** —
   this is the single largest code-side adaptation in the next re-pin.
2. **The startup audit hardened**: `auditStartupEntries()` now enforces
   required entry ids at boot — our `demandServices` is the same instinct
   and should mirror any id list changes.
3. **Preset-scoped tool rows on web**: upstream moved model-facing tools
   behind presets in the web bundle; our boot mounts them host-plane. Not
   urgent (our profile is single-agent), but a semantic drift to track.

A vendored refresh stays a planned, deliberate change (D6); this section is
the watch list so it is prepared, not surprised by.

## 5. Reading map

| To understand | Read |
| --- | --- |
| The plugin kernel | upstream `docs/cordis-primer.md`, `vendor/cordis` |
| The capability vocabulary | upstream `docs/capability-seams.md` |
| The launch model | upstream `apps/cli/src/profile-boot.ts`, `packages/boot/app-boot/src/index.ts` |
| The turn loop | upstream `packages/core/agent-loop/src/agent.ts`, `docs/agent-lifecycle.md` |
| Tool execution | upstream `packages/core/tools`, `docs/tool-execution-pipeline.md` |
| LLM contract | upstream `packages/llm/llm/src/types.ts` (`StreamChunk`, `GenerateOptions`) |
| The client wire | upstream `docs/api-gateway.md`, `packages/api/session-controller` |
| Our port | `runtime/spike/upstream/README.md`, `runtime/spike/upstream/boot.js`, `docs/ARCHITECTURE.md` §3–§5, §10 D9 |
| The capability patterns we adopted | [upstream-capability-mounting.md](upstream-capability-mounting.md) |
