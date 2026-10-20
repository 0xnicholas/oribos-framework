# Memory 语义

> 来源:wayfinder ticket #12(决策:Memory 语义)。本文件是 Memory 子系统的架构规范。
> 决策记录见 `docs/adr/0007-memory-semantics.md`;术语见 `CONTEXT.md`。

## 定位

Memory 是框架的记忆子系统:**语义层薄自研**——thread/resource 身份 + 消息历史 + 可选工作记忆,存储走 port、默认内存实现、核心零依赖。重机制不进核心:语义召回(向量 RAG)留 seam——经 ADR-0017 重判(2026-10-11,#161)**转追赶项**(CUT-MEM1 行)→ **已兑现** = `@oribos/rag` 能力包(2026-10-13,#182,见下「语义召回」节);OM 类后台压缩经重判(#160)**转追赶项**(进程内 opt-in 包,CUT-MEM2 行)→ **已兑现** = `@oribos/observational-memory` 能力包(2026-10-15,#196,见下「观察记忆」节);外部记忆引擎桥接经重判(#161)**维持分叉**——**bunfold**(TencentDB-Agent-Memory fork,MIT)曾为头号桥接候选,M5 裁定:**裁**(不产桥接包;重判结论与对账见下「外部记忆引擎」节)。供给策略与模型层同构(核心零依赖契约 + 生态直通 + 能力包);依据是候选开源记忆系统(mem0/Zep/Letta/bunfold)全是 server 形态或 hosted API,而语义层薄到没有更轻的可采用对象(调研 #5;#12 决议评论中的 bunfold 探查)。

## 身份模型:thread / resource 双标识

- 每条消息、每个 thread 都同时带 `threadId` 与 `resourceId`;thread 有 owner(resourceId)。
- **memory 子系统不做访问控制**:查询前应用层必须自行校验当前用户有权访问该 resourceId(与 mastra 一致,文档写明)。
- 不提供所有权迁移 API(mastra 的 `updateThreadResourceId` 带补偿回滚逻辑,砍掉);需要时应用层删旧建新。
- per-call 传递 = 显式执行选项,两者必填,缺一则调用期显式报错:

```ts
agent.generate(input, { memory: { thread: 'id' | { id, title?, metadata? }, resource: 'id' } })
```

thread 不存在时自动创建(可带 `title` / `metadata`)。

## 消息历史(唯一默认开启的机制)

- **窗口**:`lastMessages` 默认 10,只按条数截断,不做 token 窗口。
- **消息格式**:即模型契约的 vendor prompt 类型 + 存储信封 `{ id, threadId, resourceId, createdAt }`;内部流转与存储同一格式(「决策:Agent 核心抽象」已钉)。无 mastra 的 `signal` role。消息不可变。
- **信封与写入幂等**(超规范项,补进规范):`save` 的输入可带显式 `id` / `createdAt`——缺省部分由 Memory 补(`id` 用 `crypto.randomUUID()`、`createdAt` 用实例序列戳),信封的 `threadId` / `resourceId` 由本次调用盖章;带显式 `id` 即**幂等 upsert**(同 id 重写覆盖,port 两侧同语义)。`id` 同时是游标:`before` 取某 id 即只取比它更早的条目。
- **单一查询入口**:`memory.recall({ threadId, limit?, before?, order? })`,返回可直接喂模型的消息;Memory 实例方法全公开(chat UI 可直接调用)。
- **时机**(细化「决策:Agent 核心抽象」的钉法):recall 每 run 一次——run 开始、`processInput` 之前;agent loop 内消息列表在内存累积;save 每个 step 后增量落库(首轮含用户输入消息)。
- **顺序语义**:`processOutputStep` 先于 save——processor 的脱敏/过滤在落库前生效。

## 工作记忆(可选,resource 作用域)

- 一块跨会话的小块结构化数据(用户画像/偏好/当前目标),归属 resource——**单 scope,不做 thread/resource 开关**(调研原话:两个都做是双倍语义表面;thread 级暂存有消息历史兜底)。
- **schema-only**:schema 走 Standard Schema 契约(ADR-0003);merge 语义——深合并、`null` 删字段、数组整换。mastra 的 markdown template 形态砍掉(全量替换 = 每次全量 token、易写坏)。
- **更新只走 tool-call**:启用 WM 时框架自动给 agent 挂 `updateWorkingMemory` 工具;校验失败按既有「工具错误回喂」语义返回模型。
- **编程写入口**(超规范项,补进规范):`Memory.updateWorkingMemory({ resource, patch })` 是上述工具背后的**同一条语义路径**(merge → 校验,不合 schema 即抛且不写),宿主可直接调用;对应读入口 = `Memory.getWorkingMemory(resource)`。resource 记录是 upsert(`metadata` / `createdAt` 保持);读-改-写非原子,同 resource 并发更新 last-write-wins。
- **注入**:独立 system message,追加在 instructions 之后,不改写 instructions 本体。
- read-only 模式裁出 v1(后加 minor)。

## 存储 port:MemoryStore

```ts
interface MemoryStore {
  // 必备 6
  getThreadById(id: string): Promise<StoredThread | null>
  saveThread(thread: StoredThread): Promise<void>          // upsert,兼 create/update
  deleteThread(id: string): Promise<void>                  // 级联删消息,不动 resource 级数据
  listThreads(q: { resourceId: string; limit?: number; before?: string }): Promise<StoredThread[]>
  listMessages(q: { threadId: string; limit?: number; before?: string; order?: 'asc' | 'desc' }): Promise<StoredMessage[]>
  saveMessages(messages: StoredMessage[]): Promise<void>   // 批量
  // 条件 2(仅启用 working memory 时要求;能力标志降级)
  getResource?(id: string): Promise<StoredResource | null>
  saveResource?(resource: StoredResource): Promise<void>   // upsert
}

// StoredThread   = { id, resourceId, title?, metadata?, createdAt, updatedAt }
// StoredMessage  = vendor prompt 消息 + { id, threadId, resourceId, createdAt }
// StoredResource = { id, workingMemory?, metadata?, createdAt, updatedAt }
```

- 裁单(对照 mastra 10 必备 + 3 可选):`updateMessages`(消息不可变)、`listMessagesById`(语义召回已转追赶项,#161,见 CUT-MEM1 行;2026-10-12 改记)、`updateThread`(并入 upsert)、`cloneThread` / `copyThread`(延后)、`listMessagesByResourceId`(OM 已转追赶项、#189 冻结走 thread scope 不要求该法,见 CUT-MEM2 行互注;2026-10-12 改记)。
- `deleteThread` **只在 port 层**(级联删消息、不动 resource 级数据);`Memory` 实例表面不暴露删除入口——需要清 thread 的宿主直用 port(见本文件「砍单与承载缝」C2 行)。
- 核心自带内存 Map 默认实现——不接 storage 即纯内存,无运行时负担。adapter 家族见 `docs/architecture/storage.md`(#15 已定),本清单是其输入。
- **`listMessages` 契约分两层**(ADR-0021):**base adapter** 的 `limit` 是精确上界(至多 `limit` 条,锚最新端),`order` 只翻转呈现,`before` 是严格更旧游标;**存储包装**(保持 `MemoryStore` 接口、只叠加策略的能力包组合形态)可返回内层 store 对同一查询返回的**基础窗口**的超集(RAG 并回语义相关旧消息、OM 注入一条派生 system 消息),但不得删除基础窗口成员,也不得改变其相对顺序——每条基础窗口消息恰好出现一次;包装的 `before` 精确透传、零策略副作用,`order` 不改变基础窗口的成员集合。包装表面另有编译期守卫:port 新增可选方法时,RAG / OM 的 `tsc` 同时失败并点名未处理的键,静默丢失变成编译错误。

### 语义召回(RAG 能力包,已兑现)

`@oribos/rag`(2026-10-13,#182,CUT-MEM1 行)落在存储缝上、核心零改动:`createSemanticMemoryStore({ storage?, embedder, index?, topK? })` 包装任一 `MemoryStore`(缺省 = 核心内存实现)交给 `new Memory({ storage })`。**落库 hook 索引**——`Memory.save → saveMessages` 缝上,每条持久化消息的正文(system/user/assistant 的 text 部分)经用户自带的 embedder 写入向量索引(先落库后索引,embedder 失败显式拒绝 save,索引不持有 store 拒绝的消息);**recall 语义增强**——无 `before` 游标的窗口读(`recall` 的底层缝)把窗口内最后一条 user 消息嵌为查询,把窗口外语义相关(正相似)的旧消息按时间正序并回结果,`topK` 缺省 3;分页(`before`)原样透传、不花 embedding。结果是内层基础窗口的超集:基础窗口成员恰好保留一次、相对顺序不变,合并只增不删(ADR-0021)。钉子不动:消息不可变(索引是派生缓存,整条 `StoredMessage` 随索引走,`listMessagesById` 留裁)、`recall` 单入口(增强的是同一调用返回什么)、`deleteThread` 级联清索引。embedder 复用模型契约模式(vendor EmbeddingModel `v4` 结构子集,零适配);向量索引是包自有 port——内存 cosine 默认实现零依赖,外部向量库作为 `VectorIndex` 适配由调用方携带(依赖随包不随核心)。工作记忆条件对经包装透传。验证面 = save→索引 / recall 增强单测 + `examples/semantic-recall`(进 `check:examples` 闸门)。

### 观察记忆(OM 类压缩能力包,已兑现)

`@oribos/observational-memory`(2026-10-14,#189,CUT-MEM2 行)落在存储缝上、核心零改动:`createObservationalMemoryStore({ storage?, observer, reflector?, thresholds?, observations? })` 包装任一 `MemoryStore`(缺省 = 核心内存实现)交给 `new Memory({ storage })`,与 `@oribos/rag` 同缝可叠加(推荐次序:RAG 内层、OM 外层——OM 读侧最后渲染)。**触发 = 无游标窗口读内联**(recall 底层缝,与 RAG 增强同一条件):读窗口后现算线后积压(窗口之前的未观察消息),体量估算过观察阈即在**当次请求内**跑一次 Observer(当次只观察最老一段 ≈ 阈值体量,游标式逐段推进),观察累计过反思阈跑 Reflector 合并——全部工作发生在框架可见点、请求内完成:无响应后写、无 `settled()` 式 drain、0 定时器 0 常驻管线,写侧直通不消费。**注入 = 一条 system 消息前置**(非空时):反思块 → 观察块 → 窗口原样;注入只增不删——基础窗口成员恰好保留一次、相对顺序不变(ADR-0021);窗口不做过滤/驱逐(要 N 条给 N 条),「移出上下文」由窗口天然完成——触发条件保证观察段在稳态下恒在窗口之外(窗口调大的边角 = 块与原文并存,文档写明,不静默改写窗口契约)。**游标分页(`before`)原样透传** = 原始回读路径,不挂检索工具。**观察记录 = 包自有 `ObservationStore` port**(内存默认零依赖、持久实现归部署方;重启丢失 = 下次 recall 自动补课,成本复付、非正确性损失);记录 = `{ id, threadId, resourceId, createdAt, kind: 'observation' | 'reflection', sourceIds, text }`,排序即时间序(priority 字段裁出)。阈值面 = `{ 观察阈, 反思阈 }`(已定标:默认 1000 / 2000,估算 token;体量估算 = 可选注入 `countTokens`,缺省 字符/4 启发式);模型必填无默认(模型契约 vendor 子集,零适配;模型错误 / 空输出显式拒绝该次读)。**演化门裁决 = 核缝不触发**(ADR-0012 能力包优先;存储不进 core `MemoryStore`)。**保轴判据(七条,逐条过)**:① 未 opt-in 即零存在(核与既有路径零改动)② 包装即零潜伏(未过阈无定时器 / 句柄 / 监听 / 连接)③ 请求内闭环(无响应后写、无 `settled()`、不 hook 进程退出)④ 成本显式(模型必填、阈值在场)⑤ 消息不可变(观察/反思 = 附加派生记录)⑥ `recall` 单入口(分页零副作用)⑦ 核心零新缝(包自有 port、依赖随包)。已知限制(文档写明):读路径 port 签名无 abort 信号,压缩调用不随 run 取消;同 thread 并发读进程内 in-flight 去重、跨进程 best-effort(重复观察仅成本复付)。**已落地**(2026-10-15,#196):记录 `createdAt` 走实例单调序列戳(同一 pass 产生的观察/反思同毫秒写序可读回);`deleteThread` 级联清记录。与 RAG 的复合口径已定标:积压边界取下层增强结果的最新 `limit` 条(下层并回的旧消息仍算积压、可被观察),派生块锚在返回数组的时间序首位;注入格式 = 一条 system 消息(表头 + `[reflection]` / `[observation]` 分块)。验证面 = fake model 单测(22 例)+ `examples/observational-memory`(进 `check:examples` 闸门);实施票 [#196](https://github.com/0xnicholas/oribos-framework/issues/196)。

### 外部记忆引擎(M5 裁定:不产桥接包;重判维持分叉)

bunfold 类外部记忆引擎不落在 `MemoryStore` 缝上——服务形态(常驻进程)+ 写入即后台异步蒸馏 + L0 原文可删 + 消息面仅 user/assistant 纯文本 / 身份强 team+agent+user 三元组,与本节钉子(无后台写、消息不可变可回读、库语义)正面冲突;忠实 port adapter 不存在。ADR-0017 重判(2026-10-11,#161)**维持分叉、理由改写**:新纪律下证据不成立——mastra 无外部记忆引擎桥实装(其方向 = 进程内 OM,已由 #160 判转追赶项,CUT-MEM2 行互注、两行独立判定互不预设);轴冲突依旧(外部常驻服务 + 后台 LLM 管线 + 数据落盘三道硬冲突;bunfold 调研证实服务器优先、不可嵌入——27 直接依赖 + 原生件,同 #79 结论)。判定与理由单一真相源见 ROADMAP 延后清单「外部记忆引擎桥接」行;本 port 首个真实后端 = SQLite 参考 adapter(`storage.md`)。需要外部引擎的宿主走上游零代码路径(MemoryProxy 改 base URL)或宿主侧组装,不经本框架包。

## 配置表面

```ts
new Memory({
  storage?: MemoryStore,                     // 默认内存实现
  lastMessages?: number,                     // 默认 10
  workingMemory?: { schema: StandardSchema } // 可选;启用才要求 resource 方法
})
```

- Agent 侧 `memory?: DynamicArgument<Memory>`(全域动态,ADR-0005);同一 Memory 实例可被多 agent 共享。
- **无后台写、无 `settled()`**:所有写发生在请求内;存储连接生命周期归 adapter(见 `docs/architecture/storage.md`)。

## 砍单与承载缝

判定口径见 `docs/ROADMAP.md`「下一阶段(完善)」;`C*` 行 = 对比总账 §3「形状内语义差异」(`docs/research/mastra-gap-analysis.md`),`CUT-MEM*` 行 = 审计 §2 砍单行集(`docs/research/completeness-audit.md`)。判定三值:有意分叉 / 已兑现(非差异) / 提升(→ 必须项表 ID)。2026-10-11 起按 ADR-0017 逐行重判,判定值增**转追赶项**与**维持分叉但理由改写**两值(程序、口径与已裁行见 `docs/ROADMAP.md`「追赶面」段)。

| 项 | 承载缝 | 判定 | 理由·ADR 指针 |
| --- | --- | --- | --- |
| **C1** / **CUT-MEM6** markdown template WM | 结构由 Standard Schema 表达(schema-only + merge) | 有意分叉 | 全量替换 = 每次全量 token、易写坏;schema-only + merge 是工作记忆钉子(`CONTEXT.md` 工作记忆)(ADR-0007 / 0003) |
| **C2** / **CUT-MEM4** 无单条消息 update / delete | **store 层** `deleteThread` 级联为兜底;`Memory` 表面不暴露(port 必备方法之一) | 有意分叉 | 消息不可变 + 可回读是钉子;`Memory` 表面只留 recall / save 入口(ADR-0007);互注:#161 CUT-MEM1 转项同缝——recall 增强 = 落库 hook 索引,不触消息不可变钉 |
| **C3** / **CUT-MEM3** 无 thread cloning | 用户态读 A 写 B 重组(port 6 必备够用);后加 minor 留扩展 | 有意分叉 | `cloneThread` / `copyThread` 裁单;审计判无等价物,故承载缝写为「用户态重组」而非「后加 minor」一项(ADR-0007) |
| **C4** / **CUT-MEM9** 不做访问控制 | 应用层端点鉴权 / 中间件 | 有意分叉 | 授权归应用层——resource 是稳定标识不是授权主体(ADR-0007) |
| **CUT-MEM1** semantic recall(向量 RAG) | 落库 hook = `Memory.save → MemoryStore.saveMessages`;embedder 复用模型契约模式 | 转追赶项(2026-10-11,#161)→ **已兑现**(2026-10-13,#182:`@oribos/rag` 落地——store 包装零新缝,save 落库 hook 索引 + recall 窗口语义增强,向量索引 port 内存默认零依赖、外部库随包;核心零改动;验证面 = save→索引 / recall 增强单测 + `examples/semantic-recall` 进闸门,见上「语义召回」节) | 证据 = mastra semantic recall 实装未弃(1.0 起默认关——默认关 ≠ 已弃)+ 17+ 向量适配器;knowledge v2 仅在 core alpha 线(`1.76.0-alpha.7`,稳定版未发)**不算证据**,记观察项;范围收窄 = 落库 hook 索引 + recall 语义增强,向量库依赖随能力包(过保轴门);验证面 = save→索引 / recall 增强单测 + example;**中层**(既有缝上的新能力包,#161)。消息不可变 + 单入口 recall 钉子不动(ADR-0007);延后清单「RAG / 语义召回」行 |
| **CUT-MEM2** OM 类后台压缩管线 | store 包装(读侧:无游标窗口读内联触发 + 观察块前置;写侧直通),核心零新缝;观察记录 = 包自有 `ObservationStore` port(内存默认、持久归部署方)——**表面冻结**(2026-10-14,#189):`@oribos/observational-memory`,机制与保轴判据七条见下「观察记忆」节;summarize-and-truncate = Processor 范式仍成立 | **转追赶项**(2026-10-11,#160)→ **表面冻结**(2026-10-14,#189:核缝取消、存储收包内;graduate 实施票 [#196](https://github.com/0xnicholas/oribos-framework/issues/196) 并接线)→ **已兑现**(2026-10-15,#196:`@oribos/observational-memory` 落地——store 包装同缝、包自有 `ObservationStore` 内存默认、请求内联闭环;验证面 = fake model 单测 + example 进闸门) | 轴级判词(ADR-0017 修订记):opt-in、不配置即零成本、不接管宿主的进程内后台工作 ≠ 运行时负担;证据 = mastra OM = Observer/Reflector 进程内 opt-in 库形态(§4.3,快照 2026-10-11),实装存在且未弃;验证面 = fake model 单测 + example;**距离复核**(2026-10-14,#189):原判「与现有缝距离最远(新缝 + 存储扩展)」收敛——与 RAG 同缝(store 包装)+ 包自有存储 port,核缝取消;「不进首批」的排序为既成事实保留(#160,远层)。与延后清单「外部记忆引擎桥接」行互注:共享本缝,独立判定——bunfold 类外部常驻服务桥维持分叉(#161) |
| **CUT-MEM5** thread title 生成 | 调用方写 `title` | 有意分叉 | 应用层职责;`title` 只是 metadata 字段(ADR-0007) |
| **CUT-MEM7** read-only WM | 不挂 WM 更新工具(读仍经 recall) | 有意分叉 | 后加 minor(ADR-0007) |
| **CUT-MEM8** token 窗口 | `lastMessages` 条数截断 | 有意分叉 | 条数截断是 v1 选择(`memory.ts` 明写 history is truncated by count only);**重开条件 = 真实用例要求按 token 预算裁剪历史**(ADR-0007) |
| **CUT-MEM10** 所有权迁移 | 删旧建新;错配由一致性检查显式拒绝 | 有意分叉 | 迁移是产品语义,不是存储原语(ADR-0007) |

## 与其它子系统的关系

- **Agent(#10,已定)**:`memory` 一等可选字段;recall/save 时机与 Processor 顺序见上。
- **模型层(#9,已定)**:消息格式 = vendor prompt 类型;届时 embedder 复用同一契约模式(vendor EmbeddingModel 结构类型)。
- **Tools(#13,已定)**:WM 更新工具是框架自挂的 Tool,定义规范见 `docs/architecture/tools.md`。
- **存储(#15,已定)**:MemoryStore port(6 必备 + 2 条件)是其输入,与 `WorkflowSnapshotStore` 统一 adapter 家族;扩展面与 adapter 清单见 `docs/architecture/storage.md`。
- **Observability(#14,已定)**:recall / save 各成一个 span 锚点(`memory-recall` / `memory-save`),类型常量、挂点与字段形状见 `docs/architecture/observability.md`。
- **Harness(#18)**:无耦合——无后台写意味着 memory 不需要 `settled()` 式生命周期。
- **多 agent(#19)**:memory 身份经 per-call 显式传递;as-tool 组合时 thread/resource 由调用方决定,委派场景的隔离语义归它。

## 依赖预算

核心(含 Memory)运行时依赖硬线 = 0(数字按 ADR-0001 作内部 CI 回归参考)。存储 adapter 与外部记忆系统桥接归能力包。
