# MemoryStore 包装留在能力包:编译期守住 port 表面、wrapper 可返回基础窗口超集

2026-10-20 裁决(架构 review 候选 04;实施 #207;关联 #182 / #189 / #196 / ADR-0010 / ADR-0020)。本 ADR 记录 MemoryStore 包装的归属、`MemoryStore` 表面的演化守卫,以及 `listMessages` 在 wrapper 处的契约口径。

## 背景

- `@oribos/rag`(`packages/rag/src/index.ts` 的 `createSemanticMemoryStore`)与 `@oribos/observational-memory`(`packages/observational-memory/src/index.ts` 的 `createObservationalMemoryStore`)各自包装一个 `MemoryStore`。两者共享同一段转发骨架:6 个必备方法的完整表面(3 个直通、3 个策略覆写)、`before` / 空窗口 guard、`deleteThread` 内层先删的级联、`supportsWorkingMemory` 条件对透传;`compareMessagesAsc` 与 `assertPositiveInteger` 也是逐字 twin(后者在 core `packages/core/src/memory/memory.ts:294` 还有第三份)。
- 但两者不是逐字复制:`listMessages` 都做了策略增强——RAG 并回窗口外语义相关的旧消息(结果可超过 `limit`),OM 注入一条派生 system 消息(结果 +1);`saveMessages`、构造校验、错误文本也不同。`docs/architecture/memory.md` 的「语义召回」/「观察记忆」节已记录两者都是「包装任一 `MemoryStore`、核心零改动」,OM 的演化门裁决是「核缝不触发」。
- **唯一真正的潜在正确性问题是能力标志。** 两个 wrapper 都返回固定对象字面量,不展开内层 store。`MemoryStore` 的演化纪律是 additive-only(ADR-0010):新能力只以可选方法增加。将来新增一个可选方法时,两个 wrapper 都会在运行时静默丢掉它;因为方法是 optional,TypeScript 不会报错。port 的演化纪律被自己的包装器击败。
- 架构 review 提议在 `@oribos/core/memory` 开一个装饰缝。该提议会重开「核心零新缝」的既有裁决,并把一个局部问题变成 core 公共表面。ADR-0020 已把叶子判词放宽到「无模块级状态的共享件」,所以如果将来确实需要共享运行时件,公共叶子包是结构上正确的家,不是 core。
- `listMessages` 的现有契约只写了 base 语义:`limit` 锚最新端、`order` 只翻转呈现、`before` 是游标(`packages/core/src/memory/types.ts` 的 `ListMessagesQuery`;`docs/architecture/storage.md`「查询的 SQL 形状(总序与游标)」节)。两个 wrapper 实际返回超集,这条 wrapper 口径没有写进 port 契约。

## 决定

1. **不建 core 装饰缝,不建共享运行时件。** rag/OM 继续各自持有 wrapper;转发骨架与 helper twin 的重复保留。轻量轴下,这段局部重复不值得一个新的公共包或 core 表面。
2. **每个 wrapper 加编译期穷尽断言。** wrapper 构造处维护「已转发 + 已覆写」的键集合,并断言 `Exclude<keyof MemoryStore, HandledKeys>` 为 `never`。`MemoryStore` 新增可选方法时,两个 wrapper 的 `tsc` 同时失败,作者必须显式选择转发或覆写;静默丢弃变成编译错误。
3. **`listMessages` 契约分两层。** base adapter:`limit` 仍是精确上界,锚最新端;`order` 只翻转呈现;`before` 是严格更旧游标。wrapper:结果必须包含内层 store 对同一查询返回的**基础窗口**,且基础窗口成员之间的相对顺序不变;允许声明式增量(RAG 的语义召回、OM 的观察注入)按策略并入、前置或后置;`before` 仍精确透传、不产生副作用。wrapper 不得删除基础窗口中的消息。
4. **验证面 = 编译期断言 + 每个 wrapper 的聚焦断言。** 聚焦断言钉住:基础窗口按相对顺序保留、`supportsWorkingMemory` 条件对透传、`before` 精确透传。共享 contract suite 暂不建;触发条件 = 出现第三个 wrapper/adapter,或 `MemoryStore` 在本 ADR 后第一次新增可选方法。届时提升到 `@oribos/testing`(private、source-only),并同时评估其包身份从「规范假模型」扩为「共享测试替身与契约套件」。
5. **未来若确实需要共享运行时件,走公共叶子包。** 按 ADR-0020 放宽后的判词:公共包、零 `@oribos/*` 运行时边或仅 peer core、无模块级状态、无 core 身份语义;不进 core,也不走 capability→capability 边。`@oribos/memory-decorator` 是候选名,但本 ADR 不创建它。
6. **术语。** 这类件叫「存储包装 (Store wrapper)」,不叫 decorator:它有意改变 `listMessages` 的结果集合,不是透明转发。`CONTEXT.md` 增加词条。

## Considered Options

- **core 装饰缝(review 提案)**:否决。重开 `docs/architecture/memory.md` 的「核心零改动 / 核缝不触发」;把局部问题变成 core 公共承诺;export-surface 与 byte-budget 都要吸收。
- **现在建 `@oribos/lease` 式叶子包**:暂缓。ADR-0020 的放宽判词使其结构可行,但 04 的两个消费者只共享转发骨架,策略差异大;一个公共包 + 未知方法语义 + 锁步发布清单,成本高于收益。第三个消费者出现时重开。
- **本地运行时泛化转发(spread / Proxy)**:否决。展开内层 store 会暴露非 port 字段,对 class-based store 的原型方法不可靠;Proxy 改变对象身份与枚举语义,且仍要处理未知方法。
- **不做守卫**:否决。additive-only 的 port 会被自己的 wrapper 静默击败,正是本候选要修的缺陷。
- **现在就建共享 contract suite**:暂缓。编译期守卫解决真正的缺陷;现有 per-package 测试已钉住策略;suite 是测试面扩张,等触发条件。若现在建,`@oribos/testing` 需要 `vitest` devDependency 并扩包身份。

## Consequences

- 转发骨架与两个 helper twin 保留;这是轻量轴下的有意接受项,不是遗漏。
- `MemoryStore` 未来新增可选方法时,rag/OM 的构建失败,直到两个 wrapper 各自决定转发或覆写;不会再静默丢能力。
- `listMessages` 的 wrapper 口径需要在实施时写进 `packages/core/src/memory/types.ts`、`docs/architecture/storage.md`、`docs/architecture/memory.md`;本 ADR 只记裁决。
- 不新增包、不新增依赖边、不改 core 导出面。实施时唯一的呈现层修正见下方修订。
- `CONTEXT.md` 增加「存储包装」词条;顺手修正「v1 两个存储 port」的陈旧计数(实际四个)。
- 复核条件:第三个 wrapper/adapter 出现,或 `MemoryStore` 新增第一个可选方法,或两个 wrapper 的策略开始收敛到可共享的运行时骨架。

## 修订

- **修订(实施 #207,2026-10-20)**:「不改运行时行为」按 port 默认真值补记。`ListMessagesQuery.order` 的缺省是 `'desc'`;两个包装原先把缺省当作升序呈现——RAG 的合并结果按升序返回(基础窗口相对顺序与内层默认相反),OM 的派生块前置。实施时一并修正为遵循 port 默认:缺省 / `'desc'` 下 RAG 合并结果降序、OM 派生块在数组尾(`'asc'` 时在数组首)。这是一次呈现层修正,不改变消息集合、策略、公开类型或 `Memory.recall` 的行为(后者恒传 `order`);其余契约与决定不变。

(来源:架构 review 2026-10-20 候选 04;规范 #214;实施 #207)
