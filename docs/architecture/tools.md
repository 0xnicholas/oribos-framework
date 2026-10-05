# Tools/MCP 抽象

> 来源:wayfinder ticket #13(决策:Tools/MCP 抽象)。本文件是 Tools 子系统与 MCP 能力包的架构规范。
> 决策记录见 `docs/adr/0008-tools-mcp-abstraction.md`(ctx 六件套修订见 `0012-multi-agent-collaboration.md`);术语见 `CONTEXT.md`。

## 定位

工具是框架向模型开放的唯一动作通道。设计遵守轻量轴:**定义表面刻意最小(四字段普通对象),MCP 互通全部挂包边界,核心零依赖零 MCP 概念**。北极星是同一份 Tool 定义双向流通——server 包把它暴露给 MCP 生态,client 包把外部 MCP 工具转译成它——agent 不感知 MCP 存在。

## Tool 定义表面

```ts
interface ToolConfig {
  description: string,                        // 必填,给模型看
  inputSchema?: StandardSchema,               // 可选;省略 = 无参工具
  outputSchema?: StandardSchema,              // 可选;存在则校验输出
  execute: (input, ctx: ToolContext) => output | Promise<output>,
}
```

- **四字段,无 id/name**:名字的唯一真相源是容器 Record 键(Agent 规范已定 `Record<string, Tool>` + 构造期唯一性校验);MCP 暴露时同键。Record 键本身唯一——同一字面量里重名是 TypeScript 编译错误,构造期唯一性校验因此落在编译期;运行期无法表达重复键(程序化组装在到达容器前已被对象语义折叠)。
- **`createTool(config)` 工厂仅为类型推断**(schema → input/output 类型),返回冻结普通对象;手写字面量合法(结构化类型,工厂不是必需)。
- **字段不逐个动态化**:动态性由 Agent 的 tools 容器(`DynamicArgument<Record<string, Tool>>`)整组承载——per-request 换工具集在容器层整组替换,不在工具内部逐字段解析。
- **schema 契约**:`StandardSchemaV1 & StandardJSONSchemaV1` 双接口(ADR-0003);`~standard.jsonSchema` 出 JSON Schema 发给 provider——目标固定 draft-07(与模型契约的 `JsonSchema` 子集一致),转换器产物原样直通,核心不改写 schema。
- **无参工具**:inputSchema 省略时,发给 provider 的 parameters 补空 object schema(`{ type: 'object', properties: {} }`),`input` 类型为 `undefined`。

## 执行上下文

`execute(input, ctx)` 两参签名:`input` 是 schema 校验后的模型生成参数(类型从 schema 推出),`ctx` 是框架上下文。**模型给的与框架给的分属两个参数,不混装一袋**(与 workflow `StepContext` 的 inputData-in-bag 刻意不同——step 输入是上游管道数据,工具输入是模型 JSON)。

```ts
interface ToolContext {
  signal: AbortSignal,            // 取消传播,沿 run 下发(Agent 规范已定)
  runId: string,                  // 日志/追踪关联
  toolCallId: string,             // provider 生成的调用 id;幂等键
  requestContext: RequestContext, // 用户 per-call 开放袋(嵌套不拍平,与 StepContext 对齐)
  traceId: string,                // 当前 run 的 trace id;as-tool 组合时透传给委派 run(ADR-0012)
  spanId: string,                 // 当前 tool-call span id;委派 run 经 run option 挂为其子 span
}
```

- **零权限模型**:取消 = `signal`;审批/挂起 = Harness(#18)统一裁决;授权 = 应用层(与 Memory 决策同一条线)。
- **不注入 agent / memory 引用**:mastra 把两者传给工具,是耦合源;需要时经 `requestContext` 用户袋或闭包获取。
- agent loop 内调用时框架保证六件套齐备(含 provider 真值 toolCallId);未挂 tracer 时 `traceId`/`spanId` 为空串(与观测规范的 NoOpSpan 语义对齐)。手动直调时 toolCallId 由调用方自供(如 workflow 包装用 step id),`traceId`/`spanId` 不需要时同样传空串。

## 校验与错误语义

**三线归一**——以下三种失败统一转为 error 工具结果**回喂模型**,run 不中止(沿用 Agent 规范「工具错误回喂」总原则):

1. input 校验失败(模型生成的参数不合 inputSchema)
2. execute 抛错
3. output 校验失败(execute 返回不合 outputSchema)

同语义的第四类:模型调用了工具容器中不存在的名字(Record 无此键)——框架没有可执行的 execute,同样直接以 error 结果回喂。

第 3 条与 structuredOutput 的 strict 调子一致(失败即报错);注意此时**副作用已经发生**,重复执行防护归工具的幂等设计,框架提供 `toolCallId` 作幂等键。校验由框架调用点执行(agent loop、MCP server 包);手动直调 execute 时校验是调用方责任。

## 组合范式

agent as-tool(Agent 规范已钉包装形态;Agent 的 `description` 是动态参数,故它在包装处经 `resolveDynamicArgument` 取值——Tool 的 description 是构造期静态字段):

```ts
const agentAsTool = async (ctx: RequestContext) =>
  createTool({
    description: (await resolveDynamicArgument(agent.description, ctx)) ?? agent.name,
    inputSchema: z.object({ prompt: z.string() }),
    execute: (input, { signal, traceId, spanId }) =>
      agent.generate(input.prompt, { signal, traceId, parentSpanId: spanId }),
  })
```

workflow 中用工具(无 `createStep(tool)` 特化,ADR-0006):

```ts
createStep({
  id: 'search',
  inputSchema, outputSchema,
  execute: ({ inputData, runId, signal, requestContext }) =>
    searchTool.execute(inputData, { signal, runId, toolCallId: 'search', requestContext }),
})
```

## MCP server 能力包

独立 npm 包 `@oribos/mcp-server`(ADR-0002 M5 修订;`@oribos/core` 走 peer,清单三件套沿能力包先例)。直连依赖仅 `@modelcontextprotocol/server@^2.2.0`——传递闭包 server / core / zod 3 包;Node `node:http` 绑定与 Host/Origin 防护归用户侧(官方 `@modelcontextprotocol/node`,文档钉接线),不直连。v1 单包 `@modelcontextprotocol/sdk`(92 安装包、硬拉 express+hono)为过时路径,明确排除。数字口径归 `deps-budget.json`(实施图落基线),本节只冻包集合与版本线。

```ts
const server = createMcpServer(
  { name, version, tools: Record<string, Tool> },
  { http?: { legacy?: 'stateless' | 'reject' } }, // 创建期选项;省略 = SDK 默认
)

server.fetch                                // web-standard handler:(Request, opts?) => Promise<Response>
server.serveStdio({ legacy?, transport? })  // → { close } — 起 stdin/stdout 服务
await server.close()                        // 闭合已开入口、中止在途
```

- **传输接入面**:HTTP = `server.fetch`,可直接 `export default { fetch }` 或挂任意 web 框架/运行时,`opts` 透传 SDK 的 `{ authInfo?, parsedBody? }`(v1 不消费 `authInfo`;`parsedBody` 给预解析 body 的框架);Node `node:http` 宿主自装官方 `@modelcontextprotocol/node`(`toNodeHandler` + `localhostHostValidation` / `localhostOriginValidation`,文档给片段)——不绑 web 框架、不自实现传输;旧 SSE 传输已废弃,不做。stdio = `server.serveStdio()`,options 里的 `transport` 是 in-process 接缝(`InMemoryTransport` 仅连 2025 代;modern 的 in-process 入口就是 `server.fetch`);v1 只收 `legacy` / `transport` 两项,其余沿 SDK 默认。`close()` 沿 SDK 语义:modern 在途交换被中止、闭合后 `fetch` 拒绝,legacy stateless 交换不被追踪。SDK 的 `notify` / `bus` 不暴露(静态工具无 listChanged;跨节点分发出 v1)。
- **era 姿态**:默认双代全服务(HTTP `legacy: 'stateless'`、stdio `legacy: 'serve'`);可切 `'reject'` 只服务 modern。legacy sessionful 不做——需要者用官方 SDK 自布线(`McpServer.connect(transport)`;更底层的 `Server` 类已 deprecated)。
- **原语范围**:v1 仅 tools;prompts / resources 后加(minor)。
- **ToolContext 合成**:`signal ← ctx.mcpReq.signal`;`toolCallId ← String(ctx.mcpReq.id)`(JSON-RPC 请求身份,跨连接不保证稳定);`runId` / `traceId` / `spanId` 为空串——MCP 无 run、v1 不注入 tracer,与 NoOpSpan / 手动直调语义对齐;`requestContext` 冻结空袋(框架只写 `signal` 与 `runId: ''`,不塞 `authInfo` / `era` 等 MCP 事实;授权归传输层中间件,需要 per-request 工具集的宿主走官方 SDK 自布线)。
- **结果与错误投影**:`outputSchema` 存在 → `structuredContent = output` 原文 + `content = [{ type: 'text', text: render(output) }]`;无 `outputSchema` → 仅 content。`render` = `string` 原样、其余 `JSON.stringify`(`undefined` 退化 `String`)。输入校验 / execute 抛错 / 输出校验三线全由 SDK 归一为 `{ content: […], isError: true }` 结果——Oribos 不加层、不改消息;未知 / 禁用工具沿 SDK 的协议错误(JSON-RPC error),wire 错误还原为本框架语义是 client 包的职责。
- **工具名合法性**:`[A-Za-z0-9_.-]{1,128}`(对齐 MCP 规范 SHOULD,ADR-0008 修订);`createMcpServer()` 构造期逐键校验,非法即抛——agent 域合法不代表 MCP 域合法。
- **每请求实例**:SDK 工厂模型——HTTP 每请求、stdio 每连接(含 discover 探测重进)新建实例;桥接层按次整组注册全部工具(工具 Record 本身不改),工厂须廉价、无副作用。
- **schema 零适配**:Tool 的 inputSchema/outputSchema 是 `StandardSchemaV1 & StandardJSONSchemaV1`(ADR-0003);SDK 以 `~standard.validate()` 校验(输入/输出,transform 生效)、以 `~standard.jsonSchema` 目标 `draft-2020-12` 出 JSON Schema(与发 provider 的 draft-07 目标同源不同出口);inputSchema 需 object 根。执行输入是 SDK 校验后的值——校验职责整体移交 SDK,与 agent loop 的框架侧校验同义。

## MCP client 能力包

独立 npm 包 `@oribos/mcp-client`(#72 首批六包之一;ADR-0002 M5 修订)。直连依赖仅 `@modelcontextprotocol/client@^2.2.0`(`.` 与 `./stdio` 两个子路径面;13 包 / 14.1 MiB,#6 实测;大头是 OAuth/SSE/stdio,属功能必需),`@oribos/core` 走 peer(清单三件套沿能力包先例)。**与 server 包分开是按需组合的硬要求**:依赖是包级粒度,合包则 server 用户连坐 client 的 13 包。数字口径归 `deps-budget.json`(实施图落基线),本节只冻包集合与版本线。

```ts
const client = await createMcpClient({
  transport:
    | { type: 'stdio', command: string, args?: string[], env?: Record<string, string> }
    | { type: 'http', url: string | URL, headers?: Record<string, string> },
  protocol?: 'auto' | 'legacy' | { pin: '2026-07-28' },  // 省略 = 'auto'
  timeoutMs?: number,                                     // 省略 = SDK 缺省 60s
})

client.tools            // getter:当前快照 Record<string, Tool> —— execute 代理到远端,直接展开进 agent 容器
await client.refresh()  // 重新 listTools 并换快照;失败保留旧快照并 reject
await client.close()    // HTTP 先 terminateSession(失败静默)→ client.close();幂等
```

- **接入形态唯一**:外部 MCP 工具转译为本框架 Tool 直接进 agent 容器;不做 mastra 式 MCPConfiguration 平行容器。
- **传输**:stdio(`command + args + env`,SDK 自拥子进程)+ Streamable HTTP(`url + headers` → transport `requestInit.headers`)。`env` 语义照 SDK:给了就是**整份**环境,不给 = SDK 白名单(不继承整份 `process.env`);`stderr` 缺省 inherit——子进程日志进父 stderr,正是 MCP 要的。旋钮面收口:stdio 的 `stderr` / `cwd` / `maxBufferSize`、HTTP 的 `fetch` / `authProvider` / `sessionId`、`listMaxPages`、响应缓存三件(`responseCacheStore` / `cachePartition` / `defaultCacheTtlMs`)与客户端中间件 v1 一律不暴露;逃逸口是官方 SDK 自布线(与 server 票同一条纪律)。**不接受 SDK transport 实例注入**。
- **身份**:SDK 的 `Client({ name, version })` 由包内定(`@oribos/mcp-client` + 包版本),v1 不暴露覆写。
- **era 姿态**:缺省 `'auto'`(先 `server/discover` 探测,定不了就回退 legacy `initialize`);可切 `'legacy'`(零探测,即 SDK 自身缺省)或 `{ pin: '2026-07-28' }`(不回退,失败即抛)——**我们显式把缺省抬到 auto**,SDK 缺省是 legacy。代价是 connect 期成本:stdio 上多一次短命兄弟探测进程;HTTP 探测静默超时按 outage 拒绝、不回落。
- **超时**:SDK 逐请求缺省 60s(`DEFAULT_REQUEST_TIMEOUT_MSEC`),且**没有 client 级默认值设置**——`timeoutMs` 必须由本包在 connect 与**每次** `callTool` 上透传(长工具调用的唯一入口);不提供 per-call 覆盖。
- **认证**:headers 透传(bearer 等)覆盖多数远程 server;OAuth 授权流助手裁出 v1(SDK 的 `authProvider` 不接线;裁它不缩小安装树,裁的是产品面)。
- **发现与快照**:connect 时 `listTools` 一次(no-cursor 自动翻页聚合,SDK 上限 64 页)建快照;`refresh()` 走 `cacheMode: 'refresh'` 强制真取并**换新快照**;`tools` 是 getter,返回当前快照(对象身份稳定到下次 refresh,旧引用不失效)。长驻 agent 用 `tools: () => client.tools`(`DynamicArgument` 每次解析拿最新)。不做 listChanged 订阅(长驻监听与无运行时负担有张力);SDK 响应缓存沿默认(`defaultCacheTtlMs` 0 = 每次真取仍存储)。modern + 非 stdio 的连接上 SDK 会剔除 x-mcp-header 声明非法的工具(规范 MUST,仅 warn)——快照可能少于服务端广告。
- **连接生命周期**:断线**不自动重连**——在途与后续调用抛 SDK 错误,恢复 = 新建 client;`refresh()` 不兼任重连探测。`close()` 幂等;在途请求以 `CONNECTION_CLOSED` 拒绝;stdio 子进程按 SDK 顺序关停(关 stdin → SIGTERM → SIGKILL)。不做进程退出钩子、不暴露 closed 观测——宿主不 `close()` 就是子进程常驻,这条写文档不兜底。
- **错误面**:原样抛出,**不加层、不改消息**(与 server 票同调)。连接期 = `SdkError`(`ERA_NEGOTIATION_FAILED` 等)/ `SdkHttpError`(401 / 403)/ 探测超时;运行期 = `REQUEST_TIMEOUT` / `CONNECTION_CLOSED` / 协议错误 / 输出校验 `ProtocolError` / `LIST_PAGINATION_EXCEEDED`。
- **ToolContext 消费**:`signal` → `callTool({ signal })` 直通(不额外预检);`toolCallId` / `runId` / `traceId` / `spanId` **不出网**(协议无对应位、v1 不注入 tracer),`requestContext` 不透传(远端进程读不到)。与 server 票的对称点写进文档:`toolCallId` 是本地身份,不承诺跨连接稳定;把 toolCallId 经 `_meta` / 自定义头送远端做关联不做(minor 位)。
- **结果投影**:`structuredContent !== undefined` → **直接返回该值**(`ToolResultChunk.output` 是 `unknown`,任意 JSON 自然流通);否则 text 块按换行拼接;非 text 块(图片 / 音频 / resource link)降级为占位文本——工具结果通道没有多模态 part,是 v1 的诚实边界。`isError: true` → 抛错,由框架转成 `Tool 'x' failed: …` 错误结果回喂(与「三线归一」同一条路)。空结果返回 `''`。
- **MRTR 姿态**:无 elicitation / sampling / roots handler,`inputRequired.autoFulfill: false` 显式钉死——远端的 `input_required` 变成确定性 `SdkError(UnsupportedResultType)` 回喂,而不是「没有 handler 的自动流程」。
- **桥接工具的 schema**:「JSON Schema 直通」的 Standard Schema 包装(内部工厂,不公开导出)——工厂返回**显式标注 `StandardSchema<unknown, unknown>`** 的对象(注解不可省:字面量给不出 `~standard.types` 时核心推断落成 `never`);`vendor: 'oribos'`、`version: 1`、运行时 `types: { input: unknown, output: unknown }`;`~standard.validate(value, options?)` 永远**同步**返回 `{ value }`(忽略 options;校验在远端,失败经 execute 错误回喂);`~standard.jsonSchema.input({ target })` 返回远端 `inputSchema` 原文(**忽略 target**、同引用);`~standard.jsonSchema.output` **直接抛**(桥接 Tool 不承载 outputSchema,误触达即炸,不给假值)。wrapper 与 `~standard` 一并冻结。**目标版本边界**:远端 schema 常为 2020-12 而核心发 provider 的是 draft-07 子集——原样直通,框架不改写、不剥元字段;要 draft-07 就在远端侧改写。
- **不挂 outputSchema**:桥接 Tool 的 `outputSchema` 缺省——远端与 SDK 客户端已按远端 outputSchema 校验 `structuredContent`(非 isError 结果缺它或不合 → SDK 入站校验抛 `SdkError(SdkErrorCode.InvalidResult)`),Oribos 侧再挂只会得到「永不失败的 validate」假校验。代价:MCP→MCP 再导出丢 `structuredContent`、只出 text;保真诉求留 minor(显式 opt-in)。
- **名冲突**:纯函数 helper `prefixTools(tools, prefix, separator = '_')`——返回新冻结 Record,键 = `prefix + separator + name`;execute 闭包内的远端名不变(**前缀不进 wire**),固定前缀是同构映射故不做冲突检测;不进 client 配置面。远端工具名**不在桥接层校验或清洗**(MCP 规范 SHOULD 允许 `.` 等,provider 各自更严——那是用户与 helper 的事)。

## 砍单与承载缝

判定口径见 `docs/ROADMAP.md`「下一阶段(完善)」——核心 Tool 面与 MCP 两包冻结面的裁项散点在此收编为单表;`D*` 行 = 对比总账 §3,`CUT-T*` 行 = 审计 §2 砍单行集(其中 `CUT-T3` 为内联裁项群,逐项展开)。所有行的逃逸口同一条纪律:**官方 SDK 自布线**(用户直依 `@modelcontextprotocol/*`)。

| 项 | 承载缝 | 判定 | 理由·ADR 指针 |
| --- | --- | --- | --- |
| **D2** 工具保持四字段 | 审批 / 权限一律在包装层(`createDurableAgent`)与调用方;框架不往 Tool 加字段 | 有意分叉 | 四字段 + Record 键唯一真相源;核心零权限模型(ADR-0008 / 0005;`docs/architecture/harness.md` 审批闸) |
| **CUT-T1** MCP v1 单包(`@modelcontextprotocol/sdk`)路径 | 官方 SDK 自布线 | 有意分叉 | v2 直连两路径是已冻面;v1 单包 92 安装包、硬拉 express+hono(ADR-0008 / 0002) |
| **CUT-T2** OAuth 授权流助手 | `headers` 透传(bearer)+ 官方 SDK 自布线 | 有意分叉 | 授权是宿主 / 部署面(凭证、回调、浏览器);裁它不缩小安装树,裁的是产品面(ADR-0008) |
| **CUT-T3·server** legacy sessionful(2025 代有状态连接) | 官方 SDK 自布线(`McpServer.connect(transport)`) | 有意分叉 | 最小表面:HTTP `fetch` + stdio 双入口已覆盖;默认双代全服务已给兼容面(ADR-0008) |
| **CUT-T3·server** prompts / resources 原语 | 后加 minor | 有意分叉 | v1 仅 tools(ADR-0008) |
| **CUT-T3·server** `notify` / `bus` 接口 | 跨节点分发 v1 不做 | 有意分叉 | 静态工具无 listChanged;每请求实例模型下无长驻订阅对象(ADR-0008) |
| **CUT-T3·server** Node `node:http` 绑定 | 宿主自装官方 `@modelcontextprotocol/node`(`toNodeHandler` + host / origin 校验,文档给片段) | 有意分叉 | 不绑 web 框架、不自实现传输;Node 绑定不替宿主选(ADR-0008) |
| **CUT-T3·server** 创建 / 运行旋钮(`legacy` / `transport` 之外) | 沿 SDK 默认;要别的 → 官方 SDK 自布线 | 有意分叉 | 旋钮一律不暴露,只留显式接缝(ADR-0008) |
| **CUT-T3·client** 配置旋钮面(stdio 的 `stderr` / `cwd` / `maxBufferSize`、HTTP 的 `fetch` / `authProvider` / `sessionId`、`listMaxPages`、响应缓存三件、客户端中间件) | 官方 SDK 自布线 | 有意分叉 | 最小配置面 + 不提供产品级开关(ADR-0008) |
| **CUT-T3·client** transport 实例注入 + 身份覆写 | 官方 SDK 自布线 | 有意分叉 | 接入形态唯一(transport 三形态 + 包内定 `Client({ name, version })`);实例注入会把包面契约让给宿主的 transport 版本(ADR-0008) |
| **CUT-T3·client** per-call `timeoutMs` 覆盖 | `timeoutMs` 由包在 connect 与**每次** `callTool` 透传 | 有意分叉 | 单入口超时;per-call 覆盖与「不做 per-call 旋钮」纪律冲突,长工具调用 = 调 `timeoutMs`(ADR-0008) |
| **CUT-T3·client** `listChanged` 订阅 | `refresh()` 显式换快照;长驻用 `tools: () => client.tools` | 有意分叉 | 长驻监听与无运行时负担有张力(ADR-0008) |
| **CUT-T3·client** 断线自动重连 | 恢复 = 新建 client;`refresh()` 不兼任重连探测 | 有意分叉 | 重连策略(退避 / 会话恢复 / 幂等)是部署面,不是包面(ADR-0008) |
| **CUT-T3·client** elicitation / sampling / roots handler(MRTR) | `inputRequired.autoFulfill: false` 显式钉死——远端 `input_required` 变确定性 `SdkError(UnsupportedResultType)` 回喂 | 有意分叉 | 不做「没有 handler 的自动流程」;本地人机交互原语归 Harness(ADR-0008 / 0011) |
| **CUT-T3·client** 结果保真(多模态 part + `outputSchema`) | 非 text 块降级占位文本、不挂 `outputSchema`;保真留 minor(显式 opt-in) | 有意分叉 | 工具结果通道没有多模态 part;再挂 `outputSchema` 只会得到「永不失败的 validate」假校验(ADR-0008) |
| **CUT-T3·client** `toolCallId` 经 `_meta` / 自定义头送远端 | 不做(minor 位) | 有意分叉 | 协议无对应位;本地身份不承诺跨连接稳定(ADR-0008) |
| **CUT-T3·client** 进程退出钩子 / closed 观测 | 宿主显式 `close()`;这条写文档不兜底 | 有意分叉 | 不接管宿主生命周期(ADR-0002 / 0010) |

## 与其它子系统的关系

- **模型层(#9,已定)**:chunk 协议承载 tool-call / tool-result 事件;工具 schema 经双接口出 JSON Schema 发给 provider。
- **Agent(#10,已定)**:容器形状 `Record<string, Tool>`、工具错误回喂、maxSteps、signal 传播全部继承;审批/挂起不在核心,无 `requireToolApproval` 字段。
- **Workflows(#11,已定)**:无特化重载,一行手写包装;`ToolContext` 与 `StepContext` 对齐(signal / runId / requestContext)。
- **Memory(#12,已定)**:授权归应用层同一条线;工具要记忆经 requestContext 用户袋或闭包。
- **Harness(#18)**:审批/挂起的统一裁决归它;届时若进核心按 minor 扩展(ADR-0005 consequence)。
- **Observability(#14,已定)**:ctx 携带 `traceId`/`spanId`,供 as-tool 组合经 run option 续接 trace、把委派 run 挂为当前 tool-call span 的子 span(ADR-0012)。

## 依赖预算

核心(含 tools 子路径)运行时依赖 = 0(ADR-0001 红线,内部 CI 回归参考);MCP 两能力包各自隔离,不装不付(server = server / core / zod 3 包,node 绑定归用户侧;client 13 包 / 14.1 MiB)。
