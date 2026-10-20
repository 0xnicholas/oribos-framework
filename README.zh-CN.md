# Oribos

[English](README.md) | [简体中文](README.zh-CN.md)

构建能连续运行数天的 AI 智能体。Oribos 是一个 TypeScript 智能体框架——涵盖 agents、memory、
workflows,以及 harness 三件套(durable agents、signals、schedules)——且**零运行时依赖**:
只组合你用到的部分,随处运行。路线图如今追赶已被生态验证的功能面——在这条轻量轴之内,
而不是取代它。

> **Oribos** 是伞形品牌;本仓库——**oribos-framework**——是其框架子项目。包以 `@oribos/*`
> scope 发布(始于 `@oribos/core`),后续子项目将与之并列。

> **定位——第三次摆动,如实写明(2026-10-12)。** Oribos 起步时是一个有意分叉的轻量替代品,
> 2026-10-11 当天该立场先被正式裁定维持
> ([ADR-0016](docs/adr/0016-positioning-verdict-maintain-divergence.md)),随后又被 owner 决策
> 推翻([ADR-0017](docs/adr/)):两波路线图工作产出的
> 全部是判定与文档、零功能增量,「不追赶」纪律下的路线图没有功能面出口。新立场:主流框架
> 已实装且持续维护的功能面计为需求证据,Oribos 实现其中与下方轴线兼容的子集——零运行时
> 依赖、一切 opt-in、无常驻管线——按需组合这一差异轴原样保留。首批追赶件已落地(多工具
> 并发调用、推理 / 工具参数增量帧、time-travel restart、`@oribos/supervisor`、
> `@oribos/evals`、signal-provider webhook、后台任务配方);追赶面其余部分见
> [路线图](docs/ROADMAP.md)排序。

> **状态:** 1.0 之前。Agents、memory、workflows、harness 三件套(durable agents、signals、
> schedules)以及十八个能力包均已实现并验证([路线图](docs/ROADMAP.md))。**0.9.0 已发布**:
> 全部十九个包均已上架 npm([`@oribos/core`](https://www.npmjs.com/package/@oribos/core) 加上十八个
> 能力包),统一以 `v0.9.0` 标签发布——追赶面**收尾段**,追赶面就此收口
> ([ADR-0017](docs/adr/),见上文「定位」):`@oribos/distributed-signals` 跨实例 signals、
> `@oribos/inngest` 把工作流触发外包给 Inngest 的外部 runner、
> `@oribos/observational-memory` 请求内联的记忆压缩、`@oribos/background-tasks` 协调式
> 后台工作——全部 additive、零破型、默认不变。它取代 0.8.0——后者是追赶面**中层段**:
> `@oribos/rag` 语义召回、`@oribos/resumable-stream` 可重连流、`@oribos/model-router`
> 字符串路由、`@oribos/checkpoints` 每步检查点 + 崩溃重放、`@oribos/otel-bridge` 真
> OpenTelemetry span(映射经共享叶子包 `@oribos/semconv`);再往前,0.7.0 是首个**追赶版**
> 发布:opt-in 多工具并发调用、opt-in 推理 / 工具参数增量帧、time-travel restart、
> `@oribos/supervisor`、`@oribos/evals`、signal-provider webhook 形态、后台任务配方;
> 0.6.0 是 `@oribos/*` scope 下的首个发布,承载更名后的线上接口面(OTel 属性族、
> 环境变量前缀、服务名;见 [ADR-0013](docs/adr/0013-naming-and-branding.md))及 M1–M5 外加
> 一轮加固;0.5.0 以旧 `@balsats/*` scope 发布且现已撤下,请改用 `@oribos/*`。0.1.0 /
> 0.2 / 0.3 **未**单独发布。核心之外的包见[能力包](#能力包m5)。

## 为什么选择 Oribos

- **只组合你用到的部分。** 每个子系统都藏在自己的 subpath export 之后
  (`@oribos/core/agent`、`/tools`、`/memory`、`/workflows`……)。你不导入的东西不会产生任何
  成本——无论是依赖树(核心零运行时依赖)还是概念空间。
- **零运行时负担。** 不需要数据库、队列或常驻进程。存储端口默认提供内存实现,Oribos 嵌入
  你的应用,而不是接管它。

一个很小的心智面贯穿始终:一个 agent 只有寥寥几个字段,一个 tool 只有四个字段,横切扩展点
只有一个(processors),模型实例直接来自 AI SDK provider 生态——无需适配器,无需注册表。

## 环境要求

- Node.js ≥ 22.13
- 一个适配你模型的 AI SDK provider 包(如 `@ai-sdk/openai`),以及一个用于工具输入/输出的
  schema 库(如 `zod`)——核心本身零依赖

## 安装

```bash
npm install @oribos/core zod @ai-sdk/openai
```

要求 `0.6.0` 或更高——更早的 0.5.0 系列以旧 `@balsats/*` scope 发布且现已撤下。0.9.0 覆盖的
内容见[状态](#状态)。若要在本仓库上开发,请参阅
[开发](#开发)。

## 快速上手

```ts
import { openai } from '@ai-sdk/openai';
import { Agent } from '@oribos/core/agent';
import { createTool } from '@oribos/core/tools';
import { z } from 'zod';

// 一个 tool 是只有四个字段的普通对象——description、可选的 inputSchema / outputSchema、
// execute——其名字就是它在 tools 容器中的键。Schema 是 Standard Schema 双接口
// (zod@4 原生支持):框架用它校验模型的参数,并把 JSON Schema 发给 provider。
const weather = createTool({
  description: 'Looks up the current weather for a city.',
  inputSchema: z.object({ city: z.string() }),
  execute: ({ city }) => ({ city, celsius: 18 }),
});

// agent 的面:name、instructions、model、tools(外加可选的 memory / processors)。
// 模型实例直接来自某个 AI SDK provider 包。
const agent = new Agent({
  name: 'assistant',
  instructions: 'You are concise. Use the weather tool for weather questions.',
  model: openai.chat('gpt-4o-mini'),
  tools: { weather },
});

// 一次运行,同一对象上的两种消费方式:`for await` 流式读取 Oribos 自己的 chunk 协议;
// 终值(text、usage、steps、finishReason)在该对象上 await 获得。
const result = agent.stream('What is the weather in Paris right now?');

for await (const chunk of result) {
  if (chunk.type === 'text-delta') process.stdout.write(chunk.textDelta);
}

console.log(await result.finishReason, await result.usage);
```

`agent.generate(input)` 是同一次运行折叠为终值的形式——就是 `stream()` 加 await,同一条代码
路径,因此两者永远一致。当模型以工具调用作答时,内置循环会执行该工具并把结果回喂给模型,
直至 `maxSteps`(默认 5)步;工具失败会以 `isError` 结果返回,模型可以据此自行恢复。

每个配置字段都是**动态参数**:它既接受一个值 `T`,也接受一个函数
`(ctx: RequestContext) => T | Promise<T>`,在每次执行时针对请求上下文
(`signal`、`runId`,外加你自己的按次调用属性)解析。

## 开箱即有什么

每个子系统都藏在自己的 subpath export 之后——只用你需要的。[包接口面](#包接口面)一表就是
完整的导入映射。

### Agents — `@oribos/core/agent`

`Agent` 把模型、instructions 和 tools 包装成可以 `generate()` / `stream()` 的对象。横切关注点
——guardrails、脱敏、限流、evals——只住在一个地方:**processors**,三个钩子
(`processInput` / `processOutputStep` / `processError`)按声明顺序运行。多智能体协作就是
**as-tool 组合**:把一个 agent 包成 tool,挂到另一个 agent 上;委托就是一次普通的工具调用。
核心里没有 supervisor 协议,也没有子智能体概念——[`@oribos/supervisor`](#能力包m5) 把这个
模式打包成了能力包;见[能力包](#能力包m5)。

两个 additive 的 run options 在不动默认值的前提下扩展一次运行:`toolExecution: 'eager'`
让每个工具调用在参数流完的瞬间即启动(结果仍按调用顺序发射);`deltas: { reasoning,
toolInput }` 在默认四帧 chunk 协议之外发射推理与工具参数的增量帧——不消费它们的一方看到的
仍是同一次运行。

### Memory — `@oribos/core/memory`

```ts
import { Memory, createInMemoryStore } from '@oribos/core/memory';

const memory = new Memory({ storage: createInMemoryStore() });
const agent = new Agent({ name, instructions, model, memory });

// thread 和 resource 按次调用命名——agent 本身不携带任何会话状态,
// 所以一个 agent 服务所有会话。缺失的 thread 会在首次保存时创建。
await agent.generate('Should I bring a rain jacket?', {
  memory: { thread: 'trip-lisbon', resource: 'user-42' },
});
```

**消息历史**(默认开启)把每次运行的消息按 thread 持久化,并把最近窗口(`lastMessages`,
默认 10)注入下一次 prompt;`memory.recall()` 是唯一的查询入口。**工作记忆**(通过 schema
选择开启)是一个小型结构化、按 resource 作用域的记录,模型通过一个框架挂载的工具更新它,
它以 system 消息的形式注入——于是该用户的下一次对话,无论在哪个 thread,开局就已了解其
画像。存储走一个 port,内存实现为默认;换成持久化适配器,port 之上的东西一概不变。

### Workflows — `@oribos/core/workflows`

```ts
import { createStep, createWorkflow } from '@oribos/core/workflows';

const workflow = createWorkflow({ id: 'expense-approval', inputSchema, outputSchema })
  .foreach(checkItem, { concurrency: 2 })
  .parallel([policyCheck, budgetCheck])
  .branch([
    [(ctx) => ctx.inputData['budget-check'].budget === 'over', routeManager],
    [() => true, routeAuto],
  ])
  .then(draftMemo)      // 一个 execute 里调用 agent 的步骤,就是 agent 加入 workflow 的方式
  .then(approvalGate)   // ctx.suspend() 以 JSON 快照展开此次运行
  .then(finalize)
  .commit();

const run = workflow.createRun({ runId: 'run-1' });
const out = run.start({ inputData: report });
for await (const event of out) { /* run-start / step-start / step-end / run-end */ }
const settled = await out.result; // { status: 'success' | 'suspended', … }

// 之后——即便在另一个进程里,配合持久化的快照存储:
const outcome = await workflow
  .createRun({ runId: 'run-1' })
  .resume({ step: 'approval-gate', resumeData: { approved: true } });
```

builder 编译为一张扁平的条目列表,由一个 for 循环解释执行——不是 DAG。每条边界(启动输入、
步骤输入、resume 数据)都对照其 Standard Schema 校验。`suspend` / `resume` 依托步骤边界处的
JSON 快照,通过一个存储端口持久化(默认内存)。`run.restart({ step })` 是快照 run 的
time-travel:目标步骤处及其之后的记录被截断,walk 从那里重进,并续接同一条 trace——省略
step 则整个 run 从启动输入重新执行。它是 `resume` 的 load → 重进原语的薄变种:零新端口、
无 resume 数据。

### 可观测性 — `@oribos/core/observability`

```ts
import { createApp } from '@oribos/core';
import { consoleExporter, createTracer } from '@oribos/core/observability';

// 组合根是一个可选的薄装配点:在这里装配一个 tracer,交给经由该 app 构建的每个 agent——
// 无需逐 agent 接线。
const app = createApp({ tracer: createTracer({ exporters: [consoleExporter()] }) });
const agent = app.agent({ name, instructions, model, tools });
```

Oribos 有自己的极简 span 模型(不是 OTel):每次 agent run、模型步骤、工具调用、workflow
run/step,以及 memory recall/save 都被追踪,内置 console 和 memory 两种 exporter。OTLP
(GenAI 语义约定)作为独立能力包发布。独立的 `new Agent({ … })`,不带 app 也不带 tracer,
依然是完全的一等公民——零开销,不产生任何 span 对象。

### Signals — `@oribos/core/signals`

`createSignals({ agent, memory? })` 是面向 thread 的交互原语:向活跃运行注入用户输入、把空闲
thread 唤醒为一次新运行,或按序排队——注入的内容会落进消息历史。单进程语义;跨实例分发
属于能力包的职责。

### Durable agents — `@oribos/core/durable-agent`

```ts
import { createDurableAgent } from '@oribos/core/durable-agent';

// 把 agent 包装成一次运行可以停下来等人的形态:名字在审批名单上的工具调用不会执行——
// 运行挂起,其循环快照写入一个 port。
const durable = app.durableAgent({ agent, approval: { tools: ['issueRefund'] } });
const out = durable.stream('Please refund order A-4471.');
// out.finishReason === 'suspended' → out.suspendPayload 说明扣下了什么
await durable.resume(out.runId, { approved: true }); // 执行它……或传 false:模型重新规划
```

审批声明住在包装器上,绝不在工具上——工具保持四个字段,核心保持无权限概念。快照只含 JSON,
经由 `AgentRunSnapshotStore`(`load` / `save`,默认内存);一次 resume 会在同一 trace 中开启
新的 `agent-run` span,因此一次人机交互始终是一条 trace。崩溃恢复、多副本租约和可恢复的
stream 被有意排除在核心之外。

### Schedules — `@oribos/core/schedules`

```ts
import { createSchedules } from '@oribos/core/schedules';

const schedules = createSchedules({ agents: { desk: agent }, signals });
await schedules.save({ id: 'morning-sweep', next: (from) => nextDailyAt(9, from), target: { … } });
await schedules.tick(); // 列出到期的 → 触发 → 推进 nextFireAt
```

`tick` 就是全部运行时:平台 cron 打一个调用它的端点是一等形态,`startTicker` 只是进程内的
便利封装。记录经由 `ScheduleStore`,只含 JSON;occurrence 函数是**注入的**
(`next(from) → Date | null`),因此 cron 解析永远不会进入核心。触发器要么无 thread
(`agent.generate`),要么带 thread(向一个会话 `sendSignal`——schedules 复用 signals)。

## 包接口面

| 导入路径 | 提供什么 |
| --- | --- |
| `@oribos/core` | `createApp`——可选的组合根 |
| `@oribos/core/agent` | `Agent`、动态参数、结构化输出、processors |
| `@oribos/core/model` | 模型契约与 chunk 协议类型 |
| `@oribos/core/tools` | `createTool` 与工具类型 |
| `@oribos/core/memory` | `Memory`、`createInMemoryStore`、memory 存储端口 |
| `@oribos/core/workflows` | `createWorkflow`、`createStep`、快照存储、`restart`(time-travel) |
| `@oribos/core/observability` | `createTracer`、console / memory exporter、span 类型 |
| `@oribos/core/signals` | `createSignals`——在 thread 上注入 / 唤醒 / 排队 |
| `@oribos/core/durable-agent` | `createDurableAgent`、审批闸门、`AgentRunSnapshotStore` |
| `@oribos/core/agent-run` | `continueRun` / `RunContinuation` / `createResumeLock`——能力包用的 continuation 缝 |
| `@oribos/core/output-object` | `createOutputObject` / `teeOutputObject` / `materialize`——输出对象泵:能力包 / 高级集成用的稳定小表面 |
| `@oribos/core/schedules` | `createSchedules`、`tick`、`ScheduleStore` |

### 能力包(M5)

携带外部依赖的能力包以独立的 `@oribos/<capability>` 包发布——用哪个装哪个。六个全部已实现
并验证:`pnpm verify` 中的单元测试、覆盖全部六个包的五个端到端示例(见
[示例](#示例)),以及在存在依赖可测之处设有压缩后字节预算和依赖闭包基线
([路线图](docs/ROADMAP.md),M5)。六个随 `0.6.0` 首发;追赶包分三段跟进——首批
(supervisor / evals)随 `0.7.0`,中层五件随 `0.8.0`,远层(distributed-signals / inngest /
observational-memory / background-tasks)随 `0.9.0`——十九个包
现已统一以 `@oribos/*` scope 发出(见[状态](#状态)):

| 包 | 提供什么 | 规范 |
| --- | --- | --- |
| `@oribos/otlp` | OTLP exporter:Oribos span 映射到 GenAI 语义约定 | [observability.md](docs/architecture/observability.md) |
| `@oribos/otel-bridge` | OTel bridge:Oribos span 变成宿主 TracerProvider 上的真 OpenTelemetry span(映射经共享叶子包 `@oribos/semconv`) | [observability.md](docs/architecture/observability.md) |
| `@oribos/mcp-server` | 你的工具经 MCP(HTTP / stdio)对外提供服务 | [tools.md](docs/architecture/tools.md) |
| `@oribos/mcp-client` | 别家 MCP server 的工具,变成 Oribos 工具 | [tools.md](docs/architecture/tools.md) |
| `@oribos/sqlite` | 覆盖全部四个存储端口的 SQLite 适配器 | [storage.md](docs/architecture/storage.md) |
| `@oribos/ai-sdk` | AI SDK UI message stream 互操作及一条 `useChat` 路由 | [model.md](docs/architecture/model.md) |
| `@oribos/croner` | 把 cron 表达式变成注入的 `next` 函数 | [harness.md](docs/architecture/harness.md) |

bunfold memory 桥经过评估,暂不采用;重新开启的条件列在路线图的延期清单里。打包与依赖红线
规则见 [ADR-0002](docs/adr/0002-package-structure.md) 和
[ADR-0015](docs/adr/0015-ci-lightweight-redlines.md)。

M5 之后落地的追赶包分三段发布:`@oribos/supervisor` / `@oribos/evals` 随 `0.7.0`(首批,
均零依赖);中层五件随 `0.8.0`;远层随 `0.9.0`(见上文「状态」):

| 包 | 提供什么 | 规范 |
| --- | --- | --- |
| `@oribos/supervisor` | 子 agent 即委派工具——公开 as-tool 表面上的单个 `createSupervisor` 工厂,核心零新缝 | [agent.md](docs/architecture/agent.md) |
| `@oribos/evals` | scorer 即普通 `{ name, score }` 对象——经 processor 逐步接线,或对已收束的整跑事后打分 | [agent.md](docs/architecture/agent.md) |

追赶面中层段(均 opt-in、不配置零成本;`@oribos/otel-bridge` 见上表):

| 包 | 提供什么 | 规范 |
| --- | --- | --- |
| `@oribos/rag` | 语义召回:包装 `MemoryStore`,save 落库 hook 索引 + recall 窗口语义增强,向量库客户端随调用方 | [memory.md](docs/architecture/memory.md) |
| `@oribos/resumable-stream` | 可重连流:事件缓存录 run 流,`observe(runId)` 重放 + 进程内跟随 | [harness.md](docs/architecture/harness.md) |
| `@oribos/model-router` | 字符串路由:`'provider/model'` → 模型实例,models.dev 类目录随包 vendored,核心无注册表 | [model.md](docs/architecture/model.md) |
| `@oribos/checkpoints` | 每步检查点 + 崩溃重放:边界检查点落自有 store,`recover(runId)` / `recoverAll()` boot 恢复 | [harness.md](docs/architecture/harness.md) |

追赶面收尾段(均 opt-in、不配置零成本),随它追赶面就此完整:

| 包 | 提供什么 | 规范 |
| --- | --- | --- |
| `@oribos/distributed-signals` | 跨实例 signals:包装 core `Signals`——三个 send 原语经共享 PubSub 路由,租约仲裁空闲唤醒;stream 保持本地 | [harness.md](docs/architecture/harness.md) |
| `@oribos/inngest` | 外部 runner:工作流 `start` / `resume` 走 Inngest 触发事件,walker 与快照 store 留在你的进程 | [workflows.md](docs/architecture/workflows.md) |
| `@oribos/observational-memory` | 请求内联压缩:包装 `MemoryStore`——recall 窗口之外的积压在触发它的那次读取里凝成观察块 | [memory.md](docs/architecture/memory.md) |
| `@oribos/background-tasks` | 协调式后台工作:任务行 + manager(领租约、执行、心跳、settle、收养孤儿) | [harness.md](docs/architecture/harness.md) |

## 示例

可运行、自断言的示例在 [`examples/`](examples/)。从仓库根目录:

```bash
pnpm install
pnpm build                  # 示例通过包的 package exports(dist)消费 @oribos/core
OPENAI_API_KEY=sk-... pnpm --filter @oribos/example-minimal-agent start
```

任何 OpenAI 兼容端点都可以,例如本地 Ollama:
`OPENAI_API_KEY=ollama OPENAI_BASE_URL=http://localhost:11434/v1 pnpm --filter … start`

| 示例 | 展示什么 |
| --- | --- |
| [`minimal-agent`](examples/minimal-agent/) | 一个 agent、一个工具、流式输出、组合根、console 追踪 |
| [`memory-chat`](examples/memory-chat/) | 一个 resource 上的两个 thread、消息历史、`recall()`、工作记忆 |
| [`workflow-approval`](examples/workflow-approval/) | `foreach` / `parallel` / `branch`、一个 agent 步骤、suspend → 快照 → resume |
| [`workflow-time-travel`](examples/workflow-time-travel/) | 调试一次已完结的 run:`restart({ step })` 截断记录并从该步重进 |
| [`durable-approval`](examples/durable-approval/) | 审批闸门:工具调用扣在步骤边界、`finishReason: 'suspended'`、`resume({ approved })` 的两种方式 |
| [`signals-desk`](examples/signals-desk/) | 一条 thread:唤醒 / 注入 / 按序排队、带类型的 `sendSignal`、`subscribeToThread`、一次调度 `tick` |
| [`mcp-tools`](examples/mcp-tools/) | 一个工具容器经 MCP 提供服务再桥接回来——HTTP 和 stdio,一个来回 |
| [`sqlite-resume`](examples/sqlite-resume/) | 一次运行在一个进程挂起,快照落进 SQLite,新进程将其恢复 |
| [`ai-chat-route`](examples/ai-chat-route/) | 一条 `useChat` 兼容的聊天路由:流中挂起、应用侧恢复 |
| [`otlp-collector`](examples/otlp-collector/) | 一次被追踪的 agent run,以 GenAI semconv span 落进本地 collector |
| [`cron-schedule`](examples/cron-schedule/) | cron 表达式作为注入的 `next` 片段:保存、occurrence 推进、`tick` 触发 |
| [`agent-supervisor`](examples/agent-supervisor/) | `@oribos/supervisor`:子 agent 即委派工具——显式构造输入、纯文本回喂、同一条 trace |
| [`agent-evals`](examples/agent-evals/) | `@oribos/evals`:scorer 经 Processor 缝接进 live run 逐步打分,整跑结果事后打分 |
| [`signal-webhook`](examples/signal-webhook/) | signal providers 的示例形态:薄 webhook 端点 → `sendSignal`——边缘翻译校验、应用自有登记簿路由 |
| [`background-tasks`](examples/background-tasks/) | background tasks 配方:工具立即 ack、应用自有 worker 后台完工、落地即一次 `sendSignal`——成功与失败同门回告;另含 `@oribos/background-tasks` manager 二期幕(`onSettle` → `sendSignal`、孤儿 adopt 重跑) |
| [`semantic-recall`](examples/semantic-recall/) | `@oribos/rag`:save 落库 hook 逐条索引,语义相关的旧消息被拉回 recall 窗口 |
| [`resumable-stream`](examples/resumable-stream/) | `@oribos/resumable-stream`:客户端中途挂断、带 run id 重连,一个 chunk 不丢 |
| [`model-router`](examples/model-router/) | `@oribos/model-router`:`'provider/model'` 字符串对照随包 vendored 的 models.dev 目录快照路由 |
| [`crash-replay`](examples/crash-replay/) | `@oribos/checkpoints`:run 中途真 `SIGKILL`,新进程从最后完成的步骤重放 |
| [`otel-bridge`](examples/otel-bridge/) | `@oribos/otel-bridge`:agent run 成为宿主 `TracerProvider` 下的真 OpenTelemetry span |
| [`distributed-signals`](examples/distributed-signals/) | `@oribos/distributed-signals`:两个 Node 进程、一条 thread——一端的 `sendSignal` 注入另一端的活跃 run,再唤醒空闲 thread |
| [`inngest`](examples/inngest/) | `@oribos/inngest`:trigger → suspend → resume → 崩溃重试,离线走真实 SDK 通路 |
| [`observational-memory`](examples/observational-memory/) | `@oribos/observational-memory`:离开 recall 窗口的消息内联凝成观察块与反思块 |

## 文档

- [`CONTEXT.md`](CONTEXT.md)——项目术语表:每个领域术语,只定义一次
- [`docs/architecture/`](docs/architecture/README.md)——架构规范,每个子系统一篇
- [`docs/adr/`](docs/adr/)——规范背后的决策
- [`docs/ROADMAP.md`](docs/ROADMAP.md)——里程碑计划、发布节奏与 v1.0 闸门
- [`skills/`](skills/)——面向用 Oribos 做开发的编码智能体的可安装 agent skill

## 开发

```bash
pnpm install
pnpm verify    # typecheck + build + tests + dist / runtime-deps / export-surface 检查
               # (不含字节 / 依赖预算——那些是 CI 闸门,见下)
```

离线示例同样有闸门——与 CI 运行的同一个闸门,排在 `verify` 之后一步:

```bash
pnpm build && pnpm check:examples   # cron-schedule / otlp-collector / mcp-tools(HTTP + stdio)/ workflow-time-travel / agent-supervisor / agent-evals / signal-webhook / background-tasks / semantic-recall / resumable-stream / model-router / crash-replay / otel-bridge / distributed-signals / inngest / observational-memory
```

它串行运行十七个离线条目,流式输出各自的日志,任何一个失败即以非零码退出
(先 `pnpm build`:示例通过包构建后的 exports 消费它们)。

字节预算(每个 export 路径压缩后的大小)在每个 PR 的 CI 中检查——是受检属性,不是口号——
且它是警告,不是合并阻塞项([ADR-0001](docs/adr/0001-lightweight-definition.md))。

## 许可证

[Apache-2.0](LICENSE)
