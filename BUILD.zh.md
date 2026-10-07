# 构建 dsh-mobile

[English](BUILD.md) | 简体中文

一个门面驱动所有平台：**`build/build.sh`**。这里的"构建"始终是
**同步 → 编译 → 测试**——与该平台 CI 工作流做的三件事相同、命令也相同——
因此本地构建为绿与 `dev/<platform>` 检查为绿，是同一件事。

```
build/build.sh [build|test|check|sync] [ios|android|harmony|core|all ...] [--release] [--list]
```

| 示例 | 发生什么 |
| --- | --- |
| `build/build.sh android` | 从规范 runtime 暂存 android 闭包 → `gradlew assembleDebug` → `run-dsh-e2e.sh`（日志校验） |
| `build/build.sh android harmony` | 两个平台同样流程——任意平台组合 |
| `build/build.sh test ios` | 只跑 e2e 腿（构建须已新鲜） |
| `build/build.sh check` | 只跑 `closures` 门禁——不需要任何工具链 |
| `build/build.sh sync harmony` | 从 `runtime/dsh` 重新暂存 harmony 的已提交闭包 |
| `build/build.sh sync all` | 重新暂存全部已提交闭包（ios → android → harmony → core，按序执行；未知平台响亮中止，绝不静默跳过） |

- 默认命令是 `build`；默认平台集是 `all`（即 CI 矩阵——单机很少凑齐所有
  工具链；iOS 只能在 macOS 编译）。
- 缺工具链会**响亮失败**，点名缺失的工具与获取方式——绝不静默跳过。
  `--list` 列出平台与其工具链需求。
- `core` 是规范 runtime 自己的验证载体：C 宿主 CLI
  （`runtime/dsh/host/build.sh`）加 CLI 证明腿——平台嵌入的同一闭包，
  在最便宜的宿主上先证明。

## 为什么是这个形状（DSH 方法）

核心是**一份拷贝**——`contract/`、`runtime/`、`system-plugins/`、
`presentation/` 与平台无关；每个宿主只加自己的特权层、原语绑定与原生
外壳（[D9]/[D6]，ARCHITECTURE.md §8）。构建系统把这件事做成了可执行的：

1. **sync** 从规范源重新暂存每个宿主的*已提交副本*（逐字节一致；上游
   vendored 包由 `runtime/dsh/vendor/ensure-dsh.sh` 固定并 sha256 校验）；
2. **compile** 跑平台自己的工具链（Xcode / Gradle-NDK / hvigor NAPI——
   每个宿主经由自己的构建系统编译同一个 C 宿主）；
3. **test** 跑该平台的日志校验 e2e 腿（断言结构化日志，绝不用截图——
   ARCHITECTURE.md §3）。

## closures 门禁

Android 的 `assets/dsh/`、HarmonyOS 的 `rawfile/dsh/`、iOS 的生成
bundle 都是规范 `runtime/dsh` 闭包的**已提交副本**——这是刻意的
（自包含的 APK/HAP，平台 IDE 能看到文件）。由于 CI 在每次构建前重新
暂存，已提交副本里的漂移对绿灯的流水线不可见。`closures` 门禁
（`gov run`，接线于 `gates.json`）堵住这个洞：它把每个已提交副本与
规范源逐字节比对（android 与 harmony 走 stager 的 `--check` 模式；
iOS 走确定性重生成 + `git diff --quiet`）。如果它红了：
`build/build.sh sync <platform>`。

## 资产镜像族（web 客户端）

自托管 web 客户端是第二个镜像族：产品树
`presentation/web-client-{next,compact}` 的字节经由三张宿主面孔出货——
android 的 `assets/dsh/webclient-*/`、harmony 的
`rawfile/dsh/webclient/dsh-web-client-*/`，以及 iOS 嵌入器的
`WEBCLIENT_TREES` 声明（其 bundle 在构建时从产品树重新生成，所以声明
才是那一份已提交的主张）。绕开镜像的产品改动就是 #286 那一类
（timeline.js 在 android 一道空转的 `--check` 循环里活了两个 PR）。
现在有两张面管着它：

- `closures` 门禁内部的逐宿主字节校验（stager 的 `--check` 循环——
  android webclient 循环的 `./` 前缀 SKIP 缺口已修，这个方向重新咬人）；
- `node tools/check-asset-mirrors.mjs [--json]`——跨宿主比较器
  （warn 级 `asset-mirrors` 门）：族内每个镜像双向比对（stale、
  missing、extra），外加 iOS 嵌入器声明对族；其拒绝用例在
  `.gov/rejections/case-asset-mirrors.sh`。

## CMake 层（同一张图，多一张面孔）

顶层 `CMakeLists.txt` + `CMakePresets.json` 把构建表达成一张带统一入口的
依赖图（cmake ≥ 3.21，Ninja）：

```
cmake --preset macos-dev                                # 配置（Ninja）
cmake --build --preset macos-dev --target dsh-core      # 编译 C 核心
cmake --build --preset macos-dev --target dsh-android   # 同步 + 构建一个宿主（包装 build.sh）
ctest --preset macos-dev                                # 门禁（dsh-gate-closures、dsh-gate-gov）
```

范围由构造决定（phase 1——加层不动路径）：

- **CMake 只编译 C 核心**：`dsh-core` 静态库，源文件来自
  `runtime/dsh/host` 加固定的引擎——与 android、harmony 的
  `cpp/CMakeLists.txt` 编译的是同一组文件。配置期先物化 vendored pin
  （`include(Vendor)` 跑 ensure 脚本，响亮失败；`DSH_SKIP_VENDOR=ON`
  可跳过但会点名风险）。
- **三个宿主仍归平台工具链所有。** `dsh-ios` / `dsh-android` /
  `dsh-harmony` 是委托给 `build/build.sh build <platform>` 的包装目标，
  带 `dsh-sync-<platform>` 依赖边——签名、HAP/AAB 打包、e2e 腿仍归
  xcodebuild / Gradle / hvigor。`build.sh` 仍是文档化的门面；这些目标是
  统一入口，不是替代品。
- **门禁挂上 CTest**（`dsh-gate-closures`、`dsh-gate-gov`）——同一批
  检查的另一张面孔；门的 DAG、任务卡、pre-push 钩子仍归 govrail 所有。

构建树位于 `build/cmake-<preset>/`（被跟踪的 `build/` 目录放的是
`build.sh` 本身）。更深的整合——sync/stage 步骤成为一等 custom command、
一份 vendor manifest 驱动所有宿主的嵌入清单——是下一阶段，不是本阶段。

## 布局：环绕项目的周边环

```
dsh-mobile/
├── build/        ┐
├── test/         │ 周边环——构建、测试、文档、包：
├── docs/         │ 项目相邻的表面，不是产品本身
├── packages/     ┘
├── tools/          govrail 检查脚本（治理工具）
├── contract/     ┐
├── runtime/      │ 项目——共享核心，仅一份（DSH 方法），
├── system-plugins/│ 加上下方的三个平台宿主
├── presentation/ ┘
└── hosts/{ios,android,harmony}
```

路径沿革：`tools/e2e → test/e2e`、`tools/release → packages/release`
（2026-09-23，[D17]）。历史 note 与 e2e 回执保留它们写下时的路径——
它们是记录，不是漂移。

## 模拟器矩阵（发布级证据）

`tools/test/run-simulator-matrix.sh` 是一条命令，在真实模拟器/仿真器上
逐平台证明 flavor 两分的两半：

| 腿 | 证明什么 | 证据 |
| --- | --- | --- |
| release（iOS / Android） | 用户面构建启动到官方 UI，驱动机制为零——无驱动标记（`dsh: sequence` / `ui-wait` / verdict 文本）、无 debug/info 日志记录——并对 E2E 驱动**点名拒绝**。Release 配置本来就跑不了驱动（驱动在构建期被编译掉），"零机制 + 响亮拒绝"正是它的证据。audit 流与 warn/error 记录是产品自己的平面（serving boot 会拉起完整 spine）：在 `release-proof.json` 里**记录**其计数，绝不断言为零 | `hosts/<plat>/artifacts/simulator-matrix/release/` |
| harness（iOS / Android） | debug harness（验证载体）原样跑既有 e2e runner：scenario-id 日志与 manifest 一一对应，回执只在绿路机器生成 | `…/simulator-matrix/{gateway-drive,device-plane,regression}/` |
| harmony | 本机没有 DevEco 工具链 / hdc 目标时诚实跳过——一张 skip 回执，绝不假绿（腿保持脚本就绪，等真设备） | `hosts/harmony/artifacts/simulator-matrix/matrix-skip-receipt.json` |

```
tools/test/run-simulator-matrix.sh                    # 全部平台
tools/test/run-simulator-matrix.sh --platform ios     # 单平台
tools/test/run-simulator-matrix.sh --platform android --skip-release
```

失败即停：第一条失败的腿中止整个运行并使其失败
（`DSH_MATRIX_KEEP_GOING=1` 可把请求的腿全部跑完——汇总仍以非零退出）。
一切等待都是带截止时间的条件轮询，绝不盲睡；失败腿的证据目录移去 /tmp，
让 e2e-matrix 检查器永远不会把"带 verdict 却缺回执"的目录算进清单。缺
驱动器的腿（iOS 缺 idb/WDA）按能力跳腿并在 `capability-skips.json` 留痕，
与常设硬件行并列（相机 / 蓝牙 / NFC：模拟器没有无线电——未来的系统能力
场景必须经能力协商回答 `unavailable`，绝不假设硬件在场）。矩阵**有意**
不接入门禁 DAG——跑它是发布仪式，接门是后续决定。

## Node 侧可测面的行覆盖

`tools/test/run-coverage.sh` 度量我们自研代码中 Node 可测面的真实行覆盖
（vitest + v8 provider，逐面 include/exclude、边界具名），汇总成一张聚合
表；`--check` 强制 `coverage-floor` 门盯着的 warn 档地板。完整契约——实测
基线、诚实的不计入清单、如何新增面：[docs/test-coverage.zh.md](docs/test-coverage.zh.md)。

## CI 映射

门面的各平台步骤就是对应工作流的逐字命令——映射与各腿运行处：

| 平台 | 编译（工作流） | 测试（工作流） |
| --- | --- | --- |
| ios | `xcodebuild … -scheme DSHHost`（`dev/ios`，macos-15） | `test/e2e/run-ios.sh`（同一作业） |
| android | `./gradlew assembleDebug`（`dev/android`） | `hosts/android/ci/run-dsh-e2e.sh`（同一作业） |
| harmony | `hvigorw assembleHap`（`dev/harmonyos`） | `hosts/harmony/ci/run-host-e2e.sh`（同一作业） |
| core | `runtime/dsh/host/build.sh`（macOS 本地；CLI 腿各自的 runner） | `runtime/dsh/ci/run-*-e2e.sh` |

[D9]: decisions.md
[D6]: decisions.md
[D17]: decisions.md
