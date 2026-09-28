# 提案:socket 缝——可审计的回环网络与能力分级(v1.8.0 candidate)

> **状态:DRAFT(D5 提案——未冻结、未实现)。**
> [English](2026-09-28-socket-seam.md) | 简体中文

## 动机

上游套件计划(T-0070)把墙量得很准:**有 18 个 spec 被排除,且理由只有一条——冻结的合同没有 socket 原语**(`ssh/ssh` 8、`lsp/lsp-stdio` 5、`ssh/subprocess-ssh` 5)。v1.5.0 时代的子进程缝让宿主拥有了真实的 OS 子进程;这些子进程(_真的 LSP 客户端、测试内起的服务器_)现在需要**真实的 TCP 回环**才能与测试内服务器通话——进程内分发无法承载两个 OS 进程之间的流量。

产品拉力是同一个形状:LSP 集成、MCP-over-TCP 传输、webhook 接收器,全都是"开一扇门、说话、关门"。

本提案添加**最小可审计 socket 缝**:仅回环 TCP、能力分级、过 gateway 审计。它刻意**不是**通用网络能力——见安全模型与具名非目标。

## 安全模型(五条规则)

1. **方向分级。** `connect`(出站)与 `listen`(入站——宿主开门)是不同的授权类。`listen` 危险性严格更高,门禁更严。
2. **三档作用域,默认最窄。** `loopback`(仅 127.0.0.1)→ `lan` → `any-remote`。v0 只出**回环**;更宽的作用域是具名非目标,各配各的授权类。
3. **授权三源头**,复用 v1.5.0 family-flag 机制:安装 profile 时声明所需(manifest,类似 Chrome 扩展);越界调用触发运行时弹窗(类似 Deno 的 `--prompt`);用户可在设置里按 profile 查看/撤销(类似 iOS 本地网络)。
4. **一切过 gateway 审计。** 每次 `listen`/`connect`/accept 记一条(peer、方向、授权来源、字节数)。载荷字节端到端(TLS 直通保持完整);审计只带元数据。
5. **默认会话作用域。** 授权随会话结束失效;持久授权需要用户显式"记住"。

测试套件自身只需要规则 2 里最窄的一档——**零弹窗、零用户交互**,由构造保证。

## 原语(两个,加一条通道)

遵循 v1.1.0–v1.5.0 的可加性规则:没有此缝的 `gateway@1` 宿主按调用逐一应答 `unavailable`,协商保留一切现有底线。

### 1. `socketListen` — 打开回环服务器(授权 `socket.listen.loopback`)

```ts
export type SocketListenRequest = {
  scope: "loopback";              // v0:唯一作用域
  port?: number;                  // 省略 = 宿主挑选空闲端口
};
export declare function socketListen(request: SocketListenRequest): Promise<
  { serverId: string; port: number } | null>;
```

绑定一个回环 TCP 监听。绑定成功即 resolve(返回的 `port` 是事实来源——宿主必须支持挑端口)。用户拒绝授权时 resolve `null`。连接以服务器通道上的事件到达(`connection.accepted` 携带 `connectionId`);数据/关闭经同一通道按连接流转(v1.6.0 缝——无轮询,D8)。

### 2. `socketConnect` — 拨号回环端点(授权 `socket.connect.loopback`)

```ts
export type SocketConnectRequest = {
  scope: "loopback";              // v0:唯一作用域
  host: "127.0.0.1";              // v0 仅字面回环
  port: number;
};
export declare function socketConnect(request: SocketConnectRequest): Promise<
  { connectionId: string } | null>;
```

拨号一个回环 TCP 端点。`connectionId` 标识一条双工流:`connection.write(bytes)`(gateway 调用)+ `connection.data` / `connection.close` 事件(通道)。半关闭表达为 `connection.end()`;对端关闭以 `close` 事件到达,尾随字节先于事件送达。

### 3. `socket` 通道(v1.6.0 事件通道缝)

每个服务器/连接一条通道,承载 `connection.accepted`、`data`、`close`、`error`——与渲染面的帧同一形状。任何地方无轮询(D8)。

## v0 刻意排除的内容(具名非目标)

- **远端 connect / 局域网 / 任意远端 listen**:真实产品能力,配真实的弹窗与撤销 UX——独立授权类,待 v0 验证审计模型后另案提案。
- **TLS 终结**:v0 套接字是裸字节管道;TLS 类流量继续走 `httpFetch`,那边已有完整审计。
- **UDP、组播、Unix domain socket**:具名,未设计。
- **后台监听**:服务器的生命周期与其开启会话等长。

## 备选方案(已考虑并否决)

- **维持只有进程内分发(现状)**:否决——进程内分发无法承载两个 OS 进程之间的流量,而这正是子进程缝创造的形状;被排除的 spec 族就是证据。
- **无门禁的裸 socket**:直接否决——手机侧插件能无授权开门,正是本提案要避免的攻击面。
- **完整 WASI net(Emscripten 风格)**:v0 否决——D16 的理由仍然成立(我们的 `wasmRun` 缝刻意是窄 ABI),而且 JS 侧的表面无论如何都需要合同原语;完整 WASI 宿主是更大的后续,它会**坐在这条原语之上**而非取代它。
- **仅 ish-guest 网络**:互补而非替代——guest 服务的是 Linux 用户态里的程序;本提案服务的是说 node net/http API 方言的 JS 插件。

## 验证计划

- 本缝的第一批交付就是套件自身:18 个 socket 类排除 spec(lsp-stdio ×5、ssh 回环侧 ~8、subprocess-ssh ×5)在 `socket` 授权腿上重新入场。
- 每宿主一条新 e2e 腿:同场景内服务器 + 客户端,再加 子进程 × socket(被 spawn 的 OS 进程拨号测试内服务器)——正是催生本提案的形状。
- 协商底线:三宿主在实现前一律应答 `unavailable`;现有行为零变化。

## 版本

v1.8.0 candidate(可加性:两个原语 + 一条通道;授权类复用 v1.5.0 family-flag 机制)。
