# Agent Note: the agent-flow E2E runs the upstream skill family over the vendored closure (prompt override + skill loading in one session)

Status: implemented

Date: 2026-09-23
Class: feature

## Problem

The owner ordered the agent-flow E2E on the iOS simulator: prove in ONE
session that (1) a system-prompt override reaches the LLM request (prompt
修改), (2) skills are discovered from a staged dir into the session catalog
and the `skill` tool returns their instructions (skills 载入), and (3) a full
mock-LLM turn flow runs over the vendored upstream agent spine. The upstream
SKILL family (`@deepseek-ai/dsh-skill`, `dsh-skill-filesystem`,
`dsh-tool-skill` @ 0.1.6-alpha.2) was not vendored: three new packages, two
new npm dependencies (`yaml`, `chokidar`), and two system-layer gaps (a
crypto digest, a file-watch surface) stood between the spine we already boot
and that proof.

## Decision

- Vendor the three skill packages verbatim (npm registry as the pin source,
  since upstream deleted the vendor dir): tgz sha256 pins in
  `runtime/spike/vendor/ensure-dsh.sh`, tarballs in the tracked mirror
  `dsh-tarballs/`. The npm-published builds are byte-identical to the
  submodule's local build of the same commit (verified before vendoring).
- `yaml@2.9.0` (upstream lockfile pin) is vendored verbatim and served
  behind the bare specifier through the established `npm-bridges.js`
  runtime-module seam, pointing at the package's `browser/` ESM face (the
  "node" face is CJS, which the loader cannot serve). No host-C change.
- `chokidar@5.0.0` stays OUT of the closure (the @vscode/ripgrep precedent:
  its engine is real OS fs events + awaitWriteFinish wall-clock timers, and
  the runtime has neither seam). `npm-bridges.js` registers a LOUD linkage
  shim whose `watch()` throws naming the gap; `boot.js` mounts
  skill-filesystem with `watch:false`, so the only code that reaches chokidar
  never runs. `shims/fs.js` gains `watchFile`/`unwatchFile` binding-only loud
  stubs for the same reason (named imports need bindings at link time).
- `shims/crypto.js` gains `createHash('sha256')` routed through the spike's
  own `sha256.js` (tool-skill's session-catalog digest needs it; one SHA-256
  implementation, no second hand-rolled copy).
- `upstream/boot.js` mounts the skill plane (SkillRegistry →
  skill-filesystem → tool-skill, before AgentLoop so the catalog's
  `agent/pre-step` listeners see every step) ONLY when the caller passes
  `options.skills`, and forwards an optional `options.systemPrompt.personaPrefix`
  into the vendored SystemPrompt's own config — both opt-in, so the existing
  spine legs boot byte-identically. `llm-transport.js` gains an optional
  `onRequestBody` hook (the prompt-override evidence: the caller asserts on
  the serialized wire request).
- The scenario (`scenario/agent-flow.js`, id `agent.flow`) + manifest
  (`test/e2e/scenarios/agent-flow.json`, 17 expected events, one-to-one in
  order) + runner (`test/e2e/run-ios-agent-flow.sh`, the parity runner's
  exact shape: host-side mock server, `-dsh-mode session -dsh-scenario
  agent-flow`, log-only verdict, screenshots as artifacts). The fixture
  skill is staged at runtime through the node:fs/promises shim into the
  workspace VFS — no host embedding needed for it.
- The android stager stages the same closure (skill trees gitignored like
  the rest of the spine, yaml tracked like diff, the scenario tracked); the
  harmony closure is untouched (no harmony leg runs the scenario; its
  dynamic imports never resolve without `options.skills`).

## Alternatives considered

- Vendoring verbatim chokidar + readdirp and adding a `node:events` host
  shim: rejected — significant new system-layer surface (host-C change plus
  os.type/Stats/watch-seam shims) for code that can never execute here
  (no timers, no fs events). The linkage shim keeps the link honest and the
  failure loud (rule 5).
- A fake `skill` tool implemented in the scenario: rejected — the proof must
  exercise the REAL vendored tool-skill (registry lookup, invocation policy,
  rendered `<skill_content>`) and the REAL agent-loop dispatch, or the E2E
  proves nothing about the upstream family.
- Asserting the prompt override from the session log's system/message record:
  rejected — that proves what the systemPrompt projected, not what the LLM
  request carried; the wire-request capture (onRequestBody) is the actual
  claim under test.
- Making the skill mount unconditional in boot.js: rejected — the parity and
  session manifests pin the boot's `upstream/services` shape; opt-in keeps
  those legs byte-stable.

## Consequences

- Skills discovery is cwd-sensitive and reads through the `fs` service; the
  staged VFS world means discovery sees exactly what the scenario staged.
- `watch:false` is a declared staged gap (upstream/README.md): catalog
  freshness rides the request-boundary re-discovery, not live fs events.
- The chokidar linkage shim turns any future `watch:true` mount into a loud
  failure at first watch attempt instead of a silent no-op.
