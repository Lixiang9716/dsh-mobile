# dsh-lynx-client — Lynx 渲染面客户端试点

渲染面**客户端插件**(不是 system-plugin):零 gateway 调用、零 contract
改动。自包含、可整体替换——这个目录就是产品。

- `manifest.json` — 插件门面(id/version/surface/entry/bundle/skins)
- `theme/` — 主题 token 单源(`tokens.json`);`gen.mjs` 生成两个面:
  `web.tokens.css`(CSS 自定义属性,web-client-next 的 `:root` 词汇)与
  `bundle/src/theme.generated.ts`(Lynx 样式常量,带类型)。
  `node theme/gen.mjs --check` 作漂移门。
- `shared/` — 事件模型:`view-events.js`(视图事件闭集
  {message-delta, tool-card-phase, session-settled} 与意图闭集
  {submit, cancel, select-session, new-session},未知即 fail loud)与
  `fold.js`(视图事件 → 视图状态的纯折叠,两个皮肤共用一份)。
- `driver/` — 宿主侧:SessionServe wire 客户端(自 web-client-next 逐字
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

mock 环路(`driver/run-mock.mjs`)是本轮构建的绿灯标准:冷启动外壳 →
选会话/新建 → 流式回合(工具卡三态全程可见)→ 中途重进的 seed 重建 →
取消 → fail-loud 腿。

**试点边界:** 像素需要 Lynx 引擎(LynxExplorer / 真机 LynxView)。纯
Node 下 lynx 皮肤校验产物(sha256)并拒绝挂载、指名这堵墙——不假装渲染。
