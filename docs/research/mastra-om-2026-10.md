# 调研:mastra Observational Memory(OM)现状——头条化背后的实装形态与默认姿态

> 快照日:2026-10-11。研究 ticket:#141。
> 来源版本基线:`@mastra/memory@1.36.0`(npm stable,发布于 2026-10-07)、`@mastra/memory@1.37.0-alpha.2`(2026-10-09)、`@mastra/core@1.75.0`、mastra-ai/mastra `main` @ `f4477eb`(2026-10-11T01:04Z)、om-lifecycle 快照 `0.0.0-om-lifecycle-20261010194955`(2026-10-10)。
> 旧钉对比:2026-10-02 快照 `@mastra/memory@1.35.0`、main @ `2994246f`(存储域 36 方法 / 17 OM 方法)。旧钉仅作基线,本文所有事实均为 2026-10-11 重抓。
> 背景:mastra.ai/ai-agent-framework 落地页已把 OM 从「推荐但 opt-in」升格为头条卖点。本文只回答实装形态问题,不做架构决策;「重开条件是否满足」的判定归 #145。

## TL;DR

OM 的实装形态与旧钉**没有本质变化**:仍是 `@mastra/memory` 包内的库形态(进程内后台 agent + 用户自备存储适配器),仍 opt-in(`observationalMemory: true` 显式开启),存储面 OM 方法数不变(17 个)。头条化是**营销层动作**,落地页 pricing 卡三大件(Agents / Workflows / Observational Memory)与 FAQ 措辞对应的是同一个 opt-in 库特性,并非新出的托管服务或默认开启。真正在动的只有两处:OM 模型默认值正从固定 `google/gemini-2.5-flash` 切到 `model: 'auto'` 自动选型(已合 main、进 1.37.0-alpha,未进 stable);npm `om-*` dist-tag 线(latest `om-lifecycle`,活跃至 2026-10-10)是 monorepo CI 从功能分支发布的 @mastra/memory 快照,落点始终在 `packages/memory/src/processors/observational-memory/` 内。

## 票据三问的答案

### 1. 库形态还是常驻服务?默认开还是 opt-in?

**库形态,opt-in。**

- OM 完整实装在 `@mastra/memory@1.36.0` 包内:tarball 含 `dist/processors/observational-memory/` 约 60 个模块(observer-agent、reflector-agent、observation-strategies/{async-buffer,sync,resource-scoped,thread-title}、subconscious/ 等)与 `dist/tools/om-{tools,observations,search-context}`。来源:[npm tarball](https://registry.npmjs.org/@mastra/memory/-/memory-1.36.0.tgz)。
- 运行机制仍是**用户进程内的后台 LLM agent**(Observer/Reflector),数据落用户自选的存储适配器;官方 quickstart 是 `new Memory({ options: { observationalMemory: true } })` + 本地 LibSQL 文件。来源:[OM 文档页](https://mastra.ai/docs/memory/observational-memory)(2026-10-11 抓取)。
- 支持的适配器从旧钉的 4 个增至 **6 个**:`@mastra/pg`、`@mastra/libsql`、`@mastra/mysql`、`@mastra/mongodb`、`@mastra/convex`、`@mastra/oracledb`(mysql、oracledb 为新增)。来源:同上文档页 Note。
- npm 上**不存在**独立的 OM 服务/包:`npm view @mastra/om`、`@mastra/observational-memory`、`@mastra/om-core` 均 E404(2026-10-11 实测)。2026-03 曾出现 `standalone-om` / `obs-server` 分支快照线,但未落地为独立发布形态。
- **仍 opt-in**:live 文档 quickstart 首句 "Set `observationalMemory: true` in your Memory config to enable";Memory class reference 中 `options.observationalMemory` 为可选项,不设即关。来源:[OM 文档页](https://mastra.ai/docs/memory/observational-memory)、[Memory Class reference](https://mastra.ai/reference/memory/memory-class)。
- 落地页定价卡自称 "$0/month · Self host your Mastra projects for free",三大件之一为 "Observational Memory — Persist conversation context and application state across sessions.";FAQ 原文 "Track the context that matters across sessions using observational memory that learns about your users automatically." 两处营销措辞对应的都是上述同一个 opt-in 库特性。来源:[mastra.ai/ai-agent-framework](https://mastra.ai/ai-agent-framework)(2026-10-11 抓取)。
- 与「重开条件」相关的事实(判定归 #145):**OM 为可嵌入库形态,无需常驻服务**;进程内后台 agent 的生命周期负担仍存在(`memory.settled()` drain 语义,见既有 mastra-memory.md)。

### 2. 是否进了 @mastra/memory 主表面?存储面方法数变化?

**OM 已在主表面;存储面 OM 方法数不变,总方法数 36 → 40(增量全非 OM)。**

- 主表面(@mastra/memory@1.36.0 `dist/index.d.ts`):`Memory` 构造 `options.observationalMemory?: boolean | MemoryObservationalMemoryOptions` 为一等选项;包根直接导出 `ModelByInputTokens`、`Extractor`、`WorkingMemoryExtractor`、`Subconscious`(标注 @experimental 的观察期知识提醒/策展原语)、`summarizeConversation`、`getObservationsAsOf` 等;`@mastra/memory/processors` 子路径 `export * from observational-memory`。来源:[npm tarball](https://registry.npmjs.org/@mastra/memory/-/memory-1.36.0.tgz)。
- 存储域(`packages/core/src/storage/domains/memory/base.ts`,抽象类 `MemoryStorage`),同口径逐方法对比:

| 口径 | 旧钉(2994246f,2026-10-02) | 现钉(f4477eb,2026-10-11) |
|---|---|---|
| 文件行数 | 730 | 818 |
| 方法总数(不含 constructor) | 36 | **40** |
| 其中 OM 相关 | 17 | **17(不变)** |

- OM 段 17 个方法逐名核对无增删:`getObservationalMemory` / `getObservationalMemoryHistory` / `initializeObservationalMemory` / `updateActiveObservations` / `updateBufferedObservations` / `swapBufferedToActive` / `createReflectionGeneration` / `updateBufferedReflection` / `swapBufferedReflectionToActive` / `setReflectingFlag` / `setObservingFlag` / `setBufferingObservationFlag` / `setBufferingReflectionFlag` / `insertObservationalMemoryRecord` / `clearObservationalMemory` / `setPendingMessageTokens` / `updateObservationalMemoryConfig`。来源:[base.ts @ f4477eb](https://github.com/mastra-ai/mastra/blob/f4477eb9181df8199062762b2679734b3adf1d3d/packages/core/src/storage/domains/memory/base.ts) vs [base.ts @ 2994246f](https://github.com/mastra-ai/mastra/blob/2994246f/packages/core/src/storage/domains/memory/base.ts)。
- 新增 4 个方法全部非 OM:run fencing 三件套 `supportsRunFencing()` / `raiseRunFence()` / `retireRunFence()`(PR [#26418](https://github.com/mastra-ai/mastra/pull/26418),2026-10-10 合入,给 durable agent run 单 owner + 围栏过期写入;`saveThread`/`deleteMessages` 签名顺带加可选 `fence` 参数)+ `mergeResourceWorkingMemory()`(配套新能力标志 `supportsAtomicWorkingMemoryMerge`,PR [#25848](https://github.com/mastra-ai/mastra/pull/25848) 系)。
- 能力标志:`supportsObservationalMemory` / `supportsObservationalMemoryHistorySearch` 不变;新增 `supportsAtomicWorkingMemoryMerge`。

### 3. npm dist-tag `om-*` 线的实装落点?

**om-* 是 mastra monorepo CI 从功能分支发布的 `@mastra/memory` 分支快照(version 形如 `0.0.0-<branch>-<timestamp>`),不是独立包;落点始终是 `packages/memory/src/processors/observational-memory/`。**

- @mastra/memory dist-tags 中的 om-* 线(2026-10-11 实测):`om-core` / `om-ui`(均 2026-02-03,OM 首发 1.1.0 前两天的分支快照)、`om`、`om-pg-fix(-2)`、`om-tracking`、`om-oom`、`om-locking`、`codex-om`、`om-gateway-api`、`om-tokenx`、`standalone-om`、`refactor-om`、`standalone-om-load-unobserved-messages`、`om-race-fix`、`om-token-usage`、`om-continuation-hints`、`om-langfuse-session`、`om-budget-isolated`、`om-lifecycle`。来源:`npm view @mastra/memory dist-tags`。
- 最新活跃线 `om-lifecycle`:latest 指向 `0.0.0-om-lifecycle-20261010194955`,发布时间 **2026-10-10T19:55Z**(与票据「活跃至 2026-10-10」吻合)。解包比对:与 1.36.0 同构(同一 @mastra/memory 包),在 `processors/observational-memory/` 内多出 `auto-model`、`commit-queue`、`record-lineage` 三个模块。来源:[om-lifecycle 快照 tarball](https://registry.npmjs.org/@mastra/memory/-/memory-0.0.0-om-lifecycle-20261010194955.tgz)。
- 其中 auto-model 部分已落地:PR [#24508](https://github.com/mastra-ai/mastra/pull/24508)(2026-10-09 合入 main)给 OM 原生 `model: 'auto'`——Observer/Reflector 每次调用独立解析模型,`autoModels` 按 provider 覆盖、`resolveAutoModelId()` 供设置 UI 预览;已进 `1.37.0-alpha.2` CHANGELOG,`packages/memory/src/processors/observational-memory/auto-model.ts` 已存在于 main HEAD。**stable 1.36.0 尚未包含**(其内嵌文档仍写默认 `google/gemini-2.5-flash`),但 live 文档站已按 `model: 'auto'` 描述——文档站比 stable 发布超前一个迭代。
- `commit-queue` / `record-lineage`(blockAfter 处有界等待缓冲观察、迟到观察整条丢弃等提交/血缘语义)在 main HEAD 源码中**尚不存在**,属 om-lifecycle 分支的在途工作。
- 旁证:2026-10 以来 memory 域合入的 PR 几乎全部落在既有 OM 架构内做硬化(#26105 反射重试不再误停 run、#25060 超大 tool result 触发同步补观察、#25058 半截流重试整_prompt_、#25872 每请求新建 Memory 的 CPU 泄漏、#25727 per-provider idle TTL 等),无形态变更。来源:[packages/memory CHANGELOG @ main](https://github.com/mastra-ai/mastra/blob/main/packages/memory/CHANGELOG.md)。

## 结论

营销头条化 ≠ 实装形态变化。截至 2026-10-11:OM 仍是 @mastra/memory 内 opt-in 的库特性(进程内后台 agent + 六适配器自选存储),存储面 OM 方法数钉在 17;om-* dist-tag 线是同一仓库功能分支的 CI 快照,最近一波在途工作是「自动模型选型(已合 main)+ 观察提交生命周期硬化(om-lifecycle 分支,未合)」。对「重开条件」相关的事实陈述到此为止,判定归 #145。
