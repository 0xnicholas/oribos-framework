# 调研:Mastra Harness 线定点重抓(2026-10 快照)

> 快照日:2026-10-11。研究 ticket:#142。
> 来源版本:npm `@mastra/core` **latest = 1.75.0**(2026-10-07 发布)、**alpha = 1.76.0-alpha.7**(2026-10-10);dist-tag `feat-durable-agent-evented-engine` = `0.0.0-feat-durable-agent-evented-engine-20260918205958`(2026-09-18);`mastra-ai/mastra` 源码 main 分支 @ `f4477eb9`(2026-10-11T01:04:18Z);mastra.ai 文档站(2026-10-11 抓取)。
> 旧钉对比基线:[`docs/research/mastra-harness.md`](./mastra-harness.md)(2026-09-28 调研、`@mastra/core@1.72.0-alpha.4`;票据所述旧钉为 2026-10-02 快照、`@mastra/core@1.74.0`)。本文**只定点重抓三点**:supervisor 实装形态、durable evented 引擎现状、background tasks 租约,不做全面重抓。
>
> 定位提醒:只做事实呈现;「Supervisor 能力包」「Background tasks」行是否重开的判定归 #145,不在本文范围。

## TL;DR

1. **Supervisor 实装形态没有新增独立模块 / 工厂函数 / 新协议**——仍是一个普通 `Agent` 挂 `agents:` 字段 + delegation 钩子的 pattern(官方文档原话:"A parent agent that coordinates subagents is often called a supervisor")。真正的大变化在另一侧:**`.network()`(AgentNetwork)被官方迁移文档宣告弃用**,"development now focuses on supervisor agents",supervisor pattern 成为多 agent 协调的唯一推荐路径;delegation 钩子面有若干增量(`threadMetadata`、`enableResultReferences`/`contextFromRefs`、`resultText` 等),但协议本体(委派 = 一条生成的 `agent-<name>` 工具调用)未变。
2. **evented 引擎已进 stable 但默认引擎没换**。dist-tag `feat-durable-agent-evented-engine`(2026-09-18)对应的功能线经 PR #24569(2026-09-25 合入)随 **1.72.0**(2026-09-30)发布:EventedAgent 重新跑在内建 evented workflow 引擎上;`Workflow.engineType` 仍默认 `'default'`,1.72.0 反而把"声明 schedule 即自动切 evented"收窄为仅 `MASTRA_WORKERS` 设置时才切。**注意一个文档先行的未发布能力**:durable 文档页已上线 "Run ownership" 章节(run 级 claim + generation fencing),但对应 changeset 仍在 main 未消费,1.75.0 的 npm 包里没有该代码——预计随 1.76.0(minor)落地。
3. **Background tasks 租约形态不变,无新管理面**。仍是任务行持久化 `ownerId` + `leaseExpiresAt`、CAS 认领、`leaseDurationMs` 默认 30s、心跳 `leaseDurationMs/3`(即旧钉所述 1.72 形态,落地 PR #24841 随 1.72.0 发布);`manager.stream()` SSE 仍是 7 种 chunk + 同组过滤器,仅新增 `includeExisting` 参数。`untilIdle` 的调用入口已统一为 `stream({ untilIdle: true })`——`streamUntilIdle()` / `resumeStreamUntilIdle()` 自 1.46.0 起 deprecated 且 main 上标记仍在,但 supervisor 文档页仍在推荐 `streamUntilIdle()`(文档与源码漂移)。

## 1. Supervisor 实装形态:无独立模块,`.network()` 让位

**没有独立 supervisor 模块 / 工厂函数 / 新协议。** 在 `mastra-ai/mastra` main(`f4477eb9`)`packages/core/src` 全量检索:无 `createSupervisor` / `SupervisorAgent` / `class Supervisor` 符号,无 `supervisor/` 目录;"supervisor" 仅以角色称谓出现在 `agent.types.ts`、`delegation-refs.ts` 等注释与文档字符串中。源码:[`packages/core/src/agent/`](https://github.com/mastra-ai/mastra/tree/main/packages/core/src/agent)。

**Supervisor 的官方形态仍是 pattern**:普通 `Agent` + `agents: { subAgent }` 字段 + delegation 钩子,调用 `stream()`/`generate()`。文档页 [Supervisor agents](https://mastra.ai/docs/agents/supervisor-agents)(页首标注 Added in `@mastra/core@1.8.0`)原话:"A parent agent that coordinates subagents is often called a supervisor. The supervisor pattern is one approach to building multi-agent systems in Mastra."

**最大变化:`.network()` 进入弃用迁移期。** 迁移文档 [Migrate from `.network()` to supervisor agents](https://mastra.ai/reference/migrations/network-to-supervisor) 开篇明示:"**.network() Deprecation:** `.network()` is deprecated and will be removed in a future release. Existing code will continue to work until then, but development now focuses on supervisor agents." 迁移内容 = 把 `.network()` 调用换成 `stream()`/`generate()`(配置不变,仍是 `agents`/`workflows`/`tools`/`memory`),事件从 `network-execution-event-*` 映射到标准 stream chunk。值得注意的粒度:截至 main@`f4477eb9`,源码侧 `Agent.network()`([agent.ts](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/agent/agent.ts) 约 8659 行)**尚无 `@deprecated` 标记**——弃用目前是文档/路线图级,源码未打标。

**delegation 钩子面的增量(按落地版本)**:

| 增量 | 版本 | 来源 |
|---|---|---|
| `delegation.enableResultReferences`:子 agent 结果带 `[ref: <id>]`,后续委派工具获得 `contextFromRefs` 输入可原样引用先前结果(默认关) | 1.67.0(旧钉前已存在,旧钉未列) | [PR #22940](https://github.com/mastra-ai/mastra/pull/22940);源码 [`agent/delegation-refs.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/agent/delegation-refs.ts) |
| 失败委派不再以空成功结果返回:`onDelegationComplete` 收 `success: false`,failure hook 的 `resultText` 可替换 supervisor 看到的错误文本 | 1.68.0(旧钉前) | [PR #23420](https://github.com/mastra-ai/mastra/pull/23420) |
| `messageFilter` / `onDelegationStart` 的 messages 类型修正为 AI SDK `ModelMessage[]`(此前错标为库存储消息,读 `content.parts`/`id` 的过滤器会静默漏放父上下文) | **1.75.0(旧钉后)** | [PR #26161](https://github.com/mastra-ai/mastra/pull/26161),fixes [#25983](https://github.com/mastra-ai/mastra/issues/25983) |
| `onDelegationStart` 返回值新增 `threadMetadata`(委派子线程带租户等元数据,可被 metadata 过滤查询找到) | **1.76.0-alpha.6(旧钉后,未进 stable)** | [PR #25200](https://github.com/mastra-ai/mastra/pull/25200)(2026-10-10 合入) |
| `includeSubAgentToolResultsInModelContext`(默认只把子 agent 文本送回 supervisor 模型上下文,嵌套工具结果留在工具结果 payload 供 UI 查) | 旧钉前已存在 | 源码 [`agent/agent.types.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/agent/agent.types.ts) 约 368 行 |
| Subagent versioning:editor 存储域版本 + 每次调用 `versions: { agents: { 'research-agent': { status: 'published' } } }` 覆盖,随委派链传播 | editor 体系 | [Supervisor agents 文档](https://mastra.ai/docs/agents/supervisor-agents) "Subagent versioning" 节 |

**协议本体未变**:委派仍是一条生成的 `agent-<name>` 工具调用——[durable agents 文档](https://mastra.ai/docs/harness/durable-agents)恢复警告原话:"A sub-agent delegation is one generated `agent-<name>` tool call"。背景化委派沿用 background tasks 通道(supervisor 侧 `backgroundTasks.tools` 按子 agent opt-in,或继承子 agent 自身配置;嵌套背景委派限一层)。

## 2. Durable 线:evented 引擎已进 stable(1.72.0),默认引擎未换;Run ownership 文档先行、代码未发布

**dist-tag 对应物**:npm `dist-tags["feat-durable-agent-evented-engine"]` = `0.0.0-feat-durable-agent-evented-engine-20260918205958`(发布时间 2026-09-18T21:08Z),次日跟随 `fix-durable-evented-local-only` = `0.0.0-...-20260919001610`(2026-09-19)。来源:[npm registry `@mastra/core`](https://www.npmjs.com/package/@mastra/core?activeTab=versions)(`npm view @mastra/core dist-tags time`)。实测该快照 tarball(3249 个文件):`dist/agent/durable/` 含 `createEventedAgent`,dist 含 `workflow-event-processor` chunk(`workflow.step.run` 事件机制)——确为 evented 引擎预览构建;其中**不含** `DURABLE_AGENT_RUN_ACTIVE` 等 run-ownership 标记(该能力更晚,见下)。

**实装现状(进 stable 的路径)**:该功能线经 [PR #24569](https://github.com/mastra-ai/mastra/pull/24569)(分支 `unified-agent-loop`,"re-enable the evented workflow engine on the durable agent loop and refactor the agent loop structure",2026-09-25 合入)落地,随 **1.72.0**(2026-09-30 发布)进 stable。CHANGELOG 1.72.0 原话:"EventedAgent runs on the built-in evented workflow engine again. It previously fell back to the default in-process engine because the evented path crashed on resume and recovery… now covered by the durable-agent conformance suite — including crash recovery"。即 dist-tag 预览 → 一周内合入 main → 1.72.0 转正。

**默认引擎没换**(三层证据):

- 源码 main:`Workflow.engineType: WorkflowEngineType = 'default'`([`workflows/workflow.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/workflows/workflow.ts) 1833/1938 行)。
- 1.72.0 起"声明 `schedule` 即切 evented"的旧行为被**收窄**:仅当设置 `MASTRA_WORKERS` 环境变量(split-worker 部署)时调度型 workflow 才跑 evented 引擎;dev/单进程/serverless 保持默认引擎([PR #25430](https://github.com/mastra-ai/mastra/pull/25430),fixes #18807)。显式 opt-in 路径是 `import { createWorkflow } from '@mastra/core/workflows/evented'`([`workflows/create.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/workflows/create.ts) 63 行警告文案)。
- durable 侧三工厂格局与旧钉一致:`createDurableAgent()`(默认引擎、进程内)/ `createEventedAgent()`(内建 evented 引擎、fire-and-forget)/ `createInngestAgent()`(`@mastra/inngest`),见 [`agent/durable/index.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/agent/durable/index.ts) 模块注释与[文档 Execution variants 表](https://mastra.ai/docs/harness/durable-agents);`DurableAgent.workflowEngine` 默认 `'default'`,`EventedAgent` 子类覆盖为 `'evented'`([durable-agent.ts](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/agent/durable/durable-agent.ts) 约 1964-1967 行)。

**配套运行时**:`packages/core/src/worker/`(main 新增目录)导出 `MastraWorker` / `OrchestrationWorker` / `SchedulerWorker` / `BackgroundTaskWorker`、`InProcessStrategy` / `HttpRemoteStrategy`、`PullTransport`——即 evented 引擎的 split-worker 部署运行时(`MASTRA_WORKERS` 控制)。源码:[`packages/core/src/worker/`](https://github.com/mastra-ai/mastra/tree/main/packages/core/src/worker)。

**⚠️ 文档先行、代码未发布:Run ownership**。[durable agents 文档](https://mastra.ai/docs/harness/durable-agents)已上线 "Run ownership" 章节:每次 `stream()/generate()/resume()/recover()` 先认领 run,每 10s 续期、死后约 30s 失效;支持 run fencing 的存储(目前仅 `InMemoryStore`)把每次写与 claim 同操作校验,失权执行的写入被拒;`recover()` 对活 run 抛 `DURABLE_AGENT_RUN_ACTIVE`、`force: true` 夺权、同进程执行中抛 `DURABLE_AGENT_RECOVER_RUN_ACTIVE_LOCALLY`;`mastra.shutdown()` 释放 claim 使下次启动立即可恢复。**但该能力不在任何已发布版本中**:对应 `.changeset/durable-run-ownership.md`(`@mastra/core`: **minor**,fixes [#23734](https://github.com/mastra-ai/mastra/issues/23734))仍挂在 main 未消费;实证 `@mastra/core@1.75.0` 的 npm tarball dist 中检索不到 `DURABLE_AGENT_RUN_ACTIVE` / `mastra_workflow_run_owners` / `ExecutionFence`。预计随 1.76.0 落地(当前 alpha 线 1.76.0-alpha.7 的 CHANGELOG 亦无此条目)。mastra 文档站跟随 main 构建,因此文档描述领先于 latest 包。

**内部设计文档成文**:main 上 [`agent/durable/leases.md`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/agent/durable/leases.md) 把 5 种租约列成一张表(Run ownership / Thread lease / Thread claim lease / Evented step fence / Background task lease,各自 key、owner、TTL/续期、失权行为),另有 `run-recovery.md`。这是观察 mastra 分布式语义最直接的单一来源。

**1.75.0 的 durable 相关条目均为修复**,代表性的:并发 durable run 串话(同 agent 并发 run 的首快照互串、恢复错跑他人会话)与快照瘦身(transcript 每快照只存一次,12 轮工具调用 run 持久化体积默认引擎 −31%、evented 引擎 −63%)([PR #26221](https://github.com/mastra-ai/mastra/pull/26221));evented 引擎崩溃重启后 `setState` 丢失修复(同 PR);`recover()` 丢工具修复([PR #26535](https://github.com/mastra-ai/mastra/pull/26535)、[#26592](https://github.com/mastra-ai/mastra/pull/26592),1.76.0-alpha 线)。

## 3. Background tasks 租约:形态不变,入口统一到 `stream({ untilIdle })`

**租约形态与旧钉一致**(源码 main [`background-tasks/manager.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/background-tasks/manager.ts) 实证):

- 任务行持久化 `ownerId` + `leaseExpiresAt`;`leaseDurationMs` 默认 30s、下限 3s(manager.ts:111-127);单心跳循环每 `max(1s, leaseDurationMs/3)` 续租全部持有租约。
- 认领/续租走 CAS:`updateTask(taskId, …, { expectedStatus, expectedOwnerId, expectedLeaseExpiresAt })`(manager.ts:1229-1237);失权 worker 的结果写不回。
- 落地版本即旧钉所述"1.72 起":[PR #24841](https://github.com/mastra-ai/mastra/pull/24841)("Fence background task execution with a persisted ownership lease",2026-09-25 合入,随 1.72.0 发布)。CHANGELOG 提醒:条件写仅在理解它们的存储 adapter 上强制,旧 adapter 退化为无防护——升级 `@mastra/core` 需同步升级存储包。
- 时钟语义(main 新增成文):[`leases.md`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/agent/durable/leases.md) "Background task lease" 节明示过期用 **worker 本地时钟**计算与比较(区别于 run ownership 用存储时钟),worker 间时钟偏移会移动过期判定点。
- 单机多进程:`UnixSocketPubSub` 可协调同主机多 manager(manager-unix-socket.test.ts;`UnixSocketPubSub` 实现 `LeaseProvider`)。

**无新 SSE 管理面**:`manager.stream()` 仍返回 7 种 manager chunk(running/output/completed/failed/cancelled/suspended/resumed),过滤器仍是 `agentId/runId/threadId/resourceId/taskId/abortSignal`(manager.ts:752-762;[文档 Streaming 节](https://mastra.ai/docs/harness/background-tasks))。唯一新增参数 `includeExisting`(默认 true):连接时先快照当前在跑任务再转发实时事件。

**untilIdle 入口变化**(对旧钉"untilIdle"表述的修正):

- `agent.streamUntilIdle()` / `resumeStreamUntilIdle()` 自 **1.46.0** 起 deprecated,统一入口为 `stream({ untilIdle: true })` / `resumeStream(..., { untilIdle })`([PR #17536](https://github.com/mastra-ai/mastra/pull/17536));durable 侧同步合并(`DurableAgent.stream({ untilIdle })`,[PR #18349](https://github.com/mastra-ai/mastra/pull/18349))。截至 main@`f4477eb9`,`@deprecated` 标记仍在(agent.ts:9769、9855),方法本体保留且委托给 `stream({ untilIdle })`。
- **文档漂移**:2026-10-11 抓取的 [Supervisor agents 文档](https://mastra.ai/docs/agents/supervisor-agents) "Running subagents in the background" 节仍推荐 `streamUntilIdle()`("Use `streamUntilIdle()` instead of `stream()`"),与源码弃用状态相反;[Background tasks 文档](https://mastra.ai/docs/harness/background-tasks)已是 `stream({ untilIdle: true })` 口径。
- 语义不变:初始轮 + 任务完成触发的 continuation 轮走同一条 `fullStream`;聚合属性(`text`/`toolCalls`/`finishReason` 等)仍只结算**第一轮**,跨轮聚合需自行消费 `fullStream`;`maxIdleMs` 默认 5 分钟。
- 1.75.0 修复:[PR #25661](https://github.com/mastra-ai/mastra/pull/25661)(untilIdle 续轮重复输出;传入 `runId` 可用 `abortRunStream(runId)`/`abortThreadStream()` 中止初始或续轮)、[PR #26125](https://github.com/mastra-ai/mastra/pull/26125)(`defaultOptions` 里设 `untilIdle` 导致无限等待 OOM,fixes #26043)、[PR #26344](https://github.com/mastra-ai/mastra/pull/26344)(plain agent 的 awaited background 结果重复发射)。

## 4. 旧钉对比一览

| 旧钉(2026-10-02,`@mastra/core@1.74.0`) | 2026-10-11 现状 |
|---|---|
| supervisor = `agents:` 字段 + delegation 钩子(onDelegationStart/Complete、messageFilter、memory 隔离) | **形态不变,无独立模块/工厂/新协议**;`.network()` 文档级弃用、迁移指南上线(源码未打 `@deprecated`);钩子面增量:`threadMetadata`(1.76.0-alpha.6)、`ModelMessage[]` 类型修正(1.75.0)、`enableResultReferences`/`contextFromRefs`(1.67.0)、失败委派 `resultText`(1.68.0) |
| durable 三工厂(createDurableAgent / createEventedAgent / createInngestAgent) | 不变;evented 引擎预览(dist-tag 2026-09-18)已经 PR #24569 随 **1.72.0** 转正;**默认引擎仍 `'default'`**,schedule 自动切 evented 收窄为 `MASTRA_WORKERS` 门控(1.72.0);新增 split-worker 运行时 `packages/core/src/worker/`;**Run ownership(fencing)文档已上线但代码未发布**(1.76.0 minor changeset 待消费) |
| 后台任务 = manager + 持久化所有权租约(1.72 起)+ 心跳 + untilIdle + SSE 管理流 | **全部不变**;SSE 管理流仅增 `includeExisting`;`untilIdle` 入口统一为 `stream({ untilIdle })`(`streamUntilIdle()` 自 1.46.0 deprecated 至今);1.75.0 三个 untilIdle/background 修复 |
| Harness 文档 7 项能力 + createCodingAgent()、6 项 Beta | 结构不变:Harness 栏目仍 overview + 7 页(Durable Agents / Background Tasks / Goals / Schedules / Signals / Signal Providers / Agent Controller)([llms.txt](https://mastra.ai/llms.txt));`createCodingAgent` 仍在 [`packages/core/src/coding-agent/`](https://github.com/mastra-ai/mastra/tree/main/packages/core/src/coding-agent) |

## 5. 来源清单

npm registry(2026-10-11 查询,`npm view @mastra/core dist-tags / time`):
- [`@mastra/core` versions](https://www.npmjs.com/package/@mastra/core?activeTab=versions):latest `1.75.0`(2026-10-07T08:53Z)、alpha `1.76.0-alpha.7`(2026-10-10T16:22Z)、`1.74.0`(2026-10-01,旧钉)、`1.72.0`(2026-09-30);dist-tag `feat-durable-agent-evented-engine` = `0.0.0-feat-durable-agent-evented-engine-20260918205958`(2026-09-18T21:08Z)、`fix-durable-evented-local-only` = `0.0.0-...-20260919001610`(2026-09-19)。两个 tarball 均实测:`0.0.0-feat-...` 含 evented 引擎预览;`1.75.0` 不含 run-ownership 代码。

文档(2026-10-11 抓取):
- [Supervisor agents](https://mastra.ai/docs/agents/supervisor-agents)(Added in `@mastra/core@1.8.0`) · [Migrate from `.network()` to supervisor agents](https://mastra.ai/reference/migrations/network-to-supervisor)(`.network()` 弃用声明) · [Durable agents](https://mastra.ai/docs/harness/durable-agents)(Execution variants / Crash recovery / Run ownership) · [Background tasks](https://mastra.ai/docs/harness/background-tasks)(manager stream / untilIdle) · [llms.txt](https://mastra.ai/llms.txt)(Harness 栏目结构)

源码(`mastra-ai/mastra` main @ `f4477eb9`,2026-10-11):
- [`packages/core/src/agent/`](https://github.com/mastra-ai/mastra/tree/main/packages/core/src/agent)(无 supervisor 模块;`delegation-refs.ts`、`agent.types.ts`) · [`agent/agent.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/agent/agent.ts)(`network()` 约 8659 行无 `@deprecated`;`streamUntilIdle` 9769 行有 `@deprecated`)
- [`agent/durable/index.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/agent/durable/index.ts)(三工厂) · [`agent/durable/durable-agent.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/agent/durable/durable-agent.ts)(`workflowEngine` 默认 `'default'`) · [`agent/durable/leases.md`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/agent/durable/leases.md)(5 租约表) · [`.changeset/durable-run-ownership.md`](https://github.com/mastra-ai/mastra/blob/main/.changeset/durable-run-ownership.md)(未发布 minor)
- [`workflows/workflow.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/workflows/workflow.ts)(`engineType = 'default'`) · [`workflows/create.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/workflows/create.ts)(`MASTRA_WORKERS` 门控警告) · [`packages/core/src/worker/`](https://github.com/mastra-ai/mastra/tree/main/packages/core/src/worker)
- [`background-tasks/manager.ts`](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/background-tasks/manager.ts)(租约 111-127 / CAS 1229-1237 / `stream()` 752-762)
- [`packages/core/CHANGELOG.md`](https://github.com/mastra-ai/mastra/blob/main/packages/core/CHANGELOG.md)(1.46.0 / 1.67.0 / 1.68.0 / 1.72.0 / 1.75.0 / 1.76.0-alpha.x 各节)

PR / issue:
- [#24569](https://github.com/mastra-ai/mastra/pull/24569)(evented 引擎重回 durable loop,1.72.0) · [#25430](https://github.com/mastra-ai/mastra/pull/25430)(schedule→evented 收窄为 MASTRA_WORKERS,1.72.0) · [#24841](https://github.com/mastra-ai/mastra/pull/24841)(background 租约 fencing,1.72.0) · [#23734](https://github.com/mastra-ai/mastra/issues/23734)(run ownership 要修的双执行写冲突) · [#22940](https://github.com/mastra-ai/mastra/pull/22940)(enableResultReferences,1.67.0) · [#23420](https://github.com/mastra-ai/mastra/pull/23420)(失败委派 error result + resultText,1.68.0) · [#26161](https://github.com/mastra-ai/mastra/pull/26161)(delegation 消息类型修正,1.75.0) · [#25200](https://github.com/mastra-ai/mastra/pull/25200)(onDelegationStart threadMetadata,1.76.0-alpha.6) · [#17536](https://github.com/mastra-ai/mastra/pull/17536)(untilIdle 统一 + streamUntilIdle deprecated,1.46.0) · [#18349](https://github.com/mastra-ai/mastra/pull/18349)(DurableAgent.stream untilIdle) · [#25661](https://github.com/mastra-ai/mastra/pull/25661) / [#26125](https://github.com/mastra-ai/mastra/pull/26125) / [#26344](https://github.com/mastra-ai/mastra/pull/26344)(1.75.0 untilIdle/background 修复) · [#26221](https://github.com/mastra-ai/mastra/pull/26221)(并发串话 + 快照瘦身,1.75.0)
