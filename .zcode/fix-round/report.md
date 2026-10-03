# 修复轮交付报告 — 2026-10-03(#324 / #323 / #321)

**材料范围**:本报告只整理本轮给定的三条缺陷修复记录、#324 合并后设备回归输出、#321 合并后全量测试尾,**未新跑任何测试**。唯一的补充内容是第五节 5.2 记录的一组只读 `git`/`ls` 核查(报告撰写会话内执行),用于裁定第三节设备回归结论的有效性。

---

## 一、结论

| 缺陷 | PR | 合并状态 | 修复内验证(合并前,记录内) | 设备/全量回归 |
|---|---|---|---|---|
| #324 Android 预设卡三张加载失败 | #325(`fix/324-from-issue`) | ✅ 已合并(origin/main `9989f0b`) | 全绿:vendored 健康检查 `VERDICT: zero broken`、panel 77/77、`gov run` 25 门、PR CI 4 项绿 | ⚠️ 执行为 **FAIL**,但经本报告只读核查,**回归所构建的 APK 不含该修复**(详见第三节)——不能据此判修复无效;设备侧健康状态实际**未验证** |
| #323 工具执行链无时限挂死 | #326(`fix/323-from-issue`) | ✅ 已合并(squash `57cd673`) | 全绿:panel 88/88、`gov run --base origin/main` 19 门、closures、PR 六项 CI 绿 | 未做(需真实 LLM 序列复现原 hang) |
| #321 raw vitest face Cannot find package | #327(`/tmp/fix-321` 工作树) | ✅ 已合并(origin/main `d3e13ea`) | 全绿:Cannot find 264→31、文件级 532→424 failed、第二轮 CI 六项绿、gov note check 222 ok | 合并后全量:**355 failed files / 241 failed tests**(数字与 issue 原始基线一致,见第四节) |

要点:

1. **三个 PR 全部按正门流程落地**:branch → push → PR → CI 绿 → squash 合并,三个 Agent Note 均已随 PR 进 main(经 `git ls-tree origin/main` 核实存在)。
2. **#324 不按"已修复"闭环**:合并后设备回归在四张预设卡上复现了与修复前逐字相同的 `@deepseek-ai/dsh-tool-present` 解析失败。但本报告只读核查证实,该回归 `./gradlew assembleRelease` 所在的主工作树 HEAD 停在 `d14680a`(先于 #325),树内 staged assets 缺 `tool-present@/tool-ralph@/tool-pwsh@`——即 APK 里根本没有修复的字节,失败是修复前树的必然输出(这反过来**佐证**了 #324 的根因链:缺 staged 字节 → 缺 marker → present 行 broken → 卡加载失败)。**#324 的设备侧验收仍是未决项**,下一步:把本地 main 同步到 origin/main(`d3e13ea`)后重建 release 包重跑同一回归。
3. **#323 的 JS 侧防护已完整合入**(每工具 120s deadline + 回合级 300s watchdog),但 wasm 同步自旋在 pinned wasm3 v0.9.0 下仍不可中断(需 wasm3 fork,owner 决策);设备侧真实 LLM 复现未做。
4. **#321 合并后全量数字与 issue 原始基线(241 failed / 355 files)逐字一致**,而 PR 作者环境内的 before/after 是 532→424 failed files;该尾输出未附 Cannot find package 计数,三组数字间的环境对应关系列为下轮核对项(见第四节)。

---

## 二、逐缺陷

### 1. #324 — Android stager 漏物化四个 shell-face 包,三张 Agent 预设卡加载失败

**PR 与合并状态**:分支 `fix/324-from-issue` → PR #325 → PR CI 全绿(gates、android-e2e、quickjs-boot-parse、ci-verdict 均 pass;run 37084990738 / 37084990736 / 37084990757)→ **已合并**(修复记录落笔时为"PR 已绿待 owner 合并",经本报告核查,origin/main 上 squash 提交为 `9989f0b`)。staged assets 以两段式提交(`6644d41` + `3892af5`,均在分支上)。

**根因**(给定记录整理):
- 健康判定链:vendored `dsh-agent-presets` 的 discovery 对每条将启动的行做解析检查(包行走 `packageInstalled` 的 node_modules 上行);三个宿主的 seed 规则(Android `AgentPresetsSeed.kt`、iOS drive、harmony `OfficialServe`、`gen-presets-seed.py` —— 同一条规则四次实现)只为 staged `vendor/dsh/*` 包写解析 marker(name 取自各包 package.json);seed 先经 `preset-mobile-rows.js` 禁用六条 mobile-absent 行。
- 用真 vendored `discoverPresets` + 真 `patchPresetSeedFiles` + 真 staged marker 集逐行判定:standard/ptc/cordis 三份各恰有一条未解析行 `row "present": @deepseek-ai/dsh-tool-present`;minimal 无此行所以健康——与 issue 观察完全一致。
- 追根:`@deepseek-ai/dsh-tool-present` 只在 `ensure-dsh.sh` 的 NPM_PACKAGES(npm face)有 pin,`vendor/dsh` 无树;android stager(`stage-spine-closure.sh`)没有 iOS embedder TREES 里那种 npm-face→`vendor/dsh` 相对路径块(`gen_bundle_header.py` 为 present/ralph/bash/pwsh 专设,注释明说 "the dir the preset-health marker seeder walks");harmony 的 `SPINE_PKG_DSH` 已含四个——**只有 android 漏了**。于是 seed 不写它的 marker,present 行必 broken,三张卡加载失败。

**改动**:
- `hosts/android/ci/stage-spine-closure.sh` 镜像 iOS 的 npm-face 块:新增 `stage_npm_face_at_dsh_path` / `verify_npm_face_at_dsh_path` 两个 helper,**手写按包调用**,保持 stager 的六个 for-in 清单不动——`gen-staging-manifests.mjs` 按内容分类且要求每类恰好 2 个 stage/verify 孪生,首版 for-in 循环被 CI tools-face 套件拒绝(这是该套件自己的 "refuse to guess" 契约)。
- 把 tool-present/tool-ralph/tool-bash/tool-pwsh 从各自 npm pin 物化到 `assets/spike/vendor/dsh/<pkg>@<ver>`(LICENSE + package.json + lib 去 `.d.ts`,stage_pkg 同款瘦身规则,缺 pin 时 die 响亮);check 腿对同四包按 npm pin 做字节同一性判定;staged 的 #170 时代 tool-bash 副本刷新为 npm pin 字节(同名同版本,marker 不变)。
- 回归腿 `test/panel/preset-health.test.js` 只读 tracked 输入(staged 预设文档、tracked staged marker 名、从 stager 脚本解析的显式清单并集——多行续行拼接、`dsh-` 前缀归一;js-yaml 走套件自带的 committed lockfile 依赖,CI 首跑抓到 import Gradle 物化的 staged 副本在 fresh checkout 缺失后改掉),断言 (a) seed patch 后四预设零 broken;(b) 原始文档中每条未解析行都属于 mobile-absent 补丁清单。
- Agent Note:`.agents/notes/implemented/bug-fix/2026-10-03-the-android-stager-carries-the-preset-sh.md`(Problem/Decision/Alternatives——否决了 dsh-face 双 pin(第三份字节)、seed 改走 npm 面(破坏诚实边界)、MOBILE_ABSENT 加 present 行(移动端真实携带该能力,属能力回退))。

**验证**(合并前,分支工作树内,记录声明全部真实跑过):
1. 真 vendored 健康检查(直接 import `agent-presets@0.1.6-alpha.2/lib` 的 `discoverPresets`)+ 真 `patchPresetSeedFiles`:修复前 staged 种子数据上输出 `BROKEN standard/ptc/cordis: row "present" … @deepseek-ai/dsh-tool-present; HEALTHY minimal`;修复后(marker 集 87,读 committed staged assets)`HEALTHY standard/ptc/minimal/cordis — VERDICT: zero broken`。
2. `bash test/panel/run.sh`:分支工作树与 fresh `git clone`(零物化,CI 等价态)均 5 文件 77/77 通过。
3. 有牙证明:临时移走 staged tool-present 目录 → 测试红并点名三卡的 present 行;还原 → 绿。
4. `gov run` 全量 scoped DAG 25/25 绿(closures 含新 check 腿、staging-check --block harmony,android,ios、bundle-files 953=953 双向、asset-mirrors、vendoring-repro、panel-tests、code-size——它真咬过 63 行函数,已拆、logging、verify-notes)。
5. `sh tools/test/run-tools-tests.sh` 本地 PASS。
6. `sh hosts/android/ci/stage-spine-closure.sh --check` 绿。
7. PR CI 全绿(见上)。

**遗留**:
- **设备回归(本轮执行)结果判读存疑**——FAIL 为真,但测的是未含修复的 APK,验收未决;需同步 origin/main 后重建重跑(第三节)。
- 真机验卡步骤已写入 PR 正文 Device verification 节(release 包、fresh install、四卡应全部可设默认、`agentPresets/list` 响应行无 broken 字段、Creator 可选)——即本轮执行并失效的那条回归。
- `runtime/spike/scenario/agent-presets-probe-seed.js`(生成物)只有 29 个 marker,落后于当前 61 条 DSH pin;陈旧早于本修复,无任何 CI 腿消费它(grep 过 gates/e2e/workflows);本次不 regen 以免无关巨量生成物 churn,建议单独跑一次 `python3 runtime/spike/ci/gen-presets-seed.py` 同步。
- govrail field feedback(记录内):(a) 摩擦——gates.json 的 25 门 DAG 不含 CI workflow 步骤里的 tools-face vitest 套件(`run-tools-tests.sh`),本地 `gov run` 25/25 绿但 CI 红在 gen-staging-manifests;gate 注册表与 workflow 步骤分叉,建议收编为 gate 或在 gates.json 标注 CI-only 面。(b) bundle-files 门在未物化 harmony rawfile 的工作树只打印 370 条 missing 行,不像 closures 门那样点名物化命令(`build/build.sh sync harmony`);建议错误首行带 remediation。(c) 表现好:code-size 咬真实违规、check 门对 staged 副本的 SKIP-with-reason 模型、note verify 的三段占位拒绝,均实际生效。

---

### 2. #323 — 工具执行链三层无时限,一个不返回的 await 挂死整个串行运行时

**PR 与合并状态**:分支 `fix/323-from-issue` → PR #326 → PR 六项 CI 全绿(gates 1m3s、android-e2e 3m30s、ios-e2e 8m42s、harmonyos-build、quickjs-boot-parse、ci-verdict,经 `gh pr checks --watch`)→ **已合并**,squash 为 main 上 `57cd673`(经本报告核查确认)。govrail 任务卡 T-0168 在 26 门 DAG 上关闭为绿。

**根因**(三层,给定记录整理):
1. vendored ToolRuntime 以裸 `await tool.execute(...)` 派发每个 native 工具体(`dsh-tools lib/index.js:3305`,dispatchToolBody)——per-definition `timeoutMs` 只验证不执行;vendored agent-loop 的 step/turn await 上也无超时;一个永不 settle 的工具体把循环永久挂起。
2. 在串行 QuickJS 运行时上,这一个挂起的 await 钉死一切——heartbeat、journal、page connection——即观察到的 T-0167 hang(CPU 146%,2.5 分钟字节相同的 minor fault,mux `connection lost`)。
3. native 层在 wasmRun 存在的宿主上有同样的洞:`runtime/spike/host/dsh_wasm.c:149` 把 `m3_CallV` 跑到完成、无 fuel cap,且 pinned wasm3 v0.9.0 不暴露任何中断 API(在 staged `wasm3/0.9.0/source` 头文件中核实)。值得注意:实际挂死的席位(Android)**没有注册 wasmRun handler**(GatewayCore PRIMITIVES 列了它但没有 Kotlin handler——调用快速 settle 为 `denied`),且其 fsRead 有尺寸上限(`FsPrimitives.kt` MAX_READ_BYTES 8MB),所以确切的自旋调用无法指名(release 构建剥掉 debug 日志,L4)——但"无守卫的 await 链"就是机制,模型发起的 wasm run 是在真正 serve wasmRun 的宿主上最合理的自旋者。

**改动**:移动席位上的两道 JS 看门环,挂载于 `upstream/boot.js`:
- **Ring 1 — `upstream/tool-deadline.js`**:`tools/execute` waterfall listener(ToolRuntime 自身的 around-dispatch 扩展点),经 vendored `@deepseek-ai/dsh-timeout` 的 `deadline()` 给**每一次** native 工具派发武装 120s 墙钟预算,fuse 进 exec.signal,使 cancellation-aware 的工具体经 upstream 自己的 signal 路径停下;预算耗尽在 registry 的 error-result 形状内**带内失败**(`error.info.code: 'tool/deadline'`),回合继续。
- **Ring 2 — `upstream/turn-watchdog.js`**:可重装定时器,由 session-journal append、assistant-stream 帧、agent-status 事件喂狗;运行中 agent 静默 300s 即带内失败该回合(`agent.cancel({kind:'watchdog'}, {keepInbox:true})`)。
- 配套:goal/command/file-reference/creation 四条 boot 行原样拆到 `upstream/boot-coverage-rows.js`(code-size 门);committed closures 重新 staging(Android assets 整目录镜像、HarmonyOS rawfile + SPINE_OURS/BUNDLE_FILES 行、iOS `gen_bundle_header.py` RESOURCES 行);Agent Note `.agents/notes/implemented/bug-fix/2026-10-03-tool-run-deadline.md`;T-0168 关闭绿。

**验证**(记录声明全部本会话真实跑过):
1. `bash test/panel/run.sh` — 6 文件 88 测试全过,含 ask 点名的回归(`test/panel/tool-deadline.test.js`:永不 resolve、以同步切片自旋的工具体在 150ms 预算下带内失败为 `tool/deadline`、预算内返回、工具体看到了 fused abort;watchdog silence/re-arm/idle 套件在 `turn-watchdog.test.js`)。
2. `gov run --base origin/main` — 19 门 19 过(logging、code-size、closures、bundle-files、staging-check、panel-tests、note-presence、vendoring-repro fresh-clone PASS 等)。
3. `sh build/check-closures.sh` — android + harmony 字节同一,ios 生成器绿。
4. `sh hosts/android/ci/stage-spine-closure.sh` 与 `hosts/harmony/ci/vendor-official.sh --closure-only` + `check-bundle-files.mjs` — 433 文件字节校验,956 条 BUNDLE_FILES 行双向一致。
5. PR CI 六项全绿(见上)。**未跑**:设备侧真实 LLM 复现原 hang——需要真实模型序列(mock 路由在 30 次 turn-soak 中从未复现)。

**遗留**:
- 设备侧回归:按 T-0167 turn-2 形状重放真实 LLM 序列(经 release 席位写并运行一个插件),确认 deadline/watchdog 带内失败并留结构化日志——需要 staged 真实凭据,排在下一个设备轮。
- **wasm3 fuel cap**:pinned v0.9.0 无中断/fuel API,D6 禁止改 vendored 副本——有界解释器需要 wasm3 fork(quickjs-fork 先例:owner 决策、新 pin、三份 C 构建)。在此之前,同步自旋的 wasm 模块在 iOS/CLI 上仍不可中断(JS 环在钉死的线程上无法触发——已在 Agent Note 与 PR 中如实记录)。
- Android 宿主在 GatewayCore.PRIMITIVES 列出 wasmRun 但未注册 handler:调用 fail `denied`(fail-loud-safe);诚实选项(注册 unavailable handler 或删该 primitive 行)超出本修复范围。
- govrail field feedback(记录内):`gov task tick` 需先 claim 才能改卡、`close` 要求卡已提交——但第 6 项("PR opened")在首次 push 前无法 tick,于是创建 PR 的那次 push 必然带着 open card,关闭只能搭第二次 push;tick 加 `--defer` 或 push 时对锚定项给宽限可消除循环。另 `gov change-scope` 对不碰 pin 的 diff 建议了 vendoring-repro(480s 网络门)——无害但使本地 pre-push 时间翻倍。

---

### 3. #321 — raw vitest face 大面积 Cannot find package(264 处 / 61 个 specifier)

**PR 与合并状态**:分支 `fix/321-from-issue`,工作树 `/tmp/fix-321`,commits `6b1c2f0` + `d17249e` + `2ff4e71` → PR #327 → 第二轮 CI 全绿(gates、ios-e2e、android-e2e、harmonyos-build、quickjs-boot-parse、ci-verdict)→ **已合并**(经本报告核查,origin/main squash 提交为 `d3e13ea`)。govrail 卡 T-0169 全部 ticked,exits 以记录原因 void(close 的 green-receipt 规则在工具链贫瘠工作树上不可满足:既有 self-test 红 + 8 个环境 skip——已用 stash diff 证明为既有)。

**根因**(链条,给定记录整理):raw vitest face 的 specs 位于 `runtime/spike/vendor/dsh-tests@tag/packages/*/*/tests`,裸 import 沿**真实祖先链**解析,链上唯一的 node_modules 是 `runtime/spike/vendor/node_modules`(parity-node-modules.sh)。该布局只链了 product closure faces 加少量 npm faces,于是:(1) 多数 test-face registry 包虽已 vendor 进 `vendor/npm/` 却从未链入链(js-yaml、@agentclientprotocol/sdk、chokidar、yaml、ws、typescript、eventsource-parser、@modelcontextprotocol/* 等);(2) 若干 face 从未 pin(test-face 的 js-yaml 4.3.1——只有 runtime 的 4.1.0、@deepseek-ai/node-addon-system、tsx+esbuild、undici 8.10.0、fast-check、execa、readable-stream、sharp、compression、cross-spawn、picomatch 4、@deepseek-ai/dsh、dsh-sandbox-windows-acl);(3) test-support vehicles 链在缩短名下(`@deepseek-ai/llm-replay`),无 importer 这样拼写;(4) jsdom 由 vitest 的 environment loader 向 `test/upstream-suite/node_modules` 索取但 manifest 里没有。逐包 major 冲突(chokidar ^4 vs ^5、readdirp、path-key 3 vs 4、negotiator 0.6 vs 1.1)与 sharp 的 DT_RPATH 无版本 @img 兄弟目录需要刻意的嵌套 staging。**不属本修复**(issue 的 module-shape 簇,按 ask 划出):`@deepseek-ai/dsh-*/src/*` 与 `*/invariant` 族失败,因 package self-reference 解析到抽出源码面的 package.json,其 exports 指向未构建的 lib/——run-from-source vs closure-face 语义问题。

**改动**:
1. `runtime/spike/vendor/ensure-dsh-tests.sh`:新的 dated pin 节,按 dsh-v0.1.6-alpha.2 pnpm-lock 解析 stage 每个缺失的 test face(sha256 锁定,镜像进 tracked `vendor/dsh-tarballs/`):js-yaml 4.3.1、picomatch 4.0.4、tsx 4.22.4 + esbuild 0.28.1 + linux x64/arm64 二进制、undici 8.10.0、fast-check 4.8.0 + pure-rand、execa 10.0.0 + 13 包传递闭包、readable-stream 4.7.0 + polyfill 闭包、sharp 0.35.3 + detect-libc/semver/@img/colour + glibc-linux @img 二进制、compression 1.8.1 + 闭包、cross-spawn 7.0.6 + 闭包、@deepseek-ai/node-addon-system 0.1.2 + 两个 glibc linux platform 包、@deepseek-ai/dsh 0.1.6-alpha.2、@deepseek-ai/dsh-sandbox-windows-acl 0.1.6-alpha.2;koffi/claude-agent-sdk/pi-ai 有意不 stage 并在脚本中点名。
2. `runtime/spike/ci/parity-node-modules.sh`:泛化循环按真实 package.json 名链接每个 vendored test face(product 链接优先;版本冲突响亮上报);vehicle 链接改真名(移除陈旧短名);刻意嵌套 staging:chokidar 4/5 按消费者分置 + 匹配的 readdirp major、compression 内嵌 negotiator 0.6.4、cross-spawn 内嵌 path-key 3.1.1、sharp 内嵌 @img 二进制外加 binding 的 DT_RPATH 期望的无版本 `@img/sharp-libvips-linux-*` 兄弟、node-addon-system platform 包内嵌入口;新增 `--parity-only` 旗标,使 parity differential 的解析面恰好等于 product links。
3. `run-upstream-parity.sh` 改传 `--parity-only`(第一轮 CI 回归了 ios-e2e:parity flow 从不物化 dsh-tests,而无条件 guard 在 macOS runner 上 exit 1——抓到、修掉、重跑绿)。
4. `test/upstream-suite/package.json` 声明 jsdom 29.1.1(vitest 从自己的树加载 environment)+ lockfile。
5. Agent Note `.agents/notes/implemented/bug-fix/2026-10-03-the-raw-upstream-suite-vitest-face-resol.md`(Problem/Decision/Alternatives/Consequences);T-0169 如上。

**验证**(全部在 /tmp/fix-321 真实跑过,before/after 用同一 vendor 物化:dsh-tests 以当前脚本重新物化,298 个 package.json;vendoring-repro 门从 fresh clone 重验新 pin):
- **BEFORE**(repo 根跑 `test/upstream-suite/node_modules/.bin/vitest run --config test/upstream-suite/vitest.config.ts`):Test Files **532 failed | 251 passed | 2 skipped (785)**;`Cannot find package` **264 处 / 61 个 specifier**(js-yaml 63、tsx 34、node-addon-system/flock 24、chokidar 16、jsdom 10、@agentclientprotocol/sdk 10、undici 9、landlock-run 9……)。
- **AFTER**(同命令):Test Files **424 failed | 366 passed | 5 skipped (795)**;Cannot find package **264→31**,每处残留已点名:~26 处 `@deepseek-ai/dsh-*/src/*` + `*/invariant` 源面族、1 处 koffi(tarball 只带源码)、1 处 tsx 在 webworker-runtime 的 transform-corpus worker 内。
- 代表子集(22 个 file/dir 过滤器覆盖每个修复簇,第二轮后):31 过 / 19 挂文件,唯一残留 Cannot-find 是 /src/* 族的 `dsh-subprocess-local/src/spawn.ts`;从 importer 目录的直接 node 解析探针全部 OK(chokidar 4 vs 5 按消费者、flock 经 staged platform 包、execa、readable-stream、sharp 原生经 staged @img 二进制加载、@deepseek-ai/dsh/package.json、compression、cross-spawn、tsx、undici、fast-check、typescript、eventsource-parser/stream、@noble/hashes/legacy.js)。
- PR #327 第二轮 CI 六项全 pass;`gov note check` 222 notes ok;`gov run` 唯一 blocking 失败是 self-test 的 bundle-files/staging-check rejection cases——以 stash diff 在 pristine base 上逐字复现(**既有漂移,非本改动**)。

**遗留**(followUps 全录):
- `@deepseek-ai/dsh-*/src/*.ts` 与 `*/invariant` Cannot-find 族(~26 处):package self-reference 解析到抽出源码面 package.json,其 `./invariant` 与 `./src/*` exports 期望上游构建好的 lib/——需要 raw face 的 run-from-source vs closure-face 决策(像上游 `tsc -b` 那样构建 workspace lib/,或把 face 链接指向源码);weekly-sweep 域(邻近 open 卡 T-0070)。
- koffi staging:published tarball 只带源码(无预编译 linux 二进制)——需要构建步骤或 per-OS face 决策;阻塞 `packages/host/directory-picker-native/tests/win32-dialog-bindings.spec.ts`(1 处 Cannot-find)。
- tsx ×1 残留在 `packages/experimental/webworker-runtime/tests/compile/transform-corpus.spec.ts`——vitest 日志里 importer 路径被截断,worker 内解析需单独分诊;weekly-sweep 域。
- 本 PR 未碰的既有门漂移(以 stash 在 pristine base 复现):bundle-files/staging-check 对 `vendor/npm/@earendil-works/pi-ai@0.85.1` dist 行 vs harmony Index.ets BUNDLE_FILES(陈旧行)为红,同时挂 self-test 的 rejection cases——归 vendor/BUNDLE_FILES 维护者。
- `test/upstream-suite/package.json` 引用了不存在的 runner `test/upstream-suite/run.sh`——raw face 仍无脚本化消费者(gov.yml 只跑 presentation+tools;weekly-sweep 跑转译 sweep);一个薄 run.sh(ensure-dsh-tests → npm ci → parity-node-modules.sh → vitest)可让该面可复现且 CI 可见。
- `@earendil-works/pi-ai` 与 `@anthropic-ai/claude-agent-sdk` 仍未 stage(AWS 尺寸依赖闭包 / peer 闭包)——其 spec 文件位于 issue 已知真实漂移桶;待那些桶分诊后再议。
- issue 自身基线(241 failed / 355 files)与 PR 作者 fresh-tree 基线(532 failed files)不一致——报告人环境无法重建;PR 内的 before/after 对自身一致,并已如此声明。
- govrail field feedback(记录内):(1) `gov note check` 拒绝路径参数(文档暗示可按单 note 查),只能树级;(2) `gov task check` 拒绝卡 id("unrecognized arguments")而 `gov task tick` 接受——表面不一致;(3) `gov task close` 要求全部门含环境条件门的绿凭据,在带既有红的工具链贫瘠工作树上即使工作完成也无法 close,`--force` 不可覆盖,void-with-reason 是唯一出口——scoped 模式 close("我 diff 范围内绿")更适合 fix-PR 流;(4) self-test rejection cases 报 "the restored tree still fails" 不区分既有门红与 case 缺陷——三条失败对本 PR 记名,却在 pristine base 上逐字复现。

---

## 三、设备回归(#324)结果

### 3.1 执行与观察(给定材料,原样整理)——**FAIL**

**步骤**(材料声明全部本会话执行):`adb devices` → emulator-5554 已 boot(`sys.boot_completed=1`)→ `cd /home/lx/dsh-mobile/hosts/android && ./gradlew assembleRelease --no-daemon -q` → `app-release-unsigned.apk` → apksigner(debug.keystore)签为 `/tmp/rel-signed.apk`(verify: CN=Android Debug,OK)→ `adb install -r` Success → `am start -W` LaunchState: COLD → Internal Testing Notice 点 Continue → Settings → 左滑 tab 到 Agent presets → 等待并复查,徽章持久非瞬态。

**观察**:
- 四张预设卡中 **Standard / PTC / Creator 三张**渲染红色 "Failed to load" 徽章(失败卡带红边框),错误均为 `row "present" names a plugin that cannot be resolved: @deepseek-ai/dsh-tool-present`;三卡 `actionChips: []`;Creator 卡 footer 只有复制图标、无任何动作芯片。**仅 Minimal mode 正常**(`hasFailedToLoad: false`)。
- CDP dump(webview_devtools_remote_6255 → Runtime.evaluate)逐卡证实上述;DOM 含 3 个 "Failed to load" 节点。
- logcat(10:12:24–10:13:17):CarrierAPIBridge `TRACE tryForward agentPresets/list: claimed=true` 反复——列表端点已被认领并转发,卡片仍渲染失败;仅有的 console 错误属无关端点(dynamicCordisRunner/syncInspectManifest、dynamicCordisRunner/inventory,Phase-B carrier 未实现)。
- 截图:`.zcode/fix-round/presets-1-standard-ptc.png`(Standard + 红徽章;PTC + 红徽章;Minimal 干净;Creator + 红徽章)与 `.zcode/fix-round/presets-2-minimal-creator.png`(近景:PTC/Creator "Failed to load"、Minimal 健康、Creator 无动作芯片、下方 CUSTOM 区)。

### 3.2 本报告会话的只读核查(补充证据,非给定材料)

**该回归构建 APK 所用的树不含 #325 修复。** 核查命令与输出(本会话执行,均只读):

| 核查 | 命令 | 结果 |
|---|---|---|
| 本地 HEAD | `git rev-parse HEAD` / `git log --oneline -3` | `d14680a`——先于三个 PR 的合并 |
| origin/main | `git log --oneline -8 origin/main` | 顶部即三个 squash 合并:`d3e13ea`(#327)→ `9989f0b`(#325)→ `57cd673`(#326),再往下才是 d14680a |
| #324 分支提交 | `git branch -a --contains 6644d41` | 仅 `fix/324-from-issue`(本地分支工作树)与 `remotes/origin/fix/324-from-issue`;**不在本地 main** |
| 本地树 staged assets | `ls hosts/android/app/src/main/assets/spike/vendor/dsh/` | **无** `tool-present@0.1.6-alpha.2`、**无** `tool-ralph@`、**无** `tool-pwsh@`(有 `tool-bash@0.1.6-alpha.2`——#170 时代副本;`dsh-agent-tool-presentation` 等是名字不同的别的包) |
| origin/main staged assets | `git ls-tree origin/main --name-only hosts/android/app/src/main/assets/spike/vendor/dsh/` | **含** `tool-present@0.1.6-alpha.2`、`tool-ralph@0.1.6-alpha.2`、`tool-pwsh@0.1.6-alpha.2`(即 #325 物化的字节在合并后的 main 上) |
| 会话起点快照 | (会话提供) | 同样显示 main@d14680a、`.zcode/fix-round/` 已存在——与本会话现场核查一致 |

材料中的回归步骤从 `adb devices` 直接开始到 `./gradlew assembleRelease`,**未含任何 git pull/checkout 步骤**;该树在回归执行时(截图时间戳 10:15/10:16)与本报告核查时同为 `d14680a`。

### 3.3 判定

- 回归观察到的失败(`row "present" … @deepseek-ai/dsh-tool-present` 不可解析、三卡挂、Minimal 健康)正是**修复前树的必然输出**,与 #324 根因链(缺 staged 字节 → seed 不写 marker → present 行 broken → 卡加载失败)逐环吻合——这次 FAIL **反而端到端佐证了根因诊断**。
- 但因此,该回归**不是对已合并 #325 的检验**:被测 APK 不含修复字节,不能据此判"修复在设备上无效"。#324 的设备侧验收状态为**未验证**。
- **下一步(建议的下轮动作)**:本地 main 同步到 origin/main(`git pull`,至 d3e13ea)→ 确认 `hosts/android/app/src/main/assets/spike/vendor/dsh/tool-present@0.1.6-alpha.2` 在树内 → 重建 release APK、fresh install,按 PR 正文 Device verification 节原步骤重跑;四卡应全部可设默认、`agentPresets/list` 响应行无 broken 字段、Creator 可选。

---

## 四、#321 合并后全量数字

合并后全量 vitest 跑(给定材料,尾输出原样):

```text
 Test Files  355 failed | 427 passed | 3 skipped (785)
      Tests  241 failed | 8376 passed | 64 skipped (8681)
     Errors  32 errors
   Start at  10:16:41
   Duration  205.42s (transform 13.21s, setup 0ms, import 33.03s, tests 88.08s, environment 45ms)
```

- **文件级**:355 failed / 427 passed / 3 skipped,计 785。
- **测试级**:241 failed / 8376 passed / 64 skipped,计 8681;另有 32 errors。
- **对照点一**:与 **issue #321 自身基线("241 failed / 355 files")两个维度逐字一致**。该尾输出未附 Cannot find package 计数,无法从尾输出判断残留构成;31 处已点名残留(~26 源面族 + 1 koffi + 1 worker 内 tsx)以 PR #327 记录为准。此一致性的含义(合并后环境是否等同于报告人环境、修复在该环境的净效果)尾输出本身不足以裁定,列为下轮核对项。
- **对照点二**:PR 作者 /tmp/fix-321 环境内 before/after 为 532→424 failed files(Cannot find 264→31);PR 已声明无法重建 issue 报告人环境,三组数字间的差异按环境差异记录。
- 耗时构成:import 33.03s + tests 88.08s 为主,总 205.42s。

---

## 五、证据索引

### 5.1 给定材料(本报告的整理对象)

1. #324 修复记录(branch/PR/merged、rootCause、fix、verification、followUps)。
2. #323 修复记录(同上,含 squash `57cd673`、T-0168 关闭绿)。
3. #321 修复记录(/tmp/fix-321 三 commits、before/after 全量数字、T-0169、followUps、govrail feedback)。
4. #324 设备回归输出(FAIL、步骤、CDP dump、logcat、两张截图路径)。
5. #321 合并后全量尾输出(第四节原样引用)。

### 5.2 本报告会话的只读核查(命令与关键输出)

全部为 `git`/`ls`/`find` 只读命令,未跑任何测试、未改任何工作树:

- `git rev-parse HEAD` → `d14680a`;`git log --oneline -3`(d14680a / 90779cc / 9961075)。
- `git log --oneline -8 origin/main` → `d3e13ea`(#327)、`9989f0b`(#325)、`57cd673`(#326)在 d14680a 之上。
- `git branch -a --contains 6644d41` → 仅 `fix/324-from-issue` 与其 remote 跟踪分支。
- `ls hosts/android/app/src/main/assets/spike/vendor/dsh/` → 本地树无 `tool-present@/tool-ralph@/tool-pwsh@`;`git ls-tree origin/main --name-only <同目录>` → origin/main 含三者。
- `git ls-tree -r origin/main --name-only .agents/notes/implemented/bug-fix/ | grep 2026-10-03` → 三份 Note 均在 origin/main;本地 notes 目录最新为 2026-10-02(本地树陈旧的旁证)。
- `ls -la .zcode/fix-round/` → `presets-1-standard-ptc.png`(215989 B, 10:15)、`presets-2-minimal-creator.png`(187997 B, 10:16)存在。
- `find hosts/android -type d -name '*tool-present*'` → 仅命中 `dsh-agent-tool-presentation@0.1.6-alpha.2`(名字不同的包)及其 build/intermediates 副本——无 staged `tool-present@`。

### 5.3 提交、产物与路径

- **PR**:#325(#324,squash `9989f0b`)、#326(#323,squash `57cd673`)、#327(#321,squash `d3e13ea`);分支 `fix/324-from-issue`、`fix/323-from-issue`、`fix/321-from-issue`;#324 分支内两段式 staged 提交 `6644d41` + `3892af5`;#321 分支内 `6b1c2f0` + `d17249e` + `2ff4e71`。
- **CI runs**:#325 → 37084990738 / 37084990736 / 37084990757;#326 六项 checks(gates 1m3s、android-e2e 3m30s、ios-e2e 8m42s、harmonyos-build、quickjs-boot-parse、ci-verdict);#327 第二轮六项全 pass。
- **Agent Notes**(均在 origin/main):`.agents/notes/implemented/bug-fix/2026-10-03-the-android-stager-carries-the-preset-sh.md`、`2026-10-03-tool-run-deadline.md`、`2026-10-03-the-raw-upstream-suite-vitest-face-resol.md`。
- **govrail 任务卡**:T-0168 关闭绿(26 门 DAG);T-0169 全部 ticked、exits void-with-reason。
- **设备回归截图**:`.zcode/fix-round/presets-1-standard-ptc.png`、`.zcode/fix-round/presets-2-minimal-creator.png`。
- **代码引用**(来自记录):`dsh-tools lib/index.js:3305`(裸 await 派发)、`runtime/spike/host/dsh_wasm.c:149`(m3_CallV 无 fuel cap)、`hosts/android/ci/stage-spine-closure.sh`(npm-face helper)、`upstream/tool-deadline.js`、`upstream/turn-watchdog.js`、`upstream/boot-coverage-rows.js`、`test/panel/tool-deadline.test.js`、`test/panel/preset-health.test.js`、`runtime/spike/vendor/ensure-dsh-tests.sh`、`runtime/spike/ci/parity-node-modules.sh`。

---

*报告撰写说明:本文为纯整理件。凡标注"给定材料/记录内"的内容均转录自本轮 ask 提供的记录,撰写者未复跑其中任何验证;5.2 节为本撰写会话唯一新增的核查动作。两处与材料表面结论相悖的判定(#324 设备回归的有效性、#321 全量数字与基线的一致性含义)均已按证据如实标注,未作臆测填充。*
