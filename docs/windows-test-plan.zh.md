# Windows 侧测试计划(harmony 运行时 E2E + 对照)

日期:2026-10-05。目的:补全 WSL2 无法覆盖的验证边界 —— harmony 的 HAP 从未被任何环境**执行**过
(编译 + HAP 结构断言全绿,运行时零证明)。Windows 侧 DevEco 模拟器是全仓库唯一的 harmony
可执行目标;附带一个可选的 proxy-free Android 对照(解耦 Clash 代理变量)。

证据约定:一切产物写 `~/dsh-mobile-artifacts/windows-e2e/`(仓库外);发现的偏差逐条往
`.zcode/loop/queue.jsonl` 追加(字段 `id,title,severity,status:"open"`,note 含证据路径),
不改已有行。日志体系映射:harmony 用 **hilog**(对应 logcat),`hilog | grep`。

---

## P0 环境装设(用户交互部分,当前缺失)

2026-10-05 已探测:Windows 侧**没有** DevEco Studio、没有 hdc.exe、`/mnt/d/MyApplication/Sdk`
为空(只有项目骨架 AppScope/entry/hvigor)。需要:

1. 安装 DevEco Studio(Windows 版)+ HarmonyOS SDK(接受许可协议,数 GB)。
2. 在 Device Manager 里创建/启动一个 **HarmonyOS 模拟器**(API 12+ 即可)。
3. 验收判据(P0 通过线):
   - `hdc list targets` 列出模拟器(形如 `127.0.0.1:5555`);
   - `hdc shell "cat /proc/version"` 有输出(标准系统是 Linux 内核);
   - WSL 互操作可用:WSL 里
     `/mnt/c/.../sdk/default/openharmony/toolchains/hdc.exe list targets` 与 Windows 侧一致
     (WSL 将以此驱动全部测试)。
4. HAP 产物来源:CI 下载(`gh run download <dev-harmonyos run-id> -n dsh-spike-hap -D
   ~/dsh-mobile-artifacts/windows-e2e/`),或仓库 harmony 腿本地构建(hvigor 可复用 /mnt/d
   的包装器)。模拟器接受调试签名;install 报签名错则在 DevEco 里配置自动签名后重试。

---

## T1 模拟器冷启与应用结构(对应 Android 冷启协议;最高价值)

步骤(WSL 驱动 hdc.exe;以下 hdc 均指该互操作路径):

```
hdc install <hap>                          # 安装
hdc shell aa start -a EntryAbility -b com.dshmobile.spike   # 启动
# 就绪轮询(60s 截止,每 5s):
hdc shell "cat /proc/net/tcp6"             # 找应用的 LISTEN 行
hdc fport tcp:<P> tcp:<P>                  # 端口转发
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<P>/   # 带页面自取的 cookie
hilog | grep -E "FAIL|FATAL"               # 增量
```

**预期结果**:
- 应用启动后 **≤5s** 出现 LISTEN(Android 基线 ~2s;harmony 首启放宽到 10s);
- 页面 GET **200**(若 401,先经 UI 过 Internal-Testing 通知再取 cookie);
- composer(`[contenteditable="true"]`)可见 —— **不是死壳**(2026-09-24 Android 的死壳缺陷类,
  harmony 首次被执行,这是头号断言);
- hilog 增量 **0 行 FAIL / 0 行 FATAL**;
- 截图一张(模拟器窗口或 `hdc shell snapshot_display` + `hdc file recv`)。

---

## T2 timer primitive 缺席的诚实性(#382 的 harmony 侧边界)

背景:harmony 宿主未实现 timerSchedule(GatewayCore 答 denied),LLM 读空闲看门狗在 harmony
**无法武装** —— owner 已知边界。本测项验证的是**缺席是诚实的**:

```
hilog | grep -E "timer|arm"                # 冷启后一次性采样
```

**预期结果**:
- 恰好 **一条** per-runtime 的 arm/failed 告警(#382 的 once-per-runtime 语义,
  `upstream/shims/timers.js`);
- **不是风暴**(历史教训:每 arm 一条曾以 21 条/秒翻转跨线程竞态);
- GatewayCore 对 timerSchedule 的 denied 有日志痕迹;
- 回合仍可完成(定时器缺席不应阻断主链路 —— 比"功能可用"更基础的诚实断言)。

---

## T3 真模型回合(创作链路在 harmony 的首次运行)

步骤:staging 凭证(harmony 应用数据在 `/data/app/el2/100/base/com.dshmobile.spike/...`):

```
hdc file send config.json <el2>/files/profiles/default/llm/config.json
hdc shell "chmod 600 <el2>/files/profiles/default/llm/config.json"
# 若属主不对(hdc shell 是 shell 用户),用应用内 BYOK 设置面或调试口修正后重启
```

config.json 内容与 Android 席位相同:baseUrl `https://open.bigmodel.cn/api/coding/paas/v4`、
model `glm-5.3-flash`、apiKey `ea7f...5Lc`。

发回合:"帮我做一个插件,名字 win-hello,功能是向用户问好"。回合完成判据:harmony 侧
session journal(wire 快照)出现 `turn/end completed`;或页面文本出现收尾。

**预期结果**(对照 Android r20 的同款断言):
- 回合 **completed**,模型调用 plugin_manager 的 install 腿;
- 设备树出现 `plugins/win-hello/{manifest.json,plugin.js,card.json}`,registry 行
  `enabled:true`(el2 路径下 `files/profiles/default/spike/plugins/registry.json` 附近);
- hilog 增量 0 新 FAIL;
- 若有失败:**逐字摘录** —— harmony 宿主原语缺失应以结构化拒绝出现,不允许静默假成功。

---

## T4 fs 边界三形态 + 相对拼写(同一 JS 字节,期望逐字一致)

让模型依次读四个路径,取 journal 原始工具结果(或页面 transcript):

| 输入 | 预期结果(与 Android r18/r20 逐字同形 —— shim 字节相同) |
| --- | --- |
| `/system/app` | in-band 拒绝:含工作区根(el2 下的 spike 路径)+ "maybe you meant …/spike/system/app?" |
| `/system/definitely-not-here-xyz` | 缺席语义(not found / ENOENT),**无**锚点拒绝 |
| `spike/../plugins/registry.json` | 解析成功,registry 内容可见(#383 语义) |
| `../../../../etc/passwd` | 钉在根内:ENOENT 形态,**无** passwd 内容 |

任何与 Android 不一致的形态 = 宿主接缝差异(harmony 的 fs 原语实现差异),逐条入队 —— 这是
本测项真正的探针价值。

---

## T5 web_search 现实核查

让模型用 web_search 搜任意词。

**预期结果**:二选一都算过 —— (a) in-band
`[WEB_SEARCH_KEYLESS_CHALLENGED]` 错误(反爬现实,与 Android 席位一致,模型诚实处理);
(b) 真实搜索结果(harmony 网络栈路径不同,可能不被挑战)。**缺陷判定线 = 静默空成功**
(r8 时代的原始缺陷形态)。

---

## T6 轻量 soak

5 次冷启循环(同 T1 协议)+ 每轮内存采样:

```
hdc shell "hidumper --mem $(pidof com.dshmobile.spike)"   # 或 ps -o RSSHLK
```

**预期结果**:5/5 就绪;boot 秒数零方差或小方差(记录分布);无 FAIL 累积;内存无单调增长
(5 次样本 ≤ 首轮 1.5 倍,超出则入队疑似泄漏)。

---

## T7(可选)Android-on-Windows proxy-free 对照

若 Windows 侧装有 Android SDK/模拟器:把同一 release APK 装进 **无代理** 的 Windows 模拟器,
重放三个探针:一句话创作、web_search、流中切网(看门狗时延)。

**预期结果 / 价值**:行为与 WSL 席位一致(±网络差异);**web_search 在无代理网络下可能给出真实
结果** —— 这将把"CHALLENGED 是环境现实还是产品缺陷"这个悬案了结;切网看门狗仍应 120s 级触发
(无代理时 Connection reset 可能更早出现,属预期)。

---

## 退出判据与回灌

- T1-T6 全部达到预期 → harmony 的验证边界从"结构证明"升级为"运行时证明(模拟器)",收口报告
  如实改写;真机(hdc + usbipd)仍是进一步选项。
- 任一断言不符 → 截图 + hilog 摘录 + journal 证据入队,按修复轨处理;预期内的宿主差异
  (如 timer denied)不算失败,入 owner 决策清单。
- 全程不要动 WSL 侧仓库的 git/gov 状态;Windows 侧一切在模拟器内发生。
