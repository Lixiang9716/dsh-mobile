# iOS 实测——dsh-iphone 模拟器上的四个维度

[English](ios-live-test-summary.md)

状态:14 条腿中 10 条绿且有 receipts;4 条腿被机器级 CoreSimulator XPC 死锁
阻塞(见 [BLOCKED-LEGS.md](../hosts/ios/artifacts/ios-live-test/BLOCKED-LEGS.md))。

本轮按 owner 的任务书,在 `dsh-iphone` 模拟器(iOS 26.5——唯一 dyld 缓存带
libswiftWebKit 的 runtime)上跑 iOS 宿主的实测矩阵:A — UI(控件扫描、会话
面),B — 后端(gateway 家族、session、BYOK、真实 LLM),C — 工具(tool
rows、todo、wasm、ish、office),D — 能力(device plane、相机、麦克风、BLE、
市场)。证据在
[hosts/ios/artifacts/ios-live-test/](../hosts/ios/artifacts/ios-live-test/)
下按维度组织(`A-ui/`、`B-backend/`、`C-tools/`、`D-capability/`),每腿带
`logs.txt`、`scenario.jsonl`、verdict JSON、receipt 与 PNG;17 张代表截图收在
[deliverables/](../hosts/ios/artifacts/ios-live-test/deliverables/)。每条
verdict 都是一对一日志断言(截图是 owner 点名的交付物,绝不作为 CI 断言)。

## 绿腿(10 腿 12 个场景 checker)

| 腿 | 判定 | 证据 |
|---|---|---|
| boot.verification / carrier.loopback / gateway.binding / gateway.audit | 8/7/19/16 事件,全 pass | `B-backend/gateway/` |
| session.mock-llm + webclient.mount(官方客户端) | 23/7,pass | `B-backend/session-mock-llm/` |
| session.mock-llm + compactweb.mount(compact 客户端) | 23/7,pass | `A-ui/compact-mount/` |
| v2web.mount(自托管 web-client-v2) | 25,pass | `A-ui/v2web-mount/` |
| composer.live-write(b4.write.live) | 46,pass | `C-tools/b4-write-live/` |
| device.plane + audit | 16/23,pass | `D-capability/device-plane/` |
| camera.plane + audit(sim 诚实 `unavailable`) | 6/3,pass | `D-capability/camera-plane/` |
| mic.plane + audit(真 Mac 麦克风 PCM 帧) | 11/6,pass | `D-capability/mic-plane/` |
| ble.plane + audit(mock radio,全 GATT 阶梯) | 16/8,pass | `D-capability/ble-mock/` |
| ble.plane + audit(真 radio skip 姿态) | 8/4,pass | `D-capability/ble-skip/` |

## 工具腿在设备上证明了什么

b4 运行时半场现在每次运行都探测全部三条执行缝(`log.debug`,不动任何
canonical 记录):

- **tool rows**:inventory 事件带着已组合的行——bash、bash-persistent、
  pwsh、pwsh-persistent、present、ralph、todo、fs、goal、skill、subagent、
  web、workflow……prompt 请求里共 15 个工具。
- **dsh-shell-wasm echo**:77 字节的 `echo.wasm` 写入工作区、经 gateway
  `wasmRun` 执行 → `output="hello from wasm"`、`result=15`(模块自己的退出
  约定),旁边还探了结构化拒绝阶梯(缺 export、缺模块)。
- **dsh-shell-ish**:真 guest 跑——仿真 aarch64 Alpine userland 里的
  `/bin/sh -c echo hello-from-guest`,`exit=0`,stdout 逐字;userland staged
  后插件 `enabled:true`(激活)。

## 本轮发现并修掉的 bug(各有现场证据)

1. **iOS stager 漏了三个 upstream 模块**(`llm-route.js`、
   `web-write-marketplace.js`、`web-write-onboarding.js`)——import 链够到
   它们的 drive 全在 eval 死(`cannot load module`),v2web.mount 腿实测。
   修在 `SpikeBundleStager.swift`。
2. **……以及再外一环的三个根模块**(`marketplace-resolver.js`、
   `canonical-json.js`、`ed25519.js`)——同一次现场发现,同款修法。
3. **`gen.sh` 在 xcodegen 读资源之后才取 guest tarball**——新 worktree 的
   app 不带 `ish-rootfs.tar.gz`,ish 插件诚实拒绝激活
   (`unavailable: ... is missing`)。gen.sh 现在先 stage 再 `xcodegen
   generate`。
4. **compact 的 receipt 点名了一个不存在的 verdict 文件**(该模式下 carrier
   manifest 换成 compact-mount.json)——两个 checker 全绿之后共享 writer 死掉。
   一行 receipt-stems 修复。
5. **v2web-mount manifest 早于 BYOK 开机探测**(composer manifest 早于
   tool-rows / session-cancel / mobile 默认预设三轮)——两者按今日线刷新,
   腿分别 25/25、46/46 按序绿。

## 阻塞腿(诚实 skip,带原因)

- **市场真装**(D):编排已齐(`run-marketplace-install.sh`:mock market
  server → catalog config staged → 面板浏览 → 安装 → 进度 → 已装,每步
  PNG),使能提交已在本分支(seat 把
  `profiles/default/marketplace/config.json` 中继进 write options);跑到
  页面挂载后被机器的 CoreSimulator 死锁打断(留有一张部分证据 home 截图)。
- **BYOK 引导流**(B):`run-onboarding-sim.sh` 已编排好(错 key 401 → 成功
  probe → 保存 → 首回合 → 重启)。
- **真实 LLM 回合**(B):staged 凭据机制已核实(仓库 `.env` 带
  `DSH_LLM_*` → `api.deepseek.com`,`51-run-ios-release.sh` staging 路径),
  但 Debug 流式腿与 Release 回合都需要模拟器。
- **控件扫描**(A):Debug + Release 两轮扫描需要 WDA(模拟器)。

## 后果

- 三处 stager 修复 + gen.sh 顺序对今后任何 iOS 腿都是承重的:没有它们,BYOK、
  市场与 onboarding 的运行时腿在这台宿主上根本起不来。
- 模拟器服务恢复后,四条阻塞腿各是一条命令(BLOCKED-LEGS.md);无需重新
  staging。
- `dsh-office` 在 iOS 仍未挂载(office 腿保持 CLI/HarmonyOS 的故事)——诚实
  的平台缺口,本轮不假装。
