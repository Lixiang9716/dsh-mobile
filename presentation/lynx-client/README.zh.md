# dsh-lynx-client — Lynx 渲染面客户端试点

渲染面**客户端插件**(不是 system-plugin):零 gateway 调用、零 contract
改动。自包含、可整体替换——这个目录就是产品。

- `manifest.json` — 插件门面(id/version/surface/entry/bundle/skins)
- `theme/` — 主题 token 单源(`tokens.json`);`gen.mjs` 生成两个面:
  `web.tokens.css`(CSS 自定义属性,web-client-v2 的 `:root` 词汇)与
  `bundle/src/theme.generated.ts`(Lynx 样式常量,带类型)。
  `node theme/gen.mjs --check` 作漂移门。
- `shared/` — 事件模型:`view-events.js`(视图事件闭集
  {message-delta, tool-card-phase, session-settled} 与意图闭集
  {submit, cancel, select-session, new-session},未知即 fail loud)与
  `fold.js`(视图事件 → 视图状态的纯折叠,两个皮肤共用一份)。
- `driver/` — 宿主侧:SessionServe wire 客户端(自 web-client-v2 逐字
  移植,三层 `{args:{request}}` 信封原样)、adapter(域记录 → 视图事件)、
  编排 driver(单一订阅点、seed 爆发、意图执行),以及同一
  `RenderSurfaceClient` 缝(`mount` / `pushViewEvent` / `onIntent` /
  `teardown`)上的两个皮肤:`skin-stub.js`(纯文本转写)与
  `skin-lynx.js`(装载 ReactLynx bundle)。
- `bundle/` — ReactLynx 面(纯表现:零网络、零 gateway、零业务逻辑)。
  `npm run build`(rspeedy)产出 `dist/main.lynx.bundle`;模板段以
  UTF-16LE 携带 JSX 文本——那是格式,不是损坏。

## 运行

```sh
npm install --prefix bundle   # 一次
npm run mock-loop             # 环回 HTTP+WS 上的完整环路(stub 皮肤)
npm run lynx-mode             # 校验已构建 bundle + 引擎墙
npm run theme:check           # token 单源同步
```

两条证据通道,双绿(验收轮):

- `test/e2e/run-cli-lynx-mount.sh` —— `lynx.mount` CLI 腿:完整 mock-LLM
  driver 环路在同一流上跑两遍(先 lynx 面、后 stub 面——可替换性证明)。
  每面 34/34 条结构化日志事件,与 `test/e2e/scenarios/lynx-mount{,-stub}.json`
  一一对应;verdict + receipt 入库在 `artifacts/cli-lynx-mount-{lynx,stub}/`。
  `npm run mock-loop` 保留为快速内层断言环路(18/18)。
- vitest(`npm test`,本包 71 个用例;两套 presentation 套件合计 116——
  web-client-v2 的 45 个在 `test/web-client-v2-suite/`):缝契约、fold、
  adapter 映射表、wire 客户端(本地起真服务器、真 ws-lite 升级)——外加
  `tests/driver-loop.test.js`(run-mock 的 18 项检查 1:1 formalize 成
  vitest 用例,跑同一条真 mock 环路,并补上流错误 / 无 sessionId /
  not-found / busy 的边界腿)与 `tests/{wire-edge,mux}.js`(信封的坏答案
  边界、mux 的 generation 化重连契约,全部真 socket)。两套套件都跑在
  CI(`gates` workflow 的 presentation 步骤,.github/workflows/gov.yml)。
  `npm test --
  --coverage` 如实报告 driver 面(runner 文件除外:它们的检查已由
  driver-loop 套件接管)。

**试点边界:** 真机像素需要 Lynx 引擎(LynxExplorer / 真机 LynxView)。CLI
宿主上 lynx 面驱动的是 bundle 的 seam core(`shared/surface-core.js`——编译
进产物的那份模块),挂载同时校验产物 sha256。bundle 在 @lynx-js/web-core
平台的 headless Chrome 上也能真实渲染(人看的截图在 gitignored 的
`artifacts/screens/`;CI 只认日志,按 E2E 契约)。
