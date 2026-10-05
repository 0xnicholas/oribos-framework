# Workflow 引擎语义

> 来源:wayfinder ticket #11(决策:Workflow 引擎语义)。本文件是 Workflows 子系统的架构规范。
> 决策记录见 `docs/adr/0006-workflow-engine-semantics.md`;术语见 `CONTEXT.md`。
> 修订(#49):控制流算子表补钉两处实施期裁决——branch 无真分支输出空 keyed 对象 `{}`(tip 值不穿透);foreach concurrency 须为正整数,迭代失败后不再开新迭代。
> 修订(#50):循环与等待补钉实施期裁决——dowhile 条件在**迭代前**求值(条件在 tip 上为假即可 0 次迭代,块输出 = tip 原样透传)、dountil 在**迭代后**求值(至少一次);两者 `iterationCount` = 已完成迭代数(条件里抛错即最大迭代闸),块按 step id 记一条(记录 = 最后一次迭代的输出)。sleep 的动态时长 fn 收 `RequestContext`(动态参数约定,非 step 参数包;非有限数报错,负值当 0);`retries` = **额外**尝试数(最多 `retries + 1` 次),固定间隔 1000ms、可被中止打断,step 边界校验只做一次不重试,定义期须为非负整数。
> 修订(#51):suspend/resume 落地时补钉实施期裁决——v1 的 suspend 只成立在**顶层 then 条目**的 step 内,块内(parallel / branch 臂 / foreach / 循环)调用 suspend 显式报错(块内迭代现场不在快照形状内,升级为新 ticket);`position` = 重进下标(suspend 时 = 挂起条目,running 时 = 下一条目,终态 success = 条目数);resume 把前序条目**按记录回放**重建 tip(不重执行、不重估条件),`input` 用快照里已校验的值;持久化粒度 = **条目完成**(块的子 step 随块一起记录,见 #49/#50;sleep 不是 step 但条目完成也写),step 边界写只随真实 storage,无 storage 时只写 suspend 与终态。
> 修订(#52):事件流与 span 埋点落地时补钉实施期裁决——事件词汇表与载荷(下表「流式事件」)、块内 step 的**每次执行**一对事件 / 一个 `workflow-step` span(stepResults 仍按块聚合)、run span 的 input = 校验后的触发输入(start 的 input / resume 的 resumeData)、output = 终态信封;`createRun` 收 `{ traceId?, parentSpanId? }`(外部 trace 续接,空串语义沿 agent 的 run option),`traceId` 作为**可选字段**进快照(additive),resume 以快照 traceId 开同一 trace 下的新 run span。
> 修订(#54):块内挂起落地——四类块体内 `suspend()` 真挂起,迭代现场以可选 `iterationSite?` 字段进快照(additive,旧快照无此字段 = 顶层挂起的旧形状);resume 按 site 重进块内:parallel / branch 按**记录回放**完成臂(无 success 记录的臂重跑,挂起臂各落 suspended 记录,resume 命名谁谁收 resumeData)、foreach 记已收集前缀与挂起索引(洞重跑)、循环记已完成迭代数与挂起迭代的输入(dowhile 重进跳过首次前置检查);块是**满同步点**——挂起或失败前等在飞执行落定,挂起优先于同窗兄弟失败;事件/记录/快照同读「块内挂起 = suspended」。实施期补钉:foreach/parallel 的失败也等在飞落定(旧 Promise.all 的“失败即离场、在飞脱缰”废止)。
> 修订(#119):resume 并发去重的键域钉为快照的持久化身份 **(store, runId)**——机制收进内部 resume-lock 模块(`WeakMap<store, Map<runId, Promise>>`,join-in-flight、settle 即删),workflows 与 durable-agent 各持一个模块级注册表实例(结构性跨子系统隔离);两个 store 上的同 runId 各自独立,durable 侧跨 wrapper 实例也去重。

## 定位

Workflows 是框架的编排子系统:把 step 组合成可重复执行的图。API 形状与词汇对齐 mastra(`createStep` / `createWorkflow` builder),但语义内核只是「扁平 step-flow 条目列表 + for 循环 walker」——调研(#3)证明 mastra 的语义核心即此,其体量几乎全来自持久化钩子、streaming、tracing 与多引擎适配,而非语义本身。轻量落法:**存储做成 port,引擎本体零依赖、纯内存可跑**;durable 重启与调度的裁决见 Harness 规范(`docs/architecture/harness.md`),外部 runner 适配是可能的能力包方向。

## 定义表面

### Step

```ts
const step = createStep({
  id: string,                    // 必填,快照与 parallel/branch 输出的 key
  inputSchema: StandardSchema,   // ADR-0003 双接口契约,无适配器
  outputSchema: StandardSchema,
  resumeSchema?,                 // resume 时校验 resumeData
  suspendSchema?,                // suspend(payload) 的类型
  retries?: number,              // 固定间隔重试,见「错误、重试与状态机」
  execute: (ctx: StepContext) => output | Promise<output>,
})
```

execute 的参数包 `StepContext`:`inputData` / `runId` / `signal` / `requestContext` / `getStepResult(stepId)` / `resumeData` / `suspend(payload)`。

- **无 `createStep(agent)` / `createStep(tool)` 特化重载**:agent 包装是一行手写——`execute: ({ inputData }) => agent.generate(inputData)`;文档给范式。
- **无 `state` / `setState` 黑板**:跨 step 共享用 `getStepResult` + 显式管道;黑板是可后加的 minor。

### Workflow 与 builder

```ts
const wf = createWorkflow({ id, inputSchema, outputSchema })
  .then(step1)
  .parallel([a, b])
  .branch([[condFn, stepA], [condFn2, stepB]])
  .foreach(step, { concurrency: 4 })
  .dowhile(step, condFn) / .dountil(step, condFn)
  .sleep(ms | ((ctx) => ms))
  .commit()                      // 冻结定义;未 commit 不可 createRun
```

- builder 可变链式,每个算子往条目列表 push 一条 `{type, ...}` 条目;`.commit()` 冻结。**没有 DAG**:执行就是对扁平条目数组的 for 循环解释。
- 类型安全靠 type-state(`TPrevSchema` 逐链传递),只在 then 主轴严格;parallel/branch 用 keyed 对象推断。
- condFn 收与 execute 相同的参数包(只读语义);dowhile/dountil 的 cond 另收 `iterationCount`,可在其中抛错设最大迭代。
- **嵌套 workflow as step 裁出 v1**(后加是 minor)。

### Run

```ts
const run = wf.createRun({ runId?, traceId?, parentSpanId? })
const out = run.start({ inputData, requestContext?, signal? })
await out.result                 // 终值
for await (const ev of out)      // 最小 lifecycle 事件流,见「流式事件」
await run.resume({ step, resumeData? })   // 见「suspend/resume 与快照」
```

- run 输出对象与 Agent 输出对象同一心智:**await 终值 / for-await 事件流,双消费单路径**。
- `requestContext` 沿用 Agent 规范的开放袋约定;`signal`(AbortSignal)沿 execute 与动态时长函数传播。
- `createRun` 另收可选的 `traceId?` / `parentSpanId?`:把本次 run 挂到别处开始的 trace 下(入站 `traceparent`、父 run),空串语义沿 Agent 的 run option(空 `traceId` 整对作废、空 `parentSpanId` 只丢 parent)。**resume 不收取接选项**:恢复段以快照里已持久化的 traceId 续同一 trace。

## 控制流算子

| 算子 | 语义 | 输出形状 |
| --- | --- | --- |
| `.then(step)` | 顺序执行;上一步 output(校验后)作为下一步 input | 透传 |
| `.parallel([a,b])` | 全并发,无并发上限;满同步点(离场前等全部臂落定);任一步失败且无挂起则整块失败;挂起优先于同窗兄弟失败 | `{ [step.id]: output }` |
| `.branch([[cond,step]...])` | 按定义序求值,第一个真分支执行;各分支 IO schema 一致是**调用方保证**(类型层不强制),不一致由下游步的输入边界校验拦截;无真分支时输出空 keyed 对象 `{}`(tip 值不穿透) | keyed 对象,只有一个 key 有值 |
| `.foreach(step, {concurrency})` | 输入必须是数组;默认 concurrency=1(须为正整数);>1 用并发闸,保序收集;满同步点(失败或挂起后不再开新迭代,在飞迭代落定后离场);任一次迭代失败且无挂起则整块失败 | 输出数组 |
| `.dowhile` / `.dountil(step, cond)` | 循环至条件不满足/满足;dowhile 迭代**前**求值(可 0 次迭代)、dountil 迭代**后**求值(至少 1 次);输出 = 最后一次迭代的输出 | 透传 |
| `.sleep(ms\|fn)` | 进程内 setTimeout + AbortSignal,**非 durable**(进程死即丢);fn 动态算时长(收 `RequestContext`) | — |

## suspend/resume 与快照

**收 suspend/resume,形态 = suspend 控制信号 + step 边界 JSON 快照 + storage port**(ADR-0006)。

- `suspend(payload)` 在 execute 内调用:当前 step 标记 suspended → 快照写 port → 引擎展开退出;run 状态 = `suspended`。suspend 是控制信号不是失败:不经过 step 重试,也不落 failed 记录。
- 快照 = JSON 可序列化的 `{ runId, status, input, stepResults, position }`(stepResults 记录每步 status / output / 起止时间 / suspendPayload;position 即 mastra 的 startIdx 等价物)。**JSON-only 是 port 契约,默认内存实现不执法**:`structuredClone` 拒函数但放行 Map / Set / Date / 循环——核心内存默认收下的快照仍可能过不去 JSON 后端的 adapter;大数据只存引用。
- 恢复 = `run.resume({ step, resumeData? })`:load 快照 → resumeData 过 resumeSchema → 从 position 重进同一个 for 循环。time-travel / restart / restartAllActiveWorkflowRuns 是同一机制的变种,**全部裁出 v1**;引擎只暴露「load → 重进」原语,durable 重启归 Harness(#18)。
- 持久化时机:有 storage 时**每个条目完成后** + suspend + 终态,固定写;无 shouldPersistSnapshot / prune 钩子。"每个条目"而非字面的"每个 step":块的子 step 随块一起记录(#49/#50 已钉块只按 step id 记一条),条目完成才是记录表变化的时刻;sleep 不产生记录但条目完成照写。
- resume 并发去重:进程内锁,键域 = 快照的持久化身份 (store, runId)(#119);跨进程 CAS = adapter 可选扩展(`compareAndSave`,见 `docs/architecture/storage.md`)。

### 实施钉死(#51,块内部分由 #54 修订)

- **suspend 在任何条目类型内都成立(#54 修订)**:顶层 `then` 的 step、parallel / branch 臂、foreach / 循环体内调用 `suspend(payload)` 都真挂起 run;条件里调用 suspend 仍显式报错(条件是只读的)。#51 的「v1 只在顶层 then」由 #54 补上承载缝。
- **position = 重进下标**:suspend 快照 = 挂起条目;`running` 快照 = 已完成条目的下一条;终态 `success` = 条目数。只写 `running` 快照当 `createWorkflow` 附了真实 storage;无 storage 时只写 suspend 与终态——快照只落在 run 对象的内存默认实现里(同一 run 对象可恢复;新 run 对象要接真实 storage,进程内默认 store 不跨对象)。
- **resume 的回放**:从快照 `input`(start 边界已校验过的值)起,按记录重建前序条目的输出得到 tip——前序 step 不重执行、条件不重估;`getStepResult` 由快照记录种子恢复。`resumeData` 过挂起 step 的 `resumeSchema` 是第三处固定 IO 校验,校验值替换原数据;声眀无 `resumeSchema` 的 step 不接受 resumeData(显式报错)。`step`(step 对象或 id)必须与快照里挂起的 step 一致,否则显式报错。resume 选项可再传 `signal` / `requestContext`(跨进程恢复时;缺省用 start 的)。
- **信封与去重**:挂起终态 = `{ status: 'suspended', stepId, stepResults }`(payload 在 `stepResults[stepId].suspendPayload`);resume 与 start 返回同一终态信封。进程内锁按 (store, runId) 去重(#119 钉键域 = 快照的持久化身份):同一 store 上同一 run 的并发 resume 合并为一次调用(后到者拿到同一 promise),两个 store 上的同 runId 各自独立、互不 join;锁在 settle 后释放(再次挂起可再次 resume)。
- **写失败语义**:快照写失败随 run 失败(除 failed 终态那一写为 best-effort——run 自身的错误永远原样上抛)。挂起的 step 落 `suspended` 记录(记录与挂起信封同源):顶层 then 与 parallel / branch 臂按各自 step id 落记录(多个同时挂起的臂各落各的,谁都可以是下一个 resume 目标);foreach / 循环按块的聚合 step id 落一条(mid-block 挂起,块完成时替换为 success)。

### 块内挂起与迭代现场(#54)

- **块是满同步点**:挂起信号出现后,块停止拉新迭代/不再开新臂,**等在飞执行落定**后才写挂起快照——快照必须说得清哪些执行已完成(旧 Promise.all 语义下“失败即离场、在飞脱缰”废止;失败同样等落定)。挂起信号**优先于**同窗兄弟失败(失败臂落 failed 记录,重进时随重跑规则再跑)。
- **resume 按 site 重进块内,records-first**:parallel / branch 臂带 `success` 记录的按记录回放不重跑,无 success 记录的臂(失败 / 未跑 / 未被命名的挂起臂)重跑(无 resumeData,再挂起则再挂);branch 重进**不重估条件**(所选臂由记录钉死);foreach 已收集前缀回放,洞与挂起索引重跑;循环从 site 的 value 与 iterationCount 重进。
- **resumeData 归属挂起的那一次执行**:foreach 同一 step id 多次执行,按 site 的 suspendedIndex 门控;循环的重进首次体执行即挂起迭代。后续迭代 / 兄弟臂拿 `undefined`。
- **多挂起收敛**:并发执行中多个 suspend,首个落定者为信封点名的挂起目标;其余(臂)各落 suspended 记录可作下一个 resume 目标,(foreach 迭代)为洞重跑——再次 suspend 就再次挂起,逐次收敛。
- **目标校验**:site 的 kind 必须与 position 处条目类型一致(loop 对应 dowhile / dountil 两型),命名 step 必须是该块的 step 且记录为 suspended;不一致显式报错(快照与定义不匹配)。

### storage port(#15 已定)

```ts
interface WorkflowSnapshotStore {
  load(runId: string): Promise<WorkflowRunSnapshot | null>
  save(runId: string, snapshot: WorkflowRunSnapshot): Promise<void>
}
```

核心自带内存 Map 默认实现——不接 storage 即纯内存,无运行时负担。基础形状冻结;adapter 家族与 delete / list / CAS 可选扩展见 `docs/architecture/storage.md`。

快照形状在 #51 钉的五字段外,由 #52 additive 加一个可选 `traceId?`(32-hex,`docs/architecture/observability.md`「suspend/resume」):有真实 span 时才写,未挂 tracer 或采样不通过的 run 没有它;resume 用它续同一 trace,故同一次挂起的两段 run span 在一条 trace 里。#54 再 additive 一个可选 `iterationSite?`(只随块内挂起的 suspended 快照出现,running / 终态快照无):判别联合 `{kind: 'parallel' | 'branch'}`(记录即现场,无额外数据)/ `{kind: 'foreach', suspendedIndex, collected}`(键 = index-as-string,避免稀疏数组的 null 歧义)/ `{kind: 'loop', iterationCount, value}`(value = 挂起迭代的输入——中途 tip 不在任何记录里);旧快照缺此字段 = 顶层挂起的旧形状,走既有路径。

## IO 校验

- 契约 = Standard Schema 双接口(ADR-0003),零适配器。
- 校验点固定三处:start 输入、每个 step 边界(上步 output → 下步 input)、resumeData;**无 validateInputs 开关**,永远校验。
- 失败语义:start 校验失败 → 抛错不启动;step 边界失败 → 该 step failed → run failed。
- 校验返回值替换原数据(schema 的 default / transform 生效)。

## 流式事件

最小 lifecycle 事件流,粒度 = run / step 边界(run-start / step-start / step-end / run-end 量级),事件包络与词汇复用 chunk 协议(模型层已定共用,见 `docs/architecture/model.md`)。**chunk 级透传(step 内 agent 的 token 流)裁出 v1**:step 内用户可自行消费 agent 的 stream 输出对象。

事件是 `start` 输出对象的第二消费(`for await`),与 `result` 共享同一次执行、同一顺序;事件**带边界值**:

| 事件 | 载荷 | 何时 |
| --- | --- | --- |
| `run-start` | `{ runId, workflowId, input }`(`input` = 校验后的 start 输入) | start 输入过了边界;被拒的 start 不发事件(运行从未开始) |
| `step-start` | `{ stepId, input }`(`input` = 到达边界的原值) | 进入一次 step 边界(校验之前) |
| `step-end` | `{ stepId, status, output? }`(`status` = `success` / `failed` / `suspended`;`output` 只在 success) | 离开一次 step 边界 |
| `run-end` | `{ status: 'success' \| 'suspended', output? }`(success 带终值) | run 达终态 |

- **块内 step = 每次执行一对**:`foreach` / 循环的每次迭代、`parallel` 的每个臂各自一对(并发下按发生序交错),而 `stepResults` 仍按块聚合一条(#49/#50);事件与 span 是执行视角,记录是块视角。
- **失败**:失败 step 的 `step-end` 以 `status: 'failed'` 落地,随后**迭代器以 run 的错误 reject**(与 agent 流同一惯例,不设 failed 的 `run-end`);`result` 与迭代器同错、同一次执行。
- **挂起**:挂起 step 的 `step-end` 为 `suspended`,`run-end` 为 `suspended`;恢复段走 `resume` 的 promise,不是同一条流的续写。
- **事件与 span 各记一边**:`step-start` 的 `input` 是**到达边界的原值**(校验前),`workflow-step` span 的 input 是**边界校验后的值**(`execute` 实际收到的)——校验失败时 span 无 input、error 落它。**块内 step 的 suspend 读 `suspended`**(#54 修订 #52 的“读 failed”):该边界真能挂起 run,事件、记录、快照同读法;未被信封点名的挂起迭代(如 foreach 并发多挂起的非首个)事件照读 `suspended`(执行视角),记录不落(块聚合)。
- 事件缓冲**无界、无背压**:消费者慢于生产时缓冲持续增长,消费节奏是消费者侧责任。消费者提前 break:停止事件缓冲,run 照跑完(`result` 仍落定);懒启动不变(首个 `next()` 或首次读 `result` 才开始执行)。

## 错误、重试与状态机

- run 状态机三态:`success | failed | suspended`。sleep 期间状态保持 running(无 waiting);AbortSignal 取消落 `failed`(AbortError),不单设 canceled / tripwire。
- `retries?: number`:step 级,最多 `retries + 1` 次尝试、固定间隔 1000ms;重试只包 `execute`(step 边界的 IO 校验只做一次),间隔等待可被 AbortSignal 打断,最后一次的错误原样抛出;backoff 策略对象留扩展位。
- `bail(payload)` 裁出 v1:提前成功终止用 branch 建模,后加是 minor。

## 砍单与承载缝

判定口径见 `docs/ROADMAP.md`「下一阶段(完善)」;`B*` 行 = 对比总账 §3「形状内语义差异」(`docs/research/mastra-gap-analysis.md`),`CUT-W*` 行 = 审计 §2 砍单行集(`docs/research/completeness-audit.md`)。判定三值:有意分叉 / 已兑现(非差异) / 提升(→ 必须项表 ID)。

| 项 | 承载缝 | 判定 | 理由·ADR 指针 |
| --- | --- | --- | --- |
| **B1** `dowhile` 迭代**前**求值、可 0 次 | `.dountil`(后测,至少一次) | 有意分叉 | 前测与 `while` 直觉一致、条件只读、可 0 次;后测语义由 `.dountil` 给(ADR-0006) |
| **CUT-W1** map / sleepUntil | 内联 step + 一行算术(`foreach` / `sleep(ms\|fn)`) | 有意分叉 | 两者覆盖主流;后加 minor(ADR-0006) |
| **CUT-W2** `createStep(agent\|tool)` 特化重载 | 一行手写包装——范式有树内证据(`examples/workflow-approval`) | 有意分叉 | 定义表面不收简写重载;后加 minor(ADR-0006) |
| **CUT-W3** 嵌套 workflow as step | step `execute` 内手接子 run(父 run 只记 step 边界,子 run 自拥快照) | 有意分叉 | 子图字段面留判断位;后加 minor——跨图一体化恢复才有缺口(ADR-0006) |
| **CUT-W4** state / setState 黑板 | `getStepResult` + 显式管道 | 有意分叉 | 显式管道替代黑板;后加 minor(ADR-0006) |
| **CUT-W5** bail | `branch` 建模 | 有意分叉 | `branch` 已足;后加 minor(ADR-0006) |
| **CUT-W6** validateInputs 开关 | 需要绕过校验 → 放宽 schema 本身 | 有意分叉 | 校验永远开 = 标准字面「三处固定校验」,没有可关的理由(ADR-0003 / 0006) |
| **B5** resume 按记录回放重建 tip | 记录回放(records-first)即机制本体 | 有意分叉 | 前序 step 不重执行、条件不重估——副作用不重复(ADR-0006) |
| **B6** `resumeData` 只给被点名的那一次执行 | 需要广播 → 显式走 `getStepResult` / 参数管道 | 有意分叉 | 记录回放模型下数据归属明确;无「广播给兄弟臂 / 后续迭代」语义(ADR-0006) |
| **B7** 快照 = 固定五字段 + 可选 `traceId` / `iterationSite` | `iterationSite` 承载块内现场(`CONTEXT.md` 迭代现场) | 有意分叉 | 最小可判 JSON 快照;快照是库语义不是历史(只留最新一份)(ADR-0006 / 0010) |
| **B8** 无 `suspendedPaths` / `serializedStepGraph` 路径模型 | 位置 = 扁平 `position` + `iterationSite`(下「CUT-W9」行互引) | 有意分叉 | 不建路径模型——`suspendedPaths` 式多路径挂起模型在 `CONTEXT.md` 记 _Avoid_(ADR-0006) |
| **CUT-W9** resume CAS / serializedStepGraph / 多引擎适配 | **已兑现段**:CAS 已落为 adapter 可选扩展(`compareAndSave`,`@oribos/sqlite` 已实现);**两件指针**:`serializedStepGraph` 随「B8 不建路径模型」,多引擎 → 外部 runner 能力包 | 已兑现 + 有意分叉 | 三件已分流:一件已兑现(ADR-0010)、一件随 B8 分叉、一件是能力包方向(ADR-0006) |
| **CUT-W7** time-travel / restart / restartAll | `load` → 重进原语,**需先截断该位之后的记录**;durable 侧重启归 Harness | 有意分叉 | 调试 / 审计场景非 v1 判据;records-first 回放决定它不是「薄变种」(ADR-0006 / 0011);延后清单「time-travel / restart」 |
| **CUT-W8** shouldPersistSnapshot / prune 钩子 | 固定 step 边界写;保留期清理 = adapter 扩展(`deleteSnapshot` / `listSnapshots`,`@oribos/sqlite` 已落) | 有意分叉 | 固定边界写是良定义策略;保留期策略归 adapter(ADR-0006 / 0010) |
| **B2** `retries` = 额外尝试数 + 固定 1000ms + 可打断 | backoff 策略对象已留扩展位;重试只包 `execute` | 有意分叉 | 最多 `retries + 1` 次最直观;固定间隔 = 最小配置、无退避矩阵;等待可打断 = abort 一致语义(ADR-0006) |
| **B3** `sleep` 动态时长收 `RequestContext` | 需要上一步输出算时长 → 显式传参 / 内联 step 计算 | 有意分叉 | 全字段统一动态参数口径(`T \| ((ctx) => T)`);`RequestContext` 是唯一解析上下文(ADR-0006 / 0005) |
| **CUT-W11** durable sleep / 长延时等待 | **宿主平台 cron / `tick` → 应用 `listSnapshots` + `resume`**(`ScheduleTarget` 只收 agent / signal,workflows 无调度目标) | 有意分叉 | 核心 `.sleep` = `setTimeout`,非 durable;与 `harness.md`「CUT-H8 durable sleep」行互引(ADR-0006 / 0011) |
| **B4** 无 `waiting` 状态、abort 即 failed | 既有「CUT-W12 tripwire / canceled」行(互引) | 有意分叉 | run 状态机三态最小(`success \| failed \| suspended`);sleep 期间保持 running;取消落 failed 不单设 canceled(ADR-0006) |
| **CUT-W12** tripwire / canceled 状态 | AbortSignal → failed | 有意分叉 | run 状态机三态最小;取消落 `failed`(AbortError),不单设 canceled;与 B4 互引(ADR-0006) |
| **CUT-W10** chunk 级流式透传 | step 内自行消费 chunk 流 | 有意分叉 | 事件面固定四类,不设 chunk 通道(与 agent 篇「chunk 级 processor 裁出 v1」同调)(ADR-0006 / 0005) |
| **B16** 条件里调用 `suspend()` 报错 | 需要条件内挂起 → 显式 step 内 `if` + `suspend()` | 有意分叉 + 验证面欠账 → **P-1** | 条件是只读的——无副作用、挂起点须可定位重进(ADR-0006) |

## 与其它子系统的关系

- **模型层(#9,已定)**:事件流与快照中的流式词汇复用 chunk 协议;step 内用模型走 `ModelInput` 三形状。
- **Agent(#10,已定)**:不复用 agent loop;agent 由用户一行包装进 step;agent 级审批/挂起归 Harness,本规范的快照机制是其底层机器。
- **存储(#15,已定)**:本规范钉 `WorkflowSnapshotStore` port(两个方法 + JSON-only);adapter 家族与扩展面见 `docs/architecture/storage.md`。
- **Harness(#18,已定)**:跨进程恢复与 durable timer 明确裁出;重启自举 = 应用层用 load→重进原语 + 枚举扩展(workflow 侧 `listSnapshots`、durable 侧 `listSuspended`,排序/游标口径见 `docs/architecture/storage.md`);agent 侧审批挂起机器与 schedules 见 `docs/architecture/harness.md`。
- **Observability(#14,已定)**:span 挂在 run / step 边界(run span 覆盖 start / resume 到终态,step span 每次执行一个、name = step id),lifecycle 事件流是其事件锚点,traceId 随快照持久化(resume 续同一 trace);见 `docs/architecture/observability.md`。
- **Memory(#12)**:无直接耦合。

## 依赖预算

核心(含 Workflows)运行时依赖硬线 = 0(数字按 ADR-0001 作内部 CI 回归参考)。storage adapter 与可能的外部 runner 适配归能力包。
