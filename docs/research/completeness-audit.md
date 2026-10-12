# 调研:完成度审计——规范 × 实装 × 测试三方对照

> 审计票:[#103](https://github.com/0xnicholas/balsats-framework/issues/103)(wayfinder 地图 [#102](https://github.com/0xnicholas/balsats-framework/issues/102) 的 research 子票)。
> 基线:**main @ `94798c9`(0.5.0 发布态)**;工作树审计开始/结束均干净,审计过程未改动任何受版本控制文件(本报告为唯一新增文件)。所有行号以该提交下实际读到的文件为准。
> 方法:八篇规范(`docs/architecture/`)逐篇三方对照(规范承诺 ↔ 实装 ↔ 测试)的六路并行证据分片(A1–A6)+ `docs/research/mastra-gap-analysis.md` §3 的 33 条语义声明逐条复核 + 质量/债务盘点 + 可跑命令实跑(`pnpm verify`、五个 `check:*` 单跑、10 个 example 核查(6 个实跑)、npm tarball 元数据)+ 引用抽检 24 处 + 变异核对 3 例。
> 定位:**只出事实、带证据指针,不做裁决、不给提升建议**。裁决归下游票:[#104](https://github.com/0xnicholas/balsats-framework/issues/104)(完整判据)/ [#105](https://github.com/0xnicholas/balsats-framework/issues/105)(§3 逐条判定)/ [#106](https://github.com/0xnicholas/balsats-framework/issues/106)(砍单表判定)/ [#107](https://github.com/0xnicholas/balsats-framework/issues/107)(质量债务处置)。
> 条目 ID 约定:`M-` model;`AG-` agent;`T-` tools;`MS-` MCP server 包;`MC-` MCP client 包;`W-` workflows(`O-` 控制流算子 / `P-` suspend-resume / `V-` IO 校验 / `E-` 事件 / `X-` 错误重试);`MEM-` memory;`OBS-` observability(含 OTLP);`ST-` storage(含 sqlite);`H-` harness(含 croner);`SEM-` §3 语义行(A5 分片的 A/B/C/D/E 编号原样保留为后缀);`Q-` 质量与债务;`CUT-` 砍单行;`X-`(跨子系统)/`U-`(未查实)/`DOC-`(文档不一致)/`REL-`(0.5.0 遗留)/`CMD-`(命令)/`SC-`(抽样校验)/`MUT-`(变异核对)。
> 状态取值 ∈ {已落 / 部分落 / 未落 / 已落但未验};砍单现状 ∈ {仍是砍单 / 已部分落 / 已落但未记录};§3 结论 ∈ {有据 / 部分有据 / 无断言 / 未查实}。

## TL;DR

- **基线**:`main @ 94798c9`(0.5.0 发布态),七包 `@balsats/*@0.5.0`;审计前后 `git status --porcelain` 均空。
- **实跑全绿**:`pnpm verify` exit 0 —— **68 测试文件 / 865 例全部通过**(测试阶段 17.03s);`check:dist` **16 子路径**;`check:byte-budget` **16/16 零超支**;`check:deps-budget` / `check:export-surface` / `check:runtime-deps` 全部 exit 0。数字与 `docs/ROADMAP.md:98` 记账一致。
- **examples**:10 个中 6 个实跑——`cron-schedule` / `otlp-collector` / `mcp-tools`(HTTP + stdio)离线直接跑通;**`sqlite-resume` / `durable-approval` / `workflow-approval`** 以 README 允许的「OpenAI 兼容端点 + 本地 mock」端到端跑通(exit 0);`ai-chat-route` / `minimal-agent` / `memory-chat` / `signals-desk` 需真 key,**未跑**。
- **对账体量**(各子系统承诺条目,逐条见 §1):model 65 + agent 44 + tools 26(+ MCP server 12 / client 17)+ workflows 53 + memory 41 + observability 80 + storage 64 + harness 54,合计 **456 条**。绝大多数「已落」;差异集中于**「已落但未验」**(明确标注约 40 条,另有成批「已落(无断言)」的裁单/结构性行)与**少量「部分落」**。
- **「部分落」要点**:(a) `model.md:87` 终帧 `messageMetadata` 写法为可选,实装**恒**写 `{ usage }`(`chat-route.ts:199-201`);(b) `agent.md:46` / `harness.md:23`「裸 agent 不产生 `'suspended'`」只在**不传 seam** 时成立——`stepBoundary` 是公开 run option,裸 `Agent` 显式传参即可得 `suspended`(`agent-step-boundary.test.ts:163`);(c) `observability.md:110`「logs 走组合根已有的 logger 通道」——**组合根尚无 logger 槽**(`app.ts:28-29`);(d) `storage.md:174`「组合根持 adapter 时可代管 init/close(可选)」——槽已落、**代管未落**。
- **无断言面成批存在**:如 tools 的 MCP 翻页聚合(MC-9)、`CONNECTION_CLOSED`(MC-10/MC-11)、容器构造后快照(MS-11);workflows 的快照写失败语义(P-11)、条件内 `suspend()` 报错(SEM-B16)、`sleep` 条目写快照(P-5);memory 的无访问控制(MEM-6)、无后台写(MEM-40);storage 的「核心永不隐式 init/close」(ST-20)、`:memory:` 独立性;harness 的「裸 agent 不产生 suspended」(H-11)、「tick 无 span」(H-48);agent 的 Processor 钩子自身抛错(AG-40);model 的 `finishReason` 逐值映射(M-52)等。
- **砍单表复核 60 行**(2026-10-11 更正:原计 61/59 差 1,纯 CUT-\* 编号实为 60,重判清点见 [#162](https://github.com/0xnicholas/oribos-framework/issues/162)):58 行**仍是砍单**,2 行**已部分落**——agent 的「durable / pubsub / backgroundTasks / signals / goal / notifications」行(durable、signals、pubsub 已以独立子系统/工厂落地)与 workflows 的「resume CAS / serializedStepGraph / 多引擎适配」行(CAS 已在 `@balsats/sqlite` 落地);**未发现「已落但未记录」行**。
- **§3 语义复核(33 条 / 37 事实行)**:有据 35 行、部分有据 2 行(A2 串行工具执行只固定顺序不固定非并发;B16 条件内 `suspend()` 报错实装成立但无断言)、无断言 0、未查实 0(A5 口径)。
- **文档一致性已知不一致 12 处**,其中 3 处为**陈旧注释/文档措辞与实装相反**:`step.ts:32-38`(称块内 suspend 是显式错误)、`events.ts:45-49`(称块内 suspend 读 `failed`)、`README.md:153`(`result` 注释含 `'failed'`,实装失败是 reject);其余为细节口径差异(见 §4.3)。
- **发布态遗留**:线上 0.5.0 tarball 的 `repository.url` / description 仍指旧名(`balsa-framework` / "Balsa …"),不可原地修改、只能随下次发布修正;全仓 **18 个 package.json 均无 `prepublishOnly`/`prepack`/`prepare`**;`pnpm verify` **不含** byte/deps 两个预算(它们是 CI 独立黄灯步)。
- **抽检与变异**:引用抽检 **24 处**(跨 6 个分片),发现 **2 处错行**并已在报告内更正(A1/A3 的 `vitest.config.ts` include 行号;A1 的 ROADMAP「Studio / editor」行号);**3 例变异核对**全部按预期(测试由绿转红 → 还原 → 复绿),详见附录 B/C。
- **未查实边界**:真 provider 路径未验(3 个 example 由本地 mock 驱动)、任何性能/内存数字未测量、OTLP「安装树 12 包 / 19,312,287 B」口径未核、CI 未运行(只读 `ci.yml`);逐条见 §6。

## 0. 基线与方法

### 0.1 跑了什么、结果

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 全量闸门 | `pnpm verify`(typecheck → build → test → check:dist → check:runtime-deps → check:export-surface) | **exit 0**;`Test Files 68 passed (68)` / `Tests 865 passed (865)`(17.03s);typecheck 17/18 workspace 项目(根 tsc + 17 包/示例) |
| dist 面 | `pnpm check:dist` | exit 0,**16 子路径**(core 10 + 六能力包各 1) |
| 字节预算 | `pnpm check:byte-budget` | exit 0,**16/16 零超支**(core `.` 50,716 B/gzip 15,752 B;`./workflows` 16,652 B;otlp 8,276 B;sqlite 11,971 B;ai-sdk 8,253 B;mcp-client 2,290 B;mcp-server 1,601 B;croner 196 B) |
| 依赖预算 | `pnpm check:deps-budget` | exit 0,六包全 ok;mcp-client 一条**下界提示**:`isexe@2.0.0` registry 元数据缺 `dist.unpackedSize`,计 0 B(status 仍 ok) |
| 导出面 | `pnpm check:export-surface` | exit 0,七包导出面无缺口(core 10 子路径) |
| 零依赖红线 | `pnpm check:runtime-deps` | exit 0,七包全绿(core:清单 0 依赖 / 产物 57 模块 / 0 处外部导入) |
| 包清单核 | 逐包读 `package.json` | 七包 version 全 `0.5.0`;core/sqlite deps=0;ai-sdk deps=0 + peer core;mcp-server/client deps=1;croner deps=1(无 peer);otlp deps=5 + peer core |
| examples(离线) | `pnpm --filter @balsats/example-* start` | `cron-schedule` / `otlp-collector` / `mcp-tools`(HTTP 与 `MCP_TRANSPORT=stdio` 两路)exit 0 |
| examples(无 key 的文档化失败面) | 同上 | `sqlite-resume` / `workflow-approval` / `durable-approval` exit 1,输出 `Set OPENAI_API_KEY …` |
| examples(本地 OpenAI 兼容 mock) | `OPENAI_API_KEY=mock OPENAI_BASE_URL=http://127.0.0.1:<port>/v1 …`(mock 脚本在 /tmp,未入仓) | 上述三个 example **exit 0**(挂起 → resume / 审批两路 / 跨进程 CAS / `listSuspended` 等均实跑断言) |
| 发布物元数据 | `npm view` + `npm pack @balsats/core@0.5.0` | `latest=0.5.0`、`engines >=22.13.0`、`publishConfig.access=public`、exports 10 子路径;tarball 内 description 为 `"Balsa core — …"`、`repository.url` 指 `balsa-framework`(旧名) |
| README 面探针 | `node` 按 README 写法逐符号 import(七包软链进 /tmp) | core 10 入口 + 六能力包全部 ok |

命令流水账与原始输出位置见附录 A;所有命令退出码与关键输出以该次会话日志为准(`/tmp/audit103/*.log`,会话内)。

### 0.2 没跑什么、为什么

1. **真 provider(真模型)路径**:`ai-chat-route` / `minimal-agent` / `memory-chat` / `signals-desk` 4 个 example 需 `OPENAI_API_KEY`,本地无 key、无 Ollama、无网络模型,**未跑**(仅确认无 key 时按文档 exit 1);另 3 个 example 跑的也是本地 mock(模型行为由 mock 决定,框架侧断言为真跑)。
2. **任何性能/内存测量**:仓内无基准,未做压测(见 §4.4)。
3. **OTLP 安装树的并集口径**「12 包 / 19,312,287 B」:未独立复核;仓内 `packages/otlp/deps-budget.json` 是按**每直接依赖分列**的闭包数字,与规范并集口径不可直接比对。
4. **CI 未运行**:只读了 `.github/workflows/ci.yml`。
5. **地图 #102 / #65 为 GitHub issue**,由分片经 `gh` 读取(网络);本报告沿用该事实,未再访问。
6. 六路分片各自声明的其它未查实项,全部汇总于 §6,未丢弃。

### 0.3 行号基线、计数口径与分片更正

- **行号基线**:全部 `相对路径:行号` 以 `94798c9` 的工作树为准;`git rev-parse HEAD` = `94798c93c9889aed4d091315e20f6220f2f9113b`。
- **用例计数口径三套并存**(分片各自声明):A1 = 顶层 `it|test` 下界(不展开 `.each`);A2 = 调用点计数(`it.each` 记 1 点但运行期展开多例);A4 = `it|test(.each)` 计数(全仓 `it.skip/todo` 零命中)。**权威运行期数字 = 865 例 / 68 文件**(A6 实跑 `pnpm verify`);分片数字只用于盘面比较,不可相加。仓库自带 68 个 `*.test.ts`(core 44 / sqlite 7 / mcp-client 5 / ai-sdk 4 / otlp 3 / mcp-server 3 / croner 2)。
- **分片间矛盾/错行(以复核后的实际文件为准)**:
  1. `vitest.config.ts` 的 `include` 行号:A1 写 `:19`、A3 写 `:24`、A2/A6 写 `:27`。**实际在 `:27`**(`include: ['packages/*/test/**/*.test.ts']`);A1、A3 为错行,本报告统一按 `:27` 引用。
  2. A1 §3.2 把「Studio / editor / stored agents」的出域档行写作 `ROADMAP.md:130`;**实际在 `:129`**(`:130` 是 `channels / voice / workspaces & sandboxes`);本报告按 `:129` 引用。
  3. A1 与 A3 均把「测试不与源码同目录」写成对任务书的更正,彼此一致;两处 `vitest.config.ts` 行号除外(见上)。
  4. 其余分片间数字差异均为口径差异(见上),不构成事实冲突。
</chunk>

## 1. 逐子系统:规范承诺 vs 实装 vs 测试

> 阅读约定:每张表的「实装」「测试」列均为 `相对路径:行号`(+ 短摘录/括注);`无断言` = 本切片未找到断言(不代表缺陷);状态 ∈ {已落 / 部分落 / 未落 / 已落但未验}。路径前缀 `packages/core/src` 简写为 `packages/core/src`(全文一致,不另设缩写以免破坏可点击性)。

### 1.1 model 子系统(`docs/architecture/model.md`,129 行)

#### 1.1.1 定位与模型契约(model.md:6-16)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| M-1 | 契约类型级兼容 AI SDK provider spec;核心零运行时依赖 | `packages/core/src/model/contract.ts:471-482`(`Model` 五成员 `specificationVersion`/`provider`/`modelId`/`doGenerate`/`doStream`);`packages/core/package.json` 无 `dependencies` | `packages/core/test/model-contract.test.ts:29`(`expectAssignable<Model>(…LanguageModelV4)`);`scripts/lib.mjs:13` `ZERO_RUNTIME_PACKAGES=['@balsats/core']` | 已落 |
| M-2 | 只 vendor 语言模型;embedding/image/speech 不 vendor | `contract.ts` 全篇仅 `Model` 一个模型接口 | `packages/core/test/agent-surface.test.ts:283`(非语言模型构造 Agent 即抛契约错误) | 已落 |
| M-3 | 保真压过行数;union 逐 variant 覆盖 | `contract.ts` 482 行;`ModelMessage` 212-228 / `ModelStreamPart` 417-456 / `ModelToolResultOutput` 190-209 逐 variant | `model-contract.test.ts:33/38/43/48`(prompt / call options / 流 part / 结果与用量四组双向可赋值) | 已落 |
| M-4 | 工具 schema 用自有 `JsonSchema`(draft-07 子集),不引 `@types/json-schema` | `contract.ts:51-102`;核心 `src` 无外部 import;`contract.ts:48-50` 注释明示 | 无专门断言;`@types/json-schema` 仍在根 devDependencies 但 core/src 无引用 | 已落 |
| M-5 | 锁定单一 spec 版本;解析期硬断言;错误指出升级方向 | `packages/core/src/model/resolve.ts:9`(`MODEL_SPECIFICATION_VERSION='v4'`);`:54-66` 两分支;`:79-108` 按代际给方向 | `packages/core/test/model-resolve.test.ts:29/35/47/57/66/75/83`(接受 v4、v3/v5/不可识别/同代异拼/缺字段/缺 doStream) | 已落 |
| M-6 | 版本跟随策略:升 major,不做多 spec 适配器 | 结构上只有一个版本常量、无代际分支(`resolve.ts:111-114` 的 `parseGeneration` 仅用于错误消息) | 无断言(策略性承诺) | 已落但未验 |

#### 1.1.2 模型字段形状与 fallback(model.md:18-32)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| M-7 | `ModelInput` 三形状(实例 / 数组链 / 动态函数) | `packages/core/src/agent/types.ts:121`(`ModelInput=DynamicArgument<Model\|readonly Model[]>`)、`:108`(`DynamicArgument`) | `agent-surface.test.ts:76-93`(四形状含异步);`packages/core/test/agent-dynamic.test.ts:33` | 已落 |
| M-8 | fallback:每次调用按数组顺序逐项尝试 | `packages/core/src/agent/loop.ts:271`(`for (const candidate of models)`) | `packages/core/test/agent-fallback.test.ts:68`(顺序)、`:95`(每步从链首重试) | 已落 |
| M-9 | 仅「未产出任何 chunk」的失败才切换 | `loop.ts:281`(`producedChunk = true`);`:323-334`(已产 chunk → `processError` 后抛出) | `agent-fallback.test.ts:82`(只下推理增量仍算未产 chunk)、`:161`(首个 chunk 后失败不切换)、`:175`(已产 chunk 照常交付) | 已落 |
| M-10 | 流中途失败不切换、直接报错 | `loop.ts:321-332`(`// A mid-stream failure cannot fall back …`) | `agent-fallback.test.ts:161` | 已落 |
| M-11 | 错误上下文沿链保留;单候选原样浮出 | `packages/core/src/model/fallback.ts:47-56`(`ModelFallbackError.failures`+`cause`)、`:62-65`(`modelChainExhausted` 单元素返原错) | `agent-fallback.test.ts:213`(消息含每候选)、`:241`(单元素链原错误浮出) | 已落 |
| M-12 | 动态函数每次执行按请求上下文解析 | `packages/core/src/agent/dynamic.ts:27-34`;`packages/core/src/agent/agent.ts:117-123`(`Promise.all` 解析) | `agent-dynamic.test.ts:18/33/67/103/241` | 已落 |

#### 1.1.3 Chunk 协议(model.md:34-39)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| M-13 | 落地四种 chunk:`text-delta` / `tool-call`(input 已解析)/ `tool-result` / `finish` | `packages/core/src/model/chunks.ts:57-58`(`Chunk = TextDeltaChunk \| ToolCallChunk \| ToolResultChunk \| FinishChunk`);解析见 `normalize.ts:115-121` | `packages/core/test/agent-stream.test.ts:17`(流序四种形状);`packages/core/test/model-normalize.test.ts:24/53/65/88` | 已落 |
| M-14 | 推理增量、参数增量等 part 不进协议 | `normalize.ts:83-99` 显式穷举丢弃;`:101-103` `satisfies never` 兜底 | `model-normalize.test.ts:139`(不承载参数增量)、`:155`(推理增量不进协议);`agent-stream.test.ts:49` | 已落 |
| M-15 | `FinishReason` 收敛五值;`content-filter`/`other` 归 `'stop'` | `chunks.ts:18`;`normalize.ts:130-143` | `model-normalize.test.ts:80-81` 表驱动 | 已落 |
| M-16 | 归一化层在核心内、保持薄 | `normalize.ts:13-30`(`normalizeStream` 单 chunk/无缓冲)、`:43-106`(`normalizePart`) | `model-normalize.test.ts:126`、`:179`(提前退出取消上游) | 已落 |
| M-17 | `error` part 直接抛出 | `normalize.ts:78-79`(`throw toError(part.error)`);`:159-162` 非 Error 包装保留 cause | `model-normalize.test.ts:108`、`:114` | 已落 |
| M-18 | 非法工具输入保留原始字符串;核心不透出 AI SDK 流格式 | `normalize.ts:115-121`;核心 `src` 无外部 import,`packages/core/src/model/index.ts:58-67` 只导出自有类型 | `model-normalize.test.ts:59`(非法输入);「不透出」无直接断言(`agent-stream.test.ts:17` 仅间接) | **部分落**(`model.md:39` 核心不透出 AI SDK 流格式:无直接断言) |

#### 1.1.4 Provider 生态(model.md:41-45)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| M-19 | 无自有 provider SPI、无注册表、无 `'provider/model'` magic string | 结构上不存在(模型层无注册表文件;`Model` 由调用方直接传入) | 无断言 | 已落但未验 |
| M-20 | 自定义端点由用户自装 openai-compatible 包;核心无特殊机制 | 核型层无端点/网关代码 | 无断言 | 已落但未验 |
| M-21 | 字符串路由若做 = 独立能力包(地图 Not yet specified) | 未实现;`docs/ROADMAP.md:115` 延后清单「字符串路由(models.dev 类)」行在位 | 无断言 | 未落(有意延后,登记在位) |

> 补充事实:`model.md:45` 写「已登记地图 Not yet specified」;实读地图 #65 的「Not yet specified」节当前为空(仅注释占位),延后登记实际落在 `docs/ROADMAP.md:115`。两处都指向「能力包、不进 core」。

#### 1.1.5 AI SDK 互操作包(model.md:47-106;M5 设计冻结)

**包面与漂移纪律(model.md:51-63)**

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| M-22 | 包名 `@balsats/ai-sdk`、对 core 走 peer、锁步发布 | `packages/ai-sdk/package.json`(version `0.5.0`;`peerDependencies {"@balsats/core":"workspace:^"}`;无 dependencies) | 无专门断言(清单事实) | 已落 |
| M-23 | `toAISdkStream(stream, options?: { onError? })` | `packages/ai-sdk/src/to-ai-sdk-stream.ts:42-52`;`index.ts:23-24` 导出 | `packages/ai-sdk/test/to-ai-sdk-stream.test.ts:169`(onError 替换脱敏文本) | 已落 |
| M-24 | `createChatRoute({ agent, identity, onError?, keepAliveMs? })` | `packages/ai-sdk/src/chat-route.ts:42-54`、`:65-76` | `packages/ai-sdk/test/chat-route.test.ts:54-321`(全文件) | 已落 |
| M-25 | `toAISdkMessages(messages)` 同步纯函数 | `packages/ai-sdk/src/to-ai-sdk-messages.ts:32`(非 async) | `to-ai-sdk-messages.test.ts:19-269` | 已落 |
| M-26 | `AISdkStreamChunk` 封闭帧联合;发布物不引 `ai` 类型 | `packages/ai-sdk/src/chunks.ts:53-85`;`dist` 内无 `'ai'` import;`ai` 只在 devDependencies | `packages/ai-sdk/test/cross-check.test.ts:30`(联合可赋值给 `UIMessageChunk`) | 已落 |
| M-27 | 目标 = `ai@7` 词汇 + 线级 `x-vercel-ai-ui-message-stream: v1` | `packages/ai-sdk/src/headers.ts:9-15`(五件套含该头) | `chat-route.test.ts:97`(逐响应头);`cross-check.test.ts:131`(与官方常量全等) | 已落 |
| M-28 | 单一代、无 `version` 选项、不做多代适配器 | 包面无任何 version/代际参数 | 无断言(结构性) | 已落但未验 |
| M-29 | 已发帧子集可小于、不得超出目标词汇 | `chunks.ts:53-85` 封闭联合;`:1-14` 注释「closed subset … must never exceed」 | `cross-check.test.ts:30`;`:38/107` 产物经官方 schema 往返解析 | 已落 |
| M-30 | 对校三条(帧联合可赋值 / SSE 字节往返 / 响应头全等) | — | `cross-check.test.ts:30`(check 1)、`:38`(check 2)、`:107`(check 2b)、`:131`(check 3)、`:136`(bonus) | 已落 |
| M-31 | `ai` 精确钉 `7.0.123` devDependency | `packages/ai-sdk/package.json` `"ai": "7.0.123"`(无 `^`) | 无断言(清单事实) | 已落 |

**转换器帧映射逐行(model.md:67-80)**

| ID | doc 行 → 实装 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| M-32 | `— → start-step`(流首帧前;`finish-step` 之后下一条模型产出帧前补;`tool-result` 不触发) | `to-ai-sdk-stream.ts:63-66`(`ensureStep()`)、`:88-91`、`:102-120`(tool-result 分支不调用) | `to-ai-sdk-stream.test.ts:41`、`:56`(「the result without a new step」) | 已落 |
| M-33 | `text-delta → 惰性 text-start + text-delta`;块 id 合成;非 text 帧补 `text-end` | `:79-87`;`:69-74`(`closeText()` 在 tool-call / finish / error 调用) | `to-ai-sdk-stream.test.ts:41`(id `text-0`)、`:93` | 已落 |
| M-34 | `tool-call → tool-input-available` 仅一帧;`providerExecuted: true`、`dynamic: true` | `:92-100` | `to-ai-sdk-stream.test.ts:56`;`chat-route.test.ts:97` | 已落 |
| M-35 | `tool-result → output-available / output-error`;`errorText` = string 原样否则 `JSON.stringify` 回退 `String()` | `:102-120`、`:139-147`(`errorTextOf`) | `to-ai-sdk-stream.test.ts:118` | 已落 |
| M-36 | `finish`(每 step) → `finish-step`,保持原序 | `:121-127` | `to-ai-sdk-stream.test.ts:56`;`chat-route.test.ts:97` | 已落 |
| M-37 | 源流抛出 → `error`(默认脱敏 `"An error occurred."`,`onError` 可换) | `:131-136`、`:16`(`DEFAULT_ERROR_TEXT`) | `to-ai-sdk-stream.test.ts:154`(先关 text 块、再 error 帧、后重抛)、`:169` | 已落 |
| M-38 | 不发清单(`reasoning-*` / `tool-input-*` / `tool-approval-*` / `source-*` / `file` / `custom` / `data-*` / `reset-step` / `message-metadata` / `abort` 等) | `chunks.ts:53-85` 联合不含;上游 `normalize.ts:83-99` 也不产 | 无逐帧负断言(`cross-check.test.ts:30` 只证可赋值) | 已落但未验 |

**路由(model.md:82-89)**

| ID | 承诺 | 实装(`chat-route.ts` 除注明外) | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| M-39 | `POST` only,其余 405 + `Allow: POST` | `:83-87`(`allow:'POST'` 头) | `chat-route.test.ts:54` | 已落 |
| M-40 | agent / durable agent 同一入口 | `:25`(`ChatRouteAgent = Agent \| DurableAgent`)、`:145` 同一 `stream` 调用面 | `chat-route.test.ts:200`(durable 挂起) | 已落 |
| M-41 | thread = `identity(request)` 的 `{thread?, resource}`,缺省 `body.id`;resource 必填 | `:118-135` | `chat-route.test.ts:266`(identity 优先、忽略 body id)、`:90`(两者皆缺 → 400) | 已落 |
| M-42 | `messages` 只取尾部 user 消息(text / file 起步,其余 400) | `:101-116`、`:277-297` | `chat-route.test.ts:69`、`:78`、`:164`(data-URL file)、`:140`(历史不回放) | 已落 |
| M-43 | 历史走 thread recall,不与客户端全量回放双喂 | `:145-148`(只传 `memory:{thread,resource}` + 尾条 user) | `chat-route.test.ts:140` | 已落 |
| M-44 | `trigger` 不分支 | 结构上从不读取(`:99-101` 注释明示) | 无断言 | 已落但未验 |
| M-45 | `start` 帧不带 `messageId` | `:173`(注释同) | `chat-route.test.ts:97` | 已落 |
| M-46 | body 白名单;`modelSettings`/`maxSteps` 等永不从 body 读 | `:99-101` 注释;`:145-148` 只组装 `memory`+`signal` | 无断言 | 已落但未验 |
| M-47 | 400 / 405 给具体原因;首帧前失败 500(默认脱敏 + `onError`) | `:83-135`;`:122/126/157`(500 + sanitize);`:56-57`(`DEFAULT_ERROR_TEXT`) | `chat-route.test.ts:62/69/78/90/245/256` | 已落 |
| M-48 | 首帧后失败 → `error` 帧 + `finish{finishReason:'error'}` + `[DONE]`,HTTP 200 | `:182-190`、`:205` | `chat-route.test.ts:224` | 已落 |
| M-49 | 响应头 = 官方 5 件套 | `headers.ts:9-15`;`chat-route.ts:222` | `chat-route.test.ts:97` | 已落 |
| M-50 | `keepAliveMs` 默认关,参数域 `(0, 2147483647]` | `:66-72`(RangeError 校验)、`:166-172` | `chat-route.test.ts:282`(开启)、`:296`(默认关);**未见 RangeError 单测** | 已落(一处未验) |
| M-51 | 同 thread 并发不设锁;取消:`request.signal` 直传 run、响应流 `cancel()` 同接 abort;无恢复端点(`resume:true` 不互容) | 无锁;`:137-143`、`:145-148`、`:216-219`(signal);只有 POST handler | 取消:`chat-route.test.ts:307`;「无锁 / 无恢复端点」无断言 | 已落但未验(并发/无恢复端点) |
| M-52 | 终帧 `finish{finishReason, messageMetadata?}`;映射 `suspended→other`,其余透传;`messageMetadata={usage?, suspended?}` | `:187-205`、`:251-253`;`chunks.ts:26-41`、`:81-85` | `chat-route.test.ts:97`(`stop`,含 usage)、`:216`(`other`) | **部分落**:实装**恒**写 `messageMetadata:{usage}`(`:199-201`),doc 写作可选 `usage?`;`length`/`tool-calls`/`error` 逐值映射无断言 |

**挂起表达、订阅流、历史回读(model.md:91-106)**

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| M-53 | durable 挂起 = `finishReason:'other'` + `messageMetadata.suspended{runId, awaitingApproval}` | `chat-route.ts:194-203`、`:242-248`;`chunks.ts:26-41` | `chat-route.test.ts:200` | 已落 |
| M-54 | 不合流 `tool-approval-*`;resume 编排归应用 | `chunks.ts:53-85` 无该帧;包内无 resume 调用 | 无断言 | 已落但未验 |
| M-55 | `toAISdkStream` 直接吃 `subscribeToThread`(一个订阅 = 一条持续消息) | 源头 `packages/core/src/signals/signals.ts:121`(`subscribeToThread(target): AsyncIterable<Chunk>`)、`:381-395` 逐 chunk fan-out;`to-ai-sdk-stream.ts:12` 只吃 `AsyncIterable<Chunk>` | ai-sdk 侧**无** signals 集成断言 | 已落但未验 |
| M-56 | 逐 run 消息切分不做(订阅通道无 run 边界标记) | `signals.ts:229-237` 只推 chunk | 无断言 | 已落但未验 |
| M-57 | 历史回读规则(user 一条;assistant/tool 序列折叠一条;第二条 assistant 起插 `step-start`;结果按 `toolCallId` 折入;`execution-denied → output-denied`) | `to-ai-sdk-messages.ts:32-52`、`:103-146`、`:149-185` | `to-ai-sdk-messages.test.ts:19/50/136/184/240` | 已落 |
| M-58 | 宽容原则:配对不上的结果、未知 part、system / 工作记忆跳过不抛错 | `:149-152`、`:135` 注释、`:46-49`(system 跳过) | `to-ai-sdk-messages.test.ts:217`、`:136` | 已落 |
| M-59 | UIMessage id 取折叠序列首条消息 id;跨刷新 id 重生成属已知 | `:108`(`const id = messages[start]!.id`);`chunks.ts:143-147` 文档写明 | `to-ai-sdk-messages.test.ts:107`(`id:'m2'`) | 已落 |

#### 1.1.6 依赖预算与关系节(model.md:118-129)

| ID | 承诺 | 实装/测试 | 状态 |
| --- | --- | --- | --- |
| M-60 | 核心运行时依赖硬线 = 0 | `packages/core/package.json` 无 `dependencies`;`scripts/lib.mjs:13`;`scripts/check-runtime-deps.mjs` 硬闸门;`packages/core/deps-budget.json` 不存在(脚本语义=0 依赖直接 ok) | 已落 |
| M-61 | 能力包运行时依赖硬线 = 0;`ai` 仅 devDependency;口径归 `deps-budget.json` | `packages/ai-sdk/package.json`(无 deps;peer core + devDep `ai`);`deps-budget.json`(`"dependencies": {}`) | 已落 |
| M-62 | 关系节:Agents 继承 model 字段与 chunk 协议 | 见 §5 跨子系统 `X-` 行 | 已落 |
| M-63 | Observability 的 `agent-step` span 取 finish/usage | `packages/core/src/agent/loop.ts:367-374`(attributes `usage`/`finishReason`);`packages/core/src/observability/span.ts:37-38`;测试 `packages/core/test/agent-observability.test.ts:73` | 已落 |
| M-64 | Memory 的 embedding 复用契约「届时确认」 | 未见 embedding 相关实现 | 未落(约定为届时确认) |

#### 1.1.7 「扩展面:可选方法 + 能力标志」检查

| ID | 事实 | 证据 | 状态 |
| --- | --- | --- | --- |
| M-65 | **model.md / agent.md 两篇都没有该节**;该模式定义在 `docs/architecture/storage.md:19-21`。最接近的内容:model.md:49「已发帧子集只许收窄」→ 实装封闭联合 `chunks.ts:53-85`;agent.md:62「Processor 三钩(v1)」→ 三个全可选方法 `packages/core/src/agent/processors.ts:31-42` | `packages/core/test/agent-surface.test.ts:160`(空对象 `Processor` 合法) | 已落 |

#### 1.1.8 model 子系统「关键差异」「无断言面」

**关键差异(4 条,均已在表内标注)**

1. **M-52**:`messageMetadata.usage` 实装恒存在,规范写作可选;`length`/`tool-calls`/`error` 映射无逐值断言。
2. **M-18**:「核心不透出 AI SDK 流格式」只有间接断言。
3. **M-21**:字符串路由登记实际在 `ROADMAP.md:115`,而 model.md:45 指向地图「Not yet specified」(该节当前为空)。
4. **无断言面清单**:M-6(版本跟随策略)、M-19/M-20(SPI/注册表/magic string/自定义端点)、M-28(单一代)、M-38(不发清单负断言)、M-44(trigger)、M-46(body 白名单)、M-51(同 thread 无锁、无恢复端点)、M-54(tool-approval 不合流 / resume 归应用)、M-55/M-56(订阅流集成、run 边界)、M-50 的 RangeError 单测。

#### 1.1.9 model 砍单表复核(model.md:108-116)

| ID | 砍单项 | 现状 | 证据 |
| --- | --- | --- | --- |
| CUT-M1 | 反向互操作(`withMastra` 类) | **仍是砍单** | 全仓 `rg withMastra` 仅命中 `model.md:112` 自身;`packages/ai-sdk/src/**` 无接受 AI SDK 流 part 的 API |
| CUT-M2 | workflow / network 路由 | **仍是砍单** | `rg workflowRoute\|networkRoute` 仅命中 `model.md:113`;`chat-route.ts` 只有 agent/durable 一条面 |
| CUT-M3 | AI SDK `resume:true` 的 GET 恢复端点 | **仍是砍单** | `chat-route.ts:83-87` 非 POST 一律 405;重开指向成立(`ROADMAP.md:120`「resumable stream」行在位) |
| CUT-M4 | 无状态全量 `UIMessage[] → ModelMessage[]` 转换 | **仍是砍单** | `rg 'UIMessage\[\]|toModelMessages' packages/ai-sdk/src` 只命中反向 `to-ai-sdk-messages.ts:32-33`;`chat-route.ts:101-116` 只取尾条 user |
| CUT-M5 | typed 工具渲染(`dynamic:false` 直通) | **仍是砍单** | `to-ai-sdk-stream.ts:92-99` 硬编码 `dynamic:true`;`chunks.ts:59-66` 该字段为字面量 `true`;`to-ai-sdk-messages.ts:112-125` 只产 `dynamic-tool` |

### 1.2 agent 子系统(`docs/architecture/agent.md`,103 行)

#### 1.2.1 定义表面与注入缝(agent.md:10-28)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| AG-1 | 五字段(name/instructions/model/tools?/description?) | `packages/core/src/agent/types.ts:29-45` | `packages/core/test/agent-surface.test.ts:26`(必填/可选)、`:94`(多余字段 `@ts-expect-error`) | 已落 |
| AG-2 | 所有字段接受 `T \| (ctx)=>T \| Promise<T>` | `types.ts:108`;`packages/core/src/agent/agent.ts:117-123` 四字段并发解析 | `agent-surface.test.ts:63/76`;`packages/core/test/agent-dynamic.test.ts:18/241` | 已落 |
| AG-3 | run 在调用模型前解析 instructions/model/tools;与工具 ctx 同一对象 | `agent.ts:113-124`、`:307-328`;`packages/core/src/agent/loop.ts:737-744` | `agent-dynamic.test.ts:139`(同一份对象) | 已落 |
| AG-4 | `description` 不进 run;包装处用 `resolveDynamicArgument` | `agent.ts:88-90` 注释;`agent.ts` 无 description 解析路径 | `agent-dynamic.test.ts:103`;`packages/core/test/agent-as-tool.test.ts:44-53` | 已落 |
| AG-5 | `RequestContext = { signal, runId, ...用户袋 }`,纯对象,无泛型 | `types.ts:91-98`;`agent.ts:307-328`(框架字段写在最后) | `agent-dynamic.test.ts:139/205/222`;`packages/core/test/agent-loop.test.ts:459` | 已落 |
| AG-6 | instructions 仅 string(数组/SystemMessage 全砍) | `types.ts:33` | `agent-surface.test.ts:48`(数组形状被类型拒绝) | 已落 |
| AG-7 | tools 容器 `Record<string, Tool>`,键即名,构造期唯一性校验 | `types.ts:43`;`packages/core/src/tools/tool.ts:48-57`;`tools/to-model-tools.ts:17-24` | `packages/core/test/agent-tools.test.ts:135`(键重名编译期断言)、`:118`、`:152` | 已落(唯一性由 Record 编译期承担) |
| AG-8 | memory 一等可选字段;模型调用前 recall、每 step 后 save | `types.ts:54`;`agent.ts:157-164`(recall 早于 processInput);`loop.ts:490-498`(save 在 processOutputStep 之后) | `packages/core/test/agent-memory.test.ts:56/112/163` | 已落 |
| AG-9 | 组合根分发 tracer;配置自带优先;缺席零开销 | `packages/core/src/app.ts:120-141`;`agent.ts:357-379` | `packages/core/test/app.test.ts:44/96/134`;`agent-observability.test.ts:707` | 已落 |

#### 1.2.2 执行语义(agent.md:42-50)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| AG-11 | 输入 `string \| Message[]`,直通 vendor prompt 类型 | `agent.ts:432-436` | `packages/core/test/agent-generate.test.ts:60` | 已落 |
| AG-12 | 输出对象:for-await + 七个 await 终值 | `packages/core/src/agent/stream.ts:140-170`;`types.ts:384-404` | `packages/core/test/agent-stream.test.ts:17/87/104/125` | 已落 |
| AG-13 | `generate()` = `stream()` + await,单一代码路径 | `agent.ts:229-245` | `agent-stream.test.ts:191`;`packages/core/test/agent-structured-output.test.ts:346` | 已落 |
| AG-14 | run > step 两层,不收 model step | `types.ts:358-367`(`AgentStep`);无第三层类型 | 无断言 | 已落但未验 |
| AG-15 | finishReason 五值;`'suspended'` 只在 `createDurableAgent` 内产生,裸 agent 不出现 | `chunks.ts:18`;`loop.ts:415-426`(`decision?.suspend === true` → `settled='suspended'`);入口是公开 run option `types.ts:186`(`stepBoundary?`),由 `packages/core/src/durable-agent/durable-agent.ts:154-182` 组装 | `packages/core/test/agent-step-boundary.test.ts:163`:裸 `Agent`(经 `assistantWithTools`,helper 见 `packages/core/test/helpers/agent.ts:18-20`)显式传 `stepBoundary` 得到 `finishReason==='suspended'` | **部分落**:语义与文档一致的前提是「不传 seam」;seam 本身是 `AgentRunOptions` 公开成员(`harness.md:23` 同口径) |
| AG-16 | `steps[]` 每步 text/toolCalls/toolResults/usage | `types.ts:358-367`;`loop.ts:469-483`、`:906-924` | `agent-stream.test.ts:138`;`packages/core/test/agent-processors.test.ts:248` | 已落 |
| AG-17 | `maxSteps` 默认 5、正整数 | `loop.ts:28`(`DEFAULT_MAX_STEPS=5`);`agent.ts:331-337`(非整数/≤0 抛错) | `agent-loop.test.ts:246`(默认 5 封顶)、`:295`(非正整数报错) | 已落 |
| AG-18 | `modelSettings` / `providerOptions` 透传;框架字段不可被覆盖 | `agent.ts:277-294`(框架字段写在 spread 之后) | `agent-generate.test.ts:110/125/134/173` | 已落 |
| AG-19 | `signal` 沿工具调用与动态参数解析传播 | `agent.ts:291`、`:325`;`loop.ts:737-744` | `agent-loop.test.ts:418/493/535`;`agent-generate.test.ts:152/162` | 已落 |
| AG-20 | `traceId?`/`parentSpanId?` 续接;空串 = 无 trace | `agent.ts:357-379` | `agent-observability.test.ts:257/277/295/319/342` | 已落 |
| AG-21 | `hideInput?`/`hideOutput?` 本次 run 覆盖 | `agent.ts:369-377` | `agent-observability.test.ts:362/386` | 已落 |
| AG-22 | `structuredOutput` 一等支持:JSON Schema 随每次调用下发、终值 strict 校验、`object` 落值、不传即纯文本 | `packages/core/src/agent/structured-output.ts:60-64`、`:71-94`、`:30-52`;`agent.ts:288-290`;`loop.ts:906-924` | `agent-structured-output.test.ts:43/66/78/110/127/145/175/194/234/264/275/298/327/346/371/385/400/411/428/441` | 已落 |
#### 1.2.3 Agent loop(agent.md:52-58)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| AG-25 | loop 是 Agent 内部实现(不导出) | `packages/core/src/agent/index.ts:7-37` 未导出 loop;`loop.ts:28` 的 `DEFAULT_MAX_STEPS` 不在入口 | `packages/core/test/entry-points.test.ts`(导出面,属另一票) | 已落 |
| AG-26 | 停止条件:无 tool-call 即停;`maxSteps` 封顶 | `loop.ts:376`(`pending`)、`:500-503` | `agent-loop.test.ts:31/246/267` | 已落 |
| AG-27 | 不做 stopWhen DSL | 无该字段 | 无断言 | 已落但未验 |
| AG-28 | 耗尽前最后一步照常完整执行(工具执行、结果不再回喂) | `loop.ts:429-464`(照常执行)、`:500-503`(结果不 push 回 prompt) | `agent-loop.test.ts:246`(「末步工具照常执行」) | 已落 |
| AG-29 | 终值 `finishReason` 为 `'tool-calls'`(不 relay provider 原始 reason) | `loop.ts:380-382`(`terminalFinish = { ...finishChunk, finishReason:'tool-calls' }`) | `agent-loop.test.ts:282`(provider 报 stop 时终值仍 tool-calls) | 已落 |
| AG-30 | 同一步多个 tool-call 按序串行执行、结果按序并入 | `loop.ts:430-464`(`for (const call of pending)` + 顺序 push/yield) | `agent-loop.test.ts:31/216` | 已落 |
| AG-31 | 并发策略 v1 不做 | 无并发代码 | 无断言 | 已落但未验 |
| AG-32 | provider 已执行的调用不重复执行 | `loop.ts:376`(以 `rawAnswered` 过滤) | `agent-loop.test.ts:513` | 已落 |
| AG-33 | 错误回喂:校验失败 / execute 抛错 / 未知工具 → error 工具结果,run 不中止 | `loop.ts:657-703`(三条线) | `agent-loop.test.ts:305/339/365/395` | 已落 |
| AG-34 | 审批/挂起不在核心;核心 loop 无快照 | `loop.ts:394-427`(只回调 + 置 `settled`);快照在 `durable-agent.ts` | `agent-step-boundary.test.ts:101/163/199` | 已落 |

#### 1.2.4 Processor(agent.md:60-68)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| AG-35 | 唯一横切扩展点;挂载位 `AgentConfig.processors`;不进实例表面 | `types.ts:60-69`;`agent.ts:64,78`(`#processors`) | `agent-surface.test.ts:160`(`expect(agent).not.toHaveProperty('processors')`) | 已落 |
| AG-36 | 钩子按声明顺序串行;`void` 保持原值;可异步 | `packages/core/src/agent/processors.ts:174-189` `thread()` | `agent-processors.test.ts:145/465/782`、`:119`(异步) | 已落 |
| AG-37 | `processInput({messages, requestContext})` run 开始一次,在动态解析后、首次调用前 | `processors.ts:33-35,45-60,117-128`;`agent.ts:180-182` | `agent-processors.test.ts:58/79/101/119/145` | 已落 |
| AG-38 | `processOutputStep({step, stepIndex, requestContext})` 每 step 一次,改写后为权威记录(终值/prompt/span),chunk 流与 step span 仍是原始产出 | `processors.ts:63-76,135-148`;`loop.ts:469-483`、`:511-515` | `agent-processors.test.ts:184/248/298/352/447/465/494` | 已落 |
| AG-39 | `processError({error, source, stepIndex, toolCall?, requestContext})`;`source:'model'\|'tool'`;不 abort/retry;取消不触发;execute 抛错保留 `Tool 'x' failed:` 框 | `processors.ts:82-110,155-167`;`loop.ts:317-320`(取消直抛)、`:324-332`/`:347-352`(model)、`:451-457`(tool)、`:688`(框架框) | `agent-processors.test.ts:510/539/561/635/664/706/759/809/838/869`;`:618` 断言 `"Tool 'boom' failed: [redacted]"` | 已落 |
| AG-40 | 钩子自身抛错即 run 失败,不交给 `processError`;chunk 级流式 processor 裁出 v1 | `processors.ts:174-189` 无 try/catch,错误沿 generator 抛出;`Processor` 无 `processOutputStream` 类方法 | **无断言**(测试中的 `throw` 均属工具 execute / 模型,非钩子自身);chunk 级裁项无断言 | 已落但未验 |

#### 1.2.5 多 agent 组合(agent.md:70-90)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| AG-41 | 规范形态 = as-tool;无 `agents` 字段、无委派协议 | `packages/core/src/agent/*` 无该字段;`Agent` 无子 agent API | `agent-as-tool.test.ts:44-53`(包装器 = 规范 recipe) | 已落 |
| AG-42 | 上下文零透传 | `agent.ts:307-328`(每 run 新建 context) | `agent-as-tool.test.ts:181` | 已落 |
| AG-43 | 取消与观测沿链:`signal` 一行;`traceId`/`spanId` 经工具 ctx;父侧无 trace 时空串不续接 | `loop.ts:630-644`(tool span 是 ctx 来源)、`:737-744`(空串编码);`agent.ts:364-366` | `agent-as-tool.test.ts:248/327/354/408/440` | 已落 |
| AG-44 | memory 默认无状态;带记忆 = 显式传 | `agent.ts:466-487`(`toRunMemory`) | `agent-memory.test.ts:354` | 已落 |
| AG-45 | 嵌套审批不支持;sub-agent 不做 durable 包装 | `durable-agent.ts` 只在最外层包装;核心无嵌套支持 | 无断言 | 已落但未验 |
| AG-46 | 演化门(`createSupervisor` 类能力包优先) | 无该包/字段;`ROADMAP.md:111` 有 Supervisor 重开条件 | 无断言 | 已落(未实现,符合砍单) |

#### 1.2.6 依赖预算(agent.md:101-103)

| ID | 承诺 | 实装 | 状态 |
| --- | --- | --- | --- |
| AG-47 | 核心(含 Agent)运行时依赖硬线 = 0 | `packages/core/package.json` 无 `dependencies`;`scripts/lib.mjs:13` `ZERO_RUNTIME_PACKAGES`;核心 `src` 外部 import 为空 | 已落 |

#### 1.2.7 agent 子系统「关键差异」「无断言面」

**关键差异(1 条)**:AG-15 —— 「裸 agent 不产生 `'suspended'`」的文档口径(`agent.md:46`、`harness.md:23`)只在调用方不传 `stepBoundary` 时成立;该 seam 是公开 run option,裸 `Agent` 显式传入即可产生 `'suspended'`(有测试固定,`agent-step-boundary.test.ts:163`)。

**无断言面清单**:AG-14(run/step 两层无第三层)、AG-27(stopWhen DSL 不做)、AG-31(并发策略不做)、AG-40(Processor 钩子自身抛错;**无断言**;chunk 级 processor 裁项)、AG-45(嵌套审批不支持)、AG-46(演化门)。另 AG-43 的「父侧无 tracer」NoOp 路径主要由 `agent-as-tool.test.ts:408/440` 覆盖。

#### 1.2.8 agent 砍单表复核(agent.md:30-40)

| ID | 砍单项 | 现状 | 承载缝指向是否仍成立 |
| --- | --- | --- | --- |
| CUT-AG1 | scorers / evals | **仍是砍单**(未实现) | 成立:`ROADMAP.md:114`「Evals / scorers」延后行在位;`agent.md:34`「Evals 体系在雾中」与地图 #65「Not yet specified」区(当前为空)口径一致 |
| CUT-AG2 | voice / browser / channels / workspace / skills | **仍是砍单**(未实现) | 部分成立:地图 #65「Out of scope」列出 `channels / voice / workspaces`,映射 `ROADMAP.md:130`/`:150`;**`browser`/`skills` 未在两处具名** |
| CUT-AG3 | editor / rawConfig | **仍是砍单** | 成立:`ROADMAP.md:129/150`「Studio / editor / stored agents」出域档在位(行号经复核修正) |
| CUT-AG4 | durable / pubsub / backgroundTasks / signals / goal / notifications | **已部分落**(不是字段位置,而是独立子系统/工厂) | 成立:ADR `docs/adr/0011-harness-semantics.md` 在位;durable 与 signals 已实现(`packages/core/src/durable-agent/`、`packages/core/src/signals/`);pubsub = signals 的进程内实现(`signals/signals.ts:21` 注释 + `harness.md:50`);backgroundTasks 归 `ROADMAP.md:117`;goals 归 `:118`;notifications 归 `storage.md:163` + `harness.md:131`;`harness.md:8`「Harness 是文档分类,不是统一模块」、`:23`「Harness 持有 agent,不是反之」 |
| CUT-AG5 | defaultOptions / metadata | **仍是砍单** | 成立:两字段均不在 `AgentConfig`(`types.ts:29-70`),无 `rg` 命中 |
| CUT-AG6 | hooks / transform / maxRetries | **仍是砍单** | 成立:三字段均无;承载缝分别为 Processor(`processors.ts`)与 fallback 链(`model/fallback.ts`、`agent-fallback.test.ts`) |
| CUT-AG7 | 标题生成 | **仍是砍单** | 成立:核心无标题生成;唯一 `title` 是 memory thread 元数据(`types.ts:326-329`),非会话标题 |

> 说明:CUT-AG1..AG7 对应 agent.md:30-40 的全部砍单行(7 行);A1 分片原文逐行复核,本表原样收录。另:§1.2 的承诺行编号 AG-10 / AG-23 / AG-24 在合成时因与相邻行合并而留空(编号保持稳定,不重排)。

### 1.3 tools 子系统(`docs/architecture/tools.md`,152 行;含 MCP 两个能力包)

#### 1.3.1 Tool 定义表面(tools.md:10-25)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| T-1 | 四字段 `ToolConfig`:`description` 必填、`inputSchema?`/`outputSchema?`/`execute` | `packages/core/src/tools/tool.ts:64-79`、`:100-113`(createTool 返回恰四字段) | `packages/core/test/tools-surface.test.ts:15-59`(键集恰四字段/冻结)、`:120-128`(缺 description/execute 编译错误) | 已落 |
| T-2 | 无 id/name;名字唯一真相 = 容器 Record 键;MCP 暴露同键 | `tool.ts:48-57`;容器类型 `packages/core/src/agent/types.ts:43`;server 端 `packages/mcp-server/src/index.ts:147` 以键注册 | `packages/core/test/agent-tools.test.ts:118-133` | 已落 |
| T-3 | 同字面量重名 = TS 编译错误;唯一性校验落编译期 | 无运行期校验(对象语义) | `agent-tools.test.ts:135-150`(`@ts-expect-error` + 运行期只剩一个键) | 已落 |
| T-4 | `createTool` 仅为类型推断,返回冻结普通对象;手写字面量合法 | `tool.ts:108-113`(`Object.freeze`) | `tools-surface.test.ts:15-59`(原型 = Object.prototype、冻结)、`:186-208`(手写字面量/混装) | 已落 |
| T-5 | 字段不逐个动态化;per-request 换工具集在容器层整组替换 | `agent/types.ts:43`(DynamicArgument 包整组);框架无 per-field 解析 | `packages/core/test/agent-dynamic.test.ts:67-95` | 已落 |
| T-6 | schema 契约 = `StandardSchemaV1 & StandardJSONSchemaV1` | `packages/core/src/standard-schema.ts:166-167`;`tools/index.ts:13-17` 导出 | `packages/core/test/standard-schema-contract.test.ts:22-84`(与上游双向可赋值;单接口被拒) | 已落 |
| T-7 | `~standard.jsonSchema` 目标固定 draft-07;转换器产物原样直通,核心不改写 | `packages/core/src/standard-schema-runtime.ts:41-43`;`tools/to-model-tools.ts:32-37` | `agent-tools.test.ts:14-61`(同引用透传探针)、`:63-93`(与 zod 直调结果逐字一致) | 已落 |
| T-8 | 无参工具:parameters 补 `{type:'object',properties:{}}`,`input` 类型 `undefined` | `to-model-tools.ts:33-36`;`tool.ts:81-84` | `tools-surface.test.ts:41-50/87-97`;`agent-tools.test.ts:95-116` | 已落 |

#### 1.3.2 执行上下文(tools.md:27-44)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| T-9 | `execute(input, ctx)` 两参,模型给的与框架给的分属两个参数 | `tool.ts:56`、`:75-78` | `tools-surface.test.ts:163-182` | 已落 |
| T-10 | `ToolContext` 恰六件套 signal / runId / toolCallId / requestContext / traceId / spanId | `tool.ts:19-32` | `tools-surface.test.ts:139-161`(双向包含,不多不少) | 已落 |
| T-11 | 零权限模型:取消 = signal;审批/挂起归 Harness;授权 = 应用层;核心无 `requireToolApproval` | 核心 tools 无审批字段;审批声明在 `packages/core/src/durable-agent/durable-agent.ts:24`(`The approval declaration lives here, never on Tool`)、`:39-58` | 无 tools 侧断言;审批机械的测试属 durable-agent 套件(跨子系统,见 §5) | 已落(证据跨子系统) |
| T-12 | 不注入 agent / memory 引用 | 六件套之外无字段(`tool.ts:19-32`) | 结构事实,无断言 | 已落但未验 |
| T-13 | agent loop 内框架保证六件套齐备(provider 真值 toolCallId);未挂 tracer 时 traceId/spanId 为空串;手动直调同形 | `packages/core/src/agent/loop.ts:732-745`(span 缺席 → `''`) | `packages/core/test/agent-loop.test.ts:417-456`、`:459-511` | 已落 |

#### 1.3.3 校验与错误语义(tools.md:46-56)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| T-14 | 三线归一:input 校验失败 / execute 抛错 / output 校验失败 → error 工具结果回喂,run 不中止 | `loop.ts:657-703`(三线各自产 `ToolCallOutcome.failure`)、`:451-457` | `agent-loop.test.ts:304-415`(四例逐线断言 `isError:true` + 回喂 + run 继续) | 已落 |
| T-15 | 第四类:调用容器中不存在的名字 → 同样 error 结果回喂 | `loop.ts:663-667` | `agent-loop.test.ts:395-414` | 已落 |
| T-16 | 重复执行防护归工具幂等设计,框架给 `toolCallId` 作幂等键 | `tool.ts:24-25`;loop 不去重(provider 已执行的结果跳过是另一机制,`loop.ts:147`) | `agent-loop.test.ts:513+`;工具自身幂等无断言 | 已落 |
| T-17 | 校验由框架调用点执行(agent loop、MCP server 包);手动直调 execute 时校验归调用方 | `loop.ts:670-677`、`:693-700`;`tool.execute` 本体不校验;MCP 侧整体移交 SDK(`mcp-server/src/index.ts:151-157` 注释) | `agent-loop.test.ts:304-337`;`packages/mcp-server/test/fetch.test.ts:161-206` | 已落 |

#### 1.3.4 组合范式(tools.md:58-81)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| T-18 | agent as-tool 包装形态:description 经 `resolveDynamicArgument`;`traceId`/`parentSpanId: spanId` 透传 | 核心无新 API;helper `packages/core/src/agent/dynamic.ts:16-17`;包装为文档范式 | `agent-as-tool.test.ts:48-54`(逐字取自 agent.md 的包装器)、`:247-325` | 已落(核心无实装,范式由测试逐字复刻) |
| T-19 | workflow 中用工具:无 `createStep(tool)` 特化,一行手写包装 | `createStep` 只有 `StepConfig` 一个签名(`packages/core/src/workflows/step.ts:133-141`) | 无断言(仓内未见 workflow step 包 tool 的测试) | 已落(文档范式,无实装/无断言) |

#### 1.3.5 MCP server 能力包(tools.md:83-105)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| MS-1 | 独立包 `@balsats/mcp-server`,core 走 peer,直连依赖仅 `@modelcontextprotocol/server@^2.2.0` | `packages/mcp-server/package.json`(deps 恰 1 项;peer core);导入 `server/src/index.ts:18` + `:26`(`/stdio`) | 无断言(清单事实);`packages/mcp-server/deps-budget.json`(3 包 / 13,898,836 B) | 已落 |
| MS-2 | 包面 = `createMcpServer(options, config)`、`server.fetch`、`server.serveStdio({legacy?,transport?})`、`await server.close()` | `mcp-server/src/index.ts:67-78`、`:92-125`、`:51-56` | `mcp-server/test/fetch.test.ts:15-27`、`stdio.test.ts:31-74`、`fetch.test.ts:309-323` | 已落 |
| MS-3 | HTTP 传输接入面:`fetch` 即 web-standard handler;`opts` 透传 SDK `{authInfo?, parsedBody?}`(v1 不消费 authInfo) | `index.ts:64`、`:103-104` | `fetch.test.ts:299-307`(parsedBody);authInfo 无断言 | 部分落(authInfo 无断言) |
| MS-4 | era 姿态默认双代全服务(HTTP `legacy:'stateless'`、stdio `legacy:'serve'`),可切 `'reject'`;legacy sessionful 不做 | `index.ts:98-100`、`:105-109` | `fetch.test.ts:15-27`、`:264-297`(modern + reject);`stdio.test.ts:52-64`;「未指定即 SDK 默认」无直接断言 | 部分落(默认值由 SDK 承接,无独立断言) |
| MS-5 | `close()` 沿 SDK 语义:modern 在途中止、闭合后 fetch 拒绝;legacy stateless 交换不被追踪;notify/bus 不暴露 | `index.ts:118-123`;返回对象仅 3 成员 | `fetch.test.ts:309-323`;「在途中止」「stateless 不追踪」无断言 | 部分落 |
| MS-6 | 原语范围 v1 仅 tools;prompts/resources 后加 minor | `index.ts:145-149` 只 registerTool | 结构事实,无断言 | 已落 |
| MS-7 | ToolContext 合成:signal ← `ctx.mcpReq.signal`;toolCallId ← `String(ctx.mcpReq.id)`;runId/traceId/spanId 空串;requestContext 冻结空袋(只 signal+runId) | `index.ts:187-198` | `fetch.test.ts:119-142`(逐字段 + 冻结 + 袋内恰 `{signal,runId:''}`) | 已落 |
| MS-8 | 结果投影:有 outputSchema → `structuredContent` 原文 + text `render(output)`;无 → 仅 content;`render` = string 原样 / 其余 JSON.stringify / undefined 退化 String | `index.ts:174-178`、`:205-209` | `fetch.test.ts:59-117`(四例) | 已落 |
| MS-9 | 三线输入/输出校验与 execute 抛错由 SDK 归一为 `{content,isError:true}`;未知/禁用工具走 JSON-RPC error | 校验整体移交 SDK(`index.ts:151-171`) | `fetch.test.ts:161-218`(三线 isError + 未知工具 -32602) | 已落 |
| MS-10 | 工具名合法性 `[A-Za-z0-9_.-]{1,128}`,构造期逐键校验非法即抛 | `index.ts:131-138`(正则 + assert)、`:93-94`(构造期逐键) | `mcp-server/test/tool-names.test.ts:13-33`(`it.each` 展开 6 非法例 + 报错点名 + 合法集) | 已落 |
| MS-11 | 每请求实例(SDK 工厂模型);桥接层按次整组注册,容器构造时快照(后续变更不上线) | `index.ts:93-96`(`entries` 一次捕获 + `factory` 每次新建)、`:145-149` | 无断言(无「构造后改容器」测试) | 已落但未验 |
| MS-12 | schema 零适配:SDK 以 `~standard.validate()` 校验(transform 生效)、以 `~standard.jsonSchema` 出 JSON Schema(目标 draft-2020-12);inputSchema 需 object 根 | `index.ts:158-171`(schema 原样交给 SDK) | `fetch.test.ts:29-57`、`:161-206`;transform 生效 / object 根 / 目标版本无断言(均 SDK 行为) | 部分落 |

#### 1.3.6 MCP client 能力包(tools.md:107-139)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| MC-1 | 独立包;直连依赖仅 `@modelcontextprotocol/client@^2.2.0`(`.` 与 `./stdio` 两面);与 server 分开 | `packages/mcp-client/package.json`;导入 `client/src/index.ts:22` + `:29` | 清单事实;`packages/mcp-client/deps-budget.json`(13 包 / 14,837,940 B ≈ 14.1 MiB) | 已落 |
| MC-2 | 包面:`createMcpClient({transport, protocol?, timeoutMs?})`、`client.tools` getter、`refresh()`、`close()` | `client/src/index.ts:66-94`、`:102-173`、`:147-150`、`:151-159`、`:160-171` | `http.test.ts:28-47`、`refresh-close.test.ts:11-54/58-76` | 已落 |
| MC-3 | 接入形态唯一:外部工具转译为 Tool 直接进 agent 容器,不做平行容器 | `index.ts:190-204`(buildSnapshot → `Record<string,Tool>`) | `http.test.ts:41-42`;结构事实 | 已落 |
| MC-4 | 传输:stdio(`command+args+env`,SDK 拥子进程)+ Streamable HTTP(`url+headers`);env 整份替换、缺省 SDK 白名单;旋钮面收口,不接受 transport 实例注入 | `index.ts:108-122`;config 面恰 3 字段(`:66-77`) | 子进程 + env 整份:`stdio.test.ts:40-64`;其余不暴露为类型结构,无断言 | 部分落 |
| MC-5 | 身份由包内定(`@balsats/mcp-client` + 包版本),不可覆写 | `index.ts:34-35`、`:124-125` | `wire.test.ts:32-35`(clientInfo 恰为包名 + package.json 版本) | 已落 |
| MC-6 | era 缺省抬到 `'auto'`(discover 探测,失败回落 legacy);可 `'legacy'` / `{pin:'2026-07-28'}`(不回退) | `index.ts:176-178`(`protocolMode = protocol ?? 'auto'`)、`:128` | `wire.test.ts:23-68`(三姿态各一例);「自动探测成功走 modern」仅在 stdio 路径隐含 | 已落 |
| MC-7 | 超时:SDK 逐请求 60s 且无 client 级默认;`timeoutMs` 必须由本包在 connect 与每次 callTool 透传;无 per-call 覆盖 | `index.ts:104-105`、`:140`、`:154-157` | `http.test.ts:101-118`(tool 不答 → REQUEST_TIMEOUT) | 已落 |
| MC-8 | 认证 headers 透传;OAuth 助手裁出 v1 | `index.ts:115-119`;无 authProvider | `wire.test.ts:70-85`(每个 POST 带 authorization) | 已落 |
| MC-9 | 发现与快照:connect 时 listTools 一次(no-cursor 自动翻页)建快照;`refresh()` 走 `cacheMode:'refresh'` 换新快照、失败保旧;`tools` getter 身份稳定;不做 listChanged 订阅 | `index.ts:144`、`:151-159`、`:147-150`;无 listChanged 消费 | `refresh-close.test.ts:11-35/37-54`;多页翻页无断言(测试均单页) | 部分落(翻页无断言) |
| MC-10 | 连接生命周期:断线不自动重连;`close()` 幂等,在途以 `CONNECTION_CLOSED` 拒绝;stdio 按 SDK 顺序关停;不做退出钩子、不暴露 closed 观测 | `index.ts:160-171`;无重连逻辑 | `http.test.ts:154-175`、`refresh-close.test.ts:58-76`、`stdio.test.ts:58-63`;CONNECTION_CLOSED 仅注释、无断言 | 部分落 |
| MC-11 | 错误面原样抛出、不加层不改消息;列出的码:SdkError / SdkHttpError(401/403)/ 探测超时 / REQUEST_TIMEOUT / CONNECTION_CLOSED / 协议错误 / ProtocolError / LIST_PAGINATION_EXCEEDED | `index.ts` 无 try/catch 包装(除 terminate 静默) | 已断言:EraNegotiationFailed(`wire.test.ts:57-68`)、RequestTimeout(`wire.test.ts:87-98`、`http.test.ts:101-118`)、InvalidResult(`wire.test.ts:149-171`)、JSON-RPC error 原样(`wire.test.ts:187-199`)、UnsupportedResultType(`http.test.ts:137-152`);401/403、CONNECTION_CLOSED、LIST_PAGINATION_EXCEEDED 无断言 | 部分落(断言面) |
| MC-12 | ToolContext 消费:`signal` → `callTool({signal})` 直通;toolCallId/runId/traceId/spanId 不出网;requestContext 不透传 | `index.ts:136-142`(只取 signal,组装 `{name,arguments}`) | `http.test.ts:120-135`(signal 中止远端调用);「不出网」由实现结构保证,无逐字段断言 | 已落 |
| MC-13 | 结果投影:`structuredContent !== undefined` 直返;否则 text 块换行拼接;非 text 降级占位;`isError:true` 抛错;空结果 `''` | `index.ts:214-219`、`:222-227` | `wire.test.ts:102-199`、`http.test.ts:49-99`、`packages/core/test/working-memory.test.ts:477-484` | 已落 |
| MC-14 | MRTR:`inputRequired.autoFulfill:false` 显式钉死 → 确定性 `SdkError(UnsupportedResultType)` | `index.ts:129-131` | `http.test.ts:137-152` | 已落 |
| MC-15 | 桥接 schema 包装(内部工厂、不公开导出):显式标注 `StandardSchema<unknown,unknown>`;`vendor:'balsats'`、`version:1`、运行时 `types`;`validate` 永远同步返回 `{value}`;`jsonSchema.input` 返回远端原文(忽略 target、同引用);`jsonSchema.output` 抛;wrapper 与 `~standard` 均冻结 | `index.ts:238-254`;`:239` 显式注解;`:243` 运行时 `types:{input:undefined,output:undefined}`;未被任何入口导出 | `schema-bridge.test.ts:14-52/54-67/69-84`;`vendor`/`version`/`types` 运行时值无断言 | 部分落(断言面;另见 §4.3 DOC 行) |
| MC-16 | 不挂 outputSchema:桥接 Tool 的 outputSchema 缺省;远端与 SDK 已校验 structuredContent | `index.ts:197-201`(对象没有 outputSchema 键) | `schema-bridge.test.ts:86-97`(`'outputSchema' in tool === false`) | 已落 |
| MC-17 | 名冲突:`prefixTools(tools, prefix, separator='_')` 纯函数,新冻结 Record,execute 闭包内远端名不变,不做冲突检测;不进 client 配置面 | `index.ts:263-271`(导出);config 面不含它 | `schema-bridge.test.ts:100-122`(默认分隔符/自定义/同一工具引用/不改输入) | 已落 |

#### 1.3.7 关系与依赖预算(tools.md:141-152)

| ID | 承诺 | 实装/测试 | 状态 |
| --- | --- | --- | --- |
| T-20 | 模型层 chunk 承载 tool-call/result;schema 经双接口出 JSON Schema | `agent-tools.test.ts:14-93`;`packages/core/test/model-normalize.test.ts:65-72` | 已落(跨子系统) |
| T-21 | Agent:容器形状、错误回喂、maxSteps、signal 传播继承;审批不在核心 | 见 T-2/T-11/T-14 | 已落(跨子系统) |
| T-22 | Workflows:无特化重载,一行手写包装;ToolContext 与 StepContext 对齐 | 见 T-19 | 已落(无断言) |
| T-23 | Memory:授权归应用层;工具要记忆经 requestContext / 闭包 | 六件套无 memory 字段;`working-memory.test.ts` 经工具暴露 working memory | 已落 |
| T-24 | Harness:审批/挂起统一裁决,届时若进核心按 minor | `durable-agent/durable-agent.ts:24-58`(审批闸,不在 tools) | 已落(跨子系统) |
| T-25 | Observability:ctx 携带 traceId/spanId;as-tool 续 trace / 挂子 span | `agent-as-tool.test.ts:247-325` | 已落(跨子系统) |
| T-26 | 核心(含 tools 子路径)运行时依赖 = 0;MCP 两包隔离 | `packages/core/package.json` 三字段空;两包各自 deps-budget 基线 | 已落 |

#### 1.3.8 tools 子系统「关键差异」「无断言面」

**关键差异(A2 §6 六条,详见 §4.3)**:tools.md:137 的 `types:{input:unknown,output:unknown}` vs 实装 `{input:undefined,output:undefined}`(DOC-5);tools.md:138 的 `InvalidRequest`/`InvalidParams` 两码未在仓内观察到(仅 `InvalidResult`,DOC-6);其余四条属 workflows 侧。

**无断言面**:T-12(不注入 agent/memory)、T-19(workflow 内包工具)、MS-11(容器构造时快照)、MC-10 的 `CONNECTION_CLOSED`、MC-9 多页翻页、MC-15 的 `vendor`/`version`/`types` 运行时值、MS-12 的 transform 生效/object 根、MC-4 的 `stderr`/`cwd`/`maxBufferSize` 不暴露、MC-11 的 401/403 与 `LIST_PAGINATION_EXCEEDED`、MC-12 的「不出网」逐字段。

#### 1.3.9 tools 砍单表复核(tools.md 无独立砍单表;A2 §1.8)

| ID | 砍单项 | 现状 | 证据 |
| --- | --- | --- | --- |
| CUT-T1 | `@modelcontextprotocol/sdk`(v1 单包)为过时路径,明确排除(tools.md:85) | **仍是砍单** | 两包都直连 ^2.2.0(server/client),无 sdk 依赖 |
| CUT-T2 | OAuth 授权流助手裁出 v1(tools.md:130) | **仍是砍单** | `mcp-client/src/index.ts` 无 authProvider / 无 OAuth 助手,README 亦无 |
| CUT-T3 | 内联裁项群:v1 只收 legacy/transport、不做 legacy sessionful、v1 仅 tools、notify/bus 不暴露、旋钮一律不暴露、不提供 per-call 覆盖、不做 listChanged 订阅、不自动重连/不做退出钩子/不暴露 closed、无 elicitation/sampling/roots handler | **仍是砍单(现状与文本一致)** | tools.md:98-101、126、129、131、132、136;对应实装证据见 MS-4/5/6、MC-4/7/9/10 各行 |

### 1.4 workflows 子系统(`docs/architecture/workflows.md`,178 行)

#### 1.4.1 定义表面(workflows.md:15-66)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| W-1 | `createStep`:id + input/output schema + 可选 resume/suspend schema + retries + execute | `packages/core/src/workflows/step.ts:53-84`、`:91-118`、`:133-156`(retries 非负整数校验 `:142-146`) | `packages/core/test/workflows-surface.test.ts:16-84`、`:85-127`;`workflows-loop-wait.test.ts:461-486` | 已落 |
| W-2 | StepContext 七件套(`inputData`/`runId`/`signal`/`requestContext`/`getStepResult`/`resumeData`/`suspend`) | `step.ts:19-40`;装配 `walker.ts:694-717` | `workflows-run.test.ts:112-200` | 已落 |
| W-3 | 无 `createStep(agent\|tool)` 特化重载;无 `state`/`setState` 黑板 | `createStep` 单一签名;workflow 源码无 setState | 结构事实,无断言 | 已落(裁项) |
| W-4 | builder 七算子可变链式,每个 push 一条 `{type,...}`;`.commit()` 冻结;未 commit 不可 createRun | `workflow.ts:80-135`、`:182-258`、`:213-220`、`:276-289`;`Workflow` 才有 createRun(`:48-74`) | `workflows-surface.test.ts:160-172/173-274/275-333/327-340`;`workflows-type-state.test.ts:214-234` | 已落 |
| W-5 | 没有 DAG:执行就是对扁平条目数组的 for 循环解释 | `entry.ts:96-103`;`walker.ts:313-336`、`:356-380` | `workflows-surface.test.ts:253-274`;`workflows-run.test.ts:30-67` | 已落 |
| W-6 | type-state:`TPrevSchema` 逐链传递,只在 then 主轴严格;parallel/branch keyed 对象 | `workflow.ts:90-110`、`:140-158`(ThenInputAccepts 编译期闸) | `workflows-type-state.test.ts:46-155` | 已落 |
| W-7 | condFn 收与 execute 相同参数包(只读);dowhile/dountil 的 cond 另收 `iterationCount`,可抛错设最大迭代 | `entry.ts:20-33`;`walker.ts:1012-1020`(注入 iterationCount) | `workflows-loop-wait.test.ts:192-218`;`workflows-type-state.test.ts:135-156` | 已落 |
| W-8 | 嵌套 workflow as step 裁出 v1(后加 minor) | 无任何嵌套 workflow 入口 | 无 | **仍是砍单** |
| W-9 | Run 面:`createRun({runId?,traceId?,parentSpanId?})`;`start({inputData,requestContext?,signal?})`;`out.result`;`for await`;`run.resume({step,resumeData?})` | `run.ts:57-70`、`:72-95`、`:103-110`、`:119-130` | `workflows-run.test.ts:509-538`;`workflows-surface.test.ts:275-307`;`workflows-events.test.ts:28-72` | 已落 |
| W-10 | 双消费单路径(await 终值 / for-await 事件流) | `run.ts:291-396`(一份 pump 同时喂 result 与迭代器) | `workflows-events.test.ts:28-72`、`:271-345` | 已落 |
| W-11 | requestContext 开放袋;signal 沿 execute 与动态时长函数传播 | `run.ts:311-316`;`walker.ts:696-717`、`:1035` | `workflows-run.test.ts:112-200`;`workflows-loop-wait.test.ts:280-304` | 已落 |
| W-12 | `createRun` 收 `traceId?`/`parentSpanId?` 挂外部 trace;空串语义沿 agent;resume 不收取接选项 | `run.ts:57-70`;`walker.ts:262-273`;`WorkflowResumeOptions` 无 trace 字段(`run.ts:83-95`) | `workflows-observability.test.ts:322-361`(空串整对作废) | 已落 |

#### 1.4.2 控制流算子(workflows.md:68-77)

| ID | 算子承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| O-1 | `.then`:顺序;上一步校验后 output 作下一步 input;透传 | `walker.ts:358-360`;边界校验 `:648` | `workflows-run.test.ts:30-67`、`:259-290` | 已落 |
| O-2 | `.parallel`:全并发无上限;满同步点;任一步失败整块失败;挂起优先于同窗兄弟失败;`{[id]:output}` | `walker.ts:741-777`(`Promise.all` + suspends 优先 `:770-775`);无并发上限 | `workflows-control-flow.test.ts:54-270`;`workflows-suspend-resume.test.ts:1323-1395` | 已落 |
| O-3 | `.branch`:按定义序、第一个真分支;各分支 IO schema 一致;无真分支输出 `{}` | `walker.ts:788-820`(定义序短路;无真分支 `:819`);「各臂 IO schema 一致」无强制(注释 `:785-786` 写「expected to share」) | `workflows-control-flow.test.ts:285-437`;「IO 一致」无断言 | 已落(IO 一致性为约定,无强制/无断言) |
| O-4 | `.foreach`:输入须数组;默认 concurrency=1 须正整数;并发闸;保序收集;满同步点;任一次失败整块失败 | `workflow.ts:265-273`(定义期校验);`walker.ts:860-930`(自写闸 + 保序 + 停闸等在飞) | `workflows-control-flow.test.ts:446-686` | 已落 |
| O-5 | `.dowhile`/`.dountil`:条件前/后求值;输出 = 最后一次迭代输出;透传 | `walker.ts:959-1006`(dowhile 前置 `:973-979`、dountil 后置 `:983-988`) | `workflows-loop-wait.test.ts:39-243`(0 次迭代/至少一次/计数/失败) | 已落 |
| O-6 | `.sleep(ms\|fn)`:进程内 setTimeout + AbortSignal,非 durable;fn 收 RequestContext | `walker.ts:1034-1041`;`entry.ts:41` | `workflows-loop-wait.test.ts:245-351` | 已落 |

#### 1.4.3 suspend/resume 与快照(workflows.md:79-116)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| P-1 | `suspend(payload)` 控制信号:标记 suspended → 写快照 → 展开;不经重试、不落 failed 记录 | `suspend.ts:14-28`;`walker.ts:596-608`、`:324`;`retry.ts:31` | `workflows-suspend-resume.test.ts:108-159` | 已落 |
| P-2 | 快照 = JSON 可序列化 `{runId,status,input,stepResults,position}`;stepResults 记 status/output/起止/suspendPayload | `snapshot.ts:68-92`;`walker.ts:387-409` | `workflows-suspend-resume.test.ts:178-239`;`:108-134` | 已落(字段面) |
| P-3 | JSON-only 约束:大数据只存引用 | 无运行时执法;内存默认实现注释明说 `structuredClone` 会放行 Map/Set/Date/循环,JSON-only 是 port 契约(`in-memory-snapshot-store.ts:11-14`) | 无断言 | 已落(契约面;无执法/无断言) |
| P-4 | 恢复 = load → resumeData 过 resumeSchema → 从 position 重进;time-travel/restart/restartAll 全部裁出 v1 | `run.ts:230-283`;无 restart/time-travel API | `workflows-suspend-resume.test.ts:301-745`;裁项无 API | 已落 |
| P-5 | 持久化时机:有 storage 时每个条目完成 + suspend + 终态,固定写;无 shouldPersistSnapshot/prune 钩子 | `walker.ts:324`、`:335`、`:348`、`:340-345`;`run.ts:167-172`;无钩子 API | `workflows-suspend-resume.test.ts:241-267`、`:269-297`;sleep 条目写快照无直接断言 | 已落(部分:sleep 条目写无断言) |
| P-6 | resume 并发去重:进程内锁;跨进程 CAS = adapter 可选扩展 | `run.ts:142`、`:211-228`;核心 port 无 CAS(`snapshot.ts:100-105`) | `workflows-suspend-resume.test.ts:646-678`;CAS 实装于 `packages/sqlite/src/snapshots.ts:27-40,115` | 已落(核心锁 + adapter 扩展) |
| P-7 | suspend 在任何条目类型内都成立;条件里 suspend 显式报错 | `walker.ts:710-717`、`:720-724`;块内挂起 `:741-777,796-837,909-923,990-1003` | 块内挂起逐类:`workflows-suspend-resume.test.ts:746-1390`;**条件里 suspend 报错无断言** | 已落(部分:cond 报错无断言) |
| P-8 | position = 重进下标(suspend=挂起条目;running=下一条目;success=条目数);只写 running 快照当附真实 storage;无 storage 只写 suspend/终态 | `walker.ts:324,335,348`;`run.ts:167-172` | `workflows-suspend-resume.test.ts:178-239`、`:241-267`、`:634-644` | 已落 |
| P-9 | resume 回放:从快照 input 起、按记录重建 tip、不重执行不重估条件;resumeData 为第三处校验、替换原数据;无 resumeSchema 的 step 不接受 resumeData;step 必须与挂起 step 一致;resume 可再传 signal/requestContext | `walker.ts:417-466`、`:524-572`;`validate.ts:82-99`;`run.ts:251-257` | `workflows-suspend-resume.test.ts:301-745`、`:521-539`、`:540-566`、`:567-599`、`:600-633`;分支回放 `:362-482` | 已落 |
| P-10 | 信封与去重:挂起终态 `{status:'suspended',stepId,stepResults}`;resume 与 start 同信封;锁按 runId,settle 释放 | `run.ts:39-46`、`:211-228` | `workflows-suspend-resume.test.ts:108-134`、`:646-678`、`:700-745` | 已落 |
| P-11 | 写失败语义:快照写失败随 run 失败;failed 终态那一写 best-effort;run 自身错误原样上抛 | `run.ts:337-345`;suspend/success 的 persist 直接 await(`walker.ts:324,348`) | **无断言**(无「store.save 抛错」用例) | 已落但未验 |
| P-12 | 块是满同步点;挂起优先同窗兄弟失败;失败也等在飞 | `walker.ts:726-777`、`:839-930` | `workflows-suspend-resume.test.ts:1323-1395`;`workflows-control-flow.test.ts:623-667` | 已落 |
| P-13 | resume 按 site records-first 重进;branch 不重估条件;foreach 前缀回放、洞重跑;循环从 site 的 value/iterationCount 重进 | `walker.ts:753-756`、`:796-804`、`:867-880`、`:964-980` | `workflows-suspend-resume.test.ts:1246-1292`、`:747-812`、`:834-934`、`:936-1076` | 已落 |
| P-14 | resumeData 归属挂起的那一次执行(foreach 按 suspendedIndex;循环重进首次;后续迭代/兄弟臂 undefined) | `walker.ts:761-763`、`:891-894`、`:970` | `workflows-suspend-resume.test.ts:1293-1354`、`:834-934` | 已落 |
| P-15 | 多挂起收敛:首个落定者点名;其余臂各落 suspended 可续;foreach 洞重跑 | `walker.ts:748-775`、`:909-923` | `workflows-suspend-resume.test.ts:1293-1354` | 已落 |
| P-16 | 目标校验:site kind 与条目类型一致(loop 对两型);命名 step 属该块且记录为 suspended;不一致显式报错 | `walker.ts:426-462`、`:499-517` | `workflows-suspend-resume.test.ts:1077-1179`、`:1149-1179` | 已落 |
| P-17 | storage port 两方法 + 核心内存 Map 默认;不接即纯内存 | `snapshot.ts:100-105`;`in-memory-snapshot-store.ts:16-28`;`workflows/index.ts:67` 导出 | `workflows-suspend-resume.test.ts:1396-1425` | 已落 |
| P-18 | 快照 additive 扩展:`traceId?`(32-hex,有真实 span 才写)与 `iterationSite?`(判别联合 parallel/branch/foreach{collected}/loop{LoopCondition}) | `snapshot.ts:44-60`、`:85-91`;`walker.ts:393-406` | `workflows-observability.test.ts:236-319`;site 四类各自断言(`suspend-resume.test.ts:746,813,935,1180`) | 已落 |

#### 1.4.4 IO 校验(workflows.md:118-123)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| V-1 | 契约 = Standard Schema 双接口零适配 | `standard-schema.ts:166`;`validate.ts:108` | `standard-schema-contract.test.ts` | 已落 |
| V-2 | 校验点固定三处:start 输入、每个 step 边界、resumeData;无 validateInputs 开关,永远校验 | `walker.ts:297`、`:648`;`validate.ts:82-99`;构造函数无开关 | `workflows-run.test.ts:202-333`;`workflows-suspend-resume.test.ts:521-566` | 已落 |
| V-3 | start 失败抛错不启动;step 边界失败 → 该 step failed → run failed | `walker.ts:292-310`、`:648-666` | `workflows-run.test.ts:202-333` | 已落 |
| V-4 | 校验返回值替换原数据(default/transform 生效) | `walker.ts:297-298,648-651`;`validate.ts:115` | `workflows-run.test.ts:231-290`;`workflows-suspend-resume.test.ts:328-361,178-239` | 已落 |

#### 1.4.5 流式事件(workflows.md:125-142)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| E-1 | 最小 lifecycle 事件流,粒度 run/step 边界;chunk 级透传裁出 v1 | `events.ts:20-77`(四类事件);无 chunk 透传通道 | `workflows-events.test.ts:28-134`;裁项无 API | 已落 |
| E-2 | 事件是 start 输出对象第二消费,同一次执行同一顺序,带边界值 | `run.ts:291-396`;`walker.ts:303,645,655,664,218` | `workflows-events.test.ts:28-72`、`:271-305` | 已落 |
| E-3 | run-start 的 input = 校验后输入;被拒 start 不发事件 | `walker.ts:300-304` | `workflows-events.test.ts:135-155` | 已落 |
| E-4 | step-start input = 到达边界原值(校验前) | `walker.ts:645`(emit 在 validate 前) | `workflows-events.test.ts:28-72`;`workflows-observability.test.ts:180-207` | 已落 |
| E-5 | step-end status ∈ success/failed/suspended,output 只在 success;run-end status ∈ success/suspended | `events.ts:51-72` | `workflows-events.test.ts:157-269` | 已落 |
| E-6 | 块内 step = 每次执行一对;记录仍按块聚合 | `walker.ts:644-669`、`:606-611`、`:911-928` | `workflows-events.test.ts:73-134`;`workflows-observability.test.ts:88-115` | 已落 |
| E-7 | 失败:step-end failed 后迭代器以 run 错误 reject(不设 failed run-end);result 同错 | `run.ts:339-345`;`events.ts:61-65` | `workflows-events.test.ts:157-198` | 已落 |
| E-8 | 挂起:step-end suspended + run-end suspended;恢复段走 resume promise | `walker.ts:659-666`;`toRunEndEvent` `:276-280` | `workflows-events.test.ts:199-269` | 已落 |
| E-9 | 事件与 span 各记一边(事件原值 / span 校验后值);块内 suspend 同读 suspended;未被点名的挂起迭代事件照读 suspended、记录不落 | `walker.ts:645-656`;`events.ts:48-49` 注释仍写旧语义(见 §4.3 DOC-1) | `workflows-events.test.ts:235-269`;`workflows-observability.test.ts:180-207` | 已落(代码注释陈旧) |
| E-10 | 消费者提前 break:停缓冲、run 照跑完、result 仍落定 | `run.ts:348-376`(`abandoned`) | `workflows-events.test.ts:306-345` | 已落 |

#### 1.4.6 错误、重试与状态机(workflows.md:144-148)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| X-1 | 三态 success/failed/suspended;sleep 期间无 waiting;AbortSignal 取消落 failed(AbortError),不设 canceled/tripwire | `snapshot.ts:12`;`abort.ts:13-27`;`walker.ts:191,315,334` | `workflows-run.test.ts:370-466`;`workflows-loop-wait.test.ts:331-351` | 已落 |
| X-2 | `retries`:最多 `retries+1` 次、固定间隔 1000ms;只包 execute(边界校验一次);等待可被中止;最后错误原样;backoff 留扩展位 | `retry.ts:9-37`;`step.ts:142-146`;`walker.ts:648-654` | `workflows-loop-wait.test.ts:352-510` | 已落 |
| X-3 | `bail(payload)` 裁出 v1 | 无 API | — | **仍是砍单** |

#### 1.4.7 workflows「扩展面」检查与关键差异

- **无独立「扩展面:可选方法 + 能力标志」节**;相关表述两处:`workflows.md:114`(基础形状冻结;adapter 家族与 delete/list/CAS 可选扩展单点指向 `storage.md:19-21`)、`workflows.md:87`(resume 跨进程 CAS = adapter 可选扩展 `compareAndSave`)。`WorkflowSnapshotStore` 基础两方法在本篇冻结(`snapshot.ts:100-105`),可选扩展由 `@balsats/sqlite` 实现(属 storage 子系统面)。
- **关键差异**(A2 §6 的 6 条):DOC-1(`events.ts:45-49` 陈旧注释)、DOC-2(`step.ts:32-38` 陈旧 docstring)、DOC-3(JSON-only 无执法)、DOC-4(`.branch` IO schema 一致无强制)、DOC-5/DOC-6(tools 侧)。详见 §4.3。
- **无断言面**:P-3(JSON-only)、P-5 的 sleep 条目写、P-7 的条件内 suspend 报错、P-11(写失败语义)、O-3(IO 一致性)、X-3/W-8(裁项无 API)、T-19。

#### 1.4.8 workflows 砍单表复核(workflows.md:150-165)

| ID | 砍单项(行) | 承载缝文本 | 现状 | 证据 |
| --- | --- | --- | --- | --- |
| CUT-W1 | map / sleepUntil(:154) | 内联 step / 一行算术 | **仍是砍单** | 源码无 `map`/`sleepUntil`;sleep 只有 `.sleep`(`walker.ts:1034`) |
| CUT-W2 | createStep(agent\|tool) 特化重载(:155) | 一行手写包装(文档范式) | **仍是砍单** | `step.ts:133-141` 单一签名;替代表达见 T-19 |
| CUT-W3 | 嵌套 workflow as step(:156) | 后加 minor | **仍是砍单** | 无入口 |
| CUT-W4 | state / setState 黑板(:157) | getStepResult + 显式管道;后加 minor | **仍是砍单** | `walker.ts:575-577` `getStepResult` 为唯一跨步读取面;无 setState |
| CUT-W5 | bail(:158) | branch 建模;后加 minor | **仍是砍单** | 无 API |
| CUT-W6 | validateInputs 开关(:159) | 永远校验 | **仍是砍单** | 无开关;`validate.ts` 三处固定调用 |
| CUT-W7 | time-travel / restart / restartAll(:160) | load→重进原语;durable 归 Harness | **仍是砍单** | `run.ts` 仅 start/resume;无 restart API |
| CUT-W8 | shouldPersistSnapshot / prune 钩子(:161) | 固定 step 边界写 | **仍是砍单** | 无钩子参数;`run.ts:167-172` 固定策略 |
| CUT-W9 | resume CAS / serializedStepGraph / 多引擎适配(:162) | adapter 可选扩展 / 外部 runner 能力包方向 | **已部分落**(adapter 侧 CAS 落,其余未落) | `packages/sqlite/src/snapshots.ts:27-40`(`compareAndSave`)+`:115` 实现;`deleteSnapshot`/`listSnapshots` 同接口;serializedStepGraph / 多引擎适配全仓无 |
| CUT-W10 | chunk 级流式透传(:163) | step 内自行消费;后加 minor | **仍是砍单** | 事件仅四类(`events.ts:75-79`);无 chunk 通道 |
| CUT-W11 | durable sleep / 长延时等待(:164) | schedules + suspend 组合;调度触发归平台 cron / tick | **仍是砍单(核心侧)** | 核心 `.sleep` 为 `setTimeout` 非 durable(`abort.ts:29-47`);`packages/core/src/schedules/types.ts:43` 目标仅 agent/signal;措辞指向 harness.md |
| CUT-W12 | tripwire / canceled 状态(:165) | AbortSignal → failed | **仍是砍单** | 状态枚举无 canceled(`snapshot.ts:12`) |

### 1.5 memory 子系统(`docs/architecture/memory.md`,107 行)

#### 1.5.1 定位与供给策略(memory.md:8)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| MEM-1 | 语义层薄自研、存储走 port、默认内存实现、核心零依赖 | `packages/core/src/memory/memory.ts:108`(`config.storage ?? createInMemoryStore()`);`packages/core/package.json` 无 deps/peer | `packages/core/test/memory-surface.test.ts:127`;`packages/core/test/memory.test.ts:19` | 已落 |
| MEM-2 | semantic recall(向量 RAG)延后、留 seam | 无实装;`store.ts:17-34` 仅 8 方法,无 embedding/召回增强入口 | 无断言 | 未落(按裁单) |
| MEM-3 | OM 类后台压缩出本地图范围 | 无实装 | 无断言 | 未落(按裁单) |
| MEM-4 | bunfold 头号桥接候选、M5 裁定裁(不产桥接包) | 仓内无 bunfold 包/依赖 | 无断言 | 已落(裁单执行;重开条件 `ROADMAP.md:113`) |

#### 1.5.2 身份模型:thread / resource 双标识(memory.md:10-21)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| MEM-5 | 消息/thread 带 `threadId`+`resourceId`;thread 有 owner | `packages/core/src/memory/types.ts:11-30`;`memory.ts:151-157` 由调用参数盖章 | `memory.test.ts:18`;`packages/core/test/agent-memory.test.ts:246` | 已落 |
| MEM-6 | 不做访问控制 | `types.ts:10` 注释「memory does no access control」;无鉴权代码 | 无断言(结构缺席) | 已落但未验 |
| MEM-7 | 不提供所有权迁移 API | `memory.ts:186-190` 抛错 `ownership is not migrated` | `memory.test.ts:244` | 已落 |
| MEM-8 | per-call 显式选项两者必填、缺一调用期显式报错 | `packages/core/src/agent/agent.ts:466-483`(`toRunMemory` 两条显式错误) | `agent-memory.test.ts:307/297` | 已落 |
| MEM-9 | thread 不存在时自动创建(可带 title/metadata) | `memory.ts:176-184`、`:191-199` | `memory.test.ts:185/197/212` | 已落 |

#### 1.5.3 消息历史(memory.md:23-29)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| MEM-10 | `lastMessages` 默认 10、只按条数截断、不做 token 窗口 | `memory.ts:26`、`:109-112`、`:130-133`;`in-memory-store.ts:108-109` | `memory.test.ts:95/109`;`packages/core/test/memory-store.test.ts:168` | 已落 |
| MEM-11 | 消息格式 = vendor prompt + 存储信封;内部流转与存储同格式 | `types.ts:25-30`(`StoredMessage = ModelMessage & {…}`) | `memory-surface.test.ts:59`;`memory-store.test.ts:141` | 已落 |
| MEM-12 | 无 mastra 的 `signal` role | `packages/core/src/model/contract.ts:213-227`(仅 system/user/assistant/tool) | 无专门断言(`memory-surface.test.ts:59` 间接) | 已落但未验 |
| MEM-13 | 消息不可变 | `in-memory-store.ts:114-116`(按 id 全量替换、不合并);`types.ts:20-24` | `memory-store.test.ts:152`(重复 id 全量替换) | 已落(port 是 upsert,不删除历史版本) |
| MEM-14 | 单一查询入口 `recall({threadId,limit?,before?,order?})` | `memory.ts:127-137` | `memory.test.ts:140/151/162`;`memory-surface.test.ts:195` | 已落 |
| MEM-15 | Memory 实例方法全公开(chat UI 可直接调用) | `memory/index.ts:14` 导出;`recall`/`save`/`getWorkingMemory`/`updateWorkingMemory` 均 public | `memory-surface.test.ts:180` | 已落 |
| MEM-16 | recall 每 run 一次、run 开始 / `processInput` 之前 | `agent.ts:154-162`、`:497-519` | `agent-memory.test.ts:55/91`;`working-memory.test.ts:256` | 已落 |
| MEM-17 | agent loop 内消息列表内存累积 | `packages/core/src/agent/loop.ts:243-250` | `agent-memory.test.ts:112` | 已落 |
| MEM-18 | save 每个 step 后增量落库(首轮含用户输入) | `loop.ts:487-503`、`:545-576` | `agent-memory.test.ts:112/163/183` | 已落 |
| MEM-19 | `processOutputStep` 先于 save | `loop.ts:466-503` | `agent-memory.test.ts:499` | 已落 |

#### 1.5.4 工作记忆(memory.md:31-37)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| MEM-20 | 单 scope、resource 作用域(不做 thread/resource 开关) | `memory.ts:209-252` 全部以 `resource` 为键;`working-memory.ts:46-59` | `packages/core/test/working-memory.test.ts:69/487` | 已落 |
| MEM-21 | schema-only(Standard Schema,ADR-0003) | `memory.ts:49-52`;`working-memory.ts:115-129` | `working-memory.test.ts:303/324` | 已落 |
| MEM-22 | merge:深合并、`null` 删字段、数组整换、`undefined` 保留旧值 | `working-memory.ts:72-81` | `working-memory.test.ts:92/104/118/127` | 已落 |
| MEM-23 | markdown template WM 砍掉(schema-only) | 无 template 形态代码 | 无断言(结构缺席) | 已落(裁单执行) |
| MEM-24 | 更新只走 tool-call:启用即自动挂 `updateWorkingMemory` 工具 | `working-memory.ts:93-102`;`agent.ts:170,391-404`(同名冲突显式报错) | `working-memory.test.ts:303/348/366/375/384/405` | 已落(另注:实装另暴露 `Memory.updateWorkingMemory` 编程写入口 `memory.ts:228`) |
| MEM-25 | 校验失败按既有「工具错误回喂」语义 | `working-memory.ts:100` → `memory.ts:238-241` 抛 issues;loop 错误工具结果 | `working-memory.test.ts:458` | 已落 |
| MEM-26 | 注入:独立 system message、追加在 instructions 之后、不改写本体 | `working-memory.ts:136-145`;`agent.ts:412-425`(instructions→WM→history→input) | `working-memory.test.ts:226/256/274` | 已落 |
| MEM-27 | read-only 模式裁出 v1(后加 minor) | 无 `readOnly` 相关代码 | 无断言(结构缺席) | 已落(裁单执行) |

#### 1.5.5 存储 port:MemoryStore(memory.md:39-65)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| MEM-28 | 必备 6 签名(getThreadById/saveThread/deleteThread/listThreads/listMessages/saveMessages) | `packages/core/src/memory/store.ts:17-34` | `memory-surface.test.ts:73`;`memory-store.test.ts` 全 15 例;`packages/sqlite/test/memory.test.ts` 全 13 例 | 已落 |
| MEM-29 | 条件 2(getResource?/saveResource?)——能力标志模式首个实例 | `store.ts:30-40`、`:47-49`(`supportsWorkingMemory` 成对检测);`memory.ts:117-118,307-313`(构造期能力检查) | `memory-surface.test.ts:101/127`;`working-memory.test.ts:202/209/216` | 已落 |
| MEM-30 | `StoredThread`/`StoredMessage`/`StoredResource` 字段形状 | `types.ts:11-39` | `memory-surface.test.ts:29/59` | 已落 |
| MEM-31 | 端口裁单 6 项:`updateMessages`/`listMessagesById`/`updateThread`/`cloneThread`/`copyThread`/`listMessagesByResourceId` | 8 方法面内无这些方法(`store.ts:17-34`) | 无断言(结构缺席) | 已落(裁单执行) |
| MEM-32 | 核心自带内存 Map 默认实现(不接 storage 即纯内存) | `in-memory-store.ts:51-127` | `memory-surface.test.ts:127`;`memory-store.test.ts:296/316` | 已落 |
| MEM-33 | adapter 家族输入 `storage.md`;首个真实后端 = SQLite | `packages/sqlite/src/memory.ts:108`;`packages/sqlite/src/index.ts:83` | `packages/sqlite/test/memory.test.ts:273`(能力标志为真) | 已落 |

#### 1.5.6 外部记忆引擎(memory.md:63-65)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| MEM-34 | bunfold 类不落在 MemoryStore 缝上、M5 裁定不产桥接包 | 仓内无桥接包/依赖;裁单记 `ROADMAP.md:65,80` | 无断言 | 已落(裁单执行) |
| MEM-35 | 重开条件单一真相源 = ROADMAP 延后清单 | `ROADMAP.md:113` | 无断言 | 已落(文档面) |
| MEM-36 | 需要外部引擎的宿主走上游零代码路径或宿主侧组装 | 本仓无实装(宿主侧路径) | 无断言 | 未落(按裁定归属宿主) |

#### 1.5.7 配置表面与生命周期(memory.md:67-78)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| MEM-37 | `new Memory({ storage?, lastMessages?, workingMemory? })` | `memory.ts:55-67,107-119` | `memory-surface.test.ts:152/166/162` | 已落 |
| MEM-38 | Agent 侧 `memory?: DynamicArgument<Memory>`(全域动态) | `packages/core/src/agent/types.ts:54` | `agent-memory.test.ts:380` | 已落 |
| MEM-39 | 同一 Memory 实例可被多 agent 共享 | 无实例内 agent 绑定 | `agent-memory.test.ts:439` | 已落 |
| MEM-40 | 无后台写、无 `settled()`;连接生命周期归 adapter | `memory/` 无 `setInterval/setTimeout`;类面无 `settled` | 无断言(结构缺席) | 已落但未验 |

#### 1.5.8 依赖预算(memory.md:105-107)

| ID | 承诺 | 实装 | 状态 |
| --- | --- | --- | --- |
| MEM-41 | 核心(含 Memory)运行时依赖 = 0 | `packages/core/package.json` 无 deps/peer;`scripts/check-runtime-deps.mjs` 存在 | 已落 |

#### 1.5.9 memory 砍单表复核(memory.md:80-93)

| ID | 砍单项 | 现状 | 证据 |
| --- | --- | --- | --- |
| CUT-MEM1 | semantic recall(向量 RAG) | **仍是砍单** | 无 embedding/hook 实装;落库唯一入口 = `Memory.save → MemoryStore.saveMessages`(`memory.ts:160`) |
| CUT-MEM2 | OM 类后台压缩管线 | **仍是砍单** | 无代码;`summarize-and-truncate = Processor 模式` 仅存在于文档(`memory.md:85`) |
| CUT-MEM3 | thread cloning | **仍是砍单** | 无 API(`store.ts`/`memory.ts` 无 clone/copy) |
| CUT-MEM4 | 单条消息 update/delete | **仍是砍单** | 兜底 = `deleteThread` 级联(`in-memory-store.ts:66-72`;测试 `memory-store.test.ts:237`)。注:`deleteThread` 只在 port 上,`Memory` 类本身不暴露该方法 |
| CUT-MEM5 | thread title 生成 | **仍是砍单** | 无生成逻辑;title 是调用方字段(`memory.ts:32-34`) |
| CUT-MEM6 | markdown template WM | **仍是砍单** | 无 template 形态 |
| CUT-MEM7 | read-only WM | **仍是砍单** | 无 readOnly 配置 |
| CUT-MEM8 | token 窗口 | **仍是砍单** | 只按条数(`memory.ts:130-133`) |
| CUT-MEM9 | 访问控制 | **仍是砍单** | 无鉴权代码(`types.ts:10` 明文归应用层) |
| CUT-MEM10 | 所有权迁移 | **仍是砍单** | 显式抛错拒绝(`memory.ts:186-190`;测试 `memory.test.ts:244`) |

#### 1.5.10 memory「关键差异」「无断言面」

- **关键差异**:实装另暴露 `Memory.updateWorkingMemory` 编程写入口(`memory.ts:228`)与 `Memory.save` 带显式 `id` 的 upsert 语义(`memory.ts:42,151-153`)——规范承诺面未列这两个事实(前者有 `memory-surface.test.ts:180` 断言存在)。另:`deleteThread` 只在 port,`Memory` 类不暴露(CUT-MEM4 备注)。
- **无断言面**:MEM-6(不做访问控制)、MEM-12(无 signal role)、MEM-40(无后台写/无 settled)、`deleteThread` 只能经 port 调用、CUT-MEM1–10 十行裁项(结构缺席为主)。

### 1.6 observability 子系统(`docs/architecture/observability.md`,210 行;含 OTLP 能力包)

#### 1.6.1 Span 模型(observability.md:12-49)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| OBS-1 | Span 字段全形(id/traceId/parentSpanId/name/type/startTime/endTime/input/output/attributes/metadata/error/isEvent) | `packages/core/src/observability/span.ts:97-124` | `packages/core/test/observability-surface.test.ts:61` | 已落 |
| OBS-2 | id 16-hex、traceId 32-hex | `tracer.ts:129-130,365-370`(8/16 字节随机 hex) | `packages/core/test/observability-tracer.test.ts:44-45` | 已落 |
| OBS-3 | 7 个类型常量(kebab-case)、`type` 开放 string | `span.ts:10-19` | `observability-tracer.test.ts:72`;`observability-surface.test.ts:112-118` | 已落 |
| OBS-4 | attributes 按 type 收窄的判别联合 | `span.ts:26-70,77-84` | `observability-surface.test.ts:81`(含 `@ts-expect-error` 负例) | 已落 |
| OBS-5 | 各 type 的 input/output 语义(属性表) | run/step/tool `agent.ts:182`、`loop.ts:365-373,483`、`loop.ts:460`;workflow `walker.ts:217,649,656`;memory `agent.ts:508-512`、`loop.ts:568` | `agent-observability.test.ts:34/73/127`;`workflows-observability.test.ts:29/88/117`;`agent-observability.test.ts:421/501` | 已落 |
| OBS-6 | `agent-run` 先于 recall 创建;input = processInput 后 prompt,以 `span_updated` 落定 | `agent.ts:146-150,182` | `agent-observability.test.ts:44-49` | 已落 |
| OBS-7 | memory 两侧失败落各自 span 的 `error` 并随 run 抛出 | `agent.ts:513-518`;`loop.ts:567-572` | `agent-observability.test.ts:647/676` | 已落 |
| OBS-8 | root span attribute 带 `runId` | `span.ts:26-29,48-53`;`agent.ts:371`;`walker.ts:245` | `agent-observability.test.ts:58-60`;`workflows-observability.test.ts:29` | 已落 |
| OBS-9 | `isEvent`:无生命周期、创建即 `span_ended`、无 duration | `tracer.ts:179-185` | `observability-tracer.test.ts:142/161/174` | 已落 |
| OBS-10 | 活 span API:`end()`/`update(patch)`/`error(err)`;end 幂等、之后调用忽略 | `span.ts:147-158`;`tracer.ts:139-162` | `observability-tracer.test.ts:276-353` | 已落 |
| OBS-11 | ExportedSpan 去方法/去循环引用、加 `parentSpanId` | `tracer.ts:345-362`;`span.ts:132` | `observability-tracer.test.ts:53-56`;`observability-surface.test.ts:35` | 已落 |
| OBS-12 | `error` 在活 span 上是方法、数据字段只在 ExportedSpan | `span.ts:147` | `observability-surface.test.ts:48-50` | 已落 |
| OBS-13 | (实装额外面)`agent-run` 挂起时写 `attributes.status='suspended'` | `loop.ts:423` | 规范映射契约表(`observability.md:158-167`)未列该键;OTLP 经「未映射属性原样发出」透传(`mapping.ts:201-204`),无专门断言 | 已落(规范未列,事实记录) |

#### 1.6.2 事件与导出(observability.md:51-83)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| OBS-14 | 三事件(started/updated/ended)携带 ExportedSpan | `events.ts:7-10` | `observability-tracer.test.ts:28`;`observability-surface.test.ts:149` | 已落 |
| OBS-15 | exporter 最小面(export + 可选 flush?/shutdown?)、裁 `init?()` 与 `name` | `events.ts:19-26` | `observability-surface.test.ts:131`;接口缺席无专门断言 | 已落但未验(结构缺席) |
| OBS-16 | tracer 转发同名 `flush()`/`shutdown()`;flush 同时等待在途异步 export | `tracer.ts:240-270` | `observability-tracer.test.ts:451/480/500` | 已落 |
| OBS-17 | `createTracer` 配置面(exporters/sampler 四档/spanProcessors/hideInput/hideOutput) | `tracer.ts:80-94` | `observability-surface.test.ts:131` | 已落 |
| OBS-18 | 采样:只在 root 判定一次、子 span 继承、不通过返回 NoOpSpan 全树、缺省 always | `tracer.ts:117-120,192-197`;`span.ts:180-193` | `observability-tracer.test.ts:189/199/223/241/247/262` | 已落 |
| OBS-19 | spanProcessors:同步、逐事件、原地改写或返回 `undefined` 丢弃 | `tracer.ts:206-213`;`events.ts:28-34` | `observability-exporters.test.ts:13/30/53/71` | 已落 |
| OBS-20 | hideInput/hideOutput:trace 级、root 决定、子孙继承、擦除在 spanProcessors 之后;组合根分发 `createApp({tracer})`;显式优先;不挂即零开销 | `tracer.ts:206-213,221-233,290-297,325-331`;`app.ts:60-67,121-147` | `observability-exporters.test.ts:100-181`;`agent-observability.test.ts:362/386`;`workflows-observability.test.ts:365`;`app.test.ts:44/76/96/151` | 已落 |

#### 1.6.3 自动埋点:七边界(observability.md:85-97)

| ID | 边界 | 实装挂点 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| OBS-21 | 1. agent run | `agent.ts:146-150`(`toTracing`)、`356-379` | `agent-observability.test.ts:34` | 已落 |
| OBS-22 | 2. agent step(fallback 每尝试各一 span) | `loop.ts:605-620`;尝试环 `loop.ts:271-341` | `agent-observability.test.ts:73`;`agent-fallback.test.ts:297` | 已落 |
| OBS-23 | 3. tool call | `loop.ts:630-645` | `agent-observability.test.ts:127/187` | 已落 |
| OBS-24 | 4. workflow run | `walker.ts:234-251` | `workflows-observability.test.ts:29` | 已落 |
| OBS-25 | 5. workflow step | `walker.ts:677-685`(无 attributes) | `workflows-observability.test.ts:29/88` | 已落 |
| OBS-26 | 6. memory recall(挂 agent-run 下,每 run 一次) | `agent.ts:497-519` | `agent-observability.test.ts:421` | 已落 |
| OBS-27 | 7. memory save(挂 agent-step 下,每 step 一次) | `loop.ts:545-576` | `agent-observability.test.ts:501` | 已落 |
| OBS-28 | 裁 MODEL_CHUNK / MODEL_GENERATION 中间层 | 无对应 span(只有 7 常量 + 用户 span) | 无专门「缺席」断言;类型清单测试覆盖 | 已落(裁单执行) |
| OBS-29 | sub-agent = as-tool,落 `tool-call` span、无专门类型 | `loop.ts:630-645` | `agent-as-tool.test.ts:248` | 已落 |
| OBS-30 | 无 tracer / 采样拒绝:零开销、工具 ctx `traceId/spanId` 空串 | `loop.ts:734-744`;`tracer.ts:117` | `agent-observability.test.ts:707/726/745/761`;`workflows-observability.test.ts:209/296` | 已落 |

#### 1.6.4 上下文传播与身份(observability.md:99-103)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| OBS-31 | 框架内部显式传播 parent,不用 AsyncLocalStorage | `tracer.ts:29-31`;`agent.ts:493`;`walker.ts:674`(全仓 `rg AsyncLocalStorage` 只命中注释) | `observability-tracer.test.ts:357` | 已落 |
| OBS-32 | `startSpan` 两种入参互斥;`parentSpanId` 必须与 `traceId` 同来 | `tracer.ts:304-316`(两条显式抛错) | `observability-tracer.test.ts:432` | 已落 |
| OBS-33 | run 级 option(Agent generate/stream 与 workflow createRun)接受 `{traceId?,parentSpanId?}` | `agent/types.ts:148-154`;`workflows/run.ts:64-68` | `agent-observability.test.ts:257`;`workflows-observability.test.ts:323` | 已落 |
| OBS-34 | 空串语义:traceId 空串整对作废;parentSpanId 空串只丢 parent | `agent.ts:362-367`;`walker.ts:256-271` | `agent-observability.test.ts:295`;`workflows-observability.test.ts:323` | 已落 |
| OBS-35 | 解析 `traceparent` header 是应用层的事 | 无代码(宿主职责) | 无断言 | 已落(按规范归属) |
| OBS-36 | suspend/resume:traceId 进 workflow 快照、resume 续同一 trace;ALS 集成归延后的 OTel bridge | `workflows/snapshot.ts:91`;`walker.ts:263-264`;`workflows/run.ts:185,279`;ALS 无实装 | `workflows-observability.test.ts:236/296`;ALS 无断言 | 已落(ALS 未落,按裁单延后) |

#### 1.6.5 Exporter 清单(observability.md:105-110)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| OBS-37 | 核心自带 `console` exporter | `observability/exporters/console.ts:14-21` | `observability-exporters.test.ts:189/204/216/240` | 已落 |
| OBS-38 | 核心自带 `memory` exporter(环形缓冲;capacity 默认 1000) | `observability/exporters/memory.ts:31-81` | `observability-tracer.test.ts:104/115/128`;`capacity` 非法值的 RangeError 无断言 | 已落 |
| OBS-39 | 不做厂商专用 exporter(Langfuse/LangSmith 等);v1 只 tracing,metrics 不做 | 无 | 无断言(结构缺席) | 已落(裁单执行) |
| OBS-40 | OTel bridge 延后 | 无 | 无断言 | 未落(按裁单延后;重开条件 `ROADMAP.md:116`) |
| OBS-41 | logs 走组合根已有的 logger 通道 | **组合根尚无 logger 槽**:`app.ts:28-29`(「The `logger` slot lands with a later milestone (its spec is not written yet)」);`app.ts:61-70` `AppConfig` 仅 tracer/storage | 无断言 | **未落** |
| OBS-42 | exporter 接口裁 `init?()`/`name`(内嵌裁单) | `events.ts:19-26` | 见 OBS-15 | 已落(裁单执行) |

#### 1.6.6 OTLP 能力包:包面、依赖、桥法(observability.md:112-153)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| OBS-43 | 独立包 `@balsats/otlp`、单一 `createOtlpExporter(options?)` 包面 | `packages/otlp/package.json:2,22-27`(仅 `.` 导出);`src/index.ts:7` | `packages/otlp/test/*`(经 `@balsats/otlp` 导入) | 已落 |
| OBS-44 | options 全形(protocol/url/headers/timeoutMillis/compression/serviceName/resourceAttributes/batch) | `src/exporter.ts:23-44,91-118` | `bridge.test.ts:35,163`;`env.test.ts:128/150/170` | 已落 |
| OBS-45 | `protocol` 缺省 protobuf;本包自有 `OTEL_EXPORTER_OTLP_PROTOCOL` 面(显式 > env) | `exporter.ts:49-66,103-104` | `env.test.ts:33/49/63` | 已落 |
| OBS-46 | 配置优先级 = 显式 > env > 官方默认;官方 env 族透传(endpoint/headers 合并、特化优先、压缩) | `exporter.ts:5-7,93-104` | `env.test.ts:76/87/99/113/128`;certificate/client cert/key、timeout env 无断言 | 已落(部分 env 面无断言) |
| OBS-47 | url 缺省 `http://localhost:4318/v1/traces` | 官方基座默认(本包不设默认值) | 无断言 | 已落但未验 |
| OBS-48 | resource 合并序 `'balsats'` < env < serviceName < resourceAttributes;不发 `telemetry.sdk.*` | `exporter.ts:74-84` | `bridge.test.ts:87/119/144` | 已落 |
| OBS-49 | `instrumentationScope = { name: '@balsats/otlp' }`(不带 version) | `to-readable.ts:16` | `bridge.test.ts:96-97` | 已落 |
| OBS-50 | `flush()` → `forceFlush()`;`shutdown()` → `shutdown()` | `exporter.ts:131-136` | `bridge.test.ts:160`;`env.test.ts:143` | 已落 |
| OBS-51 | 失败面:export 只入队永不抛、队列满静默丢、导出失败静默、诊断走 diag | `exporter.ts:120-130`;`:8-11` | `bridge.test.ts:184`;`env.test.ts:143` | 已落 |
| OBS-52 | 不重复核心面(hideInput/hideOutput、spanProcessors、采样) | `exporter.ts` 无相关 import/逻辑;合成 span 恒 SAMPLED | 无专门断言(结构性) | 已落但未验 |
| OBS-53 | 依赖路线 = 官方 exporter 包 + 官方批处理器,五件精确钉版本、全 `dependencies` | `packages/otlp/package.json:45-51`(`api 1.9.1`、`exporter-trace-otlp-http 0.222.0`、`-proto 0.222.0`、`resources 2.11.0`、`sdk-trace 2.11.0`) | 无断言(清单静态可查) | 已落 |
| OBS-54 | 安装树实测 12 包 / 19,312,287 B(≈18.42 MiB) | 仓内只有按直接依赖分列的 `deps-budget.json`(http 11 包/19,254,726 B、proto 11 包/19,252,639 B、resources 4/14,032,665、sdk-trace 5/14,830,500、api 1/1,001,329) | **未查实**(未运行 `check:deps-budget` 的并集口径) | 未查实 |
| OBS-55 | 不 import `semantic-conventions`、`gen_ai.*` 键名字符串直写 | `mapping.ts:5-7`;全包无该 import/依赖 | 无断言(结构性) | 已落 |
| OBS-56 | 对 `@balsats/core` 走 peer(`workspace:^`)、锁步发布 | `packages/otlp/package.json:39-41`;版本 0.5.0 | 无断言 | 已落 |
| OBS-57 | 只有 `span_ended` 进 OTLP(started/updated 丢弃);每个 ended span 现场构造 `ReadableSpan` 普通对象交 `BatchSpanProcessor.onEnd()` | `exporter.ts:120-129`;`to-readable.ts:25-66`、`exporter.ts:125` | `bridge.test.ts:55`、`:32`(线级到达) | 已落 |
| OBS-58 | 字段换算:`spanContext()` 必须是函数;parent 无 `isRemote`;Date→HrTime;duration/ended 同批;events/links/dropped* 构造;`isEvent` 零时长 span(kind INTERNAL、status UNSET);合成 span 恒 `TraceFlags.SAMPLED` | `to-readable.ts:19-22,27-29,32-66,35,47`;mapping 默认 INTERNAL | `bridge.test.ts:45-49,72,87,103` | 已落 |
| OBS-59 | 批节奏/flush 由官方处理器承担(默认 512 条 / 5 s / 队列 2048 / 超时 30 s;定时器 unref) | `exporter.ts:106-118` 仅透传调参 | 依赖包内部核对:`node_modules/.pnpm/@opentelemetry+sdk-trace@2.11.0_.../build/esm/export/BatchSpanProcessorBase.js:27-30`、`:199`;仓内测试只验 batch 参数透传(`env.test.ts:167`) | 已落但未验(依赖包内部,非仓内断言) |

#### 1.6.7 映射契约:七类 + 兜底(observability.md:154-173)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| OBS-60 | 七类 name 按模板重建、开放 type 原样 | `mapping.ts:93-197` | `mapping.test.ts:19/37/96/133/171/205` | 已落 |
| OBS-61 | 每个映射 span 带 `balsats.span.type` | `mapping.ts:201` | `mapping.test.ts:33` 等 | 已落 |
| OBS-62 | `agent-run` → `invoke_agent {agentName}`、INTERNAL、`gen_ai.agent.name`、`balsats.run_id` | `mapping.ts:94-104` | `mapping.test.ts:19` | 已落 |
| OBS-63 | `agent-step` → `chat {model}`、CLIENT、provider/model/whitelist/usage/finish/ttfc | `mapping.ts:105-145` | `mapping.test.ts:37/69` | 已落 |
| OBS-64 | `tool-call` → `execute_tool {toolName}`、INTERNAL、tool.name/call.id | `mapping.ts:146-163` | `mapping.test.ts:96` | 已落 |
| OBS-65 | `workflow-run` → `invoke_workflow {workflowId}`、workflow.name、runId | `mapping.ts:164-174` | `mapping.test.ts:133` | 已落 |
| OBS-66 | `workflow-step` → `workflow-step {stepId}`、无 operation | `mapping.ts:175-179` | `mapping.test.ts:133/168` | 已落 |
| OBS-67 | `memory-recall`/`memory-save` 不硬蹭 operation、`balsats.thread_id`(+resource_id) | `mapping.ts:180-192` | `mapping.test.ts:171/196` | 已落 |
| OBS-68 | 开放 type:`span.name` 原样、仅 `balsats.span.type` 标记 | `mapping.ts:193-196` | `mapping.test.ts:205` | 已落 |
| OBS-69 | 参数白名单 8 键 → `gen_ai.request.*`;其余 → `balsats.request.<key>`;`gen_ai.request.stream: true` 恒发 | `mapping.ts:31-40,111-123`、`:111-112` | `mapping.test.ts:69`、`:58` | 已落 |
| OBS-70 | ttfc 毫秒→秒;finishReason 单元素数组原样;usage 只发 input/output | `mapping.ts:124-142`;测点毫秒 `loop.ts:250/282/372` | `mapping.test.ts:59-66` | 已落 |
| OBS-71 | status:成功 UNSET、error ERROR + message;`error.type` 取 `details.name` 否则 `_OTHER`;`balsats.error.details` best-effort JSON(空对象省略) | `to-readable.ts:53-56`;`mapping.ts:54-69`;`values.ts:83-87` | `mapping.test.ts:226/130` | 已落 |

#### 1.6.8 载荷映射(observability.md:175-182)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| OBS-72 | 消息语义:system→`gen_ai.system_instructions`,user/assistant/tool→`gen_ai.input.messages`(JSON 字符串) | `messages.ts:90-106` | `mapping.test.ts:350` | 已落 |
| OBS-73 | parts 转换(text/reasoning/tool_call/tool_call_response);未识别 part → 单 text part JSON 兜底;tool-result 联合降文本 | `messages.ts:44-76` | `mapping.test.ts:350/384` | 已落 |
| OBS-74 | `agent-step` output → `gen_ai.output.messages`;空串不发;structured 对象 → text part JSON | `messages.ts:112-117`;`mapping.ts:234-235` | `mapping.test.ts:405` | 已落 |
| OBS-75 | `tool-call` input→arguments、output→result(JSON 字符串;result 仅成功发) | `mapping.ts:151-161` | `mapping.test.ts:96/129` | 已落 |
| OBS-76 | 非消息语义兜底 → `balsats.input`/`balsats.output`;不截断(整形缝在上游) | `mapping.ts:238-244`;包内无截断代码 | `mapping.test.ts:133/171/205/428`;不截断无断言(结构缺席) | 已落 |

#### 1.6.9 值域与兜底规则(observability.md:184-188)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| OBS-77 | 原语/原语数组直通(剔 null/undefined,剔空即丢);对象及其他 JSON 字符串;序列化失败丢并计 `droppedAttributesCount` | `values.ts:33-61` | `mapping.test.ts:281/308/318` | 已落 |
| OBS-78 | `attributes` 袋通用规则(白名单键不重复) | `mapping.ts:199-204` | `mapping.test.ts:281` | 已落 |
| OBS-79 | `metadata` 开放袋 → 单属性 `balsats.metadata` JSON 字符串(空/失败省略、不摊平) | `mapping.ts:71-77` | `mapping.test.ts:270` | 已落 |
| OBS-80 | 框架侧 `undefined` 一律省略属性,不发空串哨兵 | `values.ts:38` | `mapping.test.ts:304` | 已落 |

#### 1.6.10 observability 砍单复核(observability.md:190-198 + 内嵌)

| ID | 砍单项 | 现状 | 证据 |
| --- | --- | --- | --- |
| CUT-OBS1 | gRPC transport / 厂商专用 exporter | **仍是砍单** | deps 仅 http+proto 两个 exporter 包(`packages/otlp/package.json:45-51`);无厂商包 |
| CUT-OBS2 | OTel bridge / metrics / logs | **仍是砍单**(logs 另见 OBS-41 组合根 logger 未落) | 无 bridge/metrics 代码;bridge 重开条件 `ROADMAP.md:116` |
| CUT-OBS3 | 自研批处理 / 重试 / 日志 / 错误回调 | **仍是砍单** | 批处理直接用官方 `BatchSpanProcessor`(`exporter.ts:18,106`);无重试/onError |
| CUT-OBS4 | 内建截断 / 敏感数据规则库 | **仍是砍单** | 无截断、无 PII 规则代码 |
| CUT-OBS5 | `gen_ai.conversation.id` 补全 | **仍是砍单** | `mapping.ts` 无该键;memory span 只发 `balsats.thread_id`(`mapping.ts:182,188`) |
| CUT-OBS6 | exporter `init?()`/`name` 字段 | **仍是砍单** | `events.ts:19-26` |
| CUT-OBS7 | `MODEL_CHUNK`/`MODEL_GENERATION` span | **仍是砍单** | 无对应 span;见 OBS-28 |

#### 1.6.11 observability「关键差异」「无断言面」

- **关键差异**:OBS-13(`status:'suspended'` 属性规范未列);OBS-41(logs 通道承诺 vs 无 logger 槽,**未落**);OBS-54(OTLP 安装树并集口径未查实)。
- **无断言面**:OBS-15(exporter 无 name/init)、OBS-28(MODEL_CHUNK/GEN 缺席)、OBS-35(traceparent 归应用层)、OBS-38 的 capacity RangeError、OBS-46 的 certificate/client-cert/key/timeout env、OBS-47(url 缺省)、OBS-52(OTLP 不重复核心整形面)、OBS-54、OBS-59(批处理器内部参数,仓内无断言)、OBS-76 的「不截断」;另 **采样拒绝时快照不写 traceId 已验**(`workflows-observability.test.ts:296`),其反向「有 trace 时快照必写」在 `:237-295` 已覆盖。

### 1.7 storage 子系统(`docs/architecture/storage.md`,178 行;含 `@balsats/sqlite`)

#### 1.7.1 定位(storage.md:6-8)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| ST-1 | 存储层 = port 集合 + adapter 家族,**不是子系统** | 无 storage 子系统目录;四个 port 分居各子系统目录;唯一汇合点 = 组合根四槽 `packages/core/src/app.ts:44-58` | `packages/core/test/app.test.ts:156`(「AppConfig.storage 四槽各可选,形状即四个 port」)、`app.test.ts:249-360`(槽分发间接) | 已落(无专门断言) |
| ST-2 | 无 mastra 式分域 composite / 域路由 | `app.ts:42`(「each slot is independent — no composite store, no domain routing」);`rg composite packages/core/src` 仅此一处 | 无断言 | 已落但未验 |
| ST-3 | 观测无 storage port(tracing 走 exporter,span 不落库) | `packages/core/src/observability/` 无 store 类型;后端 = `packages/otlp` exporter 包 | 无断言 | 已落但未验 |

#### 1.7.2 Port 清单(storage.md:10-17)

| ID | Port(规范形状) | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| ST-4 | `MemoryStore` 6 必备 + 2 条件 | `packages/core/src/memory/store.ts:17-34`、`WorkingMemoryStore:37-40` | core `memory-store.test.ts`(15 例)、`memory-surface.test.ts:73/101`;`sqlite/test/memory.test.ts`(13 例) | 已落 |
| ST-5 | `WorkflowSnapshotStore` 2 方法 + JSON-only | `packages/core/src/workflows/snapshot.ts:100-105` | core `workflows-suspend-resume.test.ts`(37 例,含 161/241/269/634/679/1397/1407) | 已落 |
| ST-6 | `AgentRunSnapshotStore` load/save + JSON-only | `packages/core/src/durable-agent/snapshot.ts:78-83` | core `durable-agent.test.ts:96`;`sqlite/test/agent-snapshots.test.ts`(3 例) | 已落 |
| ST-7 | `ScheduleStore` 5 方法 | `packages/core/src/schedules/store.ts:15-26` | core `schedules.test.ts`(21 例,含 47/88/123);`sqlite/test/schedules.test.ts`(7 例) | 已落 |
| ST-8 | 各 port 独立定义、独立演化;一个 adapter 可只实现任意子集 | 四接口无共同基接口,无注册表;`@balsats/sqlite` 实现全部四个 | 无「部分子集 adapter」实例;无断言 | 已落(无断言) |
| ST-9 | port 类型由核心定义,adapter 包对核心仅 **types 级依赖** | `packages/sqlite/src/` 对核心 4 处全部 `import type`(`snapshots.ts:18`、`index.ts:20-21`、`schedules.ts:11`);`packages/croner/src/` 对核心零导入 | 无断言(`check:runtime-deps` 已全绿) | 已落(无断言) |

#### 1.7.3 扩展面:可选方法 + 能力标志(storage.md:19-31)

| ID | 事实 | 实装 | 测试 |
| --- | --- | --- | --- |
| ST-10 | `compareAndSave(runId, snapshot, expected)` 落 SQLite | `packages/sqlite/src/snapshots.ts:115-133`(条件单语句 + `changes()`) | `sqlite/test/workflow-snapshots.test.ts:63/72/89`;`cross-connection.test.ts:48` |
| ST-11 | `deleteSnapshot(runId)`(workflow) | `snapshots.ts:135-138` | `workflow-snapshots.test.ts:53` |
| ST-12 | `listSnapshots(q?)` | `snapshots.ts:140-160` | `workflow-snapshots.test.ts:131/146` |
| ST-13 | `deleteSnapshot(runId)`(agent) | `snapshots.ts:200-203` | `sqlite/test/agent-snapshots.test.ts:53` |
| ST-14 | `listSuspended(q?)` | `snapshots.ts:205-221` | `agent-snapshots.test.ts:61` |
| ST-15 | 「基础 port 一个字不动」;扩展接口由包自导出 | `snapshot.ts:100-105`、`durable-agent/snapshot.ts:78-83` 只有 load/save;`packages/sqlite/src/index.ts:28-31` 自导出 | — |
| ST-16 | 「存在性即能力声明,核心调用前检测,缺席降级或显式报错」 | 核心内**唯一**检测约定 = `supportsWorkingMemory`(`packages/core/src/memory/store.ts:47-49`;半实现视为缺席);缺席显式报错 = `memory.ts:307-313` | `core/test/memory-surface.test.ts:101-125`;`sqlite/test/memory.test.ts:273-274` |
| ST-17 | 事实:`compareAndSave`/`deleteSnapshot`/`listSnapshots`/`listSuspended` 四方法名在 `packages/core/src/` **零引用**(`rg` 命中仅 `durable-agent/snapshot.ts:75` 文档注释);核心无这四项的检测/降级代码 | — | — |
| ST-18 | 签名冻结核对 | `sqlite/src/snapshots.ts:27-50` 与 storage.md:139-148 逐字一致;`listSnapshots` 带 `status?`、`listSuspended` 不带 | 内存默认不实现扩展:`workflows/in-memory-snapshot-store.ts:16-28`、`durable-agent/in-memory-snapshot-store.ts:16-28` 仅 load/save;「缺席」无直接断言 |

#### 1.7.4 连接生命周期(storage.md:33-35)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| ST-19 | adapter 自拥生命周期,可选 `init?()`/`close?()` | `packages/sqlite/src/index.ts:52-55`;`connection.ts:64-98` | `sqlite/test/lifecycle.test.ts:88/101`(幂等) | 已落 |
| ST-20 | **核心永不隐式调用、不 hook 进程退出** | `rg "\.init\(\)\|\.close\(\)" packages/core/src/` 零命中;核心无 `process.on('exit')` | 无断言(静态事实) | 已落但未验 |
| ST-21 | 应用或组合根负责打开/关闭 | 组合根只分发槽(`app.ts` 无 init/close);example 自调(`examples/sqlite-resume/src/index.ts:111/260`) | `app.test.ts:249+`(不覆盖生命周期托管) | 已落(「组合根可代管」可选面未实现,见 ST-64) |
| ST-22 | 内存实现无生命周期 | 四个 `createInMemory*` 无 init/close | 无需断言 | 已落 |

#### 1.7.5 第一方 adapter 清单与作者指南(storage.md:37-47)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| ST-23 | 内存实现:四个 port 各一 | `memory/index.ts:13`、`workflows/index.ts:67`、`durable-agent/index.ts:21`、`schedules/index.ts:19` | 分别由 memory-store / workflows-suspend-resume / durable-agent / schedules 测试覆盖 | 已落 |
| ST-24 | `@balsats/sqlite` = 唯一第一方 durable adapter,驱动 `node:sqlite`,engines `>=22.13.0` | `packages/sqlite/package.json`;`connection.ts:16`(`import { DatabaseSync } from 'node:sqlite'`);root engines 同;`.github/workflows/ci.yml:33` `node-version: 22.13.0` | 全部 sqlite 用例跑在该驱动上 | 已落 |
| ST-25 | 其余后端(PG/Redis/Upstash/Mongo)不做第一方 | `packages/` 下无对应包(七包清单) | 无断言 | 已落但未验 |
| ST-26 | 作者指南 1:可实现任意子集、可选方法存在性即声明、无需注册 | 无注册表;sqlite 一次性实现全部 | 无「子集」实例可验 | 已落(无断言) |
| ST-27 | 作者指南 2:port 类型 types-only 引入 | 同 ST-9 | 无断言 | 已落 |
| ST-28 | 作者指南 3:semver 承诺同样适用于第三方 adapter | 见 ST-58 | — | 已落(承诺面) |

#### 1.7.6 SQLite 参考 adapter(storage.md:49-152)

**工厂面(storage.md:61-74)**

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| ST-29 | `createSqliteStorage({ path, busyTimeoutMs })` | `sqlite/src/index.ts:71-81`;选项类型 `:34-39` | `lifecycle.test.ts` 全篇 | 已落 |
| ST-30 | 四个面 `memory`/`workflowSnapshots`/`agentRunSnapshots`/`schedules` | `index.ts:47-51`、`:82-89` | `lifecycle.test.ts:52-75` 逐方法矩阵 | 已落 |
| ST-31 | `await storage.init()` 幂等;`close()` 幂等;close 后 port 抛错 | 实装为**同步 `void`**(`index.ts:53`、`connection.ts:76-88/90-97`),注释自认「`await storage.init()` from older docs still resolves immediately」;规范代码块写 `await`(`storage.md:68`)——`await` 作用于 void 合法,形态不同 | `lifecycle.test.ts:88/101/113`;`schema.test.ts:114` | 已落(形态差异见 §4.3 DOC-7) |
| ST-32 | `path` 原样交 `DatabaseSync`;每实例一连接、不做池 | `connection.ts:79`(`new DatabaseSync(path, { timeout: busyTimeoutMs })`) | `cross-connection.test.ts:22` | 已落 |
| ST-33 | 不暴露原始 `DatabaseSync`;裸 SQL 逃生口 = 宿主按同 path 自开连接 | `SqliteStorage`(`index.ts:47-56`)无 db 字段/方法;测试用 `sqlite/test/helpers.ts:62` 的 `rawConnection` | 无「不暴露」断言(类型面即证) | 已落 |
| ST-34 | 导出类型 = 选项类型 + 返回类型(扩展接口具名) | `index.ts:28-31` 导出 `SqliteAgentRunSnapshotStore`/`SqliteWorkflowSnapshotStore`;选项/返回类型具名 | `check:export-surface` 已全绿 | 已落 |
| ST-35 | 未 `init()` 调 port → 抛「call init() first」,不做隐式 DDL | `connection.ts:70-72` | `lifecycle.test.ts:79-86`(22 个 port 方法逐一) | 已落 |

**生命周期与并发口径(storage.md:76-80)**

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| ST-36 | init 顺序:打开 → WAL / synchronous=NORMAL / foreign_keys=ON / busy timeout → 迁移 → `user_version` | `connection.ts:76-88`、`:101-115`、`:118-134` | `lifecycle.test.ts:120-131` | 已落 |
| ST-37 | 默认 5 000 ms,`busyTimeoutMs` 覆盖 | `connection.ts:20`、`:75`、`:105` | `cross-connection.test.ts:70`(`busyTimeoutMs:200` 实测等待 ≥100 ms) | 已落 |
| ST-38 | 文件库读回 `journal_mode` 非 `wal` 抛错;`:memory:` 放过 | `connection.ts:107-114` | `lifecycle.test.ts:120/127` | 已落 |
| ST-39 | 同步 API 即原子面;多语句单元走 `BEGIN IMMEDIATE`…`COMMIT`;单语句含 CAS 不额外包事务 | `connection.ts:47-62`;多语句单元 = `saveMessages`(`sqlite/src/memory.ts:205-225`)与迁移(`connection.ts:128-134`);CAS 单语句 `snapshots.ts:115-133` | `memory.test.ts:246`;`workflow-snapshots.test.ts:63+` | 已落 |
| ST-40 | 跨进程:同文件 + WAL + busy timeout;CAS 前提;不做 lease/认领/重试;`SQLITE_BUSY` 原样抛;`:memory:` 每连接独立 | `sqlite/src/index.ts:16-18` 文档;无 lease 代码 | `cross-connection.test.ts:22/48/70`;`:memory:` 独立性无专门断言 | 已落(部分) |

**迁移纪律(storage.md:82-85)**

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| ST-41 | forward-only、additive-only;包内有序数组 `{version, up(db)}`;不建迁移表;`PRAGMA user_version` 即版本 | `sqlite/src/schema.ts:1-8/23-59`(MIGRATIONS 仅 v1;LATEST_VERSION `:59`);无迁移表 | `schema.test.ts:39/58/84` | 已落 |
| ST-42 | 迁移在事务内整体应用 | `connection.ts:128-134` | `schema.test.ts:114`(失败 init 不留半开状态) | 已落 |
| ST-43 | 库 `user_version` 高于本包已知版本 → 抛错(不支持降级) | `connection.ts:120-126` | `schema.test.ts:104-112` | 已落 |
| ST-44 | 扩容只增表/列/索引,不改既有形状 | 无 v2 迁移可验;无 CI 闸门专门核对 additive-only | 无断言 | 未落(无可验对象) |

**表结构 v1 六表(storage.md:87-124)**

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| ST-45 | 六张 STRICT 表、三索引、无触发器/视图/AUTOINCREMENT | `schema.ts:23-56`;`rg AUTOINCREMENT\|TRIGGER\|VIEW` 仅注释 | `schema.test.ts:39-56`、`:58-82`(含 FK `ON DELETE CASCADE`) | 已落 |
| ST-46 | 编码:`Date`→INTEGER Unix ms;可选字段缺席 = NULL、读回字段省略;JSON 文本列;NULL 与 `'null'` 严格区分 | `sqlite/src/memory.ts:56-91`、`:94-99`;`connection.ts:32-45`(`encodeJson`:undefined→NULL) | `memory.test.ts:67/87/181/277`;`schedules.test.ts:67` | 已落 |
| ST-47 | 六表列名逐字 | `schema.ts:27-53` | `schema.test.ts:20-27`(`EXPECTED_COLUMNS`) | 已落 |
| ST-48 | 语义分歧:内存参照接受「给不存在 thread 存消息」,FK 级联版抛约束错误 | `sqlite/src/memory.ts:135-139`(靠 FK 级联) | `memory.test.ts:264-270` | 已落 |
| ST-49 | 快照两表不投影 `status` 列;`listSnapshots({status})` 用 `json_extract` | `schema.ts:21`;`snapshots.ts:144-147` | `workflow-snapshots.test.ts:131-144` | 已落 |

**查询 SQL 形状(总序与游标)(storage.md:126-133)**

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| ST-50 | `listThreads`/`listMessages`:游标行须存在且归属相符,否则抛错;行值比较;`ORDER BY … DESC LIMIT ?`;`listMessages.limit` 永远锚最新端,`asc` 只在 JS `reverse()` | `sqlite/src/memory.ts:141-170`、`:172-203`(`:202` reverse) | `memory.test.ts:117/132/201/222`;对照 `core/test/memory-store.test.ts:65/99/168/188/209` | 已落 |
| ST-51 | `schedules.list` 总序 `nextFireAt ASC`、NULL 最后、`id ASC`;游标哨兵;`listDue` SQL | `sqlite/src/schedules.ts:87-98`(哨兵 `:26`)、`:111-120` | `schedules.test.ts:88/101/136` | 已落 |
| ST-52 | 快照两表 list:`ORDER BY updated_at DESC, run_id DESC`;游标 = run id | `snapshots.ts:63-66`、`:148-158`、`:210-219` | `workflow-snapshots.test.ts:131/146`;`agent-snapshots.test.ts:61` | 已落 |
| ST-53 | `limit` 非正整数、游标悬空一律抛错——port 层判据 | `sqlite/src/memory.ts:102-106`、`snapshots.ts:68-72`、`schedules.ts:41-45`;内存侧同 | `memory.test.ts:123/222`;`workflow-snapshots.test.ts:146`;`agent-snapshots.test.ts:91/94`;`schedules.test.ts:123` | 已落 |

**扩展实现(storage.md:135-151)**

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| ST-54 | 四个 port 的全部已声明扩展都实现;core 类型零改动;扩展接口由包自导出 | `sqlite/src/snapshots.ts:27-50` + `:115-221`;`index.ts:28-31` | `lifecycle.test.ts:63-69` | 已落 |
| ST-55 | CAS:`expected === null` → `INSERT … ON CONFLICT DO NOTHING`;否则 `UPDATE … WHERE run_id = ? AND payload = ?`;`changes() === 1`;比较串 = `JSON.stringify` | `snapshots.ts:115-133` | `workflow-snapshots.test.ts:63-87`;`cross-connection.test.ts:48-68` | 已落 |
| ST-56 | `expected` 必须取自本 adapter 的 `load`(键序不同判 false)——写进包文档;不引版本计数/哈希列 | `packages/sqlite/README.md:74-88`;schema 三列无计数/哈希 | `workflow-snapshots.test.ts:89-111` | 已落 |
| ST-57 | `compareAndSave` 失败 = false 且不写;`deleteSnapshot` 单条 DELETE、缺席 no-op | `snapshots.ts:125/132/137/202` | `workflow-snapshots.test.ts:53/63`;`agent-snapshots.test.ts:53`;`cross-connection.test.ts:66` | 已落 |

#### 1.7.7 semver 承诺(storage.md:153-155)

| ID | 承诺 | 实装 | 状态 |
| --- | --- | --- | --- |
| ST-58 | port 是面向生态作者的契约;1.0 起 stable;演化纪律 additive-only;0.x 阶段 minor 可破、changelog 明示 | 七包 version 全 `0.5.0`;无 `CHANGELOG.md`(changelog = GitHub Release notes,`ROADMAP.md:90`);1.0 门槛先搁置(`ROADMAP.md:94`) | 已落(承诺面);1.0 未发生,0.x 无强制约束可验;无测试断言 |

#### 1.7.8 与其它子系统关系 / 依赖预算(storage.md:168-178)

| ID | 承诺 | 实装 | 状态 |
| --- | --- | --- | --- |
| ST-59 | Workflows 钉 `WorkflowSnapshotStore`,CAS/保留期扩展承载其缝 | `workflows/snapshot.ts:100-105`;`workflows/run.ts:167-172`、`:242` | 已落 |
| ST-60 | Memory 钉 `MemoryStore`(6+2),条件 2 = 能力标志首个实例 | 见 ST-4/ST-16 | 已落 |
| ST-61 | Observability 无 storage port | 见 ST-3 | 已落但未验 |
| ST-62 | Harness 两个新 port 进统一 adapter 家族 | 见 ST-6/ST-7;sqlite 一并实现 | 已落 |
| ST-63 | 组合根可选;持有 adapter 时可代管 init/close(可选) | 组合根有四个槽(`app.ts:44-58`),**无代管 init/close** 的代码 | 部分落(槽已落;代管未落,规范措辞为「可」) |
| ST-64 | 核心运行时依赖硬线 = 0 | `packages/core/package.json` 无 deps/peer;`check:runtime-deps` 全绿 | 已落 |

#### 1.7.9 storage 砍单表复核(storage.md:157-166)

| ID | 砍单项 | 承载缝 | 现状 | 证据 |
| --- | --- | --- | --- | --- |
| CUT-ST1 | 分域 composite / 域路由 | 子系统各自收 store 实例 | **仍是砍单**;承载缝已落 | 无 composite 代码(`app.ts:42` 注释即否认);四子系统 config 各收 store |
| CUT-ST2 | 观测存储域(span 落库) | exporter 流式模型(ADR-0009) | **仍是砍单**;承载缝已落 | `observability/` 无 store;`packages/otlp` 是 exporter 包 |
| CUT-ST3 | harness 专属存储域(lease / notifications / thread-state) | 不建——#18 已裁决:两个新最小 port | **仍是砍单**;承载缝已落 | `durable-agent/snapshot.ts:78-83`、`schedules/store.ts:15-26`;无 lease/notification/thread-state 类型 |
| CUT-ST4 | PG / Redis 等第一方 adapter | 社区;作者指南 | **仍是砍单** | `packages/` 无对应包 |
| CUT-ST5 | CAS 进基础 port | 可选扩展;内存版不必假装支持 | **仍是砍单**;承载缝已落 | 基础 port 只有 load/save;CAS 仅在 `sqlite/src/snapshots.ts:115-133`;内存默认无 |
| CUT-ST6 | 核心托管连接生命周期(进程 hook / settled 式) | adapter 自拥 `init?()`/`close?()` | **仍是砍单**;承载缝已落 | 核心零 init/close 调用;sqlite 自拥;组合根**未实现**代管(`app.ts` 无 init/close) |

#### 1.7.10 storage「关键差异」「无断言面」

- **关键差异**:ST-31(规范代码块 `await storage.init()` vs 实装同步 `void`,形态不同);ST-63(组合根代管 init/close 未落);ST-17(四个扩展方法名核心零引用——能力标志模式在核心只有 `supportsWorkingMemory` 一个实例)。
- **无断言面**:ST-2、ST-3、ST-8、ST-9、ST-20(核心永不隐式 init/close)、ST-25(其余后端不做第一方)、ST-26(子集 adapter)、ST-40 的 `:memory:` 独立性、ST-33/ST-34(类型面即证)、ST-44(无可验对象)、ST-58(semver 承诺)。

### 1.8 harness 子系统(`docs/architecture/harness.md`,137 行;含 `@balsats/croner`)

#### 1.8.1 定位与运行时立场(harness.md:6-10)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| H-1 | Harness = 文档分类,无 Harness 类/实例 | `rg "class Harness\|createHarness" packages/core/src` 零命中 | 无断言 | 已落但未验 |
| H-2 | 三件套独立工厂、独立可用 | `createDurableAgent`/`createSignals`/`createSchedules` 三个子路径 | `core/test/entry-points.test.ts` | 已落 |
| H-3 | 核心永不要求长驻进程;进程内便利件显式标注单进程 | `schedules.ts:14-18`、`:80-82`;`signals.ts:30-33` | `schedules.test.ts:363-433`;「单进程」语义本身不可断言 | 已落 |
| H-4 | serverless/edge 路径一等形态 | `examples/cron-schedule/README.md:50-52`;`examples/signals-desk/README.md:87-90` | 示例非测试 | 已落但未验 |
| H-5 | 跨实例能力整体归能力包,不进核心 | `rg` 无共享 PubSub / 租约实现 | 无断言 | 已落但未验 |

#### 1.8.2 Durable agents(harness.md:12-24)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| H-6 | `createDurableAgent({agent, storage?, approval?})`;`stream` 与 `agent.stream` 同形;`finishReason==='suspended'` 时 `suspendPayload` 可用;`resume(runId,{approved:true})` | `durable-agent.ts:141-143`、`:65-73`、`:96-116`、`:305-310` | `durable-agent.test.ts:57-100` | 已落 |
| H-7 | 审批闸:模型返回 tool-calls 后、执行前;命中 `approval.tools` → 挂起;loop 快照写 port;`finishReason:'suspended'` | `durable-agent.ts:159-190`(闸,`:168-180` 捕获快照面)、`:225-228`(落盘)、`:330-339` | `durable-agent.test.ts:57-100`(`:69` suspended、`:71` 工具未执行、`:96` 快照逐字、`:98` JSON 往返) | 已落 |
| H-8 | 审批声明在 durable 层;Tool 四字段定义不动 | `tools/tool.ts:48-57` 无 approval 字段;`durable-agent.ts:43-46` | `durable-agent.test.ts:158-185` | 已落 |
| H-9 | resume:`approved:true` → 执行该工具继续;`approved:false` → 「用户拒绝」工具结果回喂模型继续,不终止 run | `durable-agent.ts:277-281`、`:282-294`、`:342-350`(`toRejection` 的 `isError:true`) | `durable-agent.test.ts:188-243`、`:244-270`、`:272-310` | 已落 |
| H-10 | resume 携带审批结论(必填 + 显式校验) | `durable-agent.ts:244-250`(非 boolean 抛错);`:90-93` | `durable-agent.test.ts:249`、`:455-462` | 已落 |
| H-11 | 挂起语义只在 durable 包装内;裸 agent 无快照、不产生 `'suspended'` | `durable-agent.ts:30-36` 文档;`agent/loop.ts` 无快照;`model/chunks.ts:14-18`(`'suspended'` 仅由 step boundary 产生) | 无「裸 agent 不产生 suspended」的直接用例;反向用例 `durable-agent.test.ts:158`;**而 `agent-step-boundary.test.ts:163` 显示裸 Agent 传 `stepBoundary` 即可得 `'suspended'`** | 部分落(与 AG-15 同源) |
| H-12 | 并发 resume 进程内去重 | `durable-agent.ts:151`、`:251-258` | `durable-agent.test.ts:464-474` | 已落 |
| H-13 | 裁单:崩溃自动恢复 / resumable stream 缓存 / `observe()` / 多副本+leader election / boot `recoverAll` / 工具内 `suspend()` | `rg recoverAll\|leader election` 在 `src/` 零命中;wrapper 无这些方法 | 无断言(不存在即证) | **仍是砍单** |
| H-14 | 「列出待审批 run」归 adapter 可选扩展 | sqlite `listSuspended`(`snapshots.ts:205-221`);核心内存默认无 | `agent-snapshots.test.ts:61-95` | 已落 |

#### 1.8.3 AgentRunSnapshotStore(harness.md:26-36)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| H-15 | `load`/`save` 两方法;`AgentRunSnapshot={runId,status:'suspended',messages,stepCount,suspendPayload,traceId?}` JSON-only | `durable-agent/snapshot.ts:51-83` | `durable-agent.test.ts:79-98`(逐字对齐 + JSON 往返)、`:510-512` | 已落 |
| H-16 | 内存默认实现进核心 | `durable-agent/in-memory-snapshot-store.ts:16`;`index.ts:21` 导出 | 包装用例默认走它;**无**专门深拷贝/隔离断言(对照 workflows 侧 `workflows-suspend-resume.test.ts:1397` 有) | 已落(内存默认无专门断言) |
| H-17 | 与 WorkflowSnapshotStore 同构、统一 adapter 家族 | 两接口方法集相同(`load`/`save`);sqlite 两实现同文件 | 同上 | 已落 |
| H-18 | 可选扩展 `deleteSnapshot`/`listSuspended`,缺席即无枚举能力 | 内存默认缺席;sqlite 实现(`snapshots.ts:44-50`) | `agent-snapshots.test.ts:53/61`;「缺席即无枚举」无断言 | 已落 |
| H-19 | 无 CAS——durable 不做多副本恢复,跨进程安全归部署方 | 接口无 CAS;`agent_run_snapshots` 表无 CAS 实现(`snapshots.ts:164-222`) | 无断言(不存在即证) | 已落 |

#### 1.8.4 Signals(harness.md:38-52)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| H-20 | `sendMessage`/`queueMessage`/`sendSignal`/`subscribeToThread` 四方法 | `signals.ts:101-121`、`:436-439` | `signals.test.ts` 15 例逐条覆盖 | 已落 |
| H-21 | 语义固定三句:活跃 = 注入当前 run(下一 step 生效);空闲 = 唤醒新 run;`queueMessage` = 排队保序 | `signals.ts:340-351`、`:357-366`、`:374-379`;注入在 loop step 边界 `:205-224` | `signals.test.ts:43-77`、`:81-139`、`:446-467` | 已落 |
| H-22 | 零新存储:注入/唤醒内容落消息历史普通消息(复用 `MemoryStore`) | `signals.ts:346`;`SignalsConfig` 无 storage 字段(`:37-57`) | `signals.test.ts:73-76` | 已落 |
| H-23 | 排队队列进程内,进程死 = 丢(文档化) | `signals.ts:106-107,139` | 无断言(不可观测);`examples/signals-desk/README.md:87` | 已落但未验 |
| H-24 | `memory` 缺席时唤醒 = 无历史新 run(文档化) | `signals.ts:314-321`、`:44-48` | `signals.test.ts:302-336` | 已落 |
| H-25 | 运行时 = 进程内 pubsub + 「thread → 活跃 run」注册表,单进程 | `signals.ts:164`(`threads` Map)、`:382-416` | `signals.test.ts:193/212` | 已落 |
| H-26 | agent loop 唯一改动 = 每个 step 边界检查注入队列;无挂接时零开销 | `agent/loop.ts:56-60`、`:238-248` | `agent-step-boundary.test.ts:37+`;「缺席零开销」无直接断言(注释陈述 `loop.ts:58`) | 已落(零开销无断言) |
| H-27 | 裁单:state signals / notification inbox / signal providers | `rg` 无实现;承载缝 `sendSignal` 开放 `type` 已落(`signals.ts:481-485`) | `signals.test.ts:141/163` | 仍是砍单(承载缝已落) |
| H-28 | 事实:`SignalsConfig` 比规范签名多一个可选 `tracer?`;`Signals` 面除四方法外含 `stream`/`generate` | `signals.ts:50-56`、`:71-93` | `signals.test.ts:244-298`、`:59/263` | 已落(签名较规范多一可选字段,面大于规范块) |

#### 1.8.5 Schedules 与 ScheduleStore(harness.md:54-83)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| H-29 | `createSchedules({storage?, agents, signals?})`;`save({id?,next,target,timezone?,enabled?,metadata?})`;`tick({now?})`;`startTicker({intervalMs})` | `schedules.ts:22-36/89-91/182-205`;类型 `types.ts:76-89` | `schedules.test.ts:46-440` | 已落 |
| H-30 | target 两形态:threadless = `agent.generate(input)`;threaded = `sendSignal`(要求 thread + resource) | `types.ts:17-43`;执行 `schedules.ts:119-134`;校验 `:96-116` | `schedules.test.ts:223-252`、`:268-296`、`:187-221` | 已落 |
| H-31 | 平台 cron 一等形态;**不做** mastra 式轮询调度器 + 存储 CAS 认领 | `tick` 即全部运行时(`schedules.ts:136-151`);`ScheduleStore` 无 CAS(`store.ts:11-13` 明示) | `croner/test/wiring.test.ts:76-119` | 已落 |
| H-32 | cron 字符串解析不进核心(零依赖红线);`next` 注入 | `SchedulesConfig` 无 croner 引用;core 零 dependencies | `croner/test/wiring.test.ts` | 已落 |
| H-33 | 裁单:触发记录(trigger history / runId 关联)→ observability span | `ScheduleRecord` 无 runId/history 字段(`types.ts:49-69`);SQLite 六表无触发记录表;`schedules.ts` 无 tracer 引用 | 无断言;示例 README 陈述 | 仍是砍单(承载缝 = 触发 run 自身 span;无 tick 无 span 的断言) |
| H-34 | `ScheduleStore` 5 方法(save upsert / get / list / delete / listDue) | `schedules/store.ts:15-26` | core `schedules.test.ts:47-140`;sqlite `schedules.test.ts:38-150` | 已落 |
| H-35 | 内存默认实现进核心;统一 adapter 家族;additive-only | `schedules/in-memory-store.ts:37`;`index.ts:19` 导出 | 同上 | 已落 |
| H-36 | 事实:`save` 对 `next` 返回 Invalid Date 显式报错(规范未写) | `schedules.ts:186-190` | 无断言(可见于代码) | 已落(超出规范块) |

#### 1.8.6 croner 封装能力包(harness.md:85-103)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| H-37 | 单工厂 `cron(expression, options?) → {next, timezone?}`;无 facade、不 re-export croner | `packages/croner/src/index.ts:52-67`;导出仅 `cron`/`CronFragment`/`CronOptions` | `croner/test/cron.test.ts:12-20` | 已落 |
| H-38 | `options` 仅 `{timezone?}`,子集封闭 | `index.ts:35-38`、`:53-57` | `cron.test.ts:123-128`(`@ts-expect-error` startAt) | 已落 |
| H-39 | 构建即全部校验;错误原样透出(TypeError/RangeError);非法时区构建期探针 | `index.ts:58`、`:63` | `cron.test.ts:47-57`、`:59-63` | 已落 |
| H-40 | 表达式语句全量(5/6/7 段、6 段秒在前、`@daily` 昵称) | 由 croner 透传 | `cron.test.ts:67-94` | 已落 |
| H-41 | 表达式不落记录;`ScheduleRecord` 只带 `timezone?`;重启重锚 = 宿主逐个 `save()` | `types.ts:49-69`;SQLite 表无表达式列;`save` 以 now 重锚(`schedules.ts:185`) | `croner/test/wiring.test.ts:100-106` | 已落 |
| H-42 | DST 原样透传,实测行为入文 | `index.ts` 无补偿 | `cron.test.ts:102-119`(Stockholm 2026 缺口/重叠日) | 已落 |
| H-43 | 依赖预算:croner 精确钉 `10.0.1`、1 包 / 154,686 B | `packages/croner/package.json` `"croner":"10.0.1"`;`deps-budget.json` | `check:deps-budget` 全绿 | 已落 |
| H-44 | 对 core 无 peer;core 仅 devDep;engines `>=22.13.0`;锁步 `0.5.0` | `croner/package.json` | `wiring.test.ts` 以 devDep 公开面接线 | 已落 |

#### 1.8.7 Observability 锚点(harness.md:105-109)

| ID | 承诺 | 实装 | 测试 | 状态 |
| --- | --- | --- | --- | --- |
| H-45 | 挂起 = `agent-run` span 以 attributes `status:'suspended'` 正常 end | `agent/loop.ts:419-424` | `durable-agent.test.ts:499-508` | 已落 |
| H-46 | traceId 随快照持久化;resume = 同一 traceId 下新 `agent-run` span | `durable-agent.ts:288`;`snapshot.ts:62-67` | `durable-agent.test.ts:509-520` | 已落 |
| H-47 | signals 注入 = 当前 `agent-run` span 上的 `isEvent` 事件;唤醒 run 自身一个 `agent-run` span;不新增 span 类型常量 | `signals.ts:267-279`(open literal `'signal'`,注释「deliberately not one of the framework's seven constants」);`span.ts:19`(`SpanType=string`) | `signals.test.ts:244-298` | 已落 |
| H-48 | tick 本身无 span(进程内原语) | `schedules.ts` 无 tracer/span 引用 | 无断言;示例 README 陈述 | 已落但未验 |

#### 1.8.8 关系与依赖预算(harness.md:126-137)

| ID | 承诺 | 实装 | 状态 |
| --- | --- | --- | --- |
| H-49 | Agent(#10):loop 唯一改动 = step 边界注入缝;`finishReason` 增 `'suspended'` | `agent/types.ts:186`、`model/chunks.ts:18` | 已落 |
| H-50 | Workflows(#11):不加 workflow 新机器 | `workflows/` 无 harness 引用(`rg durable-agent\|signals` 零命中,除文档) | 已落 |
| H-51 | Memory(#12):signals 复用 MemoryStore | 见 H-22 | 已落 |
| H-52 | 存储(#15):四个 port | 见 ST-4..ST-7 | 已落 |
| H-53 | 多 agent(#19):无直接耦合 | `rg` 无耦合代码 | 已落但未验 |
| H-54 | 依赖预算:核心含 Harness 三件套运行时依赖硬线 = 0;croner 归能力包 | `packages/core/package.json` 无 dependencies | 已落 |

#### 1.8.9 harness 砍单表复核(harness.md:111-124)

| ID | 裁单项 | 承载缝 | 现状 | 证据 |
| --- | --- | --- | --- | --- |
| CUT-H1 | 崩溃自动恢复 / resumable stream / 多副本恢复 | `resume` 原语 + `listSuspended` 可选扩展归应用;外部 runner 能力包方向 | **仍是砍单**;`resume` 与 `listSuspended` 已落,runner 包不存在 | `durable-agent.ts:115`;`sqlite/src/snapshots.ts:205`;`packages/` 无 runner 包 |
| CUT-H2 | state signals | working memory + Processor 组合;入雾 | **仍是砍单**;两件承载件已落 | `memory/working-memory.ts`、`agent/processors.ts`;无 state signal 代码 |
| CUT-H3 | notification inbox | `sendSignal({type:'notification'})` 即时注入 | **仍是裁出**;承载缝已落 | `signals.ts:481-485` |
| CUT-H4 | signal providers | 示例模式(薄基类 + 订阅登记簿 DIY) | **仍是砍单**;无示例 provider 实现 | `rg provider` 无实现;`examples/signals-desk` 是演示脚本 |
| CUT-H5 | background tasks(deferred / untilIdle) | 「工具 ack + 完成后 sendSignal 唤醒」组合,文档范式;入雾 | **仍是砍单** | `rg backgroundTask` 零命中 |
| CUT-H6 | goals(standing objective + judge) | Processor + working memory 原型化;入雾 | **仍是砍单** | `rg goal` 在 `packages/*/src` 仅注释性表述 |
| CUT-H7 | AgentController / session 语义 | Agent 类自行组装 | **仍是砍单**;无 AgentController | `rg AgentController` 零命中 |
| CUT-H8 | durable sleep / 长延时等待 | schedules + suspend 组合 | **仍是砍单**;两件原语已落 | `schedules.ts:136`、`workflows/suspend.ts`;无 sleep 原语 |
| CUT-H9 | `ifActive`/`ifIdle` 分支行为矩阵 | 固定三句语义 | **仍是砍单**;三句已落 | `rg ifActive\|ifIdle` 仅规范文本;实现 = `signals.ts:340-379` 三路 |
| CUT-H10 | 触发记录(trigger history) | observability span | **仍是砍单**;无记录字段/表;tick 无 span | `types.ts:49-69`、`schema.ts:49-52`;`schedules.ts` 无 tracer |

#### 1.8.10 harness「关键差异」「无断言面」

- **关键差异**:H-11(裸 agent 口径,同 AG-15);H-28(`SignalsConfig` 多 `tracer?`、面含 `stream`/`generate`);H-36(`save` 对 Invalid Date 的规范外报错);ST 侧 `storage.md:68` 的 `await` 形态差异(DOC-7)。
- **无断言面**:H-1、H-4/H-5、H-11(裸 agent 侧)、H-16(内存默认深拷贝隔离)、H-18(缺席即无枚举)、H-19(无 CAS)、H-23(排队进程死 = 丢)、H-26(缺席零开销)、H-33/H-48(tick 无 span)、H-53;ST-40 的 `:memory:` 独立性同属。

## 2. 砍单/裁单表复核总表

> 覆盖八篇规范的全部砍单表行 + 内联裁项群;逐条明细见 §1 各子系统的砍单小节(同一 ID)。
> 现状取值 ∈ {仍是砍单 / 已部分落 / 已落但未记录}。**未发现「已落但未记录」行**。

| ID | 子系统 | 砍单项 | 现状 | 证据指针 |
| --- | --- | --- | --- | --- |
| CUT-M1 | model | 反向互操作(`withMastra` 类) | 仍是砍单 | `rg withMastra` 仅命中 `model.md:112` |
| CUT-M2 | model | workflow / network 路由 | 仍是砍单 | `chat-route.ts` 只有 agent/durable 一条面 |
| CUT-M3 | model | AI SDK `resume:true` GET 恢复端点 | 仍是砍单 | `chat-route.ts:83-87` 非 POST 一律 405;`ROADMAP.md:120` 在位 |
| CUT-M4 | model | 无状态全量 `UIMessage[]→ModelMessage[]` | 仍是砍单 | 只有反向 `to-ai-sdk-messages.ts:32-33` |
| CUT-M5 | model | typed 工具渲染(`dynamic:false`) | 仍是砍单 | `to-ai-sdk-stream.ts:92-99` 硬编码 `dynamic:true` |
| CUT-AG1 | agent | scorers / evals | 仍是砍单 | `ROADMAP.md:114` 延后行在位 |
| CUT-AG2 | agent | voice / browser / channels / workspace / skills | 仍是砍单 | `ROADMAP.md:130/150`;`browser`/`skills` 未具名 |
| CUT-AG3 | agent | editor / rawConfig | 仍是砍单 | `ROADMAP.md:129/150`(行号经复核修正) |
| CUT-AG4 | agent | durable / pubsub / backgroundTasks / signals / goal / notifications | **已部分落** | durable、signals、pubsub 已落地;其余归 ROADMAP 延后行(§1.2.8) |
| CUT-AG5 | agent | defaultOptions / metadata | 仍是砍单 | 两字段均不在 `AgentConfig` |
| CUT-AG6 | agent | hooks / transform / maxRetries | 仍是砍单 | 承载缝 = Processor 与 fallback 链 |
| CUT-AG7 | agent | 标题生成 | 仍是砍单 | 唯一 `title` 是 memory thread 元数据 |
| CUT-T1 | tools | MCP v1 单包 `@modelcontextprotocol/sdk` 路径 | 仍是砍单 | 两包直连 ^2.2.0,无 sdk 依赖 |
| CUT-T2 | tools | OAuth 授权流助手(v1 裁出) | 仍是砍单 | `mcp-client` 无 authProvider |
| CUT-T3 | tools | 内联裁项群(legacy sessionful / prompts / notify/bus / 旋钮 / per-call / listChanged / 重连 / elicitation 等) | 仍是砍单(与文本一致) | tools.md:98-101、126、129、131、132、136 |
| CUT-W1 | workflows | map / sleepUntil | 仍是砍单 | 源码无 `map`/`sleepUntil` |
| CUT-W2 | workflows | `createStep(agent\|tool)` 重载 | 仍是砍单 | `step.ts:133-141` 单一签名 |
| CUT-W3 | workflows | 嵌套 workflow as step | 仍是砍单 | 无入口 |
| CUT-W4 | workflows | state / setState 黑板 | 仍是砍单 | `walker.ts:575-577` 仅 `getStepResult` |
| CUT-W5 | workflows | bail | 仍是砍单 | 无 API |
| CUT-W6 | workflows | validateInputs 开关 | 仍是砍单 | 三处固定校验 |
| CUT-W7 | workflows | time-travel / restart / restartAll | 仍是砍单 | `run.ts` 仅 start/resume |
| CUT-W8 | workflows | shouldPersistSnapshot / prune 钩子 | 仍是砍单 | `run.ts:167-172` 固定策略 |
| CUT-W9 | workflows | resume CAS / serializedStepGraph / 多引擎适配 | **已部分落**(adapter 侧 CAS 落) | `sqlite/src/snapshots.ts:115-133`;其余全仓无 |
| CUT-W10 | workflows | chunk 级流式透传 | 仍是砍单 | 事件仅四类(`events.ts:75-79`) |
| CUT-W11 | workflows | durable sleep / 长延时等待 | 仍是砍单(核心侧) | 核心 `.sleep` = `setTimeout`;`schedules/types.ts:43` 无 workflow target |
| CUT-W12 | workflows | tripwire / canceled 状态 | 仍是砍单 | `snapshot.ts:12` 无 canceled |
| CUT-MEM1 | memory | semantic recall(向量 RAG) | 仍是砍单 | 无 embedding/hook;`memory.ts:160` |
| CUT-MEM2 | memory | OM 类后台压缩管线 | 仍是砍单 | 无代码;`memory.md:85` 仅文档 |
| CUT-MEM3 | memory | thread cloning | 仍是砍单 | 无 API |
| CUT-MEM4 | memory | 单条消息 update/delete | 仍是砍单 | 兜底 `deleteThread` 级联;`Memory` 类不暴露该方法 |
| CUT-MEM5 | memory | thread title 生成 | 仍是砍单 | title 是调用方字段 |
| CUT-MEM6 | memory | markdown template WM | 仍是砍单 | 无 template 形态 |
| CUT-MEM7 | memory | read-only WM | 仍是砍单 | 无 readOnly 配置 |
| CUT-MEM8 | memory | token 窗口 | 仍是砍单 | 只按条数(`memory.ts:130-133`) |
| CUT-MEM9 | memory | 访问控制 | 仍是砍单 | `types.ts:10` 明文归应用层 |
| CUT-MEM10 | memory | 所有权迁移 | 仍是砍单 | 显式抛错拒绝(`memory.ts:186-190`) |
| CUT-OBS1 | observability | gRPC transport / 厂商 exporter | 仍是砍单 | `otlp/package.json:45-51` 仅 http+proto |
| CUT-OBS2 | observability | OTel bridge / metrics / logs | 仍是砍单 | 无代码;`ROADMAP.md:116`(logs 另见 OBS-41) |
| CUT-OBS3 | observability | 自研批处理 / 重试 / 日志 / 错误回调 | 仍是砍单 | 官方 `BatchSpanProcessor`(`exporter.ts:18,106`) |
| CUT-OBS4 | observability | 内建截断 / 敏感数据规则库 | 仍是砍单 | 无截断/无 PII 规则代码 |
| CUT-OBS5 | observability | `gen_ai.conversation.id` 补全 | 仍是砍单 | `mapping.ts` 无该键 |
| CUT-OBS6 | observability | exporter `init?()`/`name` | 仍是砍单 | `events.ts:19-26` |
| CUT-OBS7 | observability | `MODEL_CHUNK`/`MODEL_GENERATION` span | 仍是砍单 | 无对应 span |
| CUT-ST1 | storage | 分域 composite / 域路由 | 仍是砍单(承载缝已落) | `app.ts:42` 注释即否认 |
| CUT-ST2 | storage | 观测存储域(span 落库) | 仍是砍单(承载缝已落) | `observability/` 无 store |
| CUT-ST3 | storage | harness 专属存储域(lease / notifications / thread-state) | 仍是砍单(承载缝已落) | 两个最小 port 已落 |
| CUT-ST4 | storage | PG / Redis 等第一方 adapter | 仍是砍单 | `packages/` 无对应包 |
| CUT-ST5 | storage | CAS 进基础 port | 仍是砍单(承载缝已落) | 基础 port 仅 load/save;CAS 在 sqlite |
| CUT-ST6 | storage | 核心托管连接生命周期 | 仍是砍单(承载缝已落) | 核心零 init/close;组合根未代管 |
| CUT-H1 | harness | 崩溃自动恢复 / resumable stream / 多副本恢复 | 仍是砍单(`resume`/`listSuspended` 已落) | `durable-agent.ts:115`;无 runner 包 |
| CUT-H2 | harness | state signals | 仍是砍单(承载件已落) | working memory + Processor |
| CUT-H3 | harness | notification inbox | 仍是砍单(裁出;承载缝已落) | `signals.ts:481-485` |
| CUT-H4 | harness | signal providers | 仍是砍单 | 无 provider 实现;`signals-desk` 是演示 |
| CUT-H5 | harness | background tasks | 仍是砍单 | `rg backgroundTask` 零命中 |
| CUT-H6 | harness | goals | 仍是砍单 | `rg goal` 仅注释 |
| CUT-H7 | harness | AgentController / session | 仍是砍单 | 无 AgentController |
| CUT-H8 | harness | durable sleep / 长延时等待 | 仍是砍单(原语已落) | 无 sleep 原语 |
| CUT-H9 | harness | `ifActive`/`ifIdle` 矩阵 | 仍是砍单(三句已落) | `signals.ts:340-379` |
| CUT-H10 | harness | 触发记录(trigger history) | 仍是砍单 | `types.ts:49-69`;tick 无 span |

**计数**:共 **60 行**(2026-10-11 更正:原计 61 差 1,纯 CUT-\* 编号实为 60,见 [#162](https://github.com/0xnicholas/oribos-framework/issues/162));`仍是砍单` **58** 行,`已部分落` **2** 行(CUT-AG4、CUT-W9),`已落但未记录` **0** 行。

## 3. §3 语义差异逐条复核(33 条声明 / 37 事实行)

> 对象:`docs/research/mastra-gap-analysis.md:73-81`(§3 五段)。口径(沿 A5):**有据** = 实装一致且有断言(缺席类以 grep 缺席为主证据);**部分有据** = 实装一致但测试只覆盖部分/相邻事实,或实装与声明有细微差异;**无断言** = 无任何断言且实装未确立该行为;**未查实** = 找不到实装或无法判断。行号以本报告基线为准。

### 3.1 A. Agent / 模型层(§3 line 75;6 条 6 行)

| ID | 声明(短引) | 实装 | 测试 | 结论 |
| --- | --- | --- | --- | --- |
| SEM-A1 | instructions 仅 string(无 string[] / SystemMessage / providerOptions) | `agent/types.ts:32-33`(`a plain string (no message-union passthrough)`);`agent.ts:419`(system 消息不带 providerOptions);旁证 `model/contract.ts:213` | `agent-surface.test.ts:48-61`(`@ts-expect-error` 拒数组);`:94-102`(拒 `scorers`) | 有据 |
| SEM-A2 | 同一步多个工具调用**串行**执行 | `agent/loop.ts:429-464`(逐个 `await`,`for (const call of pending)`;无并发原语) | `agent-loop.test.ts:91-140`(结果/回喂顺序)、`durable-agent.test.ts:272-310` | **部分有据**(差异:只固定顺序,无「第二个工具在第一个 settle 前不启动」的断言,即非并发未被测试固定) |
| SEM-A3 | `structuredOutput` 只 strict(无 errorStrategy / jsonPromptInjection) | `agent/structured-output.ts:16-18`(「No errorStrategy, no repair round trip, no silent fallback to raw text」);`types.ts:341-345`;错误类型 `:30-52` | `agent-structured-output.test.ts:109-191`(非 JSON/不合 schema/缺字段/stream/耗尽五路均 `StructuredOutputError`) | 有据 |
| SEM-A4 | chunk 协议只有四种(无推理增量、参数增量) | `model/chunks.ts:57-58`;类型定义 `:28-55` | `agent-stream.test.ts:17-48/49-56`;`model-normalize.test.ts:139-153/155-165` | 有据 |
| SEM-A5 | fallback 只在**未产出任何 chunk** 时切换(流中途失败不切换) | `agent/loop.ts:271-341`(`:281` `producedChunk=true`;`:321-332` 中途失败直抛);`model/fallback.ts:9-13` | `agent-fallback.test.ts:38/160-198/175-197/212-252` | 有据 |
| SEM-A6 | `maxSteps` 耗尽时 `finishReason:'tool-calls'` | `agent/loop.ts:377-382`(`{ ...finishChunk, finishReason:'tool-calls' }`);`chunks.ts:10-18`;`agent/types.ts:135-140` | `agent-loop.test.ts:246-292`(默认 5 / maxSteps 2 / provider 报 stop 时终值仍 tool-calls);`agent-memory.test.ts:201` | 有据 |

### 3.2 B. Workflow(§3 line 76;16 条 18 行)

| ID | 声明(短引) | 实装 | 测试 | 结论 |
| --- | --- | --- | --- | --- |
| SEM-B1 | `dowhile` 条件在**迭代前**求值、可 0 次迭代 | `workflows/walker.ts:972-980`(条件在 `executeStep` 之前);`entry.ts:75-80` | `workflows-loop-wait.test.ts:110-124`(0 次迭代,execute 未调用)、`:39-108`、`:152-165` | 有据 |
| SEM-B2a | `retries` = **额外**尝试数 | `workflows/retry.ts:11-20,34`;`step.ts:70-75` | `workflows-loop-wait.test.ts:353-379/381-405` | 有据 |
| SEM-B2b | 间隔固定 **1000ms** | `retry.ts:9`(`STEP_RETRY_INTERVAL_MS=1000`)、`:6-7` | `workflows-loop-wait.test.ts:353-379`(≥900ms 下界)、`:407-428` | 有据 |
| SEM-B2c | 等待可被 **AbortSignal** 打断 | `retry.ts:35`;`abort.ts:34-47` | `workflows-loop-wait.test.ts:430-459` | 有据 |
| SEM-B3 | `sleep` 的动态时长 fn 收 **RequestContext** 而非上一步输出 | `walker.ts:1035`;`entry.ts:35-41` | `workflows-loop-wait.test.ts:280-303`(收到的键恰为 `['runId','signal','userId']`) | 有据 |
| SEM-B4 | 无 `waiting` 状态、abort 即 failed | `snapshot.ts:12`(无 waiting);`abort.ts:1-7`;`walker.ts:337-346`、`:1022-1041` | `workflows-run.test.ts:370-434`;`workflows-suspend-resume.test.ts:269-300/178-220` | 有据 |
| SEM-B5 | resume **按记录回放**重建 tip(不重执行、不重估条件) | `walker.ts:417-466`、`:524-572`、`:796-804` | `workflows-suspend-resume.test.ts:362-421/424-482/747-789` | 有据 |
| SEM-B6 | `resumeData` 只给**被点名的那一次执行** | `walker.ts:702,586-591,892-893,970,326-331` | `workflows-suspend-resume.test.ts:834-875/1293-1322/936-990/993-1033` | 有据 |
| SEM-B7 | 快照 = 固定五字段 + 可选 `traceId`/`iterationSite` | `snapshot.ts:68-92`;`walker.ts:387-409` | `workflows-suspend-resume.test.ts:178-220/799/857/977/1102/1073/1290`;`workflows-observability.test.ts:237-295/296-321` | 有据 |
| SEM-B8 | (无)`suspendedPaths`/`serializedStepGraph` 路径模型 | 缺席;位置模型 = 扁平 `position` + `iterationSite`(`snapshot.ts:77-85`) | 无断言(缺席类;`suspend-resume.test.ts:178` 字段 toEqual 与 `:1085/1149` 间接固定) | 有据(缺席证明) |
| SEM-B9 | 拿掉 **state 黑板** | 缺席(`setState`/`getState`/`blackboard` 全 0 命中;`step.ts:14` 否定语);`StepContext` 七件套无 state | 等价物有测试:`suspend-resume.test.ts:483-520`;`loop-wait.test.ts:39-108` | 有据(缺席证明;「无 state」本身无直接断言) |
| SEM-B10 | 拿掉 **`bail`** | 缺席;等价物 = `branch`(`entry.ts:104-110`) | 无断言(缺席类) | 有据(缺席证明) |
| SEM-B11 | 拿掉 **`map`** | 缺席;builder 七算子(`workflow.ts:222-253`)、`WorkflowEntry` 七种(`entry.ts:96-103`);等价物 = foreach / 内联 step | 无断言(缺席类) | 有据(缺席证明) |
| SEM-B12 | 拿掉 **`sleepUntil`** | 缺席;等价物 = `sleep(ms\|fn)`(`entry.ts:89-93`;`walker.ts:1034-1041`) | 无断言(缺席类) | 有据(缺席证明) |
| SEM-B13 | 拿掉**嵌套 workflow** | 缺席(`entry.ts:96-103`;`workflow.ts:20-41` 字段无子图) | 无断言(缺席类) | 有据(缺席证明) |
| SEM-B14 | 拿掉 **`createStep(agent\|tool)`** | 缺席(`step.ts:133-155` 单一 config 工厂);等价物 = 手写 inline step(`examples/workflow-approval/src/index.ts:247-257` 注释明说) | 无断言(缺席类;example 注释即承载缝证据) | 有据(缺席证明) |
| SEM-B15 | `suspend()` 在**四类块体内都成立** | parallel `walker.ts:770-774`、branch `:811-816/826-837`、foreach `:909-922`、loops `:990-1002`;重进 `:446-457` + 校验 `:499-517`;类型 `snapshot.ts:44-60` | `suspend-resume.test.ts:1199-1396`(parallel)、`:747-789`(branch)、`:834-935`(foreach)、`:936-1083`(loops)、`:1085/1117/1149`(site 校验) | 有据 |
| SEM-B16 | 但**条件里调用报错** | `walker.ts:710-716`(`suspendOutsideStep`);`:719-724`(报错文案);条件侧 `step===undefined`(`:806`、`:1019`) | **无断言**(全测试目录检索不到触发该错误的用例) | **部分有据**(实装报错成立,错误路径无任何测试断言) |

> B 段旁注(事实):`workflows/step.ts:32-38` 的 `suspend()` docstring 仍称块内挂起是 explicit error(「no snapshot representation yet」),与实装(walker.ts 四类 site,#54)矛盾——陈旧注释,见 §4.3 DOC-2。

### 3.3 C. Memory(§3 line 77;4 条 4 行)

| ID | 声明(短引) | 实装 | 测试 | 结论 |
| --- | --- | --- | --- | --- |
| SEM-C1 | 工作记忆只有 **schema 形态**(merge 语义,无 markdown 模板) | `memory.ts:49-52`(唯一字段 schema);`working-memory.ts:72-81`;`memory.ts:236-241` | `working-memory.test.ts:92-151/406-486` | 有据 |
| SEM-C2 | 无单条消息 update/delete(`deleteThread` 级联兜底) | 缺席(端口 6+2 无消息级写删);级联 `store.ts:22-23`、`in-memory-store.ts:66`、`sqlite/src/memory.ts:135-138` + `schema.ts:35` | `memory-store.test.ts:236-268`;`working-memory.test.ts:184-200`;`sqlite/test/memory.test.ts:169-177` | 有据(两条差异注记:1)`deleteThread` 只在 port,`Memory` 类未暴露;2)`Memory.save` 带显式 `id` 可「覆盖写」,无 delete API) |
| SEM-C3 | 无 **thread cloning** | 缺席(`cloneThread` 全 0 命中;`clone` 仅 `structuredClone`) | 无断言(缺席类) | 有据(缺席证明) |
| SEM-C4 | 不做**访问控制**(授权归应用层) | `memory/types.ts:10`;`agent/types.ts:332-333`;`durable-agent.ts:24`;一致性检查 `memory.ts:186-190`(完整性而非授权) | `memory.test.ts:244`(只覆盖所有权错配,不覆盖「无授权判定」本身) | 有据(测试只覆盖相邻事实) |

### 3.4 D. Harness(§3 line 78;5 条 7 行)

| ID | 声明(短引) | 实装 | 测试 | 结论 |
| --- | --- | --- | --- | --- |
| SEM-D1 | 审批声明在 **durable 包装层** | `durable-agent.ts:24-25`(「never on Tool … core permission-free」)、`:43-46`、`:144,159-190` | `durable-agent.test.ts:56-186` | 有据 |
| SEM-D2 | 工具保持**四字段** | `tools/tool.ts:34-57`;工厂 `:100-113` | `tools-surface.test.ts:15-39/41-51` | 有据 |
| SEM-D3 | `approved:false` = 「用户拒绝」工具结果**回喂模型、run 继续** | `durable-agent.ts:277-281`;`:341-349`(`isError:true`);`loop.ts:430-438` | `durable-agent.test.ts:244-270`(execute 未调用、`finishReason==='stop'`、`isError===true`、回喂 prompt) | 有据 |
| SEM-D4 | signals 固定**三句语义**(无 `ifActive`/`ifIdle` 矩阵) | `signals.ts:24-28`;缺席 `ifActive`/`ifIdle` | `signals.test.ts:42-79/445-468/81-124/338-365` | 有据 |
| SEM-D5 | 排队队列**进程内** | `signals.ts:129-142,163-164`、`:33-34`(「the process dying drops every queued message」) | `signals.test.ts:81-124/338-365`;跨进程没有也不可能有用例 | 有据 |
| SEM-D6 | 调度**无触发记录**(span 覆盖追责) | `schedules/types.ts:49-69`(无 lastFiredAt/fire log);`schedules.ts:136-151`;`:144-147`(「the run's own trace is the failure's visibility」) | `schedules.test.ts:143-168`(记录恰为该形状)、`:298-327/328-346` | 有据 |
| SEM-D7 | `tick` 本身**无 span** | 缺席(`SchedulesConfig` 无 tracer;`rg tracer\|startSpan\|SPAN` 在 `schedules` 0 命中;`tick` 不创建 span) | 无断言(`schedules.test.ts` 无 tracer/Span 用例) | 有据(缺席证明;测试无断言) |

### 3.5 E. 观测(§3 line 79;2 条 2 行)

| ID | 声明(短引) | 实装 | 测试 | 结论 |
| --- | --- | --- | --- | --- |
| SEM-E1 | 快照里**只持久化 `traceId`**(mastra 存整个 tracingContext) | workflow `workflows/snapshot.ts:86-91`;durable `durable-agent/snapshot.ts:62-67`;写入 `walker.ts:393,406`、`durable-agent.ts:337`;`tracingContext` 全 0 命中 | `workflows-observability.test.ts:237-295/296-321`;`durable-agent.test.ts:478-525` | 有据 |
| SEM-E2 | resume = 同一 `traceId` 下的**新 run span** | `walker.ts:262-273`(只续 traceId);`durable-agent.ts:286-288`;`tracer.ts:130-135`(无 parentSpanId → 新 root) | `workflows-observability.test.ts:237-295`(parentSpanId 为 undefined);`durable-agent.test.ts:517-524`(同 trace 不同 span id) | 有据 |

**计数复核**(按事实行):有据 **35** / 部分有据 **2**(SEM-A2、SEM-B16)/ 无断言 **0** / 未查实 **0**;33 条声明 ↔ 37 事实行(B2 拆 3 行;D 的「审批声明 + 工具四字段」拆 2 行、signals 两行拆 2 行)。等价物核对(state 黑板 / bail / map / sleepUntil / 嵌套 workflow / createStep 重载 / 单条消息 update-delete / thread cloning)见 A5 附录;其中「单条消息 update/delete」与「thread cloning」**无等价物**。

## 4. 质量与债务盘点

### 4.1 错误语义与边界

#### 4.1.1 abort

| ID | 场景 | 实装行为 | 证据(代码) | 测试证据 |
| --- | --- | --- | --- | --- |
| Q-1 | Agent run(per-call `signal`) | `signal` 写入 `RequestContext.signal`(未传用永不中止常量),作为 `abortSignal` 交每次模型调用;loop **自身不检查** `signal.aborted`,取消只在 provider 尊重 `abortSignal` 时生效 | `agent/agent.ts:291/307-328/382` | `agent-loop.test.ts:493`;`agent-stream.test.ts:230-238`(调用前已中止 → 不发起调用) |
| Q-2 | 取消原因浮出且**不**走 `processError` | loop catch 里 `signal.aborted` 为真则原样抛出、跳过处理器链;链上后续候选不尝试 | `agent/loop.ts:314-320` | `agent-processors.test.ts:869-884`;`agent-fallback.test.ts:194-211` |
| Q-3 | 工具执行中 abort | 框架**不抢占**正在执行的工具;`ctx.signal` 交工具自行观察;中止在**下一次**模型调用处浮出;工具自身返回值/错误照常进本步结果 | `agent/loop.ts:429-464/732-745` | `agent-loop.test.ts:535-556` |
| Q-4 | 模型流中途 abort | 代码路径存在(同 Q-2 分支,不区分是否已产 chunk),但**没有专门测试**;假模型只在 `doStream` 前 `throwIfAborted()` | `agent/loop.ts:314-320`;`test/helpers/fake-model.ts:128-140` | **无断言**(未查实:实际行为取决于 provider 流内如何响应) |
| Q-5 | 同一 signal 沿 as-tool 链传播 | 父 run 把同一 signal 交给子 run;子 run 中止后父 run 以同一原因收尾 | — | `agent-as-tool.test.ts:354-…` |

#### 4.1.2 部分流 / fallback / generate vs stream

| ID | 项 | 实装行为 | 证据(代码) | 测试证据 |
| --- | --- | --- | --- | --- |
| Q-6 | fallback 切换判据 | 只在候选**尚未产出任何 chunk** 时切换;一旦产 chunk(含只下推理增量)该步不再切换,中途失败直接传播 | `agent/loop.ts:271-341`(尤其 `:279-281/321-332`)、`model/fallback.ts:1-14` | `agent-fallback.test.ts:39/82/161/95` |
| Q-7 | 已吐出的 chunk | 照常交付消费者;失败点之后不再有 chunk | `agent/stream.ts:84-92/120-131` | `agent-fallback.test.ts:175-192` |
| Q-8 | 链全部失败(未产 chunk) | 单元素链 → 原错误原样;多元素链 → `ModelFallbackError`(message 含每候选与错误,`failures` 保留原错误数组,`cause` = 最后一次错误) | `model/fallback.ts:47-75`;`loop.ts:343-353` | `agent-fallback.test.ts:213-…/241` |
| Q-9 | 流缺 finish part | 契约错误 `ModelContractError`;不静默补默认值;单步内缺 finish 立即失败 | `agent/stream.ts:11-16`;`loop.ts:306-310` | `agent-stream.test.ts:222-228` |
| Q-10 | `generate()` 与 `stream()` 错误面 | 单一代码路径;`generate()` = 终值 promise `Promise.all`;同一错误拒绝 | `agent/agent.ts:224-245` | `agent-generate.test.ts:94`;`agent-stream.test.ts:204-223` |
| Q-11 | 错误经过处理器可被替换 | 中途失败与链耗尽都先过 `processError`(声明序);替换后的错误是 run 的终错;工具线同 | `loop.ts:322-332/345-352/449-459` | `agent-processors.test.ts:494/539/664/706` |
| Q-12 | 消费者提前退出 | **不取消 run**:`return()` 停缓冲(清空 buffer),run 继续推进到终态;取消只能走 per-call `signal` | `agent/stream.ts:46-47/133-137`;`workflows/run.ts:288-289/371-376` | `agent-stream.test.ts:71-84` |

#### 4.1.3 校验失败

| ID | 校验点 | 失败路径与错误形状 | 证据(代码) | 测试证据 |
| --- | --- | --- | --- | --- |
| Q-13 | 工具 input 校验 | 不调用 `execute`;生成 `isError:true` 的 tool-result 回喂;run 不中止;错误先过 `processError` | `loop.ts:669-677/747-755` | `agent-loop.test.ts:305-…`;`agent-processors.test.ts:664` |
| Q-14 | 工具 output 校验 | `execute` 已执行(副作用已发生),失败同样生成 `isError` 结果回喂 | `loop.ts:693-700` | `agent-loop.test.ts:365-…`;`agent-processors.test.ts:706` |
| Q-15 | 未知工具 | `isError` 结果,消息 `Unknown tool '<name>'…` | `loop.ts:663-667` | `agent-processors.test.ts:706` |
| Q-16 | 工具失败对模型的文案 | `execute` 抛错保留原对象给 `processError`/span,模型看到 `Tool 'x' failed: <detail>`;框架自产错误整条消息直给模型 | `loop.ts:710-724` | 同上 |
| Q-17 | workflow 起始输入 | `WorkflowValidationError`(含 `issues`,`stepId` 为 undefined),run 不启动、任何 step 不执行 | `workflows/validate.ts:15-37/43-53` | `workflows-run.test.ts:202-…` |
| Q-18 | workflow step 输入 | 同错带 `stepId`;该 step 失败 → run 失败 | `validate.ts:59-70` | `workflows-run.test.ts:291-…` |
| Q-19 | workflow resumeData | 同错带 `stepId`;失败后快照仍可再恢复;声明了 `resumeSchema` 的步骤对缺省数据也校验;**未声明** `resumeSchema` 的步骤带数据即报错(非校验错误) | `validate.ts:82-99` | `workflows-suspend-resume.test.ts:521-…` |
| Q-20 | structuredOutput(strict) | 终值文本先 `JSON.parse`;非 JSON → `StructuredOutputError`(`text` 原文/`cause` 解析错/`issues` undefined);不合 schema → 同错误(`issues` 带路径);无 errorStrategy/无修复重试 | `agent/structured-output.ts:30-52/71-93`;`loop.ts:906-924` | `agent-structured-output.test.ts:110/127/145/154/175/298` |
| Q-21 | working memory 落库校验 | schema 校验失败显式报错(带 issues 路径)、不落库;经工具调用时按工具错误回喂、run 继续 | `memory/working-memory.ts`;`memory/memory.ts` | `working-memory.test.ts:139/458` |

#### 4.1.4 并发

| ID | 面 | 实装行为 | 证据(代码) | 测试证据 |
| --- | --- | --- | --- | --- |
| Q-22 | 同一 agent 并发 run | 实例字段全 `readonly`;每次 run 的 prompt/steps/runId/内存接线都是生成器内局部量 → 无跨 run 共享可变执行状态 | `agent/agent.ts:37-79/113-204` | **无专门测试** |
| Q-23 | 同一 thread 并发写 memory | `Memory.save` = 生成 id/时间戳 → `ensureThread`(读线程记录再写,read-modify-write,非事务)→ `saveMessages`(按 id upsert);消息不互相覆盖(UUID 键),线程记录 `updatedAt/title/metadata` 后写者胜 | `memory/memory.ts:149-162/168-183/275-278`;`in-memory-store.ts:51-126` | **无并发写测试** |
| Q-24 | sqlite memory 并发 | WAL + busy timeout + FK 级联;跨连接测试只断言「互相可见」与 FK 语义,未断言同 thread 并发写 | `sqlite/src/index.ts:16`;`sqlite/src/connection.ts:100` | `sqlite/test/cross-connection.test.ts:22` |
| Q-25 | workflow resume 去重(进程内锁) | 模块级 `Map<runId, Promise>`:同 runId 并发 resume 返回同一 promise;load→检查→校验→重进都在锁内;settle(含失败)后释放 | `workflows/run.ts:136-142/211-228` | `workflows-suspend-resume.test.ts:646-660/661-…` |
| Q-26 | workflow resume 去重(adapter CAS) | `compareAndSave` 只在 `@balsats/sqlite` 的 workflow 快照;**core 的 resume 路径不调用它**(只用 load + 进程内锁) | `sqlite/src/snapshots.ts:115-133`;`workflows/run.ts:230-283` | `sqlite/test/cross-connection.test.ts:48-68`;`workflow-snapshots.test.ts:62-108` |
| Q-27 | durable agent resume 去重 | 每 wrapper 实例一个 `Map<runId, Promise>` 进程内锁;**无 CAS**(注释明示);sqlite 的 agent 快照 store 也无 `compareAndSave` | `durable-agent.ts:144-151/244-258`;`sqlite/src/snapshots.ts:164-222` | `durable-agent.test.ts:464-475` |
| Q-28 | signals 队列并发注入 | 同 thread 只允许一个活跃 run(第二个 run 抛错);`sendMessage` 活跃期进 `pending`(step 边界一次 `splice(0)` 全量注入),`queueMessage` 进 `queue`,settle 时合成一次续跑(保到达序);投递/排队是同步数组 push | `signals/signals.ts:183-193/261-281/290-302/340-379` | `signals.test.ts:81-…/338-…`;**无并发投递测试**;订阅缓冲无界(`signals.ts:118-120/382-416`,`signals.test.ts:193/212` 未测上界) |

### 4.2 测试结构与覆盖盲区

| ID | 事实 | 证据 |
| --- | --- | --- |
| QT-1 | 实测总况:68 文件 / 865 例全过(17.03s);与 `ROADMAP.md:98/99` 一致;分布 core 44 / sqlite 7 / mcp-client 5 / ai-sdk 4 / otlp 3 / mcp-server 3 / croner 2 | `pnpm verify` 输出(附录 A) |
| QT-2 | 运行器 vitest,`include: ['packages/*/test/**/*.test.ts']`(`vitest.config.ts:27`);`@balsats/*` 公开入口全部别名到 **src**(`vitest.config.ts:14-24`),测试打的是源码接缝,不是 dist | 同上 |
| QT-3 | 假模型 `test/helpers/fake-model.ts` 实现真实 `@ai-sdk/provider` 的 `LanguageModelV4` 接口(编译期保真),录制 call options 供断言 | — |
| QT-4 | 类型级用例:多套 `*-surface.test.ts` 以 `@ts-expect-error` 钉公共面(`agent-surface.test.ts:59/99/134`、`workflows-surface.test.ts:95/103`、`tools-surface.test.ts:104/121`),属编译期断言,运行时只计数 | — |
| QT-5 | CI 脚本自身也有单测:`check-byte-budget.test.ts`(10)、`check-runtime-deps.test.ts`(11)、`check-export-surface.test.ts`(9)、`check-deps-budget.test.ts`(5);**`scripts/check-dist.mjs` 没有对应单测** | — |
| QT-6 | 三层分工:单元/接缝测试在 `packages/*/test/**`(68 文件,含真 `node:sqlite` 文件与真 HTTP/stdio 子进程);端到端 = `examples/` 10 个自断言脚本(`node:assert/strict`),**不在 `pnpm verify`/CI 内**;预算/红线 = `scripts/check-*.mjs` 六个(verify 含 dist / runtime-deps / export-surface;byte-budget 与 deps-budget 是 CI 独立黄灯步,`package.json:22`、`ci.yml`) | — |
| QT-7 | 盲区 1:模型流**中途** abort(流已开始后再 abort)——无用例(假模型只在调用前检查信号) | `test/helpers/fake-model.ts:128-140` |
| QT-8 | 盲区 2:同一 agent 的**并发 run**——无用例;仅代码层可读为无共享可变状态 | Q-22 |
| QT-9 | 盲区 3:同一 thread 的**并发 memory 写**(core 内存实现与 sqlite 皆然)——无用例 | Q-23/Q-24 |
| QT-10 | 盲区 4:signals **并发投递 / 同时多发送方**——无用例(只有顺序排队断言) | Q-28 |
| QT-11 | 盲区 5:durable agent **跨进程** resume(无 CAS)——无用例;注释即承认 | Q-27 |
| QT-12 | 盲区 6:`check-dist` 脚本本身——无单测(其余四个 check 脚本都有) | QT-5 |
| QT-13 | 盲区 7:examples 端到端——不在测试运行器/CI 内,只能人工跑 | QT-6 |
| QT-14 | 盲区 8:流内存上界 / 背压——无任何用例或基准 | §4.4 |
| QT-15 | 盲区 9:发布路径(pack 内容、publish 前检查)——无脚本、无用例 | §4.5 |
| QT-16 | 盲区 10:真 provider(真模型)行为——全仓测试用假模型;examples 依赖外部 key(不在 CI) | §0.2 |

### 4.3 文档一致性(含已知不一致清单)

**一致项(抽查复核,均一致)**

| 抽查项 | 文档声明 | 代码实测 |
| --- | --- | --- |
| 埋点边界数 | 「自动埋点:**七**边界」`observability.md:85`、`docs/architecture/README.md:12` | `observability/span.ts:10-16` 恰 7 常量(signals 的 `type:'signal'` isEvent span 为**非**框架常量,`signals.ts:270-273` 明示有意为之) |
| chunk 类型数 | 「落地四种」`model.md:36` | `model/chunks.ts:58` 恰四种 |
| port 方法数 | `storage.md:10-15`:MemoryStore 6+2;WorkflowSnapshotStore 2;AgentRunSnapshotStore 2;ScheduleStore 5 | `memory/store.ts:17-39`、`workflows/snapshot.ts:100-104`、`durable-agent/snapshot.ts:78-82`、`schedules/store.ts:15-25` 全部一致 |
| 扩展面清单 | `storage.md:23-31` 五个可选方法 | sqlite 全部实现(`snapshots.ts:27-50/115-133/164-222`) |
| 「prepublishOnly 类声明」 | 全仓(含 docs/adr、ROADMAP)**没有任何** prepublish/prepack/prepare 的声明或脚本 | `grep -rn "prepublish"`(排除 node_modules)零命中 |
| README 安装面 | 七包 npm `latest=0.5.0`、`publishConfig.access: public`;README Package surface 表逐符号 | 实跑 import 探针:core 10 入口 + 六能力包全部 ok;`check:dist` 16 子路径全过 |
| examples 名与命令 | 10 个 example 的 `package.json` name 与 README 的 `pnpm --filter @balsats/example-*` 完全对应,每个都有 `start` + `typecheck` | 逐文件核对无错名 |

**已知不一致清单(12 处;只列事实,不裁决)**

| ID | 不一致 | 规范/文档侧 | 代码/实装侧 | 来源 |
| --- | --- | --- | --- | --- |
| DOC-1 | 块内 step 的 suspend 读法 | `workflows.md:141`(#54 修订):读 `suspended`(修订 #52 的读 failed) | `workflows/events.ts:45-49` 的 `WorkflowStepEndEvent` JSDoc 仍写「a suspend raised … (#51) leaves the run failed and reads `failed` here」;实装与断言读 `suspended`(`walker.ts:659-666`;`workflows-events.test.ts:235-269`) | A2 §6-1 |
| DOC-2 | 块内 suspend 是否合法 | `workflows.md:91/99`(#54):块内 suspend 真挂起 | `workflows/step.ts:32-38` 的 `StepContext.suspend` JSDoc 仍称在 parallel / branch arm / foreach / loops 中挂起是 explicit error(「no snapshot representation yet」)——与 `walker.ts:741-777,796-837,909-923,990-1003` 相反 | A2 §6-2 / A5 旁注 |
| DOC-3 | 快照 JSON-only 约束 | `workflows.md:84/116`:JSON-only(大数据只存引用) | `workflows/in-memory-snapshot-store.ts:11-14` 自述「structuredClone 会放行 Map/Set/Date/循环,JSON-only 是 port 的契约、本默认实现不检查」——无运行时执法(设计自述一致) | A2 §6-5 |
| DOC-4 | `.branch` 各分支 IO schema 一致 | `workflows.md:70-77` 控制流算子表:各分支 IO schema 一致 | 类型层无强制(`workflow.ts:104-110` 只约束 cond 输入与 prev schema);代码注释 `walker.ts:785-786` 用「expected to share」;无断言 | A2 §6-6 |
| DOC-5 | 桥接 wrapper 的运行时 `types` | `tools.md:137`:`types: { input: unknown, output: unknown }` | `mcp-client/src/index.ts:243`:`types: Object.freeze({ input: undefined, output: undefined })`(类型层注解 `StandardSchema<unknown,unknown>` 在 `:239`)——语义等价、字面不同 | A2 §6-3 |
| DOC-6 | 非 isError 结果缺 structuredContent 的错误码 | `tools.md:138`:抛 `InvalidRequest` / 不合 → `InvalidParams` | 仓内唯一相关断言观察到 `SdkErrorCode.InvalidResult`(`mcp-client/test/wire.test.ts:149-171`,输入 `structuredContent: null`);SDK 是否另有两码路径**未查实** | A2 §6-4 |
| DOC-7 | `sqlite.init()` 形态 | `storage.md:68` 代码块 `await storage.init()` | 实装同步 `void`(`sqlite/src/index.ts:53`、`connection.ts:76-88/90-97`),注释自认「`await storage.init()` from older docs still resolves immediately」;`await` 作用于 void 合法 | A4 §6-5 |
| DOC-8 | Signals 构造签名与面 | `harness.md:41` `createSignals({ agent, memory? })` | 实装多一个可选 `tracer?`(`signals.ts:50-56`);面除四方法外含 `stream`/`generate`(`signals.ts:71-93`) | A4 §6-5 |
| DOC-9 | `schedules.save` 的附加校验 | 规范块未写 | `schedules.ts:186-190` 对 `next` 返回 Invalid Date 显式报错 | A4 §6-5 |
| DOC-10 | README `result` 信封 | `README.md:153` 注释 `// { status: 'success' \| 'failed' \| 'suspended', … }` | 实装 `result` **只** resolve success/suspended;失败 reject(`workflows/run.ts:48-54`「A failed run never reaches here」);`workflows.md:136/139` 与该注释矛盾;快照状态枚举含 `'failed'`(`snapshot.ts:12`)但不是 `result` 信封 | A6 §3.1 |
| DOC-11 | README Development 段 | `README.md:300` `pnpm verify # typecheck + build + tests + dist / runtime-deps checks` | verify 实际含 **check:export-surface** 且**不含** byte/deps 预算(`package.json:22`);描述不完整 | A6 §3.1 |
| DOC-12 | 源码注释语言(minor) | — | `packages/` 全部 `src` 中的汉字只出现在 2 行(`memory/in-memory-store.ts:68/108` 中文注释),其余源码注释为英文;测试文件注释与用例名则系统性使用中文 | A6 §3.4 |

### 4.4 性能与资源(轻量检查;无基准)

| ID | 项 | 事实 | 证据 | 测量状态 |
| --- | --- | --- | --- | --- |
| Q-29 | chunk 缓冲 | 无界数组:消费者慢于生产时 `buffered.push(chunk)` 无容量上限;`return()` 后停缓冲并清空;**没有背压** | `agent/stream.ts:48/84-92/133-137` | 未测量 |
| Q-30 | workflow 事件缓冲 | 同上(`buffered: WorkflowEvent[]`);终止/失败前的事件照常交付 | `workflows/run.ts:307/348-356/371-376` | 未测量 |
| Q-31 | signals 订阅缓冲 | 文档明示「未消费的订阅无界缓冲」 | `signals.ts:118-120/388-394` | 未测量 |
| Q-32 | 提前退出不等于取消 | 两个 output 对象都明说「结束的是这次遍历,不是 run」;放弃迭代后模型调用/工具执行/内存写继续完成 | `agent/stream.ts:46-47`;`workflows/run.ts:288-289` | — |
| Q-33 | 单 run 内的增长 | `prompt` 与 `steps` 随步数线性增长,步数上界 `maxSteps`(缺省 5);usage 累加不持有额外对象;resume 的 `answers` Map 仅 resume 时分配 | `loop.ts:28/169-171/480/195-198` | — |
| Q-34 | 锁表生命周期 | workflow `resumeLocks` 模块级 Map、durable `resumes` wrapper 级 Map;都在 `finally` 里按同一 promise 比对后删除(settle 后不残留) | `workflows/run.ts:222-227`;`durable-agent.ts:253-256` | 未测量(长期运行行为未压测) |
| Q-35 | 观测内存 | tracer 不保存 span 注册表(hide 策略用 WeakMap);memory exporter 有界环形缓冲(缺省 1000,满则淘汰最旧) | `observability/tracer.ts:108`;`exporters/memory.ts:32-49` | — |
| Q-36 | memory 写成本 | 每个完成 step 一次 `save`(首个 step 连带 run 输入消息);每次 save 重新构造整批消息对象 | `loop.ts:485-498`;`memory/memory.ts:149-162` | 未测量 |
| Q-37 | 并发路径共享状态 | agent 层无共享可变执行态;Memory 实例有 `lastStamp` 一个可变字段(单调时间戳);signals/workflow 各有一个进程级 Map | `memory/memory.ts:104-105`;`signals.ts:164`;`workflows/run.ts:142` | — |

### 4.5 0.5.0 遗留

| ID | 项 | 事实 |
| --- | --- | --- |
| REL-1 | 已发布 tarball 元数据(已复核) | `npm view` + `npm pack @balsats/core@0.5.0`:dist-tags.latest=0.5.0、engines >=22.13.0、publishConfig.access=public、exports 10 子路径;tarball 内 `description="Balsa core — …"`、`repository.url=git+https://github.com/0xnicholas/balsa-framework.git`(旧名);七包 description 全部以 `Balsa ` 开头、repository.url 全部指向 `balsa-framework`。与 `ROADMAP.md:99` 记账一致(不可原地修改,只能随下次发布修正)。本地待发状态:七包 description 全为 `Balsats …`、repository.url 全部为 `balsats-framework`(逐包核对) |
| REL-2 | `prepublishOnly` 加固 | **全仓 18 个 package.json(根 + 七包 + 十 example)都没有 `prepublishOnly`/`prepack`/`prepare` 脚本**;全文件级 grep(排除 node_modules)对 `prepublish` 零命中(含 docs)。因此 `pnpm -r publish` 前不会自动跑 build/verify;`files:["dist"]` 只决定打包内容,不保证 dist 是新的。相关决策记录在票里而非仓库:issue #107(OPEN)正文写「`prepublishOnly` 加固(owner 曾裁不落)」 |
| REL-3 | `pnpm verify` 与预算检查 | verify **不含** byte/deps 两个预算检查(`package.json:22`),它们是 CI 的独立黄灯步(`ci.yml`) |
| REL-4 | #84 状态 | 标题「文档站分发面:skills 包与 npm 内嵌文档的归属及 manifest 消费契约」;**OPEN**;label `documentation`(非 wayfinder 票);给出分工表、三条硬约定与 manifest 形状示例;明说不阻塞文档站建站,动手时点 = 框架要发 skills 包或 embedded docs 的那次 effort;仓库内无对 #84 的引用(`grep "#84"` 零命中) |
| REL-5 | 检查运行时额外观察 | `deps-budget` 全绿,但 mcp-client 打印一条下界提示(见 §0.1);单跑六个 check 全部 exit 0;字节预算 16/16 零超支 |
| REL-6 | 旧名残留扫描 | 活面(README/CONTEXT/AGENTS/architecture/scripts/examples/七包 package.json 与 README)`grep "Balsa\b\|@balsa/"` **零命中**;命中只剩保留面:`ROADMAP.md` 5 处既有修订行、`docs/adr/` 9 文件、`docs/research/` 3 文件——与 `ROADMAP.md:97`「历史记录面按 dated records 保留」一致 |

## 5. 跨子系统归属(事实性描述)

> 只列事实归属;同一承诺的证据分布在多个子系统时给主要落点与相关系数,不做裁决。

| ID | 承诺/机制 | 证据主要在 | 说明(事实) |
| --- | --- | --- | --- |
| X-1 | chunk 协议(四种类型 + FinishReason) | `packages/core/src/model/chunks.ts` | 定义在模型子系统;消费方:`agent/loop.ts:1`、`signals/signals.ts:12`、`ai-sdk/src/to-ai-sdk-stream.ts:12`;`workflows/events.ts:1-11` 自称「与 chunk 协议同一 envelope 的词汇」但**不 import** `Chunk`(独立类型集);`observability/span.ts:37-38` 复用 `Usage`/`FinishReason` 类型 |
| X-2 | ai-sdk 帧映射的 `providerExecuted`/`dynamic` 语义 | `packages/ai-sdk/src/chunks.ts` | 由 `to-ai-sdk-stream.ts` 写死;与 core 的 chunk 无关字段(核心 chunk 无该字段) |
| X-3 | route 的 memory 权威读取 | `packages/ai-sdk/src/chat-route.ts:128-148` | recall 实现在 `packages/core/src/memory` + `agent.ts:157-164`;路由只传 identity |
| X-4 | durable 挂起表达(route 侧) | `chat-route.ts:194-203/242-248` | 挂起机制在 `packages/core/src/durable-agent/durable-agent.ts`;loop 缝在 `agent/types.ts:223-242` + `loop.ts:394-427`;三处协作 |
| X-5 | agent loop 的工具执行 | `packages/core/src/agent/loop.ts:429-464` | 工具定义在 `packages/core/src/tools/tool.ts`;schema→provider 在 `tools/to-model-tools.ts` |
| X-6 | step 边界 span 的 model/provider/usage/finishReason | `loop.ts:605-623` + `:367-374` | span 类型在 `packages/core/src/observability`;观测断言在 `agent-observability.test.ts` |
| X-7 | workflow step 快照复用 chunk 词汇 | `model.md:126` 承诺 | 当前 `workflows/**` 未 import `Chunk`;词汇同构(判别联合 + kebab-case),类型不同源 |
| X-8 | signals 订阅流 → ai-sdk 转换 | `signals.ts:121/381-395`(源头)与 `to-ai-sdk-stream.ts:42-52`(消费面) | 无跨包集成测试 |
| X-9 | suspend/resume、快照、resume CAS(workflows) | storage / harness | 核心 port `WorkflowSnapshotStore`(`snapshot.ts:100-105`);扩展实现 `packages/sqlite/src/snapshots.ts:27-40`;durable 重启归 `harness.md`(workflows.md:172 自述) |
| X-10 | 审批 / 挂起裁决(tools.md:42、147) | harness / durable-agent | 审批声明与闸门在 `durable-agent.ts:24-58`(注释明说 #13 保持核心无权限);agent loop 挂起点 `agent/types.ts:178-184`(`stepBoundary` = 唯一 harness 扩展点)、`:223-228`(审批点);被答复调用 `loop.ts:431-440` |
| X-11 | ToolContext `traceId`/`spanId` 与 as-tool 续 trace | observability / agent | 常量 `observability/span.ts:12-14`;tool span 埋点 `agent/loop.ts:630-644`;agent run option 外部 trace 约定 `agent/types.ts:143` |
| X-12 | MCP schema 直通 / draft-07 与 draft-2020-12 两个出口 | standard-schema | 契约 `standard-schema.ts:166`;核心出口 draft-07 `standard-schema-runtime.ts:41-43`;MCP 出口由 SDK 消费同一 `~standard.jsonSchema`(`mcp-server/src/index.ts:158-171`) |
| X-13 | 动态参数约定(workflow `.sleep` fn、as-tool description) | agent | `agent/dynamic.ts:9-17`;`agent/types.ts:26` 收口说明 |
| X-14 | workflows 事件 / span 复用 chunk 协议词汇 | model | `model.md` 为词汇单点;事件类型定义在 `workflows/events.ts:20-79`,无 model 包导入 |
| X-15 | durable sleep / 调度(workflows.md:164) | harness / schedules | 核心 `.sleep` 非 durable(`abort.ts:29-47`);`schedules/types.ts:43` 目标仅 agent/signal;措辞指向 harness.md |
| X-16 | MCP client 桥接工具进 agent 容器 | agent | `mcp-client/src/index.ts:190-204` 产 `Record<string,Tool>`;agent 容器 `agent/types.ts:43` |
| X-17 | `@balsats/core` 零依赖红线 | 全包面 | `packages/core/package.json` 三字段空;执法脚本 `scripts/check-runtime-deps.mjs`(`ZERO_RUNTIME_PACKAGES` 分支) |
| X-18 | memory ↔ storage port | `memory/store.ts` + `packages/sqlite/src/memory.ts` | `storage.md:171` 记「钉 MemoryStore 需求(6+2);条件 2 即能力标志模式的首个实例」;SQLite adapter 8 方法全量(`sqlite/src/memory.ts:108` 起,方法体 `:110,118,135,141,172,205,227,235`;测试 `sqlite/test/memory.test.ts:273`) |
| X-19 | memory ↔ agent | `agent/types.ts:54`;`agent.ts:466-483`;`agent.ts:154-162` + `loop.ts:466-503` | `AgentConfig.memory` 为 `DynamicArgument<Memory>`;per-call identity 校验在 `agent.ts:466-483`;recall 在 `processInput` 前、save 在 `processOutputStep` 后 |
| X-20 | memory ↔ agent 工具面 | `agent.ts:391-404` | WM 工具由 `withRunTools` 追加在用户工具之后、同名冲突显式抛错(测试 `working-memory.test.ts:348/384`) |
| X-21 | memory ↔ 恢复语义 | `agent.ts:158`;`durable-agent.ts:87-89` | resume 的 run 不加载 WM(`resumedPrompt !== undefined` 分支返回 undefined);durable 快照不持久化 memory 配置,resume 需重传 |
| X-22 | memory ↔ observability | `span.ts:59-70`;`agent.ts:497-519`;`loop.ts:545-576` | recall/save 两 span 常量与挂点;无 memory 身份的开销为零(`agent-observability.test.ts:475`) |
| X-23 | memory ↔ signals | `signals.ts:41-48/346` | signals 复用宿主同一 `Memory` 实例(未配置一致即构造期报错);注入消息直接经 `memory.save` 落历史;唤醒 run 自行 recall/save |
| X-24 | observability ↔ agent/loop | `agent.ts:146-150`;`loop.ts:605-620/630-645` | 三边界挂点;trace 续接与 hide 覆盖在 root 创建时消费(`agent.ts:357-379`) |
| X-25 | observability ↔ workflows | `walker.ts:234-251/677-685` | run/step 挂点;traceId 进快照(`workflows/snapshot.ts:91`),resume 续 trace(`walker.ts:263-264`) |
| X-26 | observability ↔ durable-agent | `durable-agent.ts:128,171,337`;`durable-agent/snapshot.ts:67` | durable 快照持久化 traceId 并在 resume 时经 run option 续接(`durable-agent.ts:285-288`);`observability.md:206` 把「持久执行跨进程 trace 延续语义」归 Harness |
| X-27 | observability ↔ signals | `signals.ts:258-275` | 注入事件以 `isEvent` span 挂当前 run 的 `agent-run` 上(测试 `app.test.ts:527`) |
| X-28 | observability ↔ schedules | `packages/core/src/schedules` | 全文不含 tracer/span 引用(`rg` 空);`mastra-gap-analysis.md:78` 记「调度无触发记录(span 覆盖追责);tick 本身无 span」 |
| X-29 | Agent loop(durable 与 signals 的共同落点) | `agent/types.ts:186/223-286` | `AgentRunOptions.stepBoundary`;loop 侧实现 `agent/loop.ts:244-248`(`beforeNextStep`)与 `:419-424`(suspend 终态);`FinishReason` 扩 `'suspended'`(`model/chunks.ts:18`);三者改动面在该处交汇 |
| X-30 | Workflows(WorkflowSnapshotStore 消费方) | `workflows/run.ts:167-172`;`walker.ts:408` | 缺省内存 store;`persistStepBoundaries` 仅真实 store 时写;跨进程 CAS 归 adapter(`workflows.md:87`) |
| X-31 | Memory(MemoryStore 消费方) | `memory/memory.ts:307-313`;`signals.ts:346/320` | `Memory` 类做能力检测;signals 的注入/唤醒经 `Memory.save`/per-call memory |
| X-32 | Schedules(消费方) | `schedules.ts:133/126` | 消费 `Agent.generate`(threadless)与 `Signals.sendSignal`(threaded);被 `@balsats/croner` 以 save 片段消费(`croner/src/index.ts:52-67`) |
| X-33 | Observability(锚点依赖) | `signals.ts:267-279`;`durable-agent.ts:288`;`span.ts:19` | durable 挂起/resume 与 signals 注入的 span 锚点依赖 `AgentConfig.tracer` / boundary 事件的 `traceId`/`spanId`;span 类型常量不新增(`SpanType=string`) |
| X-34 | 组合根 | `app.ts:44-58`、`:3-21`;`app.test.ts:249-360` | 四 storage 槽 + 三件套工厂;组合根不代管 adapter `init`/`close`(规范此为可选口径 `storage.md:174`) |
| X-35 | `@balsats/sqlite` | `sqlite/src/index.ts:20-26` | 同时面向四个 port;core 仅 types 依赖;`examples/sqlite-resume` 演示跨进程 resume + CAS(`examples/sqlite-resume/src/index.ts:223-239`) |
| X-36 | `@balsats/croner` | `croner/src/index.ts:52-67` | core 仅 devDep;接线单测位于 croner 包(`croner/test/wiring.test.ts`) |

## 6. 未查实与边界(六路分片汇总)

> 汇总六路分片声明的全部「未查实 / 未跑 / 受阻」项,不丢弃;命令面已由 A6 补齐的项注明。

| ID | 未查实/边界项 | 原因/边界 | 来源 |
| --- | --- | --- | --- |
| U-1 | 真 provider(真模型)路径 | 4 个 example 需 key 未跑;3 个 example 由本地 mock 驱动(模型行为由 mock 决定) | A6 §6 / A1 |
| U-2 | 任何性能/内存数字(流缓冲增长、并发吞吐、长期运行锁表) | 仓库无基准,未做压测 | A6 §6 |
| U-3 | 模型流「已开始后再 abort」的实际行为 | 依赖 provider 如何响应 `abortSignal`;假模型不覆盖该路径 | A6 §6 / A2 |
| U-4 | OTLP「安装树 12 包 / 19,312,287 B」并集口径 | `deps-budget` 为按直接依赖分列的闭包数字,与规范并集口径不可直接比对 | A3 §6 |
| U-5 | 批处理器默认参数与 unref 的**仓内**回归 | 只在 node_modules 官方包源码核对,无仓内测试断言 | A3 §6 |
| U-6 | `OTEL_EXPORTER_OTLP_CERTIFICATE`/`CLIENT_CERTIFICATE`/`CLIENT_KEY`/`TIMEOUT` env | `env.test.ts` 未覆盖;透传由官方基座承担 | A3 §6 |
| U-7 | OTLP url 缺省 `http://localhost:4318/v1/traces` | 官方基座默认;仓内无断言、未实跑 | A3 §6 |
| U-8 | memory 与「外部记忆引擎」的宿主侧路径 | 不在本仓实装范围内,无仓内证据 | A3 §6 |
| U-9 | CI 未运行 | 只读了 `ci.yml` | A6 §6 / A4 §6 |
| U-10 | `docs/adr`/`docs/research` 的 dated 内容是否仍有旧名的决定性影响 | 按 `ROADMAP.md:97` 保留面口径,未逐条复核 | A6 §6 |
| U-11 | #84 引用的外部仓库(balsa-docs / balsats-docs)当前结构;registry 后续变化 | 外部事实,读取时间 = 2026-10-02 | A6 §6 |
| U-12 | `packages/core/dist`、`packages/ai-sdk/dist` 的新鲜度 | 分片只做只读查看;**本报告由 `pnpm verify` 重建 dist 后被 A6 的 check:dist 覆盖**,但 A1 分片未独立核 | A1 §6 |
| U-13 | 地图 #102 / #65 的 issue 内容 | 经 `gh` 读取(网络);「Out of scope」具名清单(如 browser/skills)在地图与 ROADMAP 均未见具名 | A1 §6 |
| U-14 | `mastra-gap-analysis.md`、`CONTEXT.md` 术语逐行核对 | 不属分片范围;未对 ai-sdk README/包文档 prose 逐句比对 | A1 §6 |
| U-15 | 类型级断言(`expectAssignable` 系列)的运行面 | 在 `tsc` 阶段生效;分片未运行 tsc(本报告引 `pnpm verify` 的 typecheck 段覆盖) | A1 §6 |
| U-16 | P11 快照写失败语义 | 无测试用例;仅读到 `run.ts:337-345` 实现 | A2 §5 |
| U-17 | 条件内 `suspend()` 报错(workflows.md:91) | 实现有(`walker.ts:720-724`),未找到断言 | A2 §5 |
| U-18 | MCP server:在途交换被 close 中止、authInfo 透传不消费、容器构造后变更不上线、inputSchema 非 object 根的报错面、`~standard.validate` transform 生效 | 实现存在或由 SDK 承接,未找到断言 | A2 §5 |
| U-19 | MCP client:`CONNECTION_CLOSED` 在途拒绝、401/403、`LIST_PAGINATION_EXCEEDED`、`x-mcp-header` 非法工具剔除、`stderr`/`cwd`/`maxBufferSize` 不暴露、断线不重连 | 无断言(部分为纯 SDK 行为) | A2 §5 |
| U-20 | 桥接 wrapper 的 `vendor`/`version`/`types` 运行时值 | 无断言;`types` 实际为 `{input:undefined,output:undefined}` | A2 §5 |
| U-21 | `@balsats/core/workflows` 出口的 `StepContext.suspend` 文档注释与 #54 实装不一致 | 文本事实,未追查历史动线 | A2 §5 |
| U-22 | examples 跑通 | 由 A6 实跑覆盖(6/10;其余 4 个未跑,见 U-1) | A2 §5 / A6 |
| U-23 | 七常量清单逐一核对 | 属 observability 切片;本报告已核 `span.ts:10-16` 七常量 | A4 §6 |
| U-24 | 规范与实装的形态差异裁决 | `await storage.init()` vs 同步 void;`createSignals` 多 `tracer?`;`schedules.save` Invalid Date 附加行为——已记录、未裁决 | A4 §6 |
| U-25 | `check:dist`/`check:export-surface`/`check:runtime-deps`/`check:byte-budget`/`check:deps-budget` | A6 已全部实跑 exit 0(分片当时未跑) | A4 §6 / A6 |
| U-26 | 上游声明(mastra 侧 1.71 eager tool execution 等) | 本仓不可查,未计入 §3 结论 | A5 附录 B |
| U-27 | 发布事实(npm registry / tarball) | A6 已复核(见 REL-1);A4 分片当时未核 | A4 §6 / A6 |
| U-28 | harness.md:8「mastra 源码里 Harness 已只是 AgentController 的废弃别名」 | 出自 `docs/research/`,未在仓库外核验 | A4 §6 |
| U-29 | 同一 agent 并发 run / 同一 thread 并发 memory 写 / signals 并发投递 / durable 跨进程 resume | 均无用例(见 QT-8..QT-11) | A6 §2.3 |
| U-30 | `check-dist` 脚本自身、examples、发布路径、真 provider | 无单测 / 不在 CI(见 QT-12/13/15/16) | A6 §2.3 |

## 附录 A · 命令证据摘要(源自 A6 命令流水账)

> 全部命令在仓库根执行;开始/结束 `git status --porcelain` 均空;HEAD = `94798c9`。环境:node v26.2.0 / pnpm 10.33.2 / 2026-10-02。CI 用 Node 22.13.0,本地 Node 26.2.0(sqlite 测试因此打印 `ExperimentalWarning`)。`pnpm install` 未执行(node_modules 已存在)。

| ID | 命令 | exit | 关键输出 |
| --- | --- | --- | --- |
| CMD-1 | `git rev-parse HEAD` / `git status --porcelain` | 0 / 空 | `94798c93c9889aed4d091315e20f6220f2f9113b`;审计前后工作树均干净 |
| CMD-2 | `pnpm verify` | **0** | typecheck(17/18 workspace 项目)→ build → test → check:dist → check:runtime-deps → check:export-surface;`Test Files 68 passed (68)`、`Tests 865 passed (865)`、`Duration 17.03s` |
| CMD-3 | `pnpm check:dist` | 0 | **16 子路径** ok(core 10 + 六包各 1) |
| CMD-4 | `pnpm check:byte-budget` | 0 | **16/16 零超支**(逐项数字见 §0.1) |
| CMD-5 | `pnpm check:deps-budget` | 0 | 六包全 ok;mcp-client 下界提示(`isexe@2.0.0` 缺 `dist.unpackedSize`,计 0 B) |
| CMD-6 | `pnpm check:export-surface` | 0 | 七包导出面无缺口(core 10 子路径) |
| CMD-7 | `pnpm check:runtime-deps` | 0 | 七包全绿(core:0 依赖 / 57 模块 / 0 外部导入) |
| CMD-8 | examples 离线四个 | 0 | `cron-schedule` / `otlp-collector` / `mcp-tools`(HTTP)、`mcp-tools`(stdio) |
| CMD-9 | examples 无 key 三个 | 1 | `sqlite-resume` / `workflow-approval` / `durable-approval`(`Set OPENAI_API_KEY …`) |
| CMD-10 | examples 本地 mock 三个 | **0** | `sqlite-resume`(挂起→`listSuspended`→resume→CAS race→schedules.listDue)、`durable-approval`(两 run 各挂起一次、approved+rejected 两路)、`workflow-approval`(挂起→同 runId resume→3 次 store 写) |
| CMD-11 | README import 探针(七包软链进 /tmp) | 0 | core 10 入口 + 六能力包全部 ok(含 `@balsats/ai-sdk` exports=4) |
| CMD-12 | `npm view` / `npm pack @balsats/core@0.5.0` | 0 | latest=0.5.0;tarball 内旧名(见 REL-1) |
| CMD-13 | 旧名与 `prepublish` 扫描(排除 node_modules) | 0 | 活面 `Balsa`/`@balsa/` 零命中;`prepublish` 零命中;保留面 = ROADMAP 5 处 + adr 9 文件 + research 3 文件 |
| CMD-14 | `gh issue view 103/84/107` | 0 | #103 本票(OPEN,wayfinder:research);#84 OPEN(documentation);#107 OPEN(判定票,正文含 prepublishOnly 记录) |
| CMD-15 | 本次合成补跑基线 | 0 | `pnpm exec vitest run agent-fallback / workflows-loop-wait / durable-agent`:**3 文件 / 51 例全过**(为变异核对取基线) |

原始日志在 `/tmp/audit103/*.log`(会话内);本报告未再复跑 `pnpm verify`。

## 附录 B · 抽样校验记录(引用抽检 24 处,跨 6 个分片)

> 方法:从六路分片抽取引用点,**亲自读原文件**核对「path:line + 摘录」是否属实;错行/错引在报告内更正或标注。抽检为抽样,非穷尽。

| ID | 分片 | 抽检的引用 | 结果 |
| --- | --- | --- | --- |
| SC-1 | A1/A2/A3/A6 | `vitest.config.ts` include 行号(A1 写 `:19`;A3 写 `:24`;A2/A6 写 `:27`) | **两处错行**:实际在 `:27`;报告统一按 `:27`,并在 §0.3 记录更正 |
| SC-2 | A1 | `loop.ts:271/281/321-332`(fallback 点题 + 中途失败不切换) | 属实 |
| SC-3 | A1 | `chunks.ts:57-58`(四种 chunk 联合) | 属实 |
| SC-4 | A1 | `chat-route.ts:199-201`(`messageMetadata` 恒写 `{usage}`) | 属实(核读 `:196-203`) |
| SC-5 | A1 | `agent-step-boundary.test.ts:163` 裸 Agent 传 `stepBoundary` 得 `'suspended'`;`helpers/agent.ts:18-20` 确证 `new Agent(...)` | 属实 |
| SC-6 | A2 | `loop.ts:657-703`(三线错误:未知工具 `:663-667`、input `:669-677`、output `:693-700`) | 属实 |
| SC-7 | A2 | `events.ts:48-49` 陈旧注释(块内 suspend 读 failed) | 属实(核读 `:45-49`) |
| SC-8 | A2/A5 | `step.ts:32-38` 陈旧 docstring(块内 suspend 是 explicit error) | 属实(核读 `:32-39`) |
| SC-9 | A2 | `mcp-server/src/index.ts:131-138` 工具名正则 + assert | 属实 |
| SC-10 | A3 | `app.ts:28-29`(logger 槽未落)+ `:61-70`(AppConfig 仅 tracer/storage) | 属实 |
| SC-11 | A3 | `otlp/src/mapping.ts:201-204`(`balsats.span.type` + 未映射键) | 属实 |
| SC-12 | A3/A6 | `observability/span.ts:10-16` 七常量 | 属实 |
| SC-13 | A4 | `sqlite/src/snapshots.ts:115-133` CAS 单语句 + `changes()` | 属实 |
| SC-14 | A4/A5 | `durable-agent.ts:277-281`(拒绝集映射)+ `:342-349`(`isError:true`) | 属实 |
| SC-15 | A4 | `memory/store.ts:47-49`(`supportsWorkingMemory` 成对检测) | 属实 |
| SC-16 | A5 | `walker.ts:710-724`(条件内 `suspend()` 显式报错) | 属实 |
| SC-17 | A5 | `agent/structured-output.ts:16-18`(strict 唯一策略) | 属实 |
| SC-18 | A6 | `package.json:22` verify 脚本 = typecheck/build/test/check:dist/runtime-deps/export-surface(**不含**预算) | 属实 |
| SC-19 | A6 | `README.md:153`(`result` 注释含 `'failed'`)+ `workflows/run.ts:48-54`(失败 reject) | 属实 |
| SC-20 | A6 | `agent/stream.ts:48`(`buffered: Chunk[] = []`,无界) | 属实 |
| SC-21 | A2 | `mcp-client/src/index.ts:239-243`(`vendor:'balsats'`、`types:{input:undefined,output:undefined}`) | 属实 |
| SC-22 | A1/A3 | `ROADMAP.md` 延后清单行号(`:111` Supervisor / `:113` bunfold / `:114` Evals / `:115` 字符串路由 / `:116` OTel bridge / `:117` Background tasks / `:118` Goals / `:120` resumable stream) | 属实;但 A1 把「Studio / editor / stored agents」出域行写作 `:130` —— **实际在 `:129`**,报告内已改为 `:129` |
| SC-23 | A6 | `ROADMAP.md:97/98/99`(865 例 68 文件、发布 0.5.0、tarball 旧名记账) | 属实 |
| SC-24 | A2/A3/A4 | 八篇规范行数(tools 152 / workflows 178 / memory 107 / observability 210 / storage 178 / harness 137)、68 个测试文件分布、七包 version 0.5.0 与 deps 面 | 属实(`wc -l`、`find`、逐包 `package.json` 核对) |

**结论**:24 处抽检中 **2 处错行**(SC-1、SC-22),其余 22 处属实;错行均已在报告正文更正(不掩盖),未发现错引导致的事实性错误。

## 附录 C · 变异核对记录(抽样 3 例,非穷尽)

> 目的:抽验「高价值断言」是否真被测试固定。**安全协议**逐例遵守:先 `cp <文件> /tmp/audit103/mut-backup-<n>.ts`;改**单个文件**的最小一处;跑该测试文件;记录失败输出;`cp` 还原;`git diff --name-only` 确认空(除本报告 `?? docs/research/completeness-audit.md` 外无差异);再跑该测试文件确认复绿。全程未用 `git stash`/`checkout`/`clean`/`commit`,未做全局还原;**一次只动一个文件**。合成完成后执行,此时无其它代理在跑。

| ID | 目标断言(对应条目) | 文件:行 | 变异(最小一处) | 失败输出(关键) | 还原核验 | 复绿 |
| --- | --- | --- | --- | --- | --- | --- |
| MUT-1 | fallback 仅在候选未产出任何 chunk 时切换(M-9 / SEM-A5 / Q-6) | `packages/core/src/agent/loop.ts:281` | `producedChunk = true;` → `producedChunk = false;` | `pnpm exec vitest run packages/core/test/agent-fallback.test.ts`:**2 failed / 16 passed**;失败例「首个 chunk 之后的失败:run 以原错误拒绝」「中途失败前已产出的 chunk 照常交付给消费者」 | `git diff --name-only` 空;`git status --porcelain` 仅报告文件 | **18/18 通过** |
| MUT-2 | `dowhile` 条件在迭代前求值、可 0 次迭代(SEM-B1 / O-5) | `packages/core/src/workflows/walker.ts:973-977` | 首次尝试:去掉 `!(await loopConditionHolds(...))` 的 `!` → 语义反转使 0 迭代用例死循环,**worker 40.75s 后 SIGABRT**(vitest 报 1 error,测试文件未完成;同样构成「测试检测到变化」);改用更窄变异取得清晰断言失败:break 条件加 `iterationCount > 0 &&` | `pnpm exec vitest run packages/core/test/workflows-loop-wait.test.ts`:**2 failed / 16 passed**;失败例含 `workflows-loop-wait.test.ts:119 expect(execute).not.toHaveBeenCalled()`(0 次迭代断言) | 同上 | **18/18 通过** |
| MUT-3 | `approved:false` 的「用户拒绝」结果以 `isError` 回喂模型(H-9 / SEM-D3) | `packages/core/src/durable-agent/durable-agent.ts:348` | `isError: true` → `isError: false` | `pnpm exec vitest run packages/core/test/durable-agent.test.ts`:**2 failed / 13 passed**;失败例断言 rejection 路 `toolResults` 的 `isError` 为 `true`(`durable-agent.test.ts:304` 一带) | 同上 | **15/15 通过** |

**收尾核对**:三个被变异文件 `cmp` 与各自备份**逐字节一致**;`git diff --stat` 空;工作树唯一差异 = 本报告(未跟踪)。变异为**抽样 3 例,非穷尽**。

## 附录 D · 来源

- **规范(八篇)**:`docs/architecture/model.md`(129 行)/ `agent.md`(103)/ `tools.md`(152)/ `workflows.md`(178)/ `memory.md`(107)/ `observability.md`(210)/ `storage.md`(178)/ `harness.md`(137),及 `docs/architecture/README.md`。
- **事实底座与术语**:`docs/research/mastra-gap-analysis.md`(§3 五段逐条复核对象)、`CONTEXT.md`。
- **决策与账本**:`docs/adr/`(0001–0015,含 0011 harness semantics)、`docs/ROADMAP.md`(M5 完成段、发布 0.5.0 行、延后清单 = 重开条件单一真相源)、根 `README.md`。
- **实装面**:`packages/core/src/**`(agent / model / tools / workflows / memory / observability / signals / durable-agent / schedules / app.ts)、六个能力包 `packages/{ai-sdk,otlp,sqlite,mcp-server,mcp-client,croner}/src/**`;七包 `package.json` 与 `byte-budget.json` / `deps-budget.json`;`scripts/check-*.mjs`;`examples/`(10 例);`.github/workflows/ci.yml`。
- **测试面**:`packages/*/test/**/*.test.ts`(68 文件 / 865 例)+ `test/helpers/*`;`vitest.config.ts`。
- **六路并行证据分片(会话内,未入仓)**:`/tmp/audit103/A1-model-agent.md`、`A2-tools-workflows.md`、`A3-memory-observability.md`、`A4-storage-harness.md`、`A5-semantics.md`、`A6-quality-debt.md`、`A6-commands.md`;原始命令日志 `/tmp/audit103/*.log`;变异备份 `/tmp/audit103/mut-backup-{1,2,3}.ts`。
- **相关票**:[#102](https://github.com/0xnicholas/balsats-framework/issues/102)(wayfinder 地图)、[#103](https://github.com/0xnicholas/balsats-framework/issues/103)(本审计)、[#104](https://github.com/0xnicholas/balsats-framework/issues/104)–[#107](https://github.com/0xnicholas/balsats-framework/issues/107)(下游判定票)、[#84](https://github.com/0xnicholas/balsats-framework/issues/84)、[#45](https://github.com/0xnicholas/balsats-framework/issues/45) / [#97](https://github.com/0xnicholas/balsats-framework/issues/97) / [#99](https://github.com/0xnicholas/balsats-framework/issues/99)(发布与收口)。
