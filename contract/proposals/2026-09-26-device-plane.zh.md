# 提案:设备面(device plane)——六个平台 SDK 原语(v1.5.0 候选)

> **状态:草案(D5 提案——未冻结、未实现)。**
> [English](2026-09-26-device-plane.md) | 简体中文

## 动机

iOS 宿主已有十六个原语,覆盖存储、网络、密钥、呈现与计算——但没有任何平台自身的
设备面。创造模式客户端把需求变得具体:全屏鲸鱼查看器希望亮屏期间屏幕不熄灭;
agent 被问到设备事实(电量、屏幕、语言区域)时无从回答;无法给出触感反馈;无法把
交付物交给其他 App(系统分享);无法读写剪贴板。所有者的指示(2026-09-26)是把
系统 SDK 功能接入 iOS 系统插件——本提案就是该工作的契约先行形态(D5)。

筛选规则与最小集分析和契约 §1 一致:每个原语必须 (a) 是 agent 真实需要的,
(b) 用现有十六个无法伪造或不安全,(c) 可以被用户点名拒绝的能力。定位、相机、
麦克风、传感器、通讯录、完整相册权限要么过不了此刻的 (c),要么其 OS 授权流程
值得单独一轮设计——本提案**明确不含**(见"备选方案")。

## 原语(六个,一个扩展形状)

全部遵循 v1.1.0–v1.4.0 的增量规则:没有该缝隙的 `gateway@1` 宿主照常协商、
逐个回答 `unavailable`。权限旗标沿用 timer 先例:每个能力族一个旗标,声明在
RuntimeDescriptor 的 `available` 列表里,每次调用都进审计。

### 1. `deviceInfo` —— 只读设备事实(无权限旗标)

```ts
export type DeviceInfo = {
  platform: "ios" | "android" | "harmonyos" | "macos" | "linux" | "windows";
  model: string;            // 宿主上报的机型名
  osVersion: string;        // 如 "26.5"
  appVersion: string;       // 宿主 App 自身版本
  screen: { width: number; height: number; scale: number };
  battery?: { level: number; state: "charging" | "unplugged" | "full" | "unknown" };
  lowPowerMode?: boolean;
  locale: string;           // BCP-47
  timezone: string;         // IANA
};
export declare function deviceInfo(): Promise<DeviceInfo>;
```

无权限:这些是任何网页 UA 串都携带的同类事实,外加电量(宿主可以省略该字段——
`battery` 在 OS 隐藏它时保持 `undefined`,与 UIKit 自身策略一致)。

### 2. `haptic` —— 一次触感提示(权限 `haptic`)

```ts
export type HapticPattern =
  | "light" | "medium" | "heavy" | "rigid" | "soft"   // UIImpactFeedbackGenerator
  | "selection"                                        // UISelectionFeedbackGenerator
  | "success" | "warning" | "error";                   // UINotificationFeedbackGenerator
export declare function haptic(pattern: HapticPattern): Promise<void>;
```

用户可感知的效果而非数据:一次调用一次提示。Android 对应 `VibrationEffect`,
HarmonyOS 对应 `@ohos.vibrator`。

### 3. `clipboardRead` / 4. `clipboardWrite`(权限 `clipboard`)

```ts
export declare function clipboardRead(): Promise<
  { kind: "text"; text: string } | null>;
export declare function clipboardWrite(text: string): Promise<void>;
```

读是安全敏感方向(agent 外泄用户复制的密码只差一次调用),因此
`clipboardRead` 额外**默认需要审批**:宿主把它送到与 `presentApproval` 同一
呈现面,除非用户授予常驻权限(密钥的"机密只经治理的调用离开"规则的应用)。
两次调用都按原语名审计;读的审计**不携带**文本。

### 5. `presentShare` —— 把载荷交给系统分享面板(权限 `share`)

```ts
export type SharePayload =
  | { kind: "text"; text: string }
  | { kind: "url"; url: string }
  | { kind: "files"; paths: string[] };   // 已授权 scope 内的路径
export declare function presentShare(payload: SharePayload): Promise<
  { shared: boolean }>;
```

系统分享面板就是 OS 自己的信任边界:宿主交出载荷,只知道面板完成,不知道去向。
`files` 路径通过与 `fsRead` 相同的 scope 纪律解析(scope 之外 → `denied`)。

### 6. `keepAwake` —— 保持亮屏(权限 `screen`)

```ts
export declare function keepAwake(hold: boolean): Promise<void>;
```

布尔闩锁(非租约):创造模式查看器是第一个调用方——鲸鱼查看器打开期间持屏、
关闭时释放。没有闲置计时器的宿主回答 `unavailable`。

### 扩展形状:`presentPicker` 增加 `mode: "media"`

```ts
export type PickerRequest = {
  mode: "file" | "directory" | "media"; suggestedName?: string };
```

`media` 呈现平台媒体选择器(iOS `PHPickerViewController`、Android
`PhotoPicker`、HarmonyOS `PhotoViewPicker`),与文件选择器同一方式返回
scope 句柄——经 scope 读取、不接触相册库。这是既有原语上的字段扩展,
按 §8 同一增量规则。

## 权限与审计摘要

| 原语 | 权限旗标 | 审批 | 审计载荷 |
| --- | --- | --- | --- |
| `deviceInfo` | — | — | 调用 + platform |
| `haptic` | `haptic` | — | pattern |
| `clipboardRead` | `clipboard` | 默认开启 | 仅调用(绝不携带文本) |
| `clipboardWrite` | `clipboard` | — | kind + 长度 |
| `presentShare` | `share` | — 每次调用(面板即同意面) | kind(+ 文件数) |
| `keepAwake` | `screen` | — | hold |
| `presentShare` files / picker `media` | 沿用 fs scope 规则 | — | paths |

## 折叠时的宿主可用性

iOS 全部实现(UIKit);Android 全部可映射(`VibrationEffect`、
`ClipboardManager`、`Intent.ACTION_SEND`、`FLAG_KEEP_SCREEN_ON`、`Build` 的
设备信息);HarmonyOS 可映射五个(vibrator、pasteboard、`startAbility` 分享、
`keepScreenOn`、deviceInfo),`keepAwake` 可延后。不要求任何宿主实现——
这正是协商存在的意义。

## 备选方案

- **一个 `system.*` 大杂烩 RPC**(通用 `callService(name, args)`)——否决:
  那是第二个不受治理的面(契约拒绝全局 `setTimeout` 的同一推理);每个能力
  都必须是可点名、可拒绝、可审计的原语。
- **现在就做定位/相机/麦克风/传感器**——延后:每个都要求 OS 授权提示,其
  生命周期(设置里授予、会话中撤销)值得单独一轮设计,且都不阻塞本提案服务的
  创造模式工作。CoreMotion 事件流还需要类似 `timer.fire` 的通道形状——有了
  消费方之后是很好的 v1.6.0 候选。
- **剪贴板读不设审批**——否决:审批闸门就是"agent 能读你复制的内容"与
  "agent 能读你复制的内容,一次,且你知情"之间的区别。
- **`deviceEvents` 订阅流**(电量/屏幕变化)——随传感器一起延后;
  `deviceInfo` 设计上是一次读取(不做跨模块边界轮询,D8)。

## 证据基础

创造模式客户端(web-client-next、web-client-whale)随 #220/#221 落到全部三个
宿主;鲸鱼查看器的持屏需求与 composer 无法分享交付物文件是两个具体诉求。
上游 agent 自身的行为补齐其余:它会问出无法获得的设备事实,会提出无法兑现的
触感反馈。
