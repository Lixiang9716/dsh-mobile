# GitHub owner 网页动作清单(GitHub owner actions)

仓库的代理 workforce 手里没有仓库管理 PAT:本清单里的每一项都是只有 owner
能在 GitHub 网页上点的开关。每条都写清 **入口**(具体设置路径)、
**为什么**(不开会坏什么、漏什么)和 **完成标志**(事后核对的状态)。
代理能准备文件和工作流,但下面的开关是 owner 的手。

下文的仓库状态事实是 2026-09-30 用 API 只读核验的
(`gh api repos/Lixiang9716/dsh-mobile` 与
`gh api .../branches/main/protection`);若时日已过,动手前先重查:

- `main` 的 required status checks:目前只有 `gates`。
- Dependabot alerts:**关闭**(`gh api .../vulnerability-alerts` 返回
  404 "Vulnerability alerts are disabled")。
- Dependabot security updates:**关闭**。
- Secret scanning:**已开**;push protection:**已开**。
- Discussions:**关**。Pages:**关**。
- 三个打包工作流目前都还没有声明 `environment:`。

---

## 1. 打开 Dependabot security updates

- **入口**:Settings → **Code security** → Dependabot,按这个顺序:
  1. **Dependabot alerts** → **Enable**——这是前置,不是可选项。
  2. **Dependabot security updates** → **Enable**。
- **为什么**:版本更新已由 `.github/dependabot.yml` 接管(每周、group 合并:
  `github-actions` 管所有 workflow,`npm` 管带锁文件的
  `test/upstream-suite`)。那个节奏是按计划表升 pin;security updates 则是
  公告(advisory)一落地就对被 pin 的版本开 PR,不用等最长一周的下一次
  计划扫描。两者自动叠加——文件里没有、也不需要按 ecosystem 配安全开关。
- **为什么 alerts 在前**:security updates 是*由* Dependabot alerts *触发*的
  ——GitHub 文档明言该功能 "is available for repositories where you have
  enabled the dependency graph and Dependabot alerts",而 grouped security
  updates(正是 `dependabot.yml` 里 `npm` 组用的形态)额外要求 alerts 先开。
  alerts 关着,security updates 开关就没有公告来源:开关本身会不会拒绝启用
  无法只读验证,但可观察的失败更糟——开关显示已开,**Security** 页永远空白,
  这一项看起来完成了,实际上什么都不会发生。先开 alerts,Security 页同时
  也是验证面。
- **现状**:两者都关(API 核验,见上文事实)。
- **完成标志**:Dependabot alerts 显示 Enabled,security updates 开关显示
  Enabled,且 **Security** 标签页列出 Dependabot alerts(及其安全更新
  PR)——而不是一片空白。

## 2. 把 `ci-verdict` 检查设为 `main` 的 required

- **入口**:Settings → **Branches** → `main` 的保护规则 → 编辑 →
  **Require status checks to pass** → 添加 **`ci-verdict`**(保留
  **`gates`**;GitHub 正在把这个页面迁往 Settings → Rules → Rulesets——若
  branch-protection 页面出现迁移横幅,就在那边做同样的修改)。
- **为什么**:这是一笔老欠账。三条平台流水线都带 path 过滤,纯文档 PR 一条
  都不会触发——把任何一条平台流水线设为 required 都会让它永远停在
  "expected",把合并卡死。`ci-verdict` 不带 path:它总是运行,结论由 head
  commit 上实际存在的每次 check run 推导,没运行的 leg 会被点名说出
  (见 `.github/workflows/ci-verdict.yml` 的文件头)。把它设为 required,
  "gates 绿了"和"跑了的都绿了"之间的缝就合上了。
- **操作细节**:检查名就是 `ci-verdict`(job id;该 job 没设显示名)。若
  选择器里还列不出来,就手动输入名字——选择器只列出至少跑过一次的检查。
- **Merge queue——先想清楚再动,别顺手开**:required checks 打开后,
  GitHub 会顺势建议开 merge queue,让"head 上绿"不至于悄悄变成"合并后红"。
  诚实的背景:`docs/decisions.md` 的 **D13** 记录过一次对
  `merge_group`/merge queue 的否决——但那次否决限定在另一个问题上(绕开
  release PR 的 check 来源问题:"it changes the merge model of the whole
  repository to work around one PR's provenance")。它不会自动外延,但
  merge queue 确实改变整个仓库的合并模型,而本仓库靠 owner 常设授权做
  squash 合并。建议:现在就把 `ci-verdict` 设为 required;merge queue 只在
  交错合并真把合并后的 main 弄坏过之后再重新考虑,并且作为独立评审过的
  决策落地。
- **本次刻意不推荐**:"Require review from Code Owners"
  (`.github/CODEOWNERS` 现已存在)。required reviews 为 0 是刻意的——
  那个文件是路由声明,不是闸;把它翻开会给每一次自动合并都加一道人工审批。
- **完成标志**:`main` 的 required checks 同时列出 `gates` 和 `ci-verdict`。

## 3. 建 `release` 环境,required reviewer 设为 owner

- **入口**:Settings → **Environments** → **New environment** → 名称:
  `release` → **Required reviewers** → 添加你自己 → **Protect**。
- **为什么**:这一步把"发布需要明确的 go"从约定变成机械审批闸——每次
  tag push,打包 job 都会暂停,等 reviewer 批准才继续。
- **顺序警告——只建环境,什么都闸不住。** 三个打包工作流目前没有引用任何
  environment(已核验:`release-ios.yml` 的 job `ios-package`、
  `release-android.yml` 的 job `android-package`、`release-harmony.yml` 的
  job `harmony-package` 都没有 `environment:` 键)。没有 job 引用的环境是
  摆设。所以:
  1. 建 `release` 环境、required reviewer 设为自己(本页,owner 动作)。
  2. 然后落一个小 PR,给三个打包 job 加上 `environment: release`。
  两个方向顺序都不能反:先改工作流后建环境,每次发布都会红(引用不存在
  环境的 job 起不来);只建环境不改工作流,它就摆在那里看着像闸,实际
  什么都没闸。
- **完成标志**:环境存在、有一个 required reviewer,且三个打包 job 已声明
  `environment: release`(第 2 步已落地)。

## 4. 打开 Discussions

- **入口**:Settings → General → **Features** → 勾选 **Discussions** →
  **Set up discussions**。
- **为什么**:这是内测反馈的通道。默认分类集(Announcements、Ideas、
  Polls、Q&A——以 Q&A 作为自由讨论区)起步够用;内测流量提出需求后再调。
- **现状**:关(已核验)。
- **完成标志**:仓库的 **Discussions** 标签页能打开。

## 5. 配置 Pages(要在 Pages 工作流落地之前)

- **入口**:Settings → **Pages** → **Build and deployment** → **Source** →
  **GitHub Actions**。
- **为什么**:另一条线会落地一个 Pages 部署工作流。Pages 没配置时,那个
  工作流的 deploy 段不可能成功——只有工作流本身是不够的,这正是这里点名
  的原因:该工作流合并时(或之前)把开关打开,否则它的第一次运行就死在
  deploy 步骤上。
- **现状**:关(已核验——`has_pages: false`)。
- **完成标志**:Pages 设置页显示 Source = GitHub Actions(工作流落地前,
  部署列表为空是正常的)。

## 6. Secret scanning——无需动作

- **现状**:secret scanning **和** push protection 都**已开**(已核验)。
  没有开关要动;写这一条是为了避免有人去找一个本来就已经打开的开关。
  (Validity checks 目前是关的;保持关闭没问题——打开它是可选的额外项,
  不在本清单范围内。)

---

- 双语对侧:[github-owner-actions.md](github-owner-actions.md)
- 相关:[release.zh.md](release.zh.md)(`release` 环境闸住的那个
  tag-push 发布模型)
