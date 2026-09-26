# 提案：渲染面——面向 agent 创作图形的原生 present surface（v1.7.0 候选）

> **状态：DRAFT（D5 提案——未冻结任何内容，未实现任何内容）。**
> [English](2026-09-26-render-surface.md) | 简体中文

## 动机

creation-mode 客户端（web-client-next、web-client-whale；#214/#218/#220/#221）
已经为 agent 打通了视觉作品的交付路径：`write` + `present` → 创作卡片 → 全屏
查看器。今天，查看器把每件作品都作为 HTML 渲染在 Web Client 的沙箱 iframe
里（`sandbox="allow-scripts"`）——这是正确的下限，并且已经可以承载计划中的
第一个游戏内容（canvas 游戏 E2E leg 正在飞行中，作为本提案的证据运行）。

但它同时也是一个天花板，由三面实测过的墙构成：

1. **被驱动的 WebView 会节流定时器。** iOS 驱动层在
   `hosts/ios/App/Source/NextWebRuntime.swift:15-17` 记录了这一点：所有等待
   都必须在 Swift 侧轮询，正是因为被驱动的 WKWebView 不再触发页面定时器。
   跑在那个页面里的游戏循环，帧率任由节流摆布。
2. **没有持续帧率保证，也没有 3D。** WebView 的 canvas 与整个页面争抢内存，
   拿不到 vsync 契约；WebGL 上下文在内存压力下会丢失。原生 surface 拥有
   自己的渲染循环。
3. **宿主自己的 device-plane 工作止步于玻璃。** `haptic`、`keepAwake`
   （v1.5.0）都与游戏相关，但它们喂给的是一个无法保证游戏所需帧节奏的
   WebView 页面。

本提案是修复工作的 contract-first 形态（D5）：一个 agent（或任何插件）可以
打开、绘制、关闭的**原生渲染面**——引擎是宿主的实现细节，永远不进合同名。
它是 **v1.7.0 候选**，因为它的输入与帧管线架在 v1.6.0 事件通道接缝上（见
`2026-09-26-event-channel.md`）：D8 禁止轮询，而渲染循环是全系统最密集的
事件生产者。

## 原语（三个，外加两个通道）

全部遵循 v1.1.0–v1.5.0 的增量规则：没有该接缝的 `gateway@1` 宿主照常协商，
对每个原语答 `unavailable`。Web Client 的创作查看器保持为协商下限——不提供
原生面的宿主仍然服务已呈现的作品；本提案抬高的是天花板，不动下限。

### 1. `presentSurface`——打开 surface（权限 `surface`）

```ts
export type SurfaceRequest = {
  kind: "canvas2d";              // v0：仅一种立即模式 2D kind
  title?: string;                // 宿主 chrome（导航标题、无障碍）
  pixelRatio?: "native";         // 宿主默认取设备缩放
};
export declare function presentSurface(request: SurfaceRequest): Promise<
  { surfaceId: string; width: number; height: number; scale: number } | null>;
```

呈现一个宿主原生的全屏渲染面（与创作查看器相同的呈现姿态：位于 Web Client
之上、用户可关闭）。surface 上屏后 resolve；用户 dismissing 时 resolve
`null`（§3 的"用户取消是值不是错误"规则）。已有一个 surface 打开时再次
`presentSurface` 也 resolve `null`——v0 是单 surface，宁可软失败也不排队。

### 2. `surfaceDraw`——提交一个原子帧（权限 `surface`）

```ts
export declare function surfaceDraw(surfaceId: string, ops: DrawOp[]): Promise<
  { presented: boolean }>;
```

立即模式：op 列表被解析到后备缓冲并**原子呈现**（双缓冲；一个畸形 op 使
整次调用失败，上一帧保持不变）。v0 的 op 词表——`clear`、`fillRect`、
`strokePath`（move/line/quad/close）、`text`、`setStyle`（fill/stroke/
lineWidth/font）、`drawImage`（来自已授权 fs scope）——是封闭集合，fold
时在 `data-protocols.md` 里像那里的每个数据协议一样带版本地定稿。每次调用
带序列号，宿主据此丢弃过期帧而不是排队：跟不上的插件降级为更低帧率，
绝不降级为延迟。

### 3. `closeSurface`——关闭 surface（权限 `surface`）

```ts
export declare function closeSurface(surfaceId: string): Promise<void>;
```

幂等：关闭已关闭（或未知）的 surface 正常 resolve。

### 通道：`surface.frame`（宿主 → 插件）

走 v1.6.0 通道接缝投递，每个被请求的动画帧一个事件，**且仅在插件要求时**——
`surfaceDraw` 的任一 op 带 `animate: true` 标志即武装帧泵，下一次不带该
标志的 `surfaceDraw` 解除武装。不武装就没有事件：一张静态图零帧成本。
事件只携带 `{ surfaceId, timestamp, dropped }`——没有别的，因为画了什么
插件自己知道。

### 通道：`surface.input`（宿主 → 插件）

触摸（begin/move/end，坐标已变换到 surface 空间），以及平台提供的键盘
事件。仅在 surface 打开期间投递。**输入事件的审计记录只带 kind 与计数，
绝不带载荷**（触摸序列可以携带用户键入的文本，与剪贴板同理）。

## 权限与审计摘要

| 原语 / 通道 | 权限标志 | 审批 | 审计载荷 |
| --- | --- | --- | --- |
| `presentSurface` | `surface` | —（打开 surface 本身就是用户可见动作） | kind + title 长度 |
| `surfaceDraw` | `surface` | — | op 数 + 序列号 |
| `closeSurface` | `surface` | — | surfaceId |
| `surface.frame` | （武装状态） | — | 仅 surfaceId + timestamp |
| `surface.input` | `surface` | — | 事件 kind + 计数，绝无载荷 |

## fold 时的宿主可用性

iOS 实现全部三个原语（`canvas2d` 用 SpriteKit 或 CoreGraphics 支撑层）加
两个通道；Android 映射（SurfaceView + Canvas，Choreographer 驱动帧泵）；
HarmonyOS 映射（XComponent + Canvas，ArkTS 回调）。**任何宿主都不被要求
实现它们**——descriptor 就是差别，Web Client 查看器是下限，任何地方都没有
`hostType` 分支（RFC 0002 反模式）。

## 已考虑的替代方案

- **用引擎命名原语（`cocosRun`、`spriteKitRun`）**——拒绝：D16 对 `ishRun`
  的记录教训（"平台中立的合同不应命名某一个引擎"）。surface 才是能力；
  SpriteKit、Skia 或别的什么都是宿主自己的事。
- **纯 Web 路线（把现状当天花板而非下限）**——作为完整答案拒绝：上面三面
  实测的墙。保留为每个宿主都已服务的协商下限。
- **`wasmRun` 之后的 WASI 图形**——暂时拒绝：WASM 接缝按构造是纯函数 ABI
  （D16 替代方案一节），在它上面做图形 ABI 是独立的一大工程（surface 生命
  周期、输入、GPU 寻址）——等 wasm 工具链计划的前两层落地后再回头。
- **首个实现就嵌入完整第三方引擎（Cocos、Godot）**——v0 拒绝：50–100 MB
  二进制、脚本层 JIT 合法性需在 iOS 上实测（jitless-V8 教训，D16），而
  对本项目最具决定性的是——creation-mode 的 agent 擅长创作的不是 IDE 工程
  文件（场景文件）。agent 创作路线需要的是立即模式 op 列表，不是引擎工程。
- **保留式场景图而非立即模式 op**——推迟：合同面严格更大而 v0 没有消费者；
  op 列表正是 agent 自然产出的形状（`canvas2d` 代码编译出来的就是它），
  场景图日后可以在不破坏 `gateway@1` 协商（仅 major）的前提下叠加。

## 证据基础

creation 链路已在三个宿主上（#214/#218/#220/#221），whale 查看器已经演示了
本提案所形式化的呈现姿态。被驱动定时器的节流记录在它逼出来的 iOS 驱动源码
里（`NextWebRuntime.swift:15-17`，Swift 侧 `pollPage`）。canvas 游戏 E2E
leg——viewer 里第一个 `requestAnimationFrame` 工件——是帧泵动机的在飞证据
运行；其余证据来自上游 agent 自身的行为：让它做个游戏，它就写一个，而它
目前唯一能跑的地方是一页被节流的 WebView。
