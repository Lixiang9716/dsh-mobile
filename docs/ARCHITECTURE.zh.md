# dsh-mobile 整体架构方案

[English](ARCHITECTURE.md) | 简体中文

> 版本：v0.1（奠基版） · 状态：已评审，进入 M0
> 基于对上游 [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) vendored 运行时（285 包）的静态分析，以及 DSH Community Fabric RFC 0001–0004 草案。

## 1. 定位

dsh-mobile 是 DSH（DeepSeek Harness）生态的**移动宿主**。依据 Fabric 互操作模型，移动端与桌面端是**能力不同的平等成员**，不是彼此的复制品：

- **Runtime**（执行插件的地方）与 **Presentation**（UI 呈现面）是独立维度——手机既是 Runtime（QuickJS 跑 Harness 核心），也承载 Presentation（mobile-ui / desktop-ui 都是插件）。
- 宿主通过 `RuntimeDescriptor` 诚实声明能力面（无子进程、有授权文件系统、有推送通知），插件以 required/optional capability 协商加载——装得上的跑，装不上的清晰可见。
- 分发走开源站外路线（自签/TrollStore/未来欧盟渠道），不依赖 App Store 审核。

## 2. 总体架构

```
┌────────────────────────────────────────────────────────────┐
│ Presentation 层                                             │
│  WKWebView ←─loopback HTTP/WS─→ Swift Carrier               │
│  (Web Client 插件: 官方 React UI / mobile-ui / 第三方)       │
├────────────────────────────────────────────────────────────┤
│ Harness 核心层（QuickJS 单线程协程运行时, 专用串行线程）      │
│  上游纯逻辑包原样复用: agent-loop / session / llm / settings │
├────────────────────────────────────────────────────────────┤
│ 系统实现插件层（JS, 可插拔, 实现上游服务契约）                │
│  dsh-fs-ios · dsh-subprocess-quickjs · dsh-notify-ios …     │
├────────────────────────────────────────────────────────────┤
│ 能力网关（宿主固定部分, 不可插件）                            │
│  窄原语表(≤10 v0) · capability 校验 · 权限 · 审计日志         │
├────────────────────────────────────────────────────────────┤
│ iOS 特权层（Swift, 绑定 App 签名身份）                       │
│  Security-scoped Bookmark · 钥匙串 · 通知 · NSURLSession    │
└────────────────────────────────────────────────────────────┘
```

## 3. 运行时设计

- **引擎**：quickjs-ng（纯 C 解释器，无 JIT，App Store 合规无关——我们站外分发，但它同时解决内存与多 runtime 隔离）。理由见 ADR-1。
- **执行模型**：单线程事件循环 + async/await 协程。子进程语义由 `dsh-subprocess-quickjs` 在进程内以协程实现（上游 `ctx.subprocess` 本就是抽象 Service 基类，文档明言"Subclass, implement spawn, load as plugin"）。
- **模块加载**：宿主实现 `JS_SetModuleLoaderFunc`，从 bundle 目录（代码即数据）读取 ESM 源码；编译后字节码缓存于 `cache/blobs/`（`JS_WriteObject`）加速启动。
- **垫层面**（对 285 包实测）：内置模块 import 面 = path 67 / crypto 46 / fs 35 / os 20 / url 23 / util 11 / stream 7 / net 5 / http 4 包；crypto 实际 API 仅 6 个（randomUUID/createHash/randomBytes/timingSafeEqual/pbkdf2/createHmac）→ Swift CommonCrypto 单文件覆盖；child_process 12 包全部位于平台实现包，QuickJS 宿主不装载；worker_threads 4 包单点改造。
- **生命周期**：checkpoint/resume 应对后台冻结——事件循环静默点 + 审批挂起点落盘；回前台 UI 重连（官方 `client-connection` 自带重连语义），runtime 从断点恢复。

### 事件驱动执行

**所有模块间通信一律事件驱动；任何模块不得阻塞其他模块。** 流式输出是旗舰场景——LLM token 增量是事件序列而非阻塞调用——但规则是普适的：

- **Harness 核心**：上游 Cordis 本就是事件系统（service + 事件）；工具调用、审批请求、token 增量全部以类型化事件流动（`dsh-typert-protocol` / `dsh-sdk-protocol`）。
- **流式输出**：`agent-loop → session 投影 → carrier WS 推送 → Presentation 渲染` 是一条事件管线。UI 永不轮询、永不直接调用 agent。
- **能力网关**：Swift↔JS 桥是异步事件边界——请求以事件发出，完成以事件回到 runtime 队列（线程规则就是事件投递规则）。
- **插件**：生命周期 hook 与 `messages.observe`（Fabric RFC 0001）都是事件。
- **Checkpoint**：定义为"事件队列排空"——自然的静默点，不是特例。

规则（对现有与未来所有模块强制）：

1. 跨模块通信只经事件（发布/订阅）或显式异步接口。
2. 禁止轮询：组件不得以定时器观察另一组件的状态（定时器只服务于自身职责，如心跳）。
3. 禁止共享可变状态：跨越模块边界的状态变更必须以事件宣布。
4. 长任务必须流式：任何长时运行（LLM 流、工具执行、子代理）以事件序列报告进度，不提供阻塞式整体返回 API。
5. 背压必须显式：慢消费者不得无声阻塞生产者——缓冲/溢出策略在边界处声明。

### 端到端验证：日志断言，不用截图

CI 的端到端测试只对**结构化日志**做断言，绝不用截图（截图仅限本地交互调试）。每个场景的契约：

- 每个端到端场景携带唯一 `scenario-id`；
- 运行时对每个期望事件经统一 logger 输出一条结构化日志——
  `scenario=<id> event=<name> …`（`logging` 门已强制统一 logger）；
- 断言为**期望 ↔ 日志一一对应**：不多、不少、顺序符合场景定义；
- 失败报告精确列出未匹配条目——该清单即诊断结论。

这使 CI 天然无头，并让验证面与 `logging` 门管辖的面合一：日志流。

## 4. 能力三层

| 层 | 形态 | 内容 |
| --- | --- | --- |
| 特权层 | 宿主本体，永不插件化 | entitlement、bookmark、钥匙串、通知权限——绑定 App 签名身份 |
| 能力网关 | 宿主固定部分 | 窄原语表（fsRead/fsWrite/httpFetch/notify/presentApproval/presentPicker/keychain…），每原语带类型签名 + 权限标记 + 审计；拒绝万能接口 |
| 系统实现插件 | 插件形态（JS） | 组装原语实现上游契约：`dsh-fs-ios` 实现 `ctx.fs`，`dsh-subprocess-quickjs` 实现 `ctx.subprocess`，`dsh-credentials-ios` 映射钥匙串 |

网关原语契约是**四端公共地基**（iOS/Android/鸿蒙/桌面互操作），版本化，M0 冻结。

## 5. 插件系统

- **契约**：对齐 Fabric RFC 0001——静态 manifest（JSON Schema）、带版本 capability、required/optional 协商、确定性生命周期 hook。
- **隔离**：一插件一 QuickJS runtime，零共享；所有系统访问过网关。这是全生态首个"技术强制"权限模型（Fabric 安全章节：只有隔离执行 + 受控加载 + 受管 IPC 的宿主可声称强制）。
- **安装 = 数据操作**：tgz → `cache/blobs/<sha256>`（内容寻址）→ 校验 → 原子解包 `plugins/<pkg>@<semver>/` → 写 receipt（对齐上游 `desktopPnpm.installPlugin` 的 recovery receipt 事务语义）。
- **安全待决项**（M2 设计）：网络出口管控（防插件外泄会话数据）与 UI 插件信任级别（UI 插件同样进 capability 模型）。

## 6. UI 架构

**宿主零硬编码 UI**——激活哪个 Web Client 由配置决定，官方前端只是默认插件。

三条契合通道：

1. **会话 UI**：WKWebView 加载 `http://127.0.0.1:<port>`，Swift 实现 carrier（静态文件 + WS→QuickJS 消息总线）。官方 React 前端零改动复用（它只依赖 HTTP/WS 协议，与 Electron/宿主无关）。WKWebView 处于 Apple 特权进程，JIT 合法。
2. **平台 UI 能力**：`ctx.ui.*` 服务 → Swift 原生界面（审批弹窗、文件选择器、分享、通知），异步回调进 runtime。审批即 checkpoint 边界：后台 pending approval → 本地通知 → 回前台继续。
3. **状态契约**：UI 无状态原则——renderer 是纯视图，会话在 Host 侧落盘。UI 可随时死掉重来。

**UI 插件三层机制**（上游一等机制，桌面壳为活例）：

| 层级 | 机制 | 例 |
| --- | --- | --- |
| 配置 | `cordis.patch.yml` 分层覆盖（base → 宿主面 → profile → overlay） | 移动端默认值/裁剪 |
| 组件 | `dsh-client-ui-slots` slot 注册（类型安全，零运行时依赖） | 底部工具条、审批卡片 |
| 整体 | 插件提供完整 Web Client | mobile-ui 替换官方 UI |

线程铁律：JS 只活在 runtime 串行线程；Swift↔JS 双向非阻塞，回调一律 dispatch 到 runtime queue。

## 7. 存储设计（代码即数据）

```
<容器>/dsh/
├── profiles/<name>/              # 自包含数据单元, 可整体迁移/同步
│   ├── profile.json
│   ├── cordis.patch.yml          # 本端 patch 层
│   ├── plugins/<pkg>@<semver>/   # manifest.json + integrity.json + bundle/ + web/
│   ├── sessions/*.jsonl          # 会话 = 纯数据(上游同构)
│   └── state/                    # settings、凭据引用、checkpoint
└── cache/blobs/<sha256>          # tgz 与 QuickJS 字节码(内容寻址)
```

备份分级：`cache/` → Caches（可再生）；`profiles/` → Documents（进备份）；外部 workspace → security-scoped bookmark。checkpoint 格式三端共享 ⇒ 跨设备漫游（电脑 ↔ Android 长跑 ↔ iOS 断点续跑）。

## 8. 多平台策略

| | iOS (v1) | Android (M4) | 鸿蒙 NEXT (M5) |
| --- | --- | --- | --- |
| 引擎 | quickjs-ng | quickjs-ng（v2 可选 nodejs-mobile 高保真形态） | quickjs-ng (NAPI) |
| 子进程 | ❌ 协程实现 | ✅ Termux 模式(jniLibs) | ⚠️ 按 ❌ 设计 |
| Linux 用户态(`ishRun`,D16) | ✅ 进程内模拟用户态(iSH-arm64,vendor) | ❌ unavailable → WASM shell | ❌ unavailable → WASM shell |
| 后台 | 冻结+checkpoint | 前台服务长跑 | 长时任务类别制 |
| 原生壳 | SwiftUI | Compose | ArkUI |

复用率：`contract/` + `runtime/` + `system-plugins/` 语义层 + `presentation/` 全部为平台无关 JS（占代码量大头，一份三端跑）；每端仅需特权层 + 原语绑定（数百行）+ 原生壳。端差异全部经 capability 协商表达，禁止 `hostType` 分支（RFC 0002 反模式）。

## 9. 工程结构

环绕项目的周边环(D17):最外层承载项目相邻的表面——`build/`(唯一的构建
门面,见 [BUILD.md](../BUILD.md))、`test/`(日志校验的 e2e 校验器 + 场景
清单 + runner)、`docs/`、`packages/`(发布打包)、`tools/`(govrail 检查
器)。内部是项目本身——共享核心仅一份(DSH 方法,D9/D6)加上三个平台宿主:

```
dsh-mobile/
├── build/               # 构建门面: build|test|check|sync × 平台(可多选) — 见 BUILD.md
├── test/                # e2e 校验器(check.mjs)、场景清单、各平台 runner
├── docs/                # 架构文档、决策记录
├── packages/            # 发布打包(版本提升、tag 守卫)
├── tools/               # govrail 门禁检查脚本(治理工具)
├── contract/            # M0: 原语契约 + 数据协议(bundle/manifest/receipt) — 先冻结
├── runtime/             # quickjs-ng 集成 + ESM 加载器 + 垫层(平台无关, 规范闭包)
├── system-plugins/      # 系统实现插件·契约适配层(JS, 三端共用)
├── presentation/        # mobile-ui Web Client(三端共用)
└── hosts/
    ├── ios/             # Swift 特权层 + 网关 + carrier + SwiftUI 壳
    ├── android/         # (M4)
    └── harmony/         # (M5)
```

每个宿主内嵌规范 `runtime/spike` 闭包的一份**已提交副本**;`closures`
门禁把每份副本与规范源逐字节比对(副本是刻意的——自包含的 APK/HAP——
门禁让它们保持诚实;用 `build/build.sh sync <platform>` 重新暂存)。

## 10. 里程碑

- **M0 契约冻结**：原语契约 v0（≤10 原语）+ bundle 布局 + manifest schema + receipt 格式。
- **M1 双 Spike**：A) quickjs-ng 垫层跑通上游纯逻辑包（util-crypto / session-persistence）；B) iOS 宿主骨架（QuickJS 线程 + carrier + WKWebView 官方 UI 点亮）。
- **M2 真机会话**：完成 —— 系统实现插件（`dsh-fs` / `dsh-subprocess-quickjs` / `dsh-ui`）、`m2.session` 假 LLM 会话端到端（CLI + 真机）、首个 Web Client 挂载并实时渲染会话；真实 LLM API 仍开放。
- **M3 插件化**：进行中 —— 安装链路已作为 receipt 事务完成验证（`m3.install` 在 macOS CLI 21/21：内容寻址 blob → 信任记录校验 → 严格 manifest 校验 → 暂存树读回校验 → receipt 提交；被篡改的包在解包前即被拒绝 —— 证据 `runtime/spike/artifacts/macos-cli-m3-install/`），UI 插件前两层已在设备端验证（按配置切换 Web Client 的 `m3.ui-swap` 7/7 mini 变体 + 插件工具栏 slot 的注册、渲染与回执实时完成 —— 证据 `hosts/ios/artifacts/m3-pluginization/`）。仍开放：基于 fetch 的安装器与 pending-receipt 启动重放、安装期 capability 协商、其余 UI 插件层级；真实 LLM API 仍开放。
- **M4/M5**：Android、鸿蒙宿主，均完成——各自同构宿主一次启动跑通无头回归三连（`m1.spike.boot` 7/7、`m2.bridge.smoke` 6/6、`m2.session` 23/23）与事件驱动的绑定阶段。M4：回环载体 + WebView 挂载 + 真实九原语绑定（Keystore 封装的 keychain、SAF 目录选择器 + fsScope persist/resolve、通知 + `notify.response`、`app.state` 边沿）——`m4.host-binding` 35/35（证据 `hosts/android/artifacts/m4-complete/`）7/7、`m2.bridge.smoke` 6/6、`m2.session` 23/23）与事件驱动的绑定阶段。M4：回环载体 + WebView 挂载 + 真实九原语绑定（Keystore 封装的 keychain、SAF 目录选择器 + fsScope persist/resolve、通知 + `notify.response`、`app.state` 边沿）——`m4.host-binding` 35/35（证据 `hosts/android/artifacts/m4-complete/`）；同一真实 httpFetch 绑定亦在模拟器上驱动真实 LLM 会话（`m2.llm` 设备腿，证据 `hosts/android/artifacts/m2-llm/`）。M5 **完成，九原语齐备**：同构鸿蒙宿主一次启动跑通无头回归三连（`m1.spike.boot` 7/7、`m2.bridge.smoke` 6/6、`m2.session` 23/23）与事件驱动的绑定阶段——回环载体（向 Web Client 提供静态文件服务 + 经共享总线接缝的 RFC 6455 WS 泵）将 Web Client 挂载进 ArkWeb 并实时流出 token 增量；RuntimeDescriptor 为 9 可用 / 0 不可用，且每项原语均在设备端得到证明：notify + 通知点击 `notify.response`、presentApproval 对话框、fsScope、HUKS 封装的 keychain（AES-256-GCM set/get/delete 往返）、基于 DocumentViewPicker 的 presentPicker（取消 → null；授权 → 用户作用域并完成 fsScope persist/resolve 与内容一致读回）、对宿主自身回环载体的流式 httpFetch（响应头即 settle，随后分块事件流出；体中 abort → `cancelled`）——`m5.host-binding` 27/27 逐条日志比对（证据 `hosts/harmony/artifacts/m5-host/` 与 `hosts/harmony/artifacts/m5-primitives/`）。本宿主的 `m2.llm` 真实 LLM 腿同样已接通（由启动参数 `aa start … --ps dsh.e2e.leg m2.llm` 选中、该腿单独运行，默认链路因此不消耗推理配额；运行未改动的 `runtime/spike/scenario/m2-llm.js`，经同一条 httpFetch 绑定协商出真实腿；凭据交接由平台强制塑形——沙箱拒绝 shell 侧创建、本 SDK 的 chmod 是静默空操作，因此由运行时写入 0666 占位文件、运行脚本覆盖、应用导入后如实报告封存状态并在腿结束时删除）。其传输往返已在模拟器上端到端证实（请求经本宿主 httpFetch 离开设备并得到后端响应——真实的 HTTP 429 代码 1310：账户编程套餐配额耗尽，2026-09-22 14:43:53 重置），因此这里不宣称已完成一次真实推理：配额恢复后重跑 `hosts/harmony/ci/run-m2-llm.sh` 即可落地该证据（证据 `hosts/harmony/artifacts/m5-m2-llm/`）。
- **M3 插件化**：进行中 —— 安装链路已作为 receipt 事务完成验证（`m3.install` 在 macOS CLI 21/21：内容寻址 blob → 信任记录校验 → 严格 manifest 校验 → 暂存树读回校验 → receipt 提交；被篡改的包在解包前即被拒绝 —— 证据 `runtime/spike/artifacts/macos-cli-m3-install/`），UI 插件前两层已在设备端验证（按配置切换 Web Client 的 `m3.ui-swap` 7/7 mini 变体 + 插件工具栏 slot 的注册、渲染与回执实时完成 —— 证据 `hosts/ios/artifacts/m3-pluginization/`）。仍开放：基于 fetch 的安装器与 pending-receipt 启动重放、安装期 capability 协商、其余 UI 插件层级；真实 LLM API 仍开放。

## 11. 关键技术决策

权威决策记录在 [docs/decisions.md](decisions.md)（D0–D8），由 `gov verify-decisions` 门禁：
quickjs-ng 而非 nodejs-mobile（D1）、单线程协程替代子进程（D2）、UI 即 Web Client 插件（D3）、
站外分发（D4）、契约先行（D5）、pinned 上游（D6）、checkpoint 即漫游（D7）、全模块事件驱动（D8）。
每条都记录了它击败的替代方案——修改这些决策前先读它。

## 12. 已知边界（诚实声明）

以下能力在本宿主上**声明不支持**（capability 协商标记，不假装支持）：真实子进程生态（bash/git hook/playwright/python PTC/SSH/Windows ACL）、桌面级后台常驻（上限为 checkpoint/resume + 通知唤醒）、整盘文件访问（上限为用户授权的 security-scoped 目录）。

**模拟 Linux 用户态**（契约 v1.3.0 `ishRun`，D16）是本宿主上唯一**支持**真实用户态的地方，它带着自己的诚实声明，而不是躲在"不支持"后面：

- **它是什么。** 一个用户态 AArch64 解释器（iSH-arm64，逐字 vendor）在 **app 进程内**同时模拟
  客体的指令与系统调用。因此一个真实的 Alpine 用户态在无子进程、无第二个操作系统的情况下运行
  ——这正是 iOS 得以拥有 `sh`、`apk`、`pip`、`npm` 和编译器的原因（D2）。客体的任务拥有自己的
  宿主线程;JS 运行时的串行队列法则（§6）不变,网关照常派发。
- **它不是免费的。** 在本机对原生的实测:计算慢 **11–34×**,jitless Node 慢 **40–108×**;
  客体内核在 app 内启动 **41–79 ms**,而桌面 CLI 每次调用先付约 1 s 的固定成本。jitless Node
  **没有 WebAssembly**,所以任何走 undici 的东西(fetch、MCP 客户端)都需要引擎 vendor 的纯 JS
  llhttp/fetch polyfill。
- **审计边界移动了,而且这点被明说,而不是被糊过去。** 客体的 socket 就是宿主 BSD socket
  (`fs/sock.c`),客体的路径就是宿主路径(`fs/real.c`),因此原语契约的逐调用权限旗标与强制审计
  记录**到不了它内部**:客体里的程序访问网络与文件系统时,任何地方都没有逐调用记录。剩下的控制
  手段是审批策略与宿主选择布署的那个用户态本身——是**策略**,不是强制。契约 §7 第 2 条要求宿主
  在描述符里讲明这一点,本节就是本宿主的这句声明。
- **生命周期。** 已布署的用户态是**数据**,能跨重启存活;运行中的客体进程不能。挂起会冻结它,
  内存压力会把它连同进程一起带走(D7 的 checkpoint 承载会话,**从不承载一个活的用户态**),
  所以客体里的后台工作不是可以依赖的东西。
- **仅 iOS,经协商。** Android 与 HarmonyOS 宿主对 `ishRun` 答 `unavailable` 并继续使用
  WebAssembly shell;任何地方都没有 `hostType` 分支——描述符就是差异所在。

## 13. 上游依据（关键证据索引）

- `docs/architecture.md`：薄 Electron 宿主、carrier 拓扑、"桌面壳本身就是一个普通插件，没有任何特权"
- `docs/plugin-development.md`：两层插件、`ctx.get('desktopProfiles')` 能力探测降级范式
- `vendor/dsh-runtime/0.1.6-alpha.1`：285 包解包统计（本文 §3 垫层面数据来源）
- `@deepseek-ai/dsh-subprocess` README："Subclass, implement spawn, and load the subclass as a plugin"
- `dsh-community-fabric/docs/rfcs/`：manifest/capability 协商（RFC 0001）、Runtime/Presentation 多对多模型（RFC 0002）
- `agents-anywhere/dsh-bridge-next`：官方手机方案为云端中转，"iOS 下载入口暂未开放"
