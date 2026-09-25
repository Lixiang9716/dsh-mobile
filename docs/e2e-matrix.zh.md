# 跨主机 E2E 证据矩阵

[English](e2e-matrix.md) | 简体中文

汇总四个主机（iOS、Android、HarmonyOS、macOS CLI）全部 E2E 声明的验收证据，
数据来自已提交的 artifacts 目录。由
[test/e2e/matrix.mjs](../test/e2e/matrix.mjs) 机器校验。

> **时效性**：本矩阵反映 models 页 e2e 变更（2026-09-25）：官方客户端的
> models 设置页有了独立 CLI 证明 —— scenario `models.directory` 6/6，目录
> `runtime/spike/artifacts/macos-cli-models-directory/` —— 且总量对本树重跑
> （44 个目录 / 92 条 verdict / 43 个 scenario id 全部有绿证 / 35 个
> manifest）。下面的 `49fce4f` 注记是上一次的时效记录；其加入的行保留
> 当时的展示名拼写，verdict id 现已细化。
>
> **时效性**：本矩阵反映提交 `49fce4f`
> （发布手册 #80 与打包流水线 #77 未落地任何证据目录；
> 叠加上鸿蒙 `m2.llm` 真实 LLM 分支 #79——其目录
> `hosts/harmony/artifacts/m5-m2-llm/` 被**有意**以
> **FAIL** verdict 提交：会话中途 coding-plan 配额耗尽，故传输往返已证明、
> 而被服务的轮次明确不予声明（缺口 8/9）；再叠加 M5 v2 原语 #76
> （`m5-primitives`，descriptor 9/0，`m5.host-binding` 27/27）、
> 真实 LLM 流式分支 #74（`macos-cli-m2-llm`，以及 iOS 与 Android 的
> `m2-llm`）、android 写入表面 #72（`android-write-live`）、
> 鸿蒙 composer 写入路径 #70（第六个 D9 目录 `d9-write-live`，并新增
> `b-harmony.write.live` scenario；`m2-gateway` 行由 2026-09-21 的
> W-GR 有界尝试刷新并闭合其 receipt 缺口，再叠加 W-RECEIPT 的 b3 收口）；
> 以及更早的五个 D9 目录 `android-upstream` / `d9-official-web` /
> `b4-write-live` / `android-session-live` / `d9-session-live`，
> 它们随 #63/#64/#65/#66/#67 进入清单；总量按本树重算）
> 时的 `origin/main`。它是**再生成**的，不是手工维护的：
>
> ```sh
> node test/e2e/matrix.mjs              # 退出码 0 = 清单干净
> node test/e2e/matrix.mjs --out /tmp/inv.json   # 机器可读清单
> ```
>
> 2026-09-21 的**可设卡化**变更（分支 `docs/e2e-matrix-gateable`）不改动
> 下方任何数字——它让同一份清单可被接成门禁（发现项 10 → 9、
> [已知缺口](#已知缺口如实列出) 中的登记表，以及检查器的第二种调用方式）。
> 清单本身即工具在本树上的输出。

## 验收标准

本仓库的每一条 E2E 声明，只有同时满足以下各条才被接受：

1. **日志一对一比对绿色** —— 由 `test/e2e/check.mjs` 产出的
   `verdict*.json`，`pass: true` 且 `expected == logged`
   （精确、有序、不缺、不多）。
2. **截图仅作调试工件** —— 永远不作为检查器输入；证据目录下的截图必须是
   真实 PNG（校验 magic bytes）。
3. **交付物齐全** —— `logs.txt` + `scenario.jsonl` +
   `verdict*.json` + `receipt.json`，提交在正确的 artifacts 目录下。

## 总量（本树）

| 指标 | 数值 |
| --- | --- |
| 证据目录 | 45 |
| 已提交 verdict（91 绿，2 条配额阻塞红） | 93 |
| 至少有一份已提交证据的 scenario | 44 / 44 个不同的 scenario id（36 个 manifest） |
| 已验证 PNG 的截图 | 110 |
| 验收标准缺口 | 9 —— 全部在[已知缺口登记表](#已知缺口如实列出)中有主；0 项阻塞门禁 |

## 覆盖矩阵 —— scenario × 平台

单元格 = 绿色 verdict（捕获时的 `expected/logged`）；目录见
[证据目录清单](#证据目录清单)。短横 = 该平台无已提交证据。

| Scenario | iOS | Android | HarmonyOS | macOS CLI |
| --- | --- | --- | --- | --- |
| `b-android.official-web.mount` | — | 14/14 | — | — |
| `b-android.session.live` | — | 46/46 | — | — |
| `b-android.write.live` | — | 45/45 | — | — |
| `b-harmony.httpfetch-v2` | — | — | 6/6, 6/6, 6/6, 6/6 | — |
| `b-harmony.official-web-mount` | — | — | 17/17, 17/17, 17/17, 17/17 | — |
| `b-harmony.session.live` | — | — | 43/43, 43/43, 43/43 | — |
| `b-harmony.write.live` | — | — | 33/33, 33/33 | — |
| `b1.official-web.mount` | 14/14 | — | — | — |
| `b3.session.live` | 46/46 | — | — | — |
| `b4.write.live` | 43/43 | — | — | — |
| `m1.spike.boot` | 9/9（漂移）, 7/7 | 9/9（漂移）, 7/7, 7/7 | 7/7, 7/7, 7/7, 9/9（漂移）, 7/7, 7/7 | 9/9（漂移） |
| `m1.carrier.loopback` | 7/7, 7/7 | — | — | — |
| `m2.bridge.smoke` | — | 6/6, 6/6 | 6/6, 6/6, 6/6, 6/6, 6/6 | 6/6 |
| `m2.gateway.audit` | 16/16 | 16/16 | — | — |
| `m2.gateway.binding` | 19/19 | — | — | — |
| `m2.llm` | 14/148 | 14/171 | 14/8 **FAIL**（配额） | 19/19 |
| `m2.llm.carrier` | 7/7 | 7/7 | 7/4 **FAIL**（配额） | — |
| `m2.session` | 23/23, 23/23 | 23/23, 22/22（漂移） | 23/23, 23/23, 23/23, 23/23, 23/23 | 23/23 |
| `m2.webclient.mount` | 7/7 | — | — | — |
| `m2.upstream-session` | — | — | — | 31/31 |
| `m2.upstream-boot` | — | — | — | 12/12 |
| `m3.ui-swap` | 7/7 | — | — | — |
| `m3.install` | — | — | — | 22/22 |
| `m3.complete` | — | — | — | 41/41 |
| `m3.fetch-install` | 46/46 | — | — | — |
| `m3.fetch-carrier` | 11/11 | — | — | — |
| `m4.host-binding` | — | 35/35 | — | — |
| `m5.host-binding` | — | — | 20/20（漂移）, 20/20（漂移）, 20/20（漂移）, 20/20（漂移）, 27/27 | — |
| `models.directory` | — | — | — | 6/6 |
| `nextweb.mount` | 16/16 | — | — | — |
| `upstream.parity` | 12/37 + 差分 25/25 | 13/13 + 25/25 | — | 12/37 + 25/25 |

`（漂移）` = 该 verdict 是在更早的 manifest 版本上捕获的
（见[信息性说明](#信息性说明不算失败)）。

43 个不同的 scenario id（35 个 manifest——`m2.llm` 有两个：19 事件的
scripted-SSE CLI 分支与 14 事件的设备分支）全部至少有一份绿色已提交证据；
`m2.session` 在全部四个主机上绿色，models 设置页的 `models.directory` 由
macOS CLI 列承载（api-coverage-probe 所带的 coverage 面断言，现已一对一
声明并机器校验）。main 上的每一条 verdict 都是绿的，
只有 `hosts/harmony/artifacts/m5-m2-llm/` 的两条配额阻塞 verdict 例外
（缺口 8/9，属有意提交）。

`m2.llm` 的设备分支是**repeat 感知**的：其 manifest 用一条
`repeat: true` 期望贪婪匹配 delta 流，因此 verdict 里的 `logged` 是整份
capture 的记录条数、而非匹配条数——`14/171`（Android）与 `14/148`（iOS）
都是 `pass: true` 且 `drift: false`，checker 在 PASS 时打印
`14/14 events, in order`。

## 证据目录清单

`logs` / `scen` / `rcpt` = `logs.txt` / `scenario.jsonl` / `receipt.json`
是否在位。`shots` = PNG 数量（除注明外均通过 magic 校验）。

| 目录 | 平台 | Verdict（`expected/logged`） | logs | scen | rcpt | shots |
| --- | --- | --- | --- | --- | --- | --- |
| `hosts/android/artifacts/android-upstream` | Android | b-android.official-web.mount 14/14 | ✓ | ✓ | ✗（缺口 3） | 4 |
| `hosts/android/artifacts/upstream-parity` | Android | upstream.parity 13/13 + 与 Node 金标的差分 25/25 条记录一致（模拟器腿，设备内 MockLlmRoute） | ✓ | ✓ | ✓ | 0 |
| `hosts/android/artifacts/android-session-live` | Android | b-android.session.live 46/46 | ✓ | ✓ | ✗（缺口 4） | 4 |
| `hosts/android/artifacts/android-write-live` | Android | b-android.write.live 45/45 | ✓ | ✓ | ✗（缺口 7） | 4 |
| `hosts/android/artifacts/m1-spike` | Android | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/android/artifacts/m2-llm` | Android | m2.llm.carrier 7/7, m2.llm 14/171 | ✓ | ✓ | ✓ | 0 |
| `hosts/android/artifacts/m4-complete` | Android | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m2.gateway.audit 16/16, m4.host-binding 35/35 | ✓ | ✓ | ✓ | 5 |
| `hosts/android/artifacts/m4-host` | Android | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 22/22（漂移） | ✓ | ✓ | ✓ | 1 |
| `hosts/harmony/artifacts/d9-official-web` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20, b-harmony.httpfetch-v2 6/6, b-harmony.official-web-mount 17/17 | ✓ | ✓ | ✗（缺口 2） | 4 |
| `hosts/harmony/artifacts/d9-session-live` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20, b-harmony.httpfetch-v2 6/6, b-harmony.official-web-mount 17/17, b-harmony.session.live 43/43 | ✓ | ✓ | ✗（缺口 5） | 6 |
| `hosts/harmony/artifacts/d9-write-live` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20, b-harmony.httpfetch-v2 6/6, b-harmony.official-web-mount 17/17, b-harmony.session.live 43/43, b-harmony.write.live 33/33 | ✓ | ✓ | ✗（缺口 6） | 9 |
| `hosts/harmony/artifacts/m1-spike` | HarmonyOS | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/harmony/artifacts/m5-host` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20 | ✓ | ✓ | ✓ | 2 |
| `hosts/harmony/artifacts/m5-m2-llm` | HarmonyOS | m2.llm.carrier 7/4 **FAIL**, m2.llm 14/8 **FAIL**（配额阻塞，属有意提交——缺口 8/9） | ✓ | ✓ | ✓（`blocked-on-quota`） | 1 |
| `hosts/harmony/artifacts/m5-primitives` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 27/27, b-harmony.httpfetch-v2 6/6, b-harmony.official-web-mount 17/17, b-harmony.session.live 43/43, b-harmony.write.live 33/33 | ✓ | ✓ | ✓ | 9 |
| `hosts/ios/artifacts/b1-official-web` | iOS | b1.official-web.mount 14/14 | ✓ | ✓ | ✓ | 2 |
| `hosts/ios/artifacts/b3-session-live` | iOS | b3.session.live 46/46 | ✓ | ✓ | ✓ | 2 |
| `hosts/ios/artifacts/b4-write-live` | iOS | b4.write.live 43/43 | ✓ | ✓ | ✗（缺口 1） | 3 |
| `hosts/ios/artifacts/m1-carrier` | iOS | m1.carrier.loopback 7/7 | ✓ | ✓ | ✓ | 1 |
| `hosts/ios/artifacts/m1-spike` | iOS | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/ios/artifacts/m2-gateway` | iOS | m1.spike.boot 7/7, m1.carrier.loopback 7/7, m2.gateway.audit 16/16, m2.gateway.binding 19/19 | ✓ | ✓ | ✓ | 9 |
| `hosts/ios/artifacts/m2-llm` | iOS | m2.llm.carrier 7/7, m2.llm 14/148 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/m2-session` | iOS | m2.session 23/23, m2.webclient.mount 7/7 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/m3-complete` | iOS | m3.fetch-carrier 11/11, m3.fetch-install 46/46 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/m3-pluginization` | iOS | m2.session 23/23, m3.ui-swap 7/7 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/upstream-parity` | iOS | upstream.parity 12/37 + 与已提交金标的差分 25/25 条记录一致（模拟器腿；gateway httpFetch → 宿主机侧 mock） | ✓ | ✓ | ✓ | 2 |
| `hosts/ios/artifacts/nextweb-mount` | iOS | nextweb.mount 16/16 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli` | macOS CLI | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-bridge-smoke` | macOS CLI | m2.bridge.smoke 6/6 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m2-llm` | macOS CLI | m2.llm 19/19（scripted-SSE 分支） | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m2-session` | macOS CLI | m2.session 23/23 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m3-install` | macOS CLI | m3.install 22/22 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m3-complete` | macOS CLI | m3.complete 41/41 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-upstream-session` | macOS CLI | m2.upstream-session 31/31 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-upstream-parity` | macOS CLI | upstream.parity 12/37 + 与已提交金标的差分 25/25 条记录一致（两腿各自独立的 mock 实例） | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-models-directory` | macOS CLI | models.directory 6/6 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-settings-surfaces` | macOS CLI | settings.surfaces.cli 12/12 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-tool-fs` | macOS CLI | tool.fs（探针，15 条记录） | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-upstream-boot` | macOS CLI | m2.upstream-boot 12/12 | ✓ | ✓ | ✓ | 0 |

零截图在任何目录都是合规的（标准第 2 条使截图只是可选的调试辅助，
既非交付物也非输入）：CLI 主机目录本就无头，
`hosts/android/artifacts/m2-llm/` 则把 capture 存为
`dsh-m2-llm-stream.txt` 而非图片。

## 已知缺口（如实列出）

本树上有九项未闭合的发现项，且**每一项都有主**。检查器默认全部报出并以
非零码退出；下方这张表就是**已知缺口登记表（known-gaps register）**，
它让同一次运行可以被接成门禁。

- `node test/e2e/matrix.mjs` —— 打印全部发现项（不论是否已登记）并以
  退出码 1 结束：不加修饰的完整清单。
- `node test/e2e/matrix.mjs --accept-known-gaps` —— 当每个发现项都是下方
  登记表的一行时以退出码 0 结束；以下情况以 1 结束：(a) 出现没有任何一行
  命名的发现项，即**新回归**；(b) 某一行对应的发现项已不存在——缺口闭合
  必须在同一变更中把该行划掉；(c) 登记表行数超过检查器的上限 9 行
  ——接受一个新缺口是刻意的编辑，不是漂移。**这条调用就是门禁要接的
  方式，且在本树上已绿：0 项阻塞。**

登记表由下方这张表机器读取，因此这份如实清单是唯一的副本、不会与检查器
漂移。表内单元格按字面读取（该表内不要使用反引号格式）；表格缺失或格式
错误本身就是一条发现项，绝不会静默通过。

| code | file | owner | closes with |
| --- | --- | --- | --- |
| MISSING_DELIVERABLE | hosts/ios/artifacts/b4-write-live/receipt.json | iOS b4 工作流（#65） | run-ios-live-write.sh --art-dir hosts/ios/artifacts/b4-write-live 绿色运行 ＋ 该 runner 的 receipt 步骤 |
| MISSING_DELIVERABLE | hosts/harmony/artifacts/d9-official-web/receipt.json | harmony 工作流（#64） | DSH_SKIP_BUILD=1 hosts/harmony/ci/run-host-e2e.sh hosts/harmony/artifacts/d9-official-web ＋ 同样的 runner 落盘步骤 |
| MISSING_DELIVERABLE | hosts/android/artifacts/android-upstream/receipt.json | android 工作流（#63） | DSH_WEB_ART=hosts/android/artifacts/android-upstream hosts/android/ci/run-android-full.sh ＋ 同样的 runner 落盘步骤 |
| MISSING_DELIVERABLE | hosts/android/artifacts/android-session-live/receipt.json | android 工作流（#66） | DSH_SESSION_ART=hosts/android/artifacts/android-session-live hosts/android/ci/run-android-full.sh ＋ 同样的 runner 落盘步骤 |
| MISSING_DELIVERABLE | hosts/harmony/artifacts/d9-session-live/receipt.json | harmony 工作流（#67） | DSH_SKIP_BUILD=1 hosts/harmony/ci/run-host-e2e.sh hosts/harmony/artifacts/d9-session-live ＋ 同样的 runner 落盘步骤 |
| MISSING_DELIVERABLE | hosts/harmony/artifacts/d9-write-live/receipt.json | harmony 工作流（#70） | DSH_SKIP_BUILD=1 hosts/harmony/ci/run-host-e2e.sh hosts/harmony/artifacts/d9-write-live ＋ 同样的 runner 落盘步骤 |
| MISSING_DELIVERABLE | hosts/android/artifacts/android-write-live/receipt.json | android 工作流（#72） | DSH_WRITE_ART=hosts/android/artifacts/android-write-live hosts/android/ci/run-android-full.sh ＋ 同样的 runner 落盘步骤 |
| VERDICT_FAIL | hosts/harmony/artifacts/m5-m2-llm/verdict-m2-llm-device.json | harmony 工作流（#79） | 配额恢复后 DSH_SKIP_BUILD=1 hosts/harmony/ci/run-live-llm.sh（重置时间 2026-09-22 14:43:53） |
| VERDICT_FAIL | hosts/harmony/artifacts/m5-m2-llm/verdict-m2-llm-carrier.json | harmony 工作流（#79） | 配额恢复后 DSH_SKIP_BUILD=1 hosts/harmony/ci/run-live-llm.sh（重置时间 2026-09-22 14:43:53） |

（检查器读的是英文侧 `docs/e2e-matrix.md` 中的同一张表——配对规则里英文
是源；本表为读者保留等价的中文渲染。）

### 为什么这九项都不在本分支闭合（如实说明）

其中七项需要一份 `receipt.json`，而它只能由各自主机工作流下一次在
设备/模拟器上的运行产出；另两项是对一次真实后端拒绝的有意记录。在本分支
里补写这些 receipt 就等于凭空编造：

- **receipt 证明的是一次运行，而该运行的设备不在已提交工件里。** `host`
  字段记的是运行发生在哪台机器上——iOS 模拟器 UDID 与运行时版本、android
  模拟器实例及其 AVD 与 API 级别、harmony 的 hdc 目标——而
  `test/e2e/run-ios.sh` 是在运行时从 `xcrun simctl` 读取它的。已在本树
  核验：对三个 android 目录执行
  `grep -rliE 'emulator-5554|AVD|Pixel|sdk_gphone'`、对三个 harmony D9
  目录执行 `grep -rliE 'dsh_phone|127.0.0.1:5557|HarmonyOS 7|hdc'`、对
  `hosts/ios/artifacts/b4-write-live/` 执行
  `grep -rliE 'simctl|UDID|iOS 26|A4AE41BF'`，**全部无输出**：绿色
  verdict、capture 与引擎行（`quickjs-ng 0.17.0`，在 android 的
  `results.txt` 中）都已提交，唯独设备不在其中。验收标准第 3 条与 receipt
  约定禁止凭空合成其余字段。
- **没有一次真实绿色运行，receipt 就不可能存在。** `run-ios.sh` 只在绿色
  路径上机器撰写 receipt（第 7 步，仅在全部 checker 通过后可达）。android、
  harmony 与 `run-ios-b4.sh` 的 runner 尚无该步骤，因此这些行需先做 runner
  变更（照搬同样的绿色路径落盘）**再**执行该行点名的重跑——两件事都归目录
  落地的工作流所有。
- **那两条 harmony verdict 是诊断，不是绿色声明。** 请求经本主机真实的
  `httpFetch` 离开了模拟器，而后端拒绝了它（`HTTP 429`、code `1310`、
  周/月额度耗尽）。本仓库内没有任何改动能服务那个轮次；配额恢复后的
  harmony 重跑可以。

按缺口编号的细节（与本清单上方 `rcpt` 列引用的编号一致，也即登记表各行的
顺序）：

1. **`hosts/ios/artifacts/b4-write-live/` 缺 `receipt.json`** —— 目录随
   #65（session 写表面，`b4.write.live` 43/43 绿色）落地。归 iOS b4 工作流
   所有：在携带 #65 的树上跑一次绿色的
   `test/e2e/run-ios-b4.sh --art-dir hosts/ios/artifacts/b4-write-live`，
   并在该 runner 的绿色路径上落盘 receipt（即 `run-ios.sh` 第 7 步的做法）。
2. **`hosts/harmony/artifacts/d9-official-web/` 缺 `receipt.json`** ——
   目录随 #64（harmony webServer carrier）落地。归 harmony 工作流所有：一次
   绿色的
   `DSH_SKIP_BUILD=1 hosts/harmony/ci/run-host-e2e.sh hosts/harmony/artifacts/d9-official-web`
   加上同样的 runner 落盘。
3. **`hosts/android/artifacts/android-upstream/` 缺 `receipt.json`** ——
   目录随 #63（android official-web boot）落地。归 android 工作流所有：一次
   绿色的
   `DSH_WEB_ART=hosts/android/artifacts/android-upstream hosts/android/ci/run-android-full.sh`
   加上同样的 runner 落盘。
4. **`hosts/android/artifacts/android-session-live/` 缺 `receipt.json`**
   —— 目录随 #66（android session.live 主线脊柱，b-android.session.live
   46/46 绿色）落地。归 android 工作流所有：一次绿色的
   `DSH_SESSION_ART=hosts/android/artifacts/android-session-live hosts/android/ci/run-android-full.sh`
   加上同样的 runner 落盘。
5. **`hosts/harmony/artifacts/d9-session-live/` 缺 `receipt.json`** ——
   目录随 #67（harmony session.live 主线脊柱，b-harmony.session.live
   43/43 绿色）落地。归 harmony 工作流所有：一次绿色的
   `DSH_SKIP_BUILD=1 hosts/harmony/ci/run-host-e2e.sh hosts/harmony/artifacts/d9-session-live`
   加上同样的 runner 落盘。
6. **`hosts/harmony/artifacts/d9-write-live/` 缺 `receipt.json`** ——
   目录随 #70（harmony composer 写入路径，b-harmony.write.live 33/33
   绿色）落地。归 harmony 工作流所有：一次绿色的
   `DSH_SKIP_BUILD=1 hosts/harmony/ci/run-host-e2e.sh hosts/harmony/artifacts/d9-write-live`
   加上同样的 runner 落盘。
7. **`hosts/android/artifacts/android-write-live/` 缺 `receipt.json`**
   —— 目录随 #72（android session 写表面，b-android.write.live 45/45
   绿色）落地。归 android 工作流所有：一次绿色的
   `DSH_WRITE_ART=hosts/android/artifacts/android-write-live hosts/android/ci/run-android-full.sh`
   加上同样的 runner 落盘。
8. **`hosts/harmony/artifacts/m5-m2-llm/` 的 `m2.llm` 设备 verdict 是
   红色（14/8），且属有意提交。** 该目录随 #79（鸿蒙真实 LLM 分支）落地。
   分支完全按设计运行，请求也确实经过本主机真实的 `httpFetch` 离开了
   模拟器，但 z.ai 后端**拒绝**了它——`HTTP 429`、code `1310`、
   "Weekly/Monthly Limit Exhausted. Your limit will reset at
   2026-09-22 14:43:53"（用同一把 key 在设备外以 `curl` 复现，因此阻塞
   方是账户而非主机）。被服务的轮次因此从未发生，checker 按设计 FAIL：
   **已提交的 verdict JSON 就是精确诊断，不是绿色声明。** 本次运行确实
   证明的（一对一且有序）：manifest 的前七条设备记录
   （`gateway.negotiated` → `host.ready` → `llm.leg` 经
   `gateway.httpFetch` 选为 real——能力协商，绝非 `hostType` 分支 →
   `llm.config.loaded` app-scope → `session.created` →
   `agent.started` → `llm.stream.started`）、真实的传输往返（请求穿越了
   设备网络栈并由真实服务器应答——后端回 429 本身就是证据），以及该平台
   强制的完整凭据握手（运行时写入 0666 占位 → runner 覆写 → 应用导入并
   校验 → 如实上报封印结果 → 运行结束后删除），且对两条原始流做 key 泄漏
   审计均为干净。被服务的轮次明确不予声明——README.md 的 M5 行在两种语言
   里都这么写。`receipt.json` 记录 `status: blocked-on-quota` 与
   `exitCode: 1`。**收口（归 harmony 工作流所有）：** 配额恢复后执行
   `DSH_SKIP_BUILD=1 hosts/harmony/ci/run-live-llm.sh`——无需改代码；它必须
   以退出码 0 结束且两条 verdict JSON 全绿，刷新的证据回到本目录，并翻转
   README 的相应从句。
9. **`hosts/harmony/artifacts/m5-m2-llm/` 的 `m2.llm.carrier` verdict 是
   红色（7/4），同一次运行、同一原因。** carrier 挂载链
   （`client.selected` → `webclient.mounted` → `ws.connected` →
   `slot.registered`）已记录并匹配；`ws.token-delta` 的首/末条与
   `ws.session-complete` 仍在等待被拒绝的轮次永远不会产生的 delta。
   收口方式同缺口 8。

### 由 2026-09-21 可设卡化变更闭合（docs/e2e-matrix-gateable）

- **缺口 10（FAIL verdict 上派生的 `VERDICT_MALFORMED` 提示）** —— 在检查器
  内闭合，而非改动证据。该计数一致性提示是为了捕捉**通过**记录内部自相矛盾
  （`pass: true` 却 `expected != logged`）；而 `pass: false` 的 verdict 上
  计数不一致本身就是失败、已由 `VERDICT_FAIL` 报出，且该提示的 detail 行
  会对一条实际写着 `pass: false` 的 verdict 声称 `but pass=true`。现条件为
  `v.pass === true && v.expected !== v.logged`，且 `--self-test` 双向证明：
  FAIL verdict 只产生一条发现项、不再附加该提示；而计数不一致的通过 verdict
  仍被拒绝。
- **发现项路径改为相对仓库根**（`relative(root, …)`，此前是
  `relative(process.cwd(), …)`）；打印出来的路径只是**看起来**正确，因为
  该工具总是从仓库根运行。登记表的键不能建立在随 cwd 漂移的路径上，而现在
  登记表的键就是文档表格里的那些字符串。
- 没有删除任何证据、没有撰写任何 receipt、没有改过任何 verdict 来让发现项
  消失：数量从 10 降到 9，是因为其中一条本就是检查器的误报，而不是因为
  隐藏了什么。

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

### 由 2026-09-21 m2-gateway receipt 收口闭合（fix/m2-gateway-receipt）

- **m2-gateway 的 receipt** —— 通过本分支上一次真实的 `run-ios.sh`
  重跑闭合（`e3bd333` 的全新 worktree）：四条 checker 与 manifest 一对一
  复现（m1.spike.boot 7/7、m1.carrier.loopback 7/7、m2.gateway.binding
  19/19、m2.gateway.audit 16/16，expected == logged，退出码 0），证据从
  本次运行刷新，`receipt.json` 由 runner 新增的绿色路径步骤在运行内
  机器撰写（该步骤仅在四条 checker 全部通过后可达——receipt 永远不可能
  脱离一次真实绿色运行而存在）。此次尝试也把上一条目描述的 picker 阻塞
  彻底排除，其「索引时序」只说对了一半：驱动从未**提交**搜索——在
  iOS 26.5 的选择面板上，通过 WDA 输入 "notes" 只会渲染 名称包含 的
  建议行，结果列表只有按下键盘回车后才出现；现已通过同一个与区域设置
  无关的元素 `/value` 端点发送回车（`wda_submit_search`）。结果磁贴的
  标定随之更新（px (204,894) → (163,712) / 2）。围绕它，runner 现在：
  (a) 只预置一次 picker 目标——重写它、甚至重装应用（同版本重装也会使
  数据容器迁移 UUID），都会把该文档从易变的提供器搜索索引中挤出，索引
  在数分钟沉淀后自行恢复；(b) 在 node 缺失时大声失败，并在检查前清除
  陈旧 verdict 文件——此前一次运行曾因 `|| true` 掩盖 "command not
  found" 而按上一次运行的 verdict 判绿；(c) 一切均记录在 surprises
  台账（超越重写的索引易变性、绿色目录先归档再重跑、驱动截止看门狗
  失灵）。

### 信息性说明，不算失败

- **Manifest 版本漂移**（9 条 verdict）：`m1.spike.boot` 在
  `hosts/{ios,android,harmony}/artifacts/m1-spike/` 与
  `runtime/spike/artifacts/macos-cli/` 捕获时为 9 事件，而现行 manifest 声明
  7；`hosts/android/artifacts/m4-host/` 的 `m2.session` 捕获时 22 事件，现行
  23；`m5.host-binding` 在
  `hosts/harmony/artifacts/{d9-official-web,d9-session-live,d9-write-live,m5-host}/`
  捕获时为 20 事件，而 #76 把 manifest 增长到 27（`m5-primitives` 是
  27/27 的重新捕获）。verdict 是捕获时的记录；旧日志不保证能用增长后的
  manifest 重新校验。检查器报告 `drift: true`，但不因此失败。
- **此前列为「进行中」的三个目录均已尘埃落定。**
  `runtime/spike/artifacts/macos-cli-m2-llm/` 随 #74 落地，现为绿色表行
  （scripted-SSE CLI 分支，`m2.llm` 19/19）；M5 的收尾证据则以
  `hosts/harmony/artifacts/m5-primitives/`（#76，descriptor 9/0）与
  `hosts/harmony/artifacts/m5-m2-llm/`（#79，配额阻塞——缺口 8/9）落地。
  `hosts/android/artifacts/m3-android-install/` 与
  `hosts/harmony/artifacts/m5-complete/` 从未被任何分支提交过
  （两条路径的 `git log --all` 均为空）——并不存在这样的证据可报。
- **FAIL verdict 上的派生提示已消失。** 检查器现在只对 `pass: true` 的记录
  附加计数一致性提示；`pass: false` 的 verdict 上同样的计数不一致就是
  `VERDICT_FAIL` 本身，只报一次。（即上方的缺口 10 收口说明。）

## 检查器及其拒绝证明

`test/e2e/matrix.mjs`（仅标准库）从工作树再生成清单，任何回归即以非零码
退出：verdict 失败、交付物缺失/为空、PNG 损坏、verdict/receipt 畸形、
scenario id 在 `test/e2e/scenarios/` 无 manifest，或已知缺口登记表本身有
缺陷。其 `--self-test` 模式证明每个拒绝类别都真的会拒绝（18 条断言，
规则 6）——断言集记录在
[e2e README](../test/e2e/README.md#inventory-matrix-matrixmjs)。

一种事实，两种调用（文件头写着同一份契约）：

```sh
node test/e2e/matrix.mjs                       # 打印全部发现项，退出码 1
node test/e2e/matrix.mjs --accept-known-gaps   # 全部由登记表认领时退出码 0
node test/e2e/matrix.mjs --out /tmp/inv.json   # 机器可读清单（含评估结果）
```

检查器**仍未接入 `gates.json`**：该文件在 plane seal 之内，而重新封印是一次
被记录的治理仪式，不是一项文档变更的副作用。本次变更让「接线」变得
**可行且小**：门禁调用在本树上为绿（**0 项阻塞**），它接受的那九个缺口都在
上方登记表中有主、可收口，而第一个新发现项会让同一条命令立刻变红。接线
就是一次 gate 加上封印：

```sh
gov gate add e2e-matrix --description "cross-host E2E evidence inventory (known-gaps register)" \
  --timeout 120000 -- node test/e2e/matrix.mjs --accept-known-gaps
gov verify-plane --write     # 接受 gates.json 差异的那次仪式
```

还有一件同属该仪式：规则 6 要求每个门禁配一个项目级拒绝用例（`gov self-test`
会统计它，新门禁在此前会被标为 `NONE — rule 6`）。
`.gov/rejections/case-e2e-matrix.sh` 同样在 seal 之内，因此也归 owner 添加——
检查器的 `--self-test`（18 条断言）就是这样一个用例可以包裹的断言集：构造一棵
含违规的 fixture 树，断言运行变红；把该缺口列入登记表，断言同一次运行转绿。

（该命令按运行者的 PATH 解析 `node`：macOS runner（`dev-ios.yml`）早已用裸
`node` 运行这些 checker 且无 setup 步骤；而在 `gov.yml` 使用的 ubuntu runner
上，环境里的 node 即 `dev-android.yml` 记录的那个——"the runner's default node
carries an older corepack"，存在但旧到值得平台构建各自 pin 一个。命令无法解析
时门禁会以 `MISSING` 大声失败、而非静默通过，因此在两种情况下接线都安全，
符合规则 5。）
