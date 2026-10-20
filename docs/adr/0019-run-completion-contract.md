# Run completion 契约:挂起 Run 正常落定、终态构造单点、结构化 `object` 放宽为 `T | undefined`

2026-10-20 裁决(规范 #200 Phase 1,实施 #201)。本 ADR 记录「一次 Run 如何以其终态记录收尾」的判定与构造规则,以及由此产生的公开类型放宽。

## 背景

- **挂起是正常终态,但终态构造不知道它。** 审批闸(`stepBoundary.beforeToolCalls` 返回 `{ suspend: true }`,Durable agent 的机制)让 Run 以 `finishReason: 'suspended'` 正常落定。终态记录的构造却住在 agent loop 里:只要启用了 `structuredOutput`,它就把「最后一个已完成 Step 的 text」——挂起时为空串或上一个已完成步的文本——当作 Run 的最终答案去做 JSON 解析与 schema 校验。于是挂起 Run 以 `StructuredOutputError` reject:Snapshot 与 `suspendPayload` 已经生成,调用方却拿到一个「失败」的 Run,「先审批、后拿结构化结果」的流程无法成立。
- **同一份终态记录在多处被重建。** Agent loop、Output object 投影、`materialize`、Durable agent、Checkpoints 各自拼装 text / object / toolCalls / toolResults / usage / steps / finishReason;新增终态字段或修改挂起语义要追多处。Phase 1 先把「终态记录怎么构造」收成一点;continuation 抽取与 output-object 公开缝归后续票(#202–#205)。
- **`object` 的公开类型与事实不符。** 它此前是 `TObject`,暗示结构化结果总是存在;而挂起的结构化 Run 根本没有最终答案。

## 决定

1. **终态构造单点。** core 内部 `agent/run-completion.ts`(不导出、不进任何 entry)拥有完成 / 挂起两种 Run 的终态记录构造。Agent loop 只把权威 `steps`、`finishReason` 与 `structuredOutput` 配置交给它。
2. **模式判据 = `finishReason`。** `'suspended'` 即挂起;其余到达该模块的路径都是完成。不新增终态字段。
3. **完成的 Run 语义不变。** `text` = 最后一个权威 Step 的 text(processors 改写后的记录);结构化 Run 照旧严格 JSON 解析 + schema 校验,非 JSON 或 schema 不匹配抛 `StructuredOutputError`;toolCalls / toolResults / usage / steps / finishReason 照旧。
4. **挂起的 Run 正常落定。** 保留已完成 Step 的 text / steps / toolCalls / toolResults / usage(第 0 步挂起即空值);`object` 为 `undefined`;跳过结构化解析与 schema 校验;`finishReason` 为 `'suspended'`。挂起步本身从未完成(无 `processOutputStep`、无 memory save、无 step 记录),其值不进入终态。
5. **失败仍是 rejection。** 失败不建模为终态值,继续以 `processError` 的结果 reject;本模块不参与失败路径。Provider 自报的 `finishReason: 'error'` 与此不同:它是模型给出一条终止记录,仍到达本模块(该 Run 的结构化文本照常校验)。
6. **公开类型放宽。** `AgentStreamResult.object: Promise<TObject | undefined>`,`AgentGenerateResult.object: TObject | undefined`;Durable / Checkpointed / Signals 的结果类型继承同一放宽。运行时行为只在「挂起的结构化 Run」一处变化。

## Considered Options

- **挂起时用空对象 / `null` 占位**:被否——类型说谎(空对象不是 schema 的值),调用方分不清「完成但值为空」与「尚未完成」;`undefined` 是唯一诚实的「没有结果」。
- **有文本就校验、没文本就跳过(机会式校验)**:被否——把 strict 契约变成依赖内容的条件校验;第 N 步挂起时保留的旧文本可能恰好是合法 JSON,会悄悄落一个不属于最终答案的 `object`。
- **类型放宽只落在 Durable / Checkpointed**:被否——同一个输出对象语义,裸 Agent 经公开 `stepBoundary` 也能挂起;局部化会让类型随包装器漂移。
- **终态构造留在 loop / 各包装器**:被否——正是本缺陷的成因;一个字段或一条挂起规则要改多处。
- **把挂起建模为失败**:被否——挂起是等人审批的正常中间态,失败会逼调用方从错误里区分「待审批」与「真故障」,与 Harness 语义(ADR-0011)冲突。

## Consequences

- Durable agent + `structuredOutput` + 审批闸:挂起以 `'suspended'` 正常落定,`object` 为 `undefined`,`suspendPayload` 与 Snapshot 形状不变;resume 完成后仍严格校验并落 `object`。
- 裸 Agent 经公开 `stepBoundary` 触发的挂起与 Durable 同一语义;第 0 步挂起返回空值,第 N 步挂起保留已完成 Step 的值。
- 挂起 Run 的 `agent-run` span 不把 `object` 的 `undefined` 写成 output:已完成 Step 的文本保持为 span output,span 以 `status: 'suspended'` 正常 end;resume 后的完成段再报告结构化结果。
- 完成的普通 / 结构化 Run 与失败 Run 行为不变;`generate()` 与 `stream()` 继续同源。
- **`object` 放宽是类型层 breaking change**:升级者需要处理 `undefined`(通常是先看 `finishReason` / `suspendPayload`)。运行时对完成的 Run 无变化。
- 文档同步:`CONTEXT.md`「Run completion」词条、`docs/architecture/agent.md`、`docs/architecture/harness.md`。
- 后续(不在本 ADR 范围):#202 / #203 把 Durable / Checkpoints 的 continuation 骨架收进公开 `@oribos/core/agent-run`;#204 / #205 公开 output-object 泵与契约套件。届时终态构造仍只在本模块。
- 验证面:`packages/core/test/agent-run-completion.test.ts` 的「完成 / 挂起 × 普通 / 结构化 × 第 0 / N 步」矩阵,加上既有 structured-output / step-boundary / durable-agent 套件与类型层断言。

(来源:规范 #200 Phase 1;实施 #201)
