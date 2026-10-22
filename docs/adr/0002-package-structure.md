# 包结构:核心单包 + 能力包,组合根可选

pnpm monorepo。**核心单包**以子路径导出各子系统入口(如 `core/agent`、`core/workflows`),自身保持极小;携带外部依赖的能力(MCP、OTel exporter、存储 adapter、AI SDK 互操作)独立成**能力包**,用户按需安装——依赖隔离只能发生在包边界,子路径做不到。组合根(`createApp({ storage, logger, tracer })` 形态)是可选的薄注入点,负责分发横切依赖;子系统独立 `new` 始终是一等用法。刻意不做 mastra 式强制中央实例:它把一切耦合到一个注册对象上,拉低 tree-shaking 上限,与"嵌入而不接管"直接冲突。

## Considered Options

- **全单包、能力也走子路径**:被否——依赖是包级隔离,MCP/OTel 的依赖会变成核心硬依赖。
- **mastra 式每子系统一包**(core/memory/rag/evals/… 20+ 包):被否——发布与维护复杂度对小团队过重,且与子路径导出的粒度重复。
- **强制中央实例**(mastra 式 `new Mastra({...})`):被否,理由见上。

## Consequences

- **修订(M1-15 #36)**:组合根落地为 `createApp({ tracer })` + `app.agent(config)` 工厂——经工厂建出的 Agent 被动接受分发的 tracer(配置自带 tracer 时显式优先),不经工厂的独立 `new Agent(...)` 照旧一等;M1 只分发 tracer,`logger` / `storage` 的位留给后续里程碑。
- **修订(M4 #60)**:组合根补齐到 Harness 终态——`createApp({ tracer, storage })` 的 `storage` 槽 = 四个存储 port 各一(`memory` / `workflow` / `durableAgent` / `schedules`,各自缺省 = 对应内存实现、互不耦合),`App` 加 `workflow` / `durableAgent` / `signals` / `schedules` 四工厂(沿 `App.agent` 的显式优先先例);`logger` 仍无槽(规范未定)。**memory 槽取代 M2 charting「组合根不加 memory 分发槽」的结论**:分工单位从 Memory 实例改为 `MemoryStore` 槽,组合根从槽建出一个共享 `Memory` 并分发给 `app.agent` 与 `app.signals`——signals 契约要求两侧同一实例,共享实例是 `app.signals({ agent })` 开箱即用的前提;自备实例(工作记忆等)仍显式传入、不被接管。子系统不挂组合根独立使用不回归。
- **修订(M5 基建政策,2026-09-30)**:能力包(六件 + bunfold 第七件,后者已裁 #79)的目录/构建/依赖声明/版本发布口径冻结,依据 [决策:M5 能力包基建政策](https://github.com/0xnicholas/balsa-framework/issues/72) 决议评论:
  - **目录与命名**:与核心同层平铺 `packages/<短名>`(不设子层);首批 = `packages/otlp` / `packages/mcp-server` / `packages/mcp-client` / `packages/sqlite` / `packages/ai-sdk` / `packages/croner`,包名一律 `@balsa/<短名>`(沿 ADR-0013;`@balsa/croner` 为 M5 修订补入首版清单,产品形态归 M5 croner 决策票);`@balsa/bunfold` 为 bunfold go/no-go 预留,已随该桥裁定裁(#79)——不建包。npm 名 2026-09-30 实测八个(含 `@balsa/core`)全部 FREE。
  - **清单字段先例**(沿 core):`engines.node >=22.12.0` / `type: module` / `sideEffects: false` / `files: ["dist"]` / `license: Apache-2.0` / `repository`(含 `directory`) / `publishConfig.access: public` / `exports` 仅 `types`+`default`(纯 ESM,沿 ADR-0014);每包一对 `tsconfig.json`(src+test)与 `tsconfig.build.json`(src→dist),extends 根 `tsconfig.base.json`;构建 = tsc 直出 ESM,`pnpm -r build` 拓扑序(core 先)。
  - **解析面**:沿 core 先例——tsconfig `paths` 与 vitest 别名指向源码(各包自名 + `@balsa/core`),typecheck 与单测不依赖构建;`check:dist` 独家消费产物,verify 顺序保证 core 已建。
  - **对核心的依赖声明**:`peerDependencies: { "@balsa/core": "workspace:^" }`(发布物 = `^0.5.0`)+ `devDependencies: { "@balsa/core": "workspace:*" }`(仅工作区本地解析,不发布)。理由:身份语义假定单份 core(span/chunk 对象身份、组合根共享实例如 signals 两侧同一 `Memory`),peer 是唯一挡得住重复实例的声明方式;npm 7+ 自动安装 peer,随装体验与普通 dependencies 几乎无差。**能力包之间默认不建依赖边**,如真实需要按同规则显式声明并单议。
  - **版本与发布**:1.0 前能力包与核心**锁步同一发布列车**——M5 发布时全部 `@balsa/*` 为 `0.5.0`、peer 范围 `^0.5.0`;单 tag `v0.5.0` + 单 GitHub Release(notes 按包分节,沿既有 changelog 约定);发布动作 owner 手工(沿 #45):bump → tag → `pnpm -r publish --access public`(pnpm 拓扑序 core 先发、自动重写 `workspace:^` 为 `^0.5.0`);每包一个最小英文 README(npm 门面,公共面英文沿 ADR-0013)。
  - **测试与 example 落位**:能力包单测进 `pnpm verify`(`packages/*/test/**` 已被根 vitest 收集;无网络/外部服务的硬约束见 ADR-0015 修订);端到端验证落 `examples/<名>`(workspace 成员、不进 verify),每包 ≥1 个 example 归实施。脚本/测试/example 的实现产物不在本决策范围。
- **修订(M5 SQLite 参考 adapter 冻结,2026-09-30)**:清单字段的 engines 先例自 `>=22.12.0` 抬至 **`>=22.13.0`**(root `engines` 与 CI `node-version` 同步),依据 [决策:SQLite 参考 adapter](https://github.com/0xnicholas/balsa-framework/issues/76)——`node:sqlite` 免 flag 基线;其余清单字段与上条 M5 口径不变。
- **修订(随身 LICENSE 副本,2026-10-02)**:清单字段先例**补一项**——每包目录随身一份根 `LICENSE` 的 Apache-2.0 全文副本(`packages/<名>/LICENSE`),使 npm tarball(npm 的分发单元,只含包目录内文件)自带许可证文本(字段面 `license: "Apache-2.0"` 照旧,包页按字段渲染);七包副本与根 `LICENSE` 内容实测全等。依据 [实施:发布前置公开面](https://github.com/0xnicholas/balsa-framework/issues/100) 决议评论。
- **修订(完善 M-4 #135,2026-10-05)**:组合根 `logger` 槽落位——`createApp({ logger })` 的 `Logger` = 四级方法结构类型(`debug` / `info` / `warn` / `error`,`console` 与 pino 直吃),居 observability 入口、core 根复出口收编;分发沿 tracer 的显式优先先例,但**缝只开在 workflow 子系统**(`WorkflowConfig.logger` 注入缝 + committed `Workflow.logger` 暴露,沿 `Workflow.tracer` 先例)——agent / signals 不开缝:agent 规范钦定缝集 = tracer / processors(「Nothing beyond them」),开缝归各篇规范自己的决策,无消费面不往 config 焊死字段。内核自身无 log 埋点:通道是 observability 规范为 logs 钦定的唯一路径(OTel logs 维持砍单),子系统 log 点归后续里程碑。依据 [实施:M-4 组合根 logger 槽](https://github.com/0xnicholas/oribos-framework/issues/135) 决议评论。

- **修订(叶子包依赖边,#193,2026-10-14)**:「能力包之间默认不建依赖边」立首个例外——**叶子包**:运行时 `@oribos/*` 依赖仅 peer core、无状态纯件的包,用户永不直接安装;能力包可以 `dependencies`(`workspace:^`,发布物锁步 `^0.x`)依赖叶子包,不得走 peer。依据 = [设计:OTel bridge 映射复用的依赖边形状](https://github.com/0xnicholas/oribos-framework/issues/193):OTel bridge(CUT-OBS2)须复用 `@oribos/otlp` 的 semconv 映射,而整包依赖顶撞「不装不付」(exporter 闭包 ≈19.3 MB),故映射纯件(`mapping` / `messages` / `values`)抽叶为 `@oribos/semconv`(唯一外部依赖 `@opentelemetry/api`),otlp 与 bridge 各持一条 `dependencies` 边。`check-deps-budget.mjs` 的 workspace 禁边硬错误按本判词放行(读目标包 manifest 验谓词);「复用」按字面约束裁(单一真相源),复制 + 一致性测试方案被否。
- **修订(叶子判词放宽,2026-10-20,ADR-0020)**:叶子包谓词由「运行时 `@oribos/*` 依赖仅 peer core」放宽为「零 `@oribos/*` 运行时依赖,或仅 peer core」;「无状态纯件」措辞改为「无模块级状态、无 core 身份语义的共享件」;`private: true` 的包不得作叶子。首个新实例 = `@oribos/lease`(Lease 机制共享包,ADR-0020;实施 #206)。
- **修订(Lease 抽取实施完成,2026-10-22,#213)**:ADR-0020 已落地(2026-10-20 `0fe63d7`)——`@oribos/lease` 公共叶子包入列;`@oribos/distributed-signals` / `@oribos/background-tasks` 以 `dependencies` 依赖并保留冻结公共名。实施状态见 ADR-0020「实施状态」;上条 2026-10-20 修订的叶子判词不变。

(来源:wayfinder ticket #8)
