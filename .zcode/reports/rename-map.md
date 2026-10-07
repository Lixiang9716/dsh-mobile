# 语义化重命名表（refactor/semantic-names 的执行依据）

范围决议（owner 2026-10-07）：全面改（含外部契约：应用 ID / 日志前缀 / 插件 ID）+ 产品代号也改。
历史治理资产（.agents/notes、.gov/tasks 文件名中的 m1-m5/phase-b/spike）**不改**——决策日志精神：地址不重编号。

## A. 路径与目录（Wave 1）

| 旧 | 新 | 理由 |
|---|---|---|
| runtime/spike/ | runtime/dsh/ | 它就是 DSH 运行时闭包 |
| hosts/android/app/src/main/assets/spike/ | …/assets/dsh/ | staged 镜像路径随 canonical |
| hosts/harmony/entry/src/main/resources/rawfile/spike/ | …/rawfile/dsh/ | 同上 |
| <filesDir>/spike-fs | <filesDir>/dsh-fs | app 作用域 fs 根 |
| <cacheDir>/spike（物化根） | <cacheDir>/dsh | 物化根路径 |
| liang/、echo/（未跟踪 scratch） | 删除 | 非仓库资产 |

## B. C ABI 与宿主文件/符号（Wave 2）

| 旧 | 新 | 理由 |
|---|---|---|
| dsh_spike_host.c/.h | dsh_runtime_host.c/.h | 可嵌入 C 运行时宿主 |
| dsh_spike_t / dsh_spike_new/eval/pump/free/complete/pass… | dsh_runtime_t / dsh_runtime_* | C ABI 族 |
| dsh_spike_jni.c（M1 场景生命周期桥） | dsh_jni_scenario.c | 按职责 |
| dsh_spike_m4.c（绑定相桥） | dsh_jni_binding.c | 按职责（SpikeHostM4 = 绑定相宿主） |
| dsh_spike_smoke.c/.h | dsh_gateway_smoke.c/.h | 与 harmony gateway_smoke.cpp 对齐 |
| SpikeHostM4.kt | BindingHost.kt | m4 里程碑码 → 职责名 |
| M4PagePump.kt | PagePump.kt | 同上 |
| g_m4_ctx / m4LastError / M4Bridge / startM4 | bindingCtx / bindingLastError / BindingBridge / startBinding | 同上 |
| SpikeRuntime.kt | JsRuntime.kt | 拥有 JS 串行线程的运行时（iOS SpikeRuntime.swift 同名改 JsRuntime.swift） |
| SpikeOutcome / SpikeLogSink / SpikeBundleStager / SpikeHostFactory | JsOutcome / RuntimeLogSink / BundleStager / CRuntimeFactory | 符号级 |
| CMake dsh-spike-* 目标 | dsh-runtime-* | 构建图 |
| m5（harmony 席内符号） | 随宿主职责命名 | 里程碑码清除 |

## C. 外部契约（Wave 3）

| 旧 | 新 | 波及 |
|---|---|---|
| com.dshmobile.spike | com.dshmobile.host | 34 处配置/CI + 设备需卸载重装 |
| dsh.spike.log: | dsh.runtime.log: | 139 个判定/工具文件 + 97 场景 manifest 期望行 + hilog tag |
| createLogger('m2.spike') | createLogger('dsh.scenario') | 11 个场景（manifest 若匹配 module 字段同步改） |
| cache/spike-fs 等设备路径 | cache/dsh-fs | runner 的 hdc/adb 路径 |

## D. 插件 ID 与代号（Wave 4）

| 旧 | 新 | 理由 |
|---|---|---|
| presentation/web-client-whale（id dsh-web-client-whale） | web-client-compact（id dsh-web-client-compact） | 整客户端换装证明件，代号→职责 |
| presentation/web-client-next（id dsh-web-client-next） | web-client-v2 | 时间性命名→代际命名 |
| runtime/spike/e2e-stage.js（迁至 runtime/dsh/） | credential-stage.js | 其职责是 LLM 凭据占位握手 |

## E. 文档与认知层（Wave 5）

- 双语文档全部随路径/符号更新（pairing 门 --write 再确认）。
- AOCI：文件移动 = 全量基线重扫（aoci scan）+ 大规模条目重撰写——独立收尾波次，体量≈重建索引的路径绑定。

## 不改清单（有语义或为历史地址）

- HostPhase.ets（相位机语义）、phase/marker 等；quickjs-boot-parse（CI 名，语义成立）
- .agents/notes/**、.gov/tasks/** 全部历史文件名；docs/decisions.md 的 D 编号
- vendor 包名（dsh-tests@… 等 upstream 身份）、third-party 子模块
- scenario id（boot.verification 等本就语义化）；已知语义良好的 Primitives/Carrier/Gateway 家族命名
