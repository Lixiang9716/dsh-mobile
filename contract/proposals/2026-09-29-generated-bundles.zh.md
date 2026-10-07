# 提案：停止提交 iOS 生成物——`App/Generated/` 与 xcodeproj 改为构建输出

> **状态：DRAFT（修订提案——未翻转任何内容，未冻结任何内容，未实现任何
> 内容；提交给 owner 决定接受或拒绝）。**
> [English](2026-09-29-generated-bundles.md) | 简体中文

## 动机

iOS 宿主的生成字节目前是入库的：`hosts/ios/App/Generated/SpikeBundle.c` +
`SpikeBundle.h`（以 C 字节数组嵌入的 runtime/dsh closure），以及
`hosts/ios/DSHSpike.xcodeproj/`（`project.pbxproj` + workspace 数据，由
`xcodegen generate` 从 `project.yml` 再生成）。把它们放进去的决策记录在 M1
spike-embed note
（`.agents/notes/implemented/feature/2026-09-19-ios-m1-spike-embed.md:37-39`）：
*"生成的 `DSHSpike.xcodeproj` ALSO 入库，让 CI 和 fresh clone 不装 xcodegen
也能构建"*——并且把"只提交 `project.yml`、在 CI 里生成"作为替代方案明确
拒绝。`closures` gate 的 iOS leg（`build/check-closures.sh:41-61`）就架在这个
选择之上：确定性地再生成 bundle 并要求 `git diff --quiet`，让入库副本成为
一个可以失败的主张（D17）。

2026-09-29 一个晚上对着这份副本干活，实测出了这个选择如今的代价：

- **一个晚上 6 次再生成**（本轮运行简报的计数；之所以成为例行公事，是因为
  closures gate 每次运行自己就会再生成）**一个从 48,599,826 字节长到
  64,510,997 字节的文件**（从 `f1627796` 与 `97f24d13` 的已提交 blob 实测；
  简报里的 "~50 MB" 是当晚开始时的体量）。
- **每次重写都是六位数的文本扰动，已实测**：第一次落库的重写
  （`f1627796 → 64889c54`）是 986,661 行变更；第二次
  （`64889c54 → 97f24d13`）是 92,024 行（删 41,564 + 增 50,460，全文件
  665,411 行）。简报的 "~300k diff lines" 是同一种扰动在当晚中途的观测；
  它当时量的是哪个 diff，从这里已不可复原。
- **一次非确定性漂移事故**——`908c3bdd`（"the stale copy carried six
  duplicate trees from a mid-refetch walk"）：一次生成与 `ensure-dsh.sh` 的
  pin refetch 重叠，walk 抓到了瞬态目录布局，把 `agent-presets`/`util` 树嵌
  了两遍，入库副本不得不重新落地（63,647,458 → 64,468,373 字节）才让
  closures gate 的逐字节比较重新有意义。
- **推送载荷几乎全是它**：当晚区间（`f1627796..97f24d13`）的原始 blob 字节
  是 128,158,455 bundle 字节对 17,888,152 其他字节——全区间实测 87.8%；
  纯 bundle 的推送（`908c3bdd` 修复是单文件提交）事实上是 100%。简报的
  "99.9% of push payload" 就是这一类。
- **一个 amend 顺序陷阱**（来自本轮运行简报；台账里记录的是它的同类）：
  碰过 `runtime/dsh` 之后的任何 amend 都多了一条
  "先再生成的再 amend" 的顺序约束，走反了就会把陈旧 bundle 装进被 amend 的
  提交——与 surprise 台账已记录的同一失效类（2026-09-27：并行会话的重排一度
  把陈旧的 `SpikeBundle.c` 推上了分支）。

本分支在飞的 `.gitattributes` 变更（生成路径标 `binary`/
`linguist-generated`）治的是 review 渲染这个症状：diff 显示成 `Bin` 而不是
六位数的行噪声。但字节照样传输、照样扰动 pack、照样让每次碰 runtime/dsh
都变成一个 64 MB 的提交。

**而且前提已经空心化了。** 入库副本的理由是"不用生成就能构建"。但
`gen.sh` 的 bundle 一半早已跑在每次 Xcode 构建里：`GenerateSpikeBundle`
pre-build phase 执行的正是 `gen.sh` 跑的同一个
`Tools/gen_bundle_header.py`（`hosts/ios/gen.sh:5-6`、
`hosts/ios/project.yml:96-135`），而该目录第三个文件 `ish-rootfs.tar.gz`
已经由 `FetchIshRootfs` pre-build phase 落位、且不入库
（`project.yml:145-152`、`.gitignore:217`）。今天"fresh clone 不生成就能
构建"真正买到的只剩*项目*这一半：没有任何 workflow 安装 xcodegen，每条
CI 路径都靠入库的 `project.pbxproj`（`dev-ios.yml:179`；
`release-ios.yml:198,206,269,277`）。bundle 副本买到的只是一粒首次构建的
缓存种子，外加喂 gate 的逐字节比较——它已经不是任何东西的输入，它是带
着 64 MB 运输习惯的 gate 饲料。

代价现在已经量出来了，而过去让 CI 侧生成显得可怕的那一件事——非确定性
——今晚已经带着证据修掉了（见"确定性前提已经落地"）。所以现在是通过提案
重开 09-22 那次拒绝的时机，而不是靠无声漂移。

## 提案

三个动作，全部可逆；**本文档不执行其中任何一步**。

1. **停止提交生成字节。** 把
   `hosts/ios/App/Generated/SpikeBundle.c` + `SpikeBundle.h` 与
   `hosts/ios/DSHSpike.xcodeproj/`（`project.pbxproj`、
   `project.xcworkspace/contents.xcworkspacedata`——`App/Generated` 下两个
   文件加 xcodeproj 下两个：今天共 4 个被跟踪的生成文件）
   移出索引，并把两个路径加进 `.gitignore`。`ish-rootfs.tar.gz` 本就被
   ignore——`App/Generated` 整体变成它今天大部分已经是的东西：构建输出。
2. **生成成为每个消费者站点的构建职责。** 已提交字节的每一个消费者都已经
   收敛到同一种命令形态——`xcodebuild -project DSHSpike.xcodeproj`（在前提
   P2 里枚举）——所以在每个站点前面加一步 `gen.sh`（vendor 源 →
   `gen_bundle_header.py` → `xcodegen generate`）即可均匀覆盖。pre-build
   phase 保持按构建再生成 bundle，与它今天的做法完全一致；app 的运行时
   行为零变化。
3. **`closures` gate 的 iOS leg 从逐字节比较翻转为 gen.sh-exits-0。** 今天
   `build/check-closures.sh:41-61` 把 bundle 再生成进树里并要求
   `git diff --quiet`。翻转后，iOS leg 的主张变成*"生成器在这棵树上跑得通"*
   （`gen.sh` exit 0），而不是*"索引里那份 64 MB 副本一致"*。android 与
   harmony 的逐字节比较不动（见非目标）。

## 翻转前需验证的前提

- **P1——CI workflow 安装 xcodegen 并在 xcodebuild 之前生成。** 今日实测：
  **尚不成立**——`grep xcodegen .github/workflows/*.yml` 零命中；`dev/ios`
  与 `release/ios` 直接对入库项目构建。这是承重缺口：两个 workflow 在第一次
  `xcodebuild` 之前都补上安装 + `gen.sh` 步骤之后，翻转才是绿的。
- **P2——已提交字节的每个消费者都经过 xcodebuild。** 今日实测：**成立**。
  完整消费者普查：12 个 `test/e2e/run-ios*.sh` 脚本（agent-flow、
  device-plane、install-ui、live-llm、live-session、live-write、
  next-web-mount、official-web-mount、session-mock-llm、upstream-parity、
  upstream-suite、run-ios.sh）全部调用
  `xcodebuild build -project hosts/ios/DSHSpike.xcodeproj`；
  `build/build.sh:136`（compile 阶段）与 `build/build.sh:112`（sync 阶段，
  已经跑 `gen.sh`）；`dev-ios.yml:179`；`release-ios.yml:198,206,269,277`。
  字节的其他读者只有被翻转的 gate 本身（`check-closures.sh:42-59`）和
  `dev-ios.yml:77` 的 DerivedData cache key——pbxproj 退跟踪后，后者须改键
  到 `project.yml` + 源文件。
- **P3——fresh 的 `gen.sh` 有它的输入。** `gen.sh:3-5` 要求先跑
  `runtime/dsh/vendor/ensure.sh`（xcodegen 需要磁盘上的 quickjs 源码才能
  引用它们）。`dev/ios` 已经在构建前 vendor（`dev-ios.yml:159-163`）；被
  翻转的 gate 的生成 leg 需要同样的顺序。
- **P4——本地裸脚本路径仍然可用。** `run-ios*.sh` 脚本目前假设入库项目
  存在；翻转时每个都需要 `gen.sh` 前置步骤（或共享 helper）。`build/build.sh`
  facade 路径已就绪（`sync ios` 在 compile 前跑 `gen.sh`）。
- **P5——回滚永远只是一次 revert。** 因为生成是确定性的（见下），恢复入库
  字节永远是 `git rm --cached` + 再生成 + 提交。翻转不烧桥。

## 确定性前提已经落地

2026-09-22 拒绝 CI 侧生成的部分理由是：跑跑就漂移的生成树会让 CI 为噪声
变红。今晚这个反对理由带着证据退役了：`908c3bdd` 把 walk 修成顺序稳定
（`Tools/gen_bundle_header.py:391,419`——`sorted(src_dir.rglob("*"))`），
并验证输出**跨运行字节稳定（same hash twice）**——这正是 closures gate 的
regen-and-diff 机制存在要检验的性质，而且自那以后每次 gate 运行都是绿的。
确定性就是那个前提：它让"字节可以从源码复现"成为一个 gate 能持有、而不必
扣着字节不放的主张。

## 已拒绝的替代方案

- **bundle 走 Git LFS**——拒绝：该文件每次再生成重写 ~64 MB，一晚数次；
  LFS 的存储/带宽配额让这成为一笔周期性账单，指针照样在每个触碰的提交里
  扰动，每次 CI checkout 都要 LFS pull，历史里字节照样在。为"正想不运的
  字节"付费。
- **按文件拆 C 数组（`SpikeBundle.c` 按输入文件拆分）**——拒绝：痛点是
  字节在传输这件事本身，不是 diff 粒度；载荷与扰动照旧，编译单元翻倍，
  构建变慢。
- **嵌入压缩的取舍（zstd 压载荷、staging 时解压）**——拒绝：它缩小 blob
  但止不住扰动（每次再生成仍重写一个数 MB 的 blob），入库字节反正不可
  review，还往每个 scenario leg 的 staging 路径上加一步解压。更小的税仍是
  税；本提案把税取消。

## 非目标

- **HarmonyOS rawfile 与 Android assets 保持入库形态。** 它们的 closure 是
  小体积文本文件，diff 仍可 review，stager 以 `--check` 模式校验、没有
  大字节问题，自包含的 APK/HAP 打包语义（D17："the copies are deliberate
  for self-contained APK/HAP and platform IDEs"）支持保留。`closures` 的
  逐字节比较对两者照旧。本提案只作用于 iOS 生成物。
- **不改 `runtime/dsh` 内容、bundle 布局、pre-build phase 行为。** app 的
  运行时路径翻转前后完全一致。

## 若被接受

本提案推翻的是有记录的决策，因此必须作为一个整体落地：M1 note 的入库项目
选择（`2026-09-19-ios-m1-spike-embed.md`，alternatives 一节）、09-22 note
被拒绝的"让 CI 跑 `gen.sh`"替代方案
（`2026-09-22-the-ios-release-staging-phase-moves-into.md:62-65`）、以及
D17 的入库副本替代方案的 iOS leg。接受后，通过 `gov decision add` 落一条
decision row（编号由登记册分配——痛点简报的 "D9" 是本轮运行的简称，
`docs/decisions.md` 的 D9 是另一个决策：上游 verbatim 移植）。在此之前，
本文什么都不生效：入库字节保留，gate 保持逐字节比较。

## 证据基础

本提案的每个数字都是 2026-09-29 在这棵树里实测或读到的：blob 体积与 diff
行数经 `git cat-file -s` / `git cat-file blob` + `/usr/bin/diff` 对
`f1627796`、`64889c54`、`97f24d13` 测得；消费者普查经 grep
`test/e2e/`、`build/`、`.github/workflows/`；pre-build phase 及其
input/output 声明与 `FetchIshRootfs` 先例在 `hosts/ios/project.yml:96-152`；
前提陈述的原文在 `hosts/ios/gen.sh:5-6` 与 `hosts/ios/project.yml:3-9`；
非确定性事故及其 twice-same-hash 证明在提交 `908c3bdd`；推送载荷的意外类
在 `.gov/surprises.jsonl`（2026-09-27 条目）；痛点简报中的字节数字是本轮
运行的，与实测不一致处均按引用标注。
