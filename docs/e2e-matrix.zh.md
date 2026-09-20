# 跨主机 E2E 证据矩阵

[English](e2e-matrix.md) | 简体中文

汇总四个主机（iOS、Android、HarmonyOS、macOS CLI）全部 E2E 声明的验收证据，
数据来自已提交的 artifacts 目录。由
[tools/e2e/matrix.mjs](../tools/e2e/matrix.mjs) 机器校验。

> **时效性**：本矩阵反映提交 `ca644a0`
> （`b3.session.live` 行由 2026-09-21 的 W-RECEIPT 证据收口刷新并闭合其
> receipt 缺口；五个 D9 目录 `android-upstream` / `d9-official-web` /
> `b4-write-live` / `android-session-live` / `d9-session-live` 随
> #63/#64/#65/#66/#67 进入清单；
> 总量按本树重算）
> 时的 `origin/main`。它是**再生成**的，不是手工维护的：
>
> ```sh
> node tools/e2e/matrix.mjs              # 退出码 0 = 清单干净
> node tools/e2e/matrix.mjs --out /tmp/inv.json   # 机器可读清单
> ```

## 验收标准

本仓库的每一条 E2E 声明，只有同时满足以下各条才被接受：

1. **日志一对一比对绿色** —— 由 `tools/e2e/check.mjs` 产出的
   `verdict*.json`，`pass: true` 且 `expected == logged`
   （精确、有序、不缺、不多）。
2. **截图仅作调试工件** —— 永远不作为检查器输入；证据目录下的截图必须是
   真实 PNG（校验 magic bytes）。
3. **交付物齐全** —— `logs.txt` + `scenario.jsonl` +
   `verdict*.json` + `receipt.json`，提交在正确的 artifacts 目录下。

## 总量（本树）

| 指标 | 数值 |
| --- | --- |
| 证据目录 | 25 |
| Verdict（全部 `pass: true`、`expected == logged`） | 51 |
| 至少有一份已提交证据的 scenario | 24 / 24 个 manifest |
| 已验证 PNG 的截图 | 53 |
| 验收标准缺口 | 6（见下） |

## 覆盖矩阵 —— scenario × 平台

单元格 = 绿色 verdict（捕获时的 `expected/logged`）；目录见
[证据目录清单](#证据目录清单)。短横 = 该平台无已提交证据。

| Scenario | iOS | Android | HarmonyOS | macOS CLI |
| --- | --- | --- | --- | --- |
| `b-android.official-web.mount` | — | 14/14 | — | — |
| `b-android.session.live` | — | 46/46 | — | — |
| `b-harmony.httpfetch-v2` | — | — | 6/6, 6/6 | — |
| `b-harmony.official-web-mount` | — | — | 17/17, 17/17 | — |
| `b-harmony.session.live` | — | — | 43/43 | — |
| `b1.official-web.mount` | 14/14 | — | — | — |
| `b3.session.live` | 46/46 | — | — | — |
| `b4.write.live` | 43/43 | — | — | — |
| `m1.spike.boot` | 9/9, 7/7 | 9/9, 7/7, 7/7 | 9/9, 7/7, 7/7 | 9/9 |
| `m1.carrier.loopback` | 7/7, 7/7 | — | — | — |
| `m2.bridge.smoke` | — | 6/6, 6/6 | 6/6, 6/6 | 6/6 |
| `m2.gateway.audit` | 16/16 | 16/16 | — | — |
| `m2.gateway.binding` | 19/19 | — | — | — |
| `m2.session` | 23/23, 23/23 | 22/22（漂移）, 23/23 | 23/23, 23/23 | 23/23 |
| `m2.webclient.mount` | 7/7 | — | — | — |
| `m2.upstream-session` | — | — | — | 31/31 |
| `m2.upstream-boot` | — | — | — | 12/12 |
| `m3.ui-swap` | 7/7 | — | — | — |
| `m3.install` | — | — | — | 22/22 |
| `m3.complete` | — | — | — | 41/41 |
| `m3.fetch-install` | 46/46 | — | — | — |
| `m3.fetch-carrier` | 11/11 | — | — | — |
| `m4.host-binding` | — | 35/35 | — | — |
| `m5.host-binding` | — | — | 20/20, 20/20 | — |

24 个 scenario manifest 全部至少有一份绿色已提交证据；`m2.session`
在全部四个主机上绿色。main 上的每一条 verdict 都是绿的。

## 证据目录清单

`logs` / `scen` / `rcpt` = `logs.txt` / `scenario.jsonl` / `receipt.json`
是否在位。`shots` = PNG 数量（除注明外均通过 magic 校验）。

| 目录 | 平台 | Verdict（`expected/logged`） | logs | scen | rcpt | shots |
| --- | --- | --- | --- | --- | --- | --- |
| `hosts/android/artifacts/android-upstream` | Android | b-android.official-web.mount 14/14 | ✓ | ✓ | ✗（缺口 4） | 4 |
| `hosts/android/artifacts/android-session-live` | Android | b-android.session.live 46/46 | ✓ | ✓ | ✗（缺口 5） | 4 |
| `hosts/android/artifacts/m1-spike` | Android | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/android/artifacts/m4-complete` | Android | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m2.gateway.audit 16/16, m4.host-binding 35/35 | ✓ | ✓ | ✓ | 5 |
| `hosts/android/artifacts/m4-host` | Android | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 22/22（漂移） | ✓ | ✓ | ✓ | 1 |
| `hosts/harmony/artifacts/d9-official-web` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20, b-harmony.httpfetch-v2 6/6, b-harmony.official-web-mount 17/17 | ✓ | ✓ | ✗（缺口 3） | 4 |
| `hosts/harmony/artifacts/d9-session-live` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20, b-harmony.httpfetch-v2 6/6, b-harmony.official-web-mount 17/17, b-harmony.session.live 43/43 | ✓ | ✓ | ✗（缺口 6） | 6 |
| `hosts/harmony/artifacts/m1-spike` | HarmonyOS | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/harmony/artifacts/m5-host` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20 | ✓ | ✓ | ✓ | 2 |
| `hosts/ios/artifacts/b1-official-web` | iOS | b1.official-web.mount 14/14 | ✓ | ✓ | ✓ | 2 |
| `hosts/ios/artifacts/b3-session-live` | iOS | b3.session.live 46/46 | ✓ | ✓ | ✓ | 2 |
| `hosts/ios/artifacts/b4-write-live` | iOS | b4.write.live 43/43 | ✓ | ✓ | ✗（缺口 2） | 3 |
| `hosts/ios/artifacts/m1-carrier` | iOS | m1.carrier.loopback 7/7 | ✓ | ✓ | ✓ | 1 |
| `hosts/ios/artifacts/m1-spike` | iOS | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/ios/artifacts/m2-gateway` | iOS | m1.spike.boot 7/7, m1.carrier.loopback 7/7, m2.gateway.audit 16/16, m2.gateway.binding 19/19 | ✓ | ✓ | ✗（缺口 1） | 7 |
| `hosts/ios/artifacts/m2-session` | iOS | m2.session 23/23, m2.webclient.mount 7/7 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/m3-complete` | iOS | m3.fetch-carrier 11/11, m3.fetch-install 46/46 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/m3-pluginization` | iOS | m2.session 23/23, m3.ui-swap 7/7 | ✓ | ✓ | ✓ | 3 |
| `runtime/spike/artifacts/macos-cli` | macOS CLI | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-bridge-smoke` | macOS CLI | m2.bridge.smoke 6/6 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m2-session` | macOS CLI | m2.session 23/23 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m3-install` | macOS CLI | m3.install 22/22 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m3-complete` | macOS CLI | m3.complete 41/41 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-upstream-session` | macOS CLI | m2.upstream-session 31/31 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-upstream-boot` | macOS CLI | m2.upstream-boot 12/12 | ✓ | ✓ | ✓ | 0 |

CLI 主机无头运行：零截图是合规的（标准第 2 条使截图只是可选的调试辅助，
既非交付物也非输入）。

## 已知缺口（如实列出）

检查器（`tools/e2e/matrix.mjs`）当前恰好因六项以非零码退出：一项是
re-run 受阻的既有 receipt（缺口 1），五项是其目录随 #63/#64/#65/#66/#67
落地后尚待各自主机首次 re-run 的 receipt（缺口 2–6，归各自的落地主机工作流
所有）。

1. **`hosts/ios/artifacts/m2-gateway/` 缺 `receipt.json`** —— 该目录早于
   #26 的 receipt 约定。其四条已提交 verdict 均为绿色、其余证据齐全，
   出自一次完全绿色的 WDA 运行；缺的只是 receipt，而 receipt 必须来自
   真实运行（绝不合成）。2026-09-21 的收口尝试把诊断做精确了，并排除了
   一半阻塞：WebDriverAgent 运行时已恢复健康（runner 的 `wda_up` 探测
   被 WDA 重建后改为 pretty-print 的 `/status` JSON 静默破坏——已在
   run-ios.sh 中连同 picker 搜索框标定一并修复，均有 surprise 记录），
   且 WDA 在位时运行把每条应用内 leg 都复现为绿（boot、carrier、全部
   gateway/fs/http 原语——事件 0–7 一对一），直到 `presentPicker`。
   剩余阻塞是 Files 提供器的搜索索引：预置的 `notes.txt` 在一次预置后
   数秒内能作为搜索结果出现（04:55 探测），但当文件在驱动前一刻被重写时
   返回「未找到相关结果」（04:58 运行）——在预置步骤里重写目标文件会把
   它从索引中挤出，直到重索引完成。receipt 属于下一次让索引得以沉淀的
   预置（只预置一次不重写，或留出沉淀时间）；按 rerun 协议，卡点已记录、
   未硬闯（surprise 签名 `drivepickers-ptsearch-calibration-201126`、
   `drivepicker-can-focus-the` 及 04:58 记录；过程注记
   `2026-09-20-run-ios-sh-rerun-protocol-under-a-degrad`）。
2. **`hosts/ios/artifacts/b4-write-live/` 缺 `receipt.json`** —— 目录随
   #65（session 写表面）落地；receipt 归 b4 工作流下一次在携带 #65 的树
   上运行 `run-ios-b4.sh` 所有。
3. **`hosts/harmony/artifacts/d9-official-web/` 缺 `receipt.json`** ——
   目录随 #64（harmony webServer carrier）落地；receipt 归 harmony 工作
   流的下一次主机 re-run 所有。
4. **`hosts/android/artifacts/android-upstream/` 缺 `receipt.json`** ——
   目录随 #63（android official-web boot）落地；receipt 归 android 工作
   流的下一次主机 re-run 所有。
5. **`hosts/android/artifacts/android-session-live/` 缺 `receipt.json`**
   —— 目录随 #66（android session.live 主线脊柱，b-android.session.live
   46/46 绿色）落地；receipt 归 android 工作流的下一次主机 re-run 所有。
6. **`hosts/harmony/artifacts/d9-session-live/` 缺 `receipt.json`** ——
   目录随 #67（harmony session.live 主线脊柱，b-harmony.session.live
   43/43 绿色）落地；receipt 归 harmony 工作流的下一次主机 re-run 所有。

### 由 2026-09-20 证据缺口收口闭合（fix/evidence-gaps）

- **缺口 2（Harmony `scenario.jsonl`）** —— 通过在本树上完整重跑
  `hosts/harmony/ci/run-host-e2e.sh` 闭合：四条 verdict 全部与已提交
  manifest 一致（m1.spike.boot 7/7、m2.bridge.smoke 6/6、m2.session 23/23、
  m5.host-binding 20/20），且 runner 现在从本次运行自己的 capture 文件抽取
  `scenario.jsonl`（对 sink + binding capture 执行
  `grep -h '^dsh.spike.log:'`——与 Android runner 相同的抽取约定）。重跑
  依赖一处一行主机修复：#53 把 `dsh:util-crypto` 升到 0.1.6-alpha.2 时更新了
  加载路径、manifest 与 rawfile 副本，却漏了 `Index.ets` 的 `BUNDLE_FILES`，
  导致全新启动在记录任何 scenario 行之前就死于 `GetRawfileContent`。
- **缺口 3（`.png` 名下的 JPEG 数据）** —— 模拟器 `snapshot_display` 输出
  JPEG；runner 现在用一行有记录的 `sips -s format png` 步骤对两张截图就地
  转换，重拍的两个文件均带真实 PNG magic。
- **缺口 4（`m2.bridge.smoke` 无 macOS CLI 证据）** —— 通过在该 scenario
  的规范主机上真实无头运行闭合：`runtime/spike/artifacts/macos-cli-bridge-smoke/`
  提交了 logs.txt + scenario.jsonl + `verdict.json`（6/6，一对一）+
  receipt.json，来自 `./build/dsh-spike-cli . scenario/m2-bridge-smoke.js`。

### 由 2026-09-21 receipt 收口闭合（fix/receipt-gaps）

- **b3-session-live 的 receipt** —— 通过在最终 main 上的真实
  `run-ios-b3.sh` 重跑闭合（`618f2f8` 的全新 worktree）：b3.session.live
  46/46 绿色（expected == logged，退出码 0），证据从本次运行刷新，
  `receipt.json` 按既有证据格式从其撰写。（首次冷 worktree 运行暴露了
  runner 的一个次序缺口——bundle 构建需要 vendored DSH 闭包，而 runner
  要到构建之后的 4b 步才暂存它；在运行 runner 前先执行
  `runtime/spike/vendor/ensure-dsh.sh` 即可绕过，已记 surprise。）

### 信息性说明，不算失败

- **Manifest 版本漂移**（5 条 verdict）：`m1.spike.boot` 在
  `hosts/{ios,android,harmony}/artifacts/m1-spike/` 与
  `runtime/spike/artifacts/macos-cli/` 捕获时为 9 事件，而现行 manifest 声明
  7；`hosts/android/artifacts/m4-host/` 的 `m2.session` 捕获时 22 事件，现行
  23。verdict 是捕获时的记录；旧日志不保证能用增长后的 manifest 重新校验。
  检查器报告 `drift: true`，但不因此失败。
- **审计时仍在进行中（已排除）**：`hosts/android/artifacts/m3-android-install/`、
  `hosts/harmony/artifacts/m5-complete/`、
  `runtime/spike/artifacts/macos-cli-m2-llm/`。落地后请再生成
  （`node tools/e2e/matrix.mjs`）——它们的缺口会自动进入本文的缺口清单。

## 检查器及其拒绝证明

`tools/e2e/matrix.mjs`（仅标准库）从工作树再生成清单，任何回归即以非零码
退出：verdict 失败、交付物缺失/为空、PNG 损坏、verdict/receipt 畸形，或
scenario id 在 `tools/e2e/scenarios/` 无 manifest。其 `--self-test` 模式
证明每个拒绝类别都真的会拒绝（8 条断言，规则 6）——断言集记录在
[e2e README](../tools/e2e/README.md#inventory-matrix-matrixmjs)。

检查器**有意不接入 `gates.json`**：上方尚余六项有主缺口（m2-gateway 的
receipt，按 rerun 协议等待文件提供器搜索索引健康的 picker leg；以及五个
D9 时代的 receipt，等待各自主机的下一次 re-run）；是否以该矩阵设卡，属于
plane seal 的决定。
