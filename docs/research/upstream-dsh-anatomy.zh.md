# 上游 DSH 解剖 — 包清单、执行流程与 dsh-mobile 接入地图（2026-09-23）

[English](upstream-dsh-anatomy.md) | 简体中文

本文整理上游 **deepseek-harness**（DSH）monorepo 包含什么、一次 agent
对话如何在其中流转、以及 dsh-mobile 在哪里接入。资料来源：`tmp/deepseek-harness`
处的上游克隆（tag `dsh-v0.1.7-alpha.2`，merge `00102833d`）与我们的
供应商化 pin `0.1.6-alpha.2`（`runtime/spike/vendor/`）。本文是
[upstream-capability-mounting.md](upstream-capability-mounting.zh.md)
（姊妹项目的 capability 模式与采纳决策）与
[`runtime/spike/upstream/README.md`](../../runtime/spike/upstream/README.md)
（shim 表）的补充——那两份都没有从头走一遍上游流程，这正是本文的任务。

## 1. Monorepo 全貌

**`packages/` 下 54 个分组、307 个包，4 个 app，9 个供应商化框架包，1 个
native system 包。** 所有产品包都在 `@deepseek-ai/dsh-*` 域下。对宿主移植
最重要的分层信号：整棵树按两个构建面构建——`host` 与 `client`，由
`DSH_BUILD_FACE` 选择（`tsdown.config.ts`）——因为两个面在 cordis
`Context` 的同名 key 上合并的是**不同的**服务，一个 TypeScript program
无法同时看到两边（`tsconfig.host.json` / `tsconfig.client.json`）。

整棵树遵守的分类规则（来自 `packages/README.md`，也是 dsh-mobile 原样继承
的规则）：**扩展插件依赖 Service Definition，绝不依赖具体 provider。**

| 分组 | 包数 | 是什么 |
| --- | --- | --- |
| `core/` | 8 | 大脑：agent、agent-loop、session、system-prompt、tools、scope、agent-default-model、agent-tool-presentation |
| `llm/` | 7 | LlmRuntime + provider 适配器 + 重试 + token 计量 |
| `session/` | 22 | 事件溯源会话：持久化、v0–v4 格式、projection、标题、遥测 |
| `fs/` | 7 | fs seam + local/sandbox 后端 + 文件工具（读/写/编辑/搜索） |
| `shell/` | 11 | bash/pwsh 执行器 + shell 工具（一次性与持久 PTY） |
| `subprocess/` | 3 | spawn seam（`ctx.subprocess`）+ 本地实现 |
| `sandbox/` | 4 | 按调用收拢的约束契约 + OS 后端（bwrap/Landlock/Seatbelt/ACL） |
| `api/` | 9 | Remote 控制器（session/job/terminal/workspace/settings/account）+ typert 网关 |
| `client/` | 60 | 整个浏览器层：connection、模块系统、store、约 45 个 `ui-*` 插件 |
| `boot/` | 5 | app-boot、cmdline、config-editor、hmr、plugin-manager |
| `bundle/` | 6 | profile 层：base、web-app、headless、sdk-app、sdk-minimal、acp-app |
| `preset/` | 3 | agent-preset 声明 + 注册表 + persona |
| `host/` | 9 | webserver、frontend-static、目录选择器、遥测、插件清单 |
| `web/` | 6 | web 搜索/抓取 seam + provider + web 工具 |
| `extensions/` | 4 | cordis-host-runner / cordis-client-runner（双半插件）+ tool/ui 行 |
| `subagent/` | 11 | 子 agent 委派：in-process、fork、ACP、SDK、Claude Code、Codex |
| `context/` | 6 | AGENTS.md 指令、@file/@session 引用、时间/tmux 上下文 |
| `compaction/` | 5 | token 预算压缩策略 + 斜杠命令 |
| `jobs/` `todo/` `goal/` `plan/` `workflow/` | 3+1+4+1+4 | 后台任务、todo 工具、目标、计划模式、JS 编排 |
| `interaction/` | 4 | user-approval、user-questions、ask_user 工具、权限预设 |
| `credentials/` | 5 | 凭据 seam + 本地 provider + DeepSeek 账户/授权 |
| `settings/` `storage/` `spill/` | 1+4+3 | 设置 seam；JSON/SQLite KV；超限输出外溢 |
| `terminal/` `ssh/` `lsp/` `mcp/` | 3+4+3+2 | PTY 工具；SSH 三件套（fs/subprocess/sandbox）；语言服务器；MCP |
| `acp/` `sdk/` `typert/` | 1+3+4 | ACP 服务器；TS/Python SDK（JSON-RPC）；RPC 反射/生成 |
| `experimental/` `test-support/` `runtime-diagnostics/` | 20+7+1 | Agent 团队、浏览器/计算机使用、语音；测试载具；不变量 |
| `util/` | 17 | 浏览器安全的共享原语（shared 面，设计上零依赖） |

App：`apps/cli`（`dsh` 二进制）、`apps/desktop`（Electron 壳）+
`apps/desktop-host`（其背后的私有 Node 宿主进程）、`apps/web`（Vite 前端）。
`vendor/` 放 cordis 框架层（cordis 4.0.0-rc.7、loader、include、group、timer、
hmr、logger-console、schemastery、cosmokit），重定域到 `@deepseek-ai/*`，
带 22 条本地修改日志——框架是被拥有、可审计、被钉住的。
`native/system` 发布预编译的 `landlock-run` + POSIX flock 绑定。

上游文档按依赖顺序最值得读的：`docs/cordis-primer.md` →
`docs/capability-seams.md` → `docs/architecture.md` →
`docs/agent-lifecycle.md` → `docs/tool-execution-pipeline.md` →
`docs/api-gateway.md`。

## 2. 执行流程

### 2.1 启动 — profile boot

**没有进程内的插件挂载 API**；每个应用都通过命名 profile 启动
（`dsh --profile <name>`），扩展就是「一个 profile 加一组有序 patch 文件」
（`scripts/verify-application-entrypoints.ts` 拒绝绕过）。流程
（`apps/cli/src/bin.ts` → `apps/cli/src/profile-boot.ts` →
`packages/boot/app-boot/src/index.ts`）：

1. 解析 profile（`$DSH_HOME/profiles/<name>`，其 `dsh.profile` 列出
   bundle），堆叠 patch 层：各 bundle 的 `cordis.patch.yml` 按声明顺序 →
   profile 自己的 patch → home 级 patch → `--patch` CLI 覆盖。
2. 根 `cordis.yml` 永远是**空列表**——整棵插件树都作为 patch 在其上组合
   （每次启动都重写，因为 Loader 的回写会把行烤进文件）。
3. `boot()` 创建 cordis `Context`，挂载供应商化的 cordis **Loader** +
   `cordis:include` + `cordis:group`，挂载整棵树并等待沉降。
4. `auditStartupEntries()` 对缺失的必需条目（`agent-loop`、`webserver`、
   `modules`、`connection`……）fail loud。

一条 patch 行是带 `id` 与 `config` 的 YAML 对象；`!!js` 表达式节点在挂载
时对 `ctx.<service>`、`process.env`、`dshHomePath` 插值。`dsh-base`
（`packages/bundle/base/cordis.patch.yml`，约 90 行）是除 `sdk-minimal`
外所有 profile 的共享首层。

### 2.2 上下文模型 — cordis 与服务 seam

Cordis（`docs/cordis-primer.md`）是插件元框架：插件是 `{ inject?,
apply(ctx) }` 或 `Service` 子类；context 是服务仓库（`ctx.<key>`）；
`inject` 声明依赖，因此装载顺序由服务可用性驱动而非启动排序；事件带五种
派发模式（emit / waterfall / parallel / serial / bail）的类型化声明；每次
注册都是可逆 effect。**Service Definition / Provider / Consumer** 三件套是
能力词汇：抽象 `Service` 子类声明 `ctx.<key>`，provider 插件实现它，
消费方 `inject` 它。

承载一次对话的服务及其桌面 provider：

| `ctx.*` | 定义 | 桌面 provider |
| --- | --- | --- |
| `llm` | `packages/llm/llm`（`LlmRuntime`） | 自身 + `llm-deepseek` 适配器 |
| `sessions` | `packages/core/session`（`SessionStore`） | 自身 |
| `sessionPersistence` | `packages/session/session-persistence` | `session-persistence-jsonl` |
| `sessionProjections` | `packages/session/session-projection` | 自身 |
| `agents` | `packages/core/agent`（`AgentRegistry`） | 自身 |
| `agentLoop` | `packages/core/agent-loop`（`AgentLoop`） | 自身 |
| `tools` | `packages/core/tools`（`ToolRuntime`） | 自身 |
| `systemPrompt` | `packages/core/system-prompt` | 自身 |
| `fs` | `packages/fs/fs`（抽象 `FileSystem`） | `fs-sandbox` 叠 `fs-local` |
| `subprocess` | `packages/subprocess/subprocess` | `subprocess-local` |
| `shell` | `packages/shell/shell`（`ShellExecutor`） | `bash-sandbox` / `pwsh-sandbox` |
| `sandbox` | `packages/sandbox/sandbox`（`SandboxProvider.confine`） | `sandbox-local`（或 `sandbox-windows-acl`） |
| `web` | `packages/web/web`（搜索/抓取注册表） | `web-search-deepseek` + `web-fetch-http` |
| `webServer` | `packages/host/webserver` | 自身（web profile） |
| `settings` | `packages/settings/settings` | 设置后端 |
| `agentPresets` | `packages/preset/agent-preset-registry` | 自身（web profile） |
| `sessionController` 等 | `packages/api/*` | Remote 控制器（web profile） |

### 2.3 一个回合，端到端

状态单元是 **Session**（`packages/core/session/src/index.ts`）：一份
append-only 的冻结 `SessionEvent` 数组（`seq` = 下标，连续性契约）、一个
跨消息产生事件的有序 surface、以及从日志投影 LLM 历史的折叠
（`requestHeader()`、`deriveMessages()`）。**对模型可见即已入日志**——
不存在侧路状态。

驱动者是 `ReactLoopAgent`（`packages/core/agent-loop/src/agent.ts`）：

1. **输入** — `Agent.send/followup/steer` 落入 `ReactLoopInbox`
   （`inbox.ts`），一个由 projection 支撑的持久收件箱（next-turn 与
   next-step 两个队列）。
2. **回合** — `turn()` 追加 `turn/start`，然后循环步进。
3. **步前** — `preStep()` 认领取件箱输入，组装系统提示
   （`ctx.systemPrompt.assemble`），投影运行时上下文，并跑
   `agent/pre-step` waterfall（可改写消息或拒绝）。
4. **请求** — `prepareRequest()` 从 agent 选项与持久化 header 播种配置，
   跑 `agent/request` waterfall，`ctx.llm.prepareCall()` 绑定适配器。提示词
   以 `system/message` 事件提交；认领到的用户输入以 `user/message` 提交。
   然后 `buildRequest()` 记录 `request/header` + `request/context`，并把
   `session.deriveMessages()` 冻结为不可变的 `GenerateOptions`——请求是
   日志的纯函数。
5. **流式** — `AssistantStreamAttempt` 包装
   `preparedCall.stream(request)`：每个 `StreamChunk` 折叠进块组装器并
   再发射为实时 `agent/assistant-stream` 帧；成功时一个
   `assistant/message` 事件提交精确的流；失败的尝试提交
   `assistant/attempt`（对模型不可见），`agent/request-error` waterfall
   决定重试。
6. **工具调用** — 消息 content 中的 tool-call 块交给
   `executeToolCalls()`（`tool-calls.ts`）：按工具执行模式分组（独占
   barrier 或有界并行池，`maxParallelToolCalls`），每个记录 `tool/call`
   事件，经 `ToolRuntime` 调度器（`prepare → dispatch → finalize`）执行，
   并以模型顺序提交经 `sourceEventSeqs` 回链的 `tool/result` 事件。
7. **循环** — 工具结果喂给下一步；没有工具调用则回合结束
   （`completed`）；中止时为被跳过的调用补合成结果并记
   `turn/end {kind:'aborted'}`；错误记 `turn/end {kind:'error'}`。

工具是 `ToolRuntime` 注册表中的声明式行（`name/description/parameters/
output {schema, render}/execute`），带遮蔽全局的分层作用域（`dsh-scope`）、
按 agent 的掩码，以及 `tools/pre-execute`（审批门）/ `tools/execute` /
`tools/post-execute` 事件管线（`docs/tool-execution-pipeline.md`）。

### 2.4 LLM 层

`LlmRuntime`（`packages/llm/llm/src/index.ts`）是按 provider 键控的适配器
注册表。契约小而无 Node 依赖：适配器实现
`stream(options: GenerateOptions): AsyncIterable<StreamChunk>`，外加返回
与生成绑定的调用的 `prepareCall()`，使能力与端点不会在飞行中混搭。
`StreamChunk` 是线格式中立的流协议：`block-start` / `text-delta` /
`reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`。
一切包在 `llm/stream` waterfall 里；适配器抛错归一化为终止性 `finish` 块。

**线格式漂移警报（见 §4）**：0.1.7 的官方 `DeepSeekAdapter`
（`packages/llm/llm-deepseek/src/adapter.ts`）说的是
**Anthropic-Messages 形状**的协议——`POST {baseURL}/messages`、
`anthropic-version: 2023-06-01`、SSE——而我们 pin 的时代（以及我们的
`llm-transport.js` 和 0.1.6 mock 服务器）说的是 OpenAI 风格的
`/chat/completions`。

### 2.5 事件 — 持久日志、实时流与 projection

两套独立机制：

- **持久会话事件**（`turn/*`、`step/*`、`system|user|assistant/message`、
  `tool/call`、`tool/result`、`request/*`）——追加进日志并以
  `session/event` 广播。这是持久化与重放的单元。
- **实时 agent 事件**（`agent/*`）——进程内；token 级增量只存在于
  `agent/assistant-stream` 帧。

**session-projection**（`packages/session/session-projection`）让领域插件
注册纯 `ProjectionDefinition { key, init, apply }` 单元折叠每条已提交事件；
读取方拿到一致快照。loop 注册 `turnBoundary` 与 `inbox`；其他：
`sessionStats`、`turnOutline`、`agentPreset`。

### 2.6 客户端如何观察

`remotes → gateway → connection → webserver`（`docs/api-gateway.md`）。
`webServer` 服务伺服构建好的前端；RPC 是 **typert**——对 `@Remote` 装饰
方法做构建期生成的 Host/Client 契约。一元调用是
`POST /api/<namespace>/<method>`；流式 Remote 在 `/api/remote.mux`
WebSocket 上多路复用。`SessionController` 暴露
`create/prompt/cancel/page/projections/…`，外加驱动 UI 的两条流：
`follow`（快照 + 无缝事件流 + assistant-stream 帧）与 `control`。浏览器侧
在 cordis 存在之前先从 `window.__DSH_BOOT__`（`packages/client/modules`）
构建模块表。

### 2.7 执行世界

一个 seam 家族承载全部 OS 触达，各自带按调用策略与诚实的能力事实：
`SandboxProvider.confine(argv, policy)` 包装 argv（read-only /
workspace-write / danger-full-access，fail closed）；shell 执行器在经
`ctx.subprocess` spawn 之前先过 `confine` 包装 argv；`FileSystem.
sandboxMode`（与 `ShellExecutor.sandboxMode`）是诚实的 getter，让工具层
能如实播报升级。审批是独立 seam（`tools/pre-execute` + `user-approval`）。

### 2.8 预设

`AgentPresetRegistry`（`packages/preset/agent-preset-registry`）：一个
preset 是 YAML 声明的插件条目列表，每次激活挂载进专属作用域——persona
行、工具行、提示词段——按会话组合因此从不编辑宿主面。会话经 header 持久
绑定其 preset；在 web 上，面向模型的工具移到了 preset 之后。

### 2.9 宿主必须提供什么（嵌入事实）

对任何移植，承重的性质是：loop 的请求是会话日志的纯函数；流式是无 Node
类型的普通 `AsyncIterable`；**一切 I/O 只经 fs/subprocess/shell/sandbox/
llm-adapter 的 provider seam 触达 OS**；组合靠把 provider 挂到 context
上——桌面宿主自己也「只是另一个 profile」（`desktop-host` 跑 web profile
外加额外能力）。

## 3. dsh-mobile 如何接入

### 3.1 规则

D9 + D6：承载产品的上游包**逐字**供应商化（钉住 tarball + sha256，
`runtime/spike/vendor/ensure-dsh.sh`），经适配器插件驱动；自研代码只做
胶水。平台差异活在**上游契约之下**——绝不在其上做 `hostType` 分支。

### 3.2 供应商化闭包

29 个 `dsh-*` 包 + 9 个 npm 包，钉在 `0.1.6-alpha.2` / 各自版本：脊柱
（`session`、`agent`、`agent-loop`、`tools`、`system-prompt`、
`session-projection`、`llm`、`settings`、`scope`、`sandbox`……）、文件
工具（`fs-local`、`tool-fs`、`tool-str-replace-editor`）、shell 家族
基底、`agent-presets`、测试载具（`llm-mock-server`）。**刻意不进闭包**：
provider 适配器（`llm-deepseek`/`llm-pi-ai`——由网关传输层替代）、
`session-persistence-jsonl`（koffi）、`subagent`、`tool-fs-search`
（ripgrep 二进制）、`base`（patch bundle——由下述内存组合替代）。

### 3.3 移动 profile boot

`runtime/spike/upstream/boot.js` —— `bootUpstream(options)` 以空根 +
内存层组合复现桌面入口形状（没有磁盘 Loader；宿主模块加载器把说明符映射
进 vendor 闭包）。挂载顺序：

1. `web-shims.js`（Web-API 全局）→ 钉住 profile 容器（`$DSH_HOME`/cwd/
   tmpdir 折叠进宿主授予的容器）。
2. `new Context()` + cordis logger 接统一日志槽。
3. **先挂 `llm`**：供应商化的 `LlmRuntime`，为调用方的 provider 路由注册
   网关传输适配器（`upstream/llm-transport.js`）——桌面 `llm` 服务跑在
   `httpFetch` 之上。
4. dsh-base 脊柱：`SessionStore` → `AgentRegistry` → `SystemPrompt` →
   `ToolRuntime` → `SessionProjectionRegistry` → `SettingsMemory`（唯一
   自研行）→ 工具行（`tool-todo`、`shell-wasm`、`shell-ish`）→ 文件工具
   行（供应商化 `fs-local` + `tool-fs` + `tool-str-replace-editor` 跑在
   内存工作区 VFS 上）→ `AgentLoop`（一个配置好的 agent）。
5. 预设面：真 cordis `Loader` + `AgentPresets` 跑在预置 presets VFS 上
   （同时伺服 web-boot 组合）。
6. `demandServices` 对任何缺失脊柱服务 fail loud；boot 发出
   `upstream/profile`、`llm/runtime`、`upstream/services` 记录。

### 3.4 seam 表 — 上游服务 → 我们的 provider → 网关原语

| 上游契约 | 桌面 provider | dsh-mobile provider | 所骑原语 |
| --- | --- | --- | --- |
| `llm` 适配器（`stream`） | `llm-deepseek`（直连 fetch） | `upstream/llm-transport.js` | `httpFetch` |
| `fs` Service | `fs-sandbox` 落盘 | 今天：供应商化 `fs-local` 跑内存工作区 VFS（`shims/fs.js`）；落盘路线：`system-plugins/dsh-fs` | `fsRead/fsWrite/fsScope`（+v1.1 操作） |
| `subprocess` Service | `subprocess-local`（OS 进程） | `system-plugins/dsh-subprocess-quickjs` —— 进程内协程执行器 | 无（纯运行时） |
| `ui`（通知/审批/选择器） | Electron 对话框 | `system-plugins/dsh-ui` | `notify`、`presentApproval`、`presentPicker` |
| `shell` 执行器家族 | `bash-sandbox`/`pwsh-sandbox` | `system-plugins/dsh-shell-wasm`（wasm 程序）、`system-plugins/dsh-shell-ish`（Alpine 用户态） | `wasmRun` / `ishRun` + fs 原语 |
| `webServer` + 客户端层 | Node webserver + 浏览器 | 载体环回（HTTP+WS）+ 组合官方 client modules 的 `web-boot.js` | 载体 seam（docs/webserver-contract.md） |

契约 v1.3.0 总计：**16 个原语**（v1.0 冻结的 9 个 + v1.1 的 5 个 fs 操作 +
v1.2 的 `wasmRun` + v1.3 的 `ishRun`），带结构化 `GatewayError` 拒绝与
扁平审计流。

### 3.5 客户端层

`upstream/web-boot.js` 把供应商化的 `ClientModuleRegistry` 挂到预置
web-plugin VFS 上，把组合好的 wire 加 `/api` 与 mux journal 面交给载体。
`presentation/official-web` 是官方上游 web UI，逐字供应商化在
`0.1.6-alpha.2`，带 PROVENANCE + MANIFEST，外加 **58 包应用层**
（api-gateway、connection、`ui-*` 插件），经物化与 manifest 校验。活线
（`composer-live-write` 家族）驱动真实的 `session/create` →
`session/prompt` → agent-loop 回合，渲染进官方 DOM。

### 3.6 三个宿主

`hosts/ios`、`hosts/android`、`hosts/harmony` 三个平台宿主内嵌规范
`runtime/spike` 闭包的提交副本（`closures` gate 逐字节校验），并提供：
串行运行时线程 + 模块加载器（`dsh_spike_host.c`）、网关桥、平台原语
（SAF / 安全范围书签 scope、流式 httpFetch、keychain、通知）与载体服务器。
平台差异只以能力协商答案出现（如 `ishRun` 仅 iOS 可用）。

### 3.7 E2E 如何钉住

`test/e2e/scenarios/` 的场景族以结构化日志断言整条链：`upstream-session`
（供应商化脊柱 + 网关 LLM 回合）、`upstream-web-boot` / `officialweb-mount`
（+ android/harmony 变体）、`session-live-read` / `composer-live-write`
（带真实数据的官方 app）、`llm-live-stream`（`httpFetch` 上的真实流）、
`userland-shell-local`（`ishRun`）。按 `scenario-id` 一对一期望 ↔ 日志匹配
（docs/ARCHITECTURE.md §3）。

## 4. 漂移观察 — 我们的 pin（0.1.6-alpha.2）对上游 0.1.7-alpha.2

capability-mounting 研究已点名 preset 波（`agent-preset-registry`、
`config-editor`、account/job Remote 控制器、双工 `RemoteStream`、
registry-fallback 插件管理器）。流程层面再补三条：

1. **LLM 线格式在我们 pin 之后切换。** 上游 commit `99e22ebbe`
   （2026-09-19，"make the official DeepSeek adapter Messages-only"）把官方
   适配器迁到 Anthropic-Messages 协议（`POST /messages`、
   `anthropic-version` 头）。我们的 `llm-transport.js` 与 0.1.6 mock 服务
   器说的是 `/chat/completions`。**re-pin 必须要么把传输层移植到 Messages
   线格式，要么连同 mock-server 时代一起钉**——这是下一次 re-pin 里最大
   的代码侧适配点。
2. **启动审计收紧**：`auditStartupEntries()` 现在在启动时强制必需条目
   id——我们的 `demandServices` 是同一直觉，应镜像其 id 清单的变化。
3. **web 上 preset 作用域的工具行**：上游在 web bundle 里把面向模型的工具
   移到 preset 之后；我们的 boot 挂在宿主面。不紧急（我们的 profile 是单
   agent），但是要跟踪的语义漂移。

供应商化刷新仍是计划中的、深思熟虑的变更（D6）；本节是观察清单，让下一
次 re-pin 是有备而来，而非措手不及。

## 5. 阅读地图

| 要理解 | 读 |
| --- | --- |
| 插件内核 | 上游 `docs/cordis-primer.md`、`vendor/cordis` |
| 能力词汇 | 上游 `docs/capability-seams.md` |
| 启动模型 | 上游 `apps/cli/src/profile-boot.ts`、`packages/boot/app-boot/src/index.ts` |
| 回合循环 | 上游 `packages/core/agent-loop/src/agent.ts`、`docs/agent-lifecycle.md` |
| 工具执行 | 上游 `packages/core/tools`、`docs/tool-execution-pipeline.md` |
| LLM 契约 | 上游 `packages/llm/llm/src/types.ts`（`StreamChunk`、`GenerateOptions`） |
| 客户端线 | 上游 `docs/api-gateway.md`、`packages/api/session-controller` |
| 我们的移植 | `runtime/spike/upstream/README.md`、`runtime/spike/upstream/boot.js`、`docs/ARCHITECTURE.md` §3–§5、§10 D9 |
| 我们采纳的能力模式 | [upstream-capability-mounting.md](upstream-capability-mounting.zh.md) |
