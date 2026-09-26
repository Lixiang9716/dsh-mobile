# 提案：事件通道接缝——设备数据源走一对订阅原语（v1.6.0 候选）

> **状态：DRAFT（D5 提案——未冻结任何内容，未实现任何内容）。**
> [English](2026-09-26-event-channel.md) | 简体中文

## 动机

契约已有三条固定事件通道（§5：`app.state`、`notify.response`、`timer.fire`），
以及一类它完全无法承载的设备数据源。设备面提案（v1.5.0，已折叠）在自己的
Alternatives 一节点了名：*"CoreMotion 事件流同样需要一个类似 `timer.fire`
的通道形态——一旦有消费者，就是很好的 v1.6.0 候选。"* 如今消费者已经有了
两个：

1. **渲染面**（`2026-09-26-render-surface.md`，v1.7.0 候选）就指定在本接缝
   之上：它的 `surface.frame` 帧泵与 `surface.input` 输入流是通道，不是调用
   ——D8 禁止轮询，而渲染循环是全系统最密集的事件生产者。
2. **agent 自己。** 被问到设备的运动、姿态或一段时间的电量时，上游 agent
   只能拿一次性的 `deviceInfo` 作答；它创作的游戏则完全读不到倾斜角。

本提案是修复工作的 contract-first 形态（D5）：**一对订阅原语**架在一张
封闭、带版本的数据源表上——不是每个数据源一条原语，更绝不是第二个不受
治理的事件面。

## 原语（两条，外加一个通道）

全部遵循 v1.1.0–v1.5.0 的增量规则：没有该接缝的 `gateway@1` 宿主照常协商，
对每条原语答 `unavailable`。

### 1. `channelOpen`——订阅一个数据源（权限 `channel`）

```ts
export type ChannelSource = "motion" | "battery";
export declare function channelOpen(source: ChannelSource, opts?: {
  hz?: number;      // 仅 motion；宿主 clamp 到其声明区间
  tag?: string;     // 调用方选定的审计标签，timer 先例
}): Promise<{ channelId: number }>;
```

订阅 **已武装** 时即 resolve，而非数据开始流动时——与 `timerSchedule` 的
姿态完全一致。`channelId` 为不透明整数，仅在存活订阅间唯一。对同一数据源
再次 `channelOpen` 是一条新订阅（扇出合法）；v0 对每个调用方的存活订阅数
设宿主声明的小上限，超限以 `invalid` 拒绝。

### 2. `channelClose`——退订（权限 `channel`）

```ts
export declare function channelClose(channelId: number): Promise<{ closed: boolean }>;
```

幂等，`timerCancel` 形态：对未知或已关闭的 id 返回 `{ closed: false }`。

### 通道：`channel.event`（宿主 → 插件，§5 表扩展）

`{ channelId, source, seq, payload }`——像所有宿主事件一样送达调用方的串行
队列。payload 是**按数据源封闭的 schema**，fold 时在 `data-protocols.md`
定稿：`motion` 携带带时间戳的加速度/旋转采样；`battery` 在变化时携带电量
与状态。两条承重的投递规则：

- **负载下最新者胜，缺口可见。** 串行队列落后时，宿主合并积压采样、只送
  最新一条，并让 `seq` 越过被丢弃的编号。跟不上的消费者降级为更低的
  *有效* 帧率、配诚实的序列号——绝不降级为不断增长的队列
  （`surfaceDraw` 序列号规则的推广）。
- **挂起期间不投递。** 进入后台的宿主暂停投递，并在描述符说明中写明；
  D7 的 checkpoint 承载会话，**从不承载活的订阅**——调用方在恢复后重新
  open。

## 权限与审计摘要

| 原语 / 通道 | 权限标志 | 审批 | 审计载荷 |
| --- | --- | --- | --- |
| `channelOpen` | `channel` | —（需要 OS 权限弹窗的数据源不在范围内，见 §8） | source + hz + tag |
| `channelClose` | `channel` | — | channelId |
| `channel.event` | （武装状态） | — | **不逐事件审计**——见诚实性说明 |

**审计诚实性（`ishRun` 规则，§6/§7）。** 逐事件审计不存在，也绝不许伪装：
宿主 clamp 后的运动流每秒产出的记录比任何审计落点该承载的都多。留痕是
open/close 记录，加上消费者观察到的 `seq` 连续性。提供本原语的宿主在
描述符中说明：事件*投递*没有逐调用审计——旗标门控的是*订阅*，那才是
控制点。

## fold 时的宿主可用性

iOS 实现两个数据源（CoreMotion 设备运动——未滤波的加速度计/陀螺仪不需要
OS 权限弹窗——以及经 `UIDevice.batteryState` 通知的电量）；Android 映射
（`SensorManager` 与粘性的 `BatteryManager` 广播）；HarmonyOS 映射（传感器
与电池信息 kit）。**任何宿主都不被要求实现任何数据源**——descriptor 就是
差别，任何地方都没有 `hostType` 分支。

## 已考虑的替代方案

- **每个数据源一条原语（`motionRead`、`batteryWatch`……）**——拒绝：
  一个形状被拆成 N 条原语；数据源表才是带版本的接口面，原语对在其上
  保持稳定。
- **轮询（每帧一次 `motionRead()`）**——直接拒绝：违反 D8（耗电、采样
  竞态），而且会把渲染面的帧泵变成变相轮询。
- **一个通用的 `onEvent(handler)` 全局量**——拒绝：那是第二个不受治理的
  表面（与 v1.4.0 拒绝全局 `setTimeout` 同一条理由）；每条流都必须是
  一条可打开、可拒绝、可审计的订阅，架在封闭的数据源表上。
- **把本提案并入渲染面提案**——拒绝：渲染面依赖接缝，接缝不依赖渲染面。
  先落通道，让每次折叠的评审都保持与自己想法相当的体量，也让 motion、
  battery 这些数据源能在没有任何 UI 依赖的情况下落地。
- **需要 OS 权限弹窗的传感器源（位置、相机、麦克风、活动）**——明确不在：
  设备面的遴选规则适用，且每个权限生命周期都值得一轮自己的设计
  （v1.5.0 折叠的 §8）。此处的 `motion` 仅指无需权限的设备运动类。

## 证据基础

需求记录在 v1.5.0 折叠自身（上面引用的 Alternatives 推迟），消费者已经
指明：渲染面提案的 `surface.frame`/`surface.input` 通道是本接缝的第一批
调用方，而在飞的 canvas 游戏 E2E leg 是帧泵动机的第一个端到端运行。其余
证据来自上游 agent 自身的行为：它追问一段时间内的设备运动与电量，却没有
能读其中任何一个的原语。
