# Oribos

一个轻量的 TypeScript/Node agent 框架：设计目标对齐 mastra(从原型到生产的一体化体验),差异化轴是"轻量"。本文件是项目术语表——只放定义,不放实现细节与架构决策(后者在 `docs/adr/`)。

## Language

**轻量 (Lightweight)**:
本项目的差异化轴,两层含义:**按需组合**——用户只为用到的能力付出,不用的子系统既不占依赖树也不占概念空间;**无运行时负担**——不强制任何基础设施(DB、队列、长驻进程),随处可跑,嵌入宿主应用而不接管它。心智表面小是贯穿的设计品味,但不是轴。
_Avoid_: 把"轻量"等同于依赖数/字节数等硬性数字指标(数字仅作内部 CI 回归参考,不是定义)、把"轻量"当公开身份词(2026-10-11 起公开叙事退役该词——品类语言 + 零依赖事实担纲,轴名仅内部;见 ADR-0016。2026-10-11 ADR-0017 转向追赶 mastra 并**保轴**——轴两层含义不变、轴名仍仅内部,公开叙事再翻转归后续叙事票)

**重开条件 (Reopen trigger)**:
延后/出域档缺口重新进入重估的触发信号。现行纪律(2026-10-11 起,ADR-0017):**mastra 已采用且未弃的功能面 = 需求证据(二手需求)**,触发重估而非自动晋升;已弃方向(如 `.network()`)与纯营销动作不构成证据。旧纪律(需求侧信号:必须外部可观察、可累计,如"≥1 个真实用例受阻",单一真相源在 `docs/ROADMAP.md` 的「延后清单」)随 ADR-0017 作废——ADR-0016 及之前的 dated 记录中该词均指旧纪律。对比总账(与 mastra 的差异、差距)见 `docs/research/mastra-gap-analysis.md`。
_Avoid_: "以后需要时"类不可判定的措辞、把重估触发当自动晋升或排期

**信号源建设期 (Signal-source building phase)**:
无用户期的路线图姿态:需求侧重开条件以用户基数为前提,信号源缺席时候选池静默是结构性的、不构成「无需求」或定位失败的证据;此阶段路线图主题为采用与上手面建设(让利基找得到框架、让仪器获得信号源),功能面不动、不 reopen 延后行。首个已执行动作 = oribos-website 叙事改版(2026-10-11)。(终态注记:2026-10-11 定位硬转——owner 决定转向追赶 mastra,ADR-0017 取代 ADR-0016,本期即日终结、主题作废;本词条保留为 dated 术语,不再描述现行路线图姿态。)
_Avoid_: 把空池静默误读为「无需求」证据、以建设期为名塞功能面工作

**完整判据 (Completeness criteria)**:
「完善现有功能」阶段的目标形态:每个子系统(模型 / Agent / 工具 / 工作流 / 记忆 / 观测 / 存储 / Harness)一份「什么算完整」的标准——规范承诺兑现 + 已记录砍单项清账 + 有意分叉写明 + 质量面达标。它是**自定触发**的锚点,以子系统为粒度。
_Avoid_: 用版本号代替判据(版本口径由内容量决定)、把判据当排期或对外承诺

**自定触发 (Goal-derived trigger)**:
由目标反推的路线图准入信号:把「完整判据」本身当作提升条件,与「重开条件」(必须外部可观察、可累计)并列的第二类判据;落在 `docs/ROADMAP.md` 增补段的必须项表(逐项写明判据要求与验证面),提升项从「延后清单」移出——单一真相源不变。
_Avoid_: 与「重开条件」混为一物、无判据理由的提升(那是跟单)

**有意分叉 / 欠账 (Deliberate fork / arrears)**:
完善判定的二元结论。有意分叉 = 同能力、不同重量或语义的有意差异(依据在各 ADR),判定后并入对应规范的「砍单与承载缝」表;欠账 = 相对完整判据的缺口,提升为必须项并写明自定触发。
_Avoid_: 把有意分叉当欠账补齐(与轻量轴冲突)、对欠账不写理由与验证面就提升

**形状内语义差异 (Within-shape semantic difference)**:
对比总账(`docs/research/mastra-gap-analysis.md` §3)对「形状已实现、语义与参照物不同」这类差异的分类,与「缺口」(参照物有、本框架没有)并列；差异是**对比视图**的说法,逐条判定为有意分叉或欠账(非差异行标「已兑现」,不进二元)。
_Avoid_: 把形状内差异当缺口补齐(先判分叉)、与「有意分叉」混为一物(前者是分类,后者是判定结论)

**验证面 (Verification surface)**:
「承诺兑现」的第二半:一条可判真假的承担机制——测试 / example / 闸门 / 类型系统 / 缺席证明 / 编译期约束；兑现 = 实装存在 **且** 验证面在位,缺一不构成兑现(欠账)。
_Avoid_: 把「实装存在」当兑现、用不可判真的描述充当验证面

**核心包 (Core package)**:
框架的单数核心 npm 包 `@oribos/core`,以子路径导出各子系统入口;自身保持极小,是"按需组合"的载体。
_Avoid_: 内核、平台包

**能力包 (Capability package)**:
因携带外部依赖而与核心包隔离的独立 npm 包(如 MCP、OTel exporter、存储 adapter、AI SDK 互操作),用户按需安装;命名一律 `@oribos/<能力>` 短名词、无类型后缀(如 `@oribos/mcp-server`、`@oribos/otlp`)。
_Avoid_: plugin、integration

**叶子包 (Leaf package)**:
被能力包复用的共享件包:无模块级状态、无核心身份语义,用户永不直接安装;运行时 `@oribos/*` 依赖为零,或仅 peer 核心包(ADR-0020 放宽);能力包以 `dependencies` 依赖它(能力包间依赖边的唯一例外,ADR-0002)。实例 = `@oribos/semconv`(#193,无状态纯件)与 `@oribos/lease`(ADR-0020,Lease 机制共享包;实施 #206)。
_Avoid_: 共享库、utils 包(叶子包是判词定死的结构位,不是杂物抽屉)

**组合根 (Composition root)**:
可选的薄组装点,负责把 storage/logger/tracer 等横切依赖注入给挂上来的子系统;子系统不挂它也能独立完整使用。
_Avoid_: 中央实例、registry(易与模型注册表混淆)

**模型契约 (Model contract)**:
核心与"一个模型"对话的结构类型契约,vendor 自 AI SDK provider spec 当前一代的最小子集;用户直接传入 AI SDK 生态 provider 包的模型实例,核心保持零依赖。字符串路由的标准化承载 = `@oribos/model-router` 能力包(parse 首斜杠拆分 + models.dev 目录存在性校验 + 用户自带 provider 工厂,零新缝,2026-10-14 #185)。
_Avoid_: 自有 provider SPI、provider 注册表、magic string

**Chunk 协议 (Chunk protocol)**:
核心自有的流式输出事件词汇(text-delta / tool-call / tool-result / finish 最小集合;A4 起 additive opt-in 两族增量帧:推理增量 `reasoning-delta` 与参数增量 `tool-input-start/-delta/-end`,经 run option `deltas` 发射、默认全关),stream 输出、processors、workflow 快照、observability 共用;与外部格式(AI SDK UI stream 等)的转换只发生在互操作能力包。
_Avoid_: 透出/复用 AI SDK 流格式

**Lifecycle 事件流 (Lifecycle event stream)**:
workflow run 输出对象的流式面:run / step 边界事件(run-start / step-start / step-end / run-end),包络复用 chunk 协议;step 内的 token 透传不在其中(用户自行消费 agent 的 stream 输出对象)。
_Avoid_: 与 chunk 协议混为一物、开第三套流格式

**Agent**:
框架的核心执行单元:把 name、instructions、model、tools 包装成可 generate()/stream() 的对象;定义表面刻意最小,横切能力一律走 Processor。
_Avoid_: 模型本身(Agent 是模型+指令+工具的执行包装,不是 LLM 的同义词)、平台对象、上帝类

**动态参数 (Dynamic argument)**:
配置字段的形状约定:一切字段接受 `T | ((ctx: RequestContext) => T | Promise<T>)`,每次执行按请求上下文解析。
_Avoid_: 仅个别字段支持动态(全字段统一,无一例外)

**RequestContext**:
每次执行传给动态参数解析的上下文对象:框架写入 `signal`(AbortSignal)与 `runId`,其余为用户 per-call 传入的开放属性袋;纯对象。
_Avoid_: mastra 式 Map 类、泛型上下文参数

**Run**:
一次执行的完整生命周期。agent 域:一次 generate()/stream() 调用,从输入到 finishReason,包含零到多个 step;workflow 域:一次 workflow 执行,从 start/resume/restart 到终态(success | failed | suspended)。
_Avoid_: session、conversation(那是 Memory 域的词)

**Run completion**:
一次 Run 如何以其终态记录收尾的判定与构造:完成(`finishReason` 非 `'suspended'`)构造 text / object / toolCalls / toolResults / usage / steps / finishReason,并严格校验结构化输出;挂起(`finishReason` 为 `'suspended'`)保留已完成 Step 的值、`object` 为 `undefined`、跳过结构化校验;失败不是终态值,仍以 rejection 表达。终态构造只有一个 core 内部模块,Agent loop 只交 steps、finishReason 与 structuredOutput 配置(ADR-0019)。
_Avoid_: 把挂起当失败、把失败建模为终态值、在包装器重建终态记录

**Step**:
两层含义,靠语境限定。agent 域:run 内的一轮"模型调用 + 工具执行"(fallback 链的多次模型尝试同属这一轮,不另成 step;mastra 的第三层 model step 不收);workflow 域:图中的一个节点(id + input/output schema + execute)。
_Avoid_: iteration、loop iteration(规范统一用 step)

**输出对象 (Output object)**:
一次执行返回的可双消费对象:`for await` 消费流,`await` 拿终值;两处同一心智。agent 域:`stream()` 的返回对象(chunk 协议流 + text / object / usage / steps / finishReason 等终值;`generate()` 复用同一代码路径);workflow 域:`run.start()` 的返回对象(lifecycle 事件流 + 终态信封)。
_Avoid_: generate/stream 分离的双实现、两套流协议

**Processor**:
Agent 的唯一横切扩展点:挂在 `AgentConfig.processors` 上、按声明顺序串行执行的三钩处理器(processInput / processOutputStep / processError),前一个的返回是后一个的输入;guardrails、evals、脱敏、限流等横切能力的唯一合法承载点。evals 的标准化封装 = `@oribos/evals` 能力包(`scoreRun` 事后整跑 + `createScorerProcessor` per-step 接线,只观察不改写,2026-10-12 #176)。
_Avoid_: 中间件、plugin、以字段形式焊进 Agent 类

**工具 (Tool)**:
框架的工具抽象:`description` + 可选 `inputSchema` / `outputSchema`(Standard Schema 双接口)+ `execute(input, ctx)` 的普通对象,经 `createTool` 工厂或手写字面量创建;自身无 id/name 字段,名字的唯一真相源是容器 Record 键。字段不逐个动态化——动态性由 Agent 的 tools 容器(DynamicArgument)整组承载。
_Avoid_: 把工具做成 class / 注册表;工具携带框架引用(agent / memory 经 requestContext 用户袋或闭包获取,不作参数注入)

**as-tool 组合 (As-tool composition)**:
多 agent 协作的唯一规范形态:把一个 Agent 包装为 Tool 挂进另一 Agent 的工具容器,委派即一次普通工具调用;核心无 sub-agent 概念与委派协议。标准化封装 = `@oribos/supervisor` 能力包(`createSupervisor` 工厂,零新缝零依赖,2026-10-12 #175);手写包装 recipe 仍是定制组合的底层形态(`docs/architecture/agent.md`「多 agent 组合」)。
_Avoid_: supervisor 协议、sub-agent 字段、`.network()`

**Workflow**:
框架的编排子系统:用可变 builder 把 step 组成条目图,commit 冻结后 createRun 执行;语义内核 = 扁平条目列表 + for 循环 walker,suspend/resume 靠 step 边界快照。
_Avoid_: DAG 执行器(本框架 workflow 不是 DAG)、状态机 DSL

**快照 (Snapshot)**:
run 的 JSON 化状态,两种:workflow 域 = step 边界的 stepResults + 位置(块内挂起时另携迭代现场);Harness 域 = durable agent loop 的消息列表 + step 计数 + 挂起点(仅工具调用边界审批闸产生)。suspend/resume/restart 的共用机制,经 storage port 读写,默认内存实现。
_Avoid_: 事件溯源、完整历史(只保留每 run 最新一份)

**迭代现场 (Iteration site)**:
块内挂起时快照携带的块内重进坐标:挂起发生在块内哪一次执行、哪些执行已完成;记录能说清的部分(完成臂/挂起臂)不重复存。只随 suspended 快照出现,resume 据此重进块内。
_Avoid_: suspendedPaths 式多路径挂起模型(不建路径模型,现场尽量由记录承载)、把迭代现场当作执行历史(只保留最新一份)

**Memory**:
框架的记忆子系统:thread/resource 身份 + 消息历史 + 可选工作记忆;存储走 port、默认内存实现;重机制不进核心——语义召回的标准化承载 = `@oribos/rag` 能力包(store 包装:落库 hook 索引 + recall 语义增强,零新缝,2026-10-13 #182),OM 类压缩的标准化承载 = `@oribos/observational-memory` 能力包(请求内联触发、包自有存储 port,零新缝,表面冻结 2026-10-14 #189,落地 2026-10-15 #196),外部记忆系统(如 bunfold)桥接维持分叉。
_Avoid_: 把 Memory 等同于存储 adapter(adapter 归存储决策)、内建后台压缩管线

**Thread**:
Memory 域的会话身份:一次持久会话,消息按 thread 隔离,每个 thread 归属一个 owner(resourceId);per-call 经 `memory: { thread, resource }` 传入,不存在时自动创建。
_Avoid_: session、conversation 作正式词(Run 是一次执行,Thread 是持久会话,两者正交)

**Resource**:
Memory 域的用户/实体稳定标识:跨 thread 共享的锚点,每条消息与每个 thread 都带 resourceId,是工作记忆的归属维度;memory 子系统不做访问控制,授权归应用层。
_Avoid_: user(不总是人类用户)、tenant(多租户隔离是应用层职责)

**记忆身份 (Memory identity)**:
per-call 传入的身份配对 `memory: { thread, resource }`——一次执行落在哪个 Thread、归属哪个 Resource;两字段显式传入、永不默认,任一缺失在执行前报错。与 thread 记录的自动创建是两回事:记录在写路径按需创建,身份字段不存在默认值。
_Avoid_: 把记录自动创建误读为身份可省略、session / conversation(那是 Thread 的禁用词)

**消息历史 (Message history)**:
唯一默认开启的记忆机制:消息持久化 + 最近 N 条窗口(lastMessages)在模型调用前注入 + `recall()` 单一查询入口;消息格式即模型契约的 vendor prompt 类型加存储信封(id/threadId/resourceId/createdAt)。
_Avoid_: short-term memory、chat history 作术语

**工作记忆 (Working memory)**:
可选的跨会话小块结构化记忆(用户画像/偏好/当前目标),resource 作用域;作为 system message 注入,agent 经 tool-call 更新。
_Avoid_: long-term memory(向量召回、后台压缩类"长期记忆"机制不在核心,经能力包桥接)

**Span**:
观测域的单个操作记录:自有最小形状(id / 32-hex traceId / parentSpanId / name / type / 起止时间 / 一等公民 input/output / attributes / metadata / error / isEvent),非 OTel span——OTel 映射只发生在 semconv 映射(叶子包 `@oribos/semconv`,OTLP 能力包与 OTel bridge 复用)。框架只写 7 个类型常量(agent-run / agent-step / tool-call / workflow-run / workflow-step / memory-recall / memory-save),type 字段开放给用户自定义。
_Avoid_: OTel span 作内核概念、metrics/logs 信号(v1 只定 tracing)

**Tracer**:
观测子系统的入口对象:`createTracer({ exporters, sampler?, spanProcessors? })` 产物,经组合根注入分发;负责 root 采样判定(不通过则 NoOpSpan 传播)与 span_started/updated/ended 三事件派发;缺席时全子系统零开销。
_Avoid_: OTel Tracer、全局单例

**观测导出器 (Observability exporter)**:
把 tracing 事件送出进程的接口:`{ export(event), flush?(), shutdown?() }`;核心自带 console 与 memory 两个,OTLP 在能力包(GenAI semconv 映射居叶子包 `@oribos/semconv`),OTel bridge 在能力包 `@oribos/otel-bridge`(三事件桥成宿主 TracerProvider 的真 OTel span,复用同一叶子),厂商专用 exporter 不做(裸 OTLP + gen_ai.* 已覆盖各家后端)。
_Avoid_: plugin、integration(那是能力包的词)

**存储 port (Storage port)**:
子系统持久化需求的最小接口,由核心定义类型并自带内存默认实现;v1 四个:`MemoryStore`(消息历史/工作记忆,6 必备 + 2 条件)、`WorkflowSnapshotStore`(workflow 快照,2 方法 + JSON-only)、`AgentRunSnapshotStore`(durable agent loop 快照)与 `ScheduleStore`(调度记录)。演化纪律 = additive-only:1.0 起必需方法签名永不改,新能力只以可选方法 + 能力标志增加,breaking 只在 major。
_Avoid_: composite store、分域路由(mastra 式域路由为强制中央实例服务;本框架子系统各自接收 store 实例,分后端是用户侧自由)

**存储 adapter (Storage adapter)**:
实现一个或多个存储 port 的能力包(统一 adapter 家族);连接生命周期自拥(可选 `init?()` / `close?()`),核心永不隐式调用。第一方清单 = 核心内存实现 + 恰好一个 SQLite 系参考 adapter,其余后端归社区。
_Avoid_: 把存储层当子系统(它只是 port 集合 + adapter 家族)、核心托管连接生命周期(进程 hook 与无运行时负担冲突)

**存储包装 (Store wrapper)**:
保持 `MemoryStore` 接口、只在少数方法上叠加策略的包装器;`listMessages` 可返回基础窗口(内层 store 对同一查询返回的窗口)的超集,其余方法透传或按策略覆写(如 `deleteThread` 的级联删除)。它是能力包的组合形态,不是后端 adapter,也不是 port 的扩展。
_Avoid_: decorator(暗示完全透明)、adapter(后端实现)、middleware

**能力标志 (Capability flag)**:
port 可选能力的声明与降级机制:可选方法的存在性即声明,核心调用前检测,缺席时按既定语义降级或显式报错(如 MemoryStore 条件 2 仅 working memory 启用时要求;快照 CAS 缺席即退回单进程语义)。additive-only 演化纪律的载体。
_Avoid_: 基础 port 为覆盖场景而膨胀(基础形状冻结,扩展一律走可选方法)

**Harness**:
规范第六块 = **文档分类名而非统一模块**:持久执行与后台能力(durable 挂起/恢复、signals、schedules)的总称;各能力独立表面、按需取用,不存在 Harness 类/实例。
_Avoid_: Harness 类、中央运行时(那是 mastra 已废弃的形状)

**Durable agent**:
经 `createDurableAgent` 包装的 agent:run 可在工具调用边界挂起(审批闸),loop 快照走 storage port,`resume` 携带审批结论恢复;挂起语义的默认载体是包装——裸 agent 不传公开 `stepBoundary` 时无挂起,显式传入即得同一语义。
_Avoid_: 崩溃自动恢复、resumable stream(两者均另立能力包:`@oribos/checkpoints` / `@oribos/resumable-stream`;本词的恢复 = `resume` 原语)

**信号 (Signal)**:
thread 导向的交互原语:向活跃 run 注入、唤醒空闲 thread 开新 run、或排队保序;注入内容落消息历史,单进程语义。
_Avoid_: 跨实例 PubSub/租约(归能力包)、notification inbox(已裁出)

**调度 (Schedule)**:
未来触发 agent 的记录 + `tick` 原语(给定时刻返回到期项并触发);记录是到期缓存,不含 cron 表达式——表达式由宿主侧调度定义持有、构建 `next` 注入(`next` 函数不序列化);触发执行交给平台 cron 或可选进程内 ticker,核心不做轮询调度器。
_Avoid_: 内建调度轮询循环、存储 CAS 认领(多实例安全归平台/部署方)

**可恢复流 (Resumable stream)**:
断连重连的流式承载:事件缓存逐 chunk 记录 run 的输出流,`observe(runId)` 按序重放缓存 + 进程内跟随到 run 终态(`closeOnSuspend` 无机制——durable 流以 suspended finish 收尾即自然关闭)。标准化承载 = `@oribos/resumable-stream` 能力包(事件缓存 port 内存默认零依赖、Redis 结构子集适配 opt-in,零新缝,2026-10-14 #184);核心无恢复端点(GET 端点归应用),跨实例实时跟随归 PubSub 能力包(显式拒绝不轮询)。
_Avoid_: 核心内建 resume 端点、轮询跟随循环(无常驻管线)

**检查点 (Checkpoint)**:
崩溃安全的 run 承载:每个继续的步骤在边界写一条检查点(run 的 prompt + 该步 assistant 消息 + 步数 + 持有调用 + trace),run 终态(成功 / 失败 / 挂起)即清除;残留 = 进程死于途中的 run。标准化承载 = `@oribos/checkpoints` 能力包(`recover(runId)` 经 `AgentRunResume` 重放:重放步零模型调用、只重发 in-flight 那一次,其工具重执行 = 显式幂等成本;`recoverAll()` = boot 扫描;store 四方法 port、内存默认、持久归部署方,零新缝,2026-10-14 #186)。
_Avoid_: 常驻恢复守护 / 轮询扫描(无常驻管线)、核心内建 recoverAll、多副本抢同一批 run(leader election 归部署方,与跨实例 signals 行同口径)

**跨实例 signals (Distributed signals)**:
基础信号原语的跨实例承载:包装核心 `Signals`(`createDistributedSignals`),send 三原语与空闲唤醒经共享 PubSub 路由、租约裁定唤醒竞态;stream / generate 永远本地。标准化承载 = `@oribos/distributed-signals` 能力包(at-most-once、进程死在途即丢,与核心单进程语义同构,表面冻结 2026-10-14 #187)。
_Avoid_: 核心注入缝 / transport 配置(核心单进程语义不变)、跨实例 chunk 实时跟随(v1 显式拒绝)、notification inbox(已裁出)

**租约 (Lease)**:
对命名工作单元的、带 TTL 和 token 的排他所有权:acquire 竞争失败方不作为,持有期心跳或边界续约,丢失后持有方停止声明。机制层一份(ADR-0020);丢失语义归消费者——thread 活跃 run 所有权(本地 run 开始即持、settle 即释放,唤醒竞态的裁定者)与后台任务执行权(领到才执行,过期即 `adopt()` 孤儿候选)。标准化承载 = `@oribos/lease`(共享机制,能力包以 `dependencies` 依赖,ADR-0020;实施 #206);消费者 = `@oribos/distributed-signals` / `@oribos/background-tasks`。
_Avoid_: leader election(归部署方)、核心存储域 port(v1 四个冻结)、与 CUT-ST3 裁出的 lease 分域(概念只有一个)

**外部 runner (External runner)**:
workflow 触发层耐久性的外包:start / resume / 恢复事件化到外部耐久执行引擎,进程死于途中由引擎重试重放、快照续起;walker 与快照 store 原样在进程内(触发级外包,非步级接管)。标准化承载 = `@oribos/inngest` 能力包(引擎裁定 Inngest 单落,Temporal 维持分叉;最小触发式表面、零核心新缝,表面冻结 2026-10-14 #188,落地 2026-10-15 #195)。
_Avoid_: 步级执行接管(需核心执行缝)、耐久 sleep / workflow cron / 实时 stream(均不透出,各归既有裁行与能力包地界)

**观察记忆 (Observational memory)**:
把滑出最近窗口的旧消息由模型压缩成**观察**、观察累计再压缩为**反思**的长程记忆承载:无游标窗口读内联触发(积压过阈跑 Observer、观察过阈跑 Reflector),观察/反思以一条 system 消息前置、窗口原样。标准化承载 = `@oribos/observational-memory` 能力包(`createObservationalMemoryStore` 包装 store;观察记录 = 包自有 port,内存默认、持久归部署方;核心零新缝,表面冻结 2026-10-14 #189,落地 2026-10-15 #196)。
_Avoid_: 常驻压缩管线 / 响应后写(mastra 式异步缓冲 + `settled()`)、priority 排序、resource scope 跨线程压缩、把观察记录当消息(消息不可变,观察/反思是附加派生记录)

**后台任务 (Background tasks)**:
应用自有工作的持久协调:任务行(accepted → running → done | failed,attempt 计数)+ 租约执行——manager 收 handler 驱动:提交 → 领租约 → 进程内执行 → 心跳 → settle;`adopt()` 重跑孤儿(幂等成本显式)、`untilIdle()` 包级等待(不改 agent 流)。标准化承载 = `@oribos/background-tasks` 能力包(与 signals 解耦:settle 经回调交应用,一期「工具 ack + sendSignal 唤醒」配方零负担照旧;任务行 / 租约两 port 内存默认,持久与多实例归部署方,表面冻结 2026-10-14 #190,落地 2026-10-15 #197)。
_Avoid_: 常驻 worker / 重试策略(归部署方)、核心内建 manager(零常驻红线)、接管宿主进程
