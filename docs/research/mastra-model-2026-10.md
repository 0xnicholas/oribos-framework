# 调研:mastra 模型层线定点重抓——dynamic-model-router 与 provider spec 姿态

> wayfinder research for issue #143。快照日 **2026-10-11**;只重抓两个定点,其余以旧钉为基线不重抓。
> 旧钉基线:[mastra-agent-model-layer.md](./mastra-agent-model-layer.md)(2026-10-02 快照,@mastra/core@1.74.0:`'provider/model'` magic string + 210-provider 注册表(开发期每小时刷新;文档口径 212 providers / 7,738 models)+ GatewayManager 链 + 认证解析 + 4 代 spec 适配器并存)。
> 一手来源:npm registry(`@mastra/core` 的 dist-tags / time / `@mastra/core@1.75.0` 与 `0.0.0-dynamic-model-router-20251010230835` 两个 tarball 的 package.json 与 dist,本地 `npm pack` 实测)、`mastra-ai/mastra` GitHub 源码与 PR(main 分支 packages/core 现为 `1.76.0-alpha.7`)。

## TL;DR

- **`dynamic-model-router` 不是新动向**:该 dist-tag 指向 2025-10-10 的 PR 快照(PR [#8688](https://github.com/mastra-ai/mastra/pull/8688),快照发布 10 分钟后即合并)。它就是旧钉中"运行时加载注册表 + 开发期每小时刷新"机制的**源头**,而非基线之外的进一步动态化。相对 1.74.0 基线:运行时目录只有数据刷新(内置注册表 210 → 211 providers / 7,790 models),网关链(Netlify → Mastra → ModelsDev)与缓存策略(`~/.cache/mastra` 全局缓存)均无结构变化。
- **provider spec 姿态没有收敛**:@mastra/core@1.75.0 运行时依赖仍携 **3 代** spec 别名(`@ai-sdk/provider-v5/v6/v7` = spec V2/V3/V4),devDeps 仍 **4 代**并存(v4 代留在开发侧);HEAD(1.76.0-alpha.7)同姿态。与快照时代(2025-10)相比,直携的 `ai` 与裸 `@ai-sdk/provider` 运行时依赖已消失,只剩别名 spec 包。
- **与本框架钉点的对位(只核实不裁决)**:本框架 model 契约钉 spec `'v4'`(= `LanguageModelV4` = `@ai-sdk/provider` 包 major 4),对应 mastra 别名体系中的 `-v7` 一代——1.75.0 携 `4.0.17`、HEAD 携 `4.0.22`、上游最新 `4.0.26`,同 major,无升代信号。「字符串路由」延后行是否重开的判定归 #145,不在本文范围。

## 1. `dynamic-model-router` dist-tag 对应的实装

### 1.1 dist-tag 指向与发布时间线

来源:npm registry `https://registry.npmjs.org/@mastra/core`(2026-10-11 查询)。

- dist-tag `dynamic-model-router` 当前指向 `0.0.0-dynamic-model-router-20251010230835`,与票据记录一致。
- `time` 字段显示该分支共发过 4 个快照:`...-20251009204130`(2025-10-09T20:42Z)、`...-20251009231604`、`...-20251010193247`、`...-20251010230835`(**2025-10-10T23:09:57Z**)。dist-tag 停在最后一个——**这是一年前的 PR 快照指针,不是 2026-10 的新发布**。
- 参照:`latest` = `1.75.0`(2026-10-07T08:53Z 发布),`alpha` = `1.76.0-alpha.7`(2026-10-10T16:22Z);旧钉 `1.74.0` 发布于 2026-10-01T18:16Z。

### 1.2 对应实装:PR #8688(快照发布 10 分钟后合并)

来源:[mastra-ai/mastra#8688](https://github.com/mastra-ai/mastra/pull/8688)《feat(core): dynamic model router with auto-refresh and runtime type generation》,分支 `feat/dynamic-fetch-model-router-2`,2025-10-10T23:19:33Z 合并,merge commit `5af7816e2378ebe1b10e599d1b0bcc647b63c9cf`,66 个文件 +3,813/−1,940。快照是合并前的分支构建,实装以 merge commit 为准。

PR body 自述的变化(即"dynamic"的全部含义):

| 方面 | 之前 | 之后 |
| --- | --- | --- |
| 注册表 | 静态 `provider-registry.generated.ts`,新模型需手动重生成 | 运行时加载 `provider-registry.json` |
| 刷新 | 无运行时更新 | `mastra dev` 下每小时自动刷新(`MASTRA_AUTO_REFRESH_PROVIDERS` 配置;失败回落陈旧数据) |
| 类型 | 静态 | 运行时重生成 `.d.ts`,IDE 补全随注册表更新 |
| 缓存 | — | 持久缓存 `~/.cache/mastra/` |
| 手动控制 | — | `ModelRegistry.syncGateways()` |
| 端点 | — | 自定义 OpenAI-compatible 端点支持 |

改动文件面:`packages/core/src/llm/model/` 下的 `provider-registry.{ts,json}`(新增)、`provider-registry.generated.ts`(移除)、`registry-generator.ts`、`router.ts`、`shared.types.ts`、`gateways/{models-dev,netlify}.ts` 等。

### 1.3 与旧钉的关系:是源头,不是增量

旧钉(1.74.0 基线)描述的"210-provider 注册表、开发期每小时刷新"正是 #8688 引入的机制——**dist-tag 对应的实装已全部落在基线之内**。合并后同一机制的三次后续补丁(均 2025-10,均已合并):

- [#8834](https://github.com/mastra-ai/mastra/pull/8834)(10-15):定时 GitHub Action 重生成 provider registry(注册表保鲜流程化)。
- [#9095](https://github.com/mastra-ai/mastra/pull/9095)(10-22):**缓存策略的唯一一次实质变化**——provider 数据缓存改为全局 `~/.cache/mastra/` 跨项目共享(此前按项目缓存会导致 A 项目刷新后 B 项目仍用陈旧静态数据),本地文件兜底向后兼容。
- [#9533](https://github.com/mastra-ai/mastra/pull/9533)(10-31):移除未使用的 `/model-providers` API。

当前 main(packages/core@`1.76.0-alpha.7`)核验,机制原样延续:

- [`src/llm/model/provider-registry.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/llm/model/provider-registry.ts)(1,078 行):`CACHE_DIR = ~/.cache/mastra`(L81)、`syncGateways(forceRefresh, writeToSrc)`(L832)、`setInterval` 小时级刷新 + 刷新失败即停(L992–1019)、`MASTRA_AUTO_REFRESH_PROVIDERS` 门控(显式 `'true'`,或非 `'false'` 且 dev,L1072–1073)。
- [`src/llm/model/gateways/defaults.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/llm/model/gateways/defaults.ts):默认链仍为 `NetlifyGateway → MastraGateway → ModelsDevGateway`,与旧钉一致。
- 1.75.0 的 dist 佐证:三个网关类(`NetlifyGateway`/`MastraGateway`/`ModelsDevGateway`)与 `gateway-api.mastra.ai`、`api.netlify.com`、`models.dev` 端点均在;`MASTRA_AUTO_REFRESH_PROVIDERS`、`createHmac`(实例缓存键)等关键词仍在对应 chunk。

### 1.4 运行时目录规模(数据刷新,非结构变化)

打包内置 `dist/provider-registry.json` 实测计数:

| 版本 | providers | models |
| --- | --- | --- |
| 快照 `0.0.0-dynamic-model-router-20251010230835`(PR 时代种子) | 44 | 618 |
| 旧钉 @1.74.0(基线口径:注册表 210;文档口径 212 / 7,738) | 210 | — |
| **@1.75.0(内置文件实测)** | **211** | **7,790** |

1.75.0 的 [CHANGELOG](https://github.com/mastra-ai/mastra/blob/main/packages/core/CHANGELOG.md) 模型层相关条目仅 "Update provider registry and model documentation with latest models and providers"(commit `b54fda3`)一类例行刷新,无路由 / 网关 / 缓存的结构条目。口径注意:基线的 7,738 是文档口径,7,790 是 1.75.0 内置文件实测,两者来源不同但量级一致,增长由 models.dev 上游驱动。

另录一条 1.76.0 线动向(不计入 1.75.0):[#26225](https://github.com/mastra-ai/mastra/pull/26225)《keep the reasoning options models.dev publishes per model》2026-10-07T22:41Z 合并,晚于 1.75.0 发布时间(当日 08:53Z)——注册表条目内容在继续富化,方向仍是"目录数据"而非路由结构。

**结论(定点 1)**:模型路由没有进一步动态化。`dynamic-model-router` dist-tag 是旧机制的源头快照(已合并一年);相对 1.74.0 基线,运行时目录只有数据刷新(210 → 211 providers / 7,790 models),网关链与缓存策略无结构变化。

## 2. provider spec 姿态:@mastra/core@1.75.0 收敛没有?

### 2.1 运行时依赖:仍携 3 代,未收敛

来源:`npm pack @mastra/core@1.75.0` 的 `package.json`(dependencies 共 30 项,@ai-sdk 相关恰为以下 5 项,全部是大版本别名):

| 别名 | 实际包 | spec 接口 | 对应 AI SDK |
| --- | --- | --- | --- |
| `@ai-sdk/provider-v5` | `npm:@ai-sdk/provider@2.0.3` | `LanguageModelV2` | AI SDK 5 |
| `@ai-sdk/provider-v6` | `npm:@ai-sdk/provider@3.0.14` | `LanguageModelV3` | AI SDK 6 |
| `@ai-sdk/provider-v7` | `npm:@ai-sdk/provider@4.0.17` | `LanguageModelV4` | AI SDK 7 |
| `@ai-sdk/provider-utils-v6` | `npm:@ai-sdk/provider-utils@4.0.40` | — | — |
| `@ai-sdk/provider-utils-v7` | `npm:@ai-sdk/provider-utils@5.0.13` | — | — |

要点:运行时**没有**裸 `@ai-sdk/provider`、**没有** `ai` 包、**没有** v4 代别名;`provider-utils` 只携 v6/v7 两代(v5 的 utils 不在)。与票据记录的 1.74.0 基线(运行时携 v5/v6/v7)逐项相同——**1.75.0 没有收敛**。

### 2.2 devDeps:仍 4 代并存

同一 `package.json` 的 devDependencies(共 65 项)中:v4 代的 `@ai-sdk/provider-v4`(`npm:@ai-sdk/provider@1.1.3`)与 `@ai-sdk/provider-utils-v4`(`npm:...@2.2.8`)仍在;per-provider SDK 按 AI SDK 大版本成套别名(`@ai-sdk/openai-v5/v6/v7`、`anthropic-v5/v6/v7`、`google-v5/v6/v7`,另有 cerebras/groq/mistral 等只留 `-v6`、deepseek 只留 `-v7`);`@internal/ai-sdk-v4`、`@internal/ai-sdk-v5` 测试夹具在列。即票据基线"devDeps 4 代并存"在 1.75.0 原样成立。

### 2.3 代数口径对照(防混淆)

mastra 别名后缀是 **AI SDK 大版本号**,不是 `@ai-sdk/provider` 包自身的 major:

| mastra 别名 | `@ai-sdk/provider` 包 major | spec 接口 | 生态位 |
| --- | --- | --- | --- |
| `-v4` | 1.x | `LanguageModelV1` | AI SDK 4(legacy,仅 devDeps) |
| `-v5` | 2.x | `LanguageModelV2` | AI SDK 5 |
| `-v6` | 3.x | `LanguageModelV3` | AI SDK 6 |
| `-v7` | 4.x | `LanguageModelV4` | AI SDK 7 |

**本框架钉的 spec `'v4'`(`packages/core/src/model/resolve.ts:9` `MODEL_SPECIFICATION_VERSION = 'v4'`)= `LanguageModelV4` = provider 包 major 4 = mastra 的 `-v7` 别名代。**

### 2.4 纵向对比与 HEAD 姿态

- **快照时代**(2025-10-10,@mastra/core 0.x):运行时**直携** `ai@^5.0.60` + `@ai-sdk/provider@^2.0.0` + `@ai-sdk/provider-utils@^3.0.10`,v4 代以别名(`ai-v4` = `npm:ai@4.3.19`、`@ai-sdk/provider-v4` = `npm:@ai-sdk/provider@1.1.3`)并存——两代直携结构。
- **1.75.0**(2026-10-07):直携全部消失,运行时只剩 3 代别名 spec 包(§2.1)。与旧钉"内部规范接口是 provider spec、不是 AI SDK 运行时"的论断互证。
- **HEAD**(main = `1.76.0-alpha.7`,[packages/core/package.json](https://github.com/mastra-ai/mastra/blob/main/packages/core/package.json)):同姿态,仅 patch 跟升(`provider-v7` 4.0.17 → 4.0.22、`provider-utils-v7` 5.0.13 → 5.0.54),无任何一代被摘除的迹象。
- **上游面核实**(与票据背景一致):`@ai-sdk/provider` 最新 `4.0.26`(仍 spec v4 major)、`ai` 最新 `7.0.137`;本仓库 `@oribos/ai-sdk` devDep `ai@7.0.123`。

**结论(定点 2)**:@mastra/core@1.75.0 **没有收敛**——运行时依赖仍携 v5/v6/v7 三代 spec 别名(provider 包 major 2/3/4),devDeps 仍 4 代并存,HEAD 亦然。对本框架钉的 spec v4(= mastra `-v7` 代)而言,上下游同处 provider 包 major 4,暂无升代压力的事实基线成立。

## 附:主要来源

npm registry(2026-10-11 查询;tarball 经 `npm pack` 本地解包实测):

- `https://registry.npmjs.org/@mastra/core` — dist-tags(`dynamic-model-router` → `0.0.0-dynamic-model-router-20251010230835`;`latest` = `1.75.0`)与 `time`(快照 2025-10-10T23:09:57Z;1.74.0 = 2026-10-01T18:16Z;1.75.0 = 2026-10-07T08:53Z)
- `@mastra/core@1.75.0` tarball:`package.json`(5 项 @ai-sdk 运行时别名、65 项 devDeps 4 代并存)、`dist/provider-registry.json`(211 providers / 7,790 models)、dist chunk(三网关类、`MASTRA_AUTO_REFRESH_PROVIDERS`、`createHmac`)
- `@mastra/core@0.0.0-dynamic-model-router-20251010230835` tarball:`package.json`(直携 `ai@^5` 时代)、`dist/provider-registry.json`(44 / 618 种子)

GitHub `mastra-ai/mastra`:

- PR [#8688](https://github.com/mastra-ai/mastra/pull/8688)(merge commit `5af7816e2378ebe1b10e599d1b0bcc647b63c9cf`)、[#8834](https://github.com/mastra-ai/mastra/pull/8834)、[#9095](https://github.com/mastra-ai/mastra/pull/9095)、[#9533](https://github.com/mastra-ai/mastra/pull/9533)、[#26225](https://github.com/mastra-ai/mastra/pull/26225)
- 源码(main,packages/core@`1.76.0-alpha.7`):[`src/llm/model/provider-registry.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/llm/model/provider-registry.ts)(L81 / L832 / L992–1019 / L1072–1073)、[`src/llm/model/gateways/defaults.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/llm/model/gateways/defaults.ts)、[`packages/core/package.json`](https://github.com/mastra-ai/mastra/blob/main/packages/core/package.json)、[`packages/core/CHANGELOG.md`](https://github.com/mastra-ai/mastra/blob/main/packages/core/CHANGELOG.md)(## 1.75.0 节)

旧钉(基线,未重抓):[docs/research/mastra-agent-model-layer.md](./mastra-agent-model-layer.md)(2026-10-02 快照,@mastra/core@1.74.0)。
