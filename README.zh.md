# dsh-mobile

[English](README.md) | 简体中文

DSH（DeepSeek Harness）生态的移动宿主（Mobile Host）。基于社区 Fabric 互操作模型，将移动端实现为 Harness 运行时之上的一个对等宿主：QuickJS 单线程协程运行时承载 Harness 核心，iOS 系统能力以"特权层 / 能力网关 / 系统实现插件"三层封装，UI 以 Web Client 插件形态可插拔。

> 社区独立项目，非 DeepSeek 官方产品。上游生态参考 [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) 与 DSH Community Fabric 草案。

## 文档

- [整体架构方案](docs/ARCHITECTURE.md) —— 分层设计、关键技术决策、里程碑
- [发布包](docs/release.md) —— 标签触发的版本化发布与三个宿主 App 的打包

## 里程碑

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| M0 | 原语契约 v0 + 数据协议三件套（bundle 布局 / manifest / receipt） | 已完成（冻结于 v1.0.0） |
| M1 | Spike：quickjs-ng 垫层跑通纯逻辑包 + iOS 宿主骨架 + 本机 carrier | 已完成（运行时 spike 已在 iOS/Android/鸿蒙 + macOS 验证；本机 carrier——回环静态文件 + WS↔QuickJS 泵——已在 iOS 模拟器验证） |
| M2 | 系统实现插件（fs/subprocess/ui）+ Web Client 挂载 + 首个设备端会话 + 真实 LLM API | 完成（系统插件 + Web Client 挂载 + 首个设备端会话：`dsh-fs`/`dsh-subprocess-quickjs`/`dsh-ui` 插件，`m2.session` 在 CLI 与设备端均 23/23 通过，Web Client `dsh-web-client` 经 carrier WS 挂载并实时渲染 —— 证据见 `runtime/spike/artifacts/macos-cli-m2-session/` 与 `hosts/ios/artifacts/m2-session/`；真实 LLM API 已随场景 `m2.llm` 交付：经网关 `httpFetch` 形态的 OpenAI 兼容流式客户端（`runtime/spike/llm.js`），由 RuntimeDescriptor 协商执行腿 —— CLI 脚本化 SSE 腿 `m2.llm` 19/19（`runtime/spike/artifacts/macos-cli-m2-llm/`），iOS 模拟器与 Android 模拟器上的真实 z.ai 流式（`hosts/ios/artifacts/m2-llm/`、`hosts/android/artifacts/m2-llm/`），reasoning+content 增量按事件序列流出、逐字记录服务端报告的模型名、并对每条日志行断言 API 密钥零泄漏（泄漏即响亮失败）） |
| M3 | 插件安装链路 + UI 插件化（三级 UI 插件、能力协商） | 完成（安装 = 冻结 fs 原语上的 receipt 事务 —— `m3.install` 在 CLI 22/22：内容寻址 blob、信任记录校验、严格 manifest 校验、对照 RuntimeDescriptor 的安装期能力协商、暂存树读回校验、receipt 提交、被篡改的包在解包前被拒绝；基于 FETCH 的安装器把 httpFetch 流式 body 送入同一条流水线 —— CLI 用带日志的桩 `m3.complete` 41/41（`runtime/spike/artifacts/macos-cli-m3-complete/`），设备端直接对回环 carrier 本身用真实 `httpFetch` `m3.fetch-install` 46/46 + carrier 证据 `m3.fetch-carrier` 11/11（`hosts/ios/artifacts/m3-complete/`），并包含 append-only receipt 日志上的 pending-receipt 启动重放（暂存树可验证 → 提交；暂存不完整 → 回滚且已安装树不动）；三级 UI 插件均在设备端验证 —— 配置层（`cordis.patch` 分层覆盖）选择活动 Web Client 并覆盖工具栏 slot 集合，另有整客户端替换与组件 slot（`m3.ui-swap` 7/7，`hosts/ios/artifacts/m3-pluginization/`）；回归 `m2.session` CLI + 设备端 23/23，`run-ios.sh` 4/4） |
| M4 | Android 宿主（QuickJS 同构） | 完成（完成会话 `m4.host-binding` 在模拟器 35/35 全绿：回环 carrier 将内嵌的 Web Client 装载进真实 WebView 并实时渲染会话；九原语网关真实绑定——描述符 9 可用 / 0 不可用，强制审计经 `m2.gateway.audit` 16/16 复核；三场景回归同跑保持全绿——证据 `hosts/android/artifacts/m4-complete/`；同一真实 httpFetch 绑定亦在模拟器上驱动真实 LLM 流式会话 `m2.llm` —— `m2.llm` 设备端 期望 14 / 实记 171 + carrier 7/7，证据 `hosts/android/artifacts/m2-llm/`） |
| M5 | 鸿蒙宿主（ArkTS + NAPI） | 完成（同构宿主已验证：回环载体——向 Web Client 提供静态文件服务 + RFC 6455 WS 泵——ArkWeb 挂载实时会话；九项契约原语全部在模拟器上真实可用，描述符 9 可用 / 0 不可用：notify、presentApproval、fsScope、HUKS 封装的 keychain（AES-256-GCM；set → get 字节一致，set null 即删除）、基于 DocumentViewPicker 的 presentPicker（取消 → null；授权 → 用户作用域并完成 fsScope persist/resolve 与内容一致读回；用户作用域面为只读，与 Android 孪生端一致）、对宿主自身回环载体的流式 httpFetch（body 在响应头即 settle，随后按块事件流出、绝非整块返回；体中 abort → `cancelled`）——`m5.host-binding` 27/27 加上 `m1.spike.boot`/`m2.bridge.smoke`/`m2.session`（23/23）回归一次启动全绿——证据见 `hosts/harmony/artifacts/m5-host/` 与 `hosts/harmony/artifacts/m5-primitives/`；本宿主的 `m2.llm` 真实 LLM 腿同样已接通——由启动参数 `aa start … --ps dsh.e2e.leg m2.llm` 选中（该腿单独运行，默认链路因此不消耗任何推理配额），运行未改动的 `runtime/spike/scenario/m2-llm.js`，经同一条 httpFetch 绑定协商出真实腿，并实现本平台强制的凭据交接（运行时写入 0666 占位文件 → 运行脚本 `hdc file send` 覆盖 → 应用导入、如实报告封存状态、运行结束即删除），载体挂载链（`client.selected` → `webclient.mounted` → `ws.connected` → `slot.registered`）已在模拟器上验证；其传输往返已端到端证实——请求经本宿主 httpFetch 离开设备并得到后端响应（真实的 HTTP 429 代码 1310：账户编程套餐配额耗尽，2026-09-22 14:43:53 重置）——因此不宣称已完成一次真实推理：配额恢复后重跑 `hosts/harmony/ci/run-m2-llm.sh` 即可落地（证据 `hosts/harmony/artifacts/m5-m2-llm/`，原始日志的密钥泄漏审计干净）） |

### 上游移植（D9）

上表记录各里程碑以自身证据证明的内容。自决策 [D9](docs/decisions.md) 起，Harness 层本身
不再是自研重实现：上游 DSH 运行时在 quickjs 上**原样**运行——26 个包由
`runtime/spike/vendor/ensure-dsh.sh` pin 并做 sha256 校验（21 个上游 DSH 包
@ 0.1.6-alpha.2 + 5 个 pinned npm 依赖），自研代码只留胶水（垫层、适配器、契约 carrier）。
经 carrier 在 iOS / Android / 鸿蒙上已点亮：官方 client-modules web 启动、官方 App 壳
（#61 的 58 包 application 层）、真实 `session.list`/日志，以及 composer 写入路径。汇总
数字与逐目录清单见 [docs/e2e-matrix.md](docs/e2e-matrix.md)——32 个证据目录、73 条绿色
verdict（另有 2 条因配额阻塞而红，已如实披露）——位于 `hosts/{ios,android,harmony}/artifacts/`（`b1-official-web`、
`b3-session-live`、`b4-write-live`、`android-upstream`、`android-session-live`、
`d9-official-web`、`d9-session-live`、`d9-write-live`）。

## 治理

本仓库由 [govrail](https://github.com/Lixiang9716/govrail) 门禁管理：pre-commit 内容门、推送前 `gov run` 门 DAG、CI 强制（`.github/workflows/gov.yml`），并采用其 `agent-heavy` preset 所描述的多 agent 并行开发实践（`parallel-workers` skill + `verify-decisions` 门）。安装方式 `pip install govrail`，入口命令为 `gov`。

## License

MIT
