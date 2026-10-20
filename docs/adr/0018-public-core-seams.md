# 核心公开缝:能力包用的稳定小表面

2026-10-20 裁决(规范 #200;首批实施 #202)。本 ADR 记录把 core 内部机制提升为公开子路径的判据、表面纪律与首批实例。它回答的是「什么可以成为公开缝、以什么形状公开」,不重新讨论被提升机制的语义——那些归各自篇章与 ADR。

## 背景

- **能力包需要复用的机制住在 core 内部。** `@oribos/checkpoints` 与 `@oribos/core/durable-agent` 各自手写一份 continuation 骨架(load 快照 → 构造 input / resume seed → 延续 traceId → 排空 chunk → materialize 终值);`@oribos/resumable-stream` 等包又各自复制输出对象的泵与收集器。同一份逻辑三处维护,新增一个终态字段或修一个泵的缺陷要追多处。
- **公开面必须显式追认。** 先前实现(#115)明确写着「公开子路径导出须另开 issue 显式追认」。核心的价值之一是表面小:任何内部模块「顺带」成为公开 API,都会把实现细节变成兼容承诺。因此提升需要判据,而不是遇事开子路径。
- **能力包不是日常用户入口。** 这些缝服务的是写包装器/适配器的作者(durable / checkpoints / resumable-stream 一类),不是 `Agent` 的普通调用者。公开它们不等于把它们塞进快速上手路径。

## 决定

1. **显式追认。** 只有经 issue 明确决策并落到本 ADR(或后续同类 ADR)的内部机制,才能获得公开子路径。不存在「目录里有什么就导出什么」的通配承诺;`@oribos/core/*` 的每个公开子路径都必须在 `package.json` 的 `exports` 表里逐条列出。
2. **按用途命名,小表面。** 子路径名描述能力(`agent-run` = 继续一次 Run),不描述实现(`internals` / `advanced`);只导出调用者真正需要的函数与类型。实现细节、结果构造器、内部 helper 不公开。
3. **机制公开,策略留消费者。** 被提升的模块只承担两端共享的机械部分。`agent-run` 不拥有存储、审批决定或 boundary composition:它从纯记录构造续跑输入,包装器提供自己的 `start`(boundary、快照钩子、额外字段都在那里)。
4. **additive-only 演化。** 公开缝遵循存储 port 的同一条纪律:已发布签名不做破坏性修改,新能力以可选字段/参数增加,breaking 只在 major。
5. **进全套闸门。** 每个新子路径同时进入 `package.json` exports、entry-points 与 export-map 测试、`check:dist`、`check:export-surface` 与 byte-budget 基线。公开面 = 文档面,任一闸门缺口都视为未交付。
6. **首批实例:`@oribos/core/agent-run`(#202)。** 公开 `continueRun(start, continuation, options) → { output, result }`、纯记录 `RunContinuation`(messages / stepCount / toolCalls / answers? / traceId?)、公开的 `createResumeLock`,以及调用所需的类型。`continueRun` 负责记录 → input / resume seed / traceId 的映射,排空输出并 `materialize`;返回的 `output` 已 settle,包装器可读取自己的额外字段。Run 终态记录构造器仍居 core 内部(ADR-0019),不进任何入口。
7. **同批规范、另票实施:`@oribos/core/output-object`。** 输出对象泵的公开面(白名单见 #200 规范)按同一判据追认,实施归 #204 / #205;它不是本 ADR 生效即自动公开的模块。

## Considered Options

- **通配导出内部模块**:被否——实现细节变兼容承诺,核心表面随目录结构漂移。
- **只给 capability 包留 internal import 路径**:被否——包一旦发布,internal 路径就是事实 API;没有稳定的版本承诺。
- **一个 `@oribos/core/advanced` 大入口**:被否——把所有缝捆成一个表面,消费者被迫整体接受;按用途命名的小入口才能让每个公开承诺独立演化。
- **把 `agent-run` 命名为 `run` 以避开 span 类型 `agent-run`**:被否——两者分属导入路径与 span type 两个命名空间,口头碰撞不构成歧义;`agent-run` 更精确。
- **公开 Run 终态构造器**:被否——能力包要的是「继续一次 Run」,不是「自造 Run 结局」;公开构造器会让挂起/完成语义出现第二个家。

## Consequences

- Durable agent 的 `resume` 改走 `continueRun`(load Snapshot → 映射 `RunContinuation` → continueRun);`Checkpoints` 的 `recover` 随 #203 迁移。两者的重放、trace 续接、memory 行为保持不变。
- `createResumeLock` 成为公开机制,但每个消费者仍自持注册表(一个子系统一份),跨子系统隔离不变。
- 能力包不再复制 continuation 骨架与恢复锁;新增终态字段或挂起语义仍只改 core 内部一处。
- 输出对象泵成为公开机制:能力包不必复制泵与收集器,懒启动 / 缓冲 / 失败排空 / abandon 语义只有一处;消费者迁移与共享契约套件归 #205。
- 公开面增长是逐条审过的:新增子路径需要 issue + ADR 判据 + 全套闸门,不会因实现方便而漂移。
- 文档须在 README / SKILL 的 import 表与对应架构篇(`harness.md` / `agent.md` / `workflows.md`)标注:`agent-run` 与 `output-object` 是能力包 / 高级集成用稳定小表面,不是日常 Agent 入口。
- **修订(第二实例落地,2026-10-20,#204)**:`@oribos/core/output-object` 按第 7 条追认——导出恰好 `OutputObject`、`OutputSource`、`OutputProjections`、`TeeHooks`、`createOutputObject`、`teeOutputObject`、`materialize`,语义与内部模块逐条一致,不新增钩子;内部模块移入 `src/output-object/index.ts`,两域 import 更新。消费者迁移与共享契约套件归 #205。

(来源:规范 #200;首批实施 #202;第二实例 #204)
