# 上游能力挂载研究（2026-09-23）

夜间研究了三个同类项目，用于 sharpen dsh-mobile 的平台能力挂载方式：
**@zseven-w/dsh-ios**（把 iOS 模拟器/真机能力暴露为 DSH 插件的 macOS 侧项
目）、**rish-app**（内嵌 Rust x86-64 Linux 全系统解释器、本地执行工具的
React Native 口袋代理）、以及 `v0.1.7-alpha.2` 的 **deepseek-harness**
（我们 vendored 钉版 `0.1.6-alpha.2` 之后的上游，领先 1754 个提交）。
本文保存研究结论与由此产生的采纳决策。英文深度版：
[upstream-capability-mounting.md](upstream-capability-mounting.md)。

## 1. dsh-ios —— 能力引用是会过期的签名对象

名字虽叫 dsh-ios，并非原生 iOS 宿主：它是 macOS 侧的 DSH 插件，"原生能
力"是声明式工具表后面的子进程适配器（`simctl`、`devicectl`、
WebDriverAgent、编译型 OCR 工具）。值得保留的模式：

- **会过期的单一用途能力引用**：工具输出从不携带字节，只携带可重放的
  `presentationMeta`；客户端每次渲染经由 `/grant` 现场铸造 ≤10 分钟的
  HMAC 签名 URL，且在任何令牌之前先做回环传输围栏——泄露的视觉/流引用
  数分钟内即失效。
- **可选能力是"永不运行的作用域"**：可选服务经 `ctx.inject([service], cb)`
  挂载；服务缺席则回调永不触发——不是布尔开关，不是会抛异常的属性探测。
- **"已注册但诚实"的降级**：无法服务的宿主上工具保持注册，以稳定前缀与
  编码原因（`device-locked`、`tunnel-failed`）失败；发现永不 500。
- **注册/销毁对称 + 启动期挂载清单日志**——"宣称的动词背后有实现"的审计。

## 2. rish-app —— 决策核心、摘要与诚实的上限

React Native 代理应用，本地执行工具，内嵌全系统 x86-64 解释器，每次程序
运行引导真实内核（约 40 秒）。可借鉴的：

- **单一共享决策核心、按摘要绑定**：所有代理规则在 C ABI 后的 Rust 核心
  里；工具表是纯表，其 `toolset_sha256` 把每条已存储授权绑定到确切的能力
  字节，历史表分版本重建——旧记录仍有效，能力集变化可检测、可拒绝。
- **持久拒绝而非报错**：根不提供的工具投影为带消毒名称的持久拒绝；
  面向 UI 的投影枚举自身键位，并用测试断言不泄露路径/参数。
- **每次挂载都校验资产完整性**：内核/initramfs/磁盘的 SHA-256 常量在
  *每次*引导与每次运行时重验——不只安装时。
- **账本化审批**：幂等键 + 嵌套写入预算（单次 ≤ 批次 ≤ 尝试）。
- **实测超时与诚实的 runtime-mode 标签**，区分已交付能力与愿景。
- 明确*拒绝*的：每次运行全新 VM 的延迟、全进程单 VM 串行、无交互 PTY 的
  一次性 exec——对我们这种 shell 原语，常驻进程内 Alpine 用户land 才是
  正确形态。

## 3. deepseek-harness（0.1.7-alpha.2）—— 上游契约与漂移

- **接缝三件套即契约**：Service Definition（拥有 `ctx.<key>` 的抽象
  `Service`）+ 提供者 + 消费者；"扩展插件依赖 Service Definition，永不依赖
  具体提供者"。能力事实（`sandboxMode` getter）、诚实的可选成员、cordis
  `inject`（消费者挂起直到服务存在）构成协商词汇。
- **像桌面宿主那样挂载，而非另起一套**：Electron 引导*共享 profile
  runner*，再以 `ctx.plugin(...)` 向运行中的上下文添加宿主能力——第二套
  后端组合是被上游明确拒绝的替代方案。我们的
  `runtime/spike/upstream/boot.js` 移动 profile 引导正是同构；保持如此。
- **我们的钉版落后于 preset 浪潮**：`agent-preset-registry`（带激活审计的
  按会话组合）、`config-editor`、account/job Remote 控制器、双工
  `RemoteStream`、带回退的插件管理器都在 `0.1.6-alpha.2` 之后落地。
  vendored 刷新需要一次有计划的变更；关注 `docs/decisions.md`。
- **上游同样没有 hostType**：平台差异是提供者互换与客户端 `platform`
  声明；线上协议永不携带 Host 对象。

## 采纳决策（本研究在 dsh-mobile 落地的内容）

1. **引导期能力清单记录**——协商出的描述符清单在 spine 引导时以一条结构
   化记录输出（保留命名空间，不影响场景流）：dsh-ios 挂载清单审计的
   我们的形态。
2. **staged 用户land 的每次挂载校验**——ish rootfs 摘要在每次 guest 引导
   时重验，而非仅在拉取时（rish-app 规则应用于我们的 `ishRun`）。
3. **不可用能力的编码原因**——候选契约变更（按 D5 先在 `contract/` 提案）：
   结构化信封增加稳定原因码；发现诚实作答，调用方按码分支。
4. **上游观察哨**——ARCHITECTURE 增设常设小节，点名 0.1.7 的接缝新增，
   让下一次 re-pin 是计划内而非意外。
