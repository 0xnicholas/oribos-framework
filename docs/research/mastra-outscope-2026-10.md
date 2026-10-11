# 调研:mastra 出域确认线——react-sdk / knowledge v2 / Studio 云化(2026-10 快照)

> Issue: [#144](https://github.com/0xnicholas/oribos-framework/issues/144) · 快照日: **2026-10-11** · 分支: `research/outscope-2026-10` · 性质: 出域事实确认(浅抓),**不做决策**——判定归 [#145](https://github.com/0xnicholas/oribos-framework/issues/145)。
> 来源版本基线: npm registry `@mastra/core` latest = **1.75.0**(2026-10-07 发布;alpha 线 1.76.0-alpha.7,registry modified 2026-10-10)、`@mastra/react` latest = **1.8.0**(2026-10-07);github.com/mastra-ai/mastra main(pushed_at 2026-10-11);mastra.ai 官方文档(2026-10-11 抓取)。
> 旧钉对比基线: **2026-10-02 快照**的出域档 7 行(`docs/ROADMAP.md` 延后清单 + `docs/research/mastra-gap-analysis.md` §4.3)= Studio / editor / stored agents、channels / voice / workspaces & sandboxes、托管平台、OM 类后台压缩、notification inbox、signal providers、AgentController。三条确认线中**仅 Studio 云化直接落在旧出域行**;react-sdk 与 knowledge v2 在旧钉中均未单列成行。

## TL;DR

- **三条线全部仍落在本框架出域档(产品面 / 生态)的判定范围内**,没有出现需要把任何一线拉回域内的事实;禁跟单纪律不变(mastra 有 ≠ 提升理由)。
- **react-sdk 线 = 纯客户端库**(确认票据假设):实体是既有包 `@mastra/react`(monorepo `client-sdks/react`),npm 上**不存在**独立的 `@mastra/react-sdk`;2026-10-05 的动作是把 Studio 自己的数据 hooks 搬进公共 `@mastra/react/hooks`——Studio 产品面改吃公共客户端 SDK,库本身不是托管产品面。
- **knowledge v2 线 = 正在落成的框架内原语**(确认票据假设):以 `@mastra/core/knowledge` 子路径导出进入 core(main / alpha 线,稳定版 1.75.0 尚无),不是独立产品或独立包;它本就不在出域档 7 行内,**不触及出域理由措辞**,事实行归 gap-analysis 第三版刷新。
- **Studio 云化持续活跃且性质不变**:官方文档已写明「Studio on Mastra platform」云端部署路径,近一周 PR 与 dist-tag 不断;仍正中出域档第 1 行(Studio / editor / stored agents,托管产品面)与第 3 行(托管平台,商业)——云化反而**加厚**既有出域理由。

## 1. 核实口径与来源

- npm registry  packument / 搜索端点:`registry.npmjs.org`(2026-10-11 实测;发布史一段经 `registry.npmmirror.com` 镜像复核,与主站一致)。
- GitHub REST API:分支、compare、PR 搜索、`packages/core/package.json`(main)。
- 官方文档:`mastra.ai/docs`(quickstart)与 `mastra.ai/docs/studio/overview`(2026-10-11 抓取)。
- 边界:每线只核实「是什么形态」,不做深源码分析;dist-tag 快照(`0.0.0-<tag>-<时间戳>`)按 mastra 惯例 = PR 分支构建,证明「在活跃开发」,不证明「已进稳定版」。

## 2. react-sdk 线:纯客户端库,不是托管产品面

| 事实 | 证据(2026-10-11 快照) |
| --- | --- |
| npm 上**没有**独立的 `@mastra/react-sdk` 包 | `https://registry.npmjs.org/@mastra%2Freact-sdk` 返回 `{"error":"Not found"}` |
| 实体 = 既有包 `@mastra/react`,latest **1.8.0**(2026-10-07T08:49:57Z);旧钉日(10-02)线上为 1.7.2(2026-10-01);包创建于 2025-10-01 | `https://registry.npmjs.org/@mastra%2Freact` |
| 快照 dist-tag `react-sdk = 0.0.0-react-sdk-20261005160725`(2026-10-05)同时挂在 `@mastra/core` 与 `@mastra/react` | 两包 packument 的 `dist-tags` |
| 分支 `react-sdk` 存在,tip commit 2026-10-05T15:46:17Z;compare `main...react-sdk` = **ahead_by 0 / behind_by 384**——该分支已全量并入 main,快照是「react-sdk 工作线收尾」的留痕 | `https://github.com/mastra-ai/mastra/tree/react-sdk`、`https://api.github.com/repos/mastra-ai/mastra/compare/main...react-sdk` |
| 形态:monorepo `client-sdks/react`;exports = `.` / `./ui` / `./chat` / `./hooks/*` / `./styles.css`;peerDeps = react>=19、react-dom、`@tanstack/react-query`、`@mastra/core`;deps 含 `@mastra/client-js`、shiki、radix-ui——**纯浏览器端 React hooks/UI 库,经 client-js 消费用户自部署的 Mastra server** | `@mastra/react@1.8.0` packument;`https://github.com/mastra-ai/mastra/tree/main/client-sdks/react` |
| 2026-10-05 的实质动作:[#25916](https://github.com/mastra-ai/mastra/pull/25916)「Move Studio data hooks to a public `@mastra/react/hooks` entry」+ [#25926](https://github.com/mastra-ai/mastra/pull/25926)(全 hooks 收 TanStack queryOptions)+ [#25950](https://github.com/mastra-ai/mastra/pull/25950)(hooks 按域拆入口) | `client-sdks/react` 提交史(2026-10-05) |

**判定范围内的落点**:`@mastra/react` 是 client-js 的 React 封装,属「产品面 / 生态」中的**客户端 SDK / UI 生态**一侧(gap-analysis §4 产品面行已点名 client-js;ROADMAP 出域档第 2 行承载缝 = 生态)。票据假设「react-sdk 是纯客户端库而非托管产品面」**成立**——它从头到尾不是托管面,10-05 的变化方向还是「产品面(Studio)改吃公共客户端库」,进一步把库与托管面分离。出域理由(产品面 / 生态)仍然覆盖,**无需修订 7 行出域档措辞**;gap-analysis 第三版刷新时可在事实行补一条性质注记(客户端库,非托管面)。

## 3. knowledge v2 线:正在落成的框架内原语,未进稳定版

| 事实 | 证据(2026-10-11 快照) |
| --- | --- |
| npm 上**没有**独立的 `@mastra/knowledge` 包 | `https://registry.npmjs.org/@mastra%2Fknowledge` 返回 `{"error":"Not found"}` |
| `@mastra/core` 快照 dist-tag:`knowledgev2`(2026-08-28)、`knowledge-org-scope`(2026-09-02)、`fix-knowledge-inspector-org-scope`(2026-09-03)、`knowledge-w2`(**2026-10-08**)、`knowledge-w1`(**2026-10-09**)、`knowledge-w2-demo`(2026-10-09)——与票据所指 10-08 / 10-09 吻合 | `@mastra/core` packument `dist-tags` |
| main 上 `packages/core/package.json`(version 1.76.0-alpha.7)含 **`./knowledge` 子路径导出**(共 88 个导出);稳定版 1.75.0 为 87 个导出、**无** `./knowledge`——已进 alpha 线,**未进稳定版** | `https://raw.githubusercontent.com/mastra-ai/mastra/main/packages/core/package.json`;`@mastra/core@1.75.0` packument |
| main 上存在 `packages/core/src/knowledge/`(`config.ts` / `index.ts` / `reconcile.ts`) | `https://github.com/mastra-ai/mastra/tree/main/packages/core/src/knowledge` |
| 形态(PR 自述):[#26302](https://github.com/mastra-ai/mastra/pull/26302)(open,10-07 创建 / 10-10 更新)「register importers on the canonical Knowledge model」——**Wave 2 of 4**;importer 注册(稳定 ID、source 身份、scoped authority、触发元数据)+ keyed `Knowledge` 运行时挂在 `@mastra/core/knowledge` 导出;scope nodes / memberships 模型与 **Factory reads、Subconscious capture、SDK inspector** 共享;LibSQL / PostgreSQL 从「published v1 layout」做存储升级 | PR #26302 body |
| 同批在途 PR(均 2026-10-10 更新):#26304 静态导入操作、#26305 replay-safe 触发器、#26306 agentic 导入对账、#26307 Factory 暴露 importer 历史、#26308 / #26309 导入流测试、#26453 删除节点修复 | GitHub PR 搜索 `repo:mastra-ai/mastra knowledge in:title` |

**判定范围内的落点**:票据假设「知识线变成框架内原语而非产品」**成立**——knowledge v2 以 core 子路径原语成形(带存储域与多 wave 计划),而非独立产品包;但它同时为云上产品(Factory / Subconscious / inspector)提供共享 scope 模型,带明显的产品面供血性质。关键:**knowledge 线不在旧出域档 7 行之内**(旧钉近邻是延后档「RAG / 语义召回」,承载缝 = memory 落库 hook + 能力包),因此它**不触及任何出域行的理由措辞**;其事实行新增与分档(是否影响 RAG 延后行)归 gap-analysis 第三版刷新与 #145 判定,本票不裁决。

## 4. Studio 云化线:持续活跃,性质不变(托管产品面)

| 事实 | 证据(2026-10-11 快照) |
| --- | --- |
| 云化 dist-tag 链(均在 `@mastra/core`):`playground-studio-cloud`(2025-10-31)、`bundle-studio-cloud`(2025-12-22)、`testing-cloud-studios` / `test-cloud-studio`(2026-01-14/15)、`vercel-studio`(2026-02-27)、`standalone-studio-base-path`(2026-03-02)、`studio-deploy`(2026-04-04)、`studio-cli`(2026-05-04)、`fix-studio-trace-thread-hide-om`(2026-09-30)、`unified-sidebar`(2026-10-10) | `@mastra/core` packument `dist-tags` |
| 官方文档写明双形态:「Run it locally during development … **deploy it to production using Studio on Mastra platform** or your own infrastructure」 | [Studio overview](https://mastra.ai/docs/studio/overview)(2026-10-11 抓取) |
| quickstart 仍以 Studio 为开箱 UI:「You can open Studio immediately, which is an interactive UI for your Mastra project」 | [mastra.ai/docs](https://mastra.ai/docs)(2026-10-11 抓取) |
| 近一周 PR 不断:#26633(closed,10-10)、#26447 `auth-studio` Studio/Factory 会话保活(closed,10-09)、#26449 playground 接入 Studio chat 连接请求(open,10-08)、#26051 去 Studio/Factory query waterfalls(closed,10-06);云实例面早有 [#20828](https://github.com/mastra-ai/mastra/pull/20828)「authenticate `mastra api --url` to **Mastra Cloud studio/factory instances**」 | GitHub PR 搜索 `studio in:title`(2026-10-11) |

**判定范围内的落点**:Studio 云化正中旧出域档第 1 行(Studio / editor / stored agents,出域依据 = 托管产品面)与第 3 行(托管平台,商业)。性质**无变化**——本地 Studio + 云平台 Studio 双轨并行,云化方向与旧钉快照时一致且已文档化;出域理由不仅成立,且被「Studio on Mastra platform」这一官方产品形态进一步加厚。

## 5. 旧钉逐行对照与措辞评估

| 确认线 | 形态(2026-10-11) | 旧钉落点 | 性质变化? | 出域理由措辞 |
| --- | --- | --- | --- | --- |
| react-sdk(`@mastra/react` 1.8.0) | 纯客户端 React hooks/UI 库(经 client-js 打用户自部署 server);10-05 起 Studio 自身改吃其公共 hooks | 未单列;由「产品面 / 生态」(§4 产品面行的 client-js、出域档第 2 行生态缝)覆盖 | 有(票据假设成立):确认是客户端库而非托管面——但此性质一直如此,且 10-05 动作加深库 / 托管面分离 | **不需要修订**:出域理由仍覆盖;gap-analysis 第三版可在事实行补「客户端库,非托管面」注记 |
| knowledge v2(alpha 线 `@mastra/core/knowledge`) | 框架内原语(core 子路径 + 存储域,wave 2/4 在途,未进稳定版 1.75.0),同时供血 Factory / Subconscious 云产品 | 未单列;近邻为延后档 RAG / 语义召回 | 有(票据假设成立):产品→框架内原语 | **不触及出域档**(本就不在 7 行);事实行新增与分档归 #145 |
| Studio 云化 | 本地 + 「Studio on Mastra platform」云双轨,官方文档化,PR / dist-tag 持续活跃 | 出域档第 1 行 + 第 3 行 | 无 | **不需要修订**,理由被加厚 |

**结论**:三线均仍落在出域判定范围内;两处性质注记(react-sdk = 客户端库、knowledge v2 = 框架内原语)只影响 gap-analysis 第三版的事实行写法,**不迫使 `docs/ROADMAP.md` 出域档 7 行的理由措辞修订**。无跟单理由;升降档判定归 [#145](https://github.com/0xnicholas/oribos-framework/issues/145)。

## 6. 边界与未查项

- 落地页(mastra.ai 首页)抓取文本中未见「react-sdk」字样,react-sdk 线的证据以 npm dist-tag + GitHub 分支 / 提交为准(票据「落地页显示」一说未独立复现,不影响结论)。
- knowledge v1 的发布形态未深挖(PR #26302 提及「published v1 layouts」的存储升级来源,未考证 v1 具体包面);浅抓口径下不影响「v2 = core 原语」的判定。
- dist-tag 快照只证明分支活跃,不代表进入稳定版;knowledge 进稳定版与否以下一个 minor 发布为准(观察项,非本票裁决项)。
