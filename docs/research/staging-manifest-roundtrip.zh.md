# 暂存清单往返证明:四份手单 vs 推导现实(2026-09-29)

[English](staging-manifest-roundtrip.md) | 简体中文

per-host 暂存清单今天是手编的(harmony 的 `Index.ets` BUNDLE_FILES、harmony 的
`ci/vendor-official.sh` CLOSURE/SPINE_OURS、android 的
`ci/stage-spine-closure.sh` 各表、iOS `Tools/gen_bundle_header.py`
RESOURCES/TREES)。台账上半场交付了 `tools/check-staging.mjs`,单向证明
图→表。下半场 —— 即本文件的主题 —— 是 `tools/gen-staging-manifests.mjs`:从现实
推导每份清单必须列什么,并逐行报告往返差。**Phase 2 只把生成器作为证据落仓,
不替换已提交清单**;把流程翻转(宿主代码块从生成器输出、接进 stager)是转硬
后的下一步。

以下全部数字来自携带本文件的提交所在树上的一次运行:

```
node tools/gen-staging-manifests.mjs --out /tmp/gen-out
```

## 1. 结论:往返成立

`staging-generate: round-trip holds · 0 freeze-fatal row(s)`(退出码 0)。推导
各腿要求的每一行都已出现在已提交清单中 —— 新装冻结类今天零实例。工具的拒绝
案例是真的,不是摆设:在清单之外往启动图里加一个 shim(一个被
`upstream/boot.js` 引用的临时文件)即触发
`FATAL harmony BUNDLE_FILES missing graph row: …` 与退出码 1;还原突变后恢复
退出码 0。开发过程中它真实触发过一次,抓的正是这一类。

## 2. 推导覆盖了什么

推导腿(机制在 `tools/gen-staging-legs.mjs`):

- **graph** —— check-staging 自己的 `walkGraph`,以各宿主根启动(harmony 到达
  121 个文件);
- **dshpins** —— 三个 stager 共同声明的 dsh pin 花名册(SPINE_PKG_DSH ∪
  android stage 循环 ∪ iOS TREES comprehension + iOS RESOURCES 点名的 dsh
  pin),按 `stage_pkg` 规则(materialized 树上的 package.json + lib/** −
  .d.ts + presets/**)展开,npm-face 别名(tool-present 族)按 vendor/dsh
  拼写展开;
- **pinfiles** —— noble *.js、pi-ai js+json、goal 三件套 js+json,以及 zod
  的运行时闭包(**重走 pin 自身导入图重算**);
- **closure-faces** —— npm 单文件 face,逐字取自 vendor-official.sh 的
  CLOSURE 行(策略,不重推导);
- **webclient** —— presentation/web-client{,-next,-whale} 按其暂存名。

各清单结果:

| 清单面 | 已提交 | 推导 | 缺失(会冻结) | 多出(推导不出) |
|---|---|---|---|---|
| harmony BUNDLE_FILES | 930 唯一行 | 897 | **0** | 33,全部分类 |
| android stage-spine-closure | 15 scenario 行 + 镜像 | — | 0(图完全落在镜像 ∪ 花名册内) | — |
| iOS RESOURCES | 69 | 46 图推导 | 0 | 23 策略行,已分类 |
| iOS TREES | 73 镜像根 | — | 0 个盘上缺失 | — |

工具每次运行都顺带证明的跨清单一致性:zod 闭包有三份手拷贝(BUNDLE_FILES、
harmony CLOSURE、iOS ZOD_FILES),三份都与重算的 79 行闭包集合相等。android
的 stage/verify 孪生表(scenario、dsh、npm)全部一致;没有声明的 pin 在盘上
缺席。

## 3. 逐条差 —— 每条:生成器局限还是清单手误

先说实话:生成器**不**逐字节复现已提交清单。成立的是集合级与归因级的往返。
残余如下:

1. **BUNDLE_FILES 里 312 行重复**(1242 原始行 → 930 唯一行)。是清单自身的
   时代沉积,不是生成器缺陷:整段整段的 spine 分组被贴了两遍(
   `upstream-suite-leg.js` 时代的每一行都出现在新旧两代表里)。今天无害 ——
   所有消费方都去重(`check-bundle-files` 计 930)—— 但这正是手工维护的可见
   沉淀,也正是生成化从构造上消除的东西。
2. **顺序。**已提交清单是到达序;生成器输出 canonical 排序。图决定不了顺序,
   所以这是生成器策略,双方都不是缺陷。Phase 3 让排序成为唯一顺序。
3. **33 行已提交但无腿可推导** —— 工具逐条分类:
   - 17 行 `upstream/shims/*`(crypto、os、path、node-module、util-types、
     child-process/stream/zlib 族……):**宿主加载器命名空间** —— 经 C bare
     map 与 `__dshModuleDefine` 注册到达,而这些是 JS 行走刻意看不见的数据。
     不是手误;要推导它们需要 per-host C 表(或一条声明式 shim 命名空间
     策略)。
   - 8 行插件 `manifest.json` + `dsh-device-plane/index.js`:**运行时数据**
     —— 插件加载器读 manifest,不存在导入边。
   - `e2e-stage.js`:**e2e 载具** —— 为 runner 自身的加载而暂存,启动图到不了。
   - 4 行 util-crypto 文档(LICENSE + 三个 README)与 2 行 npm-face
     (cordis-plugin-loader/include 的 `lib/index.js`):util-crypto 用了一个
     兄弟 pin 都不用的暂存形状(带文档行)—— 本次审计唯一判定为"疑似清单不
     一致"的条目,无害(rawfile 里字节齐全)但下次动 vendor 时值得看一眼。
     两行 npm-face 是加载器桥的解析结果,被分类器现行正则误归入 vendor-shape
     桶;修正纯机械。
4. **harmony CLOSURE/SPINE_OURS advisory 面上 31 条计数型覆盖差** —— 已知且
   有意:该表暂存的是更窄的 officialweb+spine 闭包,图到而不表有的行只是
   上下文,永不定罪(门正是为此把该面配成 advisory)。

## 4. 本报告不主张什么

- 不替换清单、不动 vendor 流程 —— Phase 2 是证据。
- android 31 个未暂存 scenario 是宿主策略(花名册即策略),不是缺口;工具
  复述花名册,不发明花名册。
- BUNDLE_FILES 未点名的 10 个盘上 shim(string-decoder、slot-registry、
  node-sqlite……)今天只由宿主加载器命名空间背书。将来某行 C bare map 指向
  其中之一时,JS 树里没有任何东西能抓到 —— 这个盲区正是 Phase 3 翻转 + 一条
  声明式 shim 命名空间策略的最强论据。

## 5. 复现

```
runtime/spike/vendor/ensure-dsh.sh          # 物化 vendored pins
sh hosts/harmony/ci/vendor-official.sh --closure-only   # rawfile 闭包
node tools/gen-staging-manifests.mjs --out /tmp/gen-out  # 本报告数字
node tools/check-staging.mjs --block harmony,android,ios # 验证器,绿
```
