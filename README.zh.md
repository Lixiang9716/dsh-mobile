# dsh-mobile

[English](README.md) | 简体中文

DSH（DeepSeek Harness）生态的移动宿主（Mobile Host）。基于社区 Fabric 互操作模型，将移动端实现为 Harness 运行时之上的一个对等宿主：QuickJS 单线程协程运行时承载 Harness 核心，iOS 系统能力以"特权层 / 能力网关 / 系统实现插件"三层封装，UI 以 Web Client 插件形态可插拔。

> 社区独立项目，非 DeepSeek 官方产品。上游生态参考 [anywhere-labs/dsh-desktop](https://github.com/anywhere-labs/dsh-desktop) 与 DSH Community Fabric 草案。

## 文档

- [整体架构方案](docs/ARCHITECTURE.md) —— 分层设计、关键技术决策、里程碑
- [时序图](docs/sequence-diagrams.zh.md) —— 全流程端到端：启动、网关调用、LLM 流式、安装、模拟用户land、验证机制本身
- [构建](BUILD.md) —— 唯一构建门面:平台可选、编译+测试、closures 门禁
- [发布包](docs/release.md) —— 标签触发的版本化发布与三个宿主 App 的打包

## 里程碑

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 契约冻结 | 原语契约 v0 + 数据协议三件套（bundle 布局 / manifest / receipt） | 已完成（冻结于 v1.0.0；经可加性扩展——primitives v1.8.0 socket 缝，data-protocols v1.1.0 §7 插件市场背后的签名目录） |
| 运行时与宿主 dsh | Dsh：quickjs-ng 垫层跑通纯逻辑包 + iOS 宿主骨架 + 本机 carrier | 已完成（运行时 dsh 已在 iOS/Android/鸿蒙 + macOS 验证；本机 carrier——回环静态文件 + WS↔QuickJS 泵——已在 iOS 模拟器验证） |
| 首个真机会话 | 系统实现插件（fs/subprocess/ui）+ Web Client 挂载 + 首个设备端会话 + 真实 LLM API | 完成（系统插件 + Web Client 挂载 + 首个设备端会话：`dsh-fs`/`dsh-subprocess-quickjs`/`dsh-ui` 插件，`session.mock-llm` 在 CLI 与设备端均 23/23 通过，Web Client `dsh-web-client` 经 carrier WS 挂载并实时渲染 —— 证据见 `runtime/dsh/artifacts/macos-cli-m2-session/` 与 `hosts/ios/artifacts/m2-session/`；真实 LLM API 已随场景 `llm.live-stream` 交付：经网关 `httpFetch` 形态的 OpenAI 兼容流式客户端（`runtime/dsh/llm.js`），由 RuntimeDescriptor 协商执行腿 —— CLI 脚本化 SSE 腿 `llm.live-stream` 19/19（`runtime/dsh/artifacts/macos-cli-m2-llm/`），iOS 模拟器与 Android 模拟器上的真实 z.ai 流式（`hosts/ios/artifacts/m2-llm/`、`hosts/android/artifacts/m2-llm/`），reasoning+content 增量按事件序列流出、逐字记录服务端报告的模型名、并对每条日志行断言 API 密钥零泄漏（泄漏即响亮失败）） |
| 插件系统 | 插件安装链路 + UI 插件化（三级 UI 插件、能力协商） | 完成（安装 = 冻结 fs 原语上的 receipt 事务 —— `install.verified-tarball` 在 CLI 22/22：内容寻址 blob、信任记录校验、严格 manifest 校验、对照 RuntimeDescriptor 的安装期能力协商、暂存树读回校验、receipt 提交、被篡改的包在解包前被拒绝；基于 FETCH 的安装器把 httpFetch 流式 body 送入同一条流水线 —— CLI 用带日志的桩 `install.full-cycle` 41/41（`runtime/dsh/artifacts/macos-cli-m3-complete/`），设备端直接对回环 carrier 本身用真实 `httpFetch` `install.from-http` 46/46 + carrier 证据 `install.carrier-evidence` 11/11（`hosts/ios/artifacts/m3-complete/`），并包含 append-only receipt 日志上的 pending-receipt 启动重放（暂存树可验证 → 提交；暂存不完整 → 回滚且已安装树不动）；三级 UI 插件均在设备端验证 —— 配置层（`cordis.patch` 分层覆盖）选择活动 Web Client 并覆盖工具栏 slot 集合，另有整客户端替换与组件 slot（`ui.client-swap` 7/7，`hosts/ios/artifacts/m3-pluginization/`）；回归 `session.mock-llm` CLI + 设备端 23/23，`run-ios.sh` 4/4） |
| Android 宿主 | Android 宿主（QuickJS 同构） | 完成（完成会话 `android.capability-binding` 在模拟器 35/35 全绿：回环 carrier 将内嵌的 Web Client 装载进真实 WebView 并实时渲染会话；九原语网关真实绑定——描述符 9 可用 / 0 不可用，强制审计经 `gateway.audit` 16/16 复核；三场景回归同跑保持全绿——证据 `hosts/android/artifacts/m4-complete/`；同一真实 httpFetch 绑定亦在模拟器上驱动真实 LLM 流式会话 `llm.live-stream` —— `llm.live-stream` 设备端 期望 14 / 实记 171 + carrier 7/7，证据 `hosts/android/artifacts/m2-llm/`） |
| 鸿蒙宿主 | 鸿蒙宿主（ArkTS + NAPI） | 完成（同构宿主已验证：回环载体——向 Web Client 提供静态文件服务 + RFC 6455 WS 泵——ArkWeb 挂载实时会话；九项契约原语全部在模拟器上真实可用，描述符 9 可用 / 0 不可用：notify、presentApproval、fsScope、HUKS 封装的 keychain（AES-256-GCM；set → get 字节一致，set null 即删除）、基于 DocumentViewPicker 的 presentPicker（取消 → null；授权 → 用户作用域并完成 fsScope persist/resolve 与内容一致读回；用户作用域面为只读，与 Android 孪生端一致）、对宿主自身回环载体的流式 httpFetch（body 在响应头即 settle，随后按块事件流出、绝非整块返回；体中 abort → `cancelled`）——`harmony.capability-binding` 27/27 加上 `boot.verification`/`gateway.bridge-smoke`/`session.mock-llm`（23/23）回归一次启动全绿——证据见 `hosts/harmony/artifacts/m5-host/` 与 `hosts/harmony/artifacts/m5-primitives/`；本宿主的 `llm.live-stream` 真实 LLM 腿同样已接通——由启动参数 `aa start … --ps dsh.e2e.leg llm.live-stream` 选中（该腿单独运行，默认链路因此不消耗任何推理配额），运行未改动的 `runtime/dsh/scenario/llm-live-stream.js`，经同一条 httpFetch 绑定协商出真实腿，并实现本平台强制的凭据交接（运行时写入 0666 占位文件 → 运行脚本 `hdc file send` 覆盖 → 应用导入、如实报告封存状态、运行结束即删除），载体挂载链（`client.selected` → `webclient.mounted` → `ws.connected` → `slot.registered`）已在模拟器上验证；其传输往返已端到端证实——请求经本宿主 httpFetch 离开设备并有真实后端应答——且配额重置后该腿重跑转绿：真实推理回合已可宣称（`llm.live-stream` 14/130 + `llm.live-stream.carrier` 7/7，证据 `hosts/harmony/artifacts/m5-llm-live-stream/`，产出 2026-09-28，原始日志的密钥泄漏审计干净）） |
| 渲染面客户端（Lynx 试点） | `presentation/lynx-client/` —— 一个可整体替换的渲染面**客户端插件**（不是 system-plugin）：ReactLynx bundle（纯表现）+ 宿主侧 driver，架在 `RenderSurfaceClient` 缝（mount / pushViewEvent / onIntent / teardown）上；主题 token 单源同时生成 web CSS 变量与 Lynx 样式常量 | Done（试点构建 + 验收：rspeedy bundle（149.6 kB）已入库并在挂载时做 sha256 校验；`lynx.mount` CLI 腿跑完整 mock-LLM driver 环路——提交 → 流式增量 → 工具卡三态 → 收拢输出 + 创作卡 → 中途重进 seed 重建 → 乐观取消 → fail-loud 腿——两条皮肤在同一流上各 34/34，即可替换性证明，证据在 `presentation/lynx-client/artifacts/cli-lynx-mount-{lynx,stub}/`；vitest 缝契约套件 36/36；bundle 在 @lynx-js/web-core 平台的 headless Chrome 上真实渲染（人看截图在 gitignored 的 `artifacts/screens/`）；真机像素留给 LynxExplorer/真机轮） |
| 设备面（契约 v1.5.0） | 宿主平台 SDK 表面：`deviceInfo` / `haptic` / `clipboardRead`+`clipboardWrite` / `presentShare` / `keepAwake` + `presentPicker` `mode:"media"` | 已完成（一份平台中立场景 `device.plane` 逐宿主在真实特权层上驱动——描述符 iOS 22 可用 / Android 23 / 鸿蒙 15，剪贴板审批梯（Approve → Approve & Remember → 常设授权）、分享面板经 Copy 完成、keepAwake 闩锁、多媒体选择器对用户所选项授予读穿透作用域；模拟器失效的剪贴板服务如实拒绝 `unavailable`，审批梯照常运行；凭据 `hosts/{ios,android,harmony}/artifacts/device-plane/`；运行器 `test/e2e/run-ios-device-plane.sh`、`hosts/android/ci/run-device-plane.sh`、`hosts/harmony/ci/run-device-plane.sh`） |
| 模拟器矩阵 | 发布级证据网：每宿主一条命令（`tools/test/run-simulator-matrix.sh`）证明 flavor 切分的两半——Release 构建直接启动、零 drive 编排、零 debug/info 日志记录、并按名拒绝 drive；既有 e2e 运行器原样再驱动 Debug harness | 已完成（iOS `simulator-matrix/release/release-proof.json`（缺席 + 拒绝证明）+ `simulator-matrix/gateway-drive`：`boot.verification` 8/8、`carrier.loopback` 7/7、`gateway.audit` 16/16、`gateway.binding` 19/19，另 `simulator-matrix/device-plane` 16/16 + 审计；Android `simulator-matrix/release/release-proof.json` + `simulator-matrix/regression`：`boot.verification` 8/8、`gateway.bridge-smoke` 6/6、`session.mock-llm` 23/23，另 `simulator-matrix/device-plane` 15/15 + 审计；凭据仅在绿路径由机器写入；鸿蒙：无 DevEco/hdc 目标时出具诚实 skip 凭据 `matrix-skip-receipt.json`（D-g 待命）；证据 `hosts/{ios,android,harmony}/artifacts/simulator-matrix/`；有意不接入门禁 DAG——发布仪式） |
| 系统能力面（契约 v1.10.0 candidate） | 相机、麦克风、BLE 置于同一 OS 权限同意模型之下——先调用方 manifest 的 grant 家族旗标（gateway 层），后 OS 权限，拒绝按层审计；每面一份平台中立场景逐宿主驱动（提案 `contract/proposals/2026-09-30-system-capability-plane.md`，#249；三个面 #252 / #255 / #254） | iOS + Android 已完成（相机 `camera.plane` iOS 6/6 + 审计——模拟器如实回答 capture-unavailable——Android 8/8 + 审计且模拟器虚拟相机真实出片（2 帧 / 44157 字节 / 457 ms）加 maxBytes 丢弃腿；麦克风 `mic.plane` iOS 11/11 / Android 9/9——武装梯带真实 PCM 帧、stop 记录的时长/字节、exactly-once 收尾、幂等；BLE 每宿主 `ble.plane` 16/16（确定性 mock 电台）+ 8/8（如实电台缺席）——没有一台模拟器有可用电台，mock 与真实电台共用同一套 gateway 强制、同意层与审计，真机腿走 D-g 一键契约；证据 `hosts/{ios,android}/artifacts/{camera-plane,mic-plane,ble-mock,ble-skip}/`；鸿蒙三面已实现，凭据等真机——D-g 脚本备好，不合成任何证据） |

### 上游移植（D9）

上表记录各里程碑以自身证据证明的内容。自决策 [D9](docs/decisions.md) 起，Harness 层本身
不再是自研重实现：上游 DSH 运行时在 quickjs 上**原样**运行——26 个包由
`runtime/dsh/vendor/ensure-dsh.sh` pin 并做 sha256 校验（21 个上游 DSH 包
@ 0.1.6-alpha.2 + 5 个 pinned npm 依赖），自研代码只留胶水（垫层、适配器、契约 carrier）。
经 carrier 在 iOS / Android / 鸿蒙上已点亮：官方 client-modules web 启动、官方 App 壳
（#61 的 58 包 application 层）、真实 `session.list`/日志，以及 composer 写入路径。汇总
数字与逐目录清单见 [docs/e2e-matrix.md](docs/e2e-matrix.md)——93 个证据目录、211 条绿色
verdict——位于 `hosts/{ios,android,harmony}/artifacts/`（`b1-official-web`、
`session-live-read`、`composer-live-write`、`android-upstream`、`android-session-live`、
`d9-official-web`、`d9-session-live`、`d9-write-live`）。

## 治理

本仓库由 [govrail](https://github.com/Lixiang9716/govrail) 门禁管理：pre-commit 内容门、推送前 `gov run` 门 DAG、CI 强制（`.github/workflows/gov.yml`），并采用其 `agent-heavy` preset 所描述的多 agent 并行开发实践（`parallel-workers` skill + `verify-decisions` 门）。安装方式 `pip install govrail`，入口命令为 `gov`。

## License

MIT
