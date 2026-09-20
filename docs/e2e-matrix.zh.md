# 跨主机 E2E 证据矩阵

[English](e2e-matrix.md) | 简体中文

汇总四个主机（iOS、Android、HarmonyOS、macOS CLI）全部 E2E 声明的验收证据，
数据来自已提交的 artifacts 目录。由
[tools/e2e/matrix.mjs](../tools/e2e/matrix.mjs) 机器校验。

> **时效性**：本矩阵反映提交 `f68056a`（2026-09-20 审计）时的 `origin/main`。
> 它是**再生成**的，不是手工维护的：
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
| 证据目录 | 14 |
| Verdict（全部 `pass: true`、`expected == logged`） | 28 |
| 至少有一份已提交证据的 scenario | 12 / 12 个 manifest |
| 已验证 PNG 的截图 | 25 |
| 验收标准缺口 | 4（见下） |

## 覆盖矩阵 —— scenario × 平台

单元格 = 绿色 verdict（捕获时的 `expected/logged`）；目录见
[证据目录清单](#证据目录清单)。短横 = 该平台无已提交证据。

| Scenario | iOS | Android | HarmonyOS | macOS CLI |
| --- | --- | --- | --- | --- |
| `m1.spike.boot` | 9/9, 7/7 | 9/9, 7/7, 7/7 | 9/9, 7/7 | 9/9 |
| `m1.carrier.loopback` | 7/7, 7/7 | — | — | — |
| `m2.bridge.smoke` | — | 6/6, 6/6 | 6/6 | —（缺口 4） |
| `m2.gateway.audit` | 16/16 | 16/16 | — | — |
| `m2.gateway.binding` | 19/19 | — | — | — |
| `m2.session` | 23/23, 23/23 | 22/22（漂移）, 23/23 | 23/23 | 23/23 |
| `m2.webclient.mount` | 7/7 | — | — | — |
| `m3.ui-swap` | 7/7 | — | — | — |
| `m3.install` | — | —（进行中） | — | 22/22 |
| `m3.complete` | — | — | —（进行中） | 41/41 |
| `m4.host-binding` | — | 35/35 | — | — |
| `m5.host-binding` | — | — | 20/20 | — |

12 个 scenario manifest 全部至少有一份绿色已提交证据；`m2.session`
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
| `hosts/android/artifacts/m1-spike` | Android | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/android/artifacts/m4-host` | Android | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 22/22（漂移） | ✓ | ✓ | ✓ | 1 |
| `hosts/android/artifacts/m4-complete` | Android | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m2.gateway.audit 16/16, m4.host-binding 35/35 | ✓ | ✓ | ✓ | 5 |
| `hosts/harmony/artifacts/m1-spike` | HarmonyOS | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/harmony/artifacts/m5-host` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20 | ✓ | ✗（缺口 2） | ✓ | 2（缺口 3） |
| `runtime/spike/artifacts/macos-cli` | macOS CLI | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m2-session` | macOS CLI | m2.session 23/23 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m3-install` | macOS CLI | m3.install 22/22 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m3-complete` | macOS CLI | m3.complete 41/41 | ✓ | ✓ | ✓ | 0 |

CLI 主机无头运行：零截图是合规的（标准第 2 条使截图只是可选的调试辅助，
既非交付物也非输入）。

## 已知缺口（如实列出）

检查器（`tools/e2e/matrix.mjs`）当前恰好因以下各项以非零码退出；此处只
列出、不代为修复，因为每一项都位于有主/进行中的区域，或无法平凡修复：

1. **`hosts/ios/artifacts/m2-gateway/` 缺 `receipt.json`** —— 该目录早于
   #26 的 receipt 约定。iOS 区域有主（审计时有 worker 进行中）；此处不修。
2. **`hosts/harmony/artifacts/m5-host/` 缺 `scenario.jsonl`** —— 该次运行
   的抽取步骤未提交。重新生成需要 Harmony runner 在真机上执行（从
   `logs.txt` 反向拼装等于伪造证据）；留给 Harmony 的 owner。
3. **两张 Harmony 截图是挂在 `.png` 名下的 JPEG 数据** ——
   `hosts/harmony/artifacts/m5-host/m5-binding-complete.png` 与
   `m5-live-deltas.png` 以 `ffd8ffe0` 开头，不是 PNG magic。图片本身可正常
   查看；改名会破坏文档链接，应由 Harmony owner 在其工作流中重新产出
   （或改名并修正引用）。
4. **`m2.bridge.smoke` 没有已提交的 macOS CLI 证据**，而按 e2e README 该
   CLI 正是该 scenario 的规范主机；当前已提交的 verdict 来自 Android
   （`m4-host`、`m4-complete`）与 Harmony（`m5-host`）。留给下一次运行
   CLI spike 的人。

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

检查器**有意不接入 `gates.json`**：上述缺口是针对验收标准的真实回归；
是否以该矩阵设卡，属于 plane seal 在有主缺口闭合之后的决定。
