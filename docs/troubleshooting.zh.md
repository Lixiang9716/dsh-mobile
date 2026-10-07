# 故障排查 —— 跨会话陷阱账本

[English](troubleshooting.md) | 简体中文

一个陷阱付过一次学费，就不该付第二次。下面每一条都真实消耗过一个会话的
排查时间，而在此之前它们只存在于踩到它的那个 agent 的记忆里 —— 换一个
agent（或换一台机器）就归零。本文件就是这本账：每个陷阱两条段落 ——
症状与机理，然后是修法 —— 修法有代码承载的，注明对应代码。陷阱在付学费
的那个会话里就地追加，与 surprises 账本（`.gov/rules.md` §11）同一精神：
在最便宜的时刻记录，赶在心智模型腐烂之前。

## 1. shim 文件间的静态 import 环会让 QuickJS 在 link 阶段以空错误死亡

每个文件都能干净通过 —— 对它们逐个跑 `node --check` 全绿 —— 但真引擎下
运行时一个字都不留地死了：dsh CLI 以非零退出，打印 `dsh: error: `
后面什么都没有（空行的呈现方式见第 6 条）。机理：`runtime/dsh/upstream/shims/`
下两个文件之间的静态 ESM import 环会让 QuickJS 的模块 link 阶段直接中止，
且不带任何错误字符串 —— 这是实测，不是推断（引入该环的那次拆分
node 全绿、QuickJS 致命，2026-09-29）。Node 复现不了，因为 `node --check`
只解析不 link；环只有在模块图真正实例化时才咬人。

保持 shim 文件依赖单向。当一个文件需要兄弟文件的绑定时，拆分方向要让边
指向一边，由原文件 re-export 保住所有既有 specifier —— 绝不让两个文件互相
import。真出现双向形状时，回向引用只能发生在调用时刻（ESM-cycle-safe
模式：导入方在调用时经 namespace 读绑定，此时定义方早已求值完成 ——
见 `fs-paths.js`、`fs-readdir.js`、`fs-stat.js`、`fs-writes.js` 的文件头）。
代码承载：`runtime/dsh/upstream/shims/fs-seeded.js:22-24`（"ONE-WAY EDGE
… a static import cycle between two runtime/shims files kills quickjs at
link with an empty error (measured)"）与
`runtime/dsh/upstream/shims/buffer.js:31`（"one-way; a shim-shim import
cycle kills QuickJS at link"）。

## 2. aapt2 默认 ignoreAssetsPattern 会把点文件悄悄排除出 APK assets

仓库内暂存 faithfully 地带着某个 vendored 数据面，APK 把同树的其他文件都
打进去，运行时挂载却死于 `cannot read '.../data/.manifest.json'` ——
parity m4 挂载，2026-09-29。机理：aapt2 默认忽略模式含 `.*` token，会把
每一个点文件排除出打包 assets，于是 `providers/data/.manifest.json`
（providers barrel 的 require 目标）根本没进 APK —— 无警告、无构建错误，
文件在运行时就是不存在的，而打包之前的所有暂存检查全绿。

在
[hosts/android/app/build.gradle.kts](../hosts/android/app/build.gradle.kts)
里重述 `androidResources.ignoreAssetsPattern`，去掉 `.*` token
（`!.svn:!.git:!.ds_store:!*.scc:CVS:!thumbs.db:!picasa.ini:!*~`），
让 bundle 的点文件正常打包。代码承载于 `build.gradle.kts:91-99`，事故
经过写在块上方的注释里。今后 vendored 任何带点文件的 asset 面，决定它
能否随包发货的就是这一行。

## 3. `(cd X && find) | while` 会吞掉失败的 cd

源目录缺失时，暂存循环产出的是静默的空目标 —— 无报错、退出码 0，
rawfile 树（或 assets 树）就是少了文件。机理：`(cd "$DIR" && find …) |
while …` 里的 `cd` 跑在管道左侧子 shell；`$DIR` 不存在时 `cd` 失败，
`find` 不执行，右侧消费空输入并以 0 退出 —— 管道状态取的是 `while` 的，
`set -e` 永远不触发。2026-09-29 的 CI gates 失败正是这个形状：vendor
pins 只挂在一条 ensure 路径上，spine ensure 没物化它们，217 行
`BUNDLE_FILES` 在 CI 上全红，而本地全量 sync 看着是绿的。

在暂存循环之前用显式 `-d` 测试守住源目录 —— 缺 pin 就大声失败，
绝不产出安静的半截 rawfile。代码承载于
[hosts/harmony/ci/vendor-official.sh](../hosts/harmony/ci/vendor-official.sh)：
每个 `(cd "$DIR" && find …) | while` 暂存循环之前都有
`[ ! -d "runtime/dsh/$DIR" ] && echo "::error::… absent" && exit 1`
（noble pin 在 `vendor-official.sh:474-481`，pi-ai 在 `:490-497`，
`vendor/dsh` 在 `:112`），首个 guard 上方的注释记录了这次事故。

## 4. `git show` / `git checkout` 的路径必须以仓库根为基准

从某个 ref 抽文件时用了"站在当前位置看是对的"的路径 —— 在
`runtime/dsh/` 下写 `git show <ref>:scenario/upstream-suite-leg.js`，
或同样拼法用于 `git checkout <ref> -- …` —— 得到的是空内容，且没有任何
东西指出原因。机理：`<ref>:<path>` 对象上的 pathspec（以及
`git checkout <ref> -- <path>`）从仓库根解析，与当前目录无关 —— 作为普通
文件系统路径正确的拼法，在 git 的索引里什么都不是。本树实测（只读）：
错误拼法让 `git show` 报 `fatal: path
'runtime/dsh/scenario/upstream-suite-leg.js' exists, but not
'scenario/upstream-suite-leg.js'` —— 在 stderr 上，而输出一旦进管道或命令
替换就丢了，空字符串继续静默流下去；而 `git checkout HEAD -- scenario/…`
在 `runtime/dsh/` 下退出码 0、什么都没改（`git status --porcelain`
无新条目）。

git 对象路径永远按仓库根拼全：
`git show <ref>:runtime/dsh/scenario/upstream-suite-leg.js`。git 报错时
读它自己的 hint —— 它会给出根相对形式（以及 `<ref>:./<path>` 这个显式
要求 cwd 相对的拼法）。目前还没有仓库代码承载这条纪律 —— 没有任何 gate
或脚本校验 `git show`/`git checkout` 的路径拼法 —— 在那之前，本段的约定
就是全部的修法。

## 5. 含撇号的正则字面量会毒化 tools/check-size.py 的引号扫描

一个真实缩进从未变过的文件突然报出几十个幻影 `INDENT` 违规 —— 一次
事故里是 48 个（已上游立案 govrail#411）—— 重新格式化文件毫无用处。
机理：code-size 扫描器的回退实现按行工作且对正则盲视。`strip_code`
（[tools/check-size.py](../tools/check-size.py):139-181）把 `'` 和 `"`
当字符串定界符并跨行携带引号状态，但没有 `/regex/` 字面量的状态 ——
字符类里含撇号的正则（经典如 RFC 7230 token 字符集：
`/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/`）会打开一条幻影字符串吞掉文件剩余
部分，扫描器的注释跟踪随之失步，其后每个嵌套块都变成违规。

这类模式用 `new RegExp` 重建，让撇号活在扫描器看得懂的真正字符串字面量里。
代码承载：`runtime/dsh/upstream/shims/node-http-loopback.js:375-381`
把 token 字符集构建为 `new RegExp("^[!#$%&'*+\\-.^_`|~0-9A-Za-z]+$")`，
旁边注释写明原因（"a regex literal here carries ' and ` inside the
class, and the code-size scanner (line-based, no regex state) reads them
as an unterminated string"）。扫描器本身未改 —— 本条记录的是它的盲视
所逼出来的绕法。

## 6. dsh CLI 的空 `dsh: error:` 是正常的未完成形状，不是崩溃

普通（非 scenario）入口打印 `dsh: FAIL (complete=0 pass=0)`，跟着
`dsh: error: ` 冒号后面什么都没有 —— 看起来像崩溃丢了报文。既不是
崩溃也没有丢报文：机理是 `main_cli.c` 在任何非零退出时打印
`dsh_spike_error()`（[runtime/dsh/host/main_cli.c](../runtime/dsh/host/main_cli.c):1305-1308），
而错误缓冲只在运行时真的记录了错误时才被写入 ——
`dsh_spike_host.c:3561` 返回 `s->err`，从未设置时就是空字符串
（`dsh_spike_host.h:31` 注明新结构体不带错误文本）。普通入口跑完就退出、
没到完成面，就永远不会记录错误，所以 `complete=0` 就是全部诊断，
错误行为空是正当的。

把它读成"这个入口没到完成面"，而不是"有什么东西静默坏了"：如果预期要
拿 summary，要么入口选错了（跑一个会调完成面的 scenario 入口），要么
运行提前结束（到 deadline —— CLI 会在其上打印 `smoke: Ns deadline
elapsed before completion`）。这里不需要改代码；修法就是认识这个形状。
写这条是为了让下一个 agent 不去追查一份从未被截断的"截断日志"。

## 7. `logcat -c` 与读取端快照赛跑 —— 完成等待与截断都要以 canary 过滤视图裁决

Android runner 清缓冲（`adb logcat -c`）后 grep 实时流等完成模式，结果
空手而归 —— "no parity/event records" —— 尽管设备明明打了日志
（2026-09-29 再次踩中，并记录在 runner 自己的注释里）。机理：`logcat -c`
截断的缓冲，streamer 可能还没拍下快照，于是裁决裸流的等待要么被
缓冲区开头的回放满足（陈旧的上一轮记录 —— 假阳性），要么被截断饿死
（本轮记录落在 `-c` 与 streamer 首次读取之间 —— 假阴性）。streamer 设计
在此之上还以三种方式输过（2026-09-26/27 实测）：早前运行留下的僵尸
streamer 持续写同一文件、就地重写孤儿化了 streamer 的 fd
（[hosts/android/ci/run-device-plane.sh](../hosts/android/ci/run-device-plane.sh):70-73）。

钉一条 streamer 附着后才可能看见的 canary 行
（`adb shell log -t dsh.canary <id>`），完成等待与截断裁决都用 canary
过滤视图 —— 对流文件做 `awk '/<canary-id>/{seen=1} seen'` —— 绝不裁裸流。
代码承载于
[hosts/android/ci/run-upstream-parity.sh](../hosts/android/ci/run-upstream-parity.sh):63-94：
`CANARY` 钉子、`canary_view()` 助手，以及 `:86-91` 点名 2026-09-29 复发
（截断已 canary 钉住、等待却仍在 grep 裸流）的注释。device-plane runner
则干脆放弃实时流：force-stop、`logcat -c`、干净启动，然后轮询
`logcat -d -s dsh.dsh` 快照 —— dump 天然只含本轮
（`run-device-plane.sh:70-95`）。两种纪律都成立；混用（截断 canary 钉住、
等待裁裸流）正是失败形状。

## 8. iOS 模拟器 runtime < 26 的 dyld 缓存里没有 libswiftWebKit

`DSHHost.debug.dylib` 在 iOS 18.5 模拟器上启动即死：`Library not loaded:
@rpath/libswiftWebKit.dylib` —— 而每个 runner 都先干净地构建成功，失败
只在 install+boot 之后才浮出，把整轮预算烧在一个永远产不出 app 日志的
启动上。机理：26 之前的模拟器 runtime 的 dyld 共享缓存不带
libswiftWebKit，debug dylib 的 Swift-WebKit 依赖在加载期无法解析 ——
这是已装 runtime 的属性而非构建的属性，rebuild 无解。

iOS E2E 腿跑在已验证配对上 —— iOS 26.5 的 `dsh-iphone` 模拟器 —— 且在
boot/install 之前对更老的 runtime 大声失败。代码承载：
[hosts/ios/Tools/sim-preflight.sh](../hosts/ios/Tools/sim-preflight.sh)
（`MIN_MAJOR=26`，`:19` —— "oldest simulator runtime whose dyld cache
carries libswiftWebKit"），读 `xcrun simctl list -j devices` 并以点名
违规 runtime 的方式退出 1；listing 是参数（`SIM_PREFLIGHT_DEVICES_JSON`），
拒绝路径无需启动任何东西即可断言。每个 `test/e2e/run-ios-*.sh` runner
在自己的 boot/install 步骤之前一行调用它。

## 如何追加条目

某个会话为新的陷阱付了学费，就在修复或记录它的同一个变更里追加到这里：
两条段落 —— 症状 + 机理，然后是修法 —— 引用承载修法的代码（路径，
引用新鲜时带行号），没有代码承载就明说。本文件两个语言侧同变
（`gov verify pairing` 强制配对）。跨会话复发的陷阱即使已进了 note 或
postmortem 也属于这里 —— 本文件是新 agent 在为其中任何一条再次付费
之前读的那一份。
