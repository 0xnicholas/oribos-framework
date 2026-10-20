# Harness 语义集

> 来源:wayfinder ticket #18(决策:Harness 语义集)。本文件是 Harness(持久执行与后台能力)的架构规范。
> 决策记录见 `docs/adr/0011-harness-semantics.md`;术语见 `CONTEXT.md`。

## 定位

Harness 是**文档分类**,不是统一模块:一组把 agent 从「请求-响应调用」升级为「长期在线协作者」的独立小能力的总称。不存在 Harness 类/实例——mastra 源码里 `Harness` 已只是 `AgentController` 的废弃别名,「Harness」在其文档侧也仅是分类名(调研 #17);各能力独立工厂、独立可用,按需组合。轻量落法:mastra 侧 7 项能力 6 项 Beta,重量集中在三个底层原语(存储域、PubSub+租约、长驻 worker 循环);本规范只收三件套最小集——**durable 挂起/恢复、基础 signals、schedules tick 原语**——核心零依赖、零新存储域(快照与调度记录走既有 port 集合模式,见 `docs/architecture/storage.md`)。

运行时立场(ADR-0001 的具体化):核心永远不要求长驻进程。进程内便利件(内存 pubsub、ticker)显式标注「单进程语义」;serverless/edge 路径(平台 cron 打 endpoint)是**一等形态**而非降级;跨实例能力(共享 PubSub、执行租约、leader election)整体归能力包,不进核心。

wrapper 不可组合(编译期):`createDurableAgent` / `createSignals` 的配置字段 `agent` 类型为 `Agent` 类,wrapper 产物(`DurableAgent` / `Signals`)结构上不满足它——互相嵌套在编译期即被拒绝,不存在「durable 包 signals」或反向的写法。组合器属假想缝,本规范不为它留扩展点;若未来要支持嵌套,须先改配置字段类型并另立决策。

## Durable agents(审批挂起/恢复)

```ts
const durable = createDurableAgent({ agent, storage?, approval? })
const out = durable.stream(input, options)          // 与 agent.stream 同形
// out.finishReason === 'suspended' 时,out.suspendPayload 可用
await durable.resume(runId, { approved: true })     // 恢复
```

- **审批闸**:模型返回 tool-calls 后、执行前,若工具命中 `approval: { tools: [...] }` 清单 → run 挂起:loop 快照(消息列表 + step 计数 + 挂起点 + suspendPayload + traceId)写 port,`finishReason: 'suspended'`。审批声明在 durable 层——Tool 四字段定义不动(#13 核心零权限)。
- **resume 语义**:`approved: true` → 执行该工具继续 loop;`approved: false` → 以「用户拒绝」工具结果**回喂模型**继续(与工具错误回喂同构),不终止 run。
- **共享 continuation 骨架(#202)**:`resume` 不再手写 load → seed → trace → drain → materialize;core 公开的 `@oribos/core/agent-run` 提供 `continueRun(start, continuation, options)`:从纯 `RunContinuation` 记录(messages / stepCount / toolCalls / answers? / traceId?)构造 input、resume seed 与 traceId,调用包装器提供的 `start`,排空输出并物化终值,返回 `{ output, result }`;返回的 `output` 已 settle,包装器从它读取自己的 `suspendPayload`。resume 锁 = 同入口公开的 `createResumeLock`(每子系统一份注册表,(store, runId) join-in-flight、settle 即删)。该子路径是能力包 / 高级集成用稳定小表面(ADR-0018),不是日常 Agent 入口;Run 终态构造器仍居 core 内部(ADR-0019)。`@oribos/checkpoints` 的 `recover` / `recoverAll` 也走同一骨架(#203):load Checkpoint → 映射 `RunContinuation` → `continueRun`,恢复锁改用 `createResumeLock`,包内不再有本地 continuation / recovery lock / `materialize` 副本;重放、终态清除与 trace 续接行为不变。
- **挂起语义默认只在 durable 包装内存在**:裸 agent 无快照、**不传 `stepBoundary` seam 时**不产生 `'suspended'`(该 seam 是公开 run option,显式传入即得同一挂起语义),核心 agent loop 本体不变。Harness 持有 agent,不是反之(ADR-0005 砍单表)。
- **挂起终态值与结构化输出**:挂起是正常终态——已完成 Step 的 text / steps / toolCalls / toolResults / usage 保留(第 0 步挂起即空值),`object` 为 `undefined`;`structuredOutput` 只在完成时严格校验,挂起不抛 `StructuredOutputError`,`suspendPayload` 与 Snapshot 形状不变。resume 后的完成段照常校验并落 `object`;裸 Agent 经公开 `stepBoundary` 的挂起与 Durable 同一语义(ADR-0019)。
- **裁单**:崩溃自动恢复(每步 running 检查点 + 重放)、resumable stream 事件缓存、`observe()`、多副本恢复与 leader election、boot 时 recoverAll、工具 `execute` 内 `suspend()`(通用挂起,background tasks 的机器)——以上仍不在核心;经 ADR-0017 重判(2026-10-11)多数**转追赶项**(CUT-H1 / CUT-H5 行),resumable stream 分件**已兑现** = `@oribos/resumable-stream` 能力包(2026-10-14,#184,见 CUT-H1 行)。「列出待审批 run」归 adapter 可选扩展(下节)。

### AgentRunSnapshotStore

```ts
interface AgentRunSnapshotStore {
  load(runId: string): Promise<AgentRunSnapshot | null>
  save(runId: string, snapshot: AgentRunSnapshot): Promise<void>
}
// AgentRunSnapshot = { runId, status: 'suspended', messages, stepCount, suspendPayload, traceId? } JSON-only
```

与 `WorkflowSnapshotStore` 同构:基础形状冻结、JSON-only、内存默认实现进核心、统一 adapter 家族。可选扩展按能力标志模式:`deleteSnapshot(runId)`、`listSuspended(q?)`(待审批列表),缺席即无枚举能力;签名与枚举排序 / 游标口径单点在 `docs/architecture/storage.md`(SQLite 参考 adapter 节)。无 CAS——durable 不做多副本恢复,跨进程安全归部署方。

## Signals(基础层)

```ts
const signals = createSignals({ agent, memory?, tracer? })  // tracer = 注入事件落 isEvent span 的缝(组合根分发,见「Observability 锚点」)
signals.stream(input, options?)                     // agent run 入口:per-call memory 身份注册 thread(调用即注册,run 仍懒启动);无身份直通不注册;同 thread 活跃 run 唯一
signals.generate(input, options?)                   // stream + await 终值,同 agent.generate
signals.sendMessage({ thread, resource }, input)    // 活跃=注入当前 run;空闲=唤醒新 run
signals.queueMessage({ thread, resource }, input)   // 等当前 run 完再开(保序)
signals.sendSignal({ thread, resource }, { type, ... })  // 系统信号注入,type 开放
signals.subscribeToThread({ thread, resource })     // 订阅该 thread 活跃 run 的 chunk 流
```

- **语义固定三句**,mastra 的 `ifActive`/`ifIdle` 分支行为矩阵裁掉:活跃 = 注入当前 run(下一 step 生效);空闲 = 唤醒新 run;queueMessage = 排队保序。
- **零新存储**:唤醒/注入内容落为消息历史的普通消息(复用 `MemoryStore`);排队队列进程内,进程死 = 丢(文档化语义)。`memory` 缺席时唤醒 = 无历史新 run(文档化)。
- **运行时**:进程内内存 pubsub + 「thread → 活跃 run」注册表,单进程语义;跨实例(共享 PubSub + 租约)归能力包——经 ADR-0017 重判(2026-10-11,#161)**转追赶项**(opt-in 能力包 + 外部 Redis,不装不配零成本;核心单进程语义不变;延后清单「跨实例 signals」行)。
- **agent loop 唯一改动**:每个 step 边界检查注入队列;无 signals 挂接时零开销(无运行时负担)。
- **裁单**:state signals(命名状态车道 + diff/merge)——重判(#161)**维持分叉、理由改写**(前置 thread 状态域未建,见 CUT-H2 行);notification inbox(持久化收件箱 + 投递策略)——重判(#160)**维持裁出、理由改写**(`sendSignal({ type: 'notification' })` 即时注入覆盖主场景,见 CUT-H3 行);signal providers(webhook/poll 入口)——重判(#160)**转追赶项(示例形态)**,仍不进规范,以示例 + 配方承载(CUT-H4 行)。

### 跨实例 signals 能力包(`@oribos/distributed-signals`)

基础 signals 单进程语义(上节)不动;跨实例路由 = 包装式能力包:`createDistributedSignals({ signals, pubsub, lease, channelPrefix?, heartbeatMs? })` 包住核心造出的 `Signals`——核心零改动、无注入缝。表面冻结(2026-10-14,#187):

```ts
const signals = createSignals({ agent, memory?, tracer? })
const distributed = createDistributedSignals({ signals, pubsub, lease })
distributed.stream / generate   // 永远本地,直达内核
distributed.sendMessage / queueMessage / sendSignal
                                // 跨实例:活跃 run 在本实例 = 本地注入;在别实例 = 发布到该 thread 频道
                                // 全实例空闲 = 订阅方抢租约,赢家本地唤醒新 run
distributed.subscribeToThread   // 仅本实例 run(跨实例 chunk 实时跟随 v1 显式拒绝,RunNotLiveError 同口径)
```

- **PubSub port**(at-most-once,回调式):`publish(topic, payload: string)` / `subscribe(topics, handler): Promise<Unsubscribe>`;`createInMemoryPubSub()` 零依赖默认,`createRedisPubSub(client)` 走 `subscribe` / `publish` 结构子集(客户端随调用方)。每 thread 一个频道 `<prefix>oribos:signals:<threadId>`,信封 JSON-only:`{ kind: 'message' | 'signal' | 'queue', thread, resource, payload, traceparent? }`;广播冗余由租约收敛。
- **租约 port**:`acquire(key, ttlMs): Promise<LeaseHandle | null>`,`LeaseHandle = { token, renew(ttlMs): Promise<boolean>, release(): Promise<void> }`;`createInMemoryLeaseStore()` 默认,`createRedisLease(client)` 走 `set(NX/PX)` / `eval` 结构子集。**租约 = thread 活跃 run 所有权**(本地 run 开始即持、settle 即释放),即 `storage.md` CUT-ST3 裁出的那个「lease」概念——不进核心 port 清单(port v1 四个冻结);配置必填(唤醒竞态的裁定者);BT 二期 manager/lease(#190)结构性复用形状、零依赖边(ADR-0002 M5)。
- **投递语义**:at-most-once——进程死在途即丢,与核心「进程死 = 丢」同构(丢失域从单进程扩到消息在途);at-least-once 不做,沿能力标志留 ack 后门。跨实例保序 = best-effort FIFO(同 thread 单频道天然有序,无序列号)。
- **心跳**:租约持有期间包内 interval 续约(`heartbeatMs` 可配;关闭则退回 step 边界续约 + 注入前 token 自检,过期窗口文档化);未配置包 = 零定时器(ADR-0017 轴级判词:opt-in 后台工作 ≠ 运行时负担)。
- **trace 延续**:信封携 traceparent,接收实例把注入事件挂自己 run 的 span 下、以 remote parent 链发送方;解析失败降级独立 span,不新增失败面。
- **验证面**:fake(内存实现即 fake)单测离线进 verify(ADR-0015);`examples/distributed-signals` 双进程 example(进程 A stream 持有 thread、进程 B sendSignal → A 注入;空闲唤醒一幕)进 `check:examples` 闸门。
- **依赖**:零外部依赖(Redis 客户端随调用方,沿 `resumable-stream` 结构子集先例);`@oribos/core` peer(ADR-0002 M5);版本 0.0.0 随发布票 bump。

### 后台任务能力包(`@oribos/background-tasks`)

一期「工具 ack + `sendSignal` 唤醒」配方(CUT-H5,#178)零负担照旧;二期 = 任务协调台账 + 执行:`createBackgroundTasks({ store?, lease?, heartbeatMs?, onSettle? })`——包收 handler 并驱动执行(opt-in 进程内,ADR-0017 判词:提交 → 领租约 → 进程内调 handler → 心跳续约 → settle)。核心零改动、无注入缝。表面冻结(2026-10-14,#190):

```ts
const tasks = createBackgroundTasks({ store?, lease?, heartbeatMs?, onSettle? })
tasks.submit({ payload, run })   // 落行 accepted → 领租约 → running → 进程内调 run(handler)
                                 // settle:done | failed 写回 + 租约释放 + onSettle(record) 交应用
tasks.get(id) / tasks.list()     // 行读
tasks.adopt()                    // 孤儿扫描(租约过期仍 running)→ attempt+1 重跑(幂等成本显式)
tasks.untilIdle()                // 全部任务 settle 即 resolve(包级 API,不改 agent 流)
```

- **任务行与状态机**:`TaskRecord = { id, status: 'accepted' | 'running' | 'done' | 'failed', payload, result?, error?, attempt, createdAt, settledAt? }`(JSON-only);孤儿 = 租约过期仍 `running`;重跑 = at-least-once、handler 幂等归应用(沿 checkpoints `recover` 口径);`attempt` 计数是重跑的可见面。
- **TaskStore port**(包自有,JSON-only):`save / get / list / delete` 四方法家族(checkpoints store 先例);`createInMemoryTaskStore()` 默认,持久实现归部署方。
- **租约 port**:与 `@oribos/distributed-signals`(#187)冻结形状**结构性同形**——`acquire(key, ttlMs) → LeaseHandle | null`,`LeaseHandle = { token, renew(ttlMs), release() }`;租约概念两域合一(CUT-ST3 裁出的那一个)、本包声明同形接口、零依赖边(ADR-0002 M5)。**可选**、缺省装配包内 `createInMemoryLeaseStore()`(内存默认零负担;多实例显式换 `createRedisLease(client)` 结构子集,客户端随调用方);租约 key = 任务行,领到才执行、竞争失败方不作为。
- **心跳**:`heartbeatMs` 可配——handler 执行期间 interval 续约,租约过期窗口文档化;不配置 = 零定时器(ADR-0017 轴级判词)。
- **与 signals 解耦**:包不 import core;settle 经 `onSettle(record)` 回调交应用,一期 `sendSignal`(`report-completed` / `report-failed`)配方原样作为组合面。对 core 无 peer(类型自含,croner 先例;`@oribos/core` 仅 devDep)。
- **v1 显式拒绝**:重试 / backoff 策略(部署方)、优先级与并发度控制、常驻 worker / 跨进程执行 handler、结果结构化存储超出 JSON payload、与 cron / schedules 的任何重叠(归 `ScheduleStore` + `@oribos/croner`)。
- **验证面**:fake(内存实现即 fake)单测离线进 verify(ADR-0015);`examples/background-tasks` 一期三幕配方原样保留作对照 + 扩二期幕(onSettle → `sendSignal` 唤醒、adopt 重跑一幕)进 `check:examples` 闸门。
- **依赖**:零外部依赖(Redis 客户端随调用方,结构子集先例同上);版本 0.0.0 随发布票 bump。
- **已落地**(2026-10-15,[#197](https://github.com/0xnicholas/oribos-framework/issues/197)):`@oribos/background-tasks` 兑现冻结表面——单测 26 例进 verify(提交 → 执行 → settle 时序 / 竞争失败方不作为 / 心跳续约与 TTL = 3 × heartbeatMs / 孤儿 adopt attempt 计数 / `untilIdle` / `onSettle` / 内存 store);`examples/background-tasks` 扩至五幕(一期三幕原样对照 + manager 驱动 `onSettle` → `sendSignal` 一幕 + 孤儿 adopt 重跑一幕)进 `check:examples` 闸门。实施澄清(冻结面内收紧):无心跳 TTL 固定 30s(过期窗口文档化);`adopt()` 重跑以进程内已知 handler 为限(handler 由 `submit` 登记;重启进程对旧孤儿行只扫描、不执行——跨进程执行 handler 即 v1 显式拒绝项);`untilIdle()` 按行(任务)释放——同一行重跑的结算即覆盖死尝试的占位。

## Schedules(最小集)

```ts
const schedules = createSchedules({ storage?, agents, signals? })
schedules.save({
  id?, next: (from: Date) => Date | null,           // cron 解析 = 注入函数,核心零依赖
  target, timezone?, enabled?, metadata?,
})
await schedules.tick({ now? })                      // listDue → 逐个触发并推进 nextFireAt
schedules.startTicker({ intervalMs })               // 可选进程内便利件,单进程语义
```

- **save 校验**:`save` 以当前时刻调一次 `next(from)` 重锚 `nextFireAt`;返回 Invalid Date 显式报错(`null` = 不再触发)。

- **target 两形态**:threadless = `agent.generate(input)`;threaded = `sendSignal` 注入(复用基础 signals,要求 thread + resource)。
- **平台 cron 一等形态**:Cloudflare Cron Triggers / Vercel Cron 打暴露 `tick` 的 HTTP endpoint;mastra 式轮询调度器 + 存储 CAS 认领**不做**(多实例安全交平台 cron 的恰好一次语义或部署方)。
- cron 字符串解析不进核心(零依赖红线);能力包封装 croner 提供 `next` helper(包面/错误面/预算见本节「croner 封装能力包」)。
- **裁单**:触发记录(trigger history / runId 关联)——observability 的 span 已覆盖追责。

### ScheduleStore

```ts
interface ScheduleStore {
  save(schedule: ScheduleRecord): Promise<void>     // upsert
  get(id: string): Promise<ScheduleRecord | null>
  list(q?: { limit?: number; before?: string }): Promise<ScheduleRecord[]>
  delete(id: string): Promise<void>
  listDue(now: Date): Promise<ScheduleRecord[]>
}
```

内存默认实现进核心;统一 adapter 家族,additive-only 演化纪律同其余 port。

### croner 封装能力包(`@oribos/croner`)

核心零依赖、cron 解析不进核心(上节),`next` 由宿主构建注入;本能力包把 croner 封装为 save 输入片段——单工厂,无 facade 包装,不 re-export croner。

```ts
import { cron } from '@oribos/croner'

schedules.save({
  id: 'daily-report',
  ...cron('0 9 * * *', { timezone: 'Asia/Shanghai' }),
  target: { agent: 'reporter', input: 'write the daily report' },
})
```

- **包面**:`cron(expression, options?) → { next: (from: Date) => Date | null; timezone?: string }`——结构上即 `ScheduleSaveInput` 的 `next` + `timezone` 子集(展开或解构皆可;`timezone` 缺席时返回对象不含该键)。`options` 仅 `{ timezone?: string }`,子集封闭:croner 其余构造选项(startAt / stopAt / utcOffset / mode / domAndDow 等)不透出——钳制类需求可解构 `next` 自行包层,解析类需求按重开条件再议。表达式语法即 croner 全量(5/6/7 段、6 段秒在前、`@daily` 类昵称)。
- **校验与错误面**:构建即全部校验——表达式结构/数值错误由 croner 构造期同步抛出(`TypeError`/`RangeError`),非法 IANA 时区由构建期探针(构造后以当前时刻调用一次 `nextRun`)一并提前到调用点;错误一律原样透出、不包装。`next(from)` 此后为纯计算。
- **表达式落点**:表达式不落记录——`ScheduleRecord` 只带 `timezone?`,无表达式字段(SQLite 参考 adapter 表结构同,零改动);真相源在宿主侧调度定义(配置/代码),持久记录是到期缓存、与 `next` 按 id 进程内配对。重启重锚 = 宿主按定义逐个 `save()`(`save` 以 now 重锚 `nextFireAt`,定义即权威);不设 `metadata` 约定、无 rehydrate helper。
- **DST 语义**:原样透传,本包不补偿。实测(v10.0.1,`Europe/Stockholm` 2026-03-29 缺口日):`30 2 * * *` 返回本地 **03:30 CEST**,与 `30 3 * * *` 撞同一时刻——是偏移映射,与 croner README「gaps are skipped」措辞矛盾,以上游行为为准并如实入文(重叠日与 README 一致:只跑第一次出现)。
- **依赖预算**:croner 精确钉 `10.0.1`(MIT、零运行时依赖、engines `>=18`;`deps-budget.json` 基线 = 1 包 / 154,686 B 解包——registry `unpackedSize`,dist 27,551 B / gzip 8,059 B 为记录面)。对 core 无 peer——片段类型自含、结构兼容;`@oribos/core` 仅 devDep,接线单测(save→tick 走 croner `next`)进 verify,core 契约漂移在该单测的类型检查暴露。清单与发布口径沿 ADR-0002 M5 修订(engines `>=22.13.0`、锁步 `0.5.0`)。

## Observability 锚点

- **挂起**:`agent-run` span 以 attributes `status: 'suspended'` 正常 end;**resume = 同一 traceId 下的新 `agent-run` span**(traceId 随快照持久化,沿用 workflows 已钉模式)。一次 HITL 交互 = 同 trace 多 span。
- **signals**:注入 = 当前 `agent-run` span 上的 `isEvent` 事件;唤醒/调度触发的新 run 自身一个 `agent-run` span。不新增 span 类型常量。
- **tick 本身无 span**(进程内原语,非自动埋点边界之一)。

## 砍单与承载缝

判定口径见 `docs/ROADMAP.md`「下一阶段(完善)」;`CUT-H*` 行 = 审计 §2 砍单行集(`docs/research/completeness-audit.md`),`D*` 行 = 对比总账 §3「形状内语义差异」(`docs/research/mastra-gap-analysis.md`)。判定三值:有意分叉 / 已兑现(非差异) / 提升(→ 必须项表 ID)。2026-10-11 起按 ADR-0017 逐行重判,判定值增**转追赶项**与**维持分叉但理由改写**两值(程序、口径与已裁行见 `docs/ROADMAP.md`「追赶面」段)。

| 项 | 承载缝 | 判定 | 理由·ADR 指针 |
| --- | --- | --- | --- |
| **D1** 审批声明在 durable 包装层 | 需要审批 → `createDurableAgent` 包装;裸 agent 不变(Tool 四字段不动) | 有意分叉 | 核心零权限模型;审批闸是包装层能力(ADR-0005 / 0011;`tools.md` D2 行互引) |
| **D3** `approved: false` = 「用户拒绝」回喂、run 继续 | 需要硬停 → `processError` / 工具自带终止语义 | 有意分叉 | 拒绝是信息不是错误——以 `isError` 工具结果回喂、模型可改方案(ADR-0011 / 0005) |
| **CUT-H1** 崩溃自动恢复 / resumable stream / 多副本恢复 | `resume` + `listSuspended` 可选扩展归应用;原语均已落;**转追赶项分件**(2026-10-11,#161):resumable stream = 能力包(事件缓存 + `observe`,内存默认零负担、Redis opt-in)→ **已兑现**(2026-10-14,#184:`@oribos/resumable-stream` 落地——`withEventCache` 包装输出对象逐 chunk 落缓存(断连不截流:消费者挂起后包装泵仍录到 run 终态)、`observe(cache, runId)` 重放 + 进程内跟随,缓存 port 内存默认零依赖、`createRedisEventCache` 走 `get/set/del` 结构子集适配任意 Redis 客户端(客户端随调用方);`closeOnSuspend` 无需机制——durable 流以 `finishReason: 'suspended'` 收尾即关缓存;核心零改动、无恢复端点钉子不动(GET 归应用);跨实例实时跟随显式拒绝(`RunNotLiveError`)归 PubSub 包;验证面 = 缓存 / 包装 / observe 单测 + `examples/resumable-stream` 进 `check:examples` 闸门);每步检查点 + 崩溃重放 = 能力包 / 部署方(boot 恢复 = 用户调用的函数、非常驻循环,重发 LLM 与幂等成本由用户显式接受)→ **已兑现**(2026-10-14,#186:`@oribos/checkpoints` 落地——`createCheckpointedAgent` 沿公开 `stepBoundary.beforeToolCalls` 每继续步写一条检查点(prompt + 该步 assistant 消息 + stepCount + 持有调用 + trace)到本包自己的 `AgentRunCheckpointStore`(四方法 save/load/delete/list,JSON-only;内存默认、持久 store 归部署方),run 终态(成功 / 失败 / 挂起)清除,残留 = 进程死于途中的 run;`recover(runId)` 经既有 `AgentRunResume` 种子重放——重放步零模型调用、其持有工具重执行(幂等成本显式)、只重发 in-flight 的那一次模型调用,`recoverAll()` = boot 扫描(list 顺序、逐条 ok:false 不毁批次);核心零改动、无守护进程、不配置零成本;验证面 = fake model 重发计数单测 18 例 + `examples/crash-replay`(子进程 SIGKILL 崩溃 → 新进程 boot 扫描重放)进 `check:examples` 闸门);2026-10-20,#203:`recover` / `recoverAll` 改走 `@oribos/core/agent-run` 共享 continuation——load Checkpoint → 映射 `RunContinuation` → `continueRun`,恢复锁 = `createResumeLock`,包内本地 continuation / recovery lock / `materialize` 副本删除;重放、终态清除与 trace 续接行为不变,恢复矩阵(崩溃点 step 0/N × 终态成功/失败/挂起)6 例;多副本恢复与 leader election 随「跨实例 signals」行口径(opt-in 能力包 + 外部 Redis) | **转追赶项**(分件,2026-10-11,#161) | 证据 = mastra 事件缓存 + `observe(runId)` + durable 流 `closeOnSuspend`(1.70)与 `recovery: 'auto'` + boot 时 `recoverAllDurableAgents()`(实装未弃);验证面 = 缓存单测 + 断连重连 example、fake model 重发计数单测 + 崩溃重放 example(进 `check:examples` 闸门);原「自动恢复是外部 runner 能力包方向」理由随转项改写(ADR-0011);延后清单「resumable stream」「每步检查点 + 崩溃重放」「外部 runner 适配」行 |
| **CUT-H2** state signals | working memory + Processor 组合 | **维持分叉、理由改写**(2026-10-11,#161) | 证据成立(mastra judge + 预算 + thread state 持久化,Beta 未弃),但承载缝前置缺席:thread 状态域未建(`storage.md` CUT-ST3 钉「不建」,且该域未进任何清单——转项就要先立一个新核心域,超出本行判定面;「thread 状态域立不立」登记地图 Fog,是本行唯一真前置);judge + 预算语义仍可由 working memory + Processor 原型组合覆盖主场景;命名状态车道 + diff/merge 是新概念面的判断不动(ADR-0007 / 0011);延后清单「Goals / State signals」行 |
| **CUT-H3** notification inbox | `sendSignal({ type: 'notification' })` 即时注入 | **维持分叉、理由改写**(2026-10-11,#160) | 收件箱 schema(通道 / 优先级 / 已读 / 过期)是应用域,框架化只能给最小公倍 CRUD、宿主自有 DB 即可,框架不提供增量价值;即时注入已覆盖主路径;mastra 侧仅 3/31 adapter 支持(生态内采纳亦薄,#160)——证据强度低于其他行;持久化收件箱 + 投递策略是应用面的判断不动(ADR-0011);`storage.md` CUT-ST3 行互引 |
| **CUT-H4** signal providers(webhook / poll 入口) | 示例模式(薄基类 + 订阅登记簿 DIY)——转追赶项即示例形态:`examples/` 新增 webhook 入口例 + 配方说明,薄 HTTP 端点 → `sendSignal`,纯 signals 消费、零新缝零依赖 | **转追赶项(示例形态)**(2026-10-11,#160)→ **已兑现**(2026-10-12,[#177](https://github.com/0xnicholas/oribos-framework/issues/177):`examples/signal-webhook` 落地——薄 HTTP 端点 → `sendSignal`,登记簿应用自有;验证面 = 自断言 example 进 `check:examples` 闸门,7→8 案) | 原裁定承载缝即示例模式,缺口只是「没人写出来」;能力包形态把一个 HTTP 端点包装成包,性价比不成立(#160);验证面 = example 进 `check:examples` 闸门;**与现有缝距离最近**,首批候选;入口形态是部署面、不进规范的判断不动(ADR-0011);延后清单「signal providers(webhook / poll 入口)」行 |
| **CUT-H5** background tasks(deferred / untilIdle) | 分两期(2026-10-11,#161):一期 = 配方文档 + example(「工具 ack + 完成后 `sendSignal` 唤醒」原语组合,ADR-0011 判等效,零负担);二期 = manager/lease 能力包(opt-in、不装不配即零成本、不接管宿主,**核心流完成语义不动**——`untilIdle` 语义冲突不触发:续轮由包在公开表面自驱,不改 agent 流) | **转追赶项(分两期)**(2026-10-11,#161)→ **一期已兑现**(2026-10-12,[#178](https://github.com/0xnicholas/oribos-framework/issues/178):`examples/background-tasks` 落地——工具 ack + `sendSignal` 唤醒配方(线程身份经 request context 开放袋 `replyTo` 随 run 携带回发,成功 / 失败同门 `report-completed` / `report-failed` 信令,ack 即收 run、框架零常驻),README 附三件配方;验证面 = 自断言 example 进 `check:examples` 闸门,8→9 案)→ **二期表面冻结**(2026-10-14,#190):`@oribos/background-tasks`(manager 收 handler 驱动执行 + `adopt()` / `untilIdle()`),细节见「后台任务能力包(`@oribos/background-tasks`)」节 → **二期已兑现**(2026-10-15,[#197](https://github.com/0xnicholas/oribos-framework/issues/197)):manager 收 handler 驱动执行 + `adopt()` 孤儿重跑 + `untilIdle()` 包级等待落地;任务行 / 租约两 port 内存默认、`createRedisLease` 结构子集随包;验证面 = 单测 26 例 + `examples/background-tasks` 五幕进 `check:examples` 闸门 | 证据强 = mastra manager + 持久化租约(1.72)+ 心跳 + `stream({ untilIdle: true })` + `context.background.adopt()`,实装存在且未弃;一期**首批候选**(配方 + example,零代码面);二期**远层**(新 port 抽象);保轴边界逐期写明(ADR-0011);延后清单「Background tasks」行 |
| **CUT-H6** goals(standing objective + judge) | Processor + working memory 原型化 | **维持分叉、理由改写**(2026-10-11,#161) | 证据成立(mastra judge + 预算 + thread state 持久化,Beta 未弃),但承载缝前置缺席:thread 状态域未建(`storage.md` CUT-ST3 钉「不建」,未进任何清单——转项先立新核心域,超出本行判定面;「thread 状态域立不立」登记地图 Fog);judge + 预算语义可由 working memory + Processor 原型组合覆盖主场景;judge + 预算语义是新概念面的判断不动(ADR-0011 / 0007);延后清单「Goals / State signals」行 |
| **CUT-H7** AgentController / session 语义 | Agent 类自行组装(「thread 持久 / live 状态内存」分层已隐含) | **维持分叉、理由改写**(2026-10-11,#160) | 证据成立(mastra modes / permissions / channels / workspace 成品运行时 + `createCodingAgent()` + mastracode),但 = 交互式编码 agent 产品面的成品运行时,接管宿主交互循环;三件套 + signals 已支撑宿主自组装,「应用层自组装」语义仍更优(ADR-0011);延后清单「AgentController / session」行 |
| **CUT-H8** durable sleep / 长延时等待 | schedules + suspend 组合(原语已落) | 有意分叉 | 核心不要长驻进程;无 sleep 原语(ADR-0011);与 `workflows.md` CUT-W11 行互引 |
| **D4** / **CUT-H9** `ifActive` / `ifIdle` 分支行为矩阵 | 固定三句语义(活跃注入 / 空闲唤醒 / 排队保序)已落 | 有意分叉 | 固定三句即标准面——行为矩阵会把最小语义扩成开关森林(ADR-0011) |
| **D6** / **CUT-H10** 触发记录(trigger history) | observability span;`tick` 无 span 由 **P-1** 断言固定 | 有意分叉 | 不建 fire log:追责靠 run 自己的 trace(ADR-0011 / 0009) |
| **D5** 排队队列进程内 | 既有缝随 [#161](https://github.com/0xnicholas/oribos-framework/issues/161) 转项:跨实例 signals 追赶项能力包(共享 PubSub + 租约 + Redis 适配;核心单进程语义不变)→ **表面冻结**(2026-10-14,#187):`@oribos/distributed-signals` 包装式,细节见「跨实例 signals 能力包(`@oribos/distributed-signals`)」节 → **已兑现**(2026-10-15,#194:`createDistributedSignals({ signals, pubsub, lease, channelPrefix?, heartbeatMs? })` 落地——send 三原语跨实例路由(活跃在本实例 = 本地注入,心跳关时注入前 token 自检;否则发布信封到 `<prefix>oribos:signals:<threadId>`);空闲唤醒 = 订阅方抢租约、赢家本地唤醒,广播冗余由租约收敛;`stream` / `generate` 永远本地直通,`subscribeToThread` 仅本实例(跨实例跟随 v1 拒绝,RunNotLiveError 同口径);`SignalPubSub` port at-most-once 回调式(`createInMemoryPubSub` 零依赖默认 + `createRedisPubSub` 走 subscribe / publish 结构子集,客户端随调用方),每 thread 频道 + JSON 信封 `{ kind, thread, resource, payload, traceparent? }`;`SignalLease` port(`createInMemoryLeaseStore` 默认 + `createRedisLease` 走 set(NX/PX) / eval 结构子集),租约 = thread 活跃 run 所有权(run 始即持、settle 即释放);心跳 `heartbeatMs` 可配(TTL = 3 × heartbeatMs、过期窗口文档化),关闭 = step 边界续约 + 注入前 token 自检、零定时器;信封 traceparent 接收侧延续唤醒 run 的 trace,解析失败降级独立 trace、不新增失败面;跨实例 at-most-once、best-effort FIFO(续跑重叠窗口文档化);核心零改动;验证面 = fake(内存)单测 36 例 + `examples/distributed-signals`(双进程 IPC hub 实现两 port:进程 B sendSignal → 进程 A 注入 + 空闲唤醒,child 零模型调用)进 `check:examples` 闸门(15 案)) | **维持分叉、理由改写**(2026-10-12,[#169](https://github.com/0xnicholas/oribos-framework/issues/169)) | 单进程语义显式、进程死即丢,文档化(ADR-0011);承载缝指针随 #161 转项改写,原指延后清单行 |
| **D7** `tick` 本身无 span | 需要 tick 级可观测 → 用户自定义 span | 有意分叉 + 缺席断言 → **P-1** | `tick` 是进程内原语、非七边界埋点之一;追责靠被触发 run 的 trace(ADR-0011 / 0009) |

## 与其它子系统的关系

- **Agent(#10,已定)**:loop 唯一改动 = step 边界注入缝(缺席零开销);`finishReason` 增 `'suspended'`,仅 durable 包装内产生;审批/挂起由本规范正式承接。
- **Workflows(#11,已定)**:本规范不加 workflow 新机器——suspend/resume 已完整;无 boot 自动恢复(`listSnapshots` + `resume` 原语归应用),无 durable timer(长等待 = schedules + suspend 组合)。
- **Memory(#12,已定)**:signals 注入内容落消息历史、唤醒经 recall;goals 延后的原因之一 = MemoryStore 无 thread 状态域。
- **存储(#15,已定)**:port 清单扩为四个(+ `AgentRunSnapshotStore`、`ScheduleStore`),统一 adapter 家族;lease / PubSub / notifications / thread-state 域不建。
- **Observability(#14,已定)**:锚点见上节,span 类型常量不变。
- **多 agent(#19)**:无直接耦合;委派语义归它。

## 依赖预算

核心(含 Harness 三件套)运行时依赖硬线 = 0(数字按 ADR-0001 作内部 CI 回归参考)。croner 封装、跨实例 PubSub/租约、外部 runner 适配归能力包。
