# dsh-mobile 上的插件开发——与上游教程一一对应

本文是上游「第一个插件」教程(deepseek-harness 文档 → develop → basic)的移动端对应物:该教程讲授的每一项能力在移动宿主上都存在,走同一套 cordis 形状,由 `plugin.forms` E2E 腿实证(`runtime/dsh/ci/run-plugin-forms-e2e.sh`,回执在 `runtime/dsh/artifacts/macos-cli-plugin-forms/`)。

## 插件是什么

与上游完全一致:一个导出 `apply` 函数、接收 cordis `ctx` 的模块。三种形态都是一等公民(挂载链全部归一,`runtime/dsh/plugin-mount.js`):

| 形态 | 入口形状 | 用途 |
| --- | --- | --- |
| 对象 | `export const name/inject/apply`(或同样内容放 `default` 下) | 默认选择 |
| 函数 | `export default (ctx) => {}` | 最小插件 |
| 类 | `export class X extends Service`(单一类/函数导出会被自动选中) | 向其他插件提供服务的插件 |

```js
import { Service } from '@deepseek-ai/cordis';   // 设备上可解析(钉版 vendored 副本)
export class MyService extends Service {
  static inject = ['tools'];                     // 依赖先就绪,插件后加载
  constructor(ctx) { super(ctx, 'myService'); }
}
```

`inject` 的语义与上游一致:框架只在被点名的服务就绪后才加载插件。

## 声明 effect(以及必须知道的一个语义)

通过 `ctx` 注册的一切(监听器、工具、定时器)在卸载时自动清理。手工资源(网络连接等)用 `ctx.effect`——在 vendored 的 `cordis@4.0.2` 里,回调**立即作为 setup 执行,返回值才是清理器**:

```js
export const apply = (ctx) => {
  const heartbeat = setInterval(() => {}, 1000);
  ctx.effect(() => () => clearInterval(heartbeat));   // setup 返回清理函数
};
```

## 插件如何挂载(移动端的差异点)

手机上没有 `pnpm dsh web`;三条注册路径对应教程的 `cordis.yml` insert:

1. **聊天创作**(产品路径):让 agent 做一个插件——模型书写插件树,原生审批门征询你,插件活挂载(`plugin-mount.js`:read → validated → approved → adopted → linked → mounted)。
2. **市场**:签名包经市场面安装——同一注册表,同一启动行为。
3. **开发者推送**(教程的迭代环):`tools/plugin/dev.sh` 在开发机上编译你的 TypeScript(**设备永不编译——只解释预构建字节**),暂存进模拟器的应用容器并启用注册表行。重启应用即把所有 ENABLED 的注册表行在脊柱启动时挂载——与教程 `--patch` 层的一一等价物(同样是每次启动生效):

   ```sh
   tools/plugin/dev.sh my-plugin/            # 编译 → 暂存 → 启用 → 重启
   ```

   `my-plugin/` 就是教程 scratch-plugin 的移动端拼写:`plugin.json`(`{id, name?, version?, entry?, capabilities?}`)+ `src/index.ts`(或 `.js`,原样透传)。

## 卸载与重载

卸载是一等操作:`unmountWorkspacePlugin(spec)` 等待 cordis fiber 的 `dispose()`(插件注册的每个 effect 都随之收尾)并把注册表行置为禁用。再次挂载会在纪元查询(`?e=1`——装载器的 node 式缓存击穿)下重新链接**当前**源码,因此「编辑 → 重启」是真重载,不是旧模块。经插件管理器移除(`marketplace/remove`)会先卸载活挂载——树永远不会从运行中的 fiber 脚下消失。

## E2E 实证在哪

`scenario/plugin-forms.js`(确定性、无模型):三形态全部挂载、`inject` 排序加载、服务经解析器应答、effect 清理在卸载时运行、编辑后的源码重载、启动列表恰好挂载启用的行。用 `runtime/dsh/ci/run-plugin-forms-e2e.sh` 运行(已接入 `build/build.sh test core`);清单在 `test/e2e/scenarios/plugin-forms.json`。

---

[English version](plugin-dev.md)
