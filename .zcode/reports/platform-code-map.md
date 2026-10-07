# 平台公共代码地图（platform-code-map）

生成：2026-10-06 · 仓库：dsh-mobile（worktree `D:\workspace\dsh-mobile`，main）· 修订：r2（按审阅意见逐条修订，见各节"口径"标注）

证据标注（每条结论按此分级）：

- **【实跑】**= 本报告会话在仓库内实际执行的命令或读取，命令原文与输出见 §3.3 与各行内注；
- **【复核】**= 随任务下发的独立复核轮的**结论**（该轮含 grep/读码/实跑证据）。**可回查性声明**：该轮的命令与输出记录在复核轮自身的记录里、未随本报告复制，因此复核级证据无法从本报告独立重放——读者只能信任其结论。凡承重结论（原语矩阵、独有性判定），本报告已尽量用【实跑】复核过一遍；未能升级的条目在 §5.2 状态列单独标注；
- **【调查】**= 仅调查材料引用（unconfirmed，本次未复核）。

**并发修改警告**：本会话测量期间工作区在被并行推进（`git status` 显示 `ci/run-upstream-suite.sh`、`entry/build-profile.json5`、`Index.ets` 有未提交修改，`artifacts/upstream-suite/` 与 rawfile 的 10 个 shims 副本为未跟踪新文件；rawfile/spike 磁盘总文件数在会话内两次测量间从 1359 增至 2007——suite extras 在被物化）。凡计数字样均为**其标注时点的快照**，用于说明层级关系，不是审计数字；受影响的稳定不变量单独注明（§3.3）。

---

## 1. 一页结论

1. **公共代码的权威源是 `runtime/spike`**：平台无关 JS 运行时闭包（logger/gateway/llm/scenario/安装管线/纯函数 codecs/upstream shims/vendor pins）+ 平台无关 C 宿主（`runtime/spike/host/dsh_spike_host.c` 等）。`build/build.sh sync <platform>` 以它为 single source 重落地各平台（build/build.sh:7-8、:107-126，实读）。`contract/` 是冻结契约（spec 消费，无代码导入）；`system-plugins/`、`presentation/` 由同一批 stager 镜像；`build/`、`test/` 是共享构建与判定设施。桌面 CLI（`main_cli.c`）是直接消费 canonical 的第四席位。
2. **三平台落地形态各不相同**：Android = 已提交 assets 字节拷贝（`stage-spine-closure.sh`）；Harmony = 已提交 rawfile 字节拷贝（`vendor-official.sh --closure-only`）；iOS = 确定性生成 C 字节数组编译进二进制、生成物不入库（D9 flip，build/check-closures.sh:17-32 实读）。
3. **当前一致性（本次实跑，工作区状态，两轮复测输出逐字一致）**：android 闭包检查 exit 0（313 个 untracked-but-staged 跳过）；harmony 闭包检查 exit 0（177 个 untracked-but-closure 跳过——**其中含在途的 10 个 shims 副本，即这 10 个文件未被本次逐文件 cmp 字节验证**，见 §3.3 口径③）；harmony BUNDLE_FILES 守卫 exit 0（1083=1083 双向，两轮不变）；web-client 资产镜像比对 ok（next 16/16、whale 4/4）；logging 门 774 文件 0 违规。**iOS 生成腿未跑**——脚本无只读模式（§3.3 口径⑥、§6.1），iOS freshness 主张本次未验证。
4. **任务附带的哈希对比（harmony：1349 extra / canonicalFiles=0）不可解读为漂移**：canonical 侧枚举数为 0（canonical 树实有 1480 个 tracked 文件，`git ls-files runtime/spike | wc -l` 实测），diff=0 / missing=0 也说明逐文件比对没有发生；"extra" 中可分类的部分全部是同步机制允许的构成差异（officialweb/、webclient/、upstream-tests/ 语料、e2e-stage.js、在途 shims 副本），详见 §3.4。
5. **平台特有核心**：harmony 独有 CardPlayer、real-agent/real-create CI 腿、BUNDLE_FILES 漂移守卫、外部 Node uitest 驱动、LLM 凭据三方握手；**android 是唯一"fs 扩展 + wasmRun + timer 三组全占"的平台**（wasmRun 本身 android 与 iOS 双有，android 的独占只在"三组同时齐备"这层意义上成立，见 §4.2#5）；iOS 独有 ishRun 在役、C 数组嵌入、BuildIshEngine、新克隆自举。
6. **最大的系统性差异是网关原语覆盖矩阵（§5.1）**：fs 扩展五原语与 wasmRun 缺于 harmony；timer seam 缺于 iOS；ishRun 仅 iOS 在役；socket seam（v1.8.0）三个移动宿主全部未实现，唯一席位是桌面 CLI（`main_cli.c:1315`，本次 grep 三宿主 0 命中）。
7. **工作区漂移一处（非仓库内容漂移）**：`runtime/spike/system-plugins` 在 git index 是指向 `../../system-plugins` 的 symlink（mode 120000），工作区被重建为绝对路径的 MSYS symlink（`/d/workspace/dsh-mobile/system-plugins`），`git status` 记为 ` D`——链接在文件系统层面仍可解析。
8. **CI 覆盖不均（check 名 = workflow job 名，实跑 grep 映射）**：ci-verdict.yml:88 的 `EXPECTED="gates ios-e2e android-e2e harmonyos-build pages-demo"` 中——`android-e2e` = dev-android.yml:41 的 job（GitHub 模拟器全量 E2E）；`ios-e2e` = dev-ios.yml:58 的 job（macOS 模拟器上**只跑 CI 可行的子集**：m1 两场景 + BLE mock + CLI 形态 parity，UI/binding 腿明确排除，dev-ios.yml:357-369）；`harmonyos-build` = dev-harmonyos.yml:45 的 job（**只有 build，无任何 e2e job**）；`pages-demo` = pages.yml:57 的 job（路径过滤，仅 lynx client 变更时跑——ci-verdict.yml:81-85 注释明示这些 leg "may legitimately be absent"）。

---

## 2. 公共代码地图

### 2.1 权威源 → 三平台落地

| # | 公共面 | 权威源（canonical） | Android 落地 | Harmony 落地 | iOS 落地 | 一致性门 |
|---|--------|--------------------|--------------|--------------|----------|----------|
| 1 | JS 闭包本体（logger.js / gateway.js / llm.js / scenario/ 64 场景 / install-pipeline / codecs / upstream shims / manifest.json） | `runtime/spike/`（1480 个 tracked 文件，`git ls-files` 实测） | `app/src/main/assets/spike/`（磁盘 1746 / 索引 1260，实测；三层口径见 §3.3a） | `entry/src/main/resources/rawfile/spike/`（磁盘 2007 / 索引 689，会话末快照；三层口径见 §3.3a） | 编译进二进制：`App/Generated/SpikeBundle.c`（gitignored，不入库） | `closures` gate（build/check-closures.sh） |
| 2 | 平台无关 C 宿主（dsh_spike_host.c + dsh_socket.c + dsh_wasm.c + dsh_ish.c） | `runtime/spike/host/` | **直编**（非副本）进 libdsh_spike.so（cpp/CMakeLists.txt:6-100【调查】） | **直编**进 libspike.so（cpp/CMakeLists.txt:34-73【调查】） | **直编**（project.yml:47-100【调查】） | 无漂移面（单一源直接编译） |
| 3 | vendored 引擎（quickjs-ng 0.17.0 / wasm3 0.9.0 / zstd 1.5.7 / iSH） | `runtime/spike/vendor/`（untracked，ensure 脚本 pin + sha256，.gitignore:264-269 实读；本 worktree 已物化——`ls runtime/spike/vendor` 实测含 quickjs-ng/dsh/npm/wasm3/zstd） | Gradle `ensureSpikeVendor` 物化【调查】 | CMake 构建前 `vendor/ensure.sh`（:20-32【调查】） | 同左 + iSH rootfs【调查】 | `vendoring-repro` 门【调查】 |
| 4 | system-plugins（10 个实现包） | `system-plugins/`（canonical；`runtime/spike/system-plugins` 是 symlink 桥，见 §5.2 #19） | `assets/spike/system-plugins/` 整目录镜像【调查】 | `rawfile/spike/system-plugins/`【调查】 | `gen_bundle_header.py` 双源嵌入（REPO/ 与 SPIKE/ 路径）【调查】 | 随闭包走 closures；harmony 另有 BUNDLE_FILES 守卫（本次实跑 exit 0） |
| 5 | web-client-next / web-client-whale | `presentation/web-client-{next,whale}` | `assets/spike/webclient-{next,whale}/` 整树镜像【调查】 | `rawfile/spike/webclient/` 整树镜像（vendor-official.sh:648-706 实读 grep） | 不在此镜像家族（iOS 用 web-client + web-client-mini 嵌入【调查】） | `node tools/check-asset-mirrors.mjs --json`（本次实跑 ok；outsideFamily 语义见 §3.3 口径④） |
| 6 | 官方 DSH Web dist + client-bundles | `presentation/official-web/`（untracked 物化） | Gradle `stageOfficialDist`→assets merge（不在 `assets/spike/` 下——实测该目录树仅 1 个路径含 "officialweb" 字样）【调查+实跑】 | `rawfile/spike/officialweb/`（gitignored，.gitignore:223 实读；vendor-official.sh:167-176 每次 rm -rf 重物化，实读 grep；219 文件实测） | Release 由 `stage_official_web.py` 逐字节 sha256 复核嵌入【调查】 | 各 stager 内置校验【调查】 |
| 7 | 冻结契约 | `contract/`：正文 `primitives.md` 当前 **v1.8.0**（:1 实读）；`proposals/` 是"拟占用下一版本号"的 DRAFT 序列（两套版本号关系见 §5.1 注） | spec 消费（GatewayCore.kt:23-25 实读头注） | spec 消费（各原语模块头注【调查】；BINDING_DESCRIPTOR 注释点名 conformance §7，HostPhase.ets:125-128 实读） | spec 消费（GatewayCore.swift:118-121 实读） | 无（D5 契约先行） |
| 8 | 统一日志 | `runtime/logger/index.ts`（canonical TS 契约，不被打包）+ `runtime/spike/logger.js`（operative，被三平台嵌入同一份字节拷贝）【调查】 | 嵌入 assets 拷贝 | 嵌入 rawfile 拷贝 | 嵌入 C 数组 | `logging` gate（本次实跑 774 文件 0 违规） |
| 9 | E2E 判定设施 | `test/e2e/check.mjs`（唯一判定器）+ `scenarios/` 清单 + `fixtures/upstream-parity-reference.jsonl` golden（存在性实测）+ `runtime/spike/ci/parity-compare.mjs`【调查】 | 各 runner 消费【调查】 | 各 runner 消费【调查】 | `run-ios-*.sh`（17 个，住 test/e2e/，hosts/ios 无 ci/ 目录，ls 实测） | `e2e-matrix` 门【调查】 |
| 10 | 构建门面 | `build/build.sh`（build\|test\|check\|sync × ios\|android\|harmony\|core，:17 实读）+ `build/check-closures.sh` | sync = stage-spine-closure.sh（build.sh:113-115 实读） | sync = vendor-official.sh --closure-only（build.sh:116-118 实读） | sync = gen.sh（build.sh:109-112 实读） | `closures` gate（check-closures.sh:41-46 实读） |

### 2.2 公共面内的平台接缝（合法适配点，非 hostType 分支）

- 场景脚本按平台前缀命名（`scenario/android-*.js`、`scenario/harmony-*.js`，含 `harmony-httpfetch-streaming.js` 注释明说补齐平台 gap）——仍是能力协商而非 hostType 分支（RFC 0002）。【调查】
- `upstream/web-boot.js:96-104` 的 web.plugins CHUNKED 形状为 harmony drive 的多 MB staging 而设（实现是通用参数，动机来自单一平台）。【调查】
- C 宿主编译期 `#ifdef` 接缝（`__OHOS__`/`__ANDROID__`/`__APPLE__`、`DSH_WITH_SQLITE`）。【调查】
- `__DSH_RELEASE__` 不烘进 staged bundle：由共享 C 宿主按 `-DDSH_RELEASE` 在 context-bind 时注入 globalThis，三平台 Release 配置各自定义宏——保住 logger.js 与 canonical 字节一致（logging 门 L4c 专查此项）。【调查】
- socket seam（v1.8.0）：唯一实现席位是桌面 CLI（`main_cli.c:1315-1337` 实跑 grep），三个移动宿主原生层 0 命中（实跑 grep）。【实跑】

---

## 3. 同步机制与命令

### 3.1 命令（BUILD.md 映射【调查】，build.sh 分派实读）

```
build/build.sh sync <platform>          # 重落地一个平台的已提交闭包（build.sh:107-126）
build/build.sh sync all                 # ios→android→harmony→core 全部重落地
build/build.sh check                    # 仅跑 closures 漂移门（build.sh:222-224 → check-closures.sh）
node tools/check-asset-mirrors.mjs --json   # web-client 镜像家族双向跨宿主比对
node hosts/harmony/ci/check-bundle-files.mjs # harmony BUNDLE_FILES ↔ rawfile 双向守卫（未升格为 gate【复核】）
```

### 3.2 三平台 stager 与落地形态

| 平台 | stager | 机制 | 落地形态 |
|------|--------|------|----------|
| android | `hosts/android/ci/stage-spine-closure.sh` | shell cp 复制 vendored pins / upstream boot 层 / system-plugins / webclient 进 assets，复制后逐文件 cmp；`--check` 即 closures gate 的 android 半【调查】；对 git 未跟踪的已暂存文件按 `is_tracked` 逐项 `note_skip` 跳过不 cmp（:393-399、:417 等实读 grep） | 已提交 assets 字节拷贝 |
| harmony | `hosts/harmony/ci/vendor-official.sh --closure-only` | CLOSURE 清单（:182 起；SPINE_OURS :317-466；:565-601 追加 system-plugins 等）逐文件 cmp + webclient 整树（:648-706）+ officialweb 每次 rm -rf 重物化（:167-176）+ `--suite-extras` 时 upstream-tests 语料（:70-140）；`--check` 对 git 未跟踪的清单内文件**先 skip 后不 cmp**（TRACKED=`git ls-files "$RAW"`，:722-727、:777-783 实读） | 已提交 rawfile 字节拷贝（officialweb/ 与 upstream-tests/ 部分 gitignored，.gitignore:223-224 实读） |
| ios | `hosts/ios/gen.sh` | `gen_bundle_header.py`/`gen_bundle_trees.py` 把闭包嵌成 NUL 结尾 C 字节数组 + `xcodegen generate`【调查】；生成物 gitignored 不入库（hosts/ios/.gitignore【调查】）；closures gate 对 iOS 的主张是"确定性生成 exit 0"，无 xcodegen 的宿主只强制纯 python3 的 bundle 半（check-closures.sh:49-89 实读） | C 数组编译进二进制，运行时由 SpikeBundleStager.swift 落盘 bundle_root【调查】 |

### 3.3 一致性现状（本次实跑的命令与结果）

| # | 命令（原文） | 结果 |
|---|--------------|------|
| 1 | `sh hosts/android/ci/stage-spine-closure.sh --check` | **exit 0**，`assets verified in place (check mode, no writes, 313 untracked-but-staged file(s) skipped — materialized by the Gradle build)` |
| 2 | `sh hosts/harmony/ci/vendor-official.sh --check` | **exit 0**（两轮复测输出逐字一致），`closure verified in place (check mode, no writes, 177 untracked-but-closure file(s) skipped — materialized at build time)`。**注意**：--check 模式在 :828-832 提前 exit，**不会**运行 check-bundle-files.mjs——后者只在物化模式末尾（:836）或单独运行时执行（实读） |
| 3 | `node hosts/harmony/ci/check-bundle-files.mjs`（单独运行） | **exit 0**（两轮复测不变），`OK (1083 listed = 1083 rawfile files on disk, both directions)` |
| 4 | `node tools/check-asset-mirrors.mjs --json` | **exit 0**，`ok: true`；next（android 16 / harmony 16）、whale（android 4 / harmony 4）全部 stale/missing/extra 为空；`outsideFamily: ["web-client-mini"]`（语义见口径④） |
| 5 | `python tools/check-logging.py` | **exit 0**，`774 file(s) checked … 0 violation(s)` |
| 6 | iOS 生成腿（`gen.sh` / `gen_bundle_header.py`） | **未跑**。无现成只读模式（口径⑥）；iOS closures 主张本次未验证 |

**口径（对照审阅问题逐条）**：

- **① 三层计数（harmony，会话末快照）**——三个数字是三个不同的层，不是同一集合的三个数：
  - **git 层：索引 689** = rawfile/spike 下 git 跟踪的已提交闭包（`git ls-files` 实测）；
  - **字节 cmp 层：177 skips** = `--check` 逐文件 cmp 的范围 = CLOSURE 清单行 ∩ **git 已跟踪**。清单行若未被 git 跟踪则记一次 skip、**不做 cmp**（vendor-official.sh:777-783 实读；check-bundle-files.mjs:88-89 注释自述"the same posture the closures gate applies to untracked-but-closure files"）。所以 exit 0 的字节证据**只覆盖 689 个 tracked 文件中出现在清单里的那部分**；
  - **物化层：1083** = BUNDLE_FILES（Index.ets 的运行时物化清单——launch 时真正拷进 app cache 的集合）↔ 磁盘树双向一致。守卫走**磁盘**而非 git（check-bundle-files.mjs:27-30、:59-78 实读），排除两项：`officialweb/`（直接从 rawfile 服务、不物化，:65）与 suite extras（由 `upstream-tests/__files.txt` 清单划出、计为 SKIPS，:83-103）。
  - **算术恒等式**：磁盘总数 2007 = officialweb 219（gitignored）+ suite extras 划出 705（`__files.txt` 996 行所列的未列出磁盘文件；upstream-tests/ 磁盘 650 文件，其余为 vendor/dsh 等 suite 行）+ 1083（物化清单文件）。同一恒等式在早前快照也成立（1359 = 219 + 57 + 1083）——**1083 与 --check 输出在会话内两次测量均逐字不变**，extras 在并发增长，这正是"三层各管各"的实证。
  - **android 侧对应关系**：磁盘 1746 / 索引 1260 / 313 skips。313 = stager 自身 staging 范围内 git 未跟踪的已暂存文件（其 cmp 范围 = 范围内 ∩ tracked，:393-399 实读）；磁盘未跟踪共 486（1746−1260），其中 313 在 stager 范围内被按设计跳过，**其余 ~173 在 stager 范围之外**（构建期物化的 gitignored 树；具体构成本次未分解——unconfirmed）。android 官方 dist 不在 `assets/spike/` 下（`find -path '*officialweb*'` 仅 1 命中，实测）。
- **② 在途 10 个 shims 的字节证据状态**：工作区 diff 显示这 10 个 `upstream/shims/*.js` 正是本次未提交修改**新加入** SPINE_OURS/CLOSURE 清单的行（`git diff hosts/harmony/ci/vendor-official.sh` 实跑，hunk 落在 :400-410）；它们在 rawfile 中未被 git 跟踪（`git status --porcelain rawfile` = 10 行，实测），因此**落入 177 个 skips——本次 exit 0 对它们不构成字节级证据**。它们现有的保证是：(a) 字节来源是 `--closure-only` 物化时从 canonical `runtime/spike/upstream/shims/`（同名 tracked 文件，`ls` 实测）cp 而来；(b) check-bundle-files 验证了它们在清单与磁盘**双向存在**（存在性，非字节）。字节级验证要等它们被提交、下一次 `--check` 用 tracked 集合覆盖时才成立。
- **③ 30 vs 28 vs 32（§4.1 表）**：BINDING_DESCRIPTOR 是 **28 个名字**（26 available + 2 phased unavailable，HostPhase.ets:129-136 实读）；onDispatch 分发表实数 **32 个名字**（:805-869 逐分支点数，实读）：cameraRecordStart/Stop 共占一分支（:848）。两者关系：32 = 28 − 1（descriptor 的裸名 `fsScope` 在分发侧拆为 `fsScope.persist`/`fsScope.resolve` 两名）+ 1（`httpFetch.abort` 控制面）+ 2（`timerSchedule`/`timerCancel`）。**观察（如实标注，不下结论）**：timer 已实现且在分发表中（:816-819、TimerPrimitive.ets），但 BINDING_DESCRIPTOR 未列这两个名字——是 binding 场景 descriptor 刻意收窄还是待补，本次未查证（unconfirmed）。原调查"30 个原语名"口径不明，以实数 32 为准（修正）。
- **④ outsideFamily 为何不算失败**：镜像家族是**声明式策略行**而非 glob——`FAMILY = ['next', 'whale']`（check-asset-mirrors.mjs:49 实读），即两个 stager 与 iOS 嵌入器实际 staging 的树（:18-24 注释："The mirror family is a declared policy row, not a glob … A new web-client-* tree outside the family is reported as an informational `outside-family` row — whether it must mirror is a human call, not a glob's"）。`web-client-mini` 的 canonical 位置是 `presentation/web-client-mini`（ls 实测），iOS 侧以资源级（非整树镜像）方式嵌入（gen_bundle_header.py:64-69【调查】），故它天然不在 android/harmony 镜像比对家族里。exit 语义：exit 1 只由 findings（漂移/缺失/多余/声明缺口）触发（:30-31）；另注 `asset-mirrors` 门本身是 allowFailure/warn 级，blocking 牙齿在各宿主 closures `--check`（:32-35 实读）。
- **⑤ EXPECTED 名单与正文的关系**：EXPECTED 四项是 **check-run 名 = workflow job 名**（实跑 grep 映射）：`android-e2e`=dev-android.yml:41、`harmonyos-build`=dev-harmonyos.yml:45、`ios-e2e`=dev-ios.yml:58、`pages-demo`=pages.yml:57。`ios-e2e` 这个 job 的**内容**就是 §1.8 所述的受限子集：m1 两场景（boot-verification + carrier-loopback，check.mjs 双跑双判，:344-355 实读）+ BLE mock（:377-380，continue-on-error）+ CLI 形态 parity（:184-185）；m2 UI binding 腿被注释明确排除在 CI 外（:357-369 实读："Hosted runners have no UI driver, so that leg CANNOT run here … The m2 E2E runs locally"）。`pages-demo` 是 lynx 客户端 demo 链（路径过滤触发）。harmony **没有任何 e2e job**——EXPECTED 里只有 `harmonyos-build`，这正是"harmony CI 仅 build"的准确含义。ci-verdict.yml:81-85 注释明示这些 leg 是路径过滤的、"may legitimately be absent"（实读）。
- **⑥ iOS 只读验证路径（回应"缺口能否收窄"）**：`gen_bundle_header.py` **没有** check 模式或输出重定向参数——`grep -n 'argv|argparse'` 0 命中，输出路径硬编码 `OUT = HOSTS_IOS / "App" / "Generated"`（:17 实读）。生成器输入树在本 worktree **已物化**（`ls runtime/spike/vendor` 实测含 quickjs-ng/dsh/npm）。理论上的只读收窄路径：在**仓库外**临时目录复刻最小布局（Tools + runtime/spike + system-plugins + presentation + hosts/ios 骨架）后运行 bundle 半——语义上等价 check-closures.sh 在无 xcodegen 宿主上的退化腿（check-closures.sh:73-83 实读）。本次未执行：(a) 需要把输入树复制到仓库外，超出本报告"只写 .zcode/reports/ 一个文件"的约束；(b) 即便 exit 0，其含义也只是"确定性生成在此树上成功"——iOS 没有已提交副本可与生成物做字节比对，这是 D9 flip 后该平台 freshness 主张的固有形态。另记一处文档失真（实读）：脚本 docstring :6-7 仍写 "Outputs are committed (App/Generated/)"，与 D9 flip 后生成物不入库的事实（check-closures.sh:19-24、hosts/ios/.gitignore）矛盾。

**结论**：可机检的两份已提交闭包副本（android / harmony）的 **tracked 部分**当前无漂移；web-client 镜像家族无漂移；harmony 的 10 个在途未跟踪 shims 无字节级证据（口径②）；iOS freshness 主张本次未验证（口径⑥）。

**工作区在途状态（如实记录，非已提交漂移）**：见文首"并发修改警告"；rawfile 下仅有的 10 个脏路径即上述 shims（`git status --porcelain` = 10，实测）。

### 3.4 哈希对比结果分类（先分类、再下结论）

原始输入：`{stagedFiles: 1349, canonicalFiles: 0, diff: 0, missing: 0, extra: 1349}`，样本前 30 条全部标 "extra"（含 officialweb/plugins/npm/** 大段、canonical-json.js、e2e-stage.js 等）。

**分类 A —— 工具伪差（整份结果不可解读为漂移）**：`canonicalFiles: 0` 说明 canonical 侧枚举根本没有发生——canonical `runtime/spike` 实有 1480 个 tracked 文件（`git ls-files runtime/spike | wc -l` 实跑）。没有 canonical 列表，diff/missing 无语义，"extra=1349" 只是"staged 全部计为 extra"的输出形状。比对工具本体未随材料给出，canonicalFiles=0 的根因（路径/glob/环境）未深挖——**此条 unconfirmed**。

**分类 B —— 同步机制允许的构成差异（对样本与两棵树顶层逐项分类，实读实证）**：

| rawfile 中存在、canonical `runtime/spike/` 顶层没有的东西 | 来源（实读 stager 证实） | 判定 |
|------|------|------|
| `officialweb/`（含 plugins/npm/@deepseek-ai/**，样本大头） | `presentation/official-web/dist` + client-bundles，vendor-official.sh:167-176 每次物化；.gitignore:223 gitignored；`ls runtime/spike/officialweb` → 不存在（实跑） | ✔ 允许 |
| `webclient/` | `presentation/web-client-{next,whale}` 整树镜像（vendor-official.sh:648-706） | ✔ 允许 |
| `e2e-stage.js` | harmony 专属 E2E 胶水（HostPhase.ets:121-123 注释 "harmony-only E2E glue"，实读）；`ls runtime/spike/e2e-stage.js` → 不存在（实跑） | ✔ 允许（harmony 独有文件，不在漂移语义内） |
| `upstream-tests/` 语料 | `--suite-extras` 物化（vendor-official.sh:70-140）；.gitignore:224 标注 generated；会话内从 2 文件长到 650 文件（并发物化实测） | ✔ 允许 |
| `upstream/shims/` 下 10 个未跟踪新副本 | canonical 同名 tracked 文件的 staged 拷贝（canonical `ls runtime/spike/upstream/shims` 全部命中，实跑）；已加入工作区 CLOSURE 清单（git diff 实证） | ✔ 允许（在途物化；字节证据状态见口径②） |
| canonical-json.js / gateway.js / logger.js 等闭包本体 | 双侧同名同源；字节一致性由 `--check` 逐文件 cmp 裁决（本次 exit 0，覆盖 tracked∩清单部分） | ✔ 无漂移 |

**分类 C —— 计数旁证**：哈希快照 1349 介于本会话两次磁盘实测（1359 → 2007，extras 并行增长）之间更早的时点；差值随 extras 物化浮动，而 1083 物化层与 --check 输出两轮不变——支持"快照时点差异 + 工具伪差"，不支持内容漂移。

**总结论**：该哈希对比不构成任何平台的漂移证据；漂移判定以 closures gate 的逐文件 cmp 为准（android / harmony 两腿本次 exit 0，覆盖范围见口径①②）；iOS 侧无哈希可比对象，其 freshness 主张本次未验证（§3.3 #6）。

---

## 4. 各平台特有盘点

### 4.1 HarmonyOS（hosts/harmony）

**特有面分层**（【调查】汇总，关键项另标实跑/复核）：

| 层 | 文件 | 职责 |
|----|------|------|
| 原生壳 | `entry/src/main/cpp/napi_init.cpp`、`gateway_smoke.cpp`、`CMakeLists.txt` | NAPI 模块 libspike.so：M5 事件驱动 mutator + 网关 smoke 后端（C 侧 fs/keychain 回归面）+ 直编共享 C 宿主与 pinned 引擎 |
| ArkTS 能力层 | `HostPhase.ets`（分发表 + BINDING_DESCRIPTOR）+ 每原语一个 .ets（HttpPrimitive/HttpFetch/TimerPrimitive/KeychainPrimitives（HUKS AES-256-GCM）/PickerPrimitives/DevicePlanePrimitives/CameraPrimitives/BlePrimitives（mock+系统双无线电）/MicPrimitives） | descriptor **28 名**（26 available + camera 两行 unavailable，:129-136 实读）；分发表 **32 名**（实读逐分支点数，口径③）的 ArkTS 实现 |
| Carrier/WWW | CarrierServer、OfficialServe、ApiBridge、WebDist、WebPlugins、**CardPlayer（独有）**、CarrierRoutes | loopback HTTP/WS、官方客户端 SERVING 座位、/api+/api/remote.mux、静态 dist、/plugins |
| E2E 相位/驱动 | OfficialPhase、NextWebPhase、ParityMockRoute、SessionLiveProbe、SessionWriteProbe、E2eLeg（--ps 启动腿选择）、**LlmConfigStaging（独有）**、BuildFlavor、Index.ets、EntryAbility | harmony.officialweb/nextweb/session 等腿的宿主侧驱动 |
| CI | `hosts/harmony/ci/` 19 个文件（`ls` 实测：run-host-e2e、run-{ble,camera-plane,device-plane,mic-plane,live-llm,next-web-mount,whale-mount,real-agent,real-create,device-parity,upstream-parity,upstream-suite}.sh、drive-{binding,device-plane,mic-plane,official}.mjs、vendor-official.sh、check-bundle-files.mjs） | 每腿一 runner，本机 Windows 宿主模拟器执行 |
| 构建 | hvigor 配置组（compatibleSdkVersion 26.0.0、DSH_RELEASE 双模式、arm64-v8a）；`signingConfigs: []`（build-profile.json5:8 实跑 grep） | 真机签名缺失，仅模拟器/CI build【复核】 |

**harmony 独有机制**：

1. **CardPlayer**——CREATE 产物卡片播放面：`/card-player` 精确路由渲染声明式 card.json + CommonJS plugin.js 运行器，`/workspace/` 服务 spike-fs 工作区文件（CardPlayer.ets:119-138）。✅ verified：【实跑】`grep -rniE 'cardplayer|card\.json' hosts/android/app/src/main/java hosts/ios/App/Source` → 0 命中；【复核】Index.ets:1514 注册、PR #399（a2d75b89）。
2. **real.agent.loop / real.create 两条 CI 腿**——runner `ci/run-real-agent.sh`、`ci/run-real-create.sh`（`ls hosts/harmony/ci` 实测在列）。✅ verified：【实跑】`ls hosts/android/ci` 12 个脚本无对应物、`ls hosts/ios` 无 ci/ 目录；场景 JS 是公共件（`runtime/spike/scenario/real-agent-loop.js`、`real-create.js` 存在性实测）。"windows-test-plan T4/T5" 指 `docs/windows-test-plan.md` 的验收表（:195-204 实读）：T4 fs shapes 与 T5 web_search 两行都标 DONE 且均由 `real.agent.loop` 腿完成（:201-202）——real.create 是该计划之后追加的 CREATE-mode live demo（【复核】）。
3. **真机一键 parity + tool-rows 机上断言 runner**（`run-device-parity.sh`）。"D-g standby 模式"是仓库决策记录里的编号 D-g（该脚本头注 :2-5 实读："decision D-g: scripts ready on standby; the moment a device is attached, one invocation produces the receipts"）：即**真机 parity 腿的脚本已就绪、处于 standby 合同下**——无真机时打印 ready-standby 报告并 exit 0、永不阻塞等待设备（standby 合同 :24-28 实读）；接上真机后一条命令产出 parity 差分 + tool-rows 断言（:15-22）的收据。◑ verified（表述已修正）：原调查"tool-rows 全仓仅 harmony 出现"**字面为假**——共享场景 `runtime/spike/scenario/composer-web-live.js:343-344` 即发射 toolRows（本次 grep 实证），iOS artifacts 亦有记录（【复核】b4-write-live/receipt.json）；harmony 独有的是**专用机上断言块**（run-device-parity.sh phase 2【复核】，test/e2e/scenarios/ 全部 manifest 不断言 toolRows【复核】）。android 只有模拟器 parity，iOS 是模拟器 in-app 驱动（【复核】）。
4. **check-bundle-files.mjs**——Index.ets BUNDLE_FILES ↔ rawfile 树双向漂移守卫（#56 类事故）。✅ verified：本次实跑 exit 0（1083=1083，两轮不变）；android 的 stage-spine-closure.sh 是 staging+源↔副本字节 cmp、iOS 是生成即派生，均无"清单↔树"比对（【复核】grep 两平台 BUNDLE_FILES 0 命中）；尚未升格为 gate（【复核】.gov 配置无引用）。⚠ 精确口径：它验证**存在性双向一致**（物化层），字节一致性仍由 closures `--check` 负责（vendor-official.sh --check 模式不调用它，§3.3 #2）。
5. **独立 Node 版 hilog 尾随 + uitest UI 驱动**（drive-binding/device-plane/mic-plane/official.mjs）。◑ verified（【复核】：uitest uiInput click、ui-wait/ui-done 轮询、hilog spawn；细化：drive-official.mjs 无点击只尾随终态标记）。android 把 uiautomator dump+input tap 内联进 shell 腿，iOS 用 in-app Swift 驱动——外部可复用 Node 驱动是 harmony 的组织方式。
6. **LLM 凭据三方占位握手 + harmony 专属 e2e-stage.js**——运行时经 C 侧 fsWrite 建占位 → runner `hdc file send` 覆写 → 应用轮询导入（LlmConfigStaging.ets:4-35【复核】；HostPhase.ets:121-123 "harmony-only E2E glue" 实读）。e2e-stage.js 仅 rawfile 有、canonical 与 android/ios 均无（与本次 canonical `ls` 一致【复核】）。android 用 run-as、iOS 用 SIMCTL_CHILD_* 注入【复核】。
7. **hilog 流控治理与启动验证**——`hilog -Q` 旋钮告警、按 pidof 验证启动（"aa start 退出码不是证据"，run-host-e2e.sh:82-117【复核】）。android 的 `am start` 退出码就是证据、iOS 用 simctl bootstatus——两平台无此层【复核】。

**consumes**（【调查】，要点）：rawfile/spike 字节拷贝（closures 门把守，本次 exit 0）；libspike.so 直编 canonical C 宿主 + quickjs-ng 0.17.0 + zstd 1.5.7；contract/ 各章节头注点名；system-plugins 10 包以 BUNDLE_FILES 条目进 rawfile；三个 web client（dsh-web-client/next/whale）以 committed webclient/ 目录进 rawfile；官方 dist 落 officialweb（gitignored，每 run 物化）；E2E 判定用共享 test/e2e/check.mjs + parity golden（存在性实测）。

### 4.2 Android（hosts/android）

**特有面分层**（【调查】汇总，关键项另标）：

| 层 | 文件 | 职责 |
|----|------|------|
| 运行时壳 | SpikeRuntime.kt（`HandlerThread("dsh-spike-js")` 单串行）、MainActivity.kt（12 种 launch 驱动模式 + `syncAssetDir` stamp 落地 :466-480 与 `.dsh-asset-stamp` :31，实跑 grep）、SpikeHostM4.kt、M4PagePump.kt、JNI 三件（dsh_spike_jni.c / dsh_spike_m4.c / dsh_spike_smoke.c）、android_compat.c | 进程级单串行 JS 线程、场景生命周期桥、smoke 网关后端 |
| 网关 | GatewayCore.kt（PRIMITIVES 冻结表 :26-36 **实读**：v0 九件 + fs 扩展五件 + wasmRun + timer 对 + 设备面 + camera + BLE 八件 + mic 对；**无 ishRun**，:24 注释声明 unavailable）、FsPrimitives/TreeScopeFs（SAF user scope）/HttpPrimitive/KeychainPrimitives（AndroidKeyStore）/NotifyPrimitive/UiPrimitives/ClipboardPrimitives/DevicePlanePrimitives/CameraPrimitives/MicPrimitives/Ble 四件（SystemBleRadio/MockBleRadio/BleConsent）/WasmPrimitive（vendored wasm3）/TimerPrimitive | 原语覆盖三平台最全的一侧 |
| UI 载体/会话 | CarrierServer.kt + CarrierAPIBridge 等、MockLlmRoute.kt（字节级镜像 dsh-llm-mock-server）、OfficialWebSession 族、SessionServe.kt、ShareFilesProvider.kt、AgentPresetsSeed.kt | loopback 载体、脚本化模型边界、官方页 claims 探针链 |
| CI | `hosts/android/ci/` 12 个脚本（`ls` 实测：run-spike-e2e / run-android-full / run-upstream-parity / run-upstream-suite / run-{ble,camera-plane,device-plane,mic-plane,live-llm,page-open} / logcat-capture / stage-spine-closure） | GitHub 模拟器 + 本地执行 |
| 构建 | AGP 8.7.3 + Kotlin 2.0.21、DSH_RELEASE 双通道（BuildConfig + cFlags）、Windows execBash、staging 任务组、双 ABI【调查】 | |

**android 独有机制**：

1. **WebView devtools 页面打开 pin**（run-page-open.sh 经 adb forward 查 /json/list 断言导航）——harmony/ios 无对应（【复核】grep）。◑ verified（【复核】）。
2. **canary 钉住的 logcat 捕获纪律**（logcat-capture.sh 被 5 个 runner 共用）。✅ verified：【实跑】`grep -c canary hosts/android/ci/logcat-capture.sh` → 39；harmony/ios 无等价物（【复核】grep 0 命中）。
3. **GitHub 托管 Linux 模拟器全量 E2E**——dev-android.yml 实跑 grep 证实五步：run-spike-e2e（:206）、run-upstream-parity（:209）、run-ble mock（:217）、run-android-full（:234）、run-page-open（:266）。✅ verified。
4. **assets→filesDir 的 stamp 清单自愈落地**（`.dsh-asset-stamp` 不符即整树重落地，loop-g 修复）。✅ verified（grep 实证代码在位）；iOS 是 C 数组落盘、harmony 是 rawfile 懒读，均无 stamp（【调查】对照，harmony 侧"未穷尽全部启动路径"低不确定）。
5. **原语覆盖**：fs 扩展 + wasmRun + timer 三组都在役（GatewayCore.kt:26-36 实读）——**三平台中唯一三组齐备的一侧**（wasmRun 并非 android 独有：iOS 同样在役，FSPrimitives.swift:52；android 的独占仅在"三组同时齐备"这层）。

**consumes**（【调查】，要点）：共享 C host 直编（非副本）+ Gradle ensureSpikeVendor 物化 vendor；assets/spike committed 字节拷贝（closures 门把守，本次 exit 0）；presentation official dist + client-bundles 由 verify/stage 任务链进 APK；contract/ spec 消费；共享 parity golden 与 check.mjs。

### 4.3 iOS（hosts/ios）

**特有面分层**（【调查】汇总，关键项另标）：

| 层 | 文件 | 职责 |
|----|------|------|
| 运行时壳 | RuntimeThread.swift（专用 4MB 栈线程——dispatch 池会破 quickjs 栈限制）、SpikeRuntime.swift、SpikeHostFactory.swift（`dsh_spike_new_declaring` + SIMCTL_CHILD_* 环境快照）、SpikeBundleStager.swift（C 数组落盘 bundle_root）、AppDelegate(+Drives).swift | 驱动平台中立 C spike host |
| Carrier | CarrierServer.swift 等 8 个 Carrier*.swift（NWListener 实现 ctx.webServer 契约子集；CarrierRoutes 含 create/game 脚本化回合 :214-239【调查】） | 回环 HTTP+WS 载体 |
| 会话族 | 16 个 Session*/Official*/NextWeb*/Camera|MicPlaneDrive*.swift | 每个 E2E 腿一对运行时+探针，in-app Swift 驱动 |
| Gateway | `Gateway/GatewayCore.swift`（primitives 表 :122-133 **实读**：v0 九件 + **fs 扩展五件 + wasmRun + ishRun** + 设备面 + camera + BLE 八件 + mic 对；**无 timerSchedule/timerCancel**）+ 13 个原语族文件（含 **IshPrimitive.swift**——进程内 iSH Linux guest） | 原语实现 |
| Tools/构建 | Tools/gen_bundle_header.py + gen_bundle_trees.py + stage_official_web.py + sim-preflight.sh；project.yml（4 个 pre-build phase：GenerateSpikeBundle / FetchIshRootfs / BuildIshEngine / StageOfficialWeb；Release DSH_RELEASE；EXCLUDED_ARCHS x86_64；TCC 声明）；gen.sh；Bridge.h；**无 hosts/ios/ci/（`ls` 实测：App / README.md / Tools / artifacts / gen.sh / project.yml）**，runner 住 `test/e2e/run-ios-*.sh`（17 个）+ ios-ui.py | XcodeGen 工程 + 构建期生成 |

**iOS 独有机制**：

1. **ishRun 在役**——进程内 iSH-aarch64 Linux guest（guest 挂载 fs scope 为 /mnt/workspace），三平台唯一实现；构建侧 FetchIshRootfs + BuildIshEngine（Xcode 内 CMake 跨编译 + guest vdso 复用）。✅ verified（实读 GatewayCore.swift:124；android 仅 :24 注释【实跑 grep】、harmony 0 命中【实跑 grep】）。
2. **JS 闭包以 C 字节数组编译进二进制**（非 assets/rawfile）——gen_bundle_header.py 生成 App/Generated/SpikeBundle.c，启动落盘成 bundle_root；D9 flip 后生成物不入库，freshness 主张 = 确定性生成 exit 0。✅ verified（机制实读 check-closures.sh:17-32）；生成器本身未跑，且无只读模式（§3.3 口径⑥）。另：脚本 docstring 仍称 "Outputs are committed"（:6-7），与 D9 flip 矛盾——文档失真一处（实读）。
3. **模拟器 runtime 预检 + CI 启动补丁**——sim-preflight.sh 拒绝缺 libswiftWebKit 的旧 runtime；CI 用 SIMCTL_CHILD_DYLD_FALLBACK_LIBRARY_PATH 绕 WebKit bug 293831。◑ verified（【复核】）。
4. **WDA label 驱动工具 ios-ui.py**（住 test/e2e/，按 label tap/type/shot）。◑ verified（【复核】）。
5. **新克隆自举**——App/Generated/、DSHSpike.xcodeproj/ 不入库，CI 装 xcodegen 跑 gen.sh 现场重建。◑ verified（【复核】）。
6. **文档失真一处**：README 自称 "SwiftUI shell"，源码全 UIKit。✅ verified：【实跑】`grep -rln 'import SwiftUI' hosts/ios/App/Source` → 0 文件。
7. **CI 形态（修正调查材料的表述）**：UI/binding 腿在 hosted runner 不可行（dev-ios.yml:19、:305、:357-369 注释实跑 grep）；但 **CI 并非完全没有 parity**——macOS runner 上以 CLI 形态跑 parity differential（dev-ios.yml:184-185 `"Upstream parity differential on the macOS CLI (reference + port legs)" → sh runtime/spike/ci/run-upstream-parity.sh`，实跑 grep）；模拟器 in-app capture 腿才是本地-only（:182 注释）。`ios-e2e` job（:58）的完整内容见 §3.3 口径⑤。

**consumes**（【调查】，要点）：runtime/spike 闭包以 C 数组嵌入（非磁盘副本）；共享 C 宿主 + vendored 引擎直编；contract/ spec 消费（ishRun= v1.3.0、ctx.webServer= webserver-contract §1-3）；system-plugins 10 包全部嵌入；web-client + web-client-mini 嵌入、web-client-next 可切自托管、official-web Release 嵌入；共享 test/e2e 场景与 check.mjs。

---

## 5. 平台间差异与缺口清单

### 5.1 网关原语覆盖矩阵

| 原语组（contract 版本） | android | harmony | iOS | 状态 |
|------|---------|---------|-----|------|
| v0 九原语（fs 三件/httpFetch/notify/approval/picker/keychain 对） | ✓ | ✓ | ✓ | ✅ 实读三张冻结表【实跑】 |
| fs 扩展 fsStat/fsList/fsMkdir/fsRemove/fsRename（v1.1.0） | ✓（GatewayCore.kt:29） | **✗**（ets/cpp grep 0 命中） | ✓（GatewayCore.swift:123-124） | ✅ verified【实跑】 |
| wasmRun（v1.2.0） | ✓（WasmPrimitive.kt，wasm3 in-process） | **✗**（grep 0；仅随包携带 dsh-shell-wasm 插件文件，而该插件 manifest required 含 wasmRun → 携带但不可用【复核】） | ✓（FSPrimitives.swift:52） | ✅ verified【实跑】 |
| ishRun（v1.3.0） | 注释声明 unavailable（GatewayCore.kt:24），表与 descriptor 均无条目【实读】 | **✗ 完全缺席**（grep 0，连 unavailable 行都没有；实际应答 invalid/unknown primitive【复核】） | ✓（IshPrimitive.swift） | ✅ verified【实跑】 |
| timerSchedule / timerCancel（v1.4.0） | ✓（TimerPrimitive.kt） | ✓（TimerPrimitive.ets + 分发表 :816-819；⚠ 但 BINDING_DESCRIPTOR 未列——口径③观察） | **✗**（仅 MicPrimitives.swift:58 注释提及，实跑 grep） | ✅ verified【实跑】 |
| cameraRecordStart/Stop（phased） | unavailable | unavailable | unavailable | ◑ 三平台一致【调查】 |
| 设备面六原语 / BLE 八原语 / mic 对（capability plane） | ✓ | ✓ | ✓ | ◑ 三宿主已上线【调查】；版本号语义见下注 |
| socketListen / socketConnect（v1.8.0） | **✗** | **✗** | **✗** | ✅ verified【实跑 grep 三宿主原生层 0 命中】；唯一席位是桌面 CLI（main_cli.c:1315-1337，实跑 grep） |

> **两套版本号的关系（对照审阅问题）**：`contract/primitives.md` 冻结正文当前 **v1.8.0**（:1 实读）；`contract/proposals/` 里的提案文件各带一个"拟占用"的正文版本号——被 ADOPTED 后提案折入正文、号码成为正文新版本。实例（实读）：socket-seam 提案标题即 "（v1.8.0）"、Status: ADOPTED (2026-09-30)——已折入正文成为正文 v1.8.0（proposal :1-4）；system-capability-plane 提案标题 "（v1.10.0 candidate）"、Status: **DRAFT**（"nothing frozen, nothing implemented"，proposal :1-3），其 :352-356 明说序列 render-surface v1.7.0 → socket seam v1.8.0 → forkpty face v1.9.0 → **v1.10.0 是下一格**。所以"DRAFT v1.10.0 > 冻结 v1.8.0"不矛盾：提案号是**尚未发生的正文版本**。三宿主代码注释自称 "v1.10.0 candidate"（GatewayCore.kt:25、GatewayCore.swift:118 实读）即引用该 DRAFT 提案号——实现跑在提案前面、契约仍冻结在 v1.8.0，这正是 capability plane 行"实现先于冻结"的现状差距。

### 5.2 缺口与差异清单（每条标状态）

| # | 差异/缺口 | 状态 | 证据 |
|---|-----------|------|------|
| 1 | harmony 缺 fs 扩展五原语（android/iOS 均有） | ✅ verified（本次实跑） | grep 0 命中 + 三表实读（GatewayCore.kt:29、GatewayCore.swift:123-124、HostPhase.ets:129-136） |
| 2 | harmony 缺 wasmRun | ✅ verified（本次实跑） | 同上；dsh-shell-wasm 插件"携带但不可用"【复核】 |
| 3 | harmony 缺 ishRun（连 unavailable 声明都无） | ✅ verified（本次实跑+复核） | grep 0；应答 invalid/unknown【复核】gateway_smoke.cpp:552 |
| 4 | iOS 缺 timer seam（contract v1.4.0） | ✅ verified（本次实跑） | grep 仅注释；GatewayCore.swift:122-133 无此二行 |
| 5 | socket seam 三移动宿主全缺、桌面 CLI 唯一 | ✅ verified（本次实跑） | 三宿主 grep 0；main_cli.c:1315 在役 |
| 6 | CardPlayer 仅 harmony | ✅ verified（本次实跑） | grep android/ios 0 命中；CardPlayer.ets:119-138 |
| 7 | real-agent/real-create CI 腿仅 harmony | ✅ verified（本次实跑） | hosts/android/ci 12 脚本无对应；hosts/ios 无 ci/；场景 JS 在 canonical；T4/T5 出处 docs/windows-test-plan.md:201-202（实读） |
| 8 | tool-rows"仅 harmony"表述需修正：独有的是机上专用断言 runner，字段本身在共享场景与 iOS 证据中均有 | ✅ verified（复核轮含反例+本次 grep） | composer-web-live.js:343-344；run-device-parity.sh:15-22、:24-28（实读） |
| 9 | check-bundle-files 守卫仅 harmony 有 | ✅ verified（harmony 侧本次实跑） | exit 0（1083=1083，两轮）；两平台无"清单↔树"比对【复核】；它管存在性、字节归 closures（§3.3 #2） |
| 10 | CI 覆盖：android 模拟器全量 E2E；iOS 受限子集（m1+BLE mock+CLI parity，UI 腿本地）；harmony 无 e2e job、E2E 全本地 Windows 宿主 | ✅ verified（本次实跑 grep 三 workflow + ci-verdict.yml:81-88） | dev-android.yml:206/209/217/234/266；dev-ios.yml:58、:184-185、:344-355、:357-369、:377-380；dev-harmonyos.yml:45 |
| 11 | upstream-suite 的 CI 物料化仅 harmony（dev-android.yml 中 run-upstream-suite 0 引用，android 该腿本地跑）；harmony 侧该腿正在被并行推进（工作区有未提交修改 + 语料在物化） | ✅ verified（本次实跑） | `grep -c run-upstream-suite dev-android.yml` → 0；git status + 磁盘计数变化（文首警告） |
| 12 | whale.mount / nextweb.mount 两腿未接进 android CI（runner 存在但 dev-android.yml 无 step） | ✅ verified（本次实跑） | `grep 'next.web.mount|whale.mount' dev-android.yml` → 0 命中；harmony 有 run-whale-mount.sh / run-next-web-mount.sh（ls 实测） |
| 13 | marketplace/install 系腿 iOS(+CLI) 侧消费、android 无 staged 场景 | ✅ verified（本次实跑） | android assets scenario 无 install/marketplace（grep rc=1）；test/e2e/run-ios-install-ui.sh 存在 |
| 14 | LLM 凭据注入三平台三机制：android run-as / harmony hdc file send 三方握手 / iOS SIMCTL_CHILD_* | ◑ verified（【复核】逐文件实读） | run-live-llm.sh(android):70、LlmConfigStaging.ets:4-35、run-ios-agent-flow.sh:129-130 |
| 15 | UI 驱动组织三机制：harmony 外部 Node uitest / android shell 内联 uiautomator / iOS in-app Swift | ◑ verified（【复核】） | drive-binding.mjs、run-android-full.sh:121-129、AppDelegate+Drives.swift |
| 16 | capture 纪律不对称：android 有共享 canary 工具；harmony 每个 runner 内联重写 hilog 捕获（此半句为调查引用） | ◐ 部分 verified：android 侧 ✅本次实跑（`grep -c canary logcat-capture.sh` → 39；5 runner 共用为【复核】）；harmony 内联捕获（run-upstream-suite.sh:120-125 等）为【调查】未复核 | 两侧证据分级不同，合写一条故标"部分" |
| 17 | iOS 的 create/whale 渲染由 WKWebView + CarrierRoutes 承担，与 harmony CardPlayer 功能等价、实现不同 | ？ unconfirmed【调查】 | CarrierRoutes.swift:214-239 本次未读 |
| 18 | harmony 真机签名配置缺失（仅影响真机，模拟器/CI 不受影响） | ✅ verified（本次实跑） | build-profile.json5:8 `"signingConfigs": []` |
| 19 | `runtime/spike/system-plugins` symlink 工作区漂移：index 记录 `120000` blob → `../../system-plugins`，盘上是绝对路径 MSYS 链接，git status 报 ` D`；链接仍可用但与 index 不一致（Windows core.symlinks=false 环境重建所致） | ✅ verified（本次实跑） | `git ls-files -s` / `git cat-file -p 40a54c31` / `ls -l` / `git status --porcelain` 四连证据 |
| 20 | HostPhase.ets:137 有一行悬空的孤儿字符串字面量 `'"unavailable":[]}';`（对 descriptor 无影响的死代码） | ✅ verified（本次实读） | HostPhase.ets:136 结束 `;` 后 :137 悬空行 |
| 21 | iOS README 自称 "SwiftUI shell"，实际全 UIKit | ✅ verified（本次实跑） | `import SwiftUI` 全树 0 文件 |
| 22 | README system-plugins "三包"表述过时（实际 10 包 + README = 11 项）；gen_bundle_header.py docstring 仍称生成物入库（:6-7），与 D9 flip 矛盾 | ✅ verified（本次实跑/实读） | `ls system-plugins | wc -l` → 11；gen_bundle_header.py:6-7 vs check-closures.sh:19-24 |
| 23 | upstream-suite 语料三条 staging 路径（android tar push / harmony --suite-extras / iOS simctl cp） | ？ unconfirmed【调查】 | 三脚本本次未逐一读 |
| 24 | dsh-ble / dsh-device-plane 已 stage 未挂载（canonical 闭包无激活点，场景直接驱动原语） | ？ unconfirmed【调查】 | 证据为公共面盘点材料（非独立复核轮）；本次未重跑 |
| 25 | android 缺真 LLM 多轮 agent/create E2E 腿（是缺口还是刻意未上，两处 README 均未声明） | ？ unconfirmed【调查】 | — |
| 26 | harmony descriptor 与分发表的 timer 口径差：timer 已实现并被分发但 BINDING_DESCRIPTOR 未列（刻意收窄还是待补） | ？ unconfirmed（本次实读发现） | HostPhase.ets:129-136（无 timer）vs :816-819（分发 timer） |
| 27 | harmony 无 in-app 驱动层（覆盖等价、机制不同——算差异，未必是缺陷） | ？ unconfirmed【调查】 | — |
| 28 | third-party/deepseek-harness submodule 本 worktree 未初始化（upstream 对比腿依赖它） | ✅ verified（本次实跑） | `git submodule status` → `-ddefc45…`（前导 `-` = 未初始化） |
| 29 | 哈希对比工具 canonicalFiles=0 的根因 | ？ unconfirmed | 工具本体未随材料给出，未深挖（§3.4 分类 A） |

---

## 6. 未覆盖范围

以下事项本次**未执行/未验证**，如实列出：

1. **iOS 生成腿与一切 macOS-only 路径**：`hosts/ios/gen.sh`、xcodebuild、sim-preflight、iOS 模拟器 legs。生成器**无只读模式**（输出路径硬编码、无 check/输出参数，§3.3 口径⑥实读）；理论上可在仓库外临时目录复刻输入布局后运行 bundle 半（等价 check-closures.sh:73-83 的无 xcodegen 退化腿，且 vendor 输入树在本 worktree 已物化——`ls runtime/spike/vendor` 实测），但需把输入树复制到仓库外，超出本报告"只写 .zcode/reports/ 一个文件"的写约束，且 exit 0 也只是"生成成功"而非字节比对（iOS 无已提交副本可比）。**iOS closures 主张本次未验证。**
2. **`build/check-closures.sh` 整体与 `gov run` 全 DAG 未跑**：只单独执行了其 android / harmony 两腿（§3.3 #1-2）。
3. **桌面 CLI 构建**（`main_cli.c` → dsh-spike-cli）与 release-logging sink-probe 未跑；socket seam 的 CLI 侧结论仅基于源码 grep（main_cli.c:1315-1337）。
4. **任何模拟器/真机 E2E 未跑**：本报告是静态盘点 + 门检查，不包含运行时验证。
5. **哈希对比工具本体未随材料给出**：canonicalFiles=0 的根因未深挖（§3.4 分类 A）。
6. **vendored/untracked 树未做本报告自己的全量逐字节对拍**：一致性结论完全依赖两平台的 `--check` 门（本次 exit 0，覆盖范围见 §3.3 口径①——**untracked 清单内文件被 skip，含在途 10 个 shims**）与镜像比对器；canonical `runtime/spike/vendor/`、`upstream-tests/` 本身是 untracked 物化树（.gitignore:262-269 实读），不在 git 可比对范围。
7. **android 未跟踪磁盘文件的範围外构成未分解**：磁盘 1746 − 索引 1260 = 486 个未跟踪文件中，313 在 stager 范围内按设计跳过，其余 ~173 在范围外（构建期 gitignored 物化），具体构成未逐一定位（§3.3 口径①，unconfirmed）。
8. **submodule 对比腿**（third-party/deepseek-harness 用于 upstream parity 差分）未运行——本 worktree 未初始化（§5.2 #28）。
9. **调查材料中标 ？unconfirmed 的行号引用未逐条复核**（§5.2 #16 harmony 半、#17、#23-25、#27），以材料原文为准；**【复核】级证据不可从本报告独立重放**（见文首标注声明），承重结论已尽量以【实跑】覆盖。

---

*本报告只写入 `.zcode/reports/platform-code-map.md` 一个文件；所有【实跑】命令均在本会话于 `D:\workspace\dsh-mobile` 执行，命令原文见 §3.3 与 §5.2 各行。r2 修订回应审阅 12 条：计数口径（§3.3a）、32/28/32 口径（§3.3③）、shims 字节证据缺口（§3.3②）、outsideFamily（§3.3④）、EXPECTED 映射（§3.3⑤、§1.8）、android 措辞（§1.5、§4.2#5）、复核可回查性（文首声明）、#16/#24 状态修正（§5.2）、D-g 与 T4/T5 出处（§4.1#2/#3）、iOS 只读路径（§3.3⑥、§6.1）、版本号两套序列（§5.1 注）。*
