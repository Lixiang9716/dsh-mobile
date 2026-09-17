# dsh-mobile

DSH（DeepSeek Harness）生态的移动宿主（Mobile Host）。基于社区 Fabric 互操作模型，将移动端实现为 Harness 运行时之上的一个对等宿主：QuickJS 单线程协程运行时承载 Harness 核心，iOS 系统能力以"特权层 / 能力网关 / 系统实现插件"三层封装，UI 以 Web Client 插件形态可插拔。

> 社区独立项目，非 DeepSeek 官方产品。上游生态参考 [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) 与 DSH Community Fabric 草案。

## 文档

- [整体架构方案](docs/ARCHITECTURE.md) —— 分层设计、关键技术决策、里程碑

## 里程碑

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| M0 | 原语契约 v0 + 数据协议三件套（bundle 布局 / manifest / receipt） | 进行中 |
| M1 | Spike：quickjs-ng 垫层跑通纯逻辑包 + iOS 宿主骨架 + 本机 carrier | 计划 |
| M2 | 系统实现插件（fs/subprocess/ui）+ Web Client 挂载 + 真机首次会话 | 计划 |
| M3 | 插件安装链路 + UI 插件化（slot / Web Client 替换） | 计划 |
| M4 | Android 宿主（QuickJS 同构） | 计划 |
| M5 | 鸿蒙宿主（ArkTS + NAPI） | 计划 |

## License

MIT
