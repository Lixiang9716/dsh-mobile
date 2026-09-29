# 提案:系统能力面——相机、麦克风与 BLE 站在同一套 OS 权限模型之下(v1.10.0 candidate)

> **状态:DRAFT(D5 提案——未冻结、未实现)。**
> [English](2026-09-30-system-capability-plane.md) | 简体中文

## 动机

这份合同为这一轮预留过两次。device-plane 的冻结(v1.5.0)在自己的 §8 里点名了被推迟的面:*"Location、camera、microphone、sensors、contacts 与完整 Photos 库访问仍然排除在外——每一个都要求 OS 权限弹窗,其生命周期值得属于自己的一轮设计。"* 事件通道提案(v1.6.0 candidate)为它的源表重复了同一条收敛规则:需要 OS 权限弹窗的传感器源*"明确排除——每一个权限生命周期都值得属于自己的一轮设计。"* 现在,这一轮到了。

消费者与其他每条缝回应的是同一个:能*看*(把相机对着的东西捕获进会话)、能*听*(把音频流给会话内转写器)、能*够到*(与手机旁边的 BLE 设备对话)的 agent,今天没有任何原语可用——媒体选择器(v1.5.0)只够到用户亲手挑的照片,一次性 `deviceInfo` 载不动相机帧、麦克风采样或附近设备。v1.6.0 缝早已携带设备流的投递纪律;缺的正是它底下那层能力层。

本提案添加**系统能力面**:三个 OS 权限背书的能力族——相机、麦克风、BLE——站在一套授权模型之下,一切过 gateway 审计。owner 指令(2026-09-30)把 v1 范围定为三族全量:

1. **相机**——拍照**突发**(`cameraCapture`)是 v1 实现面。**连续帧流**与**录像**的接口形状在本提案中设计并**分期**:形状随本合同落地,实现作为各自的后续变更——不砍形状,只分期交付。
2. **麦克风**——流式音频帧走 v1.6.0 事件通道缝:`micStart`/`micStop` 控制 + 帧事件序列(D8:禁轮询,禁阻塞整结果 API)。
3. **蓝牙**——**仅 BLE**:扫描、连接、GATT read/write 与 notify(notify 走事件)。Classic 蓝牙是具名非目标。

## 授权模型(五条规则)

1. **每能力一个授权族,复用 v1.5.0 family-flag 机制。** 三个能力串——`camera`、`microphone`、`ble`——是兄弟,不是任何东西的复制品:持有一个绝不意味着其他;profile 在 manifest 里声明它们(`capabilities.required` / `capabilities.optional`),与 v1.0.0 以来的每个旗标完全一致。gateway 在派发前检查。
2. **两层同意,gateway 在先。** gateway 授权与 OS 权限是两个不同的层。没有该族授权的调用者拿到运行时审批弹窗(与 `presentApproval` 同一面——socket 缝的"范围外调用弹窗"规则);只有在 gateway 层被用户批准过的调用者才会到达 OS 弹窗。宿主把 OS 层的拒绝映射为 `denied`,审计记录写明是哪一层拒绝——两层互不替代。
3. **默认会话作用域;撤销是活的。** 授权随会话死亡;持久授权需要用户明确的"记住"(clipboardRead 常驻授权的姿态,v1.5.0)。用户可在设置面按 profile 审查与撤销(socket 缝的第三个授权来源),撤销立即生效:打开的流被关闭(麦克风停止、相机工作结束、BLE 连接断开),后续调用 reject `denied`——响亮失败,绝不静默降级。
4. **一切过 gateway 审计。** 每次调用记一条(调用者身份、权限判定、结果),并扩展本面存在的理由所指向的三个字段:**方向**(什么流向哪里——捕获入、音频入、GATT read 还是 write、扫描)、**时长**(麦克风流与扫描在停止时记录其墙钟跨度)、**字节数**(帧、GATT 载荷、照片大小记数——绝不记内容)。像素、音频采样与 GATT 值是载荷字节;审计带它们的数量,不带它们的字节。
5. **仅前台会话。** 不有任何形式的 background 捕获:宿主在退到后台时挂起投递与捕获(事件通道缝的 no-delivery-while-suspended 规则,从投递扩展到捕获),D7 checkpoint 携带会话、绝不携带活流,且不申请任何宿主模式 entitlement(background audio、bluetooth-central)。会话持有能力多久,用户就看见 OS 捕获指示灯多久。

## 原语(十一个,外加两条通道——另有两个形状分期)

全部遵循 v1.1.0–v1.5.0 的可加性规则:没有实现该面的 `gateway@1` 宿主保持协商,对每次调用答 `unavailable`。能力协商仍是唯一的平台差异——任何地方都没有 `hostType` 分支。

### 1. `cameraCapture` —— 一次拍照突发(授权 `camera`)—— v1 实现面

```ts
export type CameraCaptureRequest = {
  count?: number;          // 突发张数,默认 1;宿主收敛到声明范围
  format?: "jpeg";         // v0:一个封闭格式,冻结时细化
  flash?: "off" | "auto" | "on";   // 宿主可遵守、收敛,或以诚实元数据忽略
  maxBytes?: number;       // 每帧上限;超限的帧被丢弃,绝不截断
  tag?: string;            // 调用者自选审计标签,timer 先例
};
export type CapturedPhoto = {
  scope: ScopeHandle;      // 宿主自有捕获 scope,经 fs 原语读回
  path: string;            // scope 相对路径,fsRead 纪律
  bytes: number;           // 供审计字节数用的尺寸
  width: number;
  height: number;
  format: "jpeg";
  capturedAt: string;      // ISO-8601 UTC
};
export declare function cameraCapture(request?: CameraCaptureRequest): Promise<
  { photos: CapturedPhoto[] } | null>;
```

从设备相机捕获 `count` 张一突的照片,每一张落入宿主的捕获 scope——与 v1.5.0 媒体选择器(`mode: "media"`)相同的 read-through-scope 姿态:像素是 fs 原语可读的普通文件,相机永远不是裸像素管道。每一帧捕获完成即 resolve;任一同意层的用户拒绝 resolve `null`;无相机的设备 reject `unavailable`(协商本该抓到的能力缺口)。整个突发是一次调用、一条审计记录(张数、总字节、时长、闪光灯决策)。

### 2. `cameraFramesOpen` / `cameraFrameClose` —— 连续预览帧(授权 `camera`)—— 形状现在,实现分期

流走 v1.6.0 缝自己的订阅对,而非新的控制原语:`channelOpen` 在其封闭、版本化的源表里新增 `"camera"` **源**,`hz` 收敛到宿主声明的范围,逐源封闭 schema(带时间戳、带尺寸的帧*引用*——落入捕获 scope 的句柄,绝不是裸像素过通道)在冻结时写入 `data-protocols.md`,与 `motion`、`battery` 完全同路。`cameraFrameClose` 即 `channelClose`。**形状属于本提案;实现排在拍照突发之后分期交付**——届时之前,`gateway@1` 宿主对 `"camera"` 源答 `unavailable`,缝的其余一切不动。

### 3. `cameraRecordStart` / `cameraRecordStop` —— 录像(授权 `camera`)—— 形状现在,实现分期

```ts
export type CameraRecordRequest = {
  maxDurationMs?: number;  // 宿主收敛到声明范围
  withAudio?: boolean;     // 为真时同时要求 `microphone` 授权
};
export declare function cameraRecordStart(request?: CameraRecordRequest): Promise<
  { recordingId: string } | null>;
export declare function cameraRecordStop(recordingId: string): Promise<
  { recording: CapturedPhoto }>;   // 一个文件,同一 scope 纪律
```

仅形状——**分期实现,第一条实现线的非目标**。现在把它们设计进来,是为了 v1 的形状不封死 v2 的路:录像是捕获 scope 里的一个文件(fs 纪律),带音轨要求两族授权同时在手(两层规则应用两次),`cameraRecordStop` 携带审计所记的时长与字节数,授权被撤销时进行中的录像被停止(规则 3)。

### 4. `micStart` / `micStop` —— 流式音频(授权 `microphone`)—— v1

```ts
export type MicStartRequest = {
  format?: "pcm-s16le";    // v0:一个封闭格式,冻结时细化
  sampleRate?: number;     // 宿主收敛到声明范围
  channels?: number;       // 默认 1
  frameMs?: number;        // 分块,默认宿主声明
  tag?: string;            // 审计标签
};
export declare function micStart(request?: MicStartRequest): Promise<
  { streamId: string } | null>;
export declare function micStop(streamId: string): Promise<
  { stopped: boolean; durationMs: number; bytes: number }>;
```

`micStart` 在流**armed**时 resolve,而不是在音频流动时——`timerSchedule` 姿态。`micStop` 幂等(未知或已停止的 id 得 `{ stopped: false }`,`timerCancel` 形状),并且是携带该流时长与字节数供审计用的那条记录。撤销(规则 3)在宿主侧停流;消费者从 `end` 事件观察到。

### 5. `mic.frame` 通道(v1.6.0 事件通道缝)—— v1

每流一条通道,携带:

- `{ streamId, kind: "frame", seq, bytes }` —— 一块音频一个事件,消费者按协商格式解码;
- `{ streamId, kind: "end", reason: "stopped" | "revoked" | "interrupted" }` —— 流结束时恰好发布一次。

缝的投递规则适用,外加一处诚实适配:音频块是顺序敏感的采样,合并规则退化为**压力下丢最旧**——宿主保持有界环,`seq` 越过被丢的帧前进,跟不上的消费者看见诚实的 `seq` 缺口,绝不是越排越长的队列。挂起时不投递(规则 5);事件像每个宿主事件一样派发到调用者的串行队列(D2、D8)。

### 6. BLE 面 —— 扫描、连接、GATT(授权 `ble`)—— v1

八个调用,每个一条审计记录(方向 + 有字节流动处记字节数):

```ts
export type BleScanRequest = {
  serviceUuids?: string[]; // 广播服务过滤;省略 = 全部
  timeoutMs?: number;      // 宿主收敛;扫描到时也会自终
  tag?: string;
};
export declare function bleScanStart(request?: BleScanRequest): Promise<
  { scanId: string } | null>;
export declare function bleScanStop(scanId: string): Promise<{ stopped: boolean }>;

export declare function bleConnect(deviceId: string): Promise<
  { connectionId: string } | null>;
export declare function bleDisconnect(connectionId: string): Promise<
  { closed: boolean }>;

export declare function bleRead(connectionId: string, service: string,
  characteristic: string): Promise<{ bytes: Uint8Array }>;
export declare function bleWrite(connectionId: string, service: string,
  characteristic: string, bytes: Uint8Array,
  opts?: { response?: boolean }): Promise<{ written: boolean }>;
export declare function bleSubscribe(connectionId: string, service: string,
  characteristic: string): Promise<{ subscribed: boolean }>;
export declare function bleUnsubscribe(connectionId: string, service: string,
  characteristic: string): Promise<{ subscribed: boolean }>;
```

- **扫描**是 armed,不是 performed:`bleScanStart` 在无线电扫描 armed 时 resolve(`micStart` 姿态),设备以事件到达,扫描在 `timeoutMs` 或 `bleScanStop` 时结束。`deviceId` 是宿主从扫描铸造的不透明串——令牌,绝不是调用者去解析的地址。
- **连接**在 GATT 链路建立后 resolve `{ connectionId }`,用户拒绝或设备走开 resolve `null`;`bleDisconnect` 幂等。
- **GATT** read/write 以 `(connectionId, service, characteristic)` 寻址——不透明 UUID 串,宿主校验;`bleWrite` 的 `opts.response` 选择带响应写与不带响应写。`bleSubscribe`武装 notify;值以事件到达,绝不轮询(D8)。
- **撤销**(规则 3)断开该 profile 持有的所有连接、停掉所有扫描;消费者从 `disconnect` 事件观察到。

### 7. `ble.event` 通道(v1.6.0 事件通道缝)—— v1

每个 BLE 会话对象一条通道(一个扫描或一个连接,socket 缝的 one-channel-per-server 姿态),携带:

- `{ scanId, kind: "device", deviceId, name?, rssi, serviceUuids? }` —— 一批广播一个事件,扫描的数据面;
- `{ connectionId, kind: "notify", service, characteristic, bytes }` —— 一个通知载荷一个事件;
- `{ connectionId, kind: "disconnect", reason }` —— 链路断开时恰好发布一次(对端走开、宿主撤销、无线电丢失)。

任何地方都不轮询(D8);事件派发到串行队列(D2)。

## 权限与审计一览

| 原语 / 通道 | 授权族 | 同意 | 审计记录 |
| --- | --- | --- | --- |
| `cameraCapture` | `camera` | gateway 弹窗 → OS 弹窗 | 张数、总字节、时长、闪光灯 |
| `channelOpen("camera")` | `camera` | gateway 弹窗 → OS 弹窗 | source + hz + tag |
| `cameraRecordStart` / `Stop` | `camera`(`withAudio` 时 +`microphone`)| gateway 弹窗 → OS 弹窗 | 停止时的时长、字节数 |
| `micStart` / `micStop` | `microphone` | gateway 弹窗 → OS 弹窗 | 停止时的时长 + 字节 |
| `mic.frame` | (armed 状态)| — | **不逐帧审计**——见诚实注记 |
| `bleScanStart` / `Stop` | `ble` | gateway 弹窗 → OS 弹窗 | 停止时的扫描跨度 |
| `bleConnect` / `Disconnect` | `ble` | gateway 弹窗 → OS 弹窗 | 设备令牌、结果 |
| `bleRead` / `bleWrite` | `ble` | —(连接授权)| 方向 + 字节数 |
| `bleSubscribe` / `Unsubscribe` | `ble` | —(连接授权)| characteristic 三元组 |
| `ble.event` | (armed 状态)| — | **不逐事件审计**——见诚实注记 |

**审计诚实(`ishRun` 规则,§6;事件通道的逐事件规则)。** 逐帧与逐通知的审计不存在,也绝不容许伪装:宿主收敛速率下的麦克风与活跃的 BLE 链路,每秒产生的记录比任何审计汇该承载的都多。轨迹是 open/close、start/stop、connect/disconnect 与 subscribe 记录——带时长与字节数——外加消费者观察到的 `seq`/事件连续性。提供本面的宿主在 descriptor 里写明事件*投递*不经逐调用审计;授权门禁的是*能力*,每一次*调用*才携带记录。

## 宿主可用性与 OS 声明

不要求任何宿主实现任何族——descriptor 就是差异,任何地方都没有 `hostType` 分支。提供某族的宿主必须携带下表中该族的 OS 声明;缺声明的宿主在 descriptor 里声明该能力缺席(缺席即信息,§7),因为缺声明是构建期事实,不是该崩溃的运行时错误。

**附录:逐宿主 OS 权限声明清单**

| 能力 | iOS(`Info.plist`)| Android(manifest + 运行时)| HarmonyOS(`module.json5`)|
| --- | --- | --- | --- |
| `camera` | `NSCameraUsageDescription` | `android.permission.CAMERA`(运行时请求)| `ohos.permission.CAMERA` |
| `microphone` | `NSMicrophoneUsageDescription` | `android.permission.RECORD_AUDIO`(运行时请求)| `ohos.permission.MICROPHONE` |
| `ble` | `NSBluetoothAlwaysUsageDescription`(仅当部署目标仍在读时保留遗留 `NSBluetoothPeripheralUsageDescription`)| API 31+:`android.permission.BLUETOOTH_SCAN` + `android.permission.BLUETOOTH_CONNECT`(运行时请求);遗留 API ≤ 30:`BLUETOOTH` + `BLUETOOTH_ADMIN` | `ohos.permission.ACCESS_BLUETOOTH`(外加 OS 与发现绑定的定位权限,当 SDK 镜像要求时)|

本仓库的宿主今天一个都未声明(`hosts/ios/App/Info.plist` 无 usage-description 键;Android manifest 带 `INTERNET`、`POST_NOTIFICATIONS`、`VIBRATE`;Harmony module 带 `INTERNET`、`VIBRATE`、`READ_PASTEBOARD`)——每条实现线只添加自己那几行,用户在 OS 弹窗读到的文案是宿主自有 chrome,不是合同面。

## v1 刻意排除的内容(具名非目标)

- **录像实现**:形状已在上方指定(分期);第一条实现线只交付拍照突发。
- **Classic 蓝牙**(SPP/SCO/A2DP profile):不同的授权族、不同的风险形状——音频路由与通往不可发现对端的裸字节管道;具名,不设计。仅 BLE。
- **后台 / 常驻捕获**:不申请任何 background mode,任何流不比它的会话活得久(规则 5)——退后台即挂起,不是功能。
- **裸相机控制**(手动曝光、对焦、RAW 格式):突发是 v1 面;旋钮式 API 是另一份提案。
- **location、sensors、contacts、完整 Photos 库访问**:**v2 编队**——每一个都点名留给自己那轮 OS 权限设计,此处一概不设计。本提案刻意不为它们定尺寸;收敛正是窄表的意义(§8)。

## 备选审视

- **一个抓袋原语(`systemCapture(action, args)`)**——最强烈的否决,device-plane 自己的理由:能力必须可单独拒绝、可单独审计;抓袋掩盖一次调用行使了哪个能力。
- **麦克风与 BLE 只做 `channelOpen` 源**(不设专用 start/stop/connect 原语)——审视后否决:缝的 `channelOpen` opts(`{ hz, tag }`)载不动音频格式、扫描过滤或 GATT 三元组,而带 OS 生命周期的权限弹窗需要显式控制调用来审计。forkpty 面立下了本提案遵循的先例:专用控制面站在缝的投递规则之上。
- **照片字节走 gateway 响应**——否决:载荷字节走 fs scope 纪律(媒体选择器先例);审计带数量,绝不带像素。
- **为完整性纳入 Classic 蓝牙**——v1 否决:它让权限面翻倍,而创作侧需求没有要求那些能力;把它具名为非目标让这一轮保持诚实。
- **等到 v2 把六族一起设计**——否决:三族今天就有在案需求与已定型的投递缝;编队保持排队,它们的设计轮到来时会引用自己的证据。

## 验证计划

- 先立协商地板:实现前三宿主对每一族答 `unavailable`;现有行为一概不变。三条实现线(相机、麦克风、BLE)以本提案为栈基分出,按族落地,并带逐平台 manifest 钉住每宿主的诚实面(device-plane 场景模式:一个平台中立场景,逐宿主 expected↔logged manifest)。
- 每族 E2E 以结构化日志断言,唯一 `scenario-id`:拍照突发(帧落入捕获 scope 并经 `fsRead` 读回)、麦克风流(`start → seq 连续帧 → stop`,stop 记录的时长/字节)、BLE(扫描 → 连接 → read/write/notify 阶梯;无无线电的模拟器诚实答 `unavailable`,阶梯走否定腿、不做内容断言——harmony 剪贴板姿态)。
- 同意阶梯逐宿主演练:manifest 声明授权、运行时弹窗、会话作用域、流中途的设置面撤销——五条规则,每条在一行日志里被看见。

## 版本

v1.10.0 candidate(可加性:十一个原语 + 两条事件通道 + 两个分期形状;授权族复用 v1.5.0 family-flag 机制,事件通道站在 v1.6.0 缝上)。编号顺着冻结的 v1.5.0 与在案的 draft 候选:事件通道 v1.6.0、render 面 v1.7.0、socket 缝 v1.8.0、forkpty 面 v1.9.0——v1.10.0 是下一个空闲的 additive 号。
