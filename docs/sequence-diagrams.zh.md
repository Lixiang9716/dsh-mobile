# 时序图 —— 全流程端到端

[English](sequence-diagrams.md) | 简体中文

构成 dsh-mobile 的十个流程，全部以时序图呈现。参与者即架构的五层
（ARCHITECTURE.md §2）：**UI**（渲染 Web Client 的 WebView）、**carrier**
（应用内回环 HTTP/WS 服务）、**spine**（承载 vendored 上游 DSH 核心的
QuickJS 运行时，单一串行线程）、**网关**（冻结的原语表 + 审计）、
**原生特权层**（Swift / Kotlin / ArkTS+NAPI）。每张图同时标注结构化日志
记录落在哪里——它们正是 e2e 校验器断言的证据。

## 1. 应用启动与官方 Web 客户端挂载

```mermaid
sequenceDiagram
    participant U as 用户
    participant N as 原生壳 (SwiftUI/Compose/ArkUI)
    participant H as C 宿主 + QuickJS spine
    participant S as Spine (boot.js → DSH 核心)
    participant C as Carrier (回环 HTTP/WS)
    participant W as WebView (官方 Web Client)

    U->>N: 启动应用
    N->>H: dsh_spike_new_declaring (bundle root)
    Note over H: 声明 launch env（host.launch 记录；<br/>iOS 附带 DSH_ISH_ROOTFS）
    N->>H: eval(upstream/boot.js)
    S->>S: 移动 profile 引导：cordis 分层<br/>(dsh-base → 宿主面 → profile)
    S-->>N: runtime.created / gateway.negotiated（日志）
    N->>C: 在 127.0.0.1:<port> 启动 carrier
    S->>S: web-boot 组合官方 client-modules<br/>(facade 队列 → __DSH_BOOT__ 线协议)
    S->>C: web.boot / api.claim / mux.claim（总线接缝）
    N->>W: 加载 http://127.0.0.1:<port>
    W->>C: GET /（官方 dist）
    C-->>W: index + 懒加载 /plugins bundles
    W->>C: WS 连接（mux）
    C-->>W: token 增量 / journal 帧
    W-->>U: 应用渲染（官方 UI，实时会话）
```

证据：`boot.verification`（7 事件）、`officialweb.mount`（14 事件）、
`hosts/<p>/artifacts/` 下各阶段截图。

## 2. 一次网关原语调用（以 fsWrite 为例）

```mermaid
sequenceDiagram
    participant P as JS 插件 / 场景
    participant G as 网关 (gateway.js)
    participant N as 原生特权层
    participant A as 审计日志
    participant Q as 运行时串行队列

    P->>G: fsWrite(scope, path, bytes)
    G->>G: 权限检查 + 类型化签名
    alt 拒绝
        G-->>P: 结构化拒绝（权限）
        G->>A: audit{primitive, denied}
    else 允许
        G->>Q: 派发事件
        Q->>N: 原语调用（串行线程上）
        N->>N: 执行（Keychain / SAF / HUKS / 文件）
        N-->>Q: 结果
        Q-->>G: 完成事件
        G->>A: audit{primitive, outcome, bytes}
        G-->>P: 结果（或结构化错误）
    end
    Note over G,A: 每次调用 = 一条审计记录；<br/>审计流本身就是一个场景（gateway.audit）
```

## 3. 能力协商（RuntimeDescriptor）

```mermaid
sequenceDiagram
    participant S as Spine 引导
    participant D as RuntimeDescriptor
    participant N as 原生宿主
    participant P as 插件（manifest）

    N->>D: available[] / unavailable[]（九+ 原语）
    S->>D: 读取描述符
    P->>S: manifest：required / optional 能力
    S->>S: required ⊆ available？
    alt 缺必需
        S--xP: 解包/加载之前即拒绝（安装时同样）
    else 满足
        S->>P: 加载插件
        P->>S: 探测可选面（诚实地失败）
    end
    Note over S,P: 运行时代码没有任何 hostType 分支——<br/>描述符本身就是平台差异<br/>(ishRun：iOS 可用 / 其余不可用)
```

## 4. 实时 LLM 流式会话

```mermaid
sequenceDiagram
    participant U as 用户
    participant W as WebView（composer）
    participant C as Carrier
    participant S as Spine (agent-loop → dsh-llm)
    participant G as 网关
    participant N as 原生 (httpFetch)
    participant L as LLM 后端（OpenAI 兼容）

    U->>W: 输入并发送
    W->>C: POST /api/session/prompt
    C->>S: session/prompt（mux）
    S->>S: agent-loop 轮次；会话 journal 追加
    S->>G: httpFetch(stream, SSE)
    G->>N: 原语调用
    N->>L: HTTPS 请求（密钥出自密封存储）
    loop 每个 SSE 块
        L-->>N: 增量（推理/正文）
        N-->>G: body 块事件
        G-->>S: 块
        S->>C: ws.token-delta {index}
        C-->>W: WS 帧
        W-->>U: token 流式渲染
    end
    L-->>N: [DONE]
    S->>C: ws.session-complete
    S-->>S: journal 提交；对每行日志做密钥泄露审计
```

证据：`llm.live-stream`（含 `.device` 腿）：服务模型逐字记录、推理+正文
为事件序列、密钥泄露审计被断言。

## 5. 会话持久化与恢复

```mermaid
sequenceDiagram
    participant S as Spine
    participant F as fs 原语
    participant J as Journal（追加式 JSONL）
    participant K as 检查点（事件队列排空）

    S->>J: 追加记录（用户/助手/工具）
    J->>F: 写 sessions/<id>.jsonl
    Note over S,K: 检查点 = 事件队列排空<br/>（自然的安静点，不是特例）
    S->>K: 持久化检查点状态
    Note over S,K: 挂起冻结、内存压力杀死——<br/>journal 存活，活体运行时不存活
    S->>S: 回前台：重连（client-connection<br/>重连语义）+ 从检查点恢复
    S->>J: session.list / journal 读回
```

## 6. 插件安装即回执事务

```mermaid
sequenceDiagram
    participant S as 安装管线 (install-pipeline.js)
    participant B as Blob 存储 (cache/blobs/<sha256>)
    participant T as 信任记录 + manifest 校验
    participant P as 暂存 (plugins/<pkg>@<semver>)
    participant R as 回执 journal（追加式）

    S->>B: tgz 字节 → 内容寻址存储
    B-->>S: 摘要匹配？（不匹配 = 解包前拒绝）
    S->>T: 校验信任 + 严格 manifest + 能力协商
    alt 篡改或权限不足
        T--xS: 拒绝（未解包任何东西）
        S->>R: pending 回执 → 回滚态
    else 通过
        S->>P: 暂存完整性读回
        P-->>S: 字节校验
        S->>R: 回执 COMMIT
        Note over R: 启动重放：staged-verifies → committed；<br/>staging-incomplete → 回滚
    end
```

证据：`install.verified-tarball`（22/22）、`install.full-cycle`（41/41）、
`install.from-http`（46/46）。

## 7. ishRun —— 模拟用户land，含每次引导完整性校验

```mermaid
sequenceDiagram
    participant P as Shell 插件 (dsh-shell-ish)
    participant G as 网关 (ishRun)
    participant H as 宿主 (dsh_ish)
    participant V as 校验器 (dsh_ish_verify)【新增】
    participant E as iSH 引擎（进程内）
    participant G2 as Guest Alpine 用户land

    Note over H,V: 暂存：rootfs 解出 →<br/>封印 manifest（<rootfs>.manifest，逐条 sha256）
    P->>G: ishRun(command)
    G->>H: 引导 guest（引导锁内）
    H->>V: 校验 staged 树 vs manifest
    alt 摘要不匹配（篡改/半写）
        V--xH: 拒绝（点名 expected 与 actual）
        H-->>G: 结构化错误 → 审计
    else 通过（热态约 25ms）
        H->>E: 引导（实测 41–79ms）
        E->>G2: 执行命令（guest init 的子进程）
        G2-->>E: stdout/stderr/退出码（经 zombie）
        E-->>H: 结果
        H-->>G: {exitCode, stdout}
        G-->>P: 结果 + 审计记录
    end
    Note over H,V: guest 的新增文件容忍并计数<br/>（契约：安装持久化）；<br/>apk upgrade 替换钉版成员 → 下次引导拒绝
```

证据：`userland.shell`（11/11 + 交付物摘要），以及 `run-ish-local.sh`
中新增的篡改拒绝案例。

## 8. 设置面板 —— 预设与插件清单

```mermaid
sequenceDiagram
    participant W as WebView（设置面板）
    participant C as Carrier (/api)
    participant S as Spine (Loader 服务 + agent-presets)
    participant F as fs（staged 预设 VFS）

    Note over S: 一个 cordis Loader 同时服务预设遍历<br/>与客户端组合（装饰而非复制）
    W->>C: GET /api agentPresets/list
    C->>S: agentPresets/list
    S->>F: 遍历 presets/**（vendored 树）
    F-->>S: roster（yaml → js-yaml）
    S-->>C: roster
    C-->>W: 预设渲染（未实现的 copy/deletePreset<br/>以只读方式诚实拒绝）
    W->>C: GET pluginInventory/list
    S-->>C: 挂载的 spine + 已暂存 client bundles + 组合
    C-->>W: 清单快照（只读）
```

证据：`settings.surfaces`（CLI，一对一）。

## 9. E2E 验证 —— 日志而非截图

```mermaid
sequenceDiagram
    participant R as Runner (run-*.sh)
    participant A as 设备/模拟器上的应用
    participant L as 结构化日志流 (dsh.spike.log:)
    participant X as check.mjs
    participant M as 证据目录 (artifacts/)

    R->>A: 安装 + 启动（恰好一次）
    A->>L: 每事件一条信封记录<br/>{scenario, event, ...}
    R->>R: 流截断于第一个完成标记
    R->>X: manifest(scenario.json) + 捕获日志
    X->>X: 逐行：前缀 → JSON.parse → 按场景 id 过滤
    X->>X: 一对一有序游走（缺失/多余/解析错误皆失败）
    X-->>R: verdict {pass, expected, logged, failures[]}
    R->>M: 日志 + scenario.jsonl + verdict + 截图（仅给人看）
    Note over X,M: 失败报告即诊断；<br/>溯源绑定 runId（CI 拒绝过期判决）
```

## 10. 构建门面

```mermaid
sequenceDiagram
    participant D as 开发者
    participant B as build/build.sh
    participant SY as sync（闭包暂存）
    participant CO as compile（平台工具链）
    participant TE as test（日志校验 e2e）
    participant GA as gov 门禁（含 closures）

    D->>B: build/build.sh android [harmony…]
    B->>SY: 从 runtime/spike 重暂存已提交副本
    SY-->>B: 逐字节一致（暂存器自校验）
    B->>CO: 精确 CI 命令（gradlew / xcodebuild / hvigorw）
    CO-->>B: 应用构建完成
    B->>TE: 平台 e2e 腿
    TE-->>B: 一对一判决全绿
    Note over GA: 独立地，`build.sh check` / closures 门禁<br/>逐字节核对已提交副本 vs 规范源——<br/>漂移即响亮失败并点名文件
```

## 阅读指南

- 流程 1–8 是运行时行为；9–10 是让它们保持诚实的验证与构建机制。
- 每条"日志"注记都是校验器可断言的真实记录；每张图至少对应
  ARCHITECTURE.md §10 验证阶段表中的一个具名场景。
- 唯一刻意的平台不对称（流程 7）经协商表达，绝无分支。
