# dsh-desktop 插件接入账本

[English](dsh-desktop-plugins.md) | 简体中文

本文件记录"完全接入除 Electron 之外的所有 dsh-desktop 插件"在本仓库的
账目：上游有什么、本仓库接入了什么、下一步排期是什么、什么被排除以及
原因。上游在 `0.1.6-alpha.2` 锚点的面：**293 个已发布的
`@deepseek-ai/dsh-*` 运行时/客户端包**（上游
`vendor/dsh-runtime/0.1.6-alpha.2/manifest.json`）加 **5 个桌面产品
workspace 包**，共 298 个。

"接入一个插件"指走仓库七条接缝之一：运行时服务插件（`upstream/boot.js`
的 `mountSpine`）、ToolRuntime 上的工具包、vendor 锚点
（`vendor/ensure-dsh.sh`）+ shim 行（`upstream/shims/` 与裸名映射）、
被认领的 web API 面（`upstream/web-write.js`）、staged 客户端 bundle
（`presentation/official-web/client-bundles/`）、自研系统插件
（`system-plugins/`），或宿主能力（`hosts/*/`，受契约约束）。

## 已接入（T-0035 之后）

| 层 | 包 | 方式 |
| --- | --- | --- |
| 运行时主干 | session、agent、system-prompt、tools、session-projection、settings、agent-loop、llm（传递引入 sandbox、scope、brand、invariants、timeout、typert-protocol、util-crypto、util-values） | `mountSpine`，逐字 vendored 包 |
| 预设数据源 | agent-presets + cordis-plugin-loader（连带 home-paths、atomic-write、js-yaml） | 真·上游服务；一个 Loader 同时服务 presets 注入与客户端组装（T-0035） |
| 文件工具行 | fs-local、tool-fs、tool-str-replace-editor、attachment（+ npm diff） | 内存工作区世界跑 vendored fs-local 后端；read/write/edit + str_replace_editor 注册进 ToolRuntime（T-0035） |
| 工具移植 | tool-todo；自研 dsh-shell-wasm（`shell`）、dsh-shell-ish（`ish`） | ToolRuntime；背后是契约 `wasmRun`/`ishRun` |
| 官方 web 层 | 58 包应用层 + 5 个 shell 静态模块 + 构建出的 SPA | staged 客户端 bundle 在运行时组装，由 carrier 服务 |
| 镜像 API | api-session-controller、api-settings-controller 的行为 | 写面板（web-write.js）——真正的控制器包未挂载 |
| Web API（T-0035） | pluginInventory/list（诚实只读快照）、agentPresets/list\|read\|copy\|deletePreset\|select、pluginManager/listBundles\|listPlugins（只读行，`readOnlyReason: management-required`） | 已认领端点；manager 的写端点有意不认领 |

## 排期中（可行，按价值排序）

网关 fs 作用域之上的 fs + tool-fs-search（等子进程接缝）；web 工具
（`tool-web`、`web-fetch-http`、基于 `httpFetch` 的搜索提供方）；审批/
提问（`tool-ask-user`、`user-approval` 走 `presentApproval`）；跑在
`ishRun` 上的 shell/终端栈；会话质量层（compaction、persona、plan-mode、
标题、permission-presets）；持久化/恢复（fs-scope jsonl 后端）；技能
（fs 发现）；commands/goals/workflows；streamable-HTTP 上的 MCP；
workspace-files 与文件侧栏；以 staged 树 + 插件系统回执日志为后端的
plugin-manager。每项都是一次 vendor 锚点 + shim 行 + 一次挂载——
文件工具行（T-0035）是模板。

## 已排除，含原因

- **Electron 层（所有者的排除项）：** `dsh-plugin-desktop`、
  `dsh-plugin-desktop-beta`、`dsh-desktop-next`（其依赖清单是接入
  checklist，不是要移植的代码）、`dsh-community-market`、
  `dsh-community-fabric`（纯文档）。
- **本宿主物理不可行（无契约原语，也无隐含路径）：** browser/
  computer-use（驱动桌面 GUI）；ssh、subprocess-ssh、http-proxy、
  lsp-stdio、mcp stdio（原始 TCP 套接字——网关只有 `httpFetch`）；
  win32/pwsh 各行；原生插件行（`session-persistence-jsonl`、
  `session-query-sqlite`、`storage-sqlite`——koffi/sqlite；按同一契约
  以 fs-scope/wasm 后端替代）；外部 CLI 编排器
  （hooks/subagent-claude-code/-codex）；worker 线程行（单串行运行时，
  决策 D2）；`office-to-pdf`（LibreOffice 二进制）；桌面入口机械
  （`host-webserver`、`cmdline`、`headless`、`app-boot`——已被本仓库
  的 carrier + boot 替代）。
- **仅测试/构建期：** testkit、loader、replay/mock server、
  hmr/生成器工具——只在产品包需要时按需 vendored，永不挂载。

## 证据

- `runtime/spike/artifacts/macos-cli-settings-surfaces/` —— CLI 上应答
  的预设名册（cordis/minimal/ptc/standard，标记部署默认）与插件清单
  （16 行主干 + 58 个客户端 bundle + 4 个组合），12/12 期望↔日志。
- `runtime/spike/artifacts/macos-cli-tool-fs/` —— 走真实工具分发的
  create/read/write/edit/view/str_replace，含边界拒绝。
- `hosts/ios/artifacts/b4-write-live/` —— 设备上的同一批面，由 b4
  驱动断言（以日志为准；`screens/` 里的截图仅作人的证据）。
