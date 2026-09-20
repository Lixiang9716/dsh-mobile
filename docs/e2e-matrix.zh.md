# 跨主机 E2E 证据矩阵

[English](e2e-matrix.md) | 简体中文

汇总四个主机（iOS、Android、HarmonyOS、macOS CLI）全部 E2E 声明的验收证据，
数据来自已提交的 artifacts 目录。由
[tools/e2e/matrix.mjs](../tools/e2e/matrix.mjs) 机器校验。

> **时效性**：本矩阵反映提交 `e80f65d`（2026-09-20 再生成，证据缺口收口）
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
| 证据目录 | 18 |
| Verdict（全部 `pass: true`、`expected == logged`） | 33 |
| 至少有一份已提交证据的 scenario | 16 / 16 个 manifest |
| 已验证 PNG 的截图 | 30 |
| 验收标准缺口 | 1（见下） |

## 覆盖矩阵 —— scenario × 平台

单元格 = 绿色 verdict（捕获时的 `expected/logged`）；目录见
[证据目录清单](#证据目录清单)。短横 = 该平台无已提交证据。

| Scenario | iOS | Android | HarmonyOS | macOS CLI |
| --- | --- | --- | --- | --- |
| `m1.spike.boot` | 9/9, 7/7 | 9/9, 7/7, 7/7 | 9/9, 7/7 | 9/9 |
| `m1.carrier.loopback` | 7/7, 7/7 | — | — | — |
| `m2.bridge.smoke` | — | 6/6, 6/6 | 6/6 | 6/6 |
| `m2.gateway.audit` | 16/16 | 16/16 | — | — |
| `m2.gateway.binding` | 19/19 | — | — | — |
| `m2.session` | 23/23, 23/23 | 22/22（漂移）, 23/23 | 23/23 | 23/23 |
| `m2.webclient.mount` | 7/7 | — | — | — |
| `m3.ui-swap` | 7/7 | — | — | — |
| `m3.install` | — | —（进行中） | — | 22/22 |
| `m3.complete` | — | — | —（进行中） | 41/41 |
| `m3.fetch-install` | 46/46 | — | — | — |
| `m3.fetch-carrier` | 11/11 | — | — | — |
| `m2.upstream-session` | — | — | — | 31/31 |
| `m4.host-binding` | — | 35/35 | — | — |
| `m5.host-binding` | — | — | 20/20 | — |
| `b1.official-web.mount` | 10/10 | — | — | — |

16 个 scenario manifest 全部至少有一份绿色已提交证据；`m2.session`
在全部四个主机上绿色。main 上的每一条 verdict 都是绿的。

## 证据目录清单

`logs` / `scen` / `rcpt` = `logs.txt` / `scenario.jsonl` / `receipt.json`
是否在位。`shots` = PNG 数量（除注明外均通过 magic 校验）。

| 目录 | 平台 | Verdict（`expected/logged`） | logs | scen | rcpt | shots |
| --- | --- | --- | --- | --- | --- | --- |
| `hosts/ios/artifacts/m1-spike` | iOS | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/ios/artifacts/m1-carrier` | iOS | m1.carrier.loopback 7/7 | ✓ | ✓ | ✓ | 1 |
| `hosts/ios/artifacts/m2-gateway` | iOS | m1.spike.boot 7/7, m1.carrier.loopback 7/7, m2.gateway.audit 16/16, m2.gateway.binding 19/19 | ✓ | ✓ | ✗（缺口 1） | 7 |
| `hosts/ios/artifacts/m2-session` | iOS | m2.session 23/23, m2.webclient.mount 7/7 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/m3-pluginization` | iOS | m2.session 23/23, m3.ui-swap 7/7 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/m3-complete` | iOS | m3.fetch-carrier 11/11, m3.fetch-install 46/46 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/b1-official-web` | iOS | b1.official-web.mount 10/10 | ✓ | ✓ | ✓ | 2 |
| `hosts/android/artifacts/m1-spike` | Android | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/android/artifacts/m4-host` | Android | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 22/22（漂移） | ✓ | ✓ | ✓ | 1 |
| `hosts/android/artifacts/m4-complete` | Android | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m2.gateway.audit 16/16, m4.host-binding 35/35 | ✓ | ✓ | ✓ | 5 |
| `hosts/harmony/artifacts/m1-spike` | HarmonyOS | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/harmony/artifacts/m5-host` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20 | ✓ | ✓ | ✓ | 2 |
| `runtime/spike/artifacts/macos-cli` | macOS CLI | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-bridge-smoke` | macOS CLI | m2.bridge.smoke 6/6 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m2-session` | macOS CLI | m2.session 23/23 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m3-install` | macOS CLI | m3.install 22/22 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m3-complete` | macOS CLI | m3.complete 41/41 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-upstream-session` | macOS CLI | m2.upstream-session 31/31 | ✓ | ✓ | ✓ | 0 |

CLI 主机无头运行：零截图是合规的（标准第 2 条使截图只是可选的调试辅助，
既非交付物也非输入）。

## 已知缺口（如实列出）

检查器（`tools/e2e/matrix.mjs`）当前恰好因一项以非零码退出；2026-09-20
审计记录的四个缺口其余全部闭合。

1. **`hosts/ios/artifacts/m2-gateway/` 缺 `receipt.json`** —— 该目录早于
   #26 的 receipt 约定。重新生成需要一次干净的 re-run，但当前被 WDA 阻塞：
   dsh-iphone iOS 26.5 模拟器上的 WebDriverAgent 运行时已进入第三次记录在案
   的退化（surprise 签名 `run-iossh-regression-rerun-green` /
   `run-iossh-ui-drive-rerun-green`，过程注记
   `2026-09-20-run-ios-sh-rerun-protocol-under-a-degrad` —— 2026-09-20 收口
   尝试时 WDA 的 HTTP 桥再次拒绝连接）。按该协议跳过 re-run、不硬闯：
   receipt 留给下一次 WDA 健康的 `tools/e2e/run-ios.sh` 运行。该目录的四条
   已提交 verdict 均为绿色，其余证据齐全。

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

检查器**有意不接入 `gates.json`**：上方尚余一项有主缺口（m2-gateway 的
receipt，等待 WDA 运行时恢复健康）；是否以该矩阵设卡，属于 plane seal
的决定。
