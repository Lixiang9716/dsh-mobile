# 提案:forkpty 面——诚实的伪终端原语(v1.9.0 candidate)

> **状态:DRAFT(D5 提案——未冻结、未实现)。**
> [English](2026-09-29-forkpty-face.md) | 简体中文

## 动机

上游套件从终端这一侧把墙量到了:node-pty 一族 spec(`api/terminal-controller` 的 controller、`subprocess/subprocess-local` 的 shell-activity、`terminal/tool-terminal` 的 loader-composition)在 vendored `@deepseek-ai/dsh-subprocess-local` 的终端路径上、第一个真实 require 处死亡——`createLazyRequire("node-pty")("node-pty")`——因为冻结的合同**没有伪终端原语**。v1.5.0 时代的子进程缝(W5-R)让宿主通过管道拥有了真实 OS 子进程;终端路径需要同样的孩子站在**真 PTY** 上——回显、作业控制、前台进程组、TERM、活的窗口尺寸——这些管道一样也载不动。

产品拉力是同一个形状:交互式 shell 工具(bash 工具的真面目)要透过 PTY 读子进程的提示符状态,vendored 的 shell-activity 探测器量的是前台进程组——只有诚实的终端才携带的事实。

本提案添加**最小可审计伪终端缝**:`forkpty` 级 spawn、数据与退出走事件序列、write/resize/kill 控制面、一切过 gateway 审计。它刻意**不**在管道上伪造 TTY 语义——那个备选已被审视并被 owner 否决(决策矩阵 D-b,2026-09-29):管道背板 shim 伪造的恰恰是终端路径要度量的那些终端事实。

## 安全模型(五条规则)

1. **一个授权族,是 subprocess 的兄弟而非复制品。** `pty` 旗标门禁每一次调用。PTY 子进程能做一切管道子进程能做的事,外加终端语义,所以它是自己的能力:一个 profile 可以持有 `subprocess` 级管道而不持有终端;持有终端也绝不意味着更宽的 socket 缝。
2. **spawn 纪律,没有 shell 字符串。** 请求携带 argv 数组(绝不是命令行——引号属于调用者自己的 shell)、(适用处)授权 scope 内的工作目录、以及由宿主按子进程面同一规则洗净凭据的环境。TERM 与窗口尺寸由宿主设置——调用者永远不直接碰 tty 设备。
3. **事件,而非轮询(D8)。** 数据与退出以事件序列到达调用者的串行队列。没有阻塞整结果 API,没有"轮询一个状态"的调用:停止读取的消费者依赖宿主有界的内核缓冲与自己的流控(`pause`/`resume` 是消费者侧的投递门;宿主持续读取,孩子永远不会因管道写满而死锁)。
4. **一切过 gateway 审计。** 每次 spawn、write、resize、kill 记一条(调用者身份、权限判定、结果、写方向的字节数)。载荷字节端到端;审计只带元数据——子进程面与 socket 面遵守同一条规则。
5. **会话作用域的生命周期。** PTY 活到它的开启会话结束;宿主在 teardown 时收割孩子、关闭主端。授权永远不是持久状态,任何 PTY 都不跨 checkpoint 存活(D7 携带会话,绝不携带活孩子)。

测试套件本身不需要弹窗、不需要用户交互:授权随 profile 到位,forkpty 面就是终端路径早已期待的诚实后端。

## 原语(一个,外加一条通道)

按 v1.1.0–v1.5.0 的可加性规则:没有实现该面的 `gateway@1` 宿主对每次调用答 `unavailable`,协商保持全部现有地板。

### `ptySpawn` —— 打开一个伪终端孩子(授权 `pty`)

```ts
export type PtySpawnRequest = {
  argv: string[];                 // 程序 + 参数,绝不是 shell 行
  cwd?: string;                   // 适用处须在授权 scope 内
  env?: Record<string, string>;   // 宿主洗净;TERM 由宿主按 `term` 设置
  cols?: number;                  // 窗口尺寸,默认 80
  rows?: number;                  // 默认 24
  term?: string;                  // TERM 名,默认 "xterm-256color"
};
export declare function ptySpawn(request: PtySpawnRequest): Promise<
  { ptyId: string; pid: number } | null>;
```

在全新伪终端上 spawn 程序(`forkpty` 一类:openpty + fork + setsid + 控制 tty + stdio 接到 slave 端)。孩子 spawn 出来即 resolve;用户拒绝授权 resolve `null`;`pty` 旗标未经协商则 reject `denied`。

控制面是三个调用,每一个都过审计:

- `ptyWrite(ptyId, bytes)` —— 键入主端;
- `ptyResize(ptyId, cols, rows)` —— 对主端 `TIOCSWINSZ`,内核以 `SIGWINCH` 递给孩子;
- `ptyKill(ptyId, signal?)` —— 给孩子一个信号;省略即 `SIGHUP`(vendored 路径所依赖的 node-pty 默认)。

### `pty.event` 通道(v1.6.0 事件通道缝)

每个 PTY 一条通道,携带:

- `{ ptyId, kind: "data", bytes }` —— 孩子的输出,一块一个事件,解码是消费者的事;
- `{ ptyId, kind: "exit", exitCode, signal }` —— 孩子被收割时恰好发布一次;正常退出 `signal` 为 `0`。

任何地方都不轮询(D8);事件像每个宿主事件一样派发到串行队列(D2)。

## v0 刻意排除的内容(具名非目标)

- **Windows ConPTY**:上游 node-pty 带 ConPTY 后端;v0 只有 POSIX `forkpty`。Windows 宿主诚实答 `unavailable`。
- **终端模拟本身**:把行渲染成像素是 Web Client 的事(xterm 一族留在客户端);宿主搬运字节与窗口尺寸,仅此而已。
- **主端 fd 的 `open` 面**:node-pty 的 `open()` 共享裸 fd;v0 把 fd 留在宿主手里,藏在 id 背后。
- **终端复用**:没有 tmux 式会话、没有 detach/attach、没有回滚存储——PTY 是活的孩子,不是服务。
- **`kill` 之外的信号转发**:孩子自己发的作业控制信号走内核;宿主一概不转发。

## 备选审视

- **管道背板 shim(现状 + 伪造 TTY)**:被 owner 否决(决策矩阵 D-b,2026-09-29)——回显、作业控制、前台进程组在管道上不存在,shim 将伪造 shell-activity 探测器所度量的终端事实;套件会绿在并不存在的语义上。
- **ishRun 客机终端**:互补,而非替代——客机终端活在被模拟的 Linux userland 里(它自己的 pty 驱动、它自己的生命周期);本提案服务的是真实宿主的孩子,与子进程缝同路。
- **不设原语(维持排除)**:否决——三个 spec 族死在第一次真实终端 spawn 上,产品的交互式 shell 面遥遥无期;排除在今天是诚实的,但它是一个具名缺口,不是归宿。

## 验证计划

- 该面的第一份交付物就是套件本身:三个 node-pty 族 spec 重新入场,并在 darwin CLI 腿上逐个验收(`upstream-suite-leg.js --env DSH_UPSTREAM_SPEC=...`,每个 `suite/summary failed:0`)。
- spike 在 Darwin 上实现该缝(`forkpty(3)`,`<util.h>`);Linux 族的宿主编译同一张脸(`<pty.h>`)并保持可用,能力协商因此永远不需要按平台分叉——同一代码路径,凡能编译处皆诚实存在。
- 协商地板:不编译该面的宿主在实现前答 `unavailable`;现有行为一概不变。

## 版本

v1.9.0 candidate(可加性:一个原语 + 一条事件通道;授权族复用 v1.5.0 family-flag 机制)。编号顺着冻结的 v1.5.0 与在案的 draft 候选:事件通道 v1.6.0、render 面 v1.7.0、socket 缝 v1.8.0。
