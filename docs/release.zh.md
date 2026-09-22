# 发布包(Release packages)

发布流水线是:先**准备**,再**逐个宿主打包**;每个 workflow 的名字都直接说明自己是哪一段。
打包阶段是 `release/ios`、`release/android`、`release/harmony`——与 `dev/ios`、
`dev/android`、`dev/harmonyos` 对齐,所以在 Actions 列表里不点开就能看出是哪个宿主。

| 阶段 | 是什么 | 触发 |
| --- | --- | --- |
| 准备 | 一个普通 pull request,运行 `packages/release/bump-version.py` | 你决定要发版的时候 |
| 打包 | `release/ios` | **推送 `v*` 标签**,或手动触发 |
| 打包 | `release/android` | 同上 |
| 打包 | `release/harmony` | 同上 |

**发布由标签推送触发**——`git push origin vX.Y.Z`。既不是 `release: published`
事件,也不是某个机器人跑完:把发布挂在别的东西跑完之上,正是这条流水线花了几天才走出来的
失败模式——一个凭据、一个仓库设置、一次被抑制的事件,就能让发布停在一个什么都不报的
步骤上。现在切一次发布只需要 `contents: write`,失败就直接再推一次。

两种入口,同一条构建路径:

- **正式发布**——常规路径:改版本 → 合并 → 推标签。
  `packages/release/bump-version.py X.Y.Z` 一条命令写完四个版本文件和 `CHANGELOG.md`
  的对应小节;然后你开一个**普通** pull request——这正是要点:人或 agent 开的 PR 会像
  任何其他 PR 一样拿到必需的 `gates` 检查(D13/D14)。合并之后推标签,三个
  `release/<宿主>` workflow 就会被触发,各自构建并把包**挂到该标签的 Release 上**,
  该标签还没有 Release 时先创建它。于是标签就是一个可下载的构建集。
- **手动触发**——Actions 页面(**release/ios**、**release/android** 或
  **release/harmony** → Run workflow)或 `gh workflow run release-ios.yml`。
  产物落在 workflow run 下而非 Release 上;`include_harness: true` 会额外构建
  该宿主的验证载体。

## 如何发一个版本

1. 用 conventional commit 消息把工作合进 `main`(由 `commit-format` 门禁强制)。
   1.0 以下,`feat:` 或破坏性变更升 minor,`fix:` 升 patch。
2. **改版本并写 changelog:**

       packages/release/bump-version.py X.Y.Z            # 或先 --dry-run 看一眼

   它会把"上一个标签以来的提交所隐含的版本号"作为提示打印出来(决定权在人),
   然后改写 `version.txt`、iOS 的 `Info.plist`、Android 的 `versionName` 和
   HarmonyOS 的 `versionName`,并从这些提交生成该版本的 `CHANGELOG.md` 小节。
   **要审的是 changelog**;那才是人负责的部分。
3. **用一个普通 pull request 提交并合并它。** 人或 agent 开的 PR 会正常拿到必需的
   `gates` 检查——这正是"版本号变更走普通 PR"的原因(D13/D14)。此时还没有任何标签。
4. **在那个合并提交上推标签:**

       git pull --ff-only && git tag vX.Y.Z && git push origin vX.Y.Z

   这会触发三个 `release/<宿主>` workflow,各自构建自己的宿主并把包挂到该标签的
   Release 上。三者并发执行;在 v0.0.1 那次 release 事件上实测为 iOS 15 分钟、
   Android 11 分钟、HarmonyOS 2 分钟,之后每次完整运行都在 9–15 分钟内完成——
   单个 job 的超时是 60 分钟。

   每个 workflow 都会先跑 `packages/release/check-tag-version.sh`,它会拒绝任何与四个
   版本文件之一不符的标签。在 `version.txt` 还是 `0.0.2` 时推 `v0.0.3`,会在任何构建
   开始前就失败,并逐个点名所有不一致——这正是"由人触发发布"否则会重新引入的漂移:
   一个装在本不该属于它的版本号下的包,下游没有任何环节会察觉。
5. **补救——某个 Release 上的包有问题。** 不要删掉 Release。触发那个宿主的
   workflow(例如 `release/harmony`)并填 **`release_tag: vX.Y.Z`**:包会从当前
   `main` 构建,然后就地替换该标签下的资产(`gh release upload --clobber`)。
   当你合并的修复改变了某个平台必须构建的内容时,就用这条路——例如 HarmonyOS
   的 HAP,在把产品级 `debuggable` 覆盖移进模块的按模式 `buildOptionSet` 之前,
   它一直在发布 debuggable 的包。**一次只重建一个宿主正是要点**:一个坏 HAP
   不需要把 iOS 一起重打。
6. **补救——标签本身是错的。** 删掉重推:`git push --delete origin vX.Y.Z`,
   修好版本文件(开一个新的 bump PR),再打一次标签。如果 Release 已经被创建,
   连它一起删掉——Release 是打包 workflow 创建的,下次推标签会重新创建。

### 版本流

整个仓库共用一个版本号:三个宿主在同一次构建里一起发布,因此共享一个号。
`version.txt` 是事实来源,而 **`packages/release/bump-version.py` 一条命令写完四个文件**,
所以它们不会漂移:

    packages/release/bump-version.py 0.1.0            # 改写所有版本文件
    packages/release/bump-version.py 0.1.0 --dry-run  # 先看一眼会改什么

| 宿主 | 文件 | 字段 |
| --- | --- | --- |
| — | `version.txt` | 事实来源 |
| iOS | `hosts/ios/App/Info.plist` | `CFBundleShortVersionString` |
| Android | `hosts/android/app/build.gradle.kts` | `versionName` |
| HarmonyOS | `hosts/harmony/AppScope/app.json5` | `versionName` |

脚本会推导出 conventional commits 所隐含的版本号(1.0 以下,`feat` 或破坏性变更升
minor,`fix` 升 patch)并作为提示打印出来,由人来决定;它同时根据这些提交写出该版本的
`CHANGELOG.md` 小节,并把写过的每个文件重新读回校验——**部分应用**的版本变更会在写入
之前就被拒绝,而不是写完之后。随后 `packages/release/check-tag-version.sh` 会拒绝任何与
这四个文件不符的标签,两端因此不可能悄悄脱节。

构建号**不**在此版本流内:`CFBundleVersion`、Android 的 `versionCode` 与
HarmonyOS 的 `versionCode` 是 semver 表达不了的单调整数,继续手工维护。

### 配置:无

没有令牌要配,没有仓库设置要记,也没有机器人要配——因为**发布的任何一步都不依赖它们**。
版本号的改动是由人或 agent 开的普通 pull request,所以它像任何其他变更一样拿到普通的
`gates` 检查;发布本身是标签推送,而打包 workflow 只需要 `contents: write`。

这是刻意的,也是这条流水线的历史收敛出来的结论:用 `GITHUB_TOKEN` 开的 release PR
拿不到必需的检查——它的 `pull_request` workflow 会以 `action_required` 到达;而由
`workflow_dispatch` 运行产出的检查也不满足分支保护(PR #111 实测:在确切 head SHA 上
是绿色 `gates`,app 与上下文都对,suite 也关联到该 PR,PR 仍是 `BLOCKED` 且检查列表
为空)。分支保护只承认来自 pull request 自身事件流的检查。把版本号改动作为普通 PR 提交,
就绕开了整件事。见 D13/D14。

`RELEASE_PLEASE_TOKEN` 若还留在 secret 里,则没有任何东西读它。`release-please` 本身
已退役(D14);若将来想要回来,它的配置都在 `git log` 里。

每个 job 也会在 workflow run 下上传各自独立的可下载产物。

**默认触发产出的是面向用户的构建**——就是你交给用户的那一份。分发构建不跑
任何验证机制,只输出关键日志集(`warn` + `error`);debug/info 在源头就被剥离
(AGENTS.md 约束 5,rules.md 规则 L4):

| 产物 | 配置 | Release 资产名 | 可直接安装? |
| --- | --- | --- | --- |
| `dsh-ios` | Release | `dsh-ios.ipa`;官方 Web 客户端已内嵌 | 否——先签名(见下) |
| `dsh-android` | Release | `dsh-android.apk`(官方 web app 打进 assets) | 否——先签名 |
| `dsh-harmony` | Release | `dsh-harmony.hap` | 否——经 DevEco/hdc 签名(见下) |

Release 资产一律按 `dsh-<宿主>.<扩展名>` 命名,绝不沿用构建系统的内部产物路径
(`entry-default-unsigned.hap`、`app-release-unsigned.apk`)。工作流在上传前
先把构建产物改名:`gh release upload` 的 `file#text` 形式设置的是显示
**label**(下载时会被忽略),真正生效的是文件名本身。

一个 Release **每个宿主一个包** —— 正好三个资产,对应三个平台。不该出现在
Release 页面的东西随 workflow run 发布:iOS 的**模拟器**包
(`dsh-ios-simulator.zip`)是开发便利品,因此它是 `dsh-ios` 这个 job 的
artifact,不是 release asset。`-harness` 包同理。

**`dsh-ios.ipa`** 是真正的(未签名)`.ipa` —— 根目录下是
`Payload/DSHSpike.app`,即 AltStore / Sideloadly / `xcrun devicectl`
所期望的布局,而不是把 `Release-iphoneos/…` 换个扩展名。

**三个包都未签名。** CI 不持有 Apple 证书,也没有 HarmonyOS 签名材料,
所以每个包都需要本地签名才能安装。想免签名跑起来,就去 run 的 `dsh-ios`
artifact 里取模拟器包。

**`include_harness: true` 会额外上传 HARNESS 包**——即 E2E 验证载体:debug
配置、完整结构化日志、验证驱动照常运行。它们存在的意义是在真机上手工验证;
`dev/*` 流水线本来就在每次 push 时构建并运行 debug harness,所以这里默认关闭:

| 产物 | 配置 | 内容 |
| --- | --- | --- |
| `dsh-ios-harness` | Debug | `DSHSpike-harness-device-unsigned.zip` + `DSHSpike-harness-simulator.zip` |
| `dsh-android-harness` | Debug | `app-debug.apk`(debug 签名,可直接安装) |
| `dsh-harmony-harness` | Debug | `entry-default-debug-unsigned.hap` |

该选哪个?**想用这个 App 就选 Release;想验证它就选 harness**(跑 E2E 腿、
读 `dsh.spike.log:` 流)。

三条构建镜像自已验证过的 `dev/ios` / `dev/android` / `dev/harmonyos`
配方(同样的 vendor、同样的钉死工具链)。发行级签名(分发证书、上架
App Store / AppGallery)不在范围内:这些包仍需本地签名才能安装。

## iOS —— 真机签名与安装

真机 `.app` 刻意未签名(CI 不持有任何 Apple 证书)。装上 iPhone:

1. 取 `dsh-ios.ipa` —— 一个未签名的 `.ipa`(`Payload/DSHSpike.app`)。
   不需要先解压:签名工具直接吃 `.ipa` 本身。
2. 用免费 Apple ID(7 天有效期)或付费团队签名:
   - **Xcode**:打开 `hosts/ios/DSHSpike.xcodeproj`,在 target 的
     Signing & Capabilities 里选你的团队,连上手机直接 Run——或把解压的
     `.app` 拖到 **Window → Devices and Simulators** 里的设备上。
   - **Sideloadly / AltStore**:用你的 Apple ID 指向解压的 `.app`。
3. 手机上:设置 → 通用 → VPN 与设备管理 → 信任你的开发者描述文件,然后
   启动 **DSHSpike**。

**`dsh-ios`(release):直接启动就进官方 DSH Web UI。** 官方 dist(89 个文件)
与客户端 bundles(129 个文件)作为资源内嵌进 App(`Tools/stage_official_web.py`,
仅 Release 配置由 `StageOfficialWeb` 构建阶段执行),因此不需要从外部暂存任何
东西。证据:`hosts/ios/artifacts/release-logging/`(直接启动、容器为空、无启动
参数 → 官方 UI,`dsh.spike.log:` 记录 0 条、verdict 文本 0 条、debug/info 记录
0 条)。

**`dsh-ios-harness`(debug):验证载体。** 它什么都不内嵌,读的是 runner 暂存到
`Documents/` 的目录树——与之前完全一致,并带完整 E2E 流。给它传 E2E 启动模式
可以跑;release 构建则会大声拒绝(规则 5),因为面向用户的二进制没有驱动。

### 从 HARNESS 看到官方 Web UI(2026-09-21 已验证)

只有 `dsh-ios-harness` 需要这一步:它不内嵌,所以 carrier 需要应用容器里先有
vendored 官方 dist,官方 web 驱动(`officialweb.mount`)才能把它服务出来。

```sh
# 1. 本地物化三棵未跟踪目录树(均按 MANIFEST 校验)
test/e2e/ensure-official-dist.sh
test/e2e/ensure-client-bundles.sh
runtime/spike/vendor/ensure-dsh.sh

# 2. 暂存进应用容器
#    模拟器:
APP_DATA=$(xcrun simctl get_app_container "$UDID" org.dsh.DSHSpike data)
#    真机(iOS 17+;设备名/UDID 见 `xcrun devicectl list devices`):
#      xcrun devicectl device copy to --device "$DEVICE" \
#        --domain-type appDataContainer --domain-identifier org.dsh.DSHSpike \
#        --source <tree> --destination Documents/...
#    两者相同:dist → Documents/official-web/dist
#             客户端 bundles → Documents/web-plugins/npm/@deepseek-ai/
#             vendored bootstrap 包覆盖其构建孪生
#            (精确的目录操作见 test/e2e/run-ios-official-web-mount.sh 第 4/4b 步)

# 3. 以 official-web 模式启动
#    模拟器:
xcrun simctl launch org.dsh.DSHSpike -dsh-mode official-web
#    真机:
#      xcrun devicectl device process launch --device "$DEVICE" \
#        org.dsh.DSHSpike -dsh-mode official-web
```

真实对话回合还需要把凭据放进
`Documents/profiles/default/llm-live-stream/config.json`(`{baseUrl, apiKey, model}`)
并加 `-dsh-scenario llm-live-stream` 启动参数;密钥只留在应用容器里,绝不进仓库。

## Android

`app-release-unsigned.apk`(release)把官方 web app 打进 assets,安装前需要
签名;`app-debug.apk`(harness)用 debug 密钥库签名:拷到手机、允许"安装未知
应用"、点按安装——或 `adb install app-debug.apk`。release 直接启动即进官方
DSH Web UI;harness 则通过 `hosts/android/ci/` runner 脚本跑 E2E 腿
(证据流程见 hosts/android/artifacts/m2-llm/)。

## HarmonyOS

HAP 未签名(签名材料与设备相关)。`dsh-harmony` 是 release 配置
(`DSH_RELEASE` 定义同时到达 ArkTS 与原生 spike 库,debug/info 因此折叠掉);
`dsh-harmony-harness` 是 debug/E2E 载体。

**`dsh-harmony`(release):直接启动即可到达官方 DSH Web UI。**
服务栈只有一处座位——`hosts/harmony/entry/src/main/ets/model/OfficialServe.ets`:
回环 carrier 直接以 rawfile 提供 vendored dist 与客户端 bundle,web-boot 运行时
组装官方 boot wire,ArkWeb 挂载 origin——两种配置都跑它。E2E 驱动
(`model/OfficialPhase.ets`:逐事件记录、同源探针、httpFetch / session-live /
write 三段腿、verdict)只通过 hook 挂到这个座位上,所以 release 启动没有驱动、
没有探针,也不产生任何记录;release 构建被要求跑 E2E 腿
(`--ps dsh.e2e.leg <leg>`)时会按名字大声拒绝(rule 5)。仍然存在的缺口是挂载腿
自己如实说明的那些,各宿主一致:`/api` 与 mux 对未认领端点按契约返回结构化错误
——session 面只在 harness 的 spine 腿上被服务——而真正的对话需要用户自己提供
凭据,移动宿主不带模型端点。证据:
`hosts/harmony/artifacts/release-logging/`(直接启动、无启动参数、无外部投放 →
官方 UI、零 `dsh.spike.log:` 记录、零 verdict 文本、零 debug/info 记录;拒绝;
harness 套件重跑全绿)。

签名:

1. 用 DevEco Studio 导入 `hosts/harmony`,把 HAP 加进 run 配置——
   DevEco 会用本地 debug 证书自动签名并装到连接的设备/模拟器;或
2. 在 `build-profile.json5` 配好 debug 签名后
   `hdc install entry-default-unsigned.hap`。

## 另见

- 双语对侧:[release.md](release.md)
- 证据约定:[e2e-matrix.zh.md](e2e-matrix.zh.md)
