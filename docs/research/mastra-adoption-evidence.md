# 调研:mastra 采用度与需求证据

> 调研 ticket:[#150](https://github.com/0xnicholas/oribos-framework/issues/150)(地图 [#149](https://github.com/0xnicholas/oribos-framework/issues/149) 子票)。快照日期:**2026-10-11**。
> 定位:为定位根裁决供**市场事实底座**——采用度硬数据、需求归因证据、生态位对照;不做新裁决。mastra 版本面等存量事实沿 [`mastra-gap-analysis.md`](./mastra-gap-analysis.md) 第三版(同快照)不重抓;本文全部是本轮新抓的采用度/需求侧数据。
> 数据源纪律:每条事实带来源 URL;一手 API(npm downloads API / npm registry / GitHub REST / HN Algolia)优先,公司自述与二手报道标注属性;查不到/不可核验的如实标注,不编。

## TL;DR

1. **采用度硬数据**:`@mastra/core` 周下载 26 周内 68.8 万 → 峰值 220.6 万(2026-09-27 周)→ 最近周 188.6 万,约 **2.7 倍增长**;量级在 TS agent 框架第一梯队(@langchain/langgraph 的 ~0.55 倍、@openai/agents 的 ~0.94 倍、ai SDK 的 ~1/15)。GitHub 28,694 星 / ~695 贡献者;**发版节奏极快**:2026-04 至 09 稳定版 261 个,约 10 个/周。星数增长 2026 年内明显减速(1.0 时 ~22k → 现 28.7k,9 个月 +6.7k),与下载曲线背离——星数跟营销走,下载跟生产用量走。
2. **需求归因**:可观察信号一致指向 **TS 原生 + batteries-included DX + 上手体验**是自述采用理由的主轴,公司背景(Gatsby 团队 / YC W25 / $35M 融资)是营销放大器(HN 上有明确反噬证据)。重型功能实际采用**薄**:voice 附装率 ~1.5%、@mastra/react ~2%、RAG ~9%、evals ~12%,而 memory/observability/server/deployer 附装率 ~50% 上下;OM 有官方 workshop 与零散社区回声,但 npm 无法分离 OM 与基础 memory 用量。即:用户为「全栈 TS 框架的核心环(agent/workflow/memory/observability)」来,不为重型长尾功能来。
3. **生态位对照**:「极致轻量」在 TS agent 框架选型话语中**几乎不以体量/依赖数的词汇出现**;被在意的近义轴是「框架 vs 库/不引入框架」(overhead、opinionated、可弹出)与「edge/Workers 可部署性」(mastta 自身 issue 里 bundle size 是真实部署阻塞痛)。市场结构上,lean 基元层(ai SDK 27.5M/周)是默认项,框架是可选项;未找到用户公开以字节数/依赖数为首要选型理由的实例(如实标注为阴性发现)。

## 口径与局限

- **npm 下载数** = registry 计数,含 CI/镜像放大,且 mastra 族包互相依赖(`@mastra/memory` 等依赖 `@mastra/core`)造成 fan-in 放大;跨包比较只作量级参考。来源:`https://api.npmjs.org/downloads/range/2026-04-12:2026-10-10/<pkg>`(本轮逐包抓取,26 个完整 7 天桶)。
- **最近一周(2026-10-04..10-10)全市场普跌**(core -15%、ai -20%、langgraph -24%、@openai/agents -18% 同向),判为 npm 侧/季节性噪声;趋势判断用峰值周与 4 周均值,不单读最近一周。
- **star 日级曲线不可得**:GitHub stargazers 列表端点对本环境凭证不可用(REST 404 / GraphQL totalCount 0,vercel/ai 同样,判为平台侧限制而非 mastra 特有);web.archive.org 本环境不可达;star-history SVG 为手绘风位图不可机读。故 star 增长只能用**带日期的二手报道里程碑点**拼,粒度受限,已逐点标注。
- **GitHub Discussions 不存在**(`has_discussions=false`,[API](https://api.github.com/repos/mastra-ai/mastra));社区阵地在 Discord(README 徽章 `discord.gg/mastra-ai`)。Discord 总成员数不可程序化核验(invite API 本环境返回空);[shields 徽章](https://img.shields.io/discord/1309558646228779139.json)显示抓取时 **594 online**(只是在线数,非成员数)。
- issue 关键词计数来自 [GitHub search API](https://docs.github.com/en/rest/search/search)(`repo:mastra-ai/mastra ... is:issue`),含标题/正文匹配噪声,只作相对热度代理。
- GitHub code search 计数(`"包名" in:file filename:package.json`)含示例/教程/ fork 噪声,同样只作代理。

## 1. 采用度硬数据

### 1.1 npm 周下载与近半年趋势(2026-04-12 .. 2026-10-10,26 个完整周桶)

来源:npm downloads API(逐包 range 抓取,下同);单位 = 次/周。

| 包 | 首周(04-12) | 峰值周 | 最近周(10-04) | 首周→最近 | 26 周总量 |
| --- | --- | --- | --- | --- | --- |
| `@mastra/core` | 688,076 | 2,206,175(09-27 周) | 1,885,667 | **2.74x** | 31.8M |
| `mastra`(CLI) | 295,199 | 930,664(09-27 周) | 829,237 | 2.81x | 13.4M |
| `create-mastra`(脚手架) | 4,396 | 11,185(07-05 周) | 7,935 | 1.81x | 148k |
| `@mastra/memory` | 354,929 | 1,121,931(09-27 周) | 1,023,185 | 2.88x | 17.1M |
| `@mastra/observability` | 268,182 | 1,191,368(09-27 周) | 1,049,870 | 3.92x | 15.7M |
| `@mastra/server` | 364,160 | 1,151,402(09-27 周) | 1,018,610 | 2.80x | 16.0M |
| `@mastra/deployer` | 306,379 | 1,046,926(09-27 周) | 938,302 | 3.06x | 14.0M |
| `@mastra/pg` | 228,734 | 1,023,229(09-27 周) | 916,087 | 4.01x | 12.9M |
| `@mastra/mcp` | 221,538 | 683,616(09-27 周) | 650,262 | 2.94x | 9.7M |
| `@mastra/libsql` | 156,226 | 484,679(09-27 周) | 406,814 | 2.60x | 7.2M |
| `@mastra/evals`(scorers) | 85,504 | 268,869(09-27 周) | 234,409 | 2.74x | 4.1M |
| `@mastra/client-js` | 118,909 | 255,568(09-27 周) | 232,949 | 1.96x | 4.7M |
| `@mastra/rag` | 59,410 | 187,184(09-27 周) | 164,674 | 2.77x | 2.6M |
| `@mastra/react`(公共 hooks) | 5,196 | 40,294(最近周) | 40,294 | **7.75x** | 351k |
| `@mastra/voice-openai`(voice 族代表) | 7,962 | 31,935(09-27 周) | 28,802 | 3.62x | 398k |

**对照族**(同一 API 同窗口):

| 包 | 首周 | 峰值周 | 最近周 | 首周→最近 | 最近周 / `@mastra/core` |
| --- | --- | --- | --- | --- | --- |
| `ai`(Vercel AI SDK) | 11,461,023 | 34,162,045(09-27 周) | 27,474,948 | 2.40x | **14.6x** |
| `@langchain/langgraph` | 2,038,667 | 4,500,759(09-27 周) | 3,427,412 | 1.68x | 1.82x |
| `@openai/agents` | 542,746 | 2,444,016(09-27 周) | 2,008,601 | 3.70x | 1.07x |
| `@voltagent/core` | 9,520 | 50,788(09-27 周) | 37,345 | 3.92x | 0.020x |

读法:

- mastra 属于 TS agent 框架**第一梯队**:与 @langchain/langgraph、@openai/agents 同量级;但底座层 `ai` 是它的 ~15 倍——**lean 基元层是市场默认项,框架是可选层**。
- 全体包族首周→峰值周普遍 ~2.5-3x,`@openai/agents`(3.7x)与 `@mastra/react`(7.8x,基数小)增长更陡;`create-mastra` ~8k/周 ≈ 新项目创建速率的可观测量级。
- **附装率**(最近周 / `@mastra/core`,口径见 §2.3):memory 54%、observability 56%、server 54%、deployer 50%、pg 49%、mcp 34%、evals 12%、client-js 12%、rag 8.7%、react 2.1%、voice-openai 1.5%。

### 1.2 GitHub star / 贡献者 / 发版节奏

一手实测([GitHub REST](https://api.github.com/repos/mastra-ai/mastra),2026-10-11):

- **28,694 星** / 2,948 fork / 105 watchers / 515 open issues;repo 创建 2024-08-06;抓取当日仍有 push(2026-10-11T04:07Z)。
- 贡献者规模:**~695**(contributors 端点 `per_page=1&anon=true` 分页尾页,[API](https://api.github.com/repos/mastra-ai/mastra/contributors))。
- 对照(同刻实测):[vercel/ai](https://api.github.com/repos/vercel/ai) 27,233 星、langchain-ai/langgraphjs 3,344 星、openai/openai-agents-js 3,903 星、VoltAgent/voltagent 10,768 星。**mastra 星数高于 vercel/ai,而 npm 下载只有其 1/15**——星数跟踪营销引力,不跟踪用量。

star 增长(二手带日期里程碑,粒度受限,口径见「口径与局限」):

| 日期 | 星数 | 来源 |
| --- | --- | --- |
| 2025-02-19 | 首次 [Show HN](https://news.ycombinator.com/item?id=43103073)(442 points) | HN |
| ~2026-01-20(1.0) | 22,000+ | [noqta 教程](https://noqta.tn/en/tutorials/mastra-typescript-ai-agents-production-guide-2026)、[effloow](https://effloow.com/articles/mastra-ai-typescript-agent-framework-guide-2026) |
| 2026-04 | 22.7k | [tinyagents.dev 对比页](https://tinyagents.dev/vs/anthropic-sdk-vs-mastra)(注明 "as of April 2026") |
| 2026-05 | 23k | [稀土掘金实战文](https://juejin.cn/post/7635832321266581554) |
| 2026-08-10 | ~26.9k | [systhoughts 对比文](https://systhoughts.com/posts/mastra-vs-flue-2-0-typescript-agent-frameworks)(注明 "at the time of writing") |
| 2026-09 | 27k+ | [mastra 官方招聘帖](https://dynamitejobs.com/company/mastra/remote-job/customer-engineer)("0 to 27k+ stars ... in under 18 months",公司自述口径) |
| 2026-10-11 | 28,694 | GitHub REST 实测 |

→ 1.0(2026-01)到现 ~+6.7k/9 个月,**星数增长显著减速**,与同期 npm 下载 2.7x 背离。

发版节奏(npm registry `time` 字段实测,`@mastra/core` 稳定版,不含 alpha/beta):

| 月份 | 稳定版个数 |
| --- | --- |
| 2026-04 | 73 |
| 2026-05 | 48 |
| 2026-06 | 50 |
| 2026-07 | 37 |
| 2026-08 | 27 |
| 2026-09 | 26 |
| 2026-10(前 11 天) | 39 |

→ 近半年 **~10 个稳定版/周**(含 patch);另有 alpha 线并行(1.76.0-alpha.7,沿 gap-analysis 钉)。latest `1.75.0` 发布时间 [2026-10-07T08:53Z](https://registry.npmjs.org/@mastra%2Fcore)。包创建于 2024-10-02(registry `created`),1.0 于 2026-01-20([Show HN: Mastra 1.0](https://news.ycombinator.com/item?id=46693959),213 points / 70 comments)。

## 2. 需求归因证据

### 2.1 公司背景、融资与营销面

- **团队**:[YC 公司页](https://www.ycombinator.com/companies/mastra)——2024 年由 Sam Bhagwat、Abhi Aiyer、Shane Thomas(Gatsby 团队)创立,YC W25 批次,员工 30 人。
- **融资**:累计 ~$35M。$13M seed(Gradient、Y Combinator、Paul Graham、Guillermo Rauch 及 120+ 天使,来源 [Day One Jobs 公司档案](https://www.dayonejobs.com/company/mastra);**官宣日期二手来源相互矛盾**——[brahmalabs](https://www.brahmalabs.io/compare/mastra-vs-brahmalabs/) 记 "October 2025",[Apify](https://blog.apify.com/best-ai-agent-frameworks/) 记与 1.0 同于 2026-01 宣布,如实标注矛盾)。$22M Series A 于 **2026-04-09** 宣布([Open Orchestrators](https://openorchestrators.org/news/mastra-series-a-agent-platform/)、[FundedStartupsDaily](https://www.fundedstartupsdaily.com/company/mastra/);Spark Capital 在投资者列,见[招聘帖](https://www.jobleads.com/us/job/customer-engineer--northern--e1ea610bae14a35cf70728f2bb727051a))。
- **许可证动作**:2025-07-09 由 Elastic License v2 改为 Apache 2.0,理由是 enterprise-adoption 摩擦(二手:[brahmalabs](https://www.brahmalabs.io/compare/mastra-vs-brahmalabs/),本环境未独立核验到官方公告,标注为二手)。
- **营销机器**:两次 Show HN 均以 "from the Gatsby devs" 为标题([2025-02](https://news.ycombinator.com/item?id=43103073)、[2026-01 1.0](https://news.ycombinator.com/item?id=46693959));官网首页自称 "the leading TypeScript agent framework"、落地页 FAQ 头条化 scorers/observability/OM([mastra.ai 抓取](https://mastra.ai));官方出书《Principles of Building AI Agents》(HN 线程内自述);联合 PR(OpenBox AI 治理集成,[PR Newswire 2026-05-04](https://www.prnewswire.com/news-releases/openbox-ai-and-mastra-bring-default-runtime-governance-to-every-typescript-agent--as-enterprises-brace-for-an-agentic-security-reckoning-302759944.html))。
- **公司自述生产用户**(公司口径,非独立核验):Replit、Brex、MongoDB、Workday、Salesforce、Sanity、SoftBank、Marsh McLennan(上引 PR Newswire);PayPal、Adobe([Day One Jobs](https://www.dayonejobs.com/company/mastra))。独立案例:[SoftBank 客户故事](https://mastra.ai/customers/softbank)(mastra.ai 官网,2025-08-20);HN 1.0 线程中 swyx 转引 Brex CTO 在 Latent Space 的采用表述。HN 1.0 线程 mastra 官方还自述 Sanity(content agent 进 CMS)、Factorial(HR/payroll 内嵌 agent)、Workday/PayPal(agentic SRE)。
- **公司自述下载口径与 registry 不符(标注)**:PR Newswire(2026-05)称 "more than 2 million downloads a month";同期 npm API 实测 `@mastra/core` 单包即 ~90-100 万/周(≈4M/月)。公司数字反而低于 registry 实测,两口径不可对齐,只作"公司在做采用度营销"的证据,不作数值依据。

### 2.2 用户因什么采用——可观察信号

按信号强度排序:

1. **TS 原生栈契合**(最多、最一致):HN 1.0 线程用户原话 "We use typescript for all our entire stack and it's super dope to see a production-grade framework (with no vendor lock in) launch"([线程](https://news.ycombinator.com/item?id=46693959));SoftBank 案例引技术负责人 "Mastra's TypeScript-native approach and flexible agent architecture gave us exactly that"([mastra.ai/customers/softbank](https://mastra.ai/customers/softbank));第三方对比文一致把 "TypeScript-first、非 Python 移植" 列为首要差异([The Agents Index](https://theagentsindex.com/guides/ai-agent-framework-comparison-2026/)、[SandBase](https://blog.sandbase.ai/mastra-typescript-agent-framework-2026/));公司口号 "Python trains, TypeScript ships"([Apify](https://blog.apify.com/best-ai-agent-frameworks/))。
2. **batteries-included DX / 单一框架免拼装**:[workflowbuilder.io](https://www.workflowbuilder.io/blog/best-ai-agent-frameworks) "Mastra's real advantage ... is its batteries-included developer experience";[developersdigest](https://www.developersdigest.tech/blog/typescript-ai-agent-stack-2026) 把 mastra 的 sweet spot 定为 "want a single framework covering agents, memory, evals, and deployment without assembling the pieces yourself";HN 1.0 线程用户心智模型:"Vercel AI SDK = library, low level; Mastra = framework"。
3. **上手体验 / 本地开发面(Studio、create-mastra)**:[mattderman 评测](https://mattderman.com/blog/comparing-the-best-ai-agent-frameworks-and-which-one-you-should-pick) "you can get started in a few minutes ... dev server, an API, and UI ... view traces";`create-mastra` 实测 ~8k 次/周(§1.1)是上手漏斗的硬信号。
4. **集成面**:90+ provider 模型路由(官网 FAQ)、MCP 双向([braintrust 对比](https://www.braintrust.dev/articles/best-ai-agent-frameworks-2026))、Telex/A2A 集成被 [dev.to 用户](https://dev.to/ursulaonyi/building-an-ai-news-digest-agent-with-mastra-and-telexim-3p1h) 列为选型首因。
5. **公司背景 = 放大器,且有反噬证据**:HN 1.0 线程高亮评论 "If I had some heartfelt advice for the Mastra devrel team it would be to shut up about Gatsby ... only going to matter to non-technical CXOs who choose technology based on names not merits"([线程](https://news.ycombinator.com/item?id=46693959))——Gatsby 出身对 CXO/信任状有用,对一线开发者中性甚至负面。

**反面信号(同样计入)**:HN 1.0 线程有用户自述因 "batteries included and opinionated" 在不适配既有模式时生产力下降、正把系统重建迁离 mastra(同一线程);这类 "重框架不适配即弃" 的轶事与 §3 的轻量诉求同源。

### 2.3 重型功能的实际采用证据

三层代理互相印证(口径与噪声见「口径与局限」):

**npm 附装率**(最近周下载 / `@mastra/core` 最近周):voice-openai **1.5%**、@mastra/react **2.1%**、@mastra/rag **8.7%**、@mastra/evals(scorers)**12.4%**、@mastra/mcp 34%、@mastra/memory 54%、@mastra/observability 56%、@mastra/server 54%、@mastra/deployer 50%。

**GitHub code search**(公开仓 package.json 含该依赖的文件数):`@mastra/core` 5,600;`@mastra/memory` 3,072(55%);`@mastra/mcp` 976(17%);`@mastra/evals` 662(12%);`@mastra/rag` 453(8%);`@mastra/voice-openai` 103(1.8%);`@mastra/react` 28(0.5%)。

**issue 热度**(`is:issue` 关键词计数):workflow 636、observational memory 211、studio 195、mcp 188、scorer 174、voice 78、rag 38;另:edge runtime 62、cold start 55、bundle size 35、dependencies(标题)27。

读法:

- **采用集中在核心环**——agent/workflow/memory/observability/server(附装率 ~50%)——这正是「全栈 TS 框架」的价值面;**重型长尾(voice、react hooks、rag、scorers)附装率个位数到十几个百分点**,与它们在落地页 FAQ 的营销权重不成比例。
- **OM(观察记忆)**:2026-02 推出,有官方 workshop 仓([mastra-ai/mastra-observational-memory-workshop](https://github.com/mastra-ai/mastra-observational-memory-workshop),2026-02-12,宣称 LongMemEval SOTA)、官方课程([mastra.ai/learn/observational-memory](https://mastra.ai/learn/observational-memory))与零散社区回声([稀土掘金实战 2026-05](https://juejin.cn/post/7635832321266581554)、[个人笔记 2026-02](https://ryanorban.com/notes/mastra-observational-memory/)、[neoneye agent-memory-atlas 条目 2026-09](https://neoneye.github.io/agent-memory-atlas/systems/mastra-observational-memory/));issue 计数 211 有一定热度。但 OM 是 `@mastra/memory` 内 opt-in 开关,**npm 无法分离 OM 与基础 memory 用量**——"OM 实装形态不变、落地页头条化是营销动作"(gap-analysis 第三版)与本文附装率证据互洽:**无证据表明重型功能面是下载增长的主驱动**。
- Studio:无独立 npm 包(随 CLI/云),无法计量;issue 热度 195 + 官网云化持续 = 活跃,但属产品面,不改变上述归因。

## 3. 生态位对照:「极致轻量」是否被在意

**阴性发现(如实记)**:本轮未检索到任何用户**公开以体量/依赖数作为 TS agent 框架首要选型理由**的实例。「轻量」被在意,但以另外三种词汇出现:

1. **「框架 vs 库/不引入框架」的 overhead 话语**(最普遍):[dev.to 选型文(2026-04)](https://dev.to/gabrielanhaia/mastra-in-2026-what-it-is-when-to-use-it-and-how-it-compares-2go1) 明确把 "Vercel AI SDK alone covers that without the overhead of a full framework" 作为不选 mastra 的条件分支;[tinyagents.dev](https://tinyagents.dev/vs/mastra-vs-vercel-ai-sdk) 的对抗定位原话 "No framework. No dependencies. No opinions. Just the code.";HN 经典帖 [Why we no longer use LangChain(2024-06,480 points)](https://news.ycombinator.com/item?id=40739982) 的 "you don't need a framework" 情绪在该生态持续有效。
2. **edge/Workers 可部署性 = 体量的实际痛点**:mastra 自身 issue 提供直接证据——[#3309](https://github.com/mastra-ai/mastra/issues/3309)(2025-03,29 评论:升级后 bundle 541 KiB → 22.4 MB,**阻塞 Cloudflare Workers 部署**)、[#11449](https://github.com/mastra-ai/mastra/issues/11449)(输出超 Cloudflare 体积上限)、[#16645](https://github.com/mastra-ai/mastra/issues/16645)(请求 tree-shaken 依赖进最终 bundle)、[#13379](https://github.com/mastra-ai/mastra/issues/13379)(构建期 "Optimizing dependencies" 耗时 ~32s)。即:**体量问题以「部署阻塞/构建耗时」的工程痛出现,不以「选型理由」出现**。
3. **opinionated / 可弹出性**:HN 1.0 线程的迁离轶事(§2.2 反面信号)与 mastra 官方回应("users need to be able to eject")说明被在意的是**架构侵入度**,与字节数正交但同源。

**市场结构判读**:

- lean 基元层是绝对默认项:`ai` 27.5M/周 ≈ `@mastra/core` 的 14.6 倍、`@langchain/langgraph` 的 8 倍;所有框架都在它之上做可选层([developersdigest](https://www.developersdigest.tech/blog/typescript-ai-agent-stack-2026) 的四层格局与组合建议)。
- 星数与用量倒挂(mastra 28.7k 星 > vercel/ai 27.2k 星,下载仅其 1/15)说明**该品类的公开热度被营销/发布事件驱动**,选型时的真实约束(部署面、侵入度、ejectability)与星数无关。
- 对 oribos 定位的含义(事实层,不作裁决):「极致轻量」的直接竞争话语是空位(无人公开以该词汇选型),但其近义痛点(edge 部署阻塞、框架 overhead、ejectability)有持续、可引用的公开证据;mastra 的体量痛以 issue 形式持续存在且未被解决为卖点。

## 附:来源清单

一手 API(本轮实测,2026-10-11):

- npm downloads API:`https://api.npmjs.org/downloads/range/2026-04-12:2026-10-10/{@mastra/core, mastra, create-mastra, @mastra/memory, @mastra/observability, @mastra/server, @mastra/deployer, @mastra/pg, @mastra/mcp, @mastra/libsql, @mastra/evals, @mastra/client-js, @mastra/rag, @mastra/react, @mastra/voice-openai, ai, @langchain/langgraph, @voltagent/core, @openai/agents}`
- npm registry:`https://registry.npmjs.org/@mastra%2fcore`(`time` 字段发版节奏、`created` 2024-10-02、latest 1.75.0 @ 2026-10-07)
- GitHub REST:`repos/mastra-ai/mastra`(28,694 星等)、`repos/mastra-ai/mastra/contributors`(~695)、`repos/{vercel/ai, langchain-ai/langgraphjs, openai/openai-agents-js, VoltAgent/voltagent}`、`search/issues`(issue 热度)、`search/code`(依赖附装)、issue [#3309](https://github.com/mastra-ai/mastra/issues/3309) / [#11449](https://github.com/mastra-ai/mastra/issues/11449) / [#16645](https://github.com/mastra-ai/mastra/issues/16645) / [#13379](https://github.com/mastra-ai/mastra/issues/13379)
- HN Algolia:[item 43103073](https://news.ycombinator.com/item?id=43103073)(2025-02-19,442 points)、[item 46693959](https://news.ycombinator.com/item?id=46693959)(1.0,2026-01-20,213 points / 70 comments)、[item 40739982](https://news.ycombinator.com/item?id=40739982)(LangChain 出走帖,480 points)
- shields.io Discord 徽章:[594 online](https://img.shields.io/discord/1309558646228779139.json)(总成员数不可核验)
- 官网:[mastra.ai 首页/FAQ](https://mastra.ai)、[SoftBank 客户故事](https://mastra.ai/customers/softbank)、[OM 课程](https://mastra.ai/learn/observational-memory)、[OM workshop 仓](https://github.com/mastra-ai/mastra-observational-memory-workshop)

公司/融资(公司口径或二手,文中已逐条标注):

- [Y Combinator 公司页](https://www.ycombinator.com/companies/mastra)、[PR Newswire 2026-05-04](https://www.prnewswire.com/news-releases/openbox-ai-and-mastra-bring-default-runtime-governance-to-every-typescript-agent--as-enterprises-brace-for-an-agentic-security-reckoning-302759944.html)、[Open Orchestrators Series A](https://openorchestrators.org/news/mastra-series-a-agent-platform/)、[FundedStartupsDaily](https://www.fundedstartupsdaily.com/company/mastra/)、[Day One Jobs](https://www.dayonejobs.com/company/mastra)、[dynamitejobs 招聘帖](https://dynamitejobs.com/company/mastra/remote-job/customer-engineer)、[jobleads 招聘帖](https://www.jobleads.com/us/job/customer-engineer--northern--e1ea610bae14a35cf70728f2bb727051a)、[brahmalabs 对比页(许可证变更)](https://www.brahmalabs.io/compare/mastra-vs-brahmalabs/)

选型话语与生态对照(二手/社区):

- [developersdigest:The TypeScript AI Agent Stack in Mid-2026](https://www.developersdigest.tech/blog/typescript-ai-agent-stack-2026)、[dev.to:Mastra in 2026](https://dev.to/gabrielanhaia/mastra-in-2026-what-it-is-when-to-use-it-and-how-it-compares-2go1)、[workflowbuilder.io](https://www.workflowbuilder.io/blog/best-ai-agent-frameworks)、[braintrust](https://www.braintrust.dev/articles/best-ai-agent-frameworks-2026)、[speakeasy](https://www.speakeasy.com/blog/ai-agent-framework-comparison)、[The Agents Index](https://theagentsindex.com/guides/ai-agent-framework-comparison-2026/)、[tinyagents.dev](https://tinyagents.dev/vs/mastra-vs-vercel-ai-sdk)、[mattderman](https://mattderman.com/blog/comparing-the-best-ai-agent-frameworks-and-which-one-you-should-pick)、[dev.to Telex 用户](https://dev.to/ursulaonyi/building-an-ai-news-digest-agent-with-mastra-and-telexim-3p1h)
- star 里程碑二手源:[noqta](https://noqta.tn/en/tutorials/mastra-typescript-ai-agents-production-guide-2026)、[effloow](https://effloow.com/articles/mastra-ai-typescript-agent-framework-guide-2026)、[tinyagents.dev](https://tinyagents.dev/vs/anthropic-sdk-vs-mastra)、[稀土掘金](https://juejin.cn/post/7635832321266581554)、[systhoughts](https://systhoughts.com/posts/mastra-vs-flue-2-0-typescript-agent-frameworks)
- OM 社区回声:[ryanorban 笔记](https://ryanorban.com/notes/mastra-observational-memory/)、[neoneye agent-memory-atlas](https://neoneye.github.io/agent-memory-atlas/systems/mastra-observational-memory/)

不可核验项(如实标注):Discord 总成员数;star 日级增长曲线(GitHub 端点受限 + archive.org 不可达 + star-history 不可机读);OM 专属 npm 用量;Elastic→Apache 许可证变更的官方公告原文(仅二手);$13M seed 官宣日期(二手矛盾);公司 "2M downloads/month" 口径。
