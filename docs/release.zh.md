# 发布包(Release packages)

两种触发,一条构建路径:

- **正式发布**——常规路径。`release/please` 读取落到 `main` 上的
  conventional commits,维护**一个**常驻的 release PR:它会升级 `version.txt`、
  生成 `CHANGELOG.md`、并同步三个宿主的版本清单。合并该 PR 即打出 `vX.Y.Z`
  标签并发布 GitHub Release;随后 `release/packages` 工作流构建三个宿主 App 并
  **把它们作为资产挂到该 Release 上**——于是标签就是一个可下载的构建集。
- **手动触发**——Actions 页面(**release/packages → Run workflow**)或
  `gh workflow run release.yml`。产物落在 workflow run 下而非 Release 上;
  `include_harness: true` 会额外构建验证载体。

## 如何发一个版本

1. 用 conventional commit 消息把工作合进 `main`(由 `commit-format` 门禁强制)。
   `feat:` 升 minor,`fix:` 升 patch;低于 1.0 时破坏性变更升 minor,而不是
   直接跳到 1.0.0。
2. `release/please` 会维护一个标题为 `chore(main): release X.Y.Z` 的 PR。它是
   生成出来的机械变更——`version.txt`、`CHANGELOG.md` 和三个宿主清单。
   **要审的是 changelog**;那才是人负责的部分,版本号是跟随 commit 推导的。
3. 合并它。release-please 打出 `vX.Y.Z` 并发布 Release,`release/packages`
   构建三个宿主并挂上去(每个宿主 30–60 分钟,全部由 release 事件触发)。
4. **补救——某个 Release 上的包有问题。** 不要删掉 Release。用手动触发
   `release/packages` 并填 **`release_tag: vX.Y.Z`**:包会从当前 `main` 构建,
   然后就地替换该标签下的资产(`gh release upload --clobber`)。当你合并的修复
   改变了某个平台必须构建的内容时,就用这条路——例如 HarmonyOS 的 HAP,
   在把产品级 `debuggable` 覆盖移进模块的按模式 `buildOptionSet` 之前,
   它一直在发布 debuggable 的包。

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

### 一次性配置:发布令牌

`release/please` 需要一个名为 `RELEASE_PLEASE_TOKEN` 的 secret——一个
fine-grained PAT(或 GitHub App 安装令牌),在本仓库上具备
**contents: write** 与 **pull requests: write**。`secrets.GITHUB_TOKEN`
不能替代:它创建的事件不会触发 workflow,于是 release PR 永远拿不到 `main`
分支保护所要求的 `gates` 检查,也就永远无法合并。该 secret 缺失时工作流会
大声失败,而不是悄悄退化成这条坏路径。

每个 job 也会在 workflow run 下上传各自独立的可下载产物。

**默认触发产出的是面向用户的构建**——就是你交给用户的那一份。分发构建不跑
任何验证机制,只输出关键日志集(`warn` + `error`);debug/info 在源头就被剥离
(AGENTS.md 约束 5,rules.md 规则 L4):

| 产物 | 配置 | Release 资产名 | 可直接安装? |
| --- | --- | --- | --- |
| `dsh-ios` | Release | `dsh-ios-device-unsigned.zip` + `dsh-ios-simulator-unsigned.zip`;官方 Web 客户端已内嵌 | 否——先签名(见下) |
| `dsh-android` | Release | `dsh-android-unsigned.apk`(官方 web app 打进 assets) | 否——先签名 |
| `dsh-harmony` | Release | `dsh-harmony-unsigned.hap` | 否——经 DevEco/hdc 签名(见下) |

Release 资产一律按 `dsh-<宿主>…` 命名,绝不沿用构建系统的内部产物路径
(`entry-default-unsigned.hap`、`app-release-unsigned.apk`)。工作流在上传前
先把构建产物改名:`gh release upload` 的 `file#text` 形式设置的是显示
label(下载时会被忽略),真正生效的是文件名本身。`-unsigned` 后缀是刻意的:
它是下载者在文件可用之前必须知道的唯一属性。

**`include_harness: true` 会额外上传 HARNESS 包**——即 E2E 验证载体:debug
配置、完整结构化日志、验证驱动照常运行。它们存在的意义是在真机上手工验证;
`dev/*` 流水线本来就在每次 push 时构建并运行 debug harness,所以这里默认关闭:

| 产物 | 配置 | 内容 |
| --- | --- | --- |
| `dsh-ios-harness` | Debug | `DSHSpike-harness-*-unsigned.zip`(真机 + 模拟器) |
| `dsh-android-harness` | Debug | `app-debug.apk`(debug 签名,可直接安装) |
| `dsh-harmony-harness` | Debug | `entry-default-debug-unsigned.hap` |

该选哪个?**想用这个 App 就选 Release;想验证它就选 harness**(跑 E2E 腿、
读 `dsh.spike.log:` 流)。

三条构建镜像自已验证过的 `dev/ios` / `dev/android` / `dev/harmonyos`
配方(同样的 vendor、同样的钉死工具链)。发行级签名(分发证书、上架
App Store / AppGallery)不在范围内:这些包仍需本地签名才能安装。

## iOS —— 真机签名与安装

真机 `.app` 刻意未签名(CI 不持有任何 Apple 证书)。装上 iPhone:

1. 解压 `dsh-ios-device-unsigned.zip`。
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
