# 安全威胁模型——对抗证据网

[English](security-threat-model.md) | 简体中文

护城河不是"我们有一个沙箱"。没人攻击过的沙箱主张只是散文,散文拦不住
回归。本文盘点这套架构暴露的敌意面、每面今天的一句话防线,以及攻击它的
对抗腿——每条腿都是可重跑的提交在库的证据跑批,拒绝记录由检查器一对一
钉住。打进来了的攻击就是**发现**,按真实严重度记录在此,绝不用散文消化。

各腿都在库内,在最便宜的宿主(macOS CLI)上即可重跑:
[security.gateway-fuzz](../runtime/spike/ci/run-security-gateway-fuzz.sh) ·
[security.jail](../runtime/spike/ci/run-security-jail.sh) ·
[security.manifest-forgery](../runtime/spike/ci/run-security-manifest-forgery.sh) ·
[security.byok-leak](../runtime/spike/ci/run-security-byok-leak.sh)。

## 对手模型

我们防御的攻击者(每面取其中最强假设):

- **敌意插件**——运行时内执行任意 JS(市场威胁:任何过了安装管线的包),
  可以拿着任意字节直接打裸 `__dshGatewayCall` 缝,绕过一切类型化 shim。
- **敌意镜像**——掌握市场宿主的字节(目录与包 URL 上的任意内容),包括
  发布者曾经合法签过的过期内容。
- **Kerckhoffs 原则**——本仓库的一切,包括各腿里的全部攻击手法,都视为
  攻击者已知;密钥是唯一的秘密,生产签名密钥从不进这个仓库。

明确不覆盖(如实点名,不藏):操作系统级失陷、从 OS 钥匙串(SecItem/
Keystore)或签名 CI 提取凭据、对 C 解释器本体(quickjs-ng、wasm3)的
内存破坏攻击(fuzz 电池止步于校验面,jail 腿断言的是解释器会陷阱而非
C 不可利用)、侧信道。

## 各威胁面

### 1. gateway 校验面

**现有防线**:每个原语在宿主边界校验参数,以冻结的契约 §3 词汇作答——
`invalid`(畸形)、`denied`(宿主从未授予的 scope)、`unavailable`(本
宿主不服务的原语)——fail loud,绝不默认放行;拒绝是结构化的,不是崩溃
([runtime/spike/host/main_cli.c](../runtime/spike/host/main_cli.c) 冒烟
后端的逐原语校验)。

**本腿怎么攻**:[security.gateway-fuzz](../runtime/spike/ci/run-security-gateway-fuzz.sh)
拿 21 案例电池打裸缝——错型、缺字段、`..` 与绝对路径逃逸、未知 scope
(含大小写与错名)、1MB 路径、超长钥匙串 ref、负数/缺失的定时器边界、
三个必须不存在的原语名、两个畸形 args JSON、两个越界 socket 目标——
逐案例要求结构化拒绝,外加电池之后的良性往返(进程存活)。证据:
`runtime/spike/artifacts/macos-cli-security-gateway-fuzz/`(21/21 全拒;
两起 socket 攻击各留固定 reason 码的审计)。

### 2. 市场供应链——签名目录

**现有防线**:目录签名即信任(data-protocols §7.1)——对摘要做
canonical-JSON ed25519,密钥带外钉扎,§7.2 双签窗口轮换,签名信任记录
原样传给未改动的安装器——被篡改的宿主因此永远造不出可安装的包。

**怎么攻(引用,不重复造)**:§7.1 篡改阶梯已落在 `marketplace.install`
腿里——坏签名、自洽的攻击者目录(信任在钉扎不在文档)、诚实目录背后
翻转字节的敌意镜像、诚实重签的发布方元数据错误。四级阶梯,每级
`InstallRejected` + 审计 + 零暂存
([run-marketplace-install-e2e.sh](../runtime/spike/ci/run-marketplace-install-e2e.sh),
证据 `runtime/spike/artifacts/macos-cli-marketplace-install/`)。

### 3. 市场供应链——目录新鲜度(**HIGH 发现,未闭合**)

**现有防线**:客户端侧没有。钉扎锚定的是签名密钥而非纪元;`generatedAt`
只验存在([runtime/spike/marketplace.js](../runtime/spike/marketplace.js));
管线拿到的信任记录锚定字节——而一份重放的旧目录自带内部一致、签名正确
的信任记录。

**本腿怎么攻——即发现**:[security.manifest-forgery](../runtime/spike/ci/run-security-manifest-forgery.sh)
重放一份过期但**签名有效**的目录(由在库发布工具在测试钉扎下诚实签出的
旧索引——敌意镜像提供发布者曾发布过内容的模型)。**重放装进来了**:
`dsh-echo@0.9.0` 经 resolver 落地,收据、暂存树俱全
(`"event":"forge.rollback.catalog","outcome":"installed","version":"0.9.0"`,
证据 `runtime/spike/artifacts/macos-cli-security-manifest-forgery/`)。
在本架构自设的对手模型内严重度 HIGH(敌意镜像天然在范围内——目录签名
本就是为此而生)。已命名后续:客户端新鲜度锚——单调 `generatedAt` 下限
或进钉扎的发布纪元;落地该防护的同一变更里,本腿钉住的期望翻转为
`rejected`。在此之前,这条腿把缺口按可回归观察的事实如实敞着。

### 4. QuickJS 沙箱(无原生面)

**现有防线**:运行时是单条串行 QuickJS 线程,无子进程、无线程逃逸(D2);
JS 侧不存在原生 FFI 面——一切能力穿越都是 gateway 调用,因此校验面
(威胁面 1)就是 JS 内视角下的全部攻击面;模块代码从不以宿主特权执行。

**怎么攻**:`security.gateway-fuzz` 的裸缝电池就是来自内部的攻击
(JS 能做的最强的事就是打这条缝);`unknown.spawn` / `unknown.fschmod`
两档钉住"连可点名的子进程/授权原语都不存在"。缝之外无原生面可 fuzz——
这本身就是本腿要守住的诚实主张。

### 5. wasm jail

**现有防线**:wasm 模块在进程内解释执行(vendored wasm3,契约 v1.2.0
`wasmRun`),它唯一的宿主回调是被导入的 `dsh.emit(ptr, len)`;导入其他
任何东西的模块无可链接之物,越出模块内存的 emit 在宿主侧边界检查处陷阱,
解释器级失败(坏解析、缺导出、栈耗尽)一律是结构化 `io` 拒绝
([dsh_wasm.c](../runtime/spike/host/dsh_wasm.c))。CLI 经由与 iOS 应用
同源的可移植 spine 服务该面,jail 因此在最便宜的宿主上可被攻击。

**本腿怎么攻**:[security.jail](../runtime/spike/ci/run-security-jail.sh)
投喂手工构造的模块:被调用的敌意导入(`env.evil`——无可链接)、用错误
签名冒用 `dsh.emit` 之名(链接拒绝)、越过内存的 emit 指针(边界陷阱)、
无限递归(栈陷阱)、缺失导出、缺失模块、逃逸路径、未授予 scope——
8/8 全拒,且诚实 echo 模块在电池前后各跑一次(jail 服务守规调用者;
进程存活)。证据:`runtime/spike/artifacts/macos-cli-security-jail/`。

### 6. socket 缝的回环边界

**现有防线**:审计过的仅回环 TCP(契约 v1.8.0 五规则模型)——最窄 scope
默认、只有字面量 `127.0.0.1` 可拨、每次 listen/connect/accept 一条结构化
审计记录且 reason 码固定(攻击者可控文本永不进审计 JSON)。

**本腿怎么攻**:`security.jail` 的 socket 电池向边界外四个目标拨号——
IPv6 回环 `::1`、未指定地址 `0.0.0.0`、名字 `localhost`、回环相邻的
`127.0.0.2`——外加一次 mesh scope 监听与一次不带 scope 的监听:6/6
`denied`,每条都审计(`host-not-loopback=4`、`scope-not-loopback=2`);
`security.gateway-fuzz` 再叠加一次 lan 监听与一次 `169.254.169.254`
元数据服务拨号。元数据拨号是关键:能摸到它的插件就能收割云凭据——
它在 serve 层被拒并留审计。

### 7. 能力授权与审计

**现有防线**:安装期协商(data-protocols §2)——`capabilities.required`
逐项对照宿主描述符,在任何解包之前 fail loud;运行期每个过授权检查的
调用(socket 缝)与每一次拒绝(本证据网全体)都落一条固定词汇的结构化
审计记录。

**本腿怎么攻**:[security.manifest-forgery](../runtime/spike/ci/run-security-manifest-forgery.sh)
把清单的能力要求两级抬升——越过过期信任记录(`integrity`,锚先于协商
抓到篡改)与完全重算的信任(`capability`,协商面拒绝连自洽字节也买不到
的东西:宿主不提供 `notify@2`)。管线各档同时钉住 id 锚与每次拒绝后的
零暂存(无 `.staging-<tx>/` 树、无 journal 行——事务从未到达提交点)。

### 8. BYOK 凭据流

**现有防线**:凭据只进钥匙串(冻结的 `keychainSet`/`keychainGet`,契约
v1.0.0 第 8–9 行),单一 ref,绝不落明文文件;路由解析是唯一读取它的家
([upstream/llm-route.js](../runtime/spike/upstream/llm-route.js));llm.js
从不记录 header 或 body——密钥只乘 Authorization header 走网络;凭据值
从不回传(写面自己的规则)。

**本腿怎么攻**:[security.byok-leak](../runtime/spike/ci/run-security-byok-leak.sh)
让金丝雀走过保存、重启路由解析、一次真实传输回合与 401 错误面——在运行
时内断言错误消息既不含金丝雀也不含另一个错钥探针值——随后 runner 审计
裸日志里两个值都不得出现,且审计前先证明匹配器对播种行会命中(不能命中
的 grep 是不能抓漏的审计)。截屏捕获没有运行时面(那是宿主/OS 侧);代码
能触及的泄漏面——日志、错误消息、路由事实——正是本腿审计的对象;共享
mock 现在接受本腿金丝雀作为期望 bearer,让真实值走上网络。证据:
`runtime/spike/artifacts/macos-cli-security-byok-leak/`。

## 腿登记表

| 腿 | 场景 id | 检查器 | 证据目录 | 拦哪类回归 |
| --- | --- | --- | --- | --- |
| gateway fuzz | `security.gateway-fuzz` | [security-gateway-fuzz.json](../test/e2e/scenarios/security-gateway-fuzz.json) | `runtime/spike/artifacts/macos-cli-security-gateway-fuzz/` | 原语停止校验(攻击案例得手,或拒绝码漂移) |
| jail(wasm+socket) | `security.jail` | [security-jail.json](../test/e2e/scenarios/security-jail.json) | `runtime/spike/artifacts/macos-cli-security-jail/` | wasm 导入面变宽、emit 边界检查缺失、回环边界漏风 |
| 清单伪造 | `security.manifest-forgery` | [security-manifest-forgery.json](../test/e2e/scenarios/security-manifest-forgery.json) | `runtime/spike/artifacts/macos-cli-security-manifest-forgery/` | 管线锚/协商变弱——以及(钉住,直到新鲜度防护落地)重放档如实记录今天的 HIGH 缺口 |
| BYOK 泄漏 | `security.byok-leak` | [security-byok-leak.json](../test/e2e/scenarios/security-byok-leak.json) | `runtime/spike/artifacts/macos-cli-security-byok-leak/` | 凭据值摸到任何日志汇,或错误面回显秘密 |

## 维护契约

- 新攻击手法 = 新档:场景里加一个案例、检查器加一行、证据重跑一次——
  绝不写成散文主张。
- 防护落地在同一变更里主动翻转钉住的期望(新鲜度档就是为这次翻转写的)。
- 每条腿保有自己的反证(规则 6):fuzz/jail 各档在攻击**得手**时失败;
  byok 审计在相信自己的绿灯之前,先对播种泄漏证明匹配器会命中。
