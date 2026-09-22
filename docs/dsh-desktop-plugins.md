# dsh-desktop plugin integration ledger

English | [简体中文](dsh-desktop-plugins.zh.md)

The accounting for "integrate ALL dsh-desktop plugins, except Electron" on
this host: what upstream ships, what this repo integrates, what is staged
next, and what is excluded with reasons. Upstream surface at pin
`0.1.6-alpha.2`: **293 published `@deepseek-ai/dsh-*` runtime/client
packages** (upstream `vendor/dsh-runtime/0.1.6-alpha.2/manifest.json`) plus
**5 desktop-product workspace packages** — 298 total.

"Integrating a plugin" means one of the repo's seven seams: a runtime
service plugin (`upstream/boot.js mountSpine`), a tool package on the
ToolRuntime, a vendor pin (`vendor/ensure-dsh.sh`) + shim rows
(`upstream/shims/`, the bare map), a claimed web API surface
(`upstream/web-write.js`), a staged client bundle
(`presentation/official-web/client-bundles/`), an in-house system plugin
(`system-plugins/`), or a host capability (`hosts/*/`, contract-gated).

## Integrated (this host, after T-0035)

| Tier | Packages | How |
| --- | --- | --- |
| Runtime spine | session, agent, system-prompt, tools, session-projection, settings, agent-loop, llm (+ sandbox, scope, brand, invariants, timeout, typert-protocol, util-crypto, util-values transitively) | `mountSpine` over verbatim vendored packages |
| 预设 data source | agent-presets + cordis-plugin-loader (+ home-paths, atomic-write, js-yaml) | REAL upstream services; one Loader serves the presets inject AND the client composition (T-0035) |
| FILE-TOOLS row | fs-local, tool-fs, tool-str-replace-editor, attachment (+ npm diff) | in-memory workspace world over the vendored fs-local backend; read/write/edit + str_replace_editor on the ToolRuntime (T-0035) |
| Tool ports | tool-todo; in-house dsh-shell-wasm (`shell`), dsh-shell-ish (`ish`) | ToolRuntime; backed by contract `wasmRun`/`ishRun` |
| Official web tier | the 58-package application tier + 5 shell-static modules + the built SPA | staged client bundles composed in-runtime; served by the carrier |
| Mirrored API | api-session-controller, api-settings-controller behavior | the write surface (web-write.js) — the real controllers stay unmounted |
| Web API (T-0035) | pluginInventory/list (honest read-only snapshot), agentPresets/list\|read\|copy\|deletePreset\|select, pluginManager/listBundles\|listPlugins (read-only rows, `readOnlyReason: management-required`) | claimed endpoints; the manager's write legs deliberately unclaimed |

## Staged next (feasible, highest value first)

fs over gateway scopes + tool-fs-search (needs the subprocess seam);
web tools (`tool-web`, `web-fetch-http`, search providers over
`httpFetch`); approval/questions (`tool-ask-user`, `user-approval` over
`presentApproval`); the shell/terminal stack over `ishRun`; the
session-quality layer (compaction, persona, plan-mode, titles,
permission-presets); persistence/resume (fs-scope jsonl backend); skills
(fs-backed); commands/goals/workflows; MCP over streamable-HTTP;
workspace-files + the Files sidebar; plugin-manager backed by the staged
trees + the m3 receipt journal. Each is a vendor pin + shim rows + a mount
— the FILE-TOOLS row (T-0035) is the template.

## Excluded, with reasons

- **Electron tier (the owner's exclusion):** `dsh-plugin-desktop`,
  `dsh-plugin-desktop-beta`, `dsh-desktop-next` (its dep list is the
  integration checklist, not code to port), `dsh-community-market`,
  `dsh-community-fabric` (docs-only).
- **Physically impossible on this host (no contract primitive exists and
  none is implied):** browser/computer-use (drive a desktop GUI); ssh,
  subprocess-ssh, http-proxy, lsp-stdio, mcp stdio (raw TCP sockets —
  gateway has only `httpFetch`); win32/pwsh rows; native-addon rows
  (`session-persistence-jsonl`, `session-query-sqlite`,
  `storage-sqlite` — koffi/sqlite; replaced by fs-scope/wasm backends
  against the same contracts); external-CLI orchestrators
  (hooks/subagent-claude-code/-codex); worker-thread rows (single
  serial runtime, decision D2); `office-to-pdf` (LibreOffice binary);
  desktop entry machinery (`host-webserver`, `cmdline`, `headless`,
  `app-boot` — already replaced by this repo's carrier + boot).
- **Test/build-time only:** testkits, loaders, replay/mock servers,
  hmr/generator tooling — vendored on demand when a product package
  needs them, never mounted.

## Evidence

- `runtime/spike/artifacts/macos-cli-settings-surfaces/` — the 预设 roster
  (cordis/minimal/ptc/standard, deployment default marked) and the 插件
  inventory (16 spine rows + 58 client bundles + 4 compositions) answered
  on the CLI, 12/12 expected↔logged.
- `runtime/spike/artifacts/macos-cli-tool-fs/` — create/read/write/edit/
  view/str_replace through the REAL tool dispatch, boundary refusals
  included.
- `hosts/ios/artifacts/b4-write-live/` — the same surfaces on device,
  asserted by the b4 drive (logs, not screenshots; screenshots in
  `screens/` are human evidence only).
