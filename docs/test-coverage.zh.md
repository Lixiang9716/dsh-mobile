# Node 侧可测面的行覆盖 — vitest、聚合 runner 与 coverage-floor 门

[English](test-coverage.md) | 简体中文

本仓真实的行为覆盖网不经过任何覆盖率工具:681 个上游官方 spec 压在
QuickJS 运行时与自研 shims 上,外加 e2e 证据矩阵与 gov 门。行覆盖只在一条
轴上补充这张网——**我们自研代码中 Node 可测的面**。本页是它的契约:测什么、
诚实不测什么,以及盯着它的 warn 档地板门。

## 跑法

```sh
sh tools/test/run-coverage.sh          # 逐面 vitest + 一张聚合表
sh tools/test/run-coverage.sh --check  # 同上,并强制地板(低于地板 exit 1)
```

runner 按 `tools/test/run-coverage.sh` 顶部的面注册表行走,缺依赖时自动
安装,以 v8 provider 跑各套件(reporter:text + lcov + json-summary),从
json-summary 报告汇总出聚合表。手动跑单面:

```sh
npm --prefix presentation/lynx-client run test:coverage
```

## 实测基线(2026-09-30,vitest 4.1.11 + @vitest/coverage-v8 4.1.11)

| 面                       | 行    | 分支   | 用例  |
|--------------------------|------:|-------:|------:|
| presentation/lynx-client | 84.2% |  66.5% | 36/36 |

## 地板与 warn 门

`tools/test/coverage-floors.json` 把每个面的地板钉在**实测值减 5 个点**
(lynx-client 今日:行 79.2、分支 61.5)——诚实的地板,真回退会亮、正常
抖动不扰。`gates.json` 的 `coverage-floor` 门跑
`sh tools/test/run-coverage.sh --check`,按面所在目录树 scoping,带
`allowFailure: true`——**warn 档:红只记录,不阻断**。它的 rule-6 反证
用例(`.gov/rejections/case-coverage-floor.sh`)证明门有牙:地板临时抬到
100% 会红且具名,同一状态在无 `--enforce` 时保持 advisory,高于地板则绿。

正当降地板的方式:重测,把地板移到新实测 − 5,并在 PR 里说明理由
(没有实测依据的地板改动是漂移,不是维护)。

## 诚实边界 — 具名的不计入项

`presentation/lynx-client` 内部,vitest 覆盖只含 `driver/**` + `shared/**`
(套件真正压住的 seam 库):

- `bundle/` — ReactLynx 渲染面跑在 Lynx 引擎上,不是 Node。在 node 侧
  假装行覆盖,与给 QuickJS 绑定的 shims 假装 node 覆盖是同一种谎。
- `driver/driver.js`、`driver/skin-*.js`、`driver/run-*.mjs`、
  `driver/mock/mock-serve.mjs` — CLI/e2e 面,只被入口引用;两种 skin 的
  完整 driver 回路由 `test/e2e/run-cli-lynx-mount.sh` 压住(stub 与 lynx
  两份 receipt 在案)。
- `theme/gen.mjs` — 归 `theme:check` 脚本门管。

整体未注册的面:

- `test/upstream-suite` — 它的 vitest 配置跑的是上游 harness 自带的
  spec(与 CLI 套件经 QuickJS 形态 harness 跑的 spec 同族)。那里的覆盖
  度量的是钉死的上游代码在 Node 语义下的行数——既不是我们的行覆盖,也不
  是 CLI 套件的行为证明。
- `presentation/web-client*` — 纯浏览器 JS,无运行器、无测试;Node 侧
  `import` `main.js` 直接失败(`document is not defined`)。
- `runtime/spike`(QuickJS 运行时 + shims)— 交付语义是 QuickJS 的;
  行为网负责它们。

## 新增一个面

1. 给该面一个 vitest 配置,`coverage.include` 具名其 Node 可测的产品代码
   (排掉 `node_modules/`、`artifacts/`、`dist/` 与每一个叫得出名字的边界)。
2. 把目录加进 `tools/test/run-coverage.sh` 的 `SURFACES`。
3. 跑一次 runner,读真实数字,把 `tools/test/coverage-floors.json` 的地板
   设为实测 − 5。
4. 门已经盯着每个注册面——不需要改 gates.json。
