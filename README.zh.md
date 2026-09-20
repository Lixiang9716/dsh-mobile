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
| M3 | 插件安装链路 + UI 插件化（三级 UI 插件、能力协商） | 完成（安装 = 冻结 fs 原语上的 receipt 事务 —— `m3.install` 在 CLI 22/22：内容寻址 blob、信任记录校验、严格 manifest 校验、对照 RuntimeDescriptor 的安装期能力协商、暂存树读回校验、receipt 提交、被篡改的包在解包前被拒绝；基于 FETCH 的安装器把 httpFetch 流式 body 送入同一条流水线 —— CLI 用带日志的桩 `m3.complete` 41/41（`runtime/spike/artifacts/macos-cli-m3-complete/`），设备端直接对回环 carrier 本身用真实 `httpFetch` `m3.fetch-install` 46/46 + carrier 证据 `m3.fetch-carrier` 11/11（`hosts/ios/artifacts/m3-complete/`），并包含 append-only receipt 日志上的 pending-receipt 启动重放（暂存树可验证 → 提交；暂存不完整 → 回滚且已安装树不动）；三级 UI 插件均在设备端验证 —— 配置层（`cordis.patch` 分层覆盖）选择活动 Web Client 并覆盖工具栏 slot 集合，另有整客户端替换与组件 slot（`m3.ui-swap` 7/7，`hosts/ios/artifacts/m3-pluginization/`）；回归 `m2.session` CLI + 设备端 23/23，`run-ios.sh` 4/4） |
| M4 | Android 宿主（QuickJS 同构） | 进行中（同构宿主已验证：`m2.session`（三个系统插件上的首个 MINI 智能体会话）、网关桥接场景 `m2.bridge.smoke` 与 `m1.spike.boot` 回归一次启动全部在模拟器通过——证据 `hosts/android/artifacts/m4-host/`） |
| M5 | 鸿蒙宿主（ArkTS + NAPI） | 进行中（同构宿主已验证：`m2.session`（经 registry + 三个系统插件）随 `m1.spike.boot` + `m2.bridge.smoke` 一次启动在模拟器通过——证据见 `hosts/harmony/artifacts/m5-host/`） |

## 治理

本仓库由 [govrail](https://github.com/Lixiang9716/govrail) 门禁管理：pre-commit 内容门、推送前 `gov run` 门 DAG、CI 强制（`.github/workflows/gov.yml`），并启用 `agent-heavy` preset 支持多 agent 并行开发。安装方式 `pip install govrail`，入口命令为 `gov`。

## License

MIT
