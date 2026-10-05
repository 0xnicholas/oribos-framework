# Agent 核心抽象

> 来源:wayfinder ticket #10(决策:Agent 核心抽象)。本文件是 Agent 子系统的架构规范。
> 决策记录见 `docs/adr/0005-agent-core-surface.md`(多 agent 组合见 `0012-multi-agent-collaboration.md`);术语见 `CONTEXT.md`。

## 定位

Agent 是框架的核心执行单元:把 name、instructions、model、tools 包装成可 `generate()` / `stream()` 的对象。词汇与体验对齐 mastra,交付遵守轻量轴:**定义表面刻意最小,横切能力一律走 Processor,重能力挂在包边界与子系统协作上**(ADR-0005)。字段取舍的总原则是可逆性不对称——后加可选字段是 minor,删字段是 major,所以默认砍、证明需要再加。

## 定义表面

```ts
interface AgentConfig {
  name: string                                   // 必填,唯一标识(不单设 id)
  instructions: DynamicArgument<string>          // 必填
  model: ModelInput                              // 必填,形状继承模型层规范
  tools?: DynamicArgument<Record<string, Tool>>  // 可选
  description?: DynamicArgument<string>          // 可选,as-tool 组合时给上游模型看
  tracer?: Tracer                                // 非定义字段:观测注入缝(M1-09,见下)
  processors?: readonly Processor[]              // 非定义字段:横切扩展点挂载位(M1-12,见下)
}
```

- **动态参数**:所有字段接受 `T | ((ctx: RequestContext) => T | Promise<T>)`,每次执行按请求上下文解析(实现原语 `resolveDynamicArgument(value, ctx)`)。run 在调用模型之前解析 `instructions` / `model` / `tools`,解析上下文与工具 `ctx.requestContext` 是同一份对象;`description` 不进 run——as-tool 包装在构造 Tool 时用同一原语取值(Tool 的 description 是构造期静态字段,见「多 agent 组合」)。`RequestContext = { signal: AbortSignal, runId: string, ...用户 per-call 开放属性袋 }`,纯对象,无 `Agent<TContext>` 泛型。
- **instructions 仅 string**:mastra 的 string[] / SystemMessage / providerOptions 联合全砍,provider 级能力(缓存控制等)证明需要后再加。
- **tools 容器**:`Record<string, Tool>`,键即工具名,构造期完成唯一性校验(Record 键天然唯一,重名在编译期即被拦截)。Tool 自身定义(Standard Schema 入参、execute 签名)见「Tools/MCP 抽象」规范(`docs/architecture/tools.md`)。
- **memory**:一等可选字段。本规范只钉三件事:字段存在、可选、读写时机固定(模型调用前 recall、每个 step 后 save);接口方法与 thread/resource 语义归「决策:Memory 语义」。
- **组合根关系**:独立 `new Agent(...)` 是一等用法,不强制注入;横切依赖(tracer 等)经组合根分发时 Agent 被动接受,不感知其存在——组合根 `createApp({ tracer })` 的 `app.agent(config)` 建出的 Agent 即已接受分发,配置自带 tracer 时显式优先。**tracer 注入缝**:`AgentConfig.tracer` 接受观测子系统实例(组合根分发或独立 new 显式传入),不属定义表面——不是可被 Processor/能力包承载的能力,而是子系统装配位;缺席时 run 不创建任何 span 对象(零开销),三边界埋点与 trace 续接见 `docs/architecture/observability.md`。

## 执行语义

- **输入**:`string | Message[]`,Message **直通模型契约的 vendor prompt 类型**——不发明自有消息格式,内部流转与 Memory 存储同一格式;spec 升级时格式跟随,由模型层的 major 跟随策略兜底。
- **输出对象**:`stream()` 返回的对象同时支持两种消费:`for await` 消费 chunk 协议流,`await` 其 promise getter(`text` / `object` / `toolCalls` / `toolResults` / `usage` / `steps` / `finishReason`)拿最终结果。**`generate()` 内部 = `stream()` + await 终值,单一代码路径**,不存在双实现。chunk 在消费者慢于生产时**无界缓冲、无背压**——消费节奏是消费者侧责任(提前 break 只丢缓冲,run 照跑完)。
- **术语两层**:**run**(一次 generate/stream 调用的完整执行)> **step**(一轮模型调用 + 工具执行;fallback 链的多次模型尝试同属这一轮,不另成 step);mastra 的第三层 model step 不收。
- **finishReason**:`'stop' | 'length' | 'tool-calls' | 'error' | 'suspended'`(`tool-calls` 表示 maxSteps 耗尽时模型仍要求工具调用;`'suspended'` 只在 `createDurableAgent` 包装内由审批闸产生,裸 agent **不传 `stepBoundary` seam 时**不出现(该 seam 是公开 run option,显式传入即产生)——见 `docs/architecture/harness.md`)。
- **steps[]**:每步的 text / toolCalls / toolResults / usage 轻量记录,调试、Observability、Workflow 快照共用;`usage` 另有全 run 累计值。
- **执行选项**:`maxSteps`(默认 5)/ `modelSettings`(temperature 等透传袋)/ `providerOptions`(透传)/ `signal`(AbortSignal,沿工具调用与动态参数解析传播)/ `traceId?` + `parentSpanId?`(trace 续接,见 `docs/architecture/observability.md`;as-tool 组合经工具 ctx 六件套取值)/ `hideInput?` + `hideOutput?`(本次 run 的擦除覆盖,透传为 root span 的创建选项,见 `docs/architecture/observability.md`)。
- **structuredOutput**:一等支持 run option `structuredOutput: { schema }`,schema 走 Standard Schema 契约(ADR-0003):经 `~standard.jsonSchema` 出 JSON Schema(draft-07,与工具 schema 同一转换)随每次模型调用下发为 `responseFormat`,run 终值文本(processors 改写后的权威记录)按 JSON 解析并校验,结果落 `object`;校验策略固定 strict(失败即报错,抛携带原文与 issues 的 `StructuredOutputError`,不做 errorStrategy 多选一)。不传即纯文本路径:不发 `responseFormat`,`object` 为 `undefined`。

## Agent loop

- **归属**:loop 是 Agent 子系统内部实现,围绕模型契约构建(继承「决策:模型层策略」);Workflows 不复用 agent loop,共享 chunk 协议与 step 词汇即可。
- **停止条件**:模型返回不含 tool-call 即停;`maxSteps`(默认 5,正整数)封顶。不做 stopWhen DSL。`maxSteps` 耗尽前的最后一步照常完整执行(它的 tool-call 已由模型发出),只是结果不再回喂;终值 `finishReason` 为 `'tool-calls'`(截断信号归框架,不 relay provider 的原始 reason)。
- **工具执行顺序**:同一步的多个 tool-call 按调用顺序**串行**执行,结果按调用顺序并入该步;并发策略 v1 不做,留待需求信号。provider 已执行的工具调用(该步内同 toolCallId 已有结果)不重复执行。
- **错误回喂**:execute 抛错捕获为 error 工具结果**回喂模型**,由模型自行恢复或放弃,run 不中止;需要硬停的场景经 Processor 实现。
- **审批 / 挂起**:不在核心,由「决策:Harness 语义集」(#18,已定)承接——`createDurableAgent` 包装的工具调用边界审批闸 + loop 快照,见 `docs/architecture/harness.md`;核心 loop 保持无快照。

## 扩展点:Processor

Processor 是 Agent 的**唯一横切扩展点**(ADR-0005):guardrails、evals、脱敏、限流等不得以字段形式焊进 Agent 类。挂载位 = `AgentConfig.processors?: readonly Processor[]`——与 `tracer` 同为接线注入缝,不占定义表面。每个钩子按声明顺序**串行执行**,前一个处理器的返回是后一个的输入;钩子可同步或异步,返回 `void` / 不返回即保持原值。v1 三钩:

- `processInput({ messages, requestContext })` → `{ messages }` — run 开始一次(动态参数解析之后、首次模型调用之前),可改写本次 run 的初始 prompt(instructions 系统消息 + 输入消息);返回值即模型实际看到的 prompt。
- `processOutputStep({ step, stepIndex, requestContext })` → `{ step }` — 每个 step 完成后一次(该步模型流结束、工具执行完、错误结果就位之后),可见可改 step 记录。**改写后的记录是 run 的权威记录**:终值 `steps` / `text` / `usage` 与 agent-run span 的 output 读它,下一轮 prompt(assistant 消息与 tool 消息)由它构造,processOutputStep 先于 save 的顺序语义也落在它上(M2);chunk 流与 agent-step span 仍是模型原始产出(chunk 级改写裁出 v1)。
- `processError({ error, source, stepIndex, toolCall?, requestContext })` → `{ error }` — provider / 工具错误时,观察并可替换错误,不做 abort/retry。`source: 'model'` 替换 run 终错(链耗尽 / 流中途失败 / 流契约违背;已取消的 run 不触发);`source: 'tool'` 替换进入 error 工具结果的错误(execute 抛错、input/output 校验失败、未知工具——execute 抛错保留框架的 `Tool 'x' failed:` 框,替换只填细节)。替换后的错误即该边界终错(run 终错 / 回喂模型的错误),span 随之记录。

Processor 钩子自身抛错即 run 失败,不再交给 `processError`(处理器不互相处理)。chunk 级流式 processor(processOutputStream 类)裁出 v1,保留向后扩展位。Observability 的 tracer 挂钩是内部缝(见 `docs/architecture/observability.md`),不占 Processor 名额。

## 多 agent 组合

**规范形态 = as-tool 组合,核心零内建协议**(ADR-0012,正式了结 ADR-0005 的暂缓项):Agent 不认识 sub-agent,无 `agents` 字段、无委派协议。组合 = 把 Agent 包装为 Tool 挂进父 agent 容器——`description` + `generate` 签名天然是一个 Tool 的 execute。Tool 的 description 是构造期静态字符串,故动态 description 在包装处用 `resolveDynamicArgument` 取值(包装本身可以是父 agent 动态 `tools` 解析器里的一次逐请求构造),委派 run 的输入仍由包装器显式构造:

```ts
const researcherAsTool = async (ctx: RequestContext) =>
  createTool({
    description: (await resolveDynamicArgument(researchAgent.description, ctx)) ?? researchAgent.name,
    inputSchema: z.object({ prompt: z.string() }),
    execute: (input, { signal, traceId, spanId }) =>
      researchAgent.generate(input.prompt, { signal, traceId, parentSpanId: spanId }),
  })
```

组合语义要点:

- **上下文零透传**:委派输入由包装器显式构造,父 run 上下文默认一字节都不传给 sub-agent。mastra 委派协议的 messageFilter / delegation 钩子 / result references 全服务于「委派隐式共享父上下文」这一前提;显式组合下它们退化为用户态平凡代码——裁剪上下文 = 构造 prompt,钩子 = 包装器前后代码,结果引用 = 包装器持有历史注入 prompt。
- **取消与观测沿链**:`signal` 透传一行;`traceId` / `spanId` 经工具 ctx 取出(Tools 规范六件套),委派 run 挂为当前 tool-call span 的子 span,多 agent 观测树不断裂。父侧无 trace(未挂 tracer 或采样不通过)时,工具 ctx 的两个字段是空串——空串不是可续接的 parent,委派 run 起自己的新 trace,不产生空 trace id 的残破 span。
- **memory**:默认无状态(包装器不传 memory);带记忆委派 = 显式传 `memory: { thread, resource }`,thread 策略(每次委派新 thread / 固定 thread)归应用。
- **嵌套审批不支持**:审批闸只挂最外层入口 agent(`createDurableAgent`,见 `docs/architecture/harness.md`);内层 sub-agent 不做 durable 包装,其工具直接执行——要闸内层危险工具就上提到父级闸。sub run 以 `suspended` 收尾时,包装器按普通文本结果回喂父模型;恢复 = 应用层 resume sub + signal 唤醒父(Harness 原语组合,无新机制)。
- **演化门**:真实需求信号(as-tool 模式的重复痛点——包装样板、传播遗漏、嵌套审批诉求)触发重开内建问题;落点 = `createSupervisor` 类能力包优先,仅当其证明需要核心新缝时才以 minor 字段进核心(ADR-0012)。

## 砍单与承载缝

判定口径见 `docs/ROADMAP.md`「下一阶段(完善)」;`A*` 行 = 对比总账 §3「形状内语义差异」(`docs/research/mastra-gap-analysis.md`),`CUT-AG*` 行 = 审计 §2 砍单行集(`docs/research/completeness-audit.md`)。判定三值:有意分叉 / 已兑现(非差异) / 提升(→ 必须项表 ID)。

| 项 | 承载缝 | 判定 | 理由·ADR 指针 |
| --- | --- | --- | --- |
| **A1** `instructions` 仅 string | `processInput` 可改写系统消息;动态 `instructions` 函数可拼装多段 | 有意分叉 | 可逆性不对称——后加可选字段是 minor、删字段是 major;provider 级能力(缓存控制等)证明需要后再加(ADR-0005) |
| **A3** `structuredOutput` 只 strict | `processError` / `processOutputStep` 承载重试与修补 | 有意分叉 | 失败即报错、不静默降级、不做修复轮;与工具校验「失败即报错」同调(ADR-0005;`docs/architecture/tools.md` 校验语义) |
| **A6** `maxSteps` 耗尽 → `finishReason: 'tool-calls'` | `steps[]` + `usage` 可判「第 N 步仍在要求工具」 | 有意分叉 | 截断信号归框架、不 relay provider 原始 reason,`finishReason` 五值冻结(ADR-0005 / 0004) |
| **A2** 同一步多工具**串行** | 工具自身可内部并发;需求信号到 → 按 run 开关 | 有意分叉 + 验证面欠账 → **P-1** | 并发策略 v1 不做、留待需求信号——顺序确定、失败路径单一、abort 语义简单(ADR-0005) |
| **CUT-AG1** scorers / evals | Processor 或独立 scorer 消费 run 结果(`steps` / `text` / `usage` 均公开面) | 有意分叉 | evals 是 CI / 线上的断言体系,超出 agent 定义表面;Processor 三钩是唯一横切点(ADR-0005);延后清单「Evals / scorers」 |
| **CUT-AG2** voice / browser / channels / workspace / skills | 能力包 / 应用层;`browser` 具名入延后清单出域档行,`skills` → [#84](https://github.com/0xnicholas/oribos-framework/issues/84) | 有意分叉 | 六项皆平台 / 应用层能力面,与「定义表面最小 + 零权限模型」立场一致(ADR-0005) |
| **CUT-AG3** editor / rawConfig | 应用层 / 宿主工具链 | 有意分叉 | Studio / editor 出域——定位裁决改变才重开(ADR-0005);延后清单「Studio / editor / stored agents」 |
| **CUT-AG4** durable / pubsub / backgroundTasks / signals / goal / notifications | **已兑现段**:durable / signals(含进程内 pubsub)已成独立子系统并冻结(`docs/architecture/harness.md`,ADR-0011)。**剩余三件指针**:backgroundTasks → 延后清单「Background tasks」;goals → 延后清单「Goals / State signals」;notifications → `sendSignal({ type: 'notification' })` 即时注入 | 已兑现 + 有意分叉 | 本行「砍的是字段位置」的原表述随 durable / signals 出账失效;剩余三件是能力形缺口,不是字段位置(ADR-0005 / 0011) |
| **CUT-AG5** defaultOptions / metadata | 用户一行包装 + 组合根 `createApp` 分发;metadata 走观测的开放袋 → `oribos.metadata` | 有意分叉 | 全局默认归组合根 / 宿主职责;run 级开放袋归观测(ADR-0002 / 0009) |
| **CUT-AG6** hooks / transform / maxRetries | `processInput` / `processOutputStep` / `processError` + 模型 fallback 链 | 有意分叉 | Processor 三钩是唯一横切点,不引入第二套钩子矩阵;重试归 fallback 链(仅未产出 chunk 时切换)(ADR-0005 / 0004) |
| **CUT-AG7** 标题生成 | 应用层;要走模型 → Processor + metadata | 有意分叉 | 标题是产品态不是 agent 语义;`title` 是调用方字段(ADR-0005 / 0007) |

## 与其它子系统的关系

- **模型层(#9,已定)**:继承 `ModelInput` 三形状、chunk 协议、零依赖红线。
- **Memory(#12)**:本规范钉住字段存在性与 recall/save 时机;接口与 thread/resource 语义归它。
- **Tools/MCP(#13,已定)**:容器形状 `Record<string, Tool>`;Tool 定义与 MCP 能力包见 `docs/architecture/tools.md`。
- **Workflows(#11)**:不复用 agent loop;chunk / step 词汇共用。
- **Observability(#14,已定)**:span 挂在 run / step / 模型调用上,形态见 `docs/architecture/observability.md`。
- **Harness(#18,已定)**:审批挂起、durable、signals 注入归它,形态见 `docs/architecture/harness.md`;loop 为它开的唯一缝 = step 边界注入检查(缺席零开销)。

## 依赖预算

核心(含 Agent)运行时依赖硬线 = 0,与模型层同一红线(ADR-0001 作内部 CI 回归参考)。
