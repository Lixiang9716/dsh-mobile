# 插件市场的发布者身份与 token——产品接线面(v0,并点名 v1 token 模型)

[English](marketplace-publisher-auth.md) | 简体中文

本文把插件市场的发布者侧设计当作**产品问题**记录:谁有权发布,什么凭证证明它,
这份凭证在哪里被消费。这是接线面的设计,不是 gateway 改动——
[§6](#6-gateway-原语勘察结论) 的勘察结论是 v0 与 v1 都**不需要任何新 gateway
原语**,因此不触发 D5 提案停机。

依据(均在本仓库 `main`、2026-10-01 读到):

- [contract/proposals/2026-10-01-plugin-marketplace.md](../contract/proposals/2026-10-01-plugin-marketplace.md)
  —— D5 草案(data-protocols **v1.1.0 candidate**,未冻结任何内容):v0 目录 =
  签名的静态 `index.json`;其非目标一节已写明"**无用户账号。**发布者 v0 即
  owner 的凭证(目录由 CI 从仓库产出,与 vendor pin 表同一纪律);消费者是
  已 vendored 的匿名设备身份"。其演进一节点名了 v1 发布 API(Verdaccio 协议
  兼容的发布/服务侧)与 v2 身份体系(OIDC IdP、Open VSX 式审核)。
- 冻结的包格式(data-protocols v1.0.0)与安装器的 trust record
  (`blobSha256` / `manifestSha256`)——已发布包必须携带的字段,本文不动它们。
- vendored 的消费者身份:`@deepseek-ai/dsh-anonymous-user-id@0.1.6-alpha.2`,
  pin 在
  [runtime/dsh/vendor/ensure-dsh.sh](../runtime/dsh/vendor/ensure-dsh.sh)
  (vendor pin 表,D6 纪律)。

## 1. 两个面,以及它们为何永不相遇

市场恰好有两个认证面,v0 把它们放在网络的两侧:

| 面 | v0 | 凭证持有人 |
| --- | --- | --- |
| **发布者**(写:目录 + 包) | 仅 owner | GitHub 凭证;CI 是行为主体身份 |
| **消费者**(读:发现 + 安装) | 匿名 | vendored 匿名设备 ID;手机上无登录、无 token |

发布者面是**生产侧**关切:它活在仓库与 CI 里。消费者面是**设备侧**关切:它活在
冻结的 `httpFetch` 原语与安装管线的 trust record 之后。本文任何内容都不把认证
搬到设备上;任何版本下,手机都不看见、不持有、不校验发布者凭证。

## 2. v0——发布者就是 owner;CI 是行为主体身份

v0 **根本不存在 token 物件**。发布权限恰等于仓库写权限,发布动作是一次 CI 运行:

1. owner(或有仓库写权限的维护者)合并喂给目录的变更——插件源码、版本、
   index 生成器的输入。
2. CI(GitHub Actions,与市场提案中持有 ed25519 目录签名键的同一信任面)
   构建包 tarball,计算 `blobSha256` / `manifestSha256` trust record,给
   `index.json` 签名,并把工件上传到静态托管。
3. 涉及的凭证只有 GitHub 自己的——Actions secrets 里的 workflow
   `GITHUB_TOKEN` / 部署凭证。

这与 vendor pin 表(D6)同一形状:真相登记处是仓库,动手的机器是 CI,没有人
需要经手市场专属凭证。这也是市场 CI/CD 线已经假设的形状——发布流不需要新的
身份系统,用仓库现有的即可。

**保管红线:**签名键与 GitHub 凭证活在 Actions secrets / 仓库的键保管里,
绝不入 git;任何地方都没有初始管理员口令,因为没有可管理的账号。

## 3. v1——发布 API 出现时的 token 模型

在此点名,让 v0 的形状演进时不必返工;本次变更不实现它。当第三方可以通过
注册服务推送包时(提案的 v1 演进),凭证是**短时的、PAT 形态的 bearer token**:

- **形态。** 一个看似不透明的签名信封 `dshpub-v1.<claims>.<sig>`:claims 写明
  签发者(IdP)、发布者主体、受众(`dsh-marketplace-publish`)、scope
  (`publish`)与签发/过期时间。**生命周期有界——按小时计,不按月计**(工作
  取值 1 小时,上限 8 小时)。永不过期的 PAT 形态 token 是泄露隐患,不是凭证。
- **签发走 IdP。** 提案 v2 演进中点名的 OIDC 身份提供方被前移来服务 v1 签发:
  CI 用 GitHub Actions OIDC 身份按次换取短时发布 token(永不存储长期密钥);
  人工本地发布则通过 IdP 登录铸取。IdP 是唯一签发者。
- **校验完全在发布 API 侧。** 注册服务在入口校验签名 + claims(签发者允许表、
  受众、scope、过期窗口,以及按 token `jti` 的 deny-list 吊销)。手机不做任何
  发布者 token 校验——它根本收不到一个。
- **不变的东西。** 客户端契约(冻结的包格式、安装器 trust record、
  `httpFetch`)原封不动;发布侧认证不增加任何客户端可见的东西。目录签名层
  仍是消费者侧的信任——有效的发布者 token 只让条目*可发布*,绝不*可安装*;
  安装仍需签名 index 与匹配的摘要。

## 4. 消费点

| 版本 | 谁出示 | 出示什么 | 给谁 | 终点 |
| --- | --- | --- | --- | --- |
| v0 | CI(在 owner 的合并上) | 仓库持有的签名键 + `GITHUB_TOKEN` | 静态托管 / GitHub | 市场发布流 |
| v1 | 发布者 CI 或工具 | 短时 `dshpub-v1` bearer | 发布 API(Verdaccio 兼容) | 市场发布流 |
| 两者 | 手机 | **发布者侧什么也不出示**——匿名设备 ID 走 `httpFetch` | 静态托管 / 注册服务(只读) | 仅发现 + 安装 |

市场发布流是发布者身份的**唯一**消费点。终端用户在任何版本都不受影响:他们
始终是已 vendored 的匿名设备身份(`@deepseek-ai/dsh-anonymous-user-id`),
设备上没有账号、没有登录、没有发布者 token。

## 5. 与 profile manifest(#268)的有意不耦合

profile-manifest 提案(#268)回答**消费侧**问题:某个 profile 想要哪些包、
何时升级。本文回答**生产侧**问题:谁有权往目录里写。两者不共享字段、不共享
身份、不共享流程——唯一交汇点是市场提案已固定的目录条目格式。升级策略变更
不需要发布者 token 变更,反之亦然;两份文档互不引用对方的模型。

## 6. Gateway 原语勘察:结论

**不需要任何新 gateway 原语。不提案任何一个。无 D5 停机。**

- v0 发布流:只有仓库 + CI。它不触碰设备,因此不可能需要设备原语。
- v0/v1 消费流:发现与安装只读地走冻结的 `httpFetch` 原语,随后是带着现有
  trust record 的冻结安装管线——恰是提案自己的结论("零新 gateway 原语——
  该流骑 `httpFetch` 与既有安装管线")。
- v1 发布 API:服务器侧(仓库/注册服务)关切。客户端行为是仅下载、无变化,
  因此不出现任何客户端原语。
- 唯一会打开 gateway 面的假想情形——从手机上发布或创作——需要设备上的凭证/
  认证写面,它在 v0/v1 中明确越界,在此点名以防它靠漂移抵达:它必须先走
  D5 提案。

流程规则注:发布流是 CI(合并上的一个事件),不是轮询循环,与 D8 一致;
任何组件都不轮询另一组件的状态。

## 7. 随本文交付的地基:mock 校验器

[仅为 v1 备地基——没有任何东西调用校验器:不接服务、不接门禁命令、无运行时
调用方。] v1 token 信封的纯函数校验器随本文一并交付,作为设计证据:

- `tools/publisher-token.mjs` —— `validatePublisherToken(token, options)`:
  格式、claims 模式、受众/scope/过期规则(注入 `now`)、一条拒绝长时 token 的
  最大生命周期规则,以及注入的签名校验回调,使函数保持纯与离线。
- `tools/publisher-token.test.mjs` —— 同址 vitest 套件,含反例腿:过期、
  错受众、缺 scope、超上限生命周期、坏签名、畸形信封。先证伪再还原:先让
  一个刻意无规则的实现对套件运行(RED),再由真校验器还原(GREEN)——
  提交在库里的反例就是那次证伪的永久记录。该套件作为 `gates` 工作流
  job 里的一道 CI step 持续运行(`tools/test/run-tools-tests.sh`,在门禁
  DAG 之后、物料化后的树上)——PR #285 评审指出手动可跑的网保护不了任何
  东西,此后校验器回归会让 CI 变红。

## 8. 安全注记

- 任何凭证、密钥、口令不入 git——v0 无可泄露之物,v1 的 token 短时且按次铸取。
- 危害面地图:v0 的爆炸半径是仓库/CI 信任面本身(与持有 vendor pin、目录键的
  同一个);v1 的是一个数小时内过期的 token,可在发布 API 侧按 `jti`
  deny-list 吊销。
- 消费者面不因发布者认证而长出认证面:目录签名(ed25519、pin 键、双签轮换)
  仍是手机行使的唯一信任。
