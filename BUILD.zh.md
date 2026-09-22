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
| `build/build.sh android` | 从规范 runtime 暂存 android 闭包 → `gradlew assembleDebug` → `run-spike-e2e.sh`（日志校验） |
| `build/build.sh android harmony` | 两个平台同样流程——任意平台组合 |
| `build/build.sh test ios` | 只跑 e2e 腿（构建须已新鲜） |
| `build/build.sh check` | 只跑 `closures` 门禁——不需要任何工具链 |
| `build/build.sh sync harmony` | 从 `runtime/spike` 重新暂存 harmony 的已提交闭包 |

- 默认命令是 `build`；默认平台集是 `all`（即 CI 矩阵——单机很少凑齐所有
  工具链；iOS 只能在 macOS 编译）。
- 缺工具链会**响亮失败**，点名缺失的工具与获取方式——绝不静默跳过。
  `--list` 列出平台与其工具链需求。
- `core` 是规范 runtime 自己的验证载体：C 宿主 CLI
  （`runtime/spike/host/build.sh`）加 CLI 证明腿——平台嵌入的同一闭包，
  在最便宜的宿主上先证明。

## 为什么是这个形状（DSH 方法）

核心是**一份拷贝**——`contract/`、`runtime/`、`system-plugins/`、
`presentation/` 与平台无关；每个宿主只加自己的特权层、原语绑定与原生
外壳（[D9]/[D6]，ARCHITECTURE.md §8）。构建系统把这件事做成了可执行的：

1. **sync** 从规范源重新暂存每个宿主的*已提交副本*（逐字节一致；上游
   vendored 包由 `runtime/spike/vendor/ensure-dsh.sh` 固定并 sha256 校验）；
2. **compile** 跑平台自己的工具链（Xcode / Gradle-NDK / hvigor NAPI——
   每个宿主经由自己的构建系统编译同一个 C 宿主）；
3. **test** 跑该平台的日志校验 e2e 腿（断言结构化日志，绝不用截图——
   ARCHITECTURE.md §3）。

## closures 门禁

Android 的 `assets/spike/`、HarmonyOS 的 `rawfile/spike/`、iOS 的生成
bundle 都是规范 `runtime/spike` 闭包的**已提交副本**——这是刻意的
（自包含的 APK/HAP，平台 IDE 能看到文件）。由于 CI 在每次构建前重新
暂存，已提交副本里的漂移对绿灯的流水线不可见。`closures` 门禁
（`gov run`，接线于 `gates.json`）堵住这个洞：它把每个已提交副本与
规范源逐字节比对（android 与 harmony 走 stager 的 `--check` 模式；
iOS 走确定性重生成 + `git diff --quiet`）。如果它红了：
`build/build.sh sync <platform>`。

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

## CI 映射

门面的各平台步骤就是对应工作流的逐字命令——映射与各腿运行处：

| 平台 | 编译（工作流） | 测试（工作流） |
| --- | --- | --- |
| ios | `xcodebuild … -scheme DSHSpike`（`dev/ios`，macos-15） | `test/e2e/run-ios.sh`（同一作业） |
| android | `./gradlew assembleDebug`（`dev/android`） | `hosts/android/ci/run-spike-e2e.sh`（同一作业） |
| harmony | `hvigorw assembleHap`（`dev/harmonyos`） | `hosts/harmony/ci/run-host-e2e.sh`（同一作业） |
| core | `runtime/spike/host/build.sh`（macOS 本地；CLI 腿各自的 runner） | `runtime/spike/ci/run-*-e2e.sh` |

[D9]: decisions.md
[D6]: decisions.md
[D17]: decisions.md
