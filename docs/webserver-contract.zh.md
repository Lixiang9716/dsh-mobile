# `ctx.webServer` 契约与 Phase B 载体对齐方案

[English](webserver-contract.md) | 简体中文

本文是移动载体 web 服务面（决策 D9）的实现规格：我们的载体必须满足
该契约，才能让官方上游 Web UI（`apps/web`，已按原样内置于
[presentation/official-web](../presentation/official-web/)）在移动
WebView 中挂载，且**零上游改动**。内容提取自内嵌 pin 对应的上游源码
（而非文档），文末给出各平台 CarrierServer 的对齐方案与 E2E 取证方案。

**来源**（均读取于 deepseek-ai/deepseek-harness
`ddefc45fbc7f8e46dd73185e68295696d1297887`，tag `dsh-v0.1.6-alpha.2` ——
即 `anywhere-labs/dsh-desktop` 的 `upstream.json`（channels.beta）与其
`deepseek-harness` 子模块 gitlink 双重记录且相互一致的 pin）：

- `packages/host/webserver/src/index.ts` —— `ctx.webServer` 服务
- `packages/host/webserver/src/injections.ts` —— 结构化 index 注入行
- `packages/host/frontend-static/src/index.ts` —— fallback 席位上的
  SPA dist 服务器
- `packages/client/connection/src/` —— `/api` RPC 传输与浏览器鉴权
- `packages/api/gateway/src/` —— `/api/remote.mux` WebSocket
- `packages/client/modules/src/index.ts` —— `/plugins` bundle 路由与
  启动全局注入行
- `packages/bundle/web-app/src/index.ts` —— 官方发行的组合

> 一段话摘要：载体是一个**带路由表的回环 HTTP + WS 端点**。命名路由
> （exact 与 prefix）由各功能方注册；唯一且单主体的**fallback 席位**
> 应答所有未匹配请求——在官方组合中即官方 SPA dist，其 index 经过鉴权
> 门与注入渲染；一张**按精确路径匹配的升级表**分发 WebSocket 连接。
> 匹配次序固定：exact → 最长 prefix → fallback。载体本身不含任何
> harness 概念。

## 1. `webServer` 服务契约

### 1.1 身份与配置

Cordis 服务 `webServer`（`ctx.webServer`），配置 schema（校验失败即
中止激活）：

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `host` | `'127.0.0.1' \| '0.0.0.0'` | 必填 | 仅两个合法值：回环或刻意的全接口暴露。服务器自身不带 TLS/鉴权。 |
| `port` | 自然数 ≤ 65535 | 必填 | `0` 请求系统分配端口；绑定后经 `webServer.port` 读取。 |
| `compression` | `'none' \| 'gzip'` | `'none'` | 对有 socket 的响应可选 gzip；跳过 `content-range` 与 SSE；无 socket 的响应原样传输。 |
| `compressionLevel` | 整数 0–9 | `1` | gzip 开启时的 DEFLATE 级别。 |
| `compressionThresholdBytes` | 自然数 | `1024` | 已知长度低于阈值不压缩；未知长度的流立即符合条件。 |

激活即**立即监听**；监听失败使初始化拒绝，启动流程上报失败 fiber。
下述所有注册均返回 **disposer**；销毁所属 effect/fiber 即撤销注册。

### 1.2 HTTP 路由注册

```ts
interface WebRoute {
  kind: 'exact' | 'prefix'   // 'prefix' p 匹配 p 与 p/<任意>
  path: string               // 绝对路径名，无尾斜杠
  handler: (req, res) => void | Promise<void>  // 拥有完整响应生命周期
}
register(route): () => void
```

- 重复的 `(kind, path)` **抛错** —— 路由模式是组合层契约；冲突是配置
  错误，而非优先级问题。
- handler 可保持响应不关闭（SSE、chunked 流）；webserver 不会对已
  交出的响应设超时或做改写。
- 请求匹配次序固定：**exact 表 → 最长 prefix 胜出 → fallback**。
  注册顺序不影响请求（路由组合后互不相交）。

### 1.3 升级（WebSocket）注册

```ts
interface WebUpgradeRoute {
  path: string               // 精确路径名，无尾斜杠
  handler: (req, socket, head) => void | Promise<void>  // 拥有协商与 socket
}
registerUpgrade(route): () => void
```

- 重复路径抛错：一条 socket 只有一个协议属主。
- 升级仅按**精确路径名**匹配；未匹配的升级 socket 直接销毁。
- 服务跟踪已升级的 socket 并在销毁时显式关闭（它们不在
  `closeAllConnections` 的可见范围内）。
- handler 失败（同步或异步）记录日志并销毁 socket——绝不导致进程
  退出。

### 1.4 fallback 席位

```ts
registerFallback(handler): () => void
```

- **仅一个属主**；第二次注册抛错（"两个 fallback 无法组合"）。
- 应答所有未被命名路由匹配的请求。席位无人认领时服务器应答裸
  **404** —— dist 属主的 fiber 已销毁或尚未激活时浏览器所见即此。
- 官方组合中该席位属于 SPA dist 服务器（§2.1）。对移动载体而言，
  这里就是官方 dist 的挂载点。

### 1.5 index 渲染：结构化注入 + 原始 tap

webserver 不持有文件，但拥有 fallback 属主在每个 index 响应上调用的
**index 渲染管线**：

```ts
tapIndex(transform: (html: string) => string): () => void   // 原生逃生口
collectIndexInjections(): IndexInjection[]   // 一次 'webserver/index-inject' emit
renderIndex(html: string): string            // 先行后 tap，按注册顺序
```

- `webserver/index-inject` 事件的监听者把带类型的行推入可变表；每
  次渲染**现读现取**（活模块图、活主题），顺序为监听者激活顺序。
- 行类型（`IndexInjection`，落点 `head` 或 `body`）：
  `{kind:'global', name, value}` —— `globalThis[name] = value`（JSON，
  转义 `<`）；`{kind:'script'|'script-src'|'script-preload'|'style'|'html', …}`。
- 渲染时把 head 行拼接在 `<head…>` 之后、body 行拼接在 `<body…>`
  之后，再附加启动就绪尾行
  `globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()`。
  客户端入口**先 await `__DSH_BOOT_READY__.promise` 再读取任何注入
  状态** —— 异步 bootstrap 必须在最后一行之后 resolve 该 deferred。

### 1.6 错误姿态

单请求 handler 失败被捕获：记日志 + **400**（若响应头已发出则销毁
响应）。畸形请求永远杀不死进程。升级路径的失败记日志并销毁 socket。

## 2. 官方 UI 所依赖的发行组合

官方页面从线上消费什么，按启动次序排列。这是 Phase B 载体必须复刻
的面（§3）。

### 2.1 fallback 席位 = SPA dist 服务器（`frontend-static`）

配置：仅一值 `distIndex` —— dist 根内 `index.html` 的绝对路径（由
组合解析，绝不由用户配置；我们的载体把它锚定在内置的
`presentation/official-web/dist/index.html`）。

行为，逐字取自源码：

- **方法**：仅 GET/HEAD；fallback 路径上的其他方法是 **405**（命名
  路由各自处理自己的方法）。
- **穿越**：解析出的目标必须留在 dist 根之内——否则 **403**。
- **index**（dist 根或 `distIndex` 路径）：先
  `connection.authorizeIndex`（§2.2），再以
  `renderIndex(readFile(distIndex))` 作为响应体，并附加**一次变换：
  在 `<head…>` 之后拼接 `<base href="/">`**（dist 以相对 base 构建；
  深层 SPA 路径会把资源解析到请求目录之下）。
- **资产**：以固定 MIME 表（`.html`、`.js`、`.css`、`.svg`、`.json`、
  `.map`、`.webmanifest`、`.gz`）从 dist 根直出，其余扩展名一律
  `application/octet-stream`；缺失或非文件目标为空 **404**（仅
  ENOENT/EISDIR/ENOTDIR）。
- 无缓存层、无 etag —— 每个响应都现算。

### 2.2 浏览器鉴权（`connection.authorizeIndex`）

发行组合仅对 **index 响应**设门（静态资产公开），以进程启动令牌
交换：

- `authenticatedUrl(baseUrl)` 把进程启动令牌附加为 `?token=` 查询
  参数 —— 这就是打印/交给浏览器的 URL。
- 携带有效令牌对 `/` 的 GET 会铸造持久签名 cookie（`Set-Cookie`，
  `cookieMaxAgeDays` 默认 30 天，名字绑定 authority）并应答
  **303 → 干净的 `/`**。
- 携带有效 cookie 的请求可取得 index（**200**）。
- 其余请求得到 Connection 属有的极简 **401**。
- 同一信任姿态护卫 `/api`：Host/Origin 检查加令牌或 cookie；失败为
  401（未鉴权）或 403（已鉴权但被拒）。

移动适配注：WebView 加载的是载体控制的回环 URL，完整的签名 cookie
机制可以裁剪 —— 见 §3.4(e)。

### 2.3 `POST /api/<endpoint>` 上的 RPC

`client-connection` 注册一条 **prefix 路由 `/api`**（经 Host/Origin
与鉴权拒绝之后）把 HTTP 桥接到宿主 RPC 注册表：

- 请求信封（JSON 体）：
  `{type:'client-request', rpcId:<uuid>, method:<endpoint>, payload:{args…}}`；
  响应信封：`{type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error:{code,message,details}}}`。
- 浏览器调用方以 `content-type: application/json` POST 到
  `{origin}/api/<endpoint>`；按 `rpcId` 关联；信封或 `rpcId` 不匹配
  即客户端传输失败。
- 默认体积上限：**300 MiB**（`maxRequestBodyBytes`）。
- Typert API 网关拦截 `/api` 端点并分发到带类型的宿主服务（源码中
  观察到的命名空间：`session` —— list/create/prompt/cancel/fork/
  rename/search/page/follow/selectModel/modelCatalog/attachment/
  updateQueue/openWorkspacePath …；`settings`、`credentials`、
  `workspace`、`terminal`、`goals`、`skills`、`fileReferences`、
  `directoryPicker`、`archive`、`typert`）。
- `connection/request` 瀑布允许组合行在桥接前否决或增补请求。

### 2.4 `WS /api/remote.mux` 上的推送

网关在精确路径 `/api/remote.mux` 注册一条**升级路由**（与 `/api`
同样过鉴权；被拒的升级收到 socket 级拒绝，而非 101）。一条物理
WebSocket 复用 N 条逻辑流（`open`/`item`/`cancel`/`error` 帧，心跳
ping），承载：

- **远程事件流**（session/agent/settings/command 事件 —— UI 渲染的
  投影词汇表），
- **session journal 流**（baseline + change 帧 —— token delta 就是
  这样到达页面的），
- **snapshot 流**（状态基线），以及
- `gateway/internal` 控制结果。

这就是 E2E 方案观察的 "ws session attach"。官方页面**不**在 `/ws`
上使用我们的 M2 插件词汇表；它期待此端点。

### 2.5 `GET /plugins/**` 上的模块 bundle

`client-modules` 注册 **prefix 路由 `/plugins`** 服务客户端插件模块
图：`/plugins/<id>/<file>?rev=<rev>` 逐 bundle（含 `.map`），以及
聚合请求 `/plugins/??<resources>&rev=<rev>`。`/plugins` 下的其他一切
（包括 HMR 行缺席时的 `/plugins/events`）都是未知资源 → 404。它还
贡献两个启动全局行（§2.6）——缺了它们页面按设计显示启动失败屏。

### 2.6 官方页面必需的 index 注入行

发行组合中 `webserver/index-inject` 的订阅者 —— 渲染出的 index 必须
含有，就精神而言：

1. `globalThis.__ModuleLoader__`（bootstrap 门面：
   `create({boot, staticModules, loadBundle?})` —— client-modules 的
   内联 script 行），
2. `globalThis.__DSH_BOOT__`（启动清单/插件图 —— client-modules 的
   JSON `global` 行），
3. `globalThis.__DSH_CONNECTION_RECOVERY__`（重连时序配置 ——
   connection），
4. 主题/预览行（ui-theme、文档预览、实验 inspector）—— 页面容忍
   其缺席的可选行，
5. `__DSH_BOOT_READY__` 结算尾行（webserver 作为最后一条 body 行
   自动附加）。

`apps/web` 构建出的 `index.html` 刻意是裸的（仅模块入口 +
modulepreload）；**原样直出什么都启动不了** —— 缺
`window.__ModuleLoader__` 会呈现上游的启动失败屏并带明确错误。因此
index 渲染管线不是可选项。

### 2.7 其他命名路由（完整组合面，非 MVP）

上游组合中存在、我们首轮载体不带：`/api/session/uploadFileBinary`
（POST，文件上传）、`/api/file`（GET，媒体引用）、
`/api/changes.summary` 与 `/api/present.host`（GET，交付物）、
open-in-app 路由（POST open / GET apps / GET icon prefix）、仅开发态
的 HMR SSE 端点 `/plugins/events`、服务器部署的 webhook 端点。命名
路由可组合；载体需要的是路由表本身，不是这些 handler。

## 3. CarrierServer 对齐方案（Phase B 实现规格）

现有载体（`hosts/ios/App/Source/CarrierServer.swift`、
`hosts/android/.../CarrierServer.kt`、
`hosts/harmony/entry/src/main/ets/model/CarrierServer.ets`）是 M1
spike 形态：单回环监听、仅 GET、硬编码 `/ws` 升级、限定
`.html`/`.js` 的目录静态服务、一次性 `Connection: close` 响应、手工
`gateway-e2e` switch、单个 WebSocket 席位。已满足项与各平台为实现 §2
需新增项如下：

### 3.1 已满足

- **回环绑定 + 临时端口** —— iOS `NWListener` 配
  `requiredLocalEndpoint 127.0.0.1:0`；Android/Harmony 等价绑定回环
  接口并上报绑定端口。与 `host: '127.0.0.1', port: 0` 相符（移动上
  唯一合法姿态；绝不暴露 `0.0.0.0`）。
- **从 web 根直出静态文件且拒绝穿越** —— `..` 检查 + 根内相对解析
  符合 §2.1 的安全形状。
- **RFC 6455 升级 + 文本帧 + ping→pong** —— 握手
  （`Sec-WebSocket-Accept` = SHA1(key+magic)）、帧解析器（客户端
  掩码帧、126/127 长度）、close/ping 处理满足 §2.4 的传输层。
- **chunked 流式** —— `gateway-e2e` 端点已在流式发送
  `Transfer-Encoding: chunked`，命名路由 handler 可复用。
- **handler 拥有响应、每连接一炮** —— 合法：契约允许 handler 拥有
  自己的生命周期；不要求 HTTP/1.1 keep-alive（浏览器透明地重开新
  连接）。

### 3.2 路由表（替换硬编码分发）

以本地代码实现 `register`/`registerUpgrade`/`registerFallback` 语义：

- 两张表（exact、prefix）+ 一张升级表 + 一个可选 fallback 槽；
  **重复 (kind, path) 或重复升级路径是致命配置错误**（抛错等价：
  中止激活，响亮失败）。
- 请求匹配：exact → 最长 prefix（prefix 匹配 `p` 与 `p/…`）→
  fallback；**无 fallback 注册 → 404**。
- 以解码后的 URL **pathname** 匹配（去 query；百分号解码一次；坏
  转义 → 400，绝不崩溃）。
- 把现有 `gateway-e2e` switch 与 `dsh-web-client` 静态/`/ws` 布线
  迁到命名路由上：`exact /ws` 升级、`prefix /gateway-e2e` 路由、插件
  `web/` 目录挂 fallback 席位。M2/M3 场景必须保持逐字节绿 —— 同
  路径、同 served 顺序。

### 3.3 升级分发

- 升级仅按**精确路径名**匹配；未知升级目标 → 销毁 socket（iOS：
  cancel 对应 NWConnection；Android/Harmony：close socket）—— 绝不
  落回静态。
- **多个并发 WS 席位**：官方页面开 `/api/remote.mux`，而我们的 M2
  插件词汇表可能仍占着 `/ws`（官方页面也可能重连）。把单一
  `wsConnection` 换成按连接为键的集合；广播 API 变为按路径。宿主面
  的 `send(_:)` 接缝增加路径/路由参数（或句柄对象）—— 这是宿主面
  API 变更，与 Phase B 载体 PR 一并排期。
- 载体停止时显式销毁已升级 socket（三平台上它们都不在"关闭监听
  socket"的覆盖范围内）。

### 3.4 fallback 席位 → 官方 dist

- 逐字实现 §2.1：GET/HEAD → 否则 405；穿越检查 → 403；index 仅在
  dist 根与 `distIndex` 处渲染（深层路径一概 404 —— 上游对缺失路径
  应答 404，深层链接不需要 SPA fallback，`<base href="/">` 加路由器
  自会重锚）；固定 MIME 表 + octet-stream；空 404 体。
- dist 根即分阶段插件目录 `presentation/official-web/dist/`（内置，
  哈希清单在手）。
- **index 渲染管线**（§2.6）：每个 index 响应把注入行拼进内置的
  `index.html` —— head 行在 `<head…>` 后、body 行在 `<body…>` 后、
  `__DSH_BOOT_READY__` 尾行最后、再拼 `<base href="/">`。Phase B
  最小行集：`__ModuleLoader__` + `__DSH_BOOT__`（由分阶段模块图
  生成）+ `__DSH_CONNECTION_RECOVERY__`（静态配置字面量）。行内容由
  载体从分阶段插件集生成 —— 与上游相同的 JSON 形状，不涉上游代码。
- **鉴权精简**（§2.2 的移动适配）：保留 令牌入 URL → cookie 交换
  形状，令牌为每会话随机；持有效 `?token=` 对 `/` 的 GET，设会话
  cookie + 303 到干净 `/`；仅持 cookie 才供 index。WebView 是回环上
  唯一客户端，故完整 BrowserAuth（签名轮换、30 天 cookie、authority
  绑定）后置；在载体 PR 中写明该裁剪。
- **WS 鉴权对齐**：`/api/remote.mux` 升级请求须在握手前通过同一
  cookie 检查（上游以 socket 错误拒绝；移动上直接关 socket 即可）。

### 3.5 POST /api 桥 + 请求体处理

- 今日载体只读请求头；`consumeHTTP` 等价物丢弃请求体。需新增：按
  `Content-Length` 读体至上限（页面 RPC 有 256 KiB 足矣；上游为上传
  允许 300 MiB，Phase B 不服务上传），命名路由上尊重
  `req.method !== 'GET'`（fallback 保持 GET/HEAD → 405）。
- 分发进运行时：RPC 信封（`client-request` / `server-response`）是
  冻结的数据协议（D5）—— 载体把 `payload` 转投运行时队列（线程
  规则：JS 运行时永不接触 socket），以 JSON 信封应答。端点→能力
  映射属 Phase B 网关工作；载体契约只是：解析、转发、应答、畸形
  输入 400、无有效会话 cookie 401。
- 长耗时 RPC 就绪后应答（handler 拥有响应）；页面按 `rpcId` 等待。
  进度走 mux 而非轮询 —— 与 D8 一致。

### 3.6 静态服务泛化

官方 dist 是 89 个文件：`.js`、`.css`、`.woff2`/`.woff`/`.ttf`、
`.svg`、`.webmanifest`、`index.html`。今日 iOS 载体仅服务
`.html`/`.js`，其余 404 —— 页面会无样式启动、字体缺失。要求：§2.1
MIME 表扩充 `.woff2: font/woff2`、`.woff: font/woff`、`.ttf:
font/ttf`、`.png: image/png`（webmanifest 图标），支持 HEAD（仅
响应头），拒绝目录列出（EISDIR → 404）。保持 `Connection: close`。

### 3.7 Phase B 载体明确不做

`compression`（默认 `none`；dist 已压缩、回环带宽免费）、`0.0.0.0`
绑定、HMR `/plugins/events`、webhook 路由、完整签名 cookie
BrowserAuth（见 §3.4 裁剪）、实验 inspector 行。命名路由可组合，
这些后续落地无需再动表。

## 4. E2E 前置：官方应用在日志中可观察的行为

官方页面不可改动以输出 `dsh.spike.log:` 行，因此一对一清单（基于
日志的 E2E，唯一 scenario id，期望 ↔ 日志）由**载体对线缆的观察**加
一条平台侧渲染态探针承载。拟议场景 `b1.official-web.mount`（先 iOS，
后 Android/Harmony），顺序固定：

| # | 事件（载体日志） | 事实来源 |
| --- | --- | --- |
| 1 | `client.selected` = `dsh-web-official` | 宿主配置翻转 |
| 2 | `index.rendered`（`rows=<n>`） | fallback 席位渲染 index（字节数 + 行数确定） |
| 3 | `index.served`（GET /，200） | 请求日志 |
| 4 | `asset.served` 首个资产路径 | 请求日志（确定性首取：入口 chunk） |
| 5 | `upgrade.accepted` path=`/api/remote.mux` | 升级分发 |
| 6 | `rpc.observed` 首个 `POST /api/<endpoint>` | 请求日志（端点名在清单中钉死） |
| 7 | `session.attached` 首条 mux journal/snapshot 流打开 | mux 帧日志 |
| 8 | `token.delta.forwarded` | mux 帧日志（含内容 delta 的 session journal change 帧） |
| 9 | `page.rendered`（探针：平台 `evaluateJavaScript` 等价物断言 transcript DOM 增长，记录布尔值） | 按 M3 先例的渲染态证据，且不改上游代码 |

清单规则：每事件在规范信封中带 scenario id；子集字段匹配器；不缺、
不多。`rpc.observed` 的端点名按清单钉死 —— 首批候选调用在
`session`/`settings`/`typert` 命名空间（见 §2.3）；先抓取一次，再把
观察到的名字冻结进清单，而不是在此预言。

### 官方应用在静态+WS 之外还需要什么（启动 RPC 面）

按 pin 处源码枚举（§2.3–§2.6）：

- `GET /` —— 带注入行的 index（不是裸 dist 文件），
- `GET /plugins/**` —— 客户端模块 bundle（含聚合 `/plugins/??…`
  形式），
- `POST /api/<endpoint>` —— 一元 RPC，信封见 §2.3；命名空间：
  `session`、`settings`、`credentials`、`workspace`、`terminal`、
  `goals`、`skills`、`fileReferences`、`directoryPicker`、`archive`、
  `typert`，
- `WS /api/remote.mux` —— 单条复用推送 socket（远程事件 + session
  journal + snapshot + `gateway/internal`），
- 后续（非 MVP）：`/api/session/uploadFileBinary`（POST）、
  `/api/file`、`/api/changes.summary`、`/api/present.host`（GET）。

只直出 dist、只保留 M2 `/ws` 升级的载体**启动不了官方页面**：没有
`__ModuleLoader__`、没有 `__DSH_BOOT__`、没有 `/api`、没有 mux。该
失败模式即上游启动失败屏 —— 按设计响亮失败。

## 5. 参考

- 内置 dist + 来源记录 + 可复现构建：
  [presentation/official-web/](../presentation/official-web/)（pin
  `ddefc45f…`，tag `dsh-v0.1.6-alpha.2`，89 文件，sha256 清单）。
- 载体拓扑语境：`anywhere-labs/dsh-desktop` `docs/architecture.md`
  —— 回环 HTTP+WS 载体、沙箱化 renderer、同源页面加载（WebView 即
  沙箱）。
- 现有 spike 载体：`hosts/ios/App/Source/CarrierServer.swift`、
  `hosts/android/app/src/main/java/com/dshmobile/spike/CarrierServer.kt`、
  `hosts/harmony/entry/src/main/ets/model/CarrierServer.ets`。
- E2E 清单惯例：`tools/e2e/README.md`、`docs/e2e-matrix.md`。
