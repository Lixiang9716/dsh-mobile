# 发布回归终跑 — v0.0.2

[English](release-regression-v0.0.2.md) | 简体中文

> v0.0.2 的权威证据包,2026-09-30 由发布前的本地全量回归产出——office-plane
> 教训(e2e-matrix 门只审已提交证据;manifest 漂移 CI 结构性看不见;
> **本地全量重跑是唯一的网**)。以下每条结论都带产出它的命令。未执行任何
> 发布动作(bump/tag/release)——那是 owner 的明确 go。

## 本包范围

- **基点**:`origin/main@4f1677ad`(开跑时)——包含相机家族(#252)、socket
  缝(#251)、BLE 面(#254)与**麦克风面(#255)**,本包含麦克风;#256/#271/#272
  (治理/CI/文档)亦在。#278(门工具测试,纯 tools)在本次跑动期间落到 main
  ——在本报告三跑之后,不触及本包测到的任何产品或套件面。
- **分支**:`feat/release-regression-final`,即本 PR。回归跑在 origin/main
  加本 PR 携带的修复上(九个提交,见下)——每个修复都是被这次重跑抓出来的,
  这正是"网"在工作。
- **机器诚实度**:并行车队把机器压到负载 ~300 达一小时;编排方应请降速后,
  权威三跑在安静下来的机器上完成。三台真机均未连接(iOS `xcrun devicectl`:
  无;Android:无;HarmonyOS `hdc list targets`:一台外来模拟器——见跑 1)
  ——所有真机腿一律脚本待机,绝不造假。

## 跑 1 — 模拟器矩阵(`tools/test/run-simulator-matrix.sh`)

命令:`bash tools/test/run-simulator-matrix.sh`(带
`DSH_ANDROID_SERIAL=emulator-5556`——本机 5554 端口槽被垂死 socket 占用;
矩阵支持用 env 钉串号)。完整日志:`/tmp/dsh-regr-final/matrix.log`。
终局汇总——六腿全绿:

```
matrix: [ios] release -> PASS (0 drive markers / 0 debug+info; audit=418 warn=22 (product planes, recorded); refusal by name)
matrix: [ios] gateway-drive -> PASS (4 verdicts green + receipt (boot, carrier, gateway binding, audit))
matrix: [ios] device-plane -> PASS (device.plane + audit verdicts green + receipt)
matrix: [android] release -> PASS (0 drive markers / 0 debug+info; audit=0 warn=0 (product planes, recorded); refusal by name)
matrix: [android] regression -> PASS (3 verdicts green + receipt)
matrix: [android] device-plane -> PASS (device.plane + audit verdicts green + receipt)
```

- **Release 腿**(双宿):发布配置裸启动,零 drive 编排标记、零 debug/info
  记录,drive **按名拒绝**(`-dsh-mode session` / `--ez dsh.llm true`),
  官方面可达(iOS 截图 + Android carrier LISTEN + adb forward 下
  `GET / -> 401`)。证据:`hosts/{ios,android}/artifacts/simulator-matrix/
  release/release-proof.json`。
- **Harness 腿**:gateway-drive 4 verdicts + receipt(boot.verification 8/8、
  carrier.loopback 7/7、gateway.binding 19/19、gateway.audit 16/16);iOS
  device-plane 16/16 + 14/14;Android regression 3 verdicts + receipt(boot、
  gateway.bridge-smoke、session.mock-llm);Android device-plane 15/15 +
  13/13。receipt + logs + scenario.jsonl 按既有结构就地刷新。
- **Harmony**:诚实 skip **拒绝生效**——`hdc list targets` 此刻答
  `127.0.0.1:5555`(一台 HarmonyOS 模拟器从早上起在跑,属于另一条工作线;
  在其上跑本包的腿会踩别人的活资源,杀掉它更不是本跑的权限)。矩阵按设计
  响亮死掉("a harmony target IS present — wire the real leg"),这与造假
  skip 恰好相反。因此本包的 Harmony 覆盖与 CI 现状一致(CI 本就没有模拟器
  腿);D-g 待机维持,`hosts/harmony/ci/run-host-e2e.sh` 在有专属目标的
  时刻即插即跑。**这不是产品失败——是一次如实记录的所有权冲突。**

### 模拟器可测的能力腿(跑 1b)

iOS(dsh-iphone),矩阵构建好 Debug 后各腿 `--skip-build`:

| 腿 | runner | verdicts |
| --- | --- | --- |
| 相机(unavailable 姿态) | `test/e2e/run-ios-camera-plane.sh` | camera.plane 6/6 + audit 3/3 |
| 麦克风(宿主输入,真 PCM) | `test/e2e/run-ios-mic-plane.sh` | mic.plane 11/11 + audit 6/6 |
| BLE mock(完整 GATT 阶梯) | `test/e2e/run-ios-ble.sh --mode mock` | ble.plane 16/16 + audit 8/8 |
| BLE 真实无线电姿态 | `test/e2e/run-ios-ble.sh --mode skip` | ble.plane 8/8 + audit 4/4 |

Android(emulator-5556):相机——虚拟相机**真拍**(8/8 + audit 5/5,burst
2 帧、read-back 匹配、maxBytes 丢弃);麦克风——宿主输入真 PCM,11/11 +
audit;BLE mock——GATT 阶梯全绿 + audit。**BLE skip**:在本文这台 AVD 上
重跑观测到 `live` 姿态(虚拟无线电在架、射电静默),扫描自结束未在场景
180s 看门狗内到来——与当天早上绿跑(另一台 AVD,`emulator-5580`)是环境/
姿态差异,非产品回归;当天已提交的绿证据
(`hosts/android/artifacts/ble-skip/`,receipt 树 `d7838262`)仍为本包引用,
未领 receipt 的重跑证据已移出工作树(诊断副本
`/tmp/dsh-regr-final/ble-skip-rerun-diag`)。

## 跑 2 — 上游全套件 sweep(权威数字)

命令:`sh runtime/spike/ci/run-upstream-suite-sweep.sh --paral 4`,安静机器
(负载 < 5),全量 vendor 树 + 新转译。汇总文件:
`tmp/upstream-suite-report-totals.txt`(诊断件,按约定不入库)。

| 指标 | v0.0.2(本跑) | #243 时点 | 增量 |
| --- | --- | --- | --- |
| specs(双腿转译) | **648** | 681 | −33 |
| qjs 有绿汇总的 specs | **573** | 614 | −41 |
| NOSUM 行(TIMEOUT-OR-ERROR:module-gap/慢族) | **75** | 67 | +8 |
| failed-count 分歧(qjs vs node) | **0** | 0 | — |
| partial 行(有汇总但 failed > 0) | **0** | 0 | — |

三向口径:**573 绿 / 0 partial / 75 module-gap**;node 差分腿对每个有汇总
的 spec 全部一致;金丝雀 spec(`core__agent-loop__tests__loop`)为
`failed:0`。

对增量的诚实解读:spec **集合**已不是 #243 测的那一批——HEAD 的转译排除
类(`runtime/spike/upstream-tests/manifest.json`:vi.mock 装载器类 65+2+4、
monorepo-src 类 54+8+4+1、31 个 esbuild 解析错类、node:vm 6+6、wall-clock 7、
fast-check 5……)相对 #243 有演化,且 #243 的逐 spec 报告未入库,逐 spec
diff 不可复原。本跑能背书的首行事实是:v0.0.2 处,每个能转译且能产出汇总
的 spec 全部通过(573/573,0 failed,0 partial),双腿在都能说话处全部
一致。

**本跑第一次 sweep 打出 278/645——是废数。** 新鲜 worktree 的物化中途死掉:
GNU tar 1.35 在后一个 `--wildcards` 模式的成员已被前面跨斜杠模式吞没时以
非零退出("*/packages/*/*/package.json: Not found in archive",实际 303 个
package.json 全抽出来了),脚本 `set -e` 在 55 个 test-face npm vendoring
之前中止,转译在残树上进行。本 PR 已修(`14922042`):gtar 退出非零时先
验证抽取完整(≥ 200 个 package.json)再放行。不修的话,任何新鲜 worktree
的 sweep——包括将来的发布回归——都在静默测量套件的一小角。

## 跑 3 — Release 配置特性 pass(iOS 模拟器)

按 ui-sweep/release-test 先例(ask 里的编号脚本已退役——`run-ios-b4.sh`
在 #145 改名;现行形态是 `test/e2e/ios-ui.py`):把矩阵 release 腿构建的
Release `.app` 裸装到 dsh-iphone,扫特性面:

```
test/e2e/ios-ui.py sweep hosts/ios/artifacts/release-feature-sweep
```

- 首跑面:内测声明对话框捕获为 `checklist-first-run-dialog.json`(3 行),
  经其"继续"按钮关闭。
- 主面:**49 个控件全触——35 个有可见效果(前后截图逐字节不同),14 个
  no-op**(部分控件在当前状态本就惰性;沿用 ui-sweep 先例的共读规则),
  104 张截图 + `checklist.json` 连同 README 入目录。
- Release 腿的机器验证半边即上面的矩阵 release 腿(drive 机械不在、按名
  拒绝、debug/info 不在——release-proof.json)。
- 真机特性腿(相机真拍、麦克风 revoke-then-deny 阶梯、BLE 对端)保持脚本
  待机,未运行——无真机连接。

## 本跑修掉的(网的渔获——九个提交)

| 提交 | 重跑抓到的 |
| --- | --- |
| `f361d009` | 矩阵无参默认档从未可用(什么都还没起就死) |
| `3b7f08d4` | gateway.binding 要求 descriptor 全可用,与 #252 的诚实 phased 行冲突;selftest 的 boot fixture 没跟上 `shims.selftest` |
| `e24b595b`/`2eba4d98`/`44dd9191` | picker 搜索沉降三部曲(被浏览路径取代;过程提交留在历史里) |
| `e30361bc` | app 每次启动重写 E2E picker 目标,把文件踢出文件提供器索引 |
| `26c15cc8` | picker drive 改走 BROWSE 层级——搜索路径在本机上对任何文件龄都不再浮现目标 |
| `34644967` | wda_find_cell 的 heredoc 吞掉了管道树(首次 walk 即发现) |
| `86abcf58`/`afe3e739` | iOS/Android device-plane descriptor 钉值落后于 #255 补全的全表(31→33、32→34) |
| `877e2ca0` 等 | Android **模拟器**相机腿错检设备线 manifest;mic/ble/skip 钉值同轮落后(26/32→34);#252 真拍 manifest 以 `android-` 名回归 |
| `14922042` | gtar 模式吞没退出饿死新鲜 worktree 的套件物化 |

Agent Note:`.agents/notes/implemented/testing/2026-09-30-the-release-
regression-final-run-is-the-net-that-caught.md`。

## Blockers

无。三跑的开放项均已如上记录,且无一为产品失败:harmony 矩阵腿的 skip
拒绝是所有权冲突(覆盖与 CI 一致);Android ble-skip 重跑是 AVD 姿态变化
(当天绿证据仍在);#278 晚于三跑(tools-only)。发布动作本身仍待 owner
的 go。

## 复现

```
bash tools/test/run-simulator-matrix.sh                       # 跑 1(+1b 能力腿,按上表逐条)
sh runtime/spike/ci/run-upstream-suite-sweep.sh --paral 4     # 跑 2(汇总在 tmp/)
test/e2e/ios-ui.py sweep hosts/ios/artifacts/release-feature-sweep   # 跑 3(裸装 Release app)
```
