# 跨主机 E2E 证据矩阵

[English](e2e-matrix.md) | 简体中文

汇总四个主机（iOS、Android、HarmonyOS、macOS CLI）全部 E2E 声明的验收证据，
数据来自已提交的 artifacts 目录。由
[test/e2e/matrix.mjs](../test/e2e/matrix.mjs) 机器校验。

> **时效性**：本矩阵反映 BYOK 引导变更（2026-09-30）：为没有现成 API key
> 的内测用户提供首启凭证面板 —— CLI 腿 `onboarding.flow` 9/9（无凭证检测 →
> 连接测试的成功与 401 两路，走真实 gateway httpFetch 传输 → keychain 存入
> → 已配过再检测 → 重启路由解析 → 重绑定路由上的首回合），目录
> `runtime/spike/artifacts/macos-cli-onboarding/`；CLI 开发宿主自此实现冻结
> 的 keychain 原语（每 ref 一个 0600 文件 —— `gateway.bridge-smoke` 重钉为
> roundtrip，7/7）；`llm.js` 的 SSE 排空不再在 [DONE] 折叠处遗留挂起的
> `next()`（实测：该孤儿续体会令 CLI 引擎硬中止）。总量对本树重跑（71 个
> 目录 / 145 条 verdict / 70 个 scenario id 全部有绿证 / 校验器解析到 62 个
> manifest）。下面的注记是历史的时效记录。
>
>
> **时效性**：本矩阵反映 shim 曝光测绘 + 探针腿（2026-09-30，T-0078）：
> 加载器现在能点名每一次 shim 加载（`DSH_MODULE_MANIFEST`，默认关闭），
> 对全部 648 个转译上游 spec 的 sweep 测绘发现：86 个 shim 的零曝光集合
> 恰好是 1 个（`dsh-session-persistence.js`——被 vendored 包收割 orphan 掉
> 的加载映射），基线之外的薄尾巴是 node-sqlite 3/648、
> openai-client/partial-json/slot-registry 各 5/648、string-decoder 7/648；
> 新 CLI 腿 `shim.exposure-probe` 在真实引擎上压这五张脸（8/8，目录
> `runtime/spike/artifacts/macos-cli-shim-exposure-probe/`；先证伪——
> 打断 string-decoder 的尾字节持有即变红）。总量对本树重跑（73 目录 /
> 149 verdict / 73 of 73 scenario id 绿覆盖 / 66 manifest），同时并入
> 自上一条注记重跑之后落地的 BLE + 相机 + 麦克风 + parity 目录。
>
> **时效性**：本矩阵反映能力面＋模拟器矩阵收编（2026-09-30，规则 12——
> #249 / #250 / #252 / #254 / #255，均已合并）：相机、麦克风、BLE 三面与
> 发布级模拟器矩阵连同其已提交证据一并入账 —— `mic.plane`（iOS 11/11 +
> 审计 6/6；Android 9/9 + `android.mic.plane.audit` 4/4 腿）、
> `ble.plane` / `ble.plane.audit`（每宿主确定性 mock 电台 16/16 + 如实
> 电台缺席 8/8——没有模拟器有可用电台，mock 与真实电台共用同一套
> gateway 强制/同意/审计；真机腿走 D-g 一键契约）、`simulator-matrix/*`
> 目录（device.plane iOS 16/16 / Android 15/15 加审计腿、regression /
> gateway-drive 腿、每宿主 `release-proof.json`；鸿蒙诚实 skip 凭据
> `matrix-skip-receipt.json`——D-g 待命），以及下方表格从未承载过的
> `device.plane` 行（iOS 16/16、Android 15/15、鸿蒙 13/13）。总量对该树
> 重跑（72 目录 / 148 verdict / 72 of 72 scenario id 绿覆盖 / 65
> manifest）——**每一条已提交 verdict 都是绿的**。同一次变更带两笔漂移
> 记录：(a) 配额阻塞的 `m5-m2-llm` 目录已不在——2026-09-28 的重跑以
> `m5-llm-live-stream` 落地绿色被服务轮次（`llm.live-stream` 14/130 +
> `llm.live-stream.carrier` 7/7，提交 `64889c54`），缺口 8/9 闭合，但
> 下方注记与单元格直到本次才不再携带红色状态；(b) 登记表第八行——
> Android 相机审计的自相矛盾 verdict（由 BLE 线的变基发现）——已在下方
> 说明。下面的注记是历史的时效记录。
>
> **时效性**：本矩阵反映麦克风面变更（2026-09-30）：能力面的 microphone
> 面在移动宿主上落地 —— 一个平台中立 scenario `mic.plane` 逐宿主驱动
> （描述符 iOS 25 / Android 26 / HarmonyOS 18；iOS 与 Android 真跑 armed
> 阶梯、带真实 PCM 帧 —— arm、帧流、stop 记录的时长/字节数、恰好一次的
> end、幂等与未知 id 腿），receipt 在
> `hosts/{ios,android}/artifacts/mic-plane/`；HarmonyOS 腿走 D-g（runner
> 与 drive 已备好；本机的模拟器从未挂上 hdc target，故不声明 harmony
> receipt）。iOS 的 arm 由 8 秒围栏兜底：宿主音频路由卡死时诚实回答
> `unavailable`（manifest 按当次实跑形状重钉 —— pasteboard 姿态）。

> **时效性**：本矩阵反映能力面相机变更（2026-09-30）：`camera.plane` +
> `camera.plane.audit` 在 iOS（模拟器的如实 capture-unavailable 姿态，目录
> `hosts/ios/artifacts/camera-plane/`）与 Android（模拟器虚拟相机真实连拍
> —— 2 帧 / 44157 字节 / 457 ms —— 加 maxBytes 丢弃腿，目录
> `hosts/android/artifacts/camera-plane/`）双绿；总量对本树重跑（59 目录 /
> 122 verdict / 65 of 65 scenario id 绿覆盖 / 51 manifest；harmony 真机腿与
> iOS 真机腿待真机——一键脚本已备好，绝不合成证据）。下面的注记是历史的
> 时效记录。
>
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
| 证据目录 | 73 |
| 已提交 verdict（149 绿） | 149 |
| 至少有一份已提交证据的 scenario | 73 / 73 个不同的 scenario id（66 个 manifest） |
| 已验证 PNG 的截图 | 160 |
| 验收标准缺口 | 8 —— 全部在[已知缺口登记表](#已知缺口如实列出)中有主；0 项阻塞门禁 |

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
| `b-harmony.write.live` | — | — | 33/33（漂移）, 33/33（漂移） | — |
| `b1.official-web.mount` | 14/14 | — | — | — |
| `officialweb.mount` | 14/14 | — | — | — |
| `b3.session.live` | 46/46 | — | — | — |
| `session.live-read` | 46/46 | — | — | — |
| `b4.write.live` | 46/46, 43/43（漂移） | — | — | — |
| `agent.flow` | 17/17 | — | — | — |
| `ble.plane` | 16/16, 8/8 | 16/16, 8/8 | — | — |
| `ble.plane.audit` | 8/8, 4/4 | 8/8, 4/4 | — | — |
| `boot.verification` | 8/8, 8/8 | 8/8 | 8/8 | — |
| `carrier.loopback` | 7/7, 7/7 | — | — | — |
| `camera.plane` | 6/6 | 8/8 | — | — |
| `camera.plane.audit` | 3/3 | 5/6（漂移） | — | — |
| `composer.live-write` | 46/46 | — | — | — |
| `device.plane` | 16/16, 16/16 | 15/15, 15/15 | 13/13 | — |
| `device.plane.audit` | 14/23, 14/23 | 13/22, 13/22 | — | — |
| `m1.spike.boot` | 9/9（漂移）, 7/7（漂移） | 9/9（漂移）, 7/7（漂移）, 7/7（漂移） | 7/7（漂移）, 7/7（漂移）, 7/7（漂移）, 9/9（漂移）, 7/7（漂移）, 7/7（漂移） | 9/9（漂移） |
| `m1.carrier.loopback` | 7/7, 7/7 | — | — | — |
| `m2.bridge.smoke` | — | 6/6, 6/6 | 6/6, 6/6, 6/6, 6/6, 6/6 | 6/6 |
| `gateway.bridge-smoke` | — | 6/6 | 6/6 | — |
| `gateway.audit` | 16/16, 16/16 | — | — | — |
| `gateway.binding` | 19/19, 19/19 | — | — | — |
| `m2.gateway.audit` | 16/16 | 16/16 | — | — |
| `m2.gateway.binding` | 19/19 | — | — | — |
| `install.carrier-evidence` | 11/11 | — | — | — |
| `install.from-http` | 46/46 | — | — | — |
| `m2.llm` | 14/148 | 14/171 | — | 19/19 |
| `m2.llm.carrier` | 7/7 | 7/7 | — | — |
| `llm.live-stream` | 14/67 | — | 14/130 | — |
| `llm.live-stream.carrier` | 7/7 | — | 7/7 | — |
| `m2.session` | 23/23, 23/23 | 23/23, 22/22（漂移） | 23/23, 23/23, 23/23, 23/23, 23/23 | 23/23 |
| `m2.webclient.mount` | 7/7 | — | — | — |
| `webclient.mount` | 7/7 | — | — | — |
| `upstream.session` | — | — | — | 31/31 |
| `upstream.web-boot` | — | — | — | 12/12 |
| `m3.ui-swap` | 7/7 | — | — | — |
| `m3.install` | — | — | — | 22/22 |
| `m3.complete` | — | — | — | 41/41 |
| `m3.fetch-install` | 46/46 | — | — | — |
| `m3.fetch-carrier` | 11/11 | — | — | — |
| `ish.shell` | — | — | — | 11/11 |
| `m4.host-binding` | — | 35/35 | — | — |
| `m5.host-binding` | — | — | 20/20（漂移）, 20/20（漂移）, 20/20（漂移）, 20/20（漂移）, 27/27 | — |
| `harmony.capability-binding` | — | — | 27/27 | — |
| `harmony.composer.live-write` | — | — | 36/36 | — |
| `harmony.httpfetch-streaming` | — | — | 6/6 | — |
| `harmony.officialweb.mount` | — | — | 17/17 | — |
| `harmony.session.live-read` | — | — | 43/43 | — |
| `mic.plane` | 11/11 | 9/9（漂移） | — | — |
| `mic.plane.audit` | 6/6 | — | — | — |
| `android.mic.plane.audit` | — | 4/4（漂移） | — | — |
| `models.directory` | — | — | — | 6/6 |
| `office` | — | — | — | 19/19 |
| `onboarding.flow` | — | — | — | 9/9 |
| `open.design` | — | — | — | 15/15 |
| `session.mock-llm` | 23/23, 23/23 | 23/23 | 23/23 | — |
| `settings.surfaces.cli` | — | — | — | 12/12 |
| `nextweb.mount` | 24/24 | — | — | — |
| `whale.mount` | 7/7 | — | — | — |
| `android.whale.mount` | — | 7/7 | — | — |
| `android.nextweb.mount` | — | 24/24 | — | — |
| `harmony.whale.mount` | — | — | 7/7 | — |
| `harmony.nextweb.mount` | — | — | 24/24 | — |
| `upstream.parity` | 12/37（漂移） + 差分 25/25 | 13/13 + 25/25 | — | 12/37（漂移） + 25/25 |
| `userland.shell` | — | — | — | 11/11 |
| `lynx.mount` | — | — | — | 34/34, 34/34 |
| `socket.seam` | — | — | — | 19/19 |
| `shim.exposure-probe` | — | — | — | 8/8 |

`（漂移）` = 该 verdict 是在更早的 manifest 版本上捕获的
（见[信息性说明](#信息性说明不算失败)）。

73 个不同的 scenario id（66 个 manifest——`m2.llm` 有两个：19 事件的
scripted-SSE CLI 分支与 14 事件的设备分支）全部至少有一份绿色已提交证据；
`m2.session` 在全部四个主机上绿色，models 设置页的 `models.directory` 由
macOS CLI 列承载（api-coverage-probe 所带的 coverage 面断言，现已一对一
声明并机器校验）。main 上的每一条 verdict 都是绿的：两条配额阻塞的
`m5-m2-llm` verdict 已于 2026-09-28 以 `m5-llm-live-stream` 重跑转绿
（`llm.live-stream` 14/130 + `llm.live-stream.carrier` 7/7，提交
`64889c54`），红色目录已划掉——被服务的轮次已可宣称。

`m2.llm` 的设备分支是**repeat 感知**的：其 manifest 用一条
`repeat: true` 期望贪婪匹配 delta 流，因此 verdict 里的 `logged` 是整份
capture 的记录条数、而非匹配条数——`14/171`（Android）与 `14/148`（iOS）
都是 `pass: true` 且 `drift: false`，checker 在 PASS 时打印
`14/14 events, in order`。同一约定也解释 `device.plane.audit` 单元格
（iOS `14/23`、Android `13/22`，均 `pass: true`）：审计 manifest 同样
repeat 匹配，`logged` 是 capture 的记录条数而非匹配条数。

## 证据目录清单

`logs` / `scen` / `rcpt` = `logs.txt` / `scenario.jsonl` / `receipt.json`
是否在位。`shots` = PNG 数量（除注明外均通过 magic 校验）。

| 目录 | 平台 | Verdict（`expected/logged`） | logs | scen | rcpt | shots |
| --- | --- | --- | --- | --- | --- | --- |
| `hosts/android/artifacts/android-upstream` | Android | b-android.official-web.mount 14/14 | ✓ | ✓ | ✗（缺口 3） | 4 |
| `hosts/android/artifacts/upstream-parity` | Android | upstream.parity 13/13 + 与 Node 金标的差分 25/25 条记录一致（模拟器腿，设备内 MockLlmRoute） | ✓ | ✓ | ✓ | 0 |
| `hosts/android/artifacts/android-session-live` | Android | b-android.session.live 46/46 | ✓ | ✓ | ✗（缺口 4） | 4 |
| `hosts/android/artifacts/android-write-live` | Android | b-android.write.live 45/45 | ✓ | ✓ | ✗（缺口 7） | 4 |
| `hosts/android/artifacts/whale-mount` | Android | android.whale.mount 7/7 | ✓ | ✓ | ✓ | 1 |
| `hosts/android/artifacts/nextweb-mount` | Android | android.nextweb.mount 24/24 | ✓ | ✓ | ✓ | 2 |
| `hosts/android/artifacts/m1-spike` | Android | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/android/artifacts/m2-llm` | Android | m2.llm.carrier 7/7, m2.llm 14/171 | ✓ | ✓ | ✓ | 0 |
| `hosts/android/artifacts/m4-complete` | Android | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m2.gateway.audit 16/16, m4.host-binding 35/35 | ✓ | ✓ | ✓ | 5 |
| `hosts/android/artifacts/m4-host` | Android | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 22/22（漂移） | ✓ | ✓ | ✓ | 1 |
| `hosts/android/artifacts/ble-mock` | Android | ble.plane 16/16, ble.plane.audit 8/8（确定性 mock 电台的双设备 GATT 库——180f/2a19 read+notify、fe00/fe01 write——与真实电台共用同一套 gateway 强制、同意层与审计） | ✓ | ✓ | ✓ | 0 |
| `hosts/android/artifacts/ble-skip` | Android | ble.plane 8/8, ble.plane.audit 4/4（如实无电台姿态：模拟器的虚拟控制器带未授予的运行时权限） | ✓ | ✓ | ✓ | 0 |
| `hosts/android/artifacts/camera-plane` | Android | camera.plane 8/8, camera.plane.audit 5/6（漂移——登记表第八行：该审计 verdict 记录 pass=true 且 expected=5 logged=6，属继承红） | ✓ | ✓ | ✓ | 0 |
| `hosts/android/artifacts/mic-plane` | Android | mic.plane 9/9（漂移）, android.mic.plane.audit 4/4（漂移）——武装梯带真实 PCM 帧 | ✓ | ✓ | ✓ | 1 |
| `hosts/android/artifacts/simulator-matrix/device-plane` | Android | device.plane 15/15, device.plane.audit 13/22 | ✓ | ✓ | ✓ | 4 |
| `hosts/android/artifacts/simulator-matrix/regression` | Android | boot.verification 8/8, gateway.bridge-smoke 6/6, session.mock-llm 23/23 | ✓ | ✓ | ✓ | 1 |
| `hosts/android/artifacts/device-plane` | Android | device.plane 15/15, device.plane.audit 13/22 | ✓ | ✓ | ✓ | 4 |
| `hosts/harmony/artifacts/d9-official-web` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20, b-harmony.httpfetch-v2 6/6, b-harmony.official-web-mount 17/17 | ✓ | ✓ | ✗（缺口 2） | 4 |
| `hosts/harmony/artifacts/d9-session-live` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20, b-harmony.httpfetch-v2 6/6, b-harmony.official-web-mount 17/17, b-harmony.session.live 43/43 | ✓ | ✓ | ✗（缺口 5） | 6 |
| `hosts/harmony/artifacts/d9-write-live` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20, b-harmony.httpfetch-v2 6/6, b-harmony.official-web-mount 17/17, b-harmony.session.live 43/43, b-harmony.write.live 33/33 | ✓ | ✓ | ✗（缺口 6） | 9 |
| `hosts/harmony/artifacts/whale-mount` | HarmonyOS | harmony.whale.mount 7/7 | ✓ | ✓ | ✓ | 1 |
| `hosts/harmony/artifacts/nextweb-mount` | HarmonyOS | harmony.nextweb.mount 24/24 | ✓ | ✓ | ✓ | 1 |
| `hosts/harmony/artifacts/device-plane` | HarmonyOS | device.plane 13/13 | ✓ | ✓ | ✓ | 1 |
| `hosts/harmony/artifacts/m1-spike` | HarmonyOS | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/harmony/artifacts/m5-host` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 20/20（漂移）, harmony.capability-binding 27/27, boot.verification 8/8, gateway.bridge-smoke 6/6, session.mock-llm 23/23, harmony.officialweb.mount 17/17, harmony.session.live-read 43/43, harmony.composer.live-write 36/36, harmony.httpfetch-streaming 6/6 | ✓ | ✓ | ✓ | 11 |
| `hosts/harmony/artifacts/m5-llm-live-stream` | HarmonyOS | llm.live-stream 14/130, llm.live-stream.carrier 7/7 —— 配额阻塞的 `m5-m2-llm` 目录于 2026-09-28 重跑转绿（提交 `64889c54`）；被服务的轮次已可宣称 | ✓ | ✓ | ✓ | 1 |
| `hosts/harmony/artifacts/m5-primitives` | HarmonyOS | m1.spike.boot 7/7, m2.bridge.smoke 6/6, m2.session 23/23, m5.host-binding 27/27, b-harmony.httpfetch-v2 6/6, b-harmony.official-web-mount 17/17, b-harmony.session.live 43/43, b-harmony.write.live 33/33 | ✓ | ✓ | ✓ | 9 |
| `hosts/ios/artifacts/b1-official-web` | iOS | b1.official-web.mount 14/14 | ✓ | ✓ | ✓ | 2 |
| `hosts/ios/artifacts/b3-session-live` | iOS | b3.session.live 46/46 | ✓ | ✓ | ✓ | 2 |
| `hosts/ios/artifacts/b4-write-live` | iOS | b4.write.live 46/46 | ✓ | ✓ | ✗（缺口 1） | 3 |
| `hosts/ios/artifacts/m1-carrier` | iOS | m1.carrier.loopback 7/7 | ✓ | ✓ | ✓ | 1 |
| `hosts/ios/artifacts/m1-spike` | iOS | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 1 |
| `hosts/ios/artifacts/m2-gateway` | iOS | m1.spike.boot 7/7, m1.carrier.loopback 7/7, m2.gateway.audit 16/16, m2.gateway.binding 19/19 | ✓ | ✓ | ✓ | 9 |
| `hosts/ios/artifacts/m2-llm` | iOS | m2.llm.carrier 7/7, m2.llm 14/148 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/m2-session` | iOS | m2.session 23/23, m2.webclient.mount 7/7 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/m3-complete` | iOS | m3.fetch-carrier 11/11, m3.fetch-install 46/46 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/m3-pluginization` | iOS | m2.session 23/23, m3.ui-swap 7/7 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/upstream-parity` | iOS | upstream.parity 12/37（漂移） + 与已提交金标的差分 25/25 条记录一致（模拟器腿；gateway httpFetch → 宿主机侧 mock） | ✓ | ✓ | ✓ | 2 |
| `hosts/ios/artifacts/nextweb-mount` | iOS | nextweb.mount 24/24 | ✓ | ✓ | ✓ | 0 |
| `hosts/ios/artifacts/agent-flow` | iOS | agent.flow 17/17 | ✓ | ✓ | ✓ | 4 |
| `hosts/ios/artifacts/composer-live-write` | iOS | composer.live-write 46/46 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/device-plane` | iOS | device.plane 16/16, device.plane.audit 14/23 | ✓ | ✓ | ✓ | 6 |
| `hosts/ios/artifacts/gateway` | iOS | boot.verification 8/8, carrier.loopback 7/7, gateway.audit 16/16, gateway.binding 19/19 | ✓ | ✓ | ✓ | 7 |
| `hosts/ios/artifacts/install-full-cycle` | iOS | install.carrier-evidence 11/11, install.from-http 46/46 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/llm-live-stream` | iOS | llm.live-stream 14/67, llm.live-stream.carrier 7/7 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/session-live-read` | iOS | session.live-read 46/46 | ✓ | ✓ | ✓ | 2 |
| `hosts/ios/artifacts/session-mock-llm` | iOS | session.mock-llm 23/23, webclient.mount 7/7 | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/wasm-shell-e2e` | iOS | b4.write.live 43/43（漂移） | ✓ | ✓ | ✓ | 3 |
| `hosts/ios/artifacts/ble-mock` | iOS | ble.plane 16/16, ble.plane.audit 8/8（同一台确定性 mock 电台、同一套强制） | ✓ | ✓ | ✓ | 0 |
| `hosts/ios/artifacts/ble-skip` | iOS | ble.plane 8/8, ble.plane.audit 4/4（如实电台缺席姿态） | ✓ | ✓ | ✓ | 0 |
| `hosts/ios/artifacts/camera-plane` | iOS | camera.plane 6/6, camera.plane.audit 3/3（模拟器如实回答 capture-unavailable 的姿态） | ✓ | ✓ | ✓ | 0 |
| `hosts/ios/artifacts/mic-plane` | iOS | mic.plane 11/11, mic.plane.audit 6/6 —— 武装梯带真实 PCM 帧 | ✓ | ✓ | ✓ | 1 |
| `hosts/ios/artifacts/simulator-matrix/device-plane` | iOS | device.plane 16/16, device.plane.audit 14/23 | ✓ | ✓ | ✓ | 5 |
| `hosts/ios/artifacts/simulator-matrix/gateway-drive` | iOS | boot.verification 8/8, carrier.loopback 7/7, gateway.audit 16/16, gateway.binding 19/19 | ✓ | ✓ | ✓ | 7 |
| `hosts/ios/artifacts/whale-mount` | iOS | whale.mount 7/7, session.mock-llm 23/23 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli` | macOS CLI | m1.spike.boot 9/9 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-bridge-smoke` | macOS CLI | m2.bridge.smoke 6/6 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m2-llm` | macOS CLI | m2.llm 19/19（scripted-SSE 分支） | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m2-session` | macOS CLI | m2.session 23/23 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m3-install` | macOS CLI | m3.install 22/22 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-m3-complete` | macOS CLI | m3.complete 41/41 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-upstream-session` | macOS CLI | upstream.session 31/31 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-upstream-parity` | macOS CLI | upstream.parity 12/37（漂移） + 与已提交金标的差分 25/25 条记录一致（两腿各自独立的 mock 实例） | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-models-directory` | macOS CLI | models.directory 6/6 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-onboarding` | macOS CLI | onboarding.flow 9/9 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-settings-surfaces` | macOS CLI | settings.surfaces.cli 12/12 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-tool-fs` | macOS CLI | tool.fs（探针，15 条记录） | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-upstream-boot` | macOS CLI | upstream.web-boot 12/12 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-ish-shell` | macOS CLI | ish.shell 11/11 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-office` | macOS CLI | office 19/19 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-open-design` | macOS CLI | open.design 15/15 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-userland-shell` | macOS CLI | userland.shell 11/11 | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-socket-seam` | macOS CLI | socket.seam 19/19（回环缝：带半关闭的真实 TCP echo、一个经 /dev/tcp 拨接测试服务器的 /bin/bash 子进程、两条越界拒绝腿；审计门钉 listen=3 connect=3 accept=2 denied=2） | ✓ | ✓ | ✓ | 0 |
| `runtime/spike/artifacts/macos-cli-shim-exposure-probe` | macOS CLI | shim.exposure-probe 8/8（shim 曝光测绘的五条行为腿：被 orphan 的 dsh-session-persistence 错误类、node:sqlite `:memory:`、string-decoder 的分片 UTF-8 持有、partial-json + openai-client 的线上脸、slot-registry 的守卫） | ✓ | ✓ | ✓ | 0 |
| `hosts/ios/artifacts/settings-screens` | iOS | ——（仅人看证据；机器断言在 `b4-write-live`） | ✓（app-stdout） | ✗（设计使然） | ✗（设计使然） | 2 |
| `presentation/lynx-client/artifacts/cli-lynx-mount-lynx` | macOS CLI | lynx.mount 34/34（lynx 皮肤：bundle 的缝核心 + 工件 sha256 校验） | ✓ | ✓ | ✓ | 0 |
| `presentation/lynx-client/artifacts/cli-lynx-mount-stub` | macOS CLI | lynx.mount 34/34（stub 皮肤：同一流程——即可替换性证明） | ✓ | ✓ | ✓ | 0 |

零截图在任何目录都是合规的（标准第 2 条使截图只是可选的调试辅助，
既非交付物也非输入）：CLI 主机目录本就无头，
`hosts/android/artifacts/m2-llm/` 则把 capture 存为
`dsh-m2-llm-stream.txt` 而非图片。

## 已知缺口（如实列出）

本树上有八项未闭合的发现项，且**每一项都有主**。检查器默认全部报出并以
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
| VERDICT_MALFORMED | hosts/android/artifacts/camera-plane/verdict-camera-plane-capture-audit.json | 相机工作流（#252） | 重跑 DSH_ANDROID_SERIAL=<模拟器> hosts/android/ci/run-camera-plane.sh 以再生成自洽的 verdict（已提交文件记录 pass=true 且 expected=5 logged=6——继承红，由 BLE 线的变基发现） |

（检查器读的是英文侧 `docs/e2e-matrix.md` 中的同一张表——配对规则里英文
是源；本表为读者保留等价的中文渲染。）

### 为什么这八项都不在本分支闭合（如实说明）

其中七项需要一份 `receipt.json`，而它只能由各自主机工作流下一次在
设备/模拟器上的运行产出；第八项是相机落地时继承的一份自相矛盾
verdict，归相机工作流下一次模拟器运行所有。在本分支
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
- **第八项是一条自我矛盾的 verdict，不是缺失的运行。**
  `hosts/android/artifacts/camera-plane/verdict-camera-plane-capture-audit.json`
  记录 `pass: true` 且 `expected=5, logged=6`——相机落地（#252）提交的
  继承红，由 BLE 线的变基（#254）发现。登记表行存在的意义正是让这一类
  缺口被点名、有主、可收口：相机工作流下一次 Android 模拟器运行会再生成
  自洽的 verdict。本次收编只做记录，不再生成设备证据（本机没有挂着的
  模拟器，而合成 verdict 是验收标准唯一禁止的动作）。

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
8. **`hosts/android/artifacts/camera-plane/verdict-camera-plane-capture-audit.json`
   自相矛盾** —— `pass: true` 却 `expected=5, logged=6`。目录随 #252
   （相机面）落地；该畸形 verdict 属继承红，由 BLE 线的变基（#254）发现，
   正是那次变基补上了登记表行。与 repeat 感知的审计 manifest
   （`device.plane.audit` 的 `14/23`）不同，这份 manifest 没有声明
   `repeat` 期望，因此 `pass: true` 记录上的计数分歧是真实矛盾——正是
   检查器计数一致性提示为之存在的形状。**收口（归相机工作流所有）：**
   重跑 `DSH_ANDROID_SERIAL=<模拟器> hosts/android/ci/run-camera-plane.sh`
   以再生成自洽的 verdict——无需改代码。

### 由 2026-09-28 配额重置重跑闭合（上游套件跟进，提交 `64889c54`）

- **缺口 8 与 9（配额阻塞的 `m5-m2-llm` verdict）** —— 按登记表点名的
  真实重跑闭合：编程套餐配额重置后，`hosts/harmony/ci/run-live-llm.sh`
  在模拟器上跑绿，证据以 `hosts/harmony/artifacts/m5-llm-live-stream/`
  落地——`llm.live-stream` 14/130 与 `llm.live-stream.carrier` 7/7，
  均 `pass: true, drift: false`，`receipt.json` 由机器撰写
  （producedAt 2026-09-28T05:36:49Z）。旧条目拒绝宣称的被服务轮次现已
  宣称；红色 `m5-m2-llm` 目录被划掉，登记表行也在同一次变更中移除。
  不过那次跟进没有更新本文档的单元格与注记——它们一直携带红色状态，
  直到能力面收编（2026-09-30）重跑总量并调和了每一处表面。这种滞后的
  状态翻转正是规则 12 要防止的失败，记录在此让模式可见。

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

- **Manifest 版本漂移**（25 条 verdict）：`m1.spike.boot` 在
  `hosts/{ios,android,harmony}/artifacts/m1-spike/` 与
  `runtime/spike/artifacts/macos-cli/` 捕获时为 9 事件，而现行 manifest 声明
  7；`hosts/android/artifacts/m4-host/` 的 `m2.session` 捕获时 22 事件，现行
  23；`m5.host-binding` 在
  `hosts/harmony/artifacts/{d9-official-web,d9-session-live,d9-write-live,m5-host}/`
  捕获时为 20 事件，而 #76 把 manifest 增长到 27（`m5-primitives` 是
  27/27 的重新捕获）。上一次时效重跑之后，同类继续增长：
  `b-harmony.write.live` 33/33（d9-write-live、m5-primitives）、
  `upstream.parity` 12/37（iOS 模拟器、macOS CLI）、Android 的 `mic.plane`
  一对与相机 `5/6` 审计腿（各宿主如实姿态重钉）、`b4.write.live` 43/43
  （wasm-shell-e2e）、以及 `m1.spike.boot` 7/7 的重捕（m4-complete、
  m4-host、m2-gateway、m5-host、m5-primitives、各 d9 目录）。verdict 是
  捕获时的记录；旧日志不保证能用增长后的 manifest 重新校验。检查器报告
  `drift: true`，但不因此失败。
- **此前列为「进行中」的三个目录均已尘埃落定。**
  `runtime/spike/artifacts/macos-cli-m2-llm/` 随 #74 落地，现为绿色表行
  （scripted-SSE CLI 分支，`m2.llm` 19/19）；M5 的收尾证据则以
  `hosts/harmony/artifacts/m5-primitives/`（#76，descriptor 9/0）与
  `hosts/harmony/artifacts/m5-m2-llm/`（#79，配额阻塞——缺口 8/9，现已
  闭合：该目录于 2026-09-28 以 `m5-llm-live-stream` 重跑转绿，提交
  `64889c54`）落地。
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
**可行且小**：门禁调用在本树上为绿（**0 项阻塞**），它接受的那八个缺口都在
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
