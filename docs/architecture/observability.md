# Observability 形态

> 来源:wayfinder ticket #14(决策:Observability 形态)。本文件是 Observability 子系统的架构规范。
> 决策记录见 `docs/adr/0009-observability-tracing.md`;事实底座见 `research/observability-references` 分支 `docs/research/observability-references.md`;术语见 `CONTEXT.md`。

## 定位

观测子系统回答一个问题:run 内部发生了什么。设计遵守轻量轴:**内核自有最小 span 模型、核心零 OTel 依赖,OTel 映射外置为单一 OTLP 能力包**。北极星是出口收敛——内核怎么建模是自己的事,送出去的都是 GenAI semconv 形状,Langfuse / LangSmith / 各家 OTel 后端直接可收。v1 只定 tracing;metrics 不做、logs 走组合根的 logger 通道(`createApp({ logger })` 槽,经 `app.workflow()` 分发、committed 定义以 `Workflow.logger` 暴露;内核自身无 log 埋点,通道是 logs 的唯一钦定路径,OTel logs 维持砍单)。

内核不自建 OTel span 的原因(ADR-0009):GenAI semconv 全部属性均为 Development 稳定性,JS 侧 `gen_ai.*` 常量只在 incubating export——把内核焊在 OTel 上是把变更风险请进核心;mastra 与 Vercel AI SDK 的实际选择同为「内核自有模型 + OTel 外置可选包」。

## Span 模型

```ts
interface Span {
  id: string,                         // 16-hex,OTel 兼容
  traceId: string,                    // 32-hex,OTel 兼容
  parentSpanId?: string,
  name: string,
  type: string,                       // 开放字符串;框架只写 7 个常量(下表)
  startTime: Date,
  endTime?: Date,
  input?: unknown,                    // 一等公民:prompt 是 LLM 调试主体
  output?: unknown,
  attributes?: SpanAttributes,        // 按 type 收窄的判别联合
  metadata?: Record<string, unknown>, // 用户开放袋
  error?: { message: string, details?: unknown },
  isEvent?: boolean,                  // 时间点 span:无 endTime,创建即导出
}
```

- **7 个框架类型常量**(kebab-case,与 chunk 协议词汇同构):`agent-run` / `agent-step` / `tool-call` / `workflow-run` / `workflow-step` / `memory-recall` / `memory-save`。`type` 是开放 string,用户自建 span 任意取名;核心导出 7 个常量。
- **attributes 判别联合**(运行时零成本,OTLP 映射包读取有类型安全):

| type | attributes | input / output |
| --- | --- | --- |
| `agent-run` | `{ agentName }` | 处理后 prompt(模型所见)/ 终值 text(或 structured 结果) |
| `agent-step` | `{ model, provider, parameters?, usage?, finishReason?, timeToFirstChunk? }` | prompt 消息 / 模型响应 |
| `tool-call` | `{ toolCallId }` | 参数 / 结果;失败落 `error` |
| `workflow-run` | `{ workflowId }` | 触发输入 / 终态结果 |
| `workflow-step` | `{ }`(name 即 step id) | step 输入(边界校验后的值)/ 输出;校验失败落 `error` |
| `memory-recall` | `{ threadId }`(name 即 thread id) | recall 查询 / 召回的消息(含存储信封) |
| `memory-save` | `{ threadId, resourceId }`(name 即 thread id) | 落库批次 / 持久化后的消息(含存储信封) |

`agent-run` span 先于 memory recall 创建(root span 存在,recall span 才能挂它下),其 input 是 `processInput` 处理后的 prompt(含注入的工作记忆与历史),故以一次 `span_updated` 落定而非创建时;memory 两侧的失败落在各自 span 的 `error` 上并随 run 抛出。

- **root span attribute 带 `runId`**:runId 是执行身份(快照/Memory 已用),traceId 是观测身份,两者不同词、靠 root span 互查。
- **`isEvent` span**:无生命周期,创建即完成,只派发一次 `span_ended`(无 duration)。是「不想开完整 span 只打时间戳」的逃生口。
- **活 span API**(tracer.startSpan 返回):`end()` / `update(patch)` / `error(err)`;导出形态 `ExportedSpan` 去方法、去循环引用,加 `parentSpanId`。`error` 在活 span 上是记录方法,与数据字段同名同属性——记录的错误只在 `ExportedSpan.error` 上读,活 span 接口不重复暴露该数据字段。

## 事件与导出

生命周期只有三个事件,携带 `ExportedSpan`:

```ts
type TracingEvent =
  | { kind: 'span_started',  span: ExportedSpan }
  | { kind: 'span_updated',  span: ExportedSpan }
  | { kind: 'span_ended',    span: ExportedSpan }

interface ObservabilityExporter {
  export(event: TracingEvent): void | Promise<void>,
  flush?(): Promise<void>,      // 可选:console 没有批概念
  shutdown?(): Promise<void>,
}
```

裁掉 mastra 接口上的 `init?()`(构造即初始化)与 `name` 字段。exporter 的可选 `flush` / `shutdown` 不各调用各的:tracer 暴露同名的 `flush()` / `shutdown()` 转发,`flush()` 同时等待在途的异步 export。

```ts
createTracer({
  exporters: ObservabilityExporter[],
  sampler?: 'always' | 'never' | { ratio: number } | ((parent) => boolean), // 默认 'always'
  spanProcessors?: SpanProcessor[], // 全局同步管线
  hideInput?: boolean,              // 导出时擦 input 的 trace 级默认(可 per-span 覆盖)
  hideOutput?: boolean,
})
```

- **采样**:四档;只在 root span 创建时判定一次,子 span 继承;不通过返回 `NoOpSpan`(全方法 no-op),其后代自动全 NoOp——埋点代码无分支。没挂 tracer 时整个子系统零开销。
- **spanProcessors**:导出前整形缝。同步、逐事件生效(每个事件派发前过一遍),原地改写或返回 `undefined` 丢弃该事件。规则库不进核心——PII 规则是应用域知识。
- **`hideInput` / `hideOutput`**:trace 级开关,导出时擦字段;可在 run option per-call 覆盖(透传为 root span 的创建选项,并由子孙继承同一条 trace 的决定)。擦除发生在 spanProcessors 之后——exporters 永远看不到被擦字段,而处理器仍能拿到原始值做规则化脱敏。
- **组合根分发**:`createApp({ tracer })`(ADR-0002 已有此位)以 `app.agent(config)` 建出的 Agent 被动接受分发的 tracer(配置自带 tracer 时显式优先),无需逐 agent 传入;子系统独立 `new` 时也可显式传入(Agent 侧即 `AgentConfig.tracer` 注入缝),不挂即零开销。

## 自动埋点:七边界

tracer 存在时框架自动开 span,缺席时 NoOp 零开销:

1. **agent run** — 一次 generate()/stream() 全程
2. **agent step** — run 内每轮模型调用(fallback 链的每次尝试各成一个 span,失败尝试落 error;服务该 step 的尝试携带 usage / finishReason);`timeToFirstChunk` 落此 span(替代被裁的 chunk 级 span 的最高价值部分)
3. **tool call** — agent loop 内每次工具执行
4. **workflow run** — start/resume 到终态
5. **workflow step** — 每个 step 边界
6. **memory recall** — run 开始、`processInput` 之前的历史召回(每 run 一次),挂 `agent-run` 下
7. **memory save** — 每 step 完成、下一轮 prompt 构造之前的落库(每 step 一次),挂 `agent-step` 下

裁掉:mastra 的 `MODEL_CHUNK`(chunk 已在 chunk 协议流里,观测侧可从流事件重建,不为此开 span)与 `MODEL_GENERATION` 中间层(run→step 两级已够表达)。sub-agent 由 Agent 规范定为 as-tool 兜底,自然落成 `tool-call` span,无专门类型。

## 上下文传播与身份

- **框架内部显式传播**:Agent loop / Workflow walker 沿执行树把 parent span 传给下一代——**不用 AsyncLocalStorage**(edge / CF Workers 需 compat flag,且隐式上下文是魔法)。用户 tool 内自建 span 同样走显式 parent(tracer API 参数)。内核缝是 `startSpan` 的两种入参:`{ parent }` 传活 span(正常执行树),或 root 创建时传 `{ traceId, parentSpanId }` 续接别处开始的 trace——二者互斥,`parentSpanId` 必须与 `traceId` 同来。
- **外部 trace 延续**:run 级 option(Agent generate/stream 与 workflow createRun)接受可选 `{ traceId?, parentSpanId? }`;解析 `traceparent` header 是应用层的事。空串不是可续接的 id(tool ctx 对"无 trace"的编码,见 `tools.md`「执行上下文」):`traceId` 为空串时整对作废——run 起自己的新 trace,不产生空 trace id 的残破 span;`parentSpanId` 为空串则只丢 parent。(ALS 集成归延后的 OTel bridge。)
- **suspend/resume**:traceId 进 workflow 快照,resume 续同一 trace。

## Exporter 清单

- **核心包自带两个**:`console`(开发调试美化打印)与 `memory`(环形缓冲,测试/集成断言的抓手)。
- **OTLP 能力包一个**(独立 npm 包 `@oribos/otlp`,沿 ADR-0002 M5 修订记):把 span 映射为 GenAI semconv 形状——`{operation} {model}` 命名、`gen_ai.operation.name / provider.name / request.model / usage.*` 属性、parts 格式消息;usage 只挂 `chat` span 防后端重复计数。transport 仅 HTTP/protobuf + HTTP/JSON,**不做 gRPC**(Langfuse 不收 gRPC,`@grpc/grpc-js` 依赖重);协议层依赖 OTel 官方 exporter 包,隔离在包边界。带 env-var 零配置 preset。设计冻结见下节「OTLP 能力包(M5 设计冻结)」。
- **不做厂商专用 exporter**:Langfuse / LangSmith 均把裸 OTLP + `gen_ai.*` 当一等摄入路径,发标准形状即同时覆盖多家后端。
- **OTel bridge**(复用进程内 OTel SDK 上下文):延后。mastra 同类包至今 experimental;记为地图 fog,路线图阶段判断。

## OTLP 能力包(M5 设计冻结)

> 决策:wayfinder ticket #73(决策:OTLP exporter 能力包)。包名 `@oribos/otlp`(沿 ADR-0002 M5 修订记),对 `@oribos/core` 走 peer(`workspace:^`)、与全 `@oribos/*` 锁步发布;事实底座 = `docs/research/otlp-js-packages.md`(2026-09-30 实测,版本钉 `exporter-trace-otlp-{proto,http}@0.222.0` / `sdk-trace@2.11.0` / `resources@2.11.0` / `api@1.9.1`)。本节是冻结态:包面、依赖路线、三事件桥法与映射契约都不留实现期判断。

### 包面

```ts
createOtlpExporter(options?: {
  protocol?: 'protobuf' | 'json',        // 缺省 'protobuf'
  url?: string,
  headers?: Record<string, string>,
  timeoutMillis?: number,
  compression?: 'none' | 'gzip',
  serviceName?: string,
  resourceAttributes?: Record<string, string | number | boolean | ReadonlyArray<string | number | boolean>>,
  batch?: { maxExportBatchSize?: number, scheduledDelayMillis?: number, maxQueueSize?: number, exportTimeoutMillis?: number },
}): ObservabilityExporter
```

- **配置优先级 = 显式选项 > env > 官方默认**。未给的项由官方 exporter 基座解析 env:`OTEL_EXPORTER_OTLP_{ENDPOINT,HEADERS,TIMEOUT,COMPRESSION,CERTIFICATE,CLIENT_CERTIFICATE,CLIENT_KEY}` + `..._TRACES_*` 特化(headers 合并、特化优先;通用 endpoint 自动拼 `v1/traces`);url 缺省 `http://localhost:4318/v1/traces`。
- **`protocol` 是本包自己的 env 面**:官方两个 exporter 包都不读 `OTEL_EXPORTER_OTLP_PROTOCOL`(协议 = 选包),本包读它做选包,显式选项优先。
- **resource(必填,官方 transformer 缺它直接抛)**:`service.name` 合并序 `'oribos'` < `OTEL_SERVICE_NAME` / `OTEL_RESOURCE_ATTRIBUTES` < `serviceName` 选项 < `resourceAttributes` 选项(后者整体覆盖);**不发 `telemetry.sdk.*`**——本包没走 OTel SDK,不冒领。
- `instrumentationScope = { name: '@oribos/otlp' }`(不带 version,免锁步版本漂移)。
- **`flush()` → 批处理器 `forceFlush()`;`shutdown()` → `shutdown()`**,原样透传(框架 tracer 的同名方法转发到这里)。
- **失败面**:`export()` 只入队、永不抛;队列满静默丢、导出失败静默(官方批处理器语义),诊断走 OTel diag(`diag.setLogger`)。不自研重试 / 日志 / `onError` 回调——可重试状态(429/502/503/504 + `Retry-After`)、超时、并发是官方 exporter 基座职责。
- **不重复的核心面**:`hideInput` / `hideOutput`(上游 trace 级已擦,exporter 永远看不到)、`spanProcessors`(核心已跑完)、采样(合成 span 的 `traceFlags` 恒 `SAMPLED`——到包里的必然已通过 root 采样)。

### 依赖路线

- **路线 = 官方 exporter 包 + 官方批处理器**(调研 §7 路线①):直接依赖 `@opentelemetry/exporter-trace-otlp-proto` / `-http`(双协议)、`@opentelemetry/sdk-trace`(`BatchSpanProcessor`)、`@opentelemetry/resources`(`resourceFromAttributes` + env 检测器)、`@opentelemetry/api`(`SpanKind` / `SpanStatusCode` / `TraceFlags`);五件全部**精确钉版本**并以 `dependencies` 声明(exporter 系列走 0.x 且对 SDK 用精确版本;`api` 作直接依赖,免 peer 解析面)。
- **安装树实测 12 包 / 19,312,287 B(≈18.42 MiB unpacked)**:`semantic-conventions` 单包 12.0 MB(62%,`core` / `resources` / `sdk-trace` 的传递依赖,无法从树里移除)、`sdk-metrics` + `sdk-logs` + `api-logs` ≈2.67 MB(transformer 同时编码三信号)。数字口径归 `deps-budget.json` 黄灯(实施图落基线,#72);`@oribos/core` peer 豁免。
- 不选的路线:仅 `otlp-transformer` + 自写 HTTP(只省 0.67 MiB,却把传输 / 重试 / 并发簿记搬进本包);自实现序列化(把 semconv 演进从「跟版本」升级成「自己维护」)。
- **不 import `semantic-conventions`**:`gen_ai.*` 键名按字符串直写(常量包只在 incubating 入口携带且全 Development;它在意不在树不是本包引入的);键名漂移只改本包、核心不随动(ADR-0009 的可逆性不对称)。

### 三事件 → OTLP 桥法

- **只有 `span_ended` 进 OTLP**:OTLP span 不可变、无 update 语义,ended 事件携带完整快照;`span_started` / `span_updated` 直接丢弃(不进批处理器)。
- 每个 ended span 现场构造**结构满足 `ReadableSpan` 的普通对象**(不需要 SDK 的 TracerProvider / Span;实测直发成功)后交 `BatchSpanProcessor.onEnd()`,批节奏与 flush 由官方处理器承担(默认 512 条 / 5 s / 队列 2048 / 导出超时 30 s;定时器 unref,不吊住进程)。
- 字段换算:`traceId` / `id` → `spanContext()`(必须是**函数**);`parentSpanId` → `parentSpanContext.spanId`(不带 `isRemote`);`Date` → `HrTime = [Math.trunc(ms/1000), (ms%1000)*1e6]`;`resource` / `instrumentationScope` / `kind` / `status` / `attributes` / `events: []` / `links: []` / `dropped*` 同批构造;`duration` / `ended` 一并给出(transformer 不读,自洽用)。
- **`isEvent` → 零时长 span**(`endTime = startTime`,kind INTERNAL,status UNSET):OTel `SpanEvent` 必须挂在某个 span 上,而 isEvent 可能先于父、也可能无父;缓冲等父会引入状态与泄漏面。除时长外,isEvent span 走与普通 span 相同的按类型映射(`signal` 等开放 type 走通用兜底)。
- 批处理器按 `traceFlags & SAMPLED` 过滤;合成 span 恒置 `TraceFlags.SAMPLED`(上游采样已在 root 判定,进包即已采样)。

### 映射契约(七类 + 兜底)

七类 span 的 `name` 一律按模板重建(不用框架原 name);开放 type 原样。每张映射 span 都带 `oribos.span.type`(框架 type 原样),`oribos.*` 键的框架多词字段转 snake_case。

| type | span name | `gen_ai.operation.name` | kind | 专属属性 |
| --- | --- | --- | --- | --- |
| `agent-run` | `invoke_agent {agentName}` | `invoke_agent` | INTERNAL | `gen_ai.agent.name`、`oribos.run_id` |
| `agent-step` | `chat {model}` | `chat` | CLIENT | `gen_ai.provider.name`、`gen_ai.request.model`、`gen_ai.request.stream: true`、参数白名单、`gen_ai.usage.{input_tokens,output_tokens}`、`gen_ai.response.finish_reasons`、`gen_ai.response.time_to_first_chunk` |
| `tool-call` | `execute_tool {toolName}` | `execute_tool` | INTERNAL | `gen_ai.tool.name`、`gen_ai.tool.call.id` |
| `workflow-run` | `invoke_workflow {workflowId}` | `invoke_workflow` | INTERNAL | `gen_ai.workflow.name`、`oribos.run_id` |
| `workflow-step` | `workflow-step {stepId}` | — | INTERNAL | — |
| `memory-recall` | `memory-recall {threadId}` | — | INTERNAL | `oribos.thread_id` |
| `memory-save` | `memory-save {threadId}` | — | INTERNAL | `oribos.thread_id`、`oribos.resource_id` |
| 开放 type | `span.name` 原样 | — | INTERNAL | — |

- 无 semconv operation 的类(workflow-step / memory / 用户 span)**不硬蹭**:稳定 kebab 名 + `oribos.*` 语境,后端可按 `oribos.span.type` 过滤。
- `agent-step` 参数白名单(`parameters` = 用户 `modelSettings` 原文):`temperature`→`gen_ai.request.temperature`、`topP`→`top_p`、`topK`→`top_k`、`maxOutputTokens`→`max_tokens`、`stopSequences`→`stop_sequences`、`presencePenalty`→`presence_penalty`、`frequencyPenalty`→`frequency_penalty`、`seed`→`seed`;其余键 → `oribos.request.<key>`(通用值域规则)。
- `gen_ai.request.stream: true` **恒发**:agent loop 对每次模型尝试(含 fallback 链)都走 `doStream`,框架无非流式模型调用路径;semconv 语义是「unset 假定非流式」,不发即失真。
- `timeToFirstChunk`(毫秒)→ `gen_ai.response.time_to_first_chunk`(秒,number;框架测点 = step 起点到首 chunk,≈请求发出,偏差记此);`finishReason` 原样单元素数组落 `gen_ai.response.finish_reasons`(不发明翻译层,`suspended` 等框架词汇直传);`usage` 只发输入 / 输出两项(semconv 无 total 键,防后端重复计数)。
- `status`:成功 `UNSET`(OTel 不默认 OK);`error` 时 `{ code: ERROR, message }` + `error.type`(取 `details.name` 字符串,否则 `_OTHER`)+ `oribos.error.details` best-effort JSON(不可序列化则省略——Error 自有属性不可枚举,发 `{}` 不如不发)。

### 载荷映射(input / output)

- **消息语义(agent-run / agent-step)**:`ModelMessage[]` 拆分——`role: 'system'` → `gen_ai.system_instructions`,`user` / `assistant` / `tool` → `gen_ai.input.messages`;span 属性上按规范允许的 JSON 字符串形态落值(数组本体)。`agent-step` 的 input 是该次模型调用的完整 prompt(含历史),不裁剪。
- parts 转换:`text`→`text`、reasoning→`reasoning`、`tool-call`→`tool_call`(id / name / arguments)、`tool-result`(含 assistant 内联结果)→`tool_call_response`;file / custom / approval 等未识别 part → 单个 `text` part 的 JSON 文本兜底;`ModelToolResultOutput` 的联合(text / json / error-* / execution-denied / content)按同规则降为文本或 JSON 文本。
- `agent-step` output = 模型文本 → `gen_ai.output.messages = [{ role: 'assistant', parts: [{ type: 'text', content }] }]`(空字符串不发);工具调用不在 step output 里,以 tool-call span 呈现(文档写明)。`agent-run` output = 终值文本;`structuredOutput` 的对象 → 单个 `text` part 的 JSON 文本。
- `tool-call`:`input` → `gen_ai.tool.call.arguments`、`output` → `gen_ai.tool.call.result`(均 JSON 字符串;result **仅成功时**发,失败信息由 `error.type` / `status.message` / `oribos.error.details` 承载)。
- **非消息语义兜底(workflow-run / workflow-step / memory-* / 开放 type)**:`input` → `oribos.input`、`output` → `oribos.output`,best-effort JSON 字符串,失败省略。
- **不截断**:v1 不做内建截断 / 大小上限——整形缝已在上游(`spanProcessors` 同步改写 + `hideInput` / `hideOutput` trace 级擦除),本包不重复开关;超大 prompt 原样上线是已知代价,宿主用处理器裁剪。

### 值域与兜底规则

- OTel 属性只收原语:原语 / 原语数组直通(数组中的 null / undefined 剔除,剔空即丢);对象及其他值 `JSON.stringify` 成字符串落同名键;序列化失败丢弃并计 `droppedAttributesCount`。
- `attributes` 袋走通用规则(白名单已映射的键不重复);`metadata` 开放袋 → 单属性 `oribos.metadata` JSON 字符串(空 / 失败省略;不摊平——避免污染命名空间与撞 semconv 键)。
- 框架侧 `undefined` 一律省略属性,不发空串哨兵。

### 裁单

本包的裁单行统一归篇章级「砍单与承载缝」表(CUT-OBS1–5 行),此处不再重列——单一真相源。

## 砍单与承载缝

判定口径见 `docs/ROADMAP.md`「下一阶段(完善)」;`CUT-OBS*` 行 = 审计 §2 砍单行集(`docs/research/completeness-audit.md`),`E*` 行 = 对比总账 §3「形状内语义差异」(`docs/research/mastra-gap-analysis.md`)。判定三值:有意分叉 / 已兑现(非差异) / 提升(→ 必须项表 ID)。

| 项 | 承载缝 | 判定 | 理由·ADR 指针 |
| --- | --- | --- | --- |
| **CUT-OBS1** gRPC transport / 厂商专用 exporter | 官方 OTel exporter 包可自拼(不装不付) | 有意分叉 | Langfuse 不收 gRPC;裸 OTLP + `gen_ai.*` 覆盖各家(ADR-0009) |
| **CUT-OBS2** OTel bridge / metrics / logs | OTLP 导出面 + 用户已有 OTel 采集管线自接 | 有意分叉 | v1 只 tracing(ADR-0009);bridge 归延后清单「OTel bridge 能力包」 |
| **CUT-OBS3** 自研批处理 / 重试 / 日志 / 错误回调 | 官方 `BatchSpanProcessor` / OTel 侧配置 | 有意分叉 | 官方基座在树内且更完整;诊断走 diag(ADR-0009) |
| **CUT-OBS4** 内建截断 / 敏感数据规则库 | `spanProcessors` 同步改写 + `hideInput` / `hideOutput` trace 级擦除 | 有意分叉 | 上游处理器 + hide 开关是唯一整形缝;「不截断」是记明的已知代价(ADR-0009) |
| **CUT-OBS5** `gen_ai.conversation.id` 补全 | memory span 已发 `oribos.thread_id`;需要时用户 spanProcessor 自补 | 有意分叉 | agent-step 属性面无 threadId;不做跨 span 推断(ADR-0009) |
| **CUT-OBS6** exporter `init?()` / `name` 字段 | 用户侧 wrapper 包一层 | 有意分叉 | 三事件最小面 = 标准字面「无 init·name」(ADR-0009) |
| **CUT-OBS7** `MODEL_CHUNK` / `MODEL_GENERATION` span | `agent-step` span 已载 model / provider / usage / finishReason;chunk 级细节由用户侧消费 chunk 流自行埋点 | 有意分叉 | 七类型冻结;chunk 级埋点与「缺席零开销」相抵(ADR-0009) |
| **E1** 快照只持久化 `traceId` | span 由 exporter 出进程;完整 trace 上下文归观测侧(与 `workflows.md` / `harness.md` 互引) | 有意分叉 | 快照是 JSON-only 状态、不是 tracing 载体;`traceId` 只作续接锚(ADR-0006 / 0011) |
| **E2** resume = 同一 `traceId` 下的**新** run span | resume 续 `traceId`(既有机制,快照内 `traceId`) | 有意分叉 | 一次人机交互 = 同 trace 多 span;不伪造父子——无 `parentSpanId` 即新 root(ADR-0009) |

## 与其它子系统的关系

- **模型层(#9,已定)**:chunk 协议是共用流式词汇;`agent-step` 的 model/provider/usage 取自模型契约的 finish/usage chunk。
- **Agent(#10,已定)**:tracer 挂钩是内部缝,不占 Processor 名额;span 挂 run / step / 工具执行三边界;run option 携带外部 trace 延续与 `hideInput/hideOutput` 覆盖。
- **Workflows(#11,已定)**:span 挂 run / step 边界;lifecycle 事件流是事件锚点;traceId 随快照持久化。
- **Memory(#12,已定)**:recall / save 各成一个普通 span 锚点(带时长):`memory-recall` 挂 `agent-run` 下、`memory-save` 挂 `agent-step` 下;无 memory 身份的 run 不开这两个 span。
- **Harness(#18)**:持久执行跨进程恢复时 trace 延续语义归它,本规范的 traceId-进快照是其底层机器。

## 依赖预算

核心(含 observability 子路径)运行时依赖 = 0(ADR-0001 红线,内部 CI 回归参考);OTLP 能力包依赖 OTel 官方 exporter 包(清单与实测数字见「OTLP 能力包(M5 设计冻结)」),不装不付。
