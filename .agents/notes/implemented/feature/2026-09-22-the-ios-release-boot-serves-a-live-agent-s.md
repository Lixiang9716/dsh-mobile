# Agent Note: the iOS release boot serves a live agent spine, and the first tool works

Status: implemented
Related: D5, D6, D9

## Problem

The user-facing iOS build (`dsh-ios`, Release) mounted the official Web Client
and served **nothing behind it**. `OfficialWebRuntime` is the b1 compatibility
mount: it serves the index, the assets, the plugin delivery and the web-boot
wire, and leaves `/api` and the mux **unclaimed on purpose**, so every control
the page renders answers structured-unavailable. Measured on the simulator:
tapping the workspace chip, the settings gear, the search rail icon and the
composer in turn produced **byte-identical screenshots** — the UI was a shell.
That is recorded as an honest shared gap in the harmony note of 2026-09-21
("the session surface is served on the harness's spine legs only").

A user opening the app therefore could not pick a workspace, send a message,
reach settings, or invoke anything. "Test every button" had nothing to test.

## Decision

**Split serving from evidence, and point the release boot at the serving
seat** — the shape the harmony port settled on after rejecting a
single-class-plus-`isRelease` gate (a file boundary is checkable by reading; a
flag only by testing).

- `hosts/ios/App/Source/SessionServe.swift` is the SERVING seat: the carrier,
  the official dist seat, the `/plugins` delivery, the `/api` + mux bridge, the
  scripted chat-completions endpoint and the web-boot runtime half (the
  upstream spine: `session/create`, prompt admission, the follow streams, the
  settings describe). It runs in BOTH configurations; its hook block defaults
  to no-ops, and its `credential` is INJECTED rather than read from the
  environment — a seat that read the app's credential file itself would make
  the E2E drive hit a real endpoint the moment a developer staged a key.
- `SessionWriteRuntime` is now only the `b4.write.live` VERIFICATION drive: it
  holds a seat, turns its hooks into canonical records, drives the page with
  the probe and decides the verdict. Record order is unchanged — `b4.write.live`
  passes 43/43 in order before and after the split.
- `AppDelegate.bootRelease` runs the seat with no hooks and no launch argument.
  `-dsh-mode serve` (Debug only) runs the same seat WITH the harness's logging,
  which is the mode a user-visible failure is reproduced in; the release build
  refuses every mode but `official-web`, as before.

**The first ported tool.** `dsh-tool-todo` is vendored, sha256-pinned,
embedded and mounted. Its closure needed nothing new: every import it makes
(`schemastery`, `zod`, `dsh-tools`) was already pinned, and its peer packages
are already mounted services. `b4-write-live.json` now pins `tools: 1`, which
is the honest new fact — the mobile profile offers exactly one tool.

**Three defects this uncovered, each with its own evidence:**

1. **The async_hooks shim lost its store at the first `await`.** The shim
   approximates `AsyncLocalStorage` over a frame stack plus a
   `Promise.prototype.then` patch, but quickjs-ng runs `await` continuations
   through its own job queue, NOT through that patched method. Measured with
   `scenario/als-shim-probe.js`: the store was gone at the first `await` and
   stayed gone. `dsh-agent` scopes the initiating Agent that way and the agent
   loop reads it when it executes a tool call, so a plain turn looked healthy
   while the first tool call of every session failed with **"no initiating
   agent is active"**. Fixed by keeping a `run()` frame installed until its
   operation's promise settles, with liveness tracked in a set the
   capture/restore machinery cannot touch (a frame written back by a restore
   is skipped, so `after-run` does not leak the store).
2. **The workspace root was the app's own JS bundle staging directory.** The
   profile's `containerRoot` was `bundleRoot` — `NSTemporaryDirectory()/spike`,
   deleted and rewritten on every launch and sitting OUTSIDE every granted
   scope. An agent working there could not be allowed to write, and anything it
   wrote would vanish. The seat now seeds a real workspace inside the app scope
   (`<Documents>/profiles/default/spike`) and passes the scope root alongside
   it, so an absolute path maps onto `(scope "app", scope-relative path)`.
3. **The agent's tool surface was empty in the shipped profile** — recorded
   above as the tool port.

**The launch surface.** A user-facing launch stages the JS bundle, boots the
spine and only then opens the origin; until then the WebView is blank white,
which is indistinguishable from an idle app. The boot now owns the screen with
a spinner until the page renders, and names the failure on screen (and on
`NSLog`, the one level a release build keeps) when it cannot.

## Alternatives considered

- **Run the serving seat only in Release, gated by `BuildFlavor.isRelease`.**
  The iOS precedent the harmony note explicitly rejected: the serving path
  stays interleaved with the drive and correctness rests on an `if` that every
  future edit must remember.
- **Give the release boot a second copy of the serving logic.** Two
  implementations of the same boot wire — the one the manifest verifies and
  the one users run — drift by construction.
- **Keep the staged bundle dir as the workspace.** It is what the b4 drive
  needed (a cwd for the turn) and it made the file-tool question invisible
  until the tools were mounted; the workspace is now a real scoped directory
  instead.
- **Reach the filesystem around the gateway for the file tools.** Forbidden by
  D5; see the contract revision below.

## Consequences

- The user-facing build is an app: workspace picking, the composer, the session
  streams, the settings surface and the tool surface all answer, and a real
  model turn renders a real reply. Verified on the simulator with
  `deepseek-flash` over the gateway `httpFetch`.
- `tools/e2e/ios-ui.py` drives the app by LABEL through the WebDriverAgent the
  repository already bootstraps; the before/after control sweeps live under
  `hosts/ios/artifacts/ui-sweep/` and `.../ui-sweep-conversation/`. Two real
  defects came out of them, both in the vendored upstream client (the plugin
  list answers "暂时无法读取插件。", and the plugins panel collapses to one
  character wide with the sidebar open) — neither is fixable here (D6), so
  both are reported upstream.
- **`contract/primitives.md` is now v1.1.0**: five additive filesystem
  primitives (`fsStat`, `fsList`, `fsMkdir`, `fsRemove`, `fsRename`) that the
  upstream file tools need and the v1.0.0 table lacked. They reuse the existing
  `fsRead`/`fsWrite` permission flags, so no manifest negotiates more than it
  did. iOS implements all five and the implementation is probed on every
  `b4.write.live` run (`scenario/b4-web-live.js`, `log.debug` so no canonical
  record changes); the CLI, Android and HarmonyOS hosts have not implemented
  them yet, which is disclosed rather than papered over. `GatewayCore.primitives`
  still reports the nine of v1.0.0 — updating it changes the descriptor the
  `m2.gateway.binding` / `m4.host-binding` / `m5.host-binding` evidence pins, so
  that edit rides the next re-run of those legs.
- The remaining work for real file tools is named: a `node:fs/promises` shim
  over those five primitives plus the v1.0.0 three (the surface is exactly the
  ten async functions and two `node:fs` symbols `@deepseek-ai/dsh-fs-local`
  imports), then vendoring `dsh-fs-local`, `dsh-attachment` and npm `diff` and
  mounting them beside `dsh-tool-todo`.
