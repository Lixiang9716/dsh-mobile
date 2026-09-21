# 发布包(Release packages)

三个宿主 App 的手动打包,每次触发各出一份。在 GitHub Actions 页面触发
(**release/packages → Run workflow**),或:

```sh
gh workflow run release.yml
```

每个 job 在 workflow run 下上传各自独立的可下载产物:

| 产物 | 内容 | 可直接安装? |
| --- | --- | --- |
| `dsh-ios` | `DSHSpike-device-unsigned.zip`(真机 .app,未签名)+ `DSHSpike-simulator.zip` | 否——先签名(见下) |
| `dsh-android` | `app-debug.apk`(debug 签名) | 是——允许未知来源后直接装,或 `adb install` |
| `dsh-harmony` | `entry-default-unsigned.hap` | 否——经 DevEco/hdc 签名(见下) |

三条构建镜像自已验证过的 `dev/ios` / `dev/android` / `dev/harmonyos`
配方(同样的 vendor、同样的钉死工具链)。发行级签名(分发证书、上架
App Store / AppGallery)不在范围内:这些包面向真机验证。

## iOS —— 真机签名与安装

真机 `.app` 刻意未签名(CI 不持有任何 Apple 证书)。装上 iPhone:

1. 解压 `DSHSpike-device-unsigned.zip`。
2. 用免费 Apple ID(7 天有效期)或付费团队签名:
   - **Xcode**:打开 `hosts/ios/DSHSpike.xcodeproj`,在 target 的
     Signing & Capabilities 里选你的团队,连上手机直接 Run——或把解压的
     `.app` 拖到 **Window → Devices and Simulators** 里的设备上。
   - **Sideloadly / AltStore**:用你的 Apple ID 指向解压的 `.app`。
3. 手机上:设置 → 通用 → VPN 与设备管理 → 信任你的开发者描述文件,然后
   启动 **DSHSpike**。

如实说明:打包的是验证载体。直接启动会拉起运行时、回环 carrier 和挂载
的官方 Web Client;真实 LLM 流式驱动(`m2.llm`)需要以
`-dsh-scenario m2-llm` 启动参数运行,且凭据由 E2E runner
(tools/e2e/run-ios-m2-llm.sh)预先注入 `app` fs scope——侧载手机上的
交互式真 LLM 对话尚未接线。

## Android

`app-debug.apk` 用 debug 密钥库签名:拷到手机、允许"安装未知应用"、
点按安装——或 `adb install app-debug.apk`。真 LLM 驱动通过
`bash hosts/android/ci/...` runner 脚本在连接的设备上运行
(证据流程见 hosts/android/artifacts/m2-llm/)。

## HarmonyOS

HAP 是 debug 模式但未签名(签名材料与设备相关):

1. 用 DevEco Studio 导入 `hosts/harmony`,把 HAP 加进 run 配置——
   DevEco 会用本地 debug 证书自动签名并装到连接的设备/模拟器;或
2. 在 `build-profile.json5` 配好 debug 签名后
   `hdc install entry-default-unsigned.hap`。

## 另见

- 双语对侧:[release.md](release.md)
- 证据约定:[e2e-matrix.zh.md](e2e-matrix.zh.md)
