# 数据协议 — Bundle 布局、Manifest、Receipt(v1.0.0)

> **状态:M0 冻结**(2026-09-19,决策 D5)。这是每个宿主、每个插件构建都必须遵守的三份数据协议。
> 机器可读 schema 见 [schemas/](schemas/)。配套文档:[primitives.md](primitives.zh.md)。
> [English](data-protocols.md) | 简体中文

## 1. Bundle 布局

已安装的插件是 profile 下一个自包含目录:

```
profiles/<name>/
├── profile.json
├── cordis.patch.yml
├── plugins/<pkg>@<semver>/
│   ├── manifest.json          # 静态 manifest(§2)—— schema:schemas/manifest.schema.json
│   ├── integrity.json         # 逐文件摘要账本(§3)—— schema:schemas/integrity.schema.json
│   ├── bundle/                # JS ESM 源码(代码即数据),入口由 manifest 指定
│   └── web/                   # Web Client 静态资源;仅 type "web-client" 存在
├── receipts/                  # 安装/移除事务日志(§4)
├── sessions/*.jsonl
└── state/
```

- `<pkg>` 是 manifest 的 `id`,`<semver>` 是 manifest 的 `version`——每个版本一个目录,
  降级与并存因此都是纯数据操作。
- `bundle/` 源码由宿主的 ESM loader 读取;宿主可将其预编译为字节码放进 `cache/blobs/`;
  该缓存可再生,不承载任何权威性。
- `receipts/` 日志(事务记录,§4)是对 ARCHITECTURE.md §7 存储图景的扩展;sessions 与
  state 仍按该节的规定。

## 2. 插件 Manifest

`manifest.json` 是**静态的**:读取它绝不能执行代码。Schema:
[schemas/manifest.schema.json](schemas/manifest.schema.json)。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `schemaVersion` | integer | manifest schema 版本,本冻结中为 `1`(§6) |
| `id` | string | 包身份,如 `dsh-fs-ios`;跨版本稳定 |
| `version` | string | 本包的 semver 2.0.0 |
| `type` | `"service"` \| `"web-client"` | service = JS 实现插件;web-client = 完整 Web Client 插件 |
| `entry` | string | 相对 `bundle/` 的 ESM 入口(`service` 必填) |
| `web` | string | 相对包根的静态资源目录(`web-client` 必填) |
| `capabilities` | object | `required[]` / `optional[]` 能力字符串(§5) |
| `hooks` | object | 可选的 `activate` / `deactivate` ESM 导出名——确定性生命周期 |

语义:

- **协商**:仅当宿主 `RuntimeDescriptor` 满足全部 `capabilities.required` 时才激活插件;
  `optional` 项在存在时调整行为。宿主自身的能力面包含 `gateway@1`(原语契约)及其声明的
  原语。请求宿主已声明 unavailable 之原语的 manifest 协商失败——可见地失败,绝不静默。
- **生命周期**:`activate` 在协商通过后运行;`deactivate` 在卸载前运行。钩子是入口模块的
  普通命名导出,各调用一次,按序,无重入。
- **隔离**:每插件一个 QuickJS 运行时,零共享;一切平台访问都经网关原语
  ([primitives.md](primitives.zh.md))。

## 3. 完整性账本

`integrity.json` 覆盖已安装树的每一个文件,使任何宿主都能在不信任传输的前提下校验任何
安装。Schema:[schemas/integrity.schema.json](schemas/integrity.schema.json)。

- `algorithm`:`"sha256"`(v1 中唯一取值)。
- `files`:包根相对路径 → 小写十六进制摘要的映射。
- `manifestSha256`:`manifest.json` 本身的摘要(也出现在 `files` 中)。

重算摘要与 `integrity.json` 不符的树即视为损坏:宿主拒绝激活,并指出不匹配的路径。

## 4. 安装事务与 Receipt

安装是**内容寻址、崩溃安全的事务**(对齐上游 `desktopPnpm.installPlugin` 的
recovery-receipt 语义):

1. 取得包 tgz → 计算摘要 → 存入 `cache/blobs/<sha256>`;
2. 校验摘要;不符则在解包之前中止;
3. 原子解包到 `plugins/<pkg>@<semver>/`,并按包内 `integrity.json` 复验;
4. 把 receipt 追加进 `receipts/` —— receipt 的写入即**提交点**。

receipt 是记录性日志;schema:[schemas/receipt.schema.json](schemas/receipt.schema.json)。

- `status: "pending"` —— 步骤 1–3 被打断(崩溃、断电)。宿主启动时重放每一条 pending
  receipt:暂存树校验通过则完成安装,否则回滚并把 receipt 标为 `rolled-back`。宿主绝不
  留下未经检查的 pending receipt。
- `status: "committed"` —— 已安装树是权威的;`previousVersion` 记录被替换者(全新安装
  为 `null`)。
- `action: "remove"` —— 对称:摘除目录树,receipt 记录被移除的 `version` 与
  `previousVersion` 供审计。
- receipt 只追加;改写或删除已提交的 receipt 是违反契约。

## 5. 能力字符串文法

与原语契约共享:`<name>` 或 `<name>@<major>`。名字为小写字母数字与 `-`/`.`。保留名:
`gateway`(本契约集,如 `gateway@1`);[primitives.md](primitives.zh.md) 的每条原语权限位
都是合法能力名。

## 6. 版本化

- 三份 schema **独立于原语契约版本化**:manifest 携带 `schemaVersion: 1`,receipt 携带
  `receiptVersion: 1`(integrity 为 `ledgerVersion: 1`)。
- 增补可选字段 = 次版本;任何移除、改型、必填字段新增 = 主版本,并附迁移说明。宿主对
  不理解的主版本的 manifest/receipt —— 响亮地拒绝(fail-loud 规则),绝不尽力解析。
