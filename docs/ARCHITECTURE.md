# dsh-mobile 整体架构方案

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
│   └── state/                    # settings / 凭据引用 / checkpoint
└── cache/blobs/<sha256>          # tgz 与 QuickJS 字节码(内容寻址)
```

备份分级：`cache/` → Caches（可再生）；`profiles/` → Documents（进备份）；外部 workspace → security-scoped bookmark。checkpoint 格式三端共享 ⇒ 跨设备漫游（电脑 ↔ Android 长跑 ↔ iOS 断点续跑）。

## 8. 多平台策略

| | iOS (v1) | Android (M4) | 鸿蒙 NEXT (M5) |
| --- | --- | --- | --- |
| 引擎 | quickjs-ng | quickjs-ng（v2 可选 nodejs-mobile 高保真形态） | quickjs-ng (NAPI) |
| 子进程 | ❌ 协程实现 | ✅ Termux 模式(jniLibs) | ⚠️ 按 ❌ 设计 |
| 后台 | 冻结+checkpoint | 前台服务长跑 | 长时任务类别制 |
| 原生壳 | SwiftUI | Compose | ArkUI |

复用率：`contract/` + `runtime/` + `system-plugins/` 语义层 + `presentation/` 全部为平台无关 JS（占代码量大头，一份三端跑）；每端仅需特权层 + 原语绑定（数百行）+ 原生壳。端差异全部经 capability 协商表达，禁止 `hostType` 分支（RFC 0002 反模式）。

## 9. 工程结构

```
dsh-mobile/
├── contract/            # M0: 原语契约 + 数据协议(bundle/manifest/receipt) — 先冻结
├── runtime/             # quickjs-ng 集成 + ESM 加载器 + 垫层(平台无关)
├── system-plugins/      # 系统实现插件·契约适配层(JS, 三端共用)
├── presentation/        # mobile-ui Web Client(三端共用)
├── hosts/
│   ├── ios/             # Swift 特权层 + 网关 + carrier + SwiftUI 壳
│   ├── android/         # (M4)
│   └── harmony/         # (M5)
└── docs/                # 架构文档、决策记录
```

## 10. 里程碑

- **M0 契约冻结**：原语契约 v0（≤10 原语）+ bundle 布局 + manifest schema + receipt 格式。
- **M1 双 Spike**：A) quickjs-ng 垫层跑通上游纯逻辑包（util-crypto / session-persistence）；B) iOS 宿主骨架（QuickJS 线程 + carrier + WKWebView 官方 UI 点亮）。
- **M2 真机会话**：dsh-fs-ios + 假 LLM 会话端到端；随后接真实 LLM API。
- **M3 插件化**：安装链路（receipt 事务）+ UI 插件三层机制 + capability 协商。
- **M4/M5**：Android、鸿蒙宿主。

## 11. 关键技术决策记录（ADR 摘要）

| # | 决策 | 理由 | 代价 |
| --- | --- | --- | --- |
| D1 | quickjs-ng 而非 nodejs-mobile | 内存小一个量级、无 JIT 合规零灰区、多 runtime 隔离 | 自建 Node 垫层 |
| D2 | 单线程协程替代子进程 | 上游 `ctx.subprocess` 本就是可替换抽象接缝 | 工具语义重定义 |
| D3 | UI = Web Client 插件 + WKWebView | 上游一等机制；浏览器侧动态加载合法且在特权进程 | 原生体验靠 slot 渐进 |
| D4 | 站外分发 | 2.5.2 禁动态代码；插件生态与之冲突 | 用户安装门槛高 |
| D5 | 契约先行 | 四端公共地基；AI 辅助开发时代价结构决定 | 首周不见 UI |
| D6 | pinned 上游 + 外挂实现包 | 上游 0.1.x 高速迭代，防断代 | 需持续跟踪纪律 |
| D7 | checkpoint 即漫游 | 后台限制转化为跨设备接力能力 | checkpoint 格式需三端一致 |

## 12. 已知边界（诚实声明）

以下能力在本宿主上**声明不支持**（capability 协商标记，不假装支持）：真实子进程生态（bash/git hook/playwright/python PTC/SSH/Windows ACL）、桌面级后台常驻（上限为 checkpoint/resume + 通知唤醒）、整盘文件访问（上限为用户授权的 security-scoped 目录）。

## 13. 上游依据（关键证据索引）

- `docs/architecture.md`：薄 Electron 宿主、carrier 拓扑、"桌面壳本身就是一个普通插件，没有任何特权"
- `docs/plugin-development.md`：两层插件、`ctx.get('desktopProfiles')` 能力探测降级范式
- `vendor/dsh-runtime/0.1.6-alpha.1`：285 包解包统计（本文 §3 垫层面数据来源）
- `@deepseek-ai/dsh-subprocess` README："Subclass, implement spawn, and load the subclass as a plugin"
- `dsh-community-fabric/docs/rfcs/`：manifest/capability 协商（RFC 0001）、Runtime/Presentation 多对多模型（RFC 0002）
- `agents-anywhere/dsh-bridge-next`：官方手机方案为云端中转，"iOS 下载入口暂未开放"
