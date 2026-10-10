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

## 写一个工具(develop/basic/tool)

教程的 `greet` 工具原样可跑——`defineTool` 经装载器裸名映射解析,注册即 effect,执行走真实 ToolRuntime:

```js
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'greet-tool';
export const inject = ['tools'];

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: { name: { type: 'string', required: true, description: 'Who to greet' } },
    output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] },
    async execute(args) { return `Hello, ${args.name}!`; },
  }));
}
```

其他插件经 `ctx.on('tools/result', (exec, result) => …)` 独立观察每次调用——松耦合,二者互不 import。

## 插件配置(develop/basic/config)

导出 `Config` schema(Schemastery——任何 Standard Schema 校验器均可),`apply(ctx, config)` 收到的就是校验过、默认值补齐的配置:

```js
import Schema from '@deepseek-ai/schemastery';

export const Config = Schema.object({
  greeting: Schema.string().default('Hello'),
});
export const apply = (ctx, config) => { /* config.greeting 总是有值 */ };
```

配置经挂载选项传递(`pluginOpts`)。校验发生在 `ctx.plugin` 内部:非法配置会让挂载**响亮失败**(ValidationError),并回滚 adoption(启用位)——坏插件绝不会保持启用、每次启动重试。

活挂载上的配置还可以**热更新**——内核的 config-HMR 面,暴露为 `updateWorkspacePluginConfig(spec, config)`:更新先校验,fiber 原位重启(卸载 effect 运行、apply 重跑),非法更新被拒且旧配置继续运行。教程的 `.volatile()` 字段与 `!!js` YAML 标签仍是桌面组合层特性。

## 事件(develop/framework/events)

四种分发模式是 cordis 内核原生的,逐字可用:`ctx.emit`(广播)、`ctx.bail`(首个非空返回短路)、`ctx.serial`、`ctx.waterfall`(每个监听器包裹 `next()`)。每个 `ctx.on` 都是 effect——卸载即摘除监听器。`tools/result` 及其他 `namespace/action` harness 事件与教程所示完全一致。

## 服务与依赖级联(develop/framework/service)

提供服务用类形态(`super(ctx, 'myService')`);消费用 `inject: ['myService']`(必需)或 `ctx.get('myService')`(可选)。级联契约在本宿主成立且已实证:**卸载提供方,依赖方随之销毁;服务恢复,依赖方自动重载。**

## 挂载被拒时:PENDING 诊断(cordis-tutorial 06)

`inject` 点名了无人提供的服务的插件,在上游会永远静默等待。本宿主的挂载会**拒绝**并给出诊断(`plugin is PENDING — an injected service is missing`),同时拆除 fiber、回滚 adoption。挂载必须现在就跑起来,否则干脆不挂。

## LLM 适配器(develop/practice/llm-adapter)

工作区插件可以服务自己的提供方——继承 `@deepseek-ai/dsh-llm` 的 `LlmAdapter` 并覆写 `stream()`(基类拥有 `providerInfo`/`providerRetryPolicy`/`resolveModel`/`prepareCall`):

```js
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

class MyAdapter extends LlmAdapter {
  async *stream(options) { /* 产出 StreamChunk 协议 */ }
}

export const inject = ['llm'];
export const apply = (ctx) => { ctx.llm.registerAdapter(['my-provider'], new MyAdapter()); };
```

注册即 effect(卸载即撤下提供方),流经真实 `LlmRuntime` 的 waterfall。

## 三层拆分(develop/practice/)与发布(develop/basic/publish)

Definition / Provider / Consumer 对应三个工作区树(或三个市场包),说同一个 Service 名——机制就是上面的 Service 形态 + `inject`;仓库自己的能力面(shell → bash-local → tool-bash)就是参照。发布对应市场面:`dsh plugin add` ≈ `plugin_manager install_bundle`(来自市场索引的签名 uSTAR 包),`remove` ≈ `marketplace/remove`(先卸活挂载),profile 组合包列表 ≈ 启动列表所读的 `dsh.plugins/1` 注册表。npm/pnpm 打包章按设计属于桌面——设备永不编译;作者在自己机器上编译(`dev.sh`)或交付预构建包。

## E2E 实证在哪

`scenario/plugin-forms.js`(确定性、无模型):三形态全部挂载、`inject` 排序加载、服务经解析器应答、effect 清理在卸载时运行、编辑后的源码重载、配置校验(显式值 → 默认值 → 非法响亮失败)、四种事件模式分发、greet 工具经真实 ToolRuntime 执行且有独立观察者、依赖级联销毁与重载、PENDING 挂载带诊断拒绝、工作区 LLM 适配器服务真实流、启动列表恰好挂载启用的行——23 个事件一一对应。用 `runtime/dsh/ci/run-plugin-forms-e2e.sh` 运行(已接入 `build/build.sh test core`);清单在 `test/e2e/scenarios/plugin-forms.json`。

## 策略钩子、后台任务与工具编写参考的其余部分(reference/cookbook)

深水区的工具编写面就是同一套 vendored `dsh-tools`,腿里已实证:

- **策略**:`tools/pre-execute` 瀑布可以拒绝调用(`{kind: 'deny', reason}`),`ctx.tools.guard` 单调拒绝——任何后续面都不能强行放行。两者都是 effect:卸载即解除。
- **后台工作**:组合面挂载的是真实 `LocalJobRegistry`——`ctx.jobs.start({kind, label, run})`、`wait`、`read`、`kill`。必须遵守的一个契约:合规生产者的 `cancel()` **必须最终兑现 `done`**(运行时等的是资源释放,不是 kill 请求)。`dsh-tool-jobs` 负责把任务状态渲染给模型。
- **UI 卡片**(`presentCall`/`presentResult`/`presentationMeta`):同一个 `defineTool` 的面;本宿主上面向模型的是 `output.render`,产品自己的原生卡面(`card.*` 事件)才是 UI 面。web `tool.call.toolview` 客户端槽位一章属于桌面 web 面。
- **PTC 模式**:程序化工具访问已经由 `ctx.tools.execute` 实证;完整 `run_code` PTC 面依赖 PTC host runner,移动墙(`preset-mobile-rows.js`)按设计将其禁用。
- `ctx.serial` 补齐四种分发模式;嵌套 `ctx.plugin(child)` 随父递归销毁;`ctx.provide` 是纯值提供面。

quickstart 的 Web-UI 流程(模型设置 → 工作区选择 → 带审批的真实回合)就是本应用的产品面——无需插件开发映射。

## seam 清点(reference/capability-seams,运行时实测)

`scenario/seam-inventory.js` 以生产等价脊柱(全部产品旗 + 组合面)启动,经与 `inject` 同一个解析器逐一探针上游目录的服务名。由 `test/e2e/scenarios/seam-inventory.json` 冻结;运行 `runtime/dsh/ci/run-seam-inventory-e2e.sh`。运行时的回答:

**已挂载(22)**:sessions、agents、systemPrompt、tools、sessionProjections、settings、agentLoop、llm、tokenMeter、jobs、userQuestions、subagentModelSelection、shell(wasm 执行器)、shellEnv、goals、commands、agentPresets、skills、fileReferences、web(免密钥面)、sessionQuery、sessionFeedback。

**缺席,属设计**——每一项都有移动等价物或记录在案的墙:

| 缺席 | 移动端处置 |
| --- | --- |
| credentials | 宿主侧存储:网关钥匙串 + profile 凭据文件(`loadCredential`) |
| approval | 网关 `presentApproval` 原语(契约优先;原生弹窗) |
| fs(网关,非 seam) | 宿主网关的 fs 原语就是 fs |
| subprocess、sandbox、terminals | 移动墙:无进程——wasm shell(+可选 iSH)路线 |
| compaction | 闭包里唯一消费者是 `/compact`(command-compact),上游 README 记录为不携带的桌面行;长会话自动压实列为产品后续 |
| sessionPersistence | 抽象 seam 已 vendor 但 jsonl 后端未钉版;resume 响亮报错("cannot resume: session persistence is not configured")——会话随启动而生;持久性列为产品后续 |
| sessionTitle、attachments、schedule、planMode、messageFeedback、mcpResources、spillStore、workflowEngine、lsp | 尚未携带的桌面产品特性(每个都是候选后续,无一静默损坏) |
| invariant、configEditor、setting、workspaceRegistry | 桌面诊断/组合面;移动等价物是 settings 服务、网关工作区选择器、宿主工作区模型 |

---

[English version](plugin-dev.md)
