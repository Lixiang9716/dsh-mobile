# 数据协议 — Bundle 布局、Manifest、Receipt、签名目录(v1.2.0)

> **状态:契约冻结阶段冻结**(2026-09-19,决策 D5);**以可加性方式扩展到 v1.1.0**
> (2026-10-01:§7 签名目录——提案
> [2026-10-01-plugin-marketplace.zh.md](proposals/2026-10-01-plugin-marketplace.zh.md),ADOPTED)。
> 这是每个宿主、每个插件构建都必须遵守的四份数据协议。
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

- 四份 schema **独立于原语契约版本化**:manifest 携带 `schemaVersion: 1`,receipt 携带
  `receiptVersion: 1`(integrity 为 `ledgerVersion: 1`),目录索引携带自己的 `schemaVersion: 1`
  (§7)。
- 增补可选字段 = 次版本;任何移除、改型、必填字段新增 = 主版本,并附迁移说明。宿主对
  不理解的主版本的 manifest/receipt/目录 —— 响亮地拒绝(fail-loud 规则),绝不尽力解析。

## 7. 签名目录(v1.1.0 —— 插件市场)

产品身份中的注册表一半是**一份签名的静态 `index.json` 加上托管在普通文件服务(对象存储 /
GitHub Releases)上的包 tarball**。目录是数据,不是服务:无常驻服务进程、无数据库、无账号;
它可以从仓库复现(由 CI 署名,与 vendor pin 表同一纪律)。发现与安装都走冻结的 `httpFetch`
原语;这里不发明任何包格式——目录上的包就是 §1–§4 的格式。提案:
[2026-10-01-plugin-marketplace.zh.md](proposals/2026-10-01-plugin-marketplace.zh.md)(ADOPTED,
owner 2026-10-01 拍板:手机侧 dsh 插件市场,上游插件、本仓库 `system-plugins/` 与 web-client
皮肤同属一种格式)。Schema:
[schemas/marketplace-index.schema.json](schemas/marketplace-index.schema.json)。

```json
{
  "schemaVersion": 1,
  "marketplace": "dsh",
  "generatedAt": "2026-10-01T00:00:00Z",
  "keys": { "dsh-market-1": "ed25519 公钥,base64(32 字节)" },
  "entries": [
    {
      "id": "dsh-office", "version": "0.1.0", "type": "service",
      "tgzUrl": "https://…/packages/dsh-office@0.1.0.tgz",
      "blobSha256": "…", "manifestSha256": "…",
      "capabilities": { "required": ["fsRead"], "optional": [] },
      "summary": { "en": "…", "zh": "…" }
    }
  ],
  "signatures": [ { "key": "dsh-market-1", "value": "ed25519 签名,base64(64 字节)" } ]
}
```

- `entries[]` 只镜像消费方在**下载之前**需要的冻结 manifest 字段;其余都在取包之后从包自带的
  `manifest.json` 读取。这里的 `capabilities` 只是**建议性的展示数据**——包 manifest(§2)
  仍是唯一事实源,授权只发生在安装期、经冻结管线里的 §2 协商。
  `blobSha256`/`manifestSha256` 就是 §4 事务的信任记录。
- `keys` 携带**当前**验证密钥集。`signatures` 平时携带一条 ed25519 签名(RFC 8032
  PureEdDSA),轮换窗口期内携带两条(见下)。

### 7.1 签名规则

- 签名覆盖除 `signatures` 之外全部内容的**规范 JSON**:UTF-8 编码,对象键递归排序(按码元
  字典序),数组保持顺序,无无意义空白。
- **签名即信任。**消费方拒绝一切无法验证的目录,且只信任它钉住过的、或按 §7.2 学到的密钥。
  验签失败、未知签名密钥、目录畸形、条目缺失,全部走安装器既有的 `InstallRejected` 词表
  响亮拒绝——每一条可审计,零暂存。
- 验证公钥由宿主侧钉住,带外进行,与 vendor pin 表同一纪律(密钥轮换是索引事件,不是应用
  升级)。初始钉扎是仓库配置;私钥只存在于签名 CI 环境——绝不入库。

### 7.2 密钥轮换

一次轮换会在一个轮换窗口期内发布由新旧两把密钥共同签名的索引。宿主用它已信任的密钥验证,
然后**学到**新密钥——但只从这种双签且验证通过的索引学:宿主既没钉过、也没见过在已验证索引
上联署的密钥就是未知密钥,仅由它签名的目录会被拒绝。窗口随后关闭:发布的索引去掉旧签名;
观察过窗口的宿主继续工作,从未观察过的宿主(陈旧钉扎)在观察到双签索引之前拒绝窗口后的
目录。学习是会话态,不持久化——重启的宿主回落到钉扎,被攻破的宿主因此无法绕过窗口纪律。

### 7.3 消费流(resolver 缝)

```
marketplace.lookup(id@range?)   → 验证过的目录条目
  → installFromFetch({ url: entry.tgzUrl, id: entry.id,
      trust: { blobSha256, manifestSha256 }, … })     // §4,既有且不改
```

resolver(经 `httpFetch` 取索引 + §7.1 验签 + §7.2 轮换状态 + 条目查找)是唯一的新缝;
§4 安装事务零改动——resolver 把签名的信任记录原样透传,因此被篡改的托管永远产不出可安装的
包(签名覆盖摘要;事务从字节重新推导它们)。

## 8. 通道负载(v1.2.0 —— `channel.payloads@1`)

v1.9.0 事件通道缝的每源封闭 schema([primitives.zh.md](primitives.zh.md) §4「the channel
seam」)。源表随本节版本化:加一个源是此处的次要版本,改既有负载形状是主版本。

| 源 | 负载 | 说明 |
| --- | --- | --- |
| `motion` | `{ ts, accel: { x, y, z }, gyro?: { x, y, z } }` | `ts` 是宿主的 ISO-8601 采样时刻;SI 单位(m/s²、rad/s);平台提供时有 `gyro`——缺失是诚实的,绝不零填充 |
| `battery` | `{ level, state }` | `level` 为 0–1;`state` 为 `"charging" \| "discharging" \| "full"`;仅在变化时投递 |

## 9. Surface 操作词汇(v1.2.0 —— `surface.ops@1`)

v1.10.0 render 面 `surfaceDraw` 的封闭、版本化操作集([primitives.zh.md](primitives.zh.md)
§4「the render surface」)。一个操作列表 = 一帧原子绘制;畸形操作使整次调用失败、上一帧
保留。fold 在提案草稿之上补了 `arc`(首个消费者要创作的正是圆形 UI 类)。加操作或字段是
此处的次要版本;改/删是主版本。

操作按提交顺序:

| 操作 | 字段 | 含义 |
| --- | --- | --- |
| `clear` | `{ op: "clear", color? }` | 填充后备缓冲(默认不透明黑) |
| `setStyle` | `{ op: "setStyle", fill?, stroke?, lineWidth?, font? }` | 后续操作的样式状态;颜色为 `#rrggbb`/`#rrggbbaa`;`font` 为 `<size>px <family>` |
| `fillRect` | `{ op: "fillRect", x, y, w, h }` | 以当前 fill 画轴对齐矩形 |
| `strokePath` | `{ op: "strokePath", d }` | `d` 为子路径数组(见下),以当前 stroke/lineWidth 描边 |
| `fillPath` | `{ op: "fillPath", d }` | 同一子路径数组,填充 |
| `text` | `{ op: "text", x, y, text, baseline? }` | fill 样式文本;`baseline` 为 `"top" \| "middle" \| "bottom"`(v0 默认 `"top"`) |
| `drawImage` | `{ op: "drawImage", path, x, y, w?, h? }` | 解码已授权 fs scope 内的图片并绘制;`path` 相对范围 |

`strokePath` / `fillPath` 的子路径项(`d`):`{ c: "move", x, y }`、`{ c: "line", x, y }`、
`{ c: "quad", cx, cy, x, y }`、`{ c: "arc", x, y, r, start, end, ccw? }`(角度为弧度)、
`{ c: "close" }`。不以 `move` 开头的 `d` 按使整帧 `invalid` 拒绝。
