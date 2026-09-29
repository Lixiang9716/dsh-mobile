# contract/

**合同冻结交付物——整个项目的第一优先级。状态:FROZEN v1.0.0(2026-09-19,D5),经可加性扩展至 v1.8.0(2026-09-30)。**

本目录冻结之前不得落任何实现代码(D5:contract first)。现在已冻结。

## 内容

| 产物 | 冻结了什么 |
| --- | --- |
| [primitives.md](primitives.md) | 能力网关原语表 v1.8.0——26 个原语(v1.1.0–v1.5.0、v1.8.0 可加),带类型、带权限旗标、带版本;事件通道;审计;符合性(`gateway@1`)· [English](primitives.md) |
| [primitives.d.ts](primitives.d.ts) | 机器可读的原语面(TS 声明) |
| [data-protocols.md](data-protocols.md) | 束布局 · 插件 manifest · 完整性账本 · 安装回执事务 · 能力串文法 · [English](data-protocols.md) |
| [schemas/manifest.schema.json](schemas/manifest.schema.json) | 插件 manifest,`schemaVersion: 1`(JSON Schema 2020-12) |
| [schemas/integrity.schema.json](schemas/integrity.schema.json) | 已安装树摘要账本,`ledgerVersion: 1` |
| [schemas/receipt.schema.json](schemas/receipt.schema.json) | 安装/移除事务回执,`receiptVersion: 1` |
| [proposals/](proposals/) | 争议中的草案增补(D5 提案——未冻结、未实现;已采纳的提案折叠进 [primitives.md](primitives.md)——最新:socket 缝,v1.8.0)· 当前:[事件通道](proposals/2026-09-26-event-channel.md)(v1.6.0 candidate)、[render 面](proposals/2026-09-26-render-surface.md)(v1.7.0 candidate)、[forkpty 面](proposals/2026-09-29-forkpty-face.md)(v1.9.0 candidate)、与[系统能力面](proposals/2026-09-30-system-capability-plane.md)(v1.10.0 candidate) |

## 阅读顺序

1. [primitives.md](primitives.md)——每个宿主实现、每个插件对着协商的服务面。
2. [data-protocols.md](data-protocols.md)——每个宿主存储、每次安装事务写下的数据。
3. Schemas——执行上述两者的校验器。

## 变更纪律

合同按 semver 版本化并被演进门禁:此处冻结的形状在 `1.x` 内不可变;增补是 minor 跳变;任何形状变更都是 major 跳变并附迁移注记(primitives.md §8、data-protocols.md §6)。提案以引用 D5 的 Agent Note 起步——绝不顺手改。
