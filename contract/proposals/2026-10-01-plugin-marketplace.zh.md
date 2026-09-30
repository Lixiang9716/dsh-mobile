# 提案:插件市场 —— 冻结包格式之上的一层签名目录(data-protocols v1.1.0 candidate)

> **状态:ADOPTED(2026-10-01,owner 拍板:手机侧 dsh 插件市场,包格式就是既有 DSH
> 包格式)——以可加性方式冻结为 data-protocols v1.1.0 §7。**与草案形状的一处差异:单个
> `signature` 对象改为 `signatures` 数组(平时一条,轮换窗口期两条),使双签在同一个冻结
> 形状内可表达。冻结的规则见 [data-protocols.zh.md](../data-protocols.zh.md) §7;机器
> schema 见 [schemas/marketplace-index.schema.json](../schemas/marketplace-index.schema.json)。
> [English](2026-10-01-plugin-marketplace.md) | 简体中文

## 动机

registry 是本仓与产品身份("一个没有预定义身份、由 profile 定义的 app")之间四大具名缺口的第三个:profile-as-app-manifest、**registry**、进程模型、运行时授权。另外三个都已动起来(能力授权随能力面落地;profile 清单有自己的 D5 草案,issue #268);registry 还是空白。

已经存在的 —— 这也是本提案很薄的原因:

- **插件包格式已冻结**(data-protocols.md v1.0.0,D5):`manifest.json`(schema 校验、静态)、逐文件 `integrity.json` 账本、`receipts/` 安装日志、`plugins/<pkg>@<semver>/` 目录布局。
- **M3 安装器已活着**:`install-pipeline.js` 跑完整事务(tgz → sha256 → blob 库 → **信任记录核验** → 解包 → manifest 校验 → 安装期能力协商 → 暂存 → 回读复验 → 提升 → receipt),`install-fetch.js` 已能经流式 `httpFetch` 安装 —— iOS 回环 carrier 的在机 E2E 证实过。
- 安装器自己的头注释点名了缺失的那块:信任记录"**stand in for the signed catalog a real installer consults**(暂代真安装器所查的签名目录)"。

决策(owner,2026-10-01):市场是**手机侧的 dsh 插件市场**,且**插件格式就是既有的 DSH 包格式** —— 上游生态插件、本仓 `system-plugins/`、web-client 皮肤是同一种格式。本文不发明任何包格式。

## 模型(三条规则)

1. **目录是数据,不是服务。** v0 = 一份签名的静态 `index.json` + 普通文件托管上的包 tarball(对象存储 / GitHub Releases)。无常驻服务、无数据库、无账号。手机就是客户端:发现与安装都走冻结的 `httpFetch` 原语过真实网络,与在机 E2E 已经在回环 carrier 上演练的路径完全一致。
2. **签名即信任。** 目录以 **ed25519** 签名;验证公钥按 vendor 钉表的同款纪律钉在宿主侧(密钥轮换是目录事件,不是 app 更新)。每个条目携带安装器已在消费的 `blobSha256` / `manifestSha256` 对 —— 目录签名 + 既有完整性账本,意味着被篡改的托管永远产不出一个可安装的包。
3. **授权发生在安装时,走冻结路径。** 安装期能力协商已经在管线里(`required` 能力宿主答 unavailable 则解包前拒绝)。市场不自建任何授权机制;目录里的 `capabilities` 摘要仅是展示数据,manifest 仍是唯一事实源。

## 目录格式(index.json)

```json
{
  "schemaVersion": 1,
  "marketplace": "dsh",
  "generatedAt": "2026-10-01T00:00:00Z",
  "keys": { "dsh-market-1": "ed25519-pub-base64" },
  "entries": [
    {
      "id": "dsh-office",
      "version": "0.1.0",
      "type": "service",
      "tgzUrl": "https://…/dsh-office@0.1.0.tgz",
      "blobSha256": "…",
      "manifestSha256": "…",
      "capabilities": { "required": ["fsRead", "fsScope"], "optional": [] },
      "summary": { "en": "…", "zh": "…" }
    }
  ],
  "signature": { "key": "dsh-market-1", "value": "ed25519-base64" }
}
```

- `keys` 携带**当前**验证密钥集;轮换时发布一份由旧新两把密钥双签的目录,持续一个轮换窗口后删除旧钥。宿主在带外(仓库配置)钉住初始密钥,只从双签目录学习轮换。
- `entries[]` 镜像安装器与 UI 在**下载前**需要的冻结 manifest 字段;其余一切在拉包后从包内 `manifest.json` 读取。`blobSha256`/`manifestSha256` **就是**管线的信任记录 —— 解析器原样透传。
- 签名覆盖除 `signature` 自身以外的规范化 JSON。

## 安装流(唯一新缝:解析器)

```
marketplace.lookup(id@range?)          → 条目(来自已缓存、已验签的目录)
  → installFromFetch({ url: entry.tgzUrl, id,
      trust: { blobSha256, manifestSha256 }, … })   // 既有,零改动
```

`install-fetch.js` 与 `install-pipeline.js` **不改动**。新代码是一个解析器模块(目录拉取 + 签名校验 + 条目查找 + 缓存失效策略)加一个小的市场 UI 面。拒绝复用安装器既有的 `InstallRejected` 词汇:签名错、密钥未知、完整性不符、条目缺失 —— 每条可审计。

## v0 明确不做(具名非目标)

- **无用户账号。** 发布者 v0 就是 owner 的 token(目录由 CI 从仓库生成,与 vendor 钉表同款);消费者是已 vendor 的匿名设备身份。
- **无常驻市场后端。** 没有可运行的服务、没有可攻击的面;目录可从仓库复现。
- **无评分、支付、搜索基础设施** —— v0 目录很小,整份拉取。
- **无自动更新策略。** 目录暴露版本;profile 是否升级是 profile 策略(归 profile-manifest 提案,#268)。

## 演进(具名,不设计)

- **v1 —— 发布 API:** 第三方经 registry 服务推包。DSH 包是 npm 形态的 tarball,**Verdaccio** 是发布/服务侧的协议兼容捷径,客户端零改动。
- **v2 —— 身份与审核:** 发布者账号挂 OIDC IdP(Logto 级,TS,可自托管)+ Open VSX 式审核模型(元数据 lint + 人工审核分级)。客户端契约不变。

## 备选方案

- **现在就部署 Open VSX / Flathub**(完整市场后端):v0 拒 —— 两者都是重服务栈(Spring/Postgres、FastAPI/Postgres),且围绕**他们的**包元数据模型构建;我们的格式已冻结在别处、安装缝已存在。它们的发布者/审核**模型**是值得抄的部分,放 v2。
- **采用 npm registry 协议作为包格式**:不必要 —— DSH 格式已冻结且本来就是 tarball+manifest 形态;与 npm 工具链的协议兼容(Verdaccio)无论如何都作为 v1 的部署选项保留。
- **不签名、只靠传输层信任(HTTPS)的目录**:拒 —— 那会把托管账号变成单点失陷;ed25519 这一层让信任留在仓库/CI,不落在任何服务器上。

## 验证计划

- 按本仓范式落 `marketplace.install` e2e 腿(scenario-id 日志逐条对账):回环托管目录 + tgz → 验签 → 解析 → `installFromFetch` → receipt;含能力协商拒绝路。
- 篡改阶梯作为反证用例:签名错 / 密钥未知 / 窗口外的轮换钥 / blob 摘要不符 / manifest 摘要不符 —— 每条必须以 `InstallRejected` 拒绝并审计,零暂存。
- 密钥轮换演练:钉着旧钥的宿主接受双签目录;窗口后的单签目录被旧钉子拒绝。

## 版本

data-protocols **v1.1.0 candidate**(additive:目录格式与签名规则扩展冻结的包协议;零新 gateway 原语 —— 全流程骑在 `httpFetch` 与既有安装管线之上)。
