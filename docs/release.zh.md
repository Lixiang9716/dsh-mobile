# 发布包(Release packages)

发布流水线分三个阶段,每个阶段的 workflow 名字都直接说明自己是哪一段——
`release/version` **准备**一次发布,随后**每个宿主一个打包阶段**负责构建并挂载。
命名与 `dev/ios`、`dev/android`、`dev/harmonyos` 对齐,所以在 Actions 列表里
不点开就能看出一次运行属于哪个阶段、哪个宿主。

| 阶段 | Workflow | 触发 |
| --- | --- | --- |
| 准备 | `release/version` | 每次推送到 `main`;维持一个常驻 release PR,永不打标签 |
| 打包 | `release/ios` | **推送 `v*` 标签**,或手动触发 |
| 打包 | `release/android` | 同上 |
| 打包 | `release/harmony` | 同上 |

**发布由标签推送触发**——`git push origin vX.Y.Z`。既不是 `release: published`
事件,也不是 release-please 跑完:把发布挂在机器人跑完之上,正是这条流水线花了几天
才走出来的失败模式——一个凭据、一个仓库设置、一次被抑制的事件,就能让发布停在一个
什么都不报的步骤上。现在切一次发布只需要 `contents: write`,而同一个标签推送直接
重试即可。

两种入口,同一条构建路径:

- **正式发布**——常规路径:落地工作 → 合并 release PR → 推标签。
  `release/version` 读取落到 `main` 上的 conventional commits,维护**一个**常驻的
  release PR:它会升级 `version.txt`、生成 `CHANGELOG.md`、并同步三个宿主的版本
  清单——但到此为止(`skip-github-release: true`)。合并该 PR 只会推进那四个版本
  文件;**推送标签**才会启动三个 `release/<宿主>` workflow,由它们构建各自的包并
  **挂到该标签对应的 Release 上**(该标签还没有 Release 时先创建它)——于是标签就是
  一个可下载的构建集。(`CHANGELOG.md` 由第一个合并的 release PR 创建——在那之前
  它刻意不存在,所以第一个 `chore(main): release X.Y.Z` 落地前不必去找它。)
- **手动触发**——Actions 页面(**release/ios**、**release/android** 或
  **release/harmony** → Run workflow)或 `gh workflow run release-ios.yml`。
  产物落在 workflow run 下而非 Release 上;`include_harness: true` 会额外构建
  该宿主的验证载体。

## 如何发一个版本

1. 用 conventional commit 消息把工作合进 `main`(由 `commit-format` 门禁强制)。
   `feat:` 升 minor,`fix:` 升 patch;低于 1.0 时破坏性变更升 minor,而不是
   直接跳到 1.0.0。
2. `release/version` 会维护一个标题为 `chore(main): release X.Y.Z` 的 PR。它是
   生成出来的机械变更——`version.txt`、`CHANGELOG.md` 和三个宿主清单。
   **要审的是 changelog**;那才是人负责的部分,版本号是跟随 commit 推导的。
3. 合并它。四个版本文件在 `main` 上推进;此时还没有任何标签。
4. **在那个合并提交上推标签:**

       git pull --ff-only && git tag vX.Y.Z && git push origin vX.Y.Z

   这会触发三个 `release/<宿主>` workflow,各自构建自己的宿主并把包挂到该标签的
   Release 上。三者并发执行;在 v0.0.1 那次 release 事件上实测为 iOS 15 分钟、
   Android 11 分钟、HarmonyOS 2 分钟,之后每次完整运行都在 9–15 分钟内完成——
   单个 job 的超时是 60 分钟。

   每个 workflow 都会先跑 `tools/release/check-tag-version.sh`,它会拒绝任何与
   四个版本文件之一不符的标签。在 `version.txt` 还是 `0.0.2` 时推 `v0.0.3`,会在
   任何构建开始前就失败,并逐个点名所有不一致——这正是"由人触发发布"否则会重新
   引入的漂移:一个装在本不该属于它的版本号下的包,下游没有任何环节会察觉。
5. **补救——某个 Release 上的包有问题。** 不要删掉 Release。触发那个宿主的
   workflow(例如 `release/harmony`)并填 **`release_tag: vX.Y.Z`**:包会从当前
   `main` 构建,然后就地替换该标签下的资产(`gh release upload --clobber`)。
   当你合并的修复改变了某个平台必须构建的内容时,就用这条路——例如 HarmonyOS
   的 HAP,在把产品级 `debuggable` 覆盖移进模块的按模式 `buildOptionSet` 之前,
   它一直在发布 debuggable 的包。**一次只重建一个宿主正是要点**:一个坏 HAP
   不需要把 iOS 一起重打。
6. **补救——标签本身是错的。** 删掉重推:`git push --delete origin vX.Y.Z`,
   修好版本文件(或合并 release PR),再打一次标签。如果 Release 已经被创建,
   连它一起删掉——Release 是打包 workflow 创建的,下次推标签会重新创建。

### 版本流

整个仓库共用一个版本号:三个宿主在同一次构建里一起发布,因此共享一个号。
`version.txt` 与 `.release-please-manifest.json` 是事实来源,宿主清单由
`release-please-config.json` 里的 `extra-files` 接线保持一致:

| 宿主 | 文件 | 字段 | 更新器 |
| --- | --- | --- | --- |
| iOS | `hosts/ios/App/Info.plist` | `CFBundleShortVersionString` | `xml` + xpath——源文件里无需任何标记 |
| Android | `hosts/android/app/build.gradle.kts` | `versionName` | `generic` + `// x-release-please-version` |
| HarmonyOS | `hosts/harmony/AppScope/app.json5` | `versionName` | `json` + jsonpath——`.json5` 扩展名不会被自动识别,所以类型必须显式声明 |

构建号**不**在此版本流内:`CFBundleVersion`、Android 的 `versionCode` 与
HarmonyOS 的 `versionCode` 是 semver 表达不了的单调整数,继续手工维护。

### 配置(一次性):一个仓库设置

`release/version` 使用 `secrets.GITHUB_TOKEN` 运行——**没有任何令牌需要配置**。
但 `GITHUB_TOKEN` 能否开 pull request,取决于仓库是否允许:**Settings → Actions →
General → Workflow permissions → "Allow GitHub Actions to create and approve
pull requests"**。关着的时候,release-please 会一路走到最后一个 API 调用然后被拒:
*"GitHub Actions is not permitted to create or approve pull requests"*——这正是过去
那个 PAT 一直在掩盖的失败。

它可以通过 API 设置,本仓库就是这么做的:

    gh api --method PUT repos/OWNER/REPO/actions/permissions/workflow --input - <<'JSON'
    {"default_workflow_permissions":"read","can_approve_pull_request_reviews":true}
    JSON

设置打开之后,`GITHUB_TOKEN` 确实可以创建 release PR。但**它依然无法让那个 PR 变成
可合并**,这一点必须说清楚——这是整条流水线里唯一尚未解决的部分。

用 `GITHUB_TOKEN` 开的 release PR 拿不到 `pull_request` workflow(它们以
`action_required` 的形式到达),因此拿不到 `gates` 检查,而 `main` 要求它。
`release/version` 会在最后一步派发一次门禁 workflow 到 release 分支,试图补上这个
检查,但**在 PR #111 上实测:这条路不通**——那次派发在 PR 的**确切 head SHA** 上产出了
绿色的 `gates` 检查,上下文、app 都对,suite 也关联到了该 PR,而 PR 在 12 分钟以上
的时间里始终是 `BLOCKED`、检查列表为空。分支保护只承认来自 **pull request 自身事件流**
的检查。见 D13;D10 最初的 PAT 要求(D11 曾否定)在这一点上是对的。

**所以"版本号提交由谁写"才是真正待决的问题,有两条路:**

| 路径 | 需要 | 现状 |
| --- | --- | --- |
| 由 release-please 开 release PR | 一个**归属到用户**的令牌(PAT 或 GitHub App),使其事件不被抑制——即 D10 当年的处方 | 在配置该令牌前处于阻塞 |
| 由人或 agent 开一个普通 PR,改那四个版本文件 | 什么都不需要——人开的 PR 正常拿到检查 | 现在就能用,且是**推荐路径** |

第二条正是 `tools/release/check-tag-version.sh` 存在的理由:把版本号变更放进普通 PR
之后,防止标签与版本文件漂移的就是那道守卫。无论走哪条,**切发布本身都不受影响**——
下面第 4 步的标签推送只需要 `contents: write`。

`RELEASE_PLEASE_TOKEN` 已不再被任何 workflow 读取。如果它还留在 secret 里,就是
被忽略而已;不需要删除,它的 fine-grained 权限也不再有任何影响。见 D11。

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
vendored 官方 dist,官方 web 驱动(`b1.official-web.mount`)才能把它服务出来。

```sh
# 1. 本地物化三棵未跟踪目录树(均按 MANIFEST 校验)
tools/e2e/ensure-official-dist.sh
tools/e2e/ensure-client-bundles.sh
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
#            (精确的目录操作见 tools/e2e/run-ios-b1.sh 第 4/4b 步)

# 3. 以 official-web 模式启动
#    模拟器:
xcrun simctl launch org.dsh.DSHSpike -dsh-mode official-web
#    真机:
#      xcrun devicectl device process launch --device "$DEVICE" \
#        org.dsh.DSHSpike -dsh-mode official-web
```

真实对话回合还需要把凭据放进
`Documents/profiles/default/m2-llm/config.json`(`{baseUrl, apiKey, model}`)
并加 `-dsh-scenario m2-llm` 启动参数;密钥只留在应用容器里,绝不进仓库。

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
