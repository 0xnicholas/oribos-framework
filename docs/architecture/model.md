# 模型层 (Model Layer)

> 来源:wayfinder ticket #9(决策:模型层策略)。本文件是模型子系统的架构规范。
> 决策记录见 `docs/adr/0004-model-layer-dual-track.md`;术语见 `CONTEXT.md`。

## 定位

**双轨**:核心自有的模型抽象与 agent loop,模型契约在**类型级**兼容 AI SDK 的 provider spec——用户把 `@ai-sdk/openai` 等生态包产出的模型实例直接传入,核心不依赖 AI SDK 运行时。与 AI SDK 的格式互操作(UI stream 转换、`useChat` 路由)收敛在独立的 AI SDK 互操作**能力包**中,核心对它零依赖。

## 模型契约

- 核心内 **vendor 最小结构类型声明**:当前一代 AI SDK provider spec 中实际被消费的接口子集(`specificationVersion` / `provider` / `modelId` / `doGenerate` / `doStream` + prompt 与流 part 类型)——语言模型接口之外的模型类型(embedding / image / speech …)不 vendor。核心零运行时依赖、零类型依赖;TS 结构类型使各 provider 包的实例天然满足契约。
- **保真压过行数**:union 型 part(prompt 消息 / 模型 content / 流 part)必须逐 variant 覆盖,否则真实 provider 实例在结构上不可赋值;规模因此由 spec 表面决定(落地约 480 行纯类型,含 JSDoc),不设行数上限。工具 schema 用自有 `JsonSchema`(draft-07 子集),不引 `@types/json-schema`。
- **锁定单一 spec 版本**。模型解析时硬断言 `specificationVersion`,不匹配即在解析期抛显式错误,指出该升级框架还是降级 provider 包。
- **版本跟随策略**:AI SDK 发布新一代 spec → 本框架升自己的 major,只支持新 spec;留在旧 provider 包的用户留在本框架旧 major。永不做多 spec 适配器。
- 漂移防护:CI 类型测试以 devDependency 中的真实 `@ai-sdk/provider` 对校 vendor 类型。

## model 字段形状

凡接受模型的位置(Agent 配置、结构化输出专用模型等),统一接受三种形状:

```ts
type ModelInput =
  | Model                                            // 满足模型契约的实例
  | Model[]                                          // fallback 链
  | ((ctx: RequestContext) => Model | Model[] | Promise<Model | Model[]>) // 动态解析
```

- **fallback 语义(初版保守)**:每次模型调用按数组顺序逐项尝试;仅在"该次尝试尚未产出任何 chunk"的失败时切换下一项;流中途失败不切换、直接报错(部分输出已发给调用方,切换会产生拼接幻觉)。错误上下文沿链保留(链上全部失败时,错误含每个候选与各自错误;单候选链的失败原样浮出)。
- **动态函数**:每次执行按请求上下文解析,一个 union 类型换来多租户、按 tier 选模型等表达力。

此形状由 [决策:Agent 核心抽象](https://github.com/0xnicholas/oribos-framework/issues/10) 继承。

## Chunk 协议

- 核心定义**自有最小 chunk 类型集**,是 `stream()` 输出、processors、workflow step 快照、observability 事件共用的流式词汇。落地四种:`text-delta` / `tool-call`(input 已解析为 JSON)/ `tool-result` / `finish`(携带 `FinishReason` 与 `Usage`);推理增量、参数增量等 part 不进协议。
- `FinishReason` 收敛为 `'stop' | 'length' | 'tool-calls' | 'error' | 'suspended'`;provider 的 `content-filter` / `other` 归入 `'stop'`(终态但非失败——报 `'error'` 会诱使对已被策略拒绝的请求重试)。
- 模型 spec 原生流 → chunk 协议的归一化层在核心内,保持薄:`error` part 直接抛出;非法工具输入保留原始字符串,交由工具边界作校验失败回喂模型。
- **核心不透出 AI SDK 流格式**;chunk → AI SDK UI stream 的转换器在互操作能力包。

## Provider 生态

- **无自有 provider SPI、无注册表、无 `'provider/model'` magic string。** AI SDK 生态的 provider 包就是插件机制;网关类需求(OpenRouter 等)由对应 provider 包承担。
- 自定义端点(Ollama / LMStudio / OpenAI-compatible 网关):用户自装 `@ai-sdk/openai-compatible` 类现成包,核心无特殊机制。
- 字符串路由(models.dev 目录 + 解析器)若做,是独立能力包——已登记地图 Not yet specified,路线图阶段再判断。

## AI SDK 互操作能力包(M5 设计冻结)

> 决策:wayfinder ticket #77(决策:AI SDK 互操作包)。包名 `@oribos/ai-sdk`(沿 ADR-0002 M5 修订记),对 `@oribos/core` 走 peer、与核心锁步发布;事实底座 = `docs/research/ai-sdk-ui-stream-protocol.md`(2026-09-30 实测,版本钉 `ai@7.0.123`)。下文的「已发帧子集」是客户端可见的协议承诺,实现只许收窄。

### 包面

- `toAISdkStream(stream: AsyncIterable<Chunk>, options?: { onError?: (error: unknown) => string }): AsyncIterable<AISdkStreamChunk>` — 转换器(体帧;源流失败时发 `error` 帧收尾)。
- `createChatRoute({ agent, identity, onError?, keepAliveMs? }): (request: Request) => Promise<Response>` — Web 标准 `useChat()` 路由。
- `toAISdkMessages(messages: readonly StoredMessage[]): UIMessage[]` — thread 历史回读(同步纯函数)。
- `AISdkStreamChunk` — 本包封闭帧联合,结构兼容 AI SDK `UIMessageChunk`;发布物不引 `ai` 类型(类型级零依赖)。

### 目标协议与漂移纪律

- 目标 = `ai@7` 代 UI message stream **词汇表** + 线级响应头 `x-vercel-ai-ui-message-stream: v1`(官方要求;客户端不校验,网关可能看)。
- **单一代、无 `version` 选项、不做多代适配器**(本 ADR「锁定单一 spec 版本」原则推广到 UI stream 协议):AI SDK 词汇表换代 = 本包 breaking,锁步发布下随全 `@oribos/*` major 走,旧代不承诺。
- 客户端白名单逐帧解析:已发帧子集**可小于**目标词汇,**不得超出**(未知 `type` 整流抛错)。
- 对校:`ai` 精确钉 `devDependencies`(`7.0.123`),升级为有意 PR;三条对校——帧联合对 `UIMessageChunk` 类型可赋值 / 产物 SSE 字节 → `parseJsonEventStream(uiMessageChunkSchema)` → `readUIMessageStream` 往返断言 / 响应头常量与 `UI_MESSAGE_STREAM_HEADERS` 全等。

### 转换器:`toAISdkStream`

- 输入 `AsyncIterable<Chunk>`(只吃流面——agent / durable / signals 订阅同一入口);输出帧对象流,SSE 编码不在转换器(归 route / 宿主)。
- **职责切分:转换器只产体帧**;消息级 `start` / `finish` 由调用方写(`finish` 的 reason 与 metadata 需要终值,转换器看不到)。
- 帧映射(逐行冻结):

| Oribos | 发出 | 规则 |
| --- | --- | --- |
| — | `start-step` | 流首帧前一条;`finish-step` 之后的下一条**模型产出**帧前补下一条(`tool-result` 不触发) |
| `text-delta` | 惰性 `text-start` + `text-delta` | 块 id 合成;连续 delta 一段,遇任何非 text 帧(含 `tool-call` / `finish`)补 `text-end` |
| `tool-call` | `tool-input-available` | 仅此一帧——无参数增量可发;`providerExecuted: true`(框架端执行,挡客户端 `onToolCall` / 自动续发)、`dynamic: true`(客户端不知道工具 schema);raw-string input 不做启发式判定,校验失败以结果 `isError` 回来 |
| `tool-result` | `output-available` / `output-error` | `isError` 分流;`errorText` = string 原样,否则 `JSON.stringify`(失败回退 `String()`);`providerExecuted: true` |
| `finish`(每 step) | `finish-step` | **保持原序**(该 step 的 `tool-result` 排在其后);客户端 reducer 原位更新、容错已实证 |
| 源流抛出 | `error` | 默认脱敏 `"An error occurred."`,`onError` 可换;随后由调用方收尾 |

- **不发清单**(显式声明):`reasoning-*`、`tool-input-start` / `tool-input-delta` / `tool-input-error`、`tool-approval-*`、`source-*`、`file`、`reasoning-file`、`custom`、`data-*`、`reset-step`、独立 `message-metadata`、`abort`——无法从 chunk 协议重建的帧一律不外发;挂起表达走消息级 metadata(见下)。

### 路由:`createChatRoute`

- `(request: Request) => Promise<Response>`,`POST` only(其余 405 + `Allow: POST`);agent / durable agent 同一入口,Next / Hono / 裸 node 的接线归宿主范式(实施 / 示例)。
- **run 输入 = memory 权威**:thread = `identity(request)` 返回的 `{ thread?, resource }`(thread 缺省 `body.id`),resource 必填(授权归应用);`messages` 只取**尾部 user 消息**转 `ModelMessage[]`(text / file 起步,其余 part 类型 400);历史一律走 thread recall,不与客户端全量回放双喂;`trigger` 不分支(`regenerate-message` = 重跑尾条,消息不可变表现为追加)。
- `start` 帧**不带** `messageId`——客户端持有自生成的 assistant 消息 id(`body.messageId` 是尾条消息 id,不作 UI id 用)。
- **HTTP 机制**:body 白名单 `id` / `messages` / `trigger` / `messageId`(只读前两者;`modelSettings` / `maxSteps` 等永不从 body 读);400(JSON 无效 / 尾条非 user / `id` 缺失)与 405 给具体原因,首帧前失败 500(默认脱敏 + `onError`,真错误进 tracer),错误体统一 `{ error: string }`;首帧后失败 → `error` 帧 + `finish { finishReason: 'error' }` + `[DONE]`(HTTP 200);响应头 = 官方 5 件套;`keepAliveMs` 默认关(被代理缓冲的部署显式打开);同 thread 并发不设锁(thread 导向机制是 signals,本路由是请求-响应适配器)。
- **取消**:`request.signal` 直传 run 的 `signal`,响应流 `cancel()` 同接 abort;无恢复端点(AI SDK `resume: true` 与 abort 不互容,核心 resumable stream 已裁)。
- **终帧**:`finish { finishReason, messageMetadata? }`;`finishReason` 映射 `stop→stop` / `length→length` / `tool-calls→tool-calls` / `error→error` / `suspended→other`;`messageMetadata = { usage, suspended? }`(usage 恒写,= run 累计;suspended 仅挂起时)。

### 挂起表达(durable agent)

- 挂起不在 chunk 流里(流以模型自己的 `finish(tool-calls)` 收尾);route 读终值后在终帧表达:`finishReason: 'other'` + `messageMetadata: { suspended: { runId, awaitingApproval } }`。
- **不合流 `tool-approval-*`**:AI SDK 逐 `approvalId` 的流内审批与 Oribos run 级挂起 / 快照是两套机制,且审批决定是单布尔(N:1),合流会把错位藏进实现。
- resume 编排归应用(自调 `durable.resume`;实施图给范式);重开条件 = 真实用例要求一键审批 UX。

### 订阅流表达(signals)

- `toAISdkStream` 直接吃 `signals.subscribeToThread(...)`:一个订阅 = **一条持续 UI 消息**(`start` 由调用方写,`finish-step` 按 step 落,消息级 `finish` 在断开 / 收尾时写)。
- 逐 run 消息切分**不做**:订阅通道只有 chunk、无 run 边界标记,`finish(tool-calls)` 收尾的 run 与 step 续跑不可分辨(step cap 与挂起同形);重开条件 = 真实用例要求逐 run 消息(届时核心 signals 需加 run 边界事件,另票)。

### 历史回读:`toAISdkMessages`

- 输入升序 `StoredMessage[]` → `UIMessage[]`;user 消息一条;user 之后的极大 assistant / tool 序列折叠为**一条** assistant UIMessage:text → text part、tool-call → tool part(`input-available`)、同序列第二条起 assistant 前插 `step-start`、tool-result 按 `toolCallId` 折入对应 part(正常 → `output-available`、`error-*` → `output-error`、`execution-denied` → `output-denied`;assistant 内联的 provider-executed 结果同规则)。
- 宽容原则:配对不上的结果、未知 part 类型(reasoning / custom / reasoning-file)跳过不抛错;不做 system / 工作记忆。
- UIMessage id 取折叠序列首条消息 id;与在途流的客户端自生成 id 不一致属已知(跨刷新 id 重生成,文档写明)。

### 裁单

本包的裁单与重开条件归口于篇章级「砍单与承载缝」表(CUT-M1–M5 行),此处不再重列——单一真相源。


## 依赖预算

- **核心(含模型层)运行时依赖硬线 = 0**。模型层是全框架最不可能裁剪的子系统,正因如此它必须守住零依赖,否则"按需组合"名存实亡。
- 互操作能力包运行时依赖硬线 = 0;`ai` 仅 devDependency(对校,见上节),数字口径归 `deps-budget.json`。所有数字按 ADR-0001 作内部 CI 回归参考(超预算 PR 亮黄灯),不对外承诺。

## 砍单与承载缝

判定口径见 `docs/ROADMAP.md`「下一阶段(完善)」;`A*` 行 = 对比总账 §3「形状内语义差异」(`docs/research/mastra-gap-analysis.md`),`CUT-M*` 行 = 审计 §2 砍单行集(`docs/research/completeness-audit.md`)。判定三值:有意分叉 / 已兑现(非差异) / 提升(→ 必须项表 ID)。本表是**篇章级单表**:AI SDK 互操作能力包的裁单行也在此(保留「重开条件」列)。

| 项 | 承载缝 | 判定 | 理由·ADR 指针 | 重开条件 |
| --- | --- | --- | --- | --- |
| **CUT-M1** 反向互操作(`withMastra` 类:给纯 AI SDK 用户套 processor / memory) | `Memory` 类可独立 `new`(port 直用);processor / 挂起点属自有 loop——纯 AI SDK 侧只能手写等价钩子 | 有意分叉 | 方向倒置:核心须接受 AI SDK 流 part 词汇作回调输入,把外部流格式塞进自有 seam;永久兼容面(ADR-0004) | ≥1 真实用例(AI SDK 原生应用在其 `streamText` 循环里用 memory / processor 且接受外部依赖) |
| **CUT-M2** workflow / network 路由(mastra `workflowRoute` / `networkRoute` 类) | 应用端点自行把 workflow 事件流 / run 记录映射为 UI 流(事件面公开) | 有意分叉 | 本包只做 agent chunk 面;workflow lifecycle 事件流是另一套词汇(ADR-0004 / 0006) | 真实用例要求 workflow run 直出 UI stream |
| **CUT-M3** AI SDK `resume: true` 的 GET 恢复端点 | 应用自建 GET 端点;事件缓存归应用 | 有意分叉 | 官方明言 resume 与 abort 不互容;核心 resumable stream 已裁(ADR-0004) | 沿 `docs/ROADMAP.md` 延后清单「resumable stream」 |
| **CUT-M4** 无状态全量 `UIMessage[] → ModelMessage[]` 转换 | `ModelInput` 三形状直通(`Message[]` 直传);缺的只是 UI part → `ModelMessage` 转换件,由用户侧承担 | 有意分叉 | 与 memory 权威双喂冲突;无状态 chat 不是本框架形态(ADR-0004 / 0007) | 真实用例要求无 memory 的纯无状态路由 |
| **CUT-M5** typed 工具渲染(`dynamic: false` 直通) | `dynamic: true` 兜底(tool part 带 input 已可渲染);typed 诉求由客户端按 `toolName` 自查 | 有意分叉 | 工具 schema 只在服务端,客户端类型面不可知(ADR-0004) | 真实用例要求 typed 工具 part(opt-in minor) |
| **A4** chunk 协议仅四帧(无推理增量 / 参数增量) | **无**——数据不可恢复:互操作包同样跳过(`reasoning-*` / `tool-input-*` 在归一层静默丢弃,`usage` 仍计 reasoning tokens) | 有意分叉 | 词汇最小 + 单一 spec 版本 + 外部格式转换归互操作包(ADR-0004) | 真实用例要求思考流 / 工具参数流式 → 加帧(additive minor) |
| **A5** fallback 仅在该次尝试**未产出任何 chunk** 时切换 | 外层重试(调用方或 `processError`) | 有意分叉 | 流中途失败不切换候选——不重复输出、不产生半截文本歧义(ADR-0004;对比总账 §1「本框架更保守」) | —(未立;需真实用例) |

## 与其它子系统的关系

- **Agents(#10)**:继承 model 字段形状与 chunk 协议;agent loop 围绕模型契约构建。
- **Workflows(#11)**:step 边界 JSON 快照与流式事件复用 chunk 协议词汇。
- **Observability(#14,已定)**:`agent-step` span 的 model/provider/usage/finishReason 取自模型契约的 finish/usage chunk;见 `docs/architecture/observability.md`。
- **Memory(#12)**:如需 embedding 模型,复用同一契约模式(接受 AI SDK spec 的 EmbeddingModel 实例、vendor 结构类型),届时确认。
- **Harness(#18,已定)/Signals**:互操作包的挂起表达与订阅流表达见上节(durable 挂起 → `finishReason: 'other'` + `messageMetadata.suspended`;`subscribeToThread` → 一条持续 UI 消息)。
