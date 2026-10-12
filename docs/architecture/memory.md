# Memory 语义

> 来源:wayfinder ticket #12(决策:Memory 语义)。本文件是 Memory 子系统的架构规范。
> 决策记录见 `docs/adr/0007-memory-semantics.md`;术语见 `CONTEXT.md`。

## 定位

Memory 是框架的记忆子系统:**语义层薄自研**——thread/resource 身份 + 消息历史 + 可选工作记忆,存储走 port、默认内存实现、核心零依赖。重机制不进核心:语义召回(向量 RAG)留 seam——经 ADR-0017 重判(2026-10-11,#161)**转追赶项**(CUT-MEM1 行);OM 类后台压缩经重判(#160)**转追赶项**(进程内 opt-in 包,CUT-MEM2 行);外部记忆引擎桥接经重判(#161)**维持分叉**——**bunfold**(TencentDB-Agent-Memory fork,MIT)曾为头号桥接候选,M5 裁定:**裁**(不产桥接包;重判结论与对账见下「外部记忆引擎」节)。供给策略与模型层同构(核心零依赖契约 + 生态直通 + 能力包);依据是候选开源记忆系统(mem0/Zep/Letta/bunfold)全是 server 形态或 hosted API,而语义层薄到没有更轻的可采用对象(调研 #5;#12 决议评论中的 bunfold 探查)。

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

- 裁单(对照 mastra 10 必备 + 3 可选):`updateMessages`(消息不可变)、`listMessagesById`(语义召回已转追赶项,#161,见 CUT-MEM1 行;2026-10-12 改记)、`updateThread`(并入 upsert)、`cloneThread` / `copyThread`(延后)、`listMessagesByResourceId`(OM 已转追赶项,#160,见 CUT-MEM2 行互注;2026-10-12 改记)。
- `deleteThread` **只在 port 层**(级联删消息、不动 resource 级数据);`Memory` 实例表面不暴露删除入口——需要清 thread 的宿主直用 port(见本文件「砍单与承载缝」C2 行)。
- 核心自带内存 Map 默认实现——不接 storage 即纯内存,无运行时负担。adapter 家族见 `docs/architecture/storage.md`(#15 已定),本清单是其输入。

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
| **CUT-MEM1** semantic recall(向量 RAG) | 落库 hook = `Memory.save → MemoryStore.saveMessages`;embedder 复用模型契约模式 | **转追赶项**(2026-10-11,#161) | 证据 = mastra semantic recall 实装未弃(1.0 起默认关——默认关 ≠ 已弃)+ 17+ 向量适配器;knowledge v2 仅在 core alpha 线(`1.76.0-alpha.7`,稳定版未发)**不算证据**,记观察项;范围收窄 = 落库 hook 索引 + recall 语义增强,向量库依赖随能力包(过保轴门);验证面 = save→索引 / recall 增强单测 + example;**中层**(既有缝上的新能力包,#161)。消息不可变 + 单入口 recall 钉子不动(ADR-0007);延后清单「RAG / 语义召回」行 |
| **CUT-MEM2** OM 类后台压缩管线 | 进程内 opt-in 能力包(Observer/Reflector 式),消费 memory 落库 hook——核心新缝,须过演化门(能力包优先);存储走 additive 可选方法 + 能力标志(ADR-0010);summarize-and-truncate = Processor 范式仍成立 | **转追赶项**(2026-10-11,#160) | 轴级判词(ADR-0017 修订记):opt-in、不配置即零成本、不接管宿主的进程内后台工作 ≠ 运行时负担;证据 = mastra OM = Observer/Reflector 进程内 opt-in 库形态(§4.3,快照 2026-10-11),实装存在且未弃;验证面 = fake model 单测 + example;**与现有缝距离最远**(新缝 + 存储扩展),不进首批(#160)。与延后清单「外部记忆引擎桥接」行互注:共享本缝,独立判定——bunfold 类外部常驻服务桥维持分叉(#161) |
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
