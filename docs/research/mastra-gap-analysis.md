# 调研:mastra 总对比——差异、差距与重开条件

> 对比 ticket:[#63](https://github.com/0xnicholas/balsats-framework/issues/63)(首版);刷新票:[#101](https://github.com/0xnicholas/balsats-framework/issues/101)(第二版)、[#145](https://github.com/0xnicholas/oribos-framework/issues/145)(第三版)。首版:2026-09-30;第二版:2026-10-02;**第三版:2026-10-11**(沿 [#101](https://github.com/0xnicholas/balsats-framework/issues/101) 口径,以 0.6.0 发布后的框架状态重对账)。
> 定位:把四份前序调研(mastra 的 Agent 与模型层、Memory、Workflows、Harness)与框架本体对账,给出**总账视图**;不做新裁决。首版沿各调研的钉、不重抓上游;第二版重抓 mastra 上游;**第三版为定点重抓**:只对定位面已动的四线重抓——OM / Harness / 模型层 / 出域确认(消费调研票 [#141](https://github.com/0xnicholas/oribos-framework/issues/141)–[#144](https://github.com/0xnicholas/oribos-framework/issues/144)),其余事实沿 2026-10-02 钉不重抓,文中标「沿旧钉」。
> 事实基线(本轮):mastra 侧钉在 **2026-10-11** 快照(线上 latest `@mastra/core@1.75.0`(2026-10-10)、main `f4477eb9` 在跑 `1.76.0-alpha.7`,**下一 major 未发**;`@mastra/memory@1.36.0`、`@mastra/react@1.8.0`);本框架侧钉在 **2026-10-11 现状**(七包 `@oribos/*@0.6.0` 上线 npm、单 tag `v0.6.0`;完善阶段 11 必须项全落地;`pnpm verify` 全绿 **947 例 72 文件**;`check:dist` 16 子路径;字节预算 16/16 零超支)。
> **「重开条件」的单一真相源 = `docs/ROADMAP.md`「延后清单」**;本文只给分档与对比视图,不复制条件。第二版刷新触发「M5 收尾」已消费;**第三版触发 = 0.7 规划地图 [#140](https://github.com/0xnicholas/oribos-framework/issues/140) 的定点刷新**;下次刷新触发(先到者):mastra 下一个 major / 公开 1.0 前。

## TL;DR

- mastra 是"从原型到生产"的平台化框架:1.x 已发布且**迭代以天计**(本轮窗口 9 天 1 个 minor:1.74.0 → 1.75.0,alpha 线 `1.76.0-alpha.7`;下一 major 未发);`agent.ts` 10,725 行 / `AgentConfigBase` 顶层字段 39 个 / core 30 个直接依赖(三项沿旧钉)/ 注册表 211 providers、7,790 models(开发期每小时刷新);本框架是**七包**(核心 + 六能力)、核心包零运行时依赖、规格先行的轻量重实现(`@oribos/*@0.6.0`)。
- **已对齐 18 项**(双轨模型层、输出对象双消费、DynamicArgument、Processor 唯一横切口、扁平条目 walker、快照 suspend/resume、thread/resource、Harness = 分类名…):对齐的是**语义**,不是维护负担;本轮无对齐面变动(`.network()` 弃用获官方迁移文档确认,方向早已对齐)。
- **有意分叉 12 面**(模型路由、Agent 配置面、Processor 生命周期、Memory 机制集、Workflow 高级语义、Harness 范围、观测、存储、中央实例、多 agent 形态、产品面、演化姿态):每面有 ADR 依据;本轮换钉五面(模型路由 / Memory 机制集 / Workflow 高级语义 / Harness 范围 / 演化姿态)。
- **缺口台账 21 项不变**(延后 12 / 出域 7 / 现实差距 2):第三版对 `docs/ROADMAP.md` 延后清单 **20 能力行**(延后档 13,含 bunfold 桥裁单行 + 出域档 7)逐条**禁跟单**核对——**零行重开条件被满足**(如实记;唯一争议行「外部记忆引擎桥接」第二臂判不满足:mastra OM 形态未变、且非该条件所指的外部引擎类)。现实差距「发布」行随 0.6.0 更新为新态。
- **结论不变**:轻量轴成立且与 mastra **不收敛**——本轮窗口的上游动向集中在营销层与产品面(OM 落地页头条化、supervisor 协调 / 人工审批闸 / scorers / Studio 进首屏 FAQ、Studio 云化持续);定点四线全部为「形态不变或营销动作」:supervisor 仍无独立实装、后台任务租约不变、durable 默认引擎未换、spec 四代并存姿态未收敛。不重开任何现裁决。

## 口径

- **已对齐**:形状照 mastra(经调研证明其可行)但按本框架依赖预算重实现——对齐语义,不对齐维护负担。
- **有意分叉**:同能力、不同重量或语义;依据在各 ADR。
- **缺口**:mastra 有、本框架没有;按处置分档——延后(触发式)/ 出域 / 现实差距(非功能)。M5 能力包已于 0.5.0 交付,不再占缺口行(见 §4.1)。
- **重开条件**:延后/出域档缺口重新进入路线图的判定信号,必须外部可观察、可累计;单一真相源在 `docs/ROADMAP.md`(术语见 `CONTEXT.md`)。
- **本轮刷新的边界**:只换事实与对账视图——升降档需 ROADMAP 侧条件先行,本文不自行新增或移除缺口行。

## 0. 基线

|  | mastra(快照 2026-10-11) | Oribos(2026-10-11 现状) |
| --- | --- | --- |
| 状态 | 1.x 已发布(1.0 于 2026-01-20);线上 latest `@mastra/core@1.75.0`(2026-10-10),main `f4477eb9` 跑 `1.76.0-alpha.7`;**下一 major 未发** | 七包 `@oribos/*@0.6.0` 已上线 npm(2026-10-05,未认证七端点全 200;接替 `@balsats/*` 0.5.0,旧 scope owner 已下架),单 tag `v0.6.0` + Release([#139](https://github.com/0xnicholas/oribos-framework/issues/139));完善阶段 11 必须项全落地([#130](https://github.com/0xnicholas/oribos-framework/issues/130) 收口);M1–M5 全部内容 |
| 形状 | `agent.ts` 10,725 行、`AgentConfigBase` 顶层字段 39、core 30 个直接依赖、core exports 87 子路径(均沿 2026-10-02 钉,本轮定点未重抓) | 七包(核心 + 六能力)、core 10 子路径 / 全树 16 子路径、core / sqlite / ai-sdk 零运行时依赖、字节预算 16/16 零超支(内部参考,ADR-0001) |
| 生态 | provider 注册表 211 providers / 7,790 models(1.75.0 内置文件实测;开发期每小时自动刷新)、capabilities 文件 207(沿旧钉)、`stores/` 31 个第一方 adapter 目录(沿旧钉)、Studio / editor / channels / voice / scorers / RAG / Inngest / Temporal / deployers / client-js / mastracode;本轮新增公共 hooks 包 `@mastra/react@1.8.0`(Studio 改吃) | 能力包六个(`@oribos/otlp`、`mcp-server`、`mcp-client`、`sqlite`、`ai-sdk`、`croner`)、10 个 example、4 个存储 port + 内存默认实现 + SQLite 参考 adapter |
| 体量参照 | memory 域 in-memory 参考实现 1,281 行(沿旧钉)/ `MemoryStorage` **40** 方法(OM 17 不变;36→40 增量为 run fencing 与 atomic WM merge,与 OM 无关);`workflows/workflow.ts` 211,020 字符(沿旧钉) | 组合根 `.` 48,369 B、`./workflows` 17,415 B、otlp 8,259 B、sqlite 11,588 B(minify 后,内部预算数字);`pnpm verify` 947 例 72 文件 |

## 1. 已对齐(照 mastra 验证过的形状)

| 面 | 对齐的形状 | 依据 |
| --- | --- | --- |
| 模型层 | 双轨:自有 loop + 自有 chunk 协议;AI SDK 只作类型底座与 provider 实例来源,格式互操作独立成包 | 调研 #4 / ADR-0004 |
| 输出对象 | 同一对象双消费(`for await` 流 + `await` 终值);`generate()` = `stream()` + await,单代码路径 | 调研 #4 |
| 动态参数 | 全字段接受 `T \| ((ctx) => T \| Promise<T>)`,按请求上下文解析(本框架更严:无一例外) | 调研 #4 |
| Processor | 唯一横切扩展点;guardrails / evals / 脱敏 / 限流不进 Agent 字段 | 调研 #4 / ADR-0005 |
| Agent 表面 | 最小核心 name / instructions / model / tools(+ description);`maxSteps` 默认 5 | 调研 #4 |
| Workflow 形态 | 扁平条目列表 + for 循环 walker;builder 可变链式 + `commit()` 冻结,**不是 DAG** | 调研 #3 / ADR-0006 |
| IO 校验 | Standard Schema 双接口、固定边界校验(mastra 内契约 `StandardSchemaWithJSON`;本框架零适配器) | 调研 #3 / ADR-0003 |
| 挂起/恢复 | suspend 控制信号 + step 边界 JSON 快照 + storage port;`start` / `resume` 同一信封 | 调研 #3 / ADR-0006 |
| Memory 身份 | thread / resource 双标识:消息按 thread 隔离、按 resource 共享锚点 | 调研 #5 / ADR-0007 |
| 消息历史 | 唯一默认开启的机制:`lastMessages` 默认 10 + 单一 `recall()` 查询入口 | 调研 #5 |
| 工作记忆 | 小结构化记录,作为 system message 注入,agent 经 tool-call 更新;resource 作用域 | 调研 #5 |
| 多 agent | 委派 = 普通 loop 内的一次工具调用;`.network()` 已废弃(本轮定点:官方迁移文档宣告弃用——"development now focuses on supervisor agents",源码尚未打 `@deprecated`),mastra 自己收敛到 loop 内 | 调研 #4 / ADR-0012 |
| Harness 形态 | 文档分类名而非统一模块(mastra 源码 `Harness` 已降级为 `AgentController` 的废弃别名);其 harness 文档现列 7 项能力 + `createCodingAgent()` 工厂行,6 项带 Beta 横幅(沿旧钉) | 调研 #17 / ADR-0011 |
| 调度复用 | threaded 触发 = 向会话注入 signal,不新建运行时 | 调研 #17 |
| 终态词汇 | `finishReason: 'suspended'` 承载挂起 | 调研 #4 |
| 模型降级 | fallback 链是一等输入形状(本框架更保守,见 §3) | 调研 #4 / ADR-0004 |
| 结构化输出 | run option `structuredOutput: { schema }`,终值校验后落 `object`(本框架只 strict) | 调研 #4 |
| MCP | 同一份 Tool 双向流通;mastra 侧 1.68 起 `@mastra/mcp@2.x` 落在 MCP 2026-07-28 修订面——**本框架 0.5.0 已交付** `@oribos/mcp-server` / `@oribos/mcp-client`(同一代 SDK 面) | tools.md / M5 |

## 2. 有意分叉(同能力,不同重量/语义)

| 面 | mastra(快照 2026-10-11) | 本框架(依据) |
| --- | --- | --- |
| 模型路由 | `'provider/model'` magic string + 211-provider 注册表(7,790 models;开发期每小时刷新)+ GatewayManager 链 + 认证解析 + **4 代 spec 适配器**(devDeps `@ai-sdk/provider` v4/v5/v6/v7 并存,运行时携 v5/v6/v7 三代别名,**姿态未收敛**,HEAD 同);`dynamic-model-router` dist-tag 经核实为 2025-10 旧机制(PR #8688)的源头快照,非新增动态化 | 实例直传(任意 AI SDK provider 实例结构满足契约)、单一 spec 版本硬断言(钉 v4 = mastra `-v7` 别名代 = `@ai-sdk/provider` major 4;上游最新 4.0.26 同 major,**暂无升代压力**)、升代升 major;无注册表/网关/magic string(ADR-0004) |
| Agent 配置面 | `AgentConfigBase` 顶层字段 39 个(沿旧钉;memory / agents / scorers / durable / pubsub / backgroundTasks / signals / goal / notifications / editor / voice / channels / workspace / skills / hooks…),含字段级 Editor 所有权 | 5 个定义字段 + memory 一等可选 + tracer/processors 两个接线缝;重能力挂包边界(ADR-0005) |
| Processor 生命周期 | 三层(run > loop iteration > model step)、约 9 个钩子(含 processLLMRequest / processToolResult / processAPIError)、`abort({ retry })` + 重试上限 | 三钩单层(processInput / processOutputStep / processError),无重试 / abort 语义 |
| Memory 机制集 | semantic recall(1.0 起默认关闭)+ OM 观察记忆(推荐但 opt-in;2026-10 落地页头条化 = **营销层动作**,实装形态不变:进程内 Observer/Reflector 后台 agent、无需常驻服务,存储面 OM 方法 17 个不动)+ thread cloning + **40** 方法存储域(36→40 增量为 run fencing 与 atomic WM merge,与 OM 无关)+ composite store + 默认 libSQL 落盘 | 8 方法 port、无向量、无后台压缩、无 cloning、无 composite;OM 归外部记忆系统桥(ADR-0007 / 0010) |
| Workflow 高级语义 | time-travel / restart / restartAllActiveRuns、state 黑板、bail、map / sleepUntil、嵌套 workflow、evented 引擎(1.72.0 转正;**默认引擎未换**,`Workflow.engineType` 仍 `'default'`,schedule 自动切 evented 收窄为 `MASTRA_WORKERS` 门控)、"Run ownership"(run 级 claim + 存储 fencing)**文档先行**——1.75.0 包内无代码、预计随 1.76.0 落地、Inngest / Temporal 引擎、shouldPersistSnapshot / prune、resume CAS | 只暴露 load→重进原语;持久化 = port;durable 重启归 Harness;resume 去重 = 进程内锁 + adapter 可选 CAS(ADR-0006 / 0010) |
| Harness 范围 | 7 项能力(durable / background tasks / goals / schedules / signals / signal providers / AgentController)+ `createCodingAgent()`,6 项 Beta(沿旧钉);PubSub + 租约 + 轮询 worker;后台任务租约形态不变(1.72 起持久化 ownerId + 过期租约;`untilIdle` 入口已统一为 `stream({ untilIdle: true })`,`streamUntilIdle()` 自 1.46.0 起 deprecated);无新 SSE 管理面 | 三件套(durable 审批闸 / signals / schedules tick);单进程语义显式;跨实例归能力包;平台 cron 是一等形态(ADR-0011) |
| 观测 | OTel 生态向 + 存储域 + scorers;1.71 起存储/服务/客户端做能力协商(observability capabilities)与 trace 聚合规划 | 自有最小 span 模型(7 个类型常量)、started / updated / ended 三事件、exporter 流式、span 不落库;OTLP 映射在能力包(ADR-0009) |
| 存储 | 域划分 + `MastraCompositeStore` 分域路由 + `stores/` 31 个第一方 adapter 目录(libsql / pg / mongo / upstash / d1 / convex / duckdb / dynamodb / …)(沿旧钉) | 4 个 port + 恰好一个 SQLite 参考 adapter,其余社区;无 composite(强制中央实例不存在)(ADR-0010) |
| 组合根 | `new Mastra({...})` 中央实例,storage / pubsub / gateways 由它持有 | `createApp` 可选薄组装点;子系统独立 `new` 是一等用法(ADR-0002) |
| 多 agent 形态 | `agents:` 字段 + delegation 钩子(onDelegationStart / Complete、messageFilter、结果引用、memory 隔离、versions 传播);官方迁移文档宣告弃用 `.network()`、转向 supervisor agents,但 supervisor 仍**无独立模块 / 工厂 / 新协议**(本轮定点;delegation 面增量仅钩子级修补) | as-tool 组合:零协议、上下文零透传;钩子退化为用户态平凡代码;`createSupervisor` 类进演化门(ADR-0012) |
| 产品面 | Studio / editor / stored agents、channels、voice、workspace / browser、scorers / evals、RAG、server(hono)/ client-js、deployers、`mastracode` 编码 agent 与 Mastra Factory、托管云;本轮新增公共 hooks 包 `@mastra/react@1.8.0`(客户端库与托管面进一步分离) | 出域或能力包;框架嵌入宿主应用而不接管(地图 Out of scope) |
| 演化姿态 | API 快速漂移(本轮窗口 9 天 1 个 minor:1.74.0 → 1.75.0;main 跑 `1.76.0-alpha.7`,**下一 major 未发**;4 代 spec 并存姿态未收敛);注册表 9 天 +1 provider / +52 models | spec-first 冻结、port additive-only、字节预算 CI 黄灯(ADR-0001 / 0015) |

## 3. 形状内语义差异(从 mastra 迁移会踩的点)

- **Agent / 模型层**:instructions 仅 string(无 string[] / SystemMessage / providerOptions);同一步多个工具调用**串行**执行(mastra 侧 1.71 起:某次工具调用的参数流完即启动,不再等本步模型流结束,可按 run 关闭);`structuredOutput` 只 strict(无 errorStrategy / jsonPromptInjection);chunk 协议只有四种(`text-delta` / `tool-call` / `tool-result` / `finish`,无推理增量、参数增量);fallback 只在该次尝试**尚未产出任何 chunk** 时切换(流中途失败不切换);`maxSteps` 耗尽时 `finishReason: 'tool-calls'`(框架自身的截断信号)。
- **Workflow**:`dowhile` 条件在**迭代前**求值、可 0 次迭代(mastra 的 dowhile / dountil 都是迭代后求值、至少一次);`retries` = 额外尝试数、固定间隔 1000ms、等待可被 AbortSignal 打断(mastra 可配、缺省 0 延迟、不可打断);`sleep` 的动态时长 fn 收 `RequestContext` 而非上一步输出;无 `waiting` 状态、abort 即 failed;resume **按记录回放**重建 tip(不重执行、不重估条件),`resumeData` 只给被点名的那一次执行,兄弟臂 / 后续迭代拿 `undefined`;快照是固定五字段 + 可选 `traceId` / `iterationSite`(无 `suspendedPaths` / `serializedStepGraph` 路径模型);拿掉 state 黑板 / `bail` / `map` / `sleepUntil` / 嵌套 workflow / `createStep(agent|tool)`;`suspend()` 在四类块体内都成立,但条件里调用报错。
- **Memory**:工作记忆只有 schema 形态(merge 语义,无 markdown 模板的 replace 语义);无单条消息 update / delete(`deleteThread` 级联兜底);无 thread cloning;不做访问控制(授权归应用层)。
- **Harness**:审批声明在 durable 包装层,工具保持四字段;`approved: false` = 以「用户拒绝」工具结果回喂模型、run 继续;signals 固定三句语义(无 `ifActive` / `ifIdle` 行为矩阵),排队队列进程内;调度无触发记录(span 覆盖追责);`tick` 本身无 span。
- **观测**:快照里只持久化 `traceId`(mastra 存整个 tracingContext);resume = 同一 traceId 下的**新 run span**(一次人机交互 = 同 trace 多 span)。

> 本节为本框架侧形状,本轮(第三版)刷新未变动(首版各调研的钉仍有效;定点四线未触及形状内语义)。第二版曾补记 §3 第一条 mastra 1.71 的 eager tool execution。

## 4. 缺口分档

> 第三版对 `docs/ROADMAP.md` 延后清单 **20 能力行**(延后档 13 + 出域档 7)逐条**禁跟单**核对(判定记录见 [#145](https://github.com/0xnicholas/oribos-framework/issues/145) 决议):**零行满足重开条件,全部原地留**;本节只换 mastra 侧事实列,不加减行。

### 4.1 M5 已交付(0.5.0;第二版出账,不再占缺口)

| 件 | 状态 | 事实 |
| --- | --- | --- |
| OTLP exporter | 交付 `@balsats/otlp`(8,276 B / gzip 2,943 B) | GenAI semconv 映射 + 官方 OTel 包拼接;HTTP(+proto exporter)(#73 / #91) |
| MCP server / client | 交付 `@balsats/mcp-server`(1,601 B)/ `@balsats/mcp-client`(2,290 B) | 同一份 Tool 双向流通,HTTP + stdio 双 transport(#74 / #75 / #87 / #88) |
| SQLite 参考 adapter | 交付 `@balsats/sqlite`(11,971 B,零运行时依赖) | 四 port 单工厂 + `node:sqlite`;跨进程挂起恢复 example(#76 / #89) |
| AI SDK 互操作 | 交付 `@balsats/ai-sdk`(8,253 B) | chunk 协议 ↔ AI SDK UI stream + `createChatRoute` 等价物(#77 / #90) |
| croner 封装(首版未列,同窗口交付) | 交付 `@balsats/croner`(196 B) | cron 表达式 → `next` 注入片段(#78 / #92) |
| bunfold 桥 | **裁单**(不产包) | 重开条件在 ROADMAP 延后清单「外部记忆引擎桥接」行 |

### 4.2 延后档(触发式)

重开条件见 `docs/ROADMAP.md`「延后清单」(单一真相源);下表只给 mastra 侧事实与承载缝。

| 缺口 | mastra 侧的事实(2026-10-11) | 承载缝 |
| --- | --- | --- |
| supervisor 语法糖 | `agents:` 字段 + delegation 钩子 + memory 隔离 + 结果引用(本轮定点:**仍无独立 supervisor 模块 / 工厂 / 新协议**;`.network()` 官方迁移文档宣告弃用、源码未打 `@deprecated`) | 能力包优先;核心字段须重开 ADR-0012 演化门 |
| RAG / 语义召回 | semantic recall(默认关)+ 17+ 向量库适配器 + embedder 依赖(沿旧钉);knowledge v2 以 `@mastra/core/knowledge` 子路径进 core alpha 线(`1.76.0-alpha.7`;稳定版 1.75.0 尚无,wave 2/4 在途) | memory 落库 hook + 能力包 |
| Evals / scorers | scorers 挂在 Agent 配置上 + 独立评估包(沿旧钉;落地页 FAQ 营销位新增) | Processor,或独立包消费 run 结果 |
| 字符串路由(models.dev 类) | `'provider/model'` + 211-provider 注册表(7,790 models)+ 网关链 + `ModelSelectionProcessor`(1.70,按请求选模型);`dynamic-model-router` dist-tag 经核实为 2025-10 旧机制源头快照,非新增 | 能力包 |
| OTel bridge 能力包 | 观测偏 OTel 生态;1.71 起存储/服务/客户端做 observability 能力协商(沿旧钉) | 能力包(与已交付的 OTLP 导出分属两件事) |
| background tasks | manager + 执行所有权租约(1.72 起持久化 ownerId + 过期租约,多 worker 安全)+ 心跳;**租约形态本轮不变**;`untilIdle` 入口统一为 `stream({ untilIdle: true })`(`streamUntilIdle()` 自 1.46.0 deprecated);无新 SSE 管理面(`manager.stream()` 仅增 `includeExisting`);1.69 起工具可 `context.background.adopt()` 交接长任务 | 文档范式(工具 ack + sendSignal)→ 能力包 |
| goals / state signals | judge 判定 + 预算 + thread state 持久化(沿旧钉) | 能力包;前置 = thread 状态域 |
| 跨实例 signals | Redis Streams PubSub + LeaseProvider + `PubSub.trimTopic()`(1.72)(沿旧钉) | 能力包 |
| resumable stream | 事件缓存(默认内存 / 生产 Redis)+ `observe(runId)`;durable 流可 `closeOnSuspend`(1.70)(沿旧钉) | 能力包 |
| 外部 runner 适配 | Inngest / Temporal 引擎(沿旧钉) | 能力包(引擎接缝已留) |
| 每步检查点 + 崩溃重放 | `recovery: 'auto'` + boot 时 `recoverAllDurableAgents()`(默认不写 running 检查点)(沿旧钉;evented 引擎 1.72.0 转正但默认引擎未换) | 能力包 / 部署方 |
| time-travel / restart | 快照 + `serializedStepGraph` 上的免费变种(沿旧钉) | load→重进原语上的薄变种,无 port 变更 |

### 4.3 出域档(定位改变才重开)

| 缺口 | mastra 侧的事实 | 出域依据 |
| --- | --- | --- |
| Studio / editor / stored agents | Editor = agent 的 CMS(DB / code 双轨、draft / published 版本化);**Studio 云化持续活跃**(官方文档写明 deploy Studio on Mastra platform;本轮窗口 PR / dist-tag 不断)——理由加厚 | 托管产品面 |
| channels / voice / workspaces & sandboxes | Slack 等渠道、语音、文件 / 沙箱;1.72 起渠道解析器可在运行时热更新(沿旧钉) | 产品面 / 生态 |
| 托管平台 | 托管云(沿旧钉) | 商业 |
| OM 类后台压缩 | Observer / Reflector 两个**进程内**后台 agent + 存储面 OM 方法 17 个(不变);实装仍为 `@mastra/memory` 内 **opt-in 库形态、无需常驻服务**;2026-10 落地页头条化(pricing 卡三大件之一)为营销层动作,非形态变化 | 后台写入与"无运行时负担"冲突(进程内后台 agent 仍是运行时负担);归外部记忆系统桥 |
| notification inbox | 持久化收件箱 + 两阶段投递(仅 3 个 adapter 支持)(沿旧钉) | 产品面 |
| signal providers | webhook / poll 入口基类(订阅登记簿 DIY)(沿旧钉) | 示例模式可承载 |
| AgentController / session | modes / permissions / channels / workspace 的成品运行时;旁有 `createCodingAgent()` 工厂与 `mastracode` 产品(沿旧钉) | 应用层自组装 |

> 出域档 7 行理由措辞本轮**无需修订**([#144](https://github.com/0xnicholas/oribos-framework/issues/144) 确认:react-sdk 证实为纯客户端库、knowledge v2 本就不在 7 行内、Studio 云化性质不变——三线均仍落在既有出域理由覆盖内);react-sdk 事实记于 §2 产品面行,knowledge v2 事实记于 §4.2 RAG 行。

## 5. 现实差距(非功能,选型者最先看见)

| 差距 | 事实 | 状态 |
| --- | --- | --- |
| 发布 | 首版记"1.x 已发布 vs 0.0.0 / 无 tag / registry 无包"的落差 | **结案(2026-10-02,0.5.0)→ 新态(2026-10-05,0.6.0)**:七包 `@oribos/*@0.6.0` 上线 npm(scope 首发,接替 `@balsats/*` 0.5.0;旧 scope 七包 owner 有意下架)、单 tag `v0.6.0` + Release([#139](https://github.com/0xnicholas/oribos-framework/issues/139));此前核对 [#97](https://github.com/0xnicholas/balsats-framework/issues/97) / 收口 [#99](https://github.com/0xnicholas/balsats-framework/issues/99) |
| 上手面 | mastra.ai 文档站 + Studio + 快速开始 | **半结案**:README quick start 已随 0.5.0 可用(安装命令 + 子路径面经注册表冒烟,0.6.0 同口径);文档站归侧翼动线,不在本框架动线内 |
| 适配器生态 | mastra `stores/` 31 个第一方 adapter 目录 + provider 目录(沿旧钉) | **保留**:本框架 = 内存默认 + 恰好一个 SQLite 参考 adapter;适配器生态留社区(第二后端诉求才是触发) |
| 公开可检验性 | 首版记"轻量主张只有内部 CI 证据" | **结案(2026-10-02 身份裁决)**:数字一律不对外(ADR-0001 立场),**机制可讲**(零依赖硬闸门、字节预算黄灯);0.5.0 上线后主张可被实测(0.6.0 同) |

## 6. 对比揭示的东西

1. **mastra 的动向在反向验证多数裁剪**:OM 的 resource 作用域被官方弃用(本框架只做 thread 隔离 + 小结构化 resource 状态)、`.network()` 废弃回到 loop 内委派(本轮获官方迁移文档确认:"development now focuses on supervisor agents"——而其 supervisor 卖点**仍无独立实装**,就是 `agents:` 字段这套旧 pattern,即本框架 as-tool 的同款方向)、Studio / editor 是产品面、4 代 spec 并存(姿态本轮仍未收敛)是"接受一切"的维护账单、6/8 Beta 是跟随成本;**本窗口新增同向证据**:OM 落地页头条化是 pricing 卡营销而非架构转向(实装形态零变化)、后台任务跨进程安全继续以持久化租约为前提(形态不变)、durable 引擎转正但默认引擎不敢换——每一项都以"中央实例 + 存储域 + 长驻进程"为前提。
2. **本框架的缺口几乎全是基础设施形或产品形,不是语义形**:M5 出账后剩下的 21 项里,租约、轮询、事件缓存、存储域、Studio、渠道仍是主体;每一条都撞在"无运行时负担"或"不接管宿主"上,说明这是轴的选择,不是没做完。第三版零行重开,台账只换事实、不动行。
3. **公开存在的差距在收窄,但护城河仍在生态侧**:0.6.0 上线(`@oribos/*` scope 首发)后,"发布 / 可检验"两项结案;余下差 = provider 目录(211 vs 实例直传)、adapter 目录(31 vs 1)、Studio / 托管面、文档站——即目录 + 生态 + 产品面,而非语义或形状。
4. **对齐有账单,且账单随上游时钟走**:凡对齐的形状都自带跟随成本——本轮 9 天窗口里 mastra 1 个 minor(1.74.0 → 1.75.0)、注册表 +1 provider / +52 models、MemoryStorage +4 方法(与 OM 无关)。纪律不变:对齐语义,不对齐维护负担;缺口按 `docs/ROADMAP.md` 的重开条件维护,不凭"mastra 有什么"跟风。
5. **刷新的正确姿势是"对账"不是"跟单"**:第三版是**首次全阴性核对**——20 能力行逐条禁跟单核对,零行满足重开条件。这说明重开条件口径(外部可观察、需求侧信号)与上游时钟解耦生效:上游活跃(含营销层大动作)不自动转化为本框架路线图输入;候选池零行是合法结论,如实记。

## 附一:第二版刷新变动账(首版 2026-09-30 → 第二版 2026-10-02)

**mastra 上游(钉点 cceb9ab / 1.72.0-alpha.4 → 2994246f / 1.75.0-alpha.0,线上 latest 1.74.0)**:

| 事实 | 首版 | 第二版 |
| --- | --- | --- |
| 版本 | `@mastra/core@1.72.0-alpha.4`(main `cceb9ab`) | 线上 latest `1.74.0`(1.72.0 于 09-30 发、1.73.0 / 1.74.0 于 10-01 发);main `1.75.0-alpha.0` |
| `agent.ts` | 10,470 行 | 10,725 行 |
| `AgentConfigBase` 顶层字段 | 38 | 39(新增 `errorProcessorDefaults`) |
| core 直接依赖 | 30 | 30(不变;devDeps 含 `@ai-sdk/provider` v4 / v5 / v6 / v7 四代) |
| provider 注册表 | 208 providers / 7,618 models | 210 / 7,738(文档生成页口径 212+ / 7738+) |
| `workflows/workflow.ts` | 202,869 字符 | 211,020 字符 |
| memory 域 in-memory / 存储面 | 1,255 行 / 约 30 方法 | 1,281 行 / 36 方法(OM 17) |
| 窗口内动向 | — | 1.72:后台任务所有权租约、渠道解析器热更新、evented agent 回到内建引擎 + 恢复、PubSub `trimTopic`;1.73 / 1.74 未发 release notes(仅 npm 版本) |

**本框架(0.0.0 / 无 tag / M4 收尾 659 例 → 0.5.0 发布态 865 例)**:

| 事实 | 首版 | 第二版 |
| --- | --- | --- |
| 发布 | version 0.0.0、无 tag、registry 无包 | 七包 `@balsats/*@0.5.0` 上线 npm + 单 tag `v0.5.0` + Release |
| 包形状 | 单核心包 10 子路径 | 七包 16 子路径(core 10 + 能力包 6) |
| 能力包 | M5 未交付 | 六包交付(otlp / mcp-server / mcp-client / sqlite / ai-sdk / croner);bunfold 裁单 |
| 核验 | `pnpm verify` 659 例 42 文件 | `pnpm verify` 865 例 68 文件;`check:dist` 16 子路径;字节预算 16/16 零超支 |
| example | 5 | 10 |
| 命名 | Balsa / `@balsa/*` | Balsats / `@balsats/*`(+ wire 面 `balsats.*` 属性族;旧 tarball 不可回改,随下一版记账) |
| 缺口台账 | 28 项(5 M5 已排 / 12 延后 / 7 出域 / 4 现实差距) | 21 项(12 延后 / 7 出域 / 2 现实差距) |

## 附一·续:第三版刷新变动账(2026-10-02 → 2026-10-11,定点重抓)

**mastra 上游(线上 latest 1.74.0 → 1.75.0(2026-10-10);main `2994246f` → `f4477eb9` 跑 `1.76.0-alpha.7`;下一 major 未发)**:

| 事实 | 第二版 | 第三版 |
| --- | --- | --- |
| provider 注册表 | 210 providers / 7,738 models | 211 / 7,790(1.75.0 内置文件实测) |
| `@mastra/memory` / 存储面 | 1.35.0 / 36 方法 | 1.36.0 / 40 方法(OM 相关 17→17 **不变**;增量 4 = run fencing #26418 + atomic WM merge) |
| OM 定位 | opt-in 库特性(17 存储方法) | **形态不变**——落地页头条化(pricing 卡三大件之一)为营销层动作;om-\* dist-tag 线为 monorepo CI 分支快照,落点仍在 `packages/memory`;om-lifecycle 的 auto-model 部分已合入 main 进 `1.37.0-alpha.2`(@mastra/memory alpha 线) |
| supervisor | `agents:` 字段 + delegation 钩子 | **形态不变**:无独立模块 / 工厂 / 新协议;`.network()` 官方迁移文档宣告弃用(源码未打 `@deprecated`);delegation 面增量仅钩子级修补 |
| durable 引擎 | evented 回内建(1.72 窗口动向) | 1.72.0 转正确认;**默认引擎未换**(`Workflow.engineType` 仍 `'default'`;schedule 自动切换收窄为 `MASTRA_WORKERS` 门控);"Run ownership"(run 级 claim + 存储 fencing)**文档先行**、1.75.0 包内无代码 |
| background tasks | 持久化 ownerId + 过期租约(1.72) | 形态不变;`untilIdle` 入口统一为 `stream({ untilIdle: true })`;无新 SSE 管理面 |
| 模型层 spec 姿态 | devDeps 4 代并存 | **未收敛**:运行时仍携 v5/v6/v7 三代别名、devDeps 4 代,HEAD 同;本框架钉的 v4 与上游 `@ai-sdk/provider@4.0.26` 同 major,暂无升代压力;`dynamic-model-router` dist-tag 证实为 2025-10 旧机制(PR #8688)源头快照 |
| 出域确认 | — | react-sdk = `@mastra/react@1.8.0` 纯客户端库(无独立 `@mastra/react-sdk`);knowledge v2 = `@mastra/core/knowledge` 进 core alpha 线(wave 2/4 在途);Studio 云化持续活跃、性质不变 |
| 重开条件核对 | — | 延后清单 20 能力行逐条禁跟单核对:**零行满足**(唯一争议行「外部记忆引擎桥接」第二臂判不满足:mastra OM 非外部引擎类、且进程内形态旧钉已知) |

**本框架(0.5.0 发布态 865 例 68 文件 → 0.6.0 发布态 + main 现状 947 例 72 文件)**:

| 事实 | 第二版 | 第三版 |
| --- | --- | --- |
| 发布 | 七包 `@balsats/*@0.5.0` 上线 npm | 七包 `@oribos/*@0.6.0` 上线(2026-10-05,[#139](https://github.com/0xnicholas/oribos-framework/issues/139);scope 首发,旧 `@balsats/*` owner 已下架) |
| 命名 | Balsats / `@balsats/*` | Oribos / `@oribos/*`(2026-10-03 更名,[#129](https://github.com/0xnicholas/oribos-framework/issues/129);wire 面 `balsa.*` → `oribos.*` 合并破型随 0.6.0 记账) |
| 内容 | M1–M5 | M1–M5 + 完善阶段 11 必须项(M-1…M-10 + P-1)全落地([#130](https://github.com/0xnicholas/oribos-framework/issues/130) 收口) |
| 核验 | `pnpm verify` 865 例 68 文件 | `pnpm verify` 947 例 72 文件(main 现状,含 [#121](https://github.com/0xnicholas/oribos-framework/issues/121) / [#123](https://github.com/0xnicholas/oribos-framework/issues/123) 两重构);`check:dist` 16 子路径;字节预算 16/16 零超支 |
| 体量(内部参考) | 组合根 `.` 50,716 B / `./workflows` 16,652 B / otlp 8,276 B / sqlite 11,971 B | 组合根 `.` 48,369 B / `./workflows` 17,415 B / otlp 8,259 B / sqlite 11,588 B |
| 缺口台账 | 21 项(12 延后 / 7 出域 / 2 现实差距) | 21 项不变(零行重开) |

## 附二:来源

mastra 侧(首版与第二版均为当时实测/抓取,按 dated records 保留):

- npm registry:`@mastra/core` 版本与发布时间线(latest `1.74.0`;`1.75.0-alpha.0`)、`@mastra/memory@1.35.0`、`@mastra/mcp@2.1.2`
- GitHub `mastra-ai/mastra` main `2994246f`(2026-10-02)与首版钉点 `cceb9ab`(2026-09-27)对照:`packages/core/package.json`(30 直接依赖;devDeps 四代 `@ai-sdk/provider`)、`packages/core/src/agent/agent.ts`(10,725 行)、`packages/core/src/agent/types.ts`(`AgentConfigBase` 39 字段)、`packages/core/src/workflows/workflow.ts`(211,020 字符)、`packages/core/src/llm/model/provider-registry.json`(210 providers / 7,738 models)、`packages/core/src/llm/model/capabilities/`(207 文件)、`packages/core/src/storage/domains/memory/{inmemory.ts,base.ts}`(1,281 行 / 36 方法)、`stores/`(31 adapter 目录)、`docs/src/content/en/models/index.mdx`(212+ providers / 7738+ models)、`docs/src/content/en/docs/harness/overview.mdx` 与各能力页(Beta 横幅计数)
- GitHub Releases:1.72.0 highlights(后台任务租约、渠道解析器、evented 恢复、PubSub `trimTopic`)、1.71.0 / 1.70.0 / 1.69.0 / 1.68.0 highlights(eager tool execution、ModelSelectionProcessor、classifier、`context.background.adopt()`、MCP v2)
- 站点:mastra.ai/docs/harness/overview(harness 能力清单)、mastra.ai/models(每小时自动刷新口径)

第三版新增(2026-10-11 定点重抓):

- 调研票与快照文档:[#141](https://github.com/0xnicholas/oribos-framework/issues/141)(OM,`docs/research/mastra-om-2026-10.md` @ `research/om-2026-10`)、[#142](https://github.com/0xnicholas/oribos-framework/issues/142)(Harness,`docs/research/mastra-harness-2026-10.md` @ `research/harness-2026-10`;源码钉 main `f4477eb9`)、[#143](https://github.com/0xnicholas/oribos-framework/issues/143)(模型层,`docs/research/mastra-model-2026-10.md` @ `research/model-2026-10`)、[#144](https://github.com/0xnicholas/oribos-framework/issues/144)(出域确认,`docs/research/mastra-outscope-2026-10.md` @ `research/outscope-2026-10`)
- npm registry:`@mastra/core@1.75.0`(2026-10-10)/ `1.76.0-alpha.7`、`@mastra/memory@1.36.0`、`@mastra/react@1.8.0`、`@ai-sdk/provider@4.0.26`
- 本仓:`docs/ROADMAP.md` 修订行(发布 0.6.0 [#139](https://github.com/0xnicholas/oribos-framework/issues/139)、完善阶段 [#130](https://github.com/0xnicholas/oribos-framework/issues/130) 收口、更名 [#129](https://github.com/0xnicholas/oribos-framework/issues/129))、[#121](https://github.com/0xnicholas/oribos-framework/issues/121) / [#123](https://github.com/0xnicholas/oribos-framework/issues/123);`pnpm verify` 947 例 72 文件(沿 [#123](https://github.com/0xnicholas/oribos-framework/issues/123) 记录)
- 决议票:[#145](https://github.com/0xnicholas/oribos-framework/issues/145)(本轮核对判定记录)

本仓库(首版与第二版为当时现状,按 dated records 保留):

- 前序调研:`docs/research/mastra-agent-model-layer.md`(#4)、`mastra-memory.md`(#5)、`mastra-workflows.md`(#2 / #3)、`mastra-harness.md`(#17)、`observability-references.md`(#7)
- 架构规范:`docs/architecture/`(model / agent / tools / workflows / memory / observability / storage / harness 八篇)
- 决策:`docs/adr/`(0001–0015)
- 路线图与状态:`docs/ROADMAP.md`(M5 实施完成段、发布 0.5.0 行、延后清单)、`CONTEXT.md`、根 `README.md`
- 实装:七包 `packages/*/package.json` 与 `byte-budget.json` / `deps-budget.json`、`scripts/`(预算与闸门)、`examples/`(10 例);`pnpm verify` / `pnpm check:dist` / `pnpm check:deps-budget` 复跑
- 相关票:[#63](https://github.com/0xnicholas/balsats-framework/issues/63)(首版)、[#101](https://github.com/0xnicholas/balsats-framework/issues/101)(第二版)、[#87](https://github.com/0xnicholas/balsats-framework/issues/87)–[#93](https://github.com/0xnicholas/balsats-framework/issues/93)(M5 实施与收尾)、[#45](https://github.com/0xnicholas/balsats-framework/issues/45) / [#97](https://github.com/0xnicholas/balsats-framework/issues/97) / [#99](https://github.com/0xnicholas/balsats-framework/issues/99)(发布、发布后验证、收口)
