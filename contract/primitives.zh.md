# 能力网关 — 原语契约 v1.1.0

> **状态:M0 冻结**(2026-09-19,决策 D5)。本文档中的形状在主版本 1 的整个生命周期内不可变。
> 演进策略见 [§8](#8-版本与演进)。机器可读接口:[primitives.d.ts](primitives.d.ts)。
> [English](primitives.md) | 简体中文
>
> **v1.1.0(增量,2026-09-22)**:五个文件系统操作,上游文件工具需要它们——
> `fsStat`、`fsList`、`fsMkdir`、`fsRemove`、`fsRename`(见下表与 §4「文件系统新增」)。
> v1.0.0 的九个原语未被改动,因此未实现这些新增的 `gateway@1` 宿主仍按原样协商,
> 并把它们报为 `unavailable`——按 §8 的定义,这是一次次要版本提升,而非新主版本。

这是四个平台(iOS / Android / HarmonyOS / 桌面互通)共同的服务基础:**能力网关的窄原语表**。
每个宿主实现同一张表;它之上的一切——上游 Harness 包、系统实现插件、Web Client——看到的都是
同一个服务面,平台差异一律通过能力协商表达。平台分支(`hostType` 条件分支,RFC 0002 反模式)
在构造上即被禁止:没有可分支的东西。

## 1. 模型

- 网关**由宿主固定,永远不是插件**。它是 JS 运行时与平台之间唯一的门。
- 一条**原语** = 一个类型化的封闭请求/响应形状的操作,带一个权限位,强制审计。没有上帝接口。
- 每条原语都是**异步的**(Promise 进,Promise 出),完成时派发回运行时的串行队列。桥接是
  异步事件边界(D8),任何东西都不阻塞运行时线程。
- 调用**只能由运行时线程代表调用者身份发起**(即运行时正在执行的插件 id)。网关信任运行时
  提供的调用者身份,并在派发前检查调用者协商到的权限。
- 原语操作服务于*插件可达*的工作。宿主自身的簿记(profile 存储、检查点、blob 缓存)属于
  宿主内部事务,不表达为原语。

## 2. v0 表(9 条原语)

| # | 原语 | 用途 | 权限位 | 流式 |
| --- | --- | --- | --- | --- |
| 1 | `fsRead` | 读取授权范围内的文件 | `fsRead` | 否 |
| 2 | `fsWrite` | 在授权范围内创建 / 覆盖 / 追加文件 | `fsWrite` | 否 |
| 3 | `fsScope` | 将用户授予的范围访问持久化、跨启动恢复 | `fsScope` | 否 |
| 4 | `httpFetch` | 经宿主网络栈发起 HTTP 请求 | `httpFetch` | 响应体 |
| 5 | `notify` | 调度本地通知 | `notify` | 否 |
| 6 | `presentApproval` | 原生审批对话框;兼作检查点边界 | `presentApproval` | 否 |
| 7 | `presentPicker` | 原生文件 / 目录选择器;成功即授予一个范围 | `presentPicker` | 否 |
| 8 | `keychainGet` | 按不透明引用读取凭据 | `keychainGet` | 否 |
| 9 | `keychainSet` | 按不透明引用写入或删除凭据 | `keychainSet` | 否 |

**v1.1.0 新增(5 个)**——上游文件工具(`@deepseek-ai/dsh-tool-fs` 经由
`@deepseek-ai/dsh-fs-local`)在每次解析、stat、列目录、编辑与原子写入时执行的操作。
它们复用既有的 `fsRead` / `fsWrite` 权限旗标,因此无需协商新的能力:

| # | 原语 | 用途 | 权限旗标 | 流 |
| --- | --- | --- | --- | --- |
| 10 | `fsStat` | 对授权范围内的路径做 stat | `fsRead` | 否 |
| 11 | `fsList` | 列出授权范围内的一个目录 | `fsRead` | 否 |
| 12 | `fsMkdir` | 在授权范围内递归创建目录 | `fsWrite` | 否 |
| 13 | `fsRemove` | 删除授权范围内的文件或目录 | `fsWrite` | 否 |
| 14 | `fsRename` | 在授权范围内重命名或移动 | `fsWrite` | 否 |

保留标识符:范围句柄 `"app"` 表示宿主自己的 profile 容器(存储布局见
[data-protocols.md](data-protocols.md));能力名 `gateway` 指本契约自身。

## 3. 签名约定

适用于每条原语;完整类型见 [primitives.d.ts](primitives.d.ts)。

- **字节**是 `Uint8Array`。**路径**是 POSIX 风格、相对于范围根的(`"logs/a.jsonl"`);
  逃逸范围根的路径按 `invalid` 拒绝。**句柄与引用**(范围句柄、持久化范围引用、凭据引用、
  通知 id)是**不透明字符串**——宿主定义其形式,调用者视作令牌。**时间戳**是 ISO-8601 UTC
  字符串。
- **错误**以结构化 `GatewayError` 拒绝:

  | 代码 | 含义 |
  | --- | --- |
  | `denied` | 调用者缺少该权限位(协商或用户策略) |
  | `unavailable` | 平台无法提供该原语;能力协商本应拦下——见到此码说明插件跳过了必需能力检查 |
  | `invalid` | 参数不合法(坏路径、坏引用、超大负载) |
  | `io` | 文件系统层失败 |
  | `network` | 传输层失败 |
  | `timeout` | 宿主声明的期限已到 |
  | `cancelled` | 用户或系统中止了操作 |

  未知的错误码对调用是致命的,必须响亮地上抛——接收方绝不在不认识的错误码上静默回退
  (fail-loud 规则)。
- **用户放弃是值,不是错误**:用户离开时 `presentPicker` 以 `null` resolve、
  `presentApproval` 以 `{ approved: false }` resolve;`cancelled` 保留给系统发起的中止。

## 4. 原语语义

### fsRead / fsWrite / fsScope

- `fsRead(scope, path) → { bytes, mtime }` —— 读取整个文件。v0 **没有流式读取**;宿主声明
  最大文件尺寸,超限按 `invalid` 拒绝(流式读取是次版本增补的候选)。
- `fsWrite(scope, path, bytes, opts?) → { written }` —— `opts.append` 追加,`opts.create`
  (默认 `true`)允许创建。
- `fsScope.persist(scope) → { ref }` / `fsScope.resolve(ref) → { scope }` —— 让用户授予的
  范围(来自 `presentPicker`)在重启后仍然可用。各平台映射到各自的原生机制(iOS
  security-scoped bookmark,Android SAF 持久化授权,HarmonyOS 等价物)。宿主可以回收不再
  能解析的引用;解析失败以 `io` 拒绝。

### 文件系统新增(v1.1.0)

以下五个操作存在的原因很直接:上游文件工具离开它们无法工作——
`@deepseek-ai/dsh-fs-local` 在读写之前先解析、stat 与列目录,它的原子写入路径会创建
一个同目录临时文件再 rename。路径沿用 `fsRead`/`fsWrite` 的 scope 相对 POSIX 规则,
逃出 scope 根的路径在任何宿主调用**之前**即被拒绝为 `invalid`。

- `fsStat(scope, path) → { kind, size, mtime }`——`kind` 为 `"file"` | `"dir"` | `"other"`;
  `size` 为字节数(目录为 0);`mtime` 为 ISO-8601 UTC。路径不存在时以 `io` 拒绝,
  消息中给出该路径——调用方靠消息而非第二个错误码区分「不存在」与「读不到」,
  因为在每个宿主上 `io` 本就覆盖两者。
- `fsList(scope, path) → { entries: [{ name, kind }] }`——只列一层,**不**递归;
  `entries` 按 `name`(字节序)排序,使同一目录在各宿主上得到确定的顺序。
  `name` 是路径最后一段;`kind` 使用 `fsStat` 的词表。
- `fsMkdir(scope, path, opts?) → {}`——创建目录及缺失的父级;目录已存在时成功
  (`opts.existing: "ok" | "error"`,默认 `"ok"`,即工具依赖的 `mkdir -p` 行为)。
- `fsRemove(scope, path, opts?) → {}`——删除文件,或带 `opts.recursive: true` 删除目录树。
  路径不存在时由 `opts.missing: "ok" | "error"` 决定(默认 `"ok"`)。
- `fsRename(scope, from, to) → {}`——在 scope 内移动;`from` 不存在以 `io` 拒绝,
  已存在的 `to` 会被替换(POSIX rename 语义),原子写入依赖这一点。

不实现列目录的宿主可以把 `fsList` 报为 `unavailable`,其余照常服务;
需要列目录的调用方必须把它当作能力缺口,而不是可重试的错误。

### httpFetch

- `httpFetch(url, init?) → { status, headers, body, abort() }` —— 响应**体是字节块的异步
  可迭代对象**:一条事件序列,绝不是阻塞式的整结果(D8)。请求 `body` 同样可以是字节数组
  或异步可迭代对象(上传流式)。
- `abort()` 取消进行中的请求;挂起的 `httpFetch` promise 以 `cancelled` 拒绝。重定向与
  超时策略采用宿主默认值;v0 不暴露。

### notify

- `notify(payload) → { id }` —— 调度**本地**通知(推送摄取是宿主能力,不是原语)。用户与
  通知的交互经 `notify.response` 事件通道(§5)送达。

### presentApproval / presentPicker

- `presentApproval(req) → { approved, remember? }` —— 原生审批面。审批挂起期间宿主**可以
  对运行时做检查点**:审批挂起中发生后台挂起,必须退化为本地通知后恢复,而不是数据丢失(D7)。
- `presentPicker(req) → { scope, path } | null` —— `mode: "file" | "directory"`。成功时宿主
  授予一个可配合 fs 原语使用的 `ScopeHandle`;用户取消 resolve `null`,不授予任何东西。

### keychainGet / keychainSet

- 凭据按不透明 `KeyRef` 寻址(manifest 声明的凭据引用存放在 profile 的 `state/` 中)。
  未设置的引用 `keychainGet` resolve `null`。
- `keychainSet(ref, secret)` 写入;`keychainSet(ref, null)` 删除。机密是字节;字符串编码
  是调用者的事。

## 5. 事件通道

由桥接派发到运行时队列——不是按调用计的原语,但属于本契约、随其一起版本化:

| 通道 | 负载 | 用途 |
| --- | --- | --- |
| `app.state` | `{ state: "foreground" \| "background" }` | 驱动检查点 / 恢复(D7) |
| `notify.response` | `{ id, action? }` | 用户与通知发生了交互 |

某次 `httpFetch` 调用的流式进度经该调用的响应体送达,不走全局通道。

## 6. 权限与审计

- 每条原语的权限位是一个**能力字符串**,文法为 `<name>` 或 `<name>@<major>`
  (如 `fsWrite`、`gateway@1`)。插件在 manifest 的 `capabilities.required` /
  `capabilities.optional` 中声明([data-protocols.md](data-protocols.md));网关在派发前检查。
- **审计是强制的、宿主固定的**:每次调用,宿主记录原语名、调用者身份、权限判定、结果码——
  绝不记录负载内容。审计落点由宿主定义,但必须是结构化记录,不是散文。

## 7. 符合性

一个宿主符合 `gateway@1`,当且仅当:

1. 它以本文档的形状实现**全部九条原语**,或在 `RuntimeDescriptor` 中诚实地将缺失的原语
   声明为 `unavailable`——缺席是给协商的信息,绝不伪装(ARCHITECTURE.md §12);
2. 它执行权限位检查,并产出 §6 的审计记录;
3. 它送达 §5 的通道,并且每次调用都以派发回运行时队列收尾;
4. 平台特有行为藏在同一张表后面——符合的宿主不添加本契约之外的原语,不在其上添加条件分支。

平台映射说明属于各宿主(`hosts/<platform>/`),不属于本契约。

## 8. 版本与演进

- 本契约按 **semver** 版本化;本文档冻结 `1.0.0`。协商字符串只含主位:`gateway@1`。
- **次版本**(`1.x`):新增原语或事件通道、新增可选请求字段。已冻结的调用点继续工作;
  新接口面通过协商按需启用。
- **主版本**(`2.0.0`):对既有形状的任何修改、移除或重编号。需要新的契约文档与迁移说明。
- 留给未来次版本的候选(明确**不在** v0):剪贴板、分享面板、生物识别、地理位置、流式
  fs 读取、fs 监视。克制正是窄表的意义;每一项增补都必须拿协商数据论证其必要性。
