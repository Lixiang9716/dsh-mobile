# dsh-mobile

[English](README.md) | 简体中文

DSH（DeepSeek Harness）生态的移动宿主（Mobile Host）。基于社区 Fabric 互操作模型，将移动端实现为 Harness 运行时之上的一个对等宿主：QuickJS 单线程协程运行时承载 Harness 核心，iOS 系统能力以"特权层 / 能力网关 / 系统实现插件"三层封装，UI 以 Web Client 插件形态可插拔。

> 社区独立项目，非 DeepSeek 官方产品。上游生态参考 [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) 与 DSH Community Fabric 草案。

## 文档

- [整体架构方案](docs/ARCHITECTURE.md) —— 分层设计、关键技术决策、里程碑

## 里程碑

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| M0 | 原语契约 v0 + 数据协议三件套（bundle 布局 / manifest / receipt） | 已完成（冻结于 v1.0.0） |
| M1 | Spike：quickjs-ng 垫层跑通纯逻辑包 + iOS 宿主骨架 + 本机 carrier | 已完成（运行时 spike 已在 iOS/Android/鸿蒙 + macOS 验证；本机 carrier——回环静态文件 + WS↔QuickJS 泵——已在 iOS 模拟器验证） |
| M2 | 系统实现插件（fs/subprocess/ui）+ Web Client 挂载 + 首个设备端会话 | 完成（系统插件 + Web Client 挂载 + 首个设备端会话：`dsh-fs`/`dsh-subprocess-quickjs`/`dsh-ui` 插件，`m2.session` 在 CLI 与设备端均 22/22 通过，Web Client `dsh-web-client` 经 carrier WS 挂载并实时渲染 —— 证据见 `runtime/spike/artifacts/macos-cli-m2-session/` 与 `hosts/ios/artifacts/m2-session/`；仍开放：真实 LLM API） |
| M3 | 插件安装链路 + UI 插件化（slot / Web Client 替换） | 进行中（安装链路已在 macOS CLI 以 receipt 事务验证 —— `m3.install` 21/21：内容寻址 blob、信任记录校验、严格 manifest 校验、暂存树读回校验、receipt 提交、被篡改的包在解包前被拒绝且已安装树保持不变 —— 证据见 `runtime/spike/artifacts/macos-cli-m3-install/`；UI 插件化已在设备端验证 —— 按配置切换到 `dsh-web-client-mini` 变体（`m3.ui-swap` 7/7），dsh-notes 的工具栏 slot 实时渲染并回执 —— 证据见 `hosts/ios/artifacts/m3-pluginization/`；仍开放：基于 fetch 的安装器 + pending-receipt 重放、其余 UI 插件层级、真实 LLM API） |
| M4 | Android 宿主（QuickJS 同构） | 进行中（同构宿主已验证：`m2.session`（三个系统插件上的首个 MINI 智能体会话）、网关桥接场景 `m2.bridge.smoke` 与 `m1.spike.boot` 回归一次启动全部在模拟器通过——证据 `hosts/android/artifacts/m4-host/`） |
| M5 | 鸿蒙宿主（ArkTS + NAPI） | 完成（同构宿主已验证：回环载体——向 Web Client 提供静态文件服务 + RFC 6455 WS 泵——ArkWeb 挂载实时会话，真实绑定原语（notify、presentApproval、fsScope app 作用域、`app.state`/`notify.response` 通道），picker/keychain/httpFetch 诚实 `unavailable`，`m5.host-binding` 20/20 加上 `m1.spike.boot`/`m2.bridge.smoke`/`m2.session`（23/23）回归一次启动在模拟器全绿——证据见 `hosts/harmony/artifacts/m5-host/`；仍未完成：HUKS keychain、用户作用域 picker 文件系统、httpFetch 流式传输） |

## 治理

本仓库由 [govrail](https://github.com/Lixiang9716/govrail) 门禁管理：pre-commit 内容门、推送前 `gov run` 门 DAG、CI 强制（`.github/workflows/gov.yml`），并启用 `agent-heavy` preset 支持多 agent 并行开发。安装方式 `pip install govrail`，入口命令为 `gov`。

## License

MIT
