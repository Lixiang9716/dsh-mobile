# v0.0.2 发布说明 — 草稿

> v0.0.2 发布说明草稿,截稿 2026-09-30。范围:#240 起合并的全部 PR(2026-09-29 →
> 2026-09-30,#240–#254)。事实只来自已合并 PR;仍在评审的线如实标注。凡数字需要
> 尚未合并的回归报告之处,指向该 PR 而非猜测(宁短勿假)。

## 运行时与套件

- #240 — 上游套件 round-4:**606/679**,tsx 墙消解(真 tsx 安装 + staged 子进程
  入口)、TC39 装饰器经真 vendored decorators 降级、fork/exec pre-exec fd 修复、
  八个超预算文件拆分回落预算线内。
- #242 — 决策矩阵 wave 1:引擎 GC 泄漏修复并重钉 fork(#239)、node 差分腿复活、
  23 个 staging 缺口全数关闭、D9 翻转(iOS 生成产物不再入库,由 `gen.sh` 再生)。
- #243 — **forkpty 面**(D-b):诚实 PTY 子进程服务 node-pty 终端路径(`ptySpawn`
  + `pty.event`,提案 v1.9.0 candidate);node-pty shim 注册为 cjs-loader 内建面。
- #246 — **sharp 面**(D-c):纯 JS 解码 shim——vendored 并 sha256 钉表 jpeg-js/
  pngjs,手写 GIF/WebP/SVG/TIFF codec 跑在 fflate 的 zlib 上;attachment-local 族
  从 import 失败到 93/93。
- #247 — terminal-bash local 加入 shell-suite 平台钉:W8 台账的 staged-world 对
  补齐;真 shell 套件的六条测试跑在 forkpty 面上。
- #251 — **socket 接缝**(D-d):经审计的仅回环 TCP 加法冻结为契约 **v1.8.0**
  (`socketListen`/`socketConnect` + `socket` 通道,五规则授权模型,每次调用留审计);
  17 条 socket 类 TIMEOUT spec 全部重新进入,0 挂起。

## 系统能力面

- #249 — **系统能力面提案**:相机、麦克风、蓝牙收进同一个 OS 权限模型——两层同意
  (先网关弹窗、后 OS 弹窗)、会话级 family-flag 授权、逐调用审计(方向/时长/字节
  计数)——**v1.10.0 candidate**,未冻结任何内容。
- #252 — **`cameraCapture`** 三宿主落地(能力线 1):AVFoundation / camera2 /
  CameraKit 连拍,受 `camera` family flag 约束,平台中立 `camera.plane` 场景,
  逐调用审计;分阶段录像行答 `unavailable`。
- #254 — **BLE 面**(能力线 3):八原语 + `ble.event` 通道三宿主落地,单一 radio
  接缝,确定性 mock radio 与真平台 radio 并列;按姿态选择的 `ble.plane` 场景。
- 麦克风面(能力线 2)**在评审中(#255)**——不在本次发布内。

## UI 与插件

- #248 — **Lynx 渲染面客户端试点**:完全可替换的表现层客户端插件(零网关原语、
  零契约改动);`lynx.mount` 腿证明接缝可替换(同一流程双面各 34/34 事件);主题
  token 单一来源喂 web 与 Lynx 两面,漂移有门。

## 测试与基建

- #250 — **模拟器矩阵**:一条命令证明 release/harness 双味拆分于真实模拟器——
  iOS release 腿 + gateway 19/19 + device-plane(dsh-iphone),Android release 腿 +
  三场景回归 + device-plane 15/15;无工具链处 harmony 诚实跳过并留 skip 收据。
- #253 — **harmony 设备 parity 跑步器**(D-g):一条命令产出 25 记录 parity 收据
  与 tool-rows 上机挂载证明(CLT 模拟器上全绿);无目标在线时打印待机报告、退出 0。

## 治理与 DX

- #241 — 九个开发者体验痛点:`quickjs-boot-parse` 门、`check-staging` 导入图
  交叉校验器、`build.sh` 解析期清单校验、共享 logcat 采集、十二个 iOS runner 全接
  `sim-preflight`、sweep 重试、`docs/troubleshooting.md`,以及 generated-bundles
  D9 修正草案。
- #244 — `staging-check` 门补齐治理欠账:rule-6 反证用例(植入的
  `upstream/boot.js` 缺口 exit 1)与缺失的 `needs: ["self-test"]` 串行边。
- #245 — **staging 清单生成器**(Phase 2):四份每宿主 staging 清单可从导入图推导;
  round-trip 成立、0 冻结致命行。已提交的手工清单**刻意未替换**(见已知问题)。

## 已知问题

截稿时如实陈述:

- **已知 flake**:`b4.write.live`(iOS live-write 腿)与 `win32-dialog`
  (worker 退出竞态——#247 两侧单跑约 80% 红;sweep 绿是重试运气)。两者均非本线回归。
- **套件残差**:#240 时 606/679;#247 的 sweep 为 681 specs / 607 绿。有名有因的
  残差:ssh×13 族卡 TLS 墙(见下)、5 条 lsp spec 失败(小而具名的 shim 缺口,
  #251)、socket 类后续(#251)。终跑回归的完整残差台账随**回归报告 PR——截稿时
  未合并;数字见该 PR**。
- **能力面真机验证待设备**:相机 iOS/Harmony 真机腿与 BLE 真机腿均为一键脚本,
  无设备时 skip 大声(#252、#254);harmony 全量 parity 跑在 CLT 模拟器上,真机腿
  待命(#253);harmony 矩阵腿需 DevEco/hdc 目标(#250)。
- **socket ssh 族的 TLS 墙**:13 条 ssh spec 在 `node:tls: createServer is not
  served` 处大声失败——TLS 终结是 socket 提案的**具名非目标**;下一步是 TLS 设计
  轮,不是更多 socket 管道(#251)。
- **v1.9.0(forkpty)已实现但未冻结**:面已落地并在 darwin CLI 上验证,而
  `contract/primitives.md` 仍冻结在 v1.5.0——冻结走 owner 流程;v1.6.0(事件通道)
  与 v1.7.0(渲染面)草案同样未冻(#243)。
