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
- **挂起语义只在 durable 包装内存在**:裸 agent 无快照、**不传 `stepBoundary` seam 时**不产生 `'suspended'`(该 seam 是公开 run option,显式传入即得),核心 agent loop 本体不变。Harness 持有 agent,不是反之(ADR-0005 砍单表)。
- **裁单**:崩溃自动恢复(每步 running 检查点 + 重放)、resumable stream 事件缓存、`observe()`、多副本恢复与 leader election、boot 时 recoverAll、工具 `execute` 内 `suspend()`(通用挂起,background tasks 的机器,已延后入雾)。「列出待审批 run」归 adapter 可选扩展(下节)。

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
- **运行时**:进程内内存 pubsub + 「thread → 活跃 run」注册表,单进程语义;跨实例(共享 PubSub + 租约)归能力包,入雾。
- **agent loop 唯一改动**:每个 step 边界检查注入队列;无 signals 挂接时零开销(无运行时负担)。
- **裁单**:state signals(命名状态车道 + diff/merge)延后入雾;notification inbox(持久化收件箱 + 投递策略)裁出——`sendSignal({ type: 'notification' })` 即时注入覆盖主场景;signal providers(webhook/poll 入口)不进规范,以示例模式承载。

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

判定口径见 `docs/ROADMAP.md`「下一阶段(完善)」;`CUT-H*` 行 = 审计 §2 砍单行集(`docs/research/completeness-audit.md`),`D*` 行 = 对比总账 §3「形状内语义差异」(`docs/research/mastra-gap-analysis.md`)。判定三值:有意分叉 / 已兑现(非差异) / 提升(→ 必须项表 ID)。

| 项 | 承载缝 | 判定 | 理由·ADR 指针 |
| --- | --- | --- | --- |
| **D1** 审批声明在 durable 包装层 | 需要审批 → `createDurableAgent` 包装;裸 agent 不变(Tool 四字段不动) | 有意分叉 | 核心零权限模型;审批闸是包装层能力(ADR-0005 / 0011;`tools.md` D2 行互引) |
| **D3** `approved: false` = 「用户拒绝」回喂、run 继续 | 需要硬停 → `processError` / 工具自带终止语义 | 有意分叉 | 拒绝是信息不是错误——以 `isError` 工具结果回喂、模型可改方案(ADR-0011 / 0005) |
| **CUT-H1** 崩溃自动恢复 / resumable stream / 多副本恢复 | `resume` + `listSuspended` 可选扩展归应用;原语均已落 | 有意分叉 | 自动恢复是外部 runner 能力包方向(ADR-0011);延后清单「resumable stream」「每步检查点 + 崩溃重放」「外部 runner 适配」 |
| **CUT-H2** state signals | working memory + Processor 组合 | 有意分叉 | 命名状态车道 + diff/merge 是新概念面;前置 = thread 状态域(ADR-0007 / 0011);延后清单「Goals / State signals」 |
| **CUT-H3** notification inbox | `sendSignal({ type: 'notification' })` 即时注入 | 有意分叉 | 持久化收件箱 + 投递策略是应用 / 能力包面;即时注入覆盖主场景(ADR-0011);`storage.md` CUT-ST3 行互引 |
| **CUT-H4** signal providers(webhook / poll 入口) | 示例模式(薄基类 + 订阅登记簿 DIY) | 有意分叉 | 入口形态是部署面,不进规范(ADR-0011);延后清单「signal providers」 |
| **CUT-H5** background tasks(deferred / untilIdle) | 「工具 ack + 完成后 `sendSignal` 唤醒」组合 | 有意分叉 | `untilIdle` 续轮会改动 agent 流的完成语义;原语组合已等效(ADR-0011);延后清单「Background tasks」 |
| **CUT-H6** goals(standing objective + judge) | Processor + working memory 原型化 | 有意分叉 | judge + 预算语义是新概念面;前置 = thread 状态域(ADR-0011 / 0007);延后清单「Goals / State signals」 |
| **CUT-H7** AgentController / session 语义 | Agent 类自行组装(「thread 持久 / live 状态内存」分层已隐含) | 有意分叉 | 交互式编码 agent 产品面出域(ADR-0011);延后清单「AgentController / session」 |
| **CUT-H8** durable sleep / 长延时等待 | schedules + suspend 组合(原语已落) | 有意分叉 | 核心不要长驻进程;无 sleep 原语(ADR-0011);与 `workflows.md` CUT-W11 行互引 |
| **D4** / **CUT-H9** `ifActive` / `ifIdle` 分支行为矩阵 | 固定三句语义(活跃注入 / 空闲唤醒 / 排队保序)已落 | 有意分叉 | 固定三句即标准面——行为矩阵会把最小语义扩成开关森林(ADR-0011) |
| **D6** / **CUT-H10** 触发记录(trigger history) | observability span;`tick` 无 span 由 **P-1** 断言固定 | 有意分叉 | 不建 fire log:追责靠 run 自己的 trace(ADR-0011 / 0009) |
| **D5** 排队队列进程内 | 既有:延后清单「跨实例 signals」行 | 有意分叉 | 单进程语义显式、进程死即丢,文档化(ADR-0011) |
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
