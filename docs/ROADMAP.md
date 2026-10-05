# 实施路线图

极致轻量 TypeScript/Node agent 框架的粗粒度实施路线图:**只讲顺序、依赖与可验证产出,不含排期**。规范本体见 `docs/architecture/`(入口:`docs/architecture/README.md`),术语见 `CONTEXT.md`,决策依据见 `docs/adr/`。本图由 [决策:粗粒度实施路线图](https://github.com/0xnicholas/oribos-framework/issues/16) 产出。

## 切分原则

- **垂直切片(walking skeleton)**:每个里程碑都是一条可跑的细流,可独立验证、可提前叫停;不按子系统水平分层。
- **Instrumentation-first**:观测内核(span 模型 / tracer / NoOpSpan)与各边界自动埋点随各子系统落地时就建进去;exporter 与 OTLP 能力包后置,永不对已完成子系统开膛回补。
- **可验证产出两件套**:每个里程碑 = 可运行 example(`examples/`)+ 覆盖该范围的测试套件。
- **守轻量从第一天**:CI 字节预算在 M1 上线(零依赖 + preset 分层 + CI 字节预算三件套,见 [调研:轻量化基准与 MCP 现状](https://github.com/0xnicholas/oribos-framework/issues/6))。
- **串行默认**:小团队单线推进;各里程碑「依赖」行标注可并行项,不排双轨。

## 里程碑

### M1 骨架闭环

核心包首次可跑:一个 agent 带工具完成 generate/stream 闭环。

- 模型契约(vendor 自 AI SDK provider spec 子集 + `specificationVersion` 硬断言)+ chunk 协议
- 工具:`createTool` 四字段普通对象、Record 容器、三线 error 回喂
- Agent 核心:五字段最小表面、动态参数 / RequestContext、输出对象双消费、内建 loop(maxSteps 默认 5、工具错误回喂)、Processor 三钩、structuredOutput strict
- 观测内核:span 模型(框架类型常量,开放 string)、tracer(started/updated/ended 三事件 + exporter 最小面)、console/memory 两个内置 exporter、NoOpSpan
- 可选组合根:薄组装点,子系统不挂也能独立完整使用

**验证**:`examples/minimal-agent` 可跑;测试套件;**CI 字节预算上线**。
**依赖**:—(首个里程碑)。

### M2 记忆

- MemoryStore port(6 必备 + 2 条件)+ 内存默认实现
- 消息历史(唯一默认机制:thread/resource 双标识、lastMessages=10 + recall)
- working memory(resource scope、schema-only、tool-call 更新)
- agent 的 memory 集成(per-call `memory: { thread, resource }`,不存在自动创建)

**验证**:多 thread 多轮会话 example + recall 演示。
**依赖**:M1。

### M3 编排

- workflow builder(then / parallel / branch / foreach / dowhile / dountil / sleep)+ commit + createRun(type-state)
- 语义内核:扁平条目列表 + for 循环 walker;Standard Schema 校验永远开
- suspend/resume:suspend 信号 + step 边界 JSON 快照;WorkflowSnapshotStore port(2 方法,JSON-only)+ 内存实现

**验证**:含 suspend/resume 的 workflow example。
**依赖**:M1(与 M2 可并行)。

### M4 持久执行与后台(Harness 三件套)

- `createDurableAgent`:工具调用边界审批闸;loop 快照走 AgentRunSnapshotStore port;finishReason 增 `'suspended'`;resume 携带审批结论恢复
- signals:内存 pubsub + loop step 边界注入缝;注入落消息历史;单进程语义
- schedules:ScheduleStore port + 记录 CRUD + tick 原语;cron 解析注入,触发执行交平台 cron

**验证**:审批闸 example(挂起 → 审批 → resume)+ signal 注入 example。
**依赖**:M1 + M2(signals 注入落消息历史)。

### M5 生态能力包

核心包之外的第一方能力包,各包独立、可并行推进:

- **OTLP exporter 包**:GenAI semconv 映射,HTTP only(依赖 M1 观测内核)
- **MCP server 包 / MCP client 包**:同一份 Tool 双向流通,桥接 schema 直通零适配(依赖 M1 工具)
- **SQLite 参考 adapter**:实现全部四个存储 port;驱动已冻 = `node:sqlite`(免 flag 基线 ≥22.13,见下「设计冻结」;port 策略见 [决策:存储适配策略](https://github.com/0xnicholas/oribos-framework/issues/15))(依赖 M2–M4 的 ports)
- **AI SDK 互操作包**:chunk 协议 ↔ AI SDK 流格式等外部格式转换(依赖 M1)
- **croner 封装包**:cron 表达式 → `next` 注入片段的便利件(表达式仍归宿主侧定义,不入记录;依赖 M4 schedules 的 `NextFn`;M4 地图移交件)
- **bunfold 桥接包(按需可裁)**:外部记忆系统桥接参考实现,价值在验证 memory seam 设计(依赖 M2)——**M5 裁定:裁**(不产桥接包;重开条件见延后清单「外部记忆引擎桥接」)

**验证**:OTLP → 本地 collector example;MCP server/client 对打 example;SQLite 跨进程挂起恢复 example。
**依赖**:各包分别挂 M1–M4 对应接缝,包间可并行。

**设计冻结(M5 收尾,2026-09-30)**:[wayfinder 地图:M5 生态能力包](https://github.com/0xnicholas/oribos-framework/issues/65) 收线——七件全部落成决策(六包 + bunfold 裁单),各件定义表面冻结在 `docs/architecture/` 的增补节,实施按 spec 直落、不再需要裁决。**实施已收口(2026-10-01,见下「实施完成」)**;发布动作(0.5,owner 手工)口径不变(见下「发布节奏与 v1.0 门槛」与 [#45](https://github.com/0xnicholas/oribos-framework/issues/45))。

| 件 | 冻结规范(节) | 决策 | 事实底座 |
| --- | --- | --- | --- |
| OTLP exporter `@oribos/otlp` | `docs/architecture/observability.md`「OTLP 能力包(M5 设计冻结)」 | [#73](https://github.com/0xnicholas/oribos-framework/issues/73) | `docs/research/otlp-js-packages.md` |
| MCP server `@oribos/mcp-server` | `docs/architecture/tools.md`「MCP server 能力包」 | [#74](https://github.com/0xnicholas/oribos-framework/issues/74) | `docs/research/mcp-v2-sdk-surface.md` |
| MCP client `@oribos/mcp-client` | `docs/architecture/tools.md`「MCP client 能力包」 | [#75](https://github.com/0xnicholas/oribos-framework/issues/75) | 同上 |
| SQLite adapter `@oribos/sqlite` | `docs/architecture/storage.md`「SQLite 参考 adapter(M5 设计冻结)」 | [#76](https://github.com/0xnicholas/oribos-framework/issues/76) | `docs/research/sqlite-driver-landscape.md` |
| AI SDK 互操作 `@oribos/ai-sdk` | `docs/architecture/model.md`「AI SDK 互操作能力包(M5 设计冻结)」 | [#77](https://github.com/0xnicholas/oribos-framework/issues/77) | `docs/research/ai-sdk-ui-stream-protocol.md` |
| croner 封装 `@oribos/croner` | `docs/architecture/harness.md`「croner 封装能力包」 | [#78](https://github.com/0xnicholas/oribos-framework/issues/78) | `docs/research/croner.md` |
| bunfold 桥(**已裁**,不建包) | `docs/architecture/memory.md`「外部记忆引擎(M5 裁定:不产桥接包)」 | [#79](https://github.com/0xnicholas/oribos-framework/issues/79) | `docs/research/bunfold.md` |
| 横切基建政策(目录 / 依赖红线 / 发布口径) | `docs/architecture/README.md` 能力包口径 + ADR-0002 / ADR-0015 的 M5 修订记 | [#72](https://github.com/0xnicholas/oribos-framework/issues/72) | — |

**实施完成(M5 收尾,2026-10-01)**:六包全部落码并核验(实施票 [#87](https://github.com/0xnicholas/oribos-framework/issues/87)–[#92](https://github.com/0xnicholas/oribos-framework/issues/92) 全关,bunfold 沿裁单不产包)——`@oribos/mcp-server` / `@oribos/mcp-client` / `@oribos/sqlite` / `@oribos/ai-sdk` / `@oribos/otlp` / `@oribos/croner`,各含单测 + 双预算基线(ai-sdk 空集基线;sqlite 零运行时依赖,沿脚本语义免 deps 基线,同 core)+ 最小英文 README;五 example 全跑通(`examples/mcp-tools` 双 transport / `sqlite-resume` 跨进程 / `ai-chat-route` / `otlp-collector` / `cron-schedule`,负例 exit 1);导出面核对:core 的 export-map / entry-points 测试在位(按设计只覆盖 core 导出表),产物面由 `check:dist` 逐包验真(七包 **16 子路径**全过);`check:runtime-deps` 白名单闸门全绿;`deps-budget` 六包逐包核对(五份基线 + sqlite 免基线)**全部在数、零黄灯**;字节预算 **16/16 零超支**;`pnpm verify` 全绿(**856 例 67 文件**)。发布交接口径见下「发布节奏与 v1.0 门槛」M5 收尾修订。依据 [实施:M5 收尾——verify 全绿核对 + 导出/预算总表 + ROADMAP/README 修订 + 发布交接口径](https://github.com/0xnicholas/oribos-framework/issues/93) 决议评论。

## 下一阶段(完善)

**目标形态 = 子系统完整判据**(不绑版本号):把八个子系统(模型 / Agent / 工具 / 工作流 / 记忆 / 观测 / 存储 / Harness)各自的「什么算完整」定死——规范承诺兑现 + 已记录砍单项清账 + 有意分叉写明 + 质量面达标——再以它为准判掉三份盘点:**有意分叉**写明理由并落各篇规范的「砍单与承载缝」表,**欠账**提升为下「必须项」表(自定触发 = 完整判据本身,验证面 = 兑现的第二半)。判定口径:二元结论(有意分叉 / 欠账)+ 两道门(写不出分叉理由的按欠账;写不出验证面的欠账不得提升)+ 禁跟单(mastra 有 / 以后有用 / 不贵)。术语见 `CONTEXT.md`(完整判据 / 自定触发 / 有意分叉·欠账 / 形状内语义差异 / 验证面)。

**依据与产出**:本段由规划型地图 [Wayfinder 地图:完善现有功能](https://github.com/0xnicholas/oribos-framework/issues/102) 产出——判据票 [#104](https://github.com/0xnicholas/oribos-framework/issues/104)(八份完整判据 + 二元判定口径)、[决策:§3 形状内语义差异逐条判定](https://github.com/0xnicholas/oribos-framework/issues/105)、[决策:砍单表逐条判定](https://github.com/0xnicholas/oribos-framework/issues/106)、[决策:质量与债务处置](https://github.com/0xnicholas/oribos-framework/issues/107);事实底座 = `docs/research/completeness-audit.md`(审计报告:八篇规范 456 条承诺三方对账 + 60 行砍单复核 + §3 语义 33 条 + 质量/债务盘点)与 `docs/research/mastra-gap-analysis.md`(对比总账)。**实施地图 = [Wayfinder 地图:完善阶段实施](https://github.com/0xnicholas/oribos-framework/issues/130)**(批 2–4 八票,2026-10-04 开图)——本节只出必须项、顺序与验证面;每项的票据级大纲见 [任务:计划成文](https://github.com/0xnicholas/oribos-framework/issues/108) 决议评论。

### 必须项(11 行)

`判据要求` 列即**自定触发**:为什么按完整判据就必须做;`验证面` 列 = 具体承担机制(测试 / example / 闸门 / 类型系统 / 缺席证明 / 编译期约束)。两项缺一不得提升。

| 提升项 | 判据要求(自定触发) | 验证面 | 落点 |
| --- | --- | --- | --- |
| **M-1** 并发与取消语义断言 | Agent · 面4(质量达标)——真并发与取消是唯一「生产必踩而框架未声明语义」的执行边界;不可断言 = 不可守卫 | 4 条用例:模型流中 abort · 同一 agent 并发 run · 同 thread 并发写(core + sqlite)· signals 并发投递 | `packages/core/test/`(agent-stream / agent-loop / memory / signals)· `packages/sqlite/test/memory.test.ts` |
| **M-2** 行为性未验断言补齐 | 模型 `M-52` / Agent `AG-40` / 工作流 `P-11` · 面1(承诺兑现)——已实装但缺验证面,按判据不构成兑现 | 五条用例:`finishReason` 逐值映射 · 钩子抛错即 run 失败 · `store.save` 抛错两路(随 run 失败 / failed 终态 best-effort)· route 取消直通(`M-51`)· 臂不一致被下游校验拦截(`DOC-4`) | `packages/core/test/*` · `packages/ai-sdk/test/*` |
| **M-3** MCP 两包断言补齐 | 工具 · 面1——两包冻结面承诺**无断言**(已是发布出的公开面) | `MS-3` authInfo 透传 · `MS-4` SDK 默认值承接 · `MS-5` · `MS-11` 构造时快照语义 · `MS-12` object 根 + draft-2020-12 目标 · `MC-4` · `MC-9` 多页翻页聚合 · `MC-10/11` `CONNECTION_CLOSED` · `MC-15` 运行时 `vendor`/`version`/`types` | `packages/mcp-server/test/*` · `packages/mcp-client/test/*` |
| **M-4** 组合根 logger 槽 | 观测 · 面1——`docs/architecture/observability.md` 承诺「组合根已有的 logger 通道」,`CONTEXT.md` 组合根词条已含 logger,实装缺席 | `AppConfig` 落 logger 槽 + 传给子系统(一条 app 测试断言行)+ 规范对齐 | `packages/core/src/app.ts` + core 根导出 |
| **M-5** 离线 example 冒烟闸门 | 工程质量 · 面4——examples 是多数提升项的验证面;不在闸门内 = 验证面不可执行 | CI 一步跑离线例:`cron-schedule` · `otlp-collector` · `mcp-tools`(HTTP + stdio);带 mock 的三个**后置**(mock 脚本先入仓) | `.github/workflows/ci.yml` · `examples/` |
| **M-6** `check-dist` 单测 | 工程质量 · 面4——五个 check 脚本中唯一无单测者(闸门自身可信度) | `check-dist` 单测(与 `check-byte-budget.test.ts` 同形) | `scripts/` |
| **M-7** 发布路径加固 | 工程质量 · 面4——`REL-2`(发布无任何自动前置,0.5.0 已实证抓到过时元数据)+ `REL-1`(线上元数据不可原地改) | 七包 `prepublishOnly`(跑 verify)+ 发布后核对单(`description` / `repository.url` / dist-tags / exports) | 七包 `package.json` · 本节发布交接口径 |
| **M-8** 文档真相源对齐 | 跨篇 · 面4——文档与实装**相反**是最贵的一类错(读者照做即错) | 三处修订:`DOC-6`(码名 → `InvalidResult`)· `DOC-10` · `DOC-11` + 修订核对表(`DOC-1` / `DOC-2` 已由 [#124](https://github.com/0xnicholas/oribos-framework/issues/124) 垫付,e261be6) | `docs/architecture/tools.md` · `README.md` |
| **M-9** 规范措辞校准与已知代价明写 | 跨篇 · 面4——规范说反 / 说满会持续误导(措辞级,不涉实装) | 六处:`AG-15`·`H-11` 限定「不传 seam 时」· `ST-63`「组合根**不**代管」· `M-52` 恒写 `{usage}` · `DOC-3` JSON-only 归 port 契约 · `DOC-4` 调用方保证 + 下游校验拦截 · agent / workflows **无界缓冲 · 无背压**各一句(消费者侧责任) | `docs/architecture/{agent,harness,storage,model,workflows}.md` |
| **M-10** 超规范项补规范 | 跨篇 · 面1——实装已超规范且更优,规范落后即真相源分裂 | 五处:`DOC-5` 桥接运行时 `types` 字面 · `DOC-7` `storage.init()` 同步形态 · `DOC-8` Signals 签名(`tracer?`)+ `stream`/`generate` · `DOC-9` `schedules.save` 的 Invalid Date 校验 · `DOC-12` 两行中文源码注释英文化 | `docs/architecture/{tools,storage,harness}.md` · `packages/core/src/memory/in-memory-store.ts` |
| **P-1** §3 语义钉子:三条行为断言 | Agent · 面1 + 工作流 · 面1 + Harness · 面1——SEM-A2 非并发 / SEM-B16 条件内 `suspend()` 报错 / SEM-D7 `tick` 无 span 三条语义已实装但无验证面,按判据不构成兑现 | 三条断言:第二个工具在第一个 settle 前不启动 · 条件内 `suspend()` 抛 `suspendOutsideStep` · `tick` 不创建 span | `packages/core/test/agent-loop.test.ts` / `workflows-suspend-resume.test.ts` / `schedules.test.ts` |

### 顺序与依赖

四项批次,批间无硬依赖(可并行开工);批序表达的是「谁的验证面先可信」:

- **批 1 · 闸门先行**:M-5(离线 example 冒烟)· M-6(`check-dist` 单测)· M-7(发布路径加固)——闸门自身先自证,后续各票的验证面才可执行;M-7 另收口「发布前必做」清单。
- **批 2 · 断言补齐(可并行)**:M-1 · M-2 · M-3 · P-1——纯测试增量、互不依赖;同文件面(M-2 与 P-1 都落 `packages/core/test/`)串行同一写者,免写冲突。
- **批 3 · 唯一公开面增量**:M-4(组合根 logger 槽)——additive 配置字段,与批 2 可并行;落地时同步观测篇措辞。
- **批 4 · 文档真相源(发布前收口)**:M-8 · M-9 · M-10——不阻塞批 1–3,但**任何发布动作前必须收口**(M-8 的 `DOC-1`/`DOC-2` 是代码注释,走 patch;其余为文档)。

### 有意分叉的落点

- **八篇规范的「砍单与承载缝」表已归一**为目标表形 `项 | 承载缝 | 判定 | 理由·ADR 指针`(model 篇另留「重开条件」列),共 95 行;判定侧落定:§3 形状内语义差异 33 条 + 审计 §2 砍单行集 60 行 + 延后清单能力项 20 行——**有意分叉 110 行 / 已兑现(非差异)3 段 / 净提升 0 行**。
- **单一真相源**:分叉理由与承载缝只在规范表(本节不复制理由);「重开条件」只在延后清单(规范表只写承接指针)。
- **提升项与分叉的边界**:唯一从 §3 走出的提升是 `P-1`(三条已实装但无验证面的语义,按判据不构成兑现);§2 与延后清单**零提升**。

### 与延后清单的关系

延后清单 20 个能力项(延后档 13 + 出域档 7)逐条判定为**有意分叉**:全部**原地留**,重开条件一律不变——「重开条件」的单一真相源仍是延后清单(新增「承接」列只为指到规范表行,判定与理由见各篇规范表)。因此本阶段**不从延后清单移出任何行**;必须项表 11 行全部来自承诺面(§1)、语义面(§3)与质量面(§4)。

### 版本口径

- **标注 0.6**(序列 0.5.0 → 0.6,0.4 已跳空):提升项内容量 = 断言补齐 + 两个闸门 + 一个 additive 配置槽 + 文档对齐——**无破型、无新子系统**。
- **与 1.0 门槛的关系**:倾向「与 1.0 门槛合并评估」——**本阶段不定义 1.0**(1.0 门槛自 M5 口径修订起搁置,见下「发布节奏与 v1.0 门槛」);若 0.6 收线后提升项自然构成门槛,另起 effort 正式定义。
- **随 0.6 记账的既有破型**:品牌改名把 OTel 属性族 `balsa.*` → `oribos.*`、`service.name` 默认 `oribos`、console 前缀与 mcp-client vendor 同步——**线上 0.5.0 tarball 实测仍是 `balsa.*` / `balsa`**(`balsats` 一次换名只落在仓库、未随发布上线),故下一次发布承载的是**合并后的一次破型**,对 0.5.0 消费者是观测 wire 面破型(pre-1.0 窗口内落,ADR-0009 已注记)——与本节提升项无关,但同一发布承载。

## 发布节奏与 v1.0 门槛

- **M1 末发 0.1**:walking skeleton 尽早公开,最早验证子路径导出与字节预算的打包链路;**以定名为门**——首次发布前必须完成 [决策:项目命名与品牌](https://github.com/0xnicholas/oribos-framework/issues/20)。
- 之后每个里程碑一个 0.x;0.x 阶段允许跨里程碑破型。
- **M5 完成 = v1.0**;存储 port 的 additive-only 演化纪律自 1.0 起生效(ADR-0010)。
- **修订(M2 收尾,2026-09-29)**:M1 末未执行发布(定名门已过,版本仍 0.0.0);首个公开版本拍板为 **0.1.0**——含 M1+M2 全部内容、不跳号;changelog = GitHub Release notes(tag + Release,仓库不新增 `CHANGELOG.md`);凭证 = owner 手动发布(前置:创建 npm org `@balsa`,registry 查实仍 FREE);此后 M3→0.2、M4→0.3、M5→1.0。依据 [实施:M2 收尾——字节预算、导出核对、verify 全绿](https://github.com/0xnicholas/balsats-framework/issues/44) 决议评论。
- **修订(M3 收尾,2026-09-29)**:M3 编排交付并核验——`./workflows` 13,958 B(字节预算 7/7 内)、导出三面一致(export-map / entry-points 测试 + `check:dist` 7 子路径)、`pnpm verify` 全绿(569 例 38 文件)、`examples/workflow-approval` 以本地 OpenAI-compatible mock 端到端跑通;0.2 = M1+M2+M3 全部内容,流程沿 0.1 结论(tag + GitHub Release notes、不新增 `CHANGELOG.md`、owner 手动发布);收尾复核:**0.1.0 与 0.2 均未发布**(version 仍 0.0.0、无 tag、registry 404 FREE)——发布动作(含 0.1.0 / 0.2 的先后)归 owner 手工前置。依据 [实施:examples/workflow-approval + M3 收尾](https://github.com/0xnicholas/balsats-framework/issues/53) 决议评论。
- **修订(M3 收线,2026-09-30)**:[#54](https://github.com/0xnicholas/balsats-framework/issues/54)(块内 suspend——迭代现场快照 + 块内 resume)后 M3 全表面终态:`./workflows` 16,817 B(预算 7/7,基线随 #54 更新,+2,859 B)、`pnpm verify` 全绿(579 例 38 文件)、`examples/workflow-approval` 本地 mock 复跑通过(挂起/回放/记录自断言);M3 wayfinder 地图 [#46](https://github.com/0xnicholas/balsats-framework/issues/46) 关账(七张实施票 #47–#54 全关)。发布结论沿上条不变。
- **修订(M4 收尾,2026-09-30)**:Harness 三件套(durable 审批闸 / signals / schedules)交付并核验——三个新子路径 `./signals` 5,509 B、`./durable-agent` 4,573 B、`./schedules` 3,037 B(字节预算 10/10,全部零超支;组合根 `.` 50,708 B,gzip 15,749 B)、导出三面一致(export-map / entry-points 测试 + `check:dist` 10 子路径)、`pnpm verify` 全绿(**659 例 42 文件**;零运行时依赖 58 模块 0 处外部导入)、两个新 example 以本地 OpenAI-compatible mock 端到端跑通——`examples/durable-approval`(挂起 → 快照 → 批准/拒绝两路 resume,拒绝不终止 run)与 `examples/signals-desk`(空闲唤醒 / 活跃注入 / 排队保序 / 类型化 sendSignal / subscribeToThread / schedules tick),负例均 exit 1。0.3 = M1–M4 全部内容,流程沿 0.1 结论(tag + GitHub Release notes、不新增 `CHANGELOG.md`、owner 手动发布);收尾复核:**0.1.0 / 0.2 / 0.3 均未发布**(version 仍 0.0.0、无 tag、registry 404 FREE)——发布动作(含先后)归 owner 手工前置。依据 [实施:examples + M4 收尾——双 example + 字节预算三层 + 导出核对 + verify 全绿 + ROADMAP 修订](https://github.com/0xnicholas/balsats-framework/issues/61) 决议评论。
- **修订(M5 版本口径,2026-09-30)**:原「**M5 完成 = v1.0**」更正为「**M5 完成 = 0.5**」——生态能力包以 0.5 交付(序列 0.1.0 → 0.2 → 0.3 → 0.5,0.4 跳空);**1.0 不再绑定 M5**,门槛先搁置(不排期);存储 port additive-only 与各公开面 major 约束不变,仍自 **1.0 起生效**(ADR-0009 / ADR-0010)。依据 [决策:M5 版本口径——M5 收尾发 0.5,1.0 不再绑定 M5](https://github.com/0xnicholas/balsats-framework/issues/64)。
- **修订(M5 收尾,2026-10-01)**:生态能力包六包交付并核验——交付清单、逐包预算数字与负例记录见上「M5 生态能力包」实施完成段(`pnpm verify` 全绿 **856 例 67 文件**;字节预算 16/16 零超支;导出面 `check:dist` 16 子路径全过;`deps-budget` 六包核对零黄灯;五 example 全跑通含负例 exit 1)。**0.5 = M1–M5 全部内容**;发布交接:owner 前置 = 创建 npm org `@balsa` + registry 复核(仍 FREE)→ bump 全 `@balsa/*` = **0.5.0** → 单 tag `v0.5.0` → `pnpm -r publish`(口径沿 [#45](https://github.com/0xnicholas/balsats-framework/issues/45) / ADR-0002 M5;流程沿 0.1 结论:tag + GitHub Release notes、不新增 `CHANGELOG.md`、owner 手动发布);收尾复核:**0.1.0 / 0.2 / 0.3 / 0.5 均未发布**(version 仍 0.0.0、无 tag、registry 404 FREE)——发布动作(含先后)归 owner 手工前置。差距参照 `docs/research/mastra-gap-analysis.md` 的刷新触发「M5 收尾」**已满足**,刷新另立 effort(沿 [#63](https://github.com/0xnicholas/balsats-framework/issues/63) 口径,该文首注已记)。依据 [实施:M5 收尾——verify 全绿核对 + 导出/预算总表 + ROADMAP/README 修订 + 发布交接口径](https://github.com/0xnicholas/balsats-framework/issues/93) 决议评论。
- **修订(身份裁决,2026-10-02)**:对外**标识根 = `balsats`**(品牌名 balsa 与仓库名 `balsa-framework` 均不变)——域名 **`balsats.com`**(仅一枚,owner 下单)、npm scope **`@balsats`**(七包首发;`@balsa` 放弃:外部实体持有、无公开获得路径)、GitHub org `balsats`(**现在裁、迁移后置**,发布后另起 effort)、X 面 `@balsats` 被个人占用(接受,不作为条件);数字口径**结案 = 不对外写数字**(机制可讲;见上「现实差距」公开可检验性行)。**发布前置修订**:创建 npm org `@balsats`(替代上条 `@balsa`)→ 全 `@balsats/*` bump = **0.5.0** → 单 tag `v0.5.0` → `pnpm -r publish`(流程沿 0.1 结论:tag + GitHub Release notes、不新增 `CHANGELOG.md`、owner 手动发布);**0.1.0 / 0.2 / 0.3 单独发布作废——0.5.0 单发**(M1–M5 全部内容、七包)。改名清扫(`@balsa/*` → `@balsats/*`:包名 / 引用面 / 示例 / 文档 / 脚本)与文档站前置三票([#81](https://github.com/0xnicholas/balsats-framework/issues/81)–[#83](https://github.com/0xnicholas/balsats-framework/issues/83))在发布前落;身份参数全表见 ADR-0013 修订记。依据 [Wayfinder 地图:可发布化](https://github.com/0xnicholas/balsats-framework/issues/94) 裁决记录票 [#95](https://github.com/0xnicholas/balsats-framework/issues/95)。
- **修订(改名清扫,2026-10-02)**:全树**活面** `@balsa/*` → `@balsats/*` 落地——七包 name 与相互依赖(peer `/` dev)、十 example(名 / 依赖 / 脚本与命令)、源码与测试 import、包内 tsconfig `paths` 与 vitest 别名、脚本常量(`lib.mjs` / `check-runtime-deps` / `check-deps-budget`)、活文档(README / `CONTEXT.md` / `AGENTS.md` / `docs/architecture/**` / 本文件当前状态表述)、`pnpm-lock.yaml` 重生成;**历史记录面按 dated records 保留**(ADR 正文与既有修订记、本文件既有修订行、`docs/research/` 快照),`git grep '@balsa/'` 只剩保留面。核验:`pnpm verify` 全绿(**856 例 67 文件**,与清扫前基线同数)、`check:dist` 16 子路径全过、`check:runtime-deps` 七包全绿、`deps-budget` 零黄灯;字节预算 **16/16 零超支**——**基线随清扫更新**(core `.` / `./model` / `./agent` 各 +8 B、otlp +8 B、sqlite +6 B、mcp-client +2 B:错误消息与导出注释内 scope 串变长的机械增量,非代码增量);example 以终态包名复跑:`cron-schedule` / `otlp-collector` / `mcp-tools`(HTTP + stdio)exit 0。依据 [实施:改名清扫——@balsa/* → @balsats/*(包名 / 引用面 / 示例 / 文档 / 脚本)+ verify 全绿](https://github.com/0xnicholas/balsats-framework/issues/96)。
- **修订(品牌改名,2026-10-02)**:对外品牌名 `Balsa` → **`Balsats`**、仓库/项目名 `balsa-framework` → **`balsats-framework`**(GitHub 原地改名,旧地址 / git 协议经 301;本地目录同名)——**ADR-0013 同日修订记「品牌名 balsa 不变」「仓库名 `balsa-framework` 不变」两条作废**,标识根与品牌名自此同一。活面:根 `package.json` name、七包 description / `repository.url`、`README` / `CONTEXT.md` / `AGENTS.md`、`docs/architecture/**`、十 example(脚本 / README / env / 临时目录)与包 README prose;**文字面之外的 wire 面一并换名**:OTel 属性族 `balsa.*` → `balsats.*`(`span.type` / `run_id` / `thread_id` / `resource_id` / `request.*` / `input` / `output` / `metadata` / `error.details`)、`service.name` 默认 `balsats`、mcp-client 桥接 `~standard.vendor` → `balsats`、console exporter 前缀 `[balsats]`、示例 env `BALSA_*` → `BALSATS_*` 与探针 / 临时目录名。**代价记账**:(1) **0.5.0 已上线**——线上 tarball 内 README 与 `repository.url` **不可回改**,旧链接 / 旧仓库地址经 GitHub 301 仍有效;(2) `balsats.*` 属性键与 `service.name` 默认值是**对 0.5.0 消费者的 wire 面破型**(pre-1.0 窗口内落,随下一版记账;ADR-0009 已注记);(3) **GitHub org 归属与侧翼仓名不在本次改动面内**——org `balsats` 迁移沿 ADR-0013「迁移后置」口径不变,`balsa-docs` / `balsa-website` 改名归各自仓库动线;(4) **GitHub 仓库改名与本地目录改名由 owner 在侧翼动线收口后执行**——本行先落文档与代码面(改名前置条件,不是遗留项)。**保留面**:ADR 正文与既有修订记、本文件既有修订行、`docs/research/` 快照 prose;活面文档内链接已统一改写为新仓库名(dated records 内链接按 ADR 惯例保留旧地址)。核验:`pnpm verify` 全绿(**865 例 68 文件**,与清扫前基线同数)、`check:dist` 16 子路径全过、`check:runtime-deps` 七包全绿、`deps-budget` 零黄灯;字节预算 **16/16 零超支**——**基线随改名更新**(core `./observability` +2 B、mcp-client `.` +2 B、otlp `.` +26 B:品牌串变长的机械增量;mcp-server `.` **−70 B 为 #83 遗留的既有漂移**,本次一并吸收,非改名所致);example 以终态品牌复跑:`otlp-collector`(断言 `balsats.*` 属性族)与 `mcp-tools`(HTTP + stdio)exit 0。依据:本次 session 裁决(**未立票**)。
- **修订(发布 0.5.0,2026-10-02)**:七包 **0.5.0 已在 npm 上线**——未认证七端点全 200(= 真 public,`publishConfig.access` 覆盖 scope 默认 `private`);`latest=0.5.0`、`engines >=22.13.0`、peer 已改写 `^0.5.0`;线上 tarball 与本地 pack 逐包同文件集(`dist/` + README + LICENSE 齐,非空包);单 tag `v0.5.0` → `f86984d` + [GitHub Release](https://github.com/0xnicholas/balsats-framework/releases/tag/v0.5.0)(notes 覆盖七包 + M1–M5);通路 = `pnpm -r publish --no-git-checks`(owner 手工,账号 2FA;pnpm 10 `--publish-branch` 默认 `master` 而仓库在 `main`;重跑安全)。**发布后验证([#97](https://github.com/0xnicholas/balsats-framework/issues/97))**:干净目录安装冒烟(七包 + core 根 + 9 子路径 **10/10** import + 运行时冒烟)与六能力包实装冒烟全绿;此前各条收尾复核的「0.1.0 / 0.2 / 0.3 / 0.5 均未发布」由本行结案。**口径收口([#99](https://github.com/0xnicholas/balsats-framework/issues/99))**:本文件「现实差距」的「发布 0.5.0」「公开上手面」两行结案、README Status / Install / 能力包段翻转为已发布、Release notes 品牌与链接随改名修正(**发布事实不动**);**已发布 tarball 的 `repository.url` / description 元数据(七包仍指旧名、写 "Balsa …")不可原地修改**,只能随下次发布修正(不属本图收口活面)。**归属收口**:GitHub 仓库改名与本地目录改名已执行(仓库现为 `0xnicholas/balsats-framework`,见上「品牌改名」行),侧翼两仓亦已改名(`balsats-docs` / `balsats-website`,归各自动线);**org `balsats` 迁移仍后置**(发布后另起 effort,沿身份裁决行)。依据 [实施:发布 0.5.0](https://github.com/0xnicholas/balsats-framework/issues/45) / [发布后验证](https://github.com/0xnicholas/balsats-framework/issues/97) / [收尾](https://github.com/0xnicholas/balsats-framework/issues/99)。
- **修订(下一阶段成文,2026-10-02)**:新增上「下一阶段(完善)」段(规划型地图 [#102](https://github.com/0xnicholas/balsats-framework/issues/102) 产出)——八份子系统完整判据定死「什么算完整」,以它为准判掉三份盘点(§3 语义 33 条 + §2 砍单 60 行 + §1/§4 131 行):**必须项 11 行**(M-1…M-10 + P-1,逐项带自定触发与验证面)、**有意分叉 110 行**落八篇规范的「砍单与承载缝」表、延后清单 20 能力项全部原地留(重开条件不变)。**版本口径标注 0.6**(倾向:与 1.0 门槛合并评估;1.0 门槛仍未定义)。依据 [任务:计划成文——ROADMAP 增补段「下一阶段(完善)」+ 实施票大纲](https://github.com/0xnicholas/balsats-framework/issues/108)。
- **修订(M-7 发布路径加固,2026-10-03)**:七包 manifest 各加 `prepublishOnly` = `pnpm -w verify`(在 workspace 根跑一次完整闸门)——发布动作现由「七包 `prepublishOnly` 跑 `verify`」前置,且前置发生在打包**之前**(`cwd` = 该包目录)⇒ 线上 tarball 内的 `dist` 必为当次构建产物、闸门未过则该包不打包也不发布;根 workspace 与十 example 是 private(无发布通路),不加。**代价记账(接受)**:`pnpm -r publish` 对每包各跑一次 ⇒ 每次发布约 +7 × `verify` 墙钟(基线 26.7s / 865 例;本机演练实测 `pnpm -r publish --dry-run --no-git-checks` 全程 **3m03s**、七包各跑一次 `verify`)≈ 3 分钟——发布是低频 owner 手工动作,不为消除它引入哨兵文件 / 缓存戳一类隐藏状态。**已知缺口(进核对单,不修)**:`pnpm pack` 不触发 `prepublishOnly`,「pack 出来的即新鲜产物」不成立;发布通路本身的证明走 `publish --dry-run` 演练。tag / Release / `CHANGELOG` / 发布 workflow / 版本 bump 流程零改动。依据 [实施:M-7 发布路径加固——七包 prepublishOnly + 发布后核对单](https://github.com/0xnicholas/balsats-framework/issues/112)。

- **修订(更名 oribos,2026-10-03)**:对外品牌名 `Balsats` → **`Oribos`**、仓库/项目名 `balsats-framework` → **`oribos-framework`**、npm scope `@balsats/*` → **`@oribos/*`**——三仓 umbrella 同步更名,本行落 framework 仓。**活面**:根 `package.json` name、七包 name / description / `repository.url`、十 example 包名与依赖、源码与测试 import(含七包子路径)、`tsconfig.base.json` `paths`、`vitest.config.ts` 别名、`pnpm-lock.yaml` 重生成、脚本常量(`lib.mjs` / `check-runtime-deps` / `check-deps-budget` / `check-examples` / `check-export-surface`)、`README` / `CONTEXT.md` / `AGENTS.md` / `docs/architecture/**`(8 文件)与包 README prose;**wire 面一并换名**:OTel 属性族 `balsats.*` → **`oribos.*`**(`span.type` / `run_id` / `thread_id` / `resource_id` / `request.*` / `input` / `output` / `metadata` / `error.details`)、resource 默认 `service.name` `balsats` → `oribos`、mcp-client 桥接 `~standard.vendor` `balsats` → `oribos`、console exporter 前缀 `[oribos]`、sqlite 默认库名 `oribos.db`、示例 env `BALSATS_*` → `ORIBOS_*` 与探针 / 临时目录名。**代价(实测记账)**:(1) **0.5.0 已上线且 tarball 不可回改**——实测线上 `@balsats/*@0.5.0` 的 wire 面仍是 `balsa.*` / `service.name: balsa` / `[balsa]` / `vendor: 'balsa'`、元数据仍是 "Balsa …" 与 `balsa-framework`,**`balsats` 一次换名只落在仓库、未随发布上线** ⇒ 下一次发布承载的是 `balsa.*` → `oribos.*` 的**合并后一次破型**;(2) **GitHub org `oribos` 已被占**(Organization,2020-08-03 创建)⇒ 沿 2026-09-28 `balsa` 先例,**个人账号同名仓库 `0xnicholas/oribos-framework` 保留完整品牌面**,ADR-0013「GitHub 归属 = org」的迁移后置口径对 `oribos` 不成立;(3) **域名 `oribos.com` 已注册**(2016-01-13、2027-01-13 到期、NameBright DNS、clientTransferProhibited)⇒ 域名根待 owner 另裁;(4) **npm org `@oribos` 创建依赖 owner 动作**(`@oribos/core` 实测 404 = FREE;`@oribos` 名下 0 包),`@balsats/*` 的 deprecate 指向动作归发布票;(5) **侧翼仓名不在本次改动面**(`balsats-docs` / `balsats-website` 归各自动线,本仓活面引用按保留面处理)。**README 口径修正**:活面机制命中会把「0.5.0 已发布」误写成新 scope,已回改为「**0.5.0 以旧 scope `@balsats/*` 上线,`@oribos/*` 自下一版起**」——已发布事实不随改名改。**保留面**:ADR 正文与既有修订记、本文件既有修订行、`docs/research/` 快照 prose;活面文档内链接已统一改写为新仓库名(dated records 内链接按 ADR 惯例保留旧地址)。**核验**:`pnpm verify` 全绿(**902 例 70 文件**)、`check:dist` 16 子路径全过、`check:runtime-deps` 七包全绿、`check:export-surface` 七包零缺口;字节预算 **16/16 零超支**——**基线随改名重钉**(core `.` / `./model` / `./agent` 各 −4 B、`./observability` −1 B、mcp-client `.` −2 B、otlp `.` −17 B、sqlite `.` −3 B:品牌串变短的机械减量);`deps-budget` **1 黄灯**(mcp-server 的 `@modelcontextprotocol/server` 闭包 13,898,836 B → 13,943,961 B、+45,125 B、包数不变 3——**外部 registry 漂移,依赖声明面未动、非改名所致**,按 ADR-0001 黄灯不卡合并,基线是否吸收另裁);example 以终态品牌复跑:`check:examples` 四案(含 `otlp-collector` 断言 `oribos.*` 属性族、`mcp-tools` HTTP + stdio)全 exit 0。依据 [改名:balsats → oribos(品牌 / npm scope / wire 面 / 仓库全换)](https://github.com/0xnicholas/oribos-framework/issues/129)。

- **修订(npm org 就位,2026-10-04)**:npm org `@oribos` 已由 owner 创建(owner 通报;org 存在性无未认证公开端点、本机 npm 未登录,存在性不可机器核验——`@oribos/core` 实测仍 404 = org 下 0 包,发布前正常)⇒ 上条「org 创建依赖 owner 动作」的前置**已就位**。0.6 发布剩余动作 = 七包 version bump → 单 tag `v0.6.0` → owner 手工 `pnpm -r publish --no-git-checks`(M-7 `prepublishOnly` 逐包前置 verify)→ 按本文件「发布后核对单」4 项核对(期望值已按 `@oribos/*` 定死);`@balsats/*` 七包 deprecate 指向 `@oribos/*` 沿上条口径仍归发布票 owner 动作;0.6 承载 `balsa.*` → `oribos.*` 合并后一次 wire 面破型的记账不变(见上「随 0.6 记账的既有破型」行)。依据 owner 通报(本 session,未立票)。

- **修订(完善阶段实施地图开图,2026-10-04)**:实施地图 [Wayfinder 地图:完善阶段实施](https://github.com/0xnicholas/oribos-framework/issues/130)(#130)建立,剩余八项落成可认领子票——批 2 = [#131](https://github.com/0xnicholas/oribos-framework/issues/131)(M-1)· [#132](https://github.com/0xnicholas/oribos-framework/issues/132)(M-2)· [#133](https://github.com/0xnicholas/oribos-framework/issues/133)(M-3)· [#134](https://github.com/0xnicholas/oribos-framework/issues/134)(P-1),批 3 = [#135](https://github.com/0xnicholas/oribos-framework/issues/135)(M-4),批 4(发布前收口)= [#136](https://github.com/0xnicholas/oribos-framework/issues/136)(M-8)· [#137](https://github.com/0xnicholas/oribos-framework/issues/137)(M-9)· [#138](https://github.com/0xnicholas/oribos-framework/issues/138)(M-10);批 1 已交付全关(#109 母票 / #110 M-5 / #111 M-6 / #112 M-7)。**批 2 前置**:M-1 / M-2 / P-1 以 [#120](https://github.com/0xnicholas/oribos-framework/issues/120)(共享 scripted model 测试桩)为阻塞(native blocked_by 已挂)——新断言消费正本、不添第六份方言;M-3 不经模型桩,可立即开工。**M-8 范围修订**:`DOC-1` / `DOC-2` 已由 [#124](https://github.com/0xnicholas/oribos-framework/issues/124)(e261be6)垫付,必须项表 M-8 行同步缩为三处(`DOC-6` / `DOC-10` / `DOC-11`),落点不再含 `workflows/{events,step}.ts`。0.6 发布路径不变:批 4 收口 → bump → tag `v0.6.0` → owner 手工 publish + 发布后核对单。依据 [Wayfinder 地图:完善阶段实施](https://github.com/0xnicholas/oribos-framework/issues/130)。

- **修订(M-3 落地,2026-10-04)**:必须项表 **M-3** 交付([#133](https://github.com/0xnicholas/oribos-framework/issues/133),5622ab9)——MCP 两包冻结面九组断言补齐:server 侧 `MS-3`(authInfo 透传:经 SDK 确达 `ctx.http.authInfo`,按设计不进 ToolContext 六件套,类型经 `McpServerRequestOptions` 复出口收编)· `MS-4`(零配置双代全服务,legacy GET/DELETE 落 405/`-32000`)· `MS-5`(modern 在途随 `close()` 中止:工具 signal 触发、fetch 落 499 空体;legacy stateless 交换不被追踪)· `MS-11`(容器构造时快照,事后增键/换 execute 不上 wire)· `MS-12`(transform 后值进 execute;非 object 根注册期被 SDK 静默略过、在 `tools/list` 落 `-32603`;派生 JSON Schema 钉 draft-2020-12 `$schema`);client 侧 `MC-4`(配置面编译期收口:新 `config-surface.test.ts`,`expectAssignable` + `@ts-expect-error` 钉死字面量面,`stderr`/`cwd`/`maxBufferSize`/`authProvider`/transport 实例注入等全拒)· `MC-9`(新 `pagination.test.ts`:no-cursor 自动跟 `nextCursor` 两页聚合保序、`refresh()` 重翻换新快照、64 页上限落 `LIST_PAGINATION_EXCEEDED`)· `MC-10/11`(`CONNECTION_CLOSED` 在途专属:在途调用以 `SdkError ConnectionClosed` 拒绝,close 后新调用为裸 `Error('Not connected')`,两面分钉)· `MC-15`(运行时 `vendor:'oribos'` / `version:1` / 冻结 `types` 双 undefined 键)。纯测试票(`src` 零改动,+21 例 / +2 文件),`pnpm verify` 全绿(**923 例 / 72 文件**),byte-budget 两包 0 B。依据 [#133](https://github.com/0xnicholas/oribos-framework/issues/133) 决议评论。

- **修订(M-4 落地,2026-10-05)**:必须项表 **M-4** 交付([#135](https://github.com/0xnicholas/oribos-framework/issues/135),dfb29b1)——组合根 logger 槽落位:`Logger` 四级方法结构类型(`debug` / `info` / `warn` / `error`,`console` / pino 直吃)居 observability 入口、core 根复出口收编;`AppConfig.logger` additive 开槽(本阶段唯一公开面增量),`app.workflow()` 分发、显式优先(沿 tracer 先例),`WorkflowConfig.logger` 缝 + committed `Workflow.logger` 暴露(沿 `Workflow.tracer` 先例)。**缝只开 workflow**:agent / signals 不开——agent.md 钦定缝集 = tracer / processors(「Nothing beyond them」),开缝归各篇规范自己的决策,无消费面不往 config 焊死字段;内核无 log 埋点,通道 = observability 规范为 logs 钦定的唯一路径(OTel logs 维持砍单),子系统 log 点归后续里程碑。钉点:`@ts-expect-error` 占位钉改钉「按类型开」+ AgentConfig 拒收反钉,workflows-surface 冻结键集钉补 `logger`;观测篇「定位」措辞与 ADR-0002 修订行同步。`pnpm verify` 全绿(**925 例 / 72 文件**),check:dist / check:export-surface / check:examples(4 案)绿,byte-budget 基线同票吸收(`.` +46 B / `./workflows` +16 B,`./observability` 0 B——类型零运行字节)。依据 [#135](https://github.com/0xnicholas/oribos-framework/issues/135) 决议评论。

- **修订(M-8 落地,2026-10-05)**:必须项表 **M-8** 交付([#136](https://github.com/0xnicholas/oribos-framework/issues/136),68f1e7b)——文档真相源三处修订全落:**DOC-6** = `docs/architecture/tools.md` 不挂 outputSchema 行码名改实(原「缺 `structuredContent` → `InvalidRequest`、不合 → `InvalidParams`」改写为 SDK 入站校验抛 `SdkError(SdkErrorCode.InvalidResult)`——`@modelcontextprotocol/client@2.2.0` 源码证实结果校验路径(缺 / 不合 `structuredContent`、非 object 根)独用 `InvalidResult`,`InvalidRequest` / `InvalidParams` 仅 JSON-RPC wire 码、不经客户端结果校验,审计「未查实」结案);**DOC-10** = README `result` 信封注释去 `'failed'`(实装 `result` 只 resolve success / suspended,失败 reject——`workflows/run.ts`);**DOC-11** = README verify 描述补 `check:export-surface` 并注明 byte / deps 预算不在 verify(CI 闸门)。修订核对表:DOC-1(`workflows/events.ts` suspend 读 `suspended`)与 DOC-2(`workflows/step.ts` suspend docstring)核对确认已由 [#124](https://github.com/0xnicholas/oribos-framework/issues/124)(e261be6)覆盖、无遗留措辞。纯文档票(`src` 零改动),`pnpm verify` 全绿(**925 例 / 72 文件**)。批 4 口径不变:M-9 / M-10 收口前不进行任何发布动作。依据 [#136](https://github.com/0xnicholas/oribos-framework/issues/136) 决议评论。

- **修订(M-9 落地,2026-10-05)**:必须项表 **M-9** 交付([#137](https://github.com/0xnicholas/oribos-framework/issues/137),5a4024c)——六处措辞级修订全落(纯措辞票,`src` 零改动):**AG-15 / H-11** = `agent.md` / `harness.md`「裸 agent 不产生 `'suspended'`」限定「**不传 `stepBoundary` seam 时**」(该 seam 是公开 run option,显式传入即产生,`agent-step-boundary.test.ts` 有钉);**ST-63** = `storage.md` 关系节「可代管 `init`/`close`」改判「**不代管**」,CUT-ST6 表行同批收口(「代管未落 → M-9」过程注记落终态);**M-52** = `model.md` 终帧 `messageMetadata` 的 `usage` 改**恒写**(实装两态 `{ usage }` / `{ usage, suspended }`,`suspended` 仅挂起时——`chat-route.ts`);**DOC-3** = `workflows.md` JSON-only 归 **port 契约**、默认内存实现不执法(`structuredClone` 放行 Map / Set / Date / 循环,与 `map-snapshot-store.ts` 自述同调);**DOC-4** = `workflows.md` `.branch` 臂间 IO schema 一致改「**调用方保证**(类型层不强制)+ 下游步输入边界校验拦截」;**无界缓冲 / 无背压** = `agent.md` / `workflows.md` 各补一句(消费节奏归消费者侧;两流共用 `output-object` 缓冲机制)。与 M-4(观测 / 组合根措辞)同批检查无撞车(M-4 落 observability 篇 / ADR-0002,本票五篇无交集)。`pnpm verify` 全绿(**925 例 / 72 文件**)。批 4 口径不变:M-10 收口前不进行任何发布动作。依据 [#137](https://github.com/0xnicholas/oribos-framework/issues/137) 决议评论。

- **修订(M-10 落地,2026-10-05)**:必须项表 **M-10** 交付([#138](https://github.com/0xnicholas/oribos-framework/issues/138),65d4ccb)——五处「实装超规范」补写全落:**DOC-5** = `tools.md` 桥接 schema 运行时 `types` 改实(冻结 `{ input: undefined, output: undefined }` 双 undefined 键,与类型标注 `unknown` 分开——`mcp-client/src/index.ts`);**DOC-7** = `storage.md` 代码块 `await storage.init()` 去 `await`(实装同步 `void`,`sqlite` 包注明旧文档的 `await` 仍即刻 resolve);**DOC-8** = `harness.md` Signals 签名补 `tracer?`(注入事件落 `isEvent` span 的缝,组合根分发)+ 面补 `stream` / `generate`(per-call `memory` 身份注册 thread,调用即注册、run 仍懒启动,无身份直通,同 thread 活跃 run 唯一);**DOC-9** = `harness.md` schedules 补 `save` 校验(以当前时刻调 `next` 重锚 `nextFireAt`,Invalid Date 显式报错,`null` = 不再触发——`schedules.ts`);**DOC-12** = `memory/in-memory-store.ts` 两行中文注释英文化。字节预算实测 10 入口 **0 B**(minify 剥行注释,基线不动,记账免吸收)。`pnpm verify` 全绿(**925 例 / 72 文件**)。**批 4 自此收口,发布前置已就绪**;0.6 到达判据余批 2 三票(M-1 / M-2 / P-1,blocked by [#120](https://github.com/0xnicholas/oribos-framework/issues/120))。依据 [#138](https://github.com/0xnicholas/oribos-framework/issues/138) 决议评论。

- **修订(M-1 落地,2026-10-05)**:必须项表 **M-1** 交付([#131](https://github.com/0xnicholas/oribos-framework/issues/131),379361e)——并发与取消语义四用例全落:**流中途 abort** = 共享测试桩正本 `@oribos/testing` 新增 `FakeResponse.abortAfter` 流中可中断钩子(发出前 N part——计数含 `stream-start` 等全部 part——后挂起,待本次调用 `abortSignal` 中止即以携带 `signal.reason` 原样的 error part 收尾,中断点后脚本 part 永不发出;doStream 校验非负整数 + 调用必带 signal,缺省不启用、存量行为不变)——断言已吐 chunk 照常交付、run 以 abort 原因**同一对象**拒绝(迭代与终值 promise 同)、`processError` 零调用(规范「已取消的 run 不触发」)、fallback 链不续(backup `streamCalls` 为空——取消不是链失败);**同一 agent 并发 run** = gated 工具造真实交叠窗:两 run 的 `text` / `steps` / `usage` / `toolCalls` / prompt 互不串(`streamCalls` 录制钉),各起一条 trace、step span 各归其 trace,窗口内工具的 span 与 ctx `runId` 属 run A;**同 thread 并发写**(core 内存 store + `@oribos/sqlite` 同一 scenario)= 16 条交错并发 save 不丢消息、不串 thread、按调用序读回(save 首 await 前同步盖章 id / createdAt)、16 id 唯一、thread 记录各一不错配,「非事务 read-modify-write」口径写入两例注释(ensureThread 竞态 last-write-wins 仅落 thread `updatedAt`,钉的是不丢不串而非更强隔离);**signals 并发投递** = 并发 `sendMessage` 按到达序注入下一 step prompt 尾部且各落历史恰好一次,并发 `queueMessage` 续跑 run 输入按到达序保序(确定性 = deliver / 入队的同步 push 先于一切 await)。纯断言票:公开包 `src` 零改动,唯一 src 触点 = 私有桩正本(不进 dist,字节 / 导出面零影响,预算免吸收);`pnpm verify` 全绿(**933 例 / 72 文件**,+8)。断言未暴露实装缺陷,无另开票。0.6 到达判据余批 2 两票(M-2 / P-1)。依据 [#131](https://github.com/0xnicholas/oribos-framework/issues/131) 决议评论。

### 发布后核对单(M-7)

发布动作已由「七包 `prepublishOnly` 跑 `verify`」前置(逐包、打包前):闸门全绿且当次构建就绪才打包,闸门红则该包不发布。发布完成(owner 手工 `pnpm -r publish --no-git-checks`)后按下表逐项核对——**本段是核对单的单一真相源,别处不复制**;七包 = `core` / `ai-sdk` / `croner` / `mcp-client` / `mcp-server` / `otlp` / `sqlite`,`<ver>` = 当次版本,命令在仓库根跑。

| # | 项 | 命令 | 期望 |
| --- | --- | --- | --- |
| 1 | `description` | `for p in core ai-sdk croner mcp-client mcp-server otlp sqlite; do npm view @oribos/$p description; done` | 七行全部以 `Oribos ` 开头(仍见 `Balsa ` / `Balsats ` = 旧名元数据没随本次发布刷新) |
| 2 | `repository.url` | `for p in core ai-sdk croner mcp-client mcp-server otlp sqlite; do npm view @oribos/$p repository.url; done` | 七行全部 `git+https://github.com/0xnicholas/oribos-framework.git`(`balsa-framework` / `balsats-framework` 零命中) |
| 3 | dist-tags | `for p in core ai-sdk croner mcp-client mcp-server otlp sqlite; do npm view @oribos/$p dist-tags.latest; done` | 七行全部 `<ver>`(`latest` = 消费者默认安装到的版本) |
| 4 | `exports` | `for p in core ai-sdk croner mcp-client mcp-server otlp sqlite; do printf '%s ' @oribos/$p; npm view @oribos/$p exports --json \| node -pe 'Object.keys(JSON.parse(require("fs").readFileSync(0,"utf8"))).length'; done` | `@oribos/core` 10 + 六能力包各 1 = 合计 **16**,与 `pnpm check:dist` 的 16 子路径一致(线上公开面未缩) |

> 0.5.0 的 `description` / `repository.url` 是旧名(不可原地修改的既有事实):上表第 1 / 2 项在 0.5.0 上必然报红——这两项守的是**下次发布**,也是这次加固要防的那类「线上元数据与仓库不一致」。
> `pnpm pack` 的边界:pack 不触发 `prepublishOnly`,故 pack 产物不由闸门保鲜;要核对发布通路本身,走演练 `pnpm --filter @oribos/<pkg> publish --dry-run --no-git-checks`(打印前置执行与 tarball 内容、不触注册表;本地版本已在注册表时需加 `--force` 才会走完全程)。

## 延后清单(post-v1,需求信号触发)

以下能力经路线图裁决**延后或出域**,不进 v1 任一里程碑。**本清单是「重开条件」的单一真相源**(术语见 `CONTEXT.md`):重开条件必须外部可观察、可累计;满足即单独评估,**不自动进入路线图**。缺口与差异的完整对账见 `docs/research/mastra-gap-analysis.md`(对比视图,不复制条件)。M5 能力包(OTLP exporter / MCP server + client / SQLite adapter / AI SDK 互操作)已在路线图内,不属本清单。

> 修订(2026-09-30,对比 ticket [#63](https://github.com/0xnicholas/oribos-framework/issues/63)):清单升级为四列表,重开条件统一为可观察、可累计的判定信号。

> 修订(2026-10-02,判定票 [#106](https://github.com/0xnicholas/oribos-framework/issues/106)):能力项 20 行(延后档 13 + 出域档 7)逐条判定为**有意分叉**——全部**原地留**、重开条件不变;新增「承接」列指到规范表行(判定与理由的单一真相源在 `docs/architecture/*.md` 的「砍单与承载缝」表,本清单不复制理由)。

### 延后档(触发式)

| 缺口 | 重开条件(可观察) | 承载缝 | 承接(规范表行) |
| --- | --- | --- | --- |
| Supervisor 能力包(createSupervisor 类) | as-tool 组合的真实重复痛点 ≥3 次复述,或 ≥1 个真实项目因包装样板 / 传播遗漏 / 嵌套审批受阻 | 能力包优先;核心字段须重开 [决策:多 agent 协作语义](https://github.com/0xnicholas/oribos-framework/issues/19) 的演化门 | `agent.md`「多 agent 组合」演化门(ADR-0012) |
| RAG / 语义召回 | ≥1 个真实用例要求跨会话语义检索(外部用户或自身产品场景) | memory 落库 hook + 能力包(复用模型契约的 embedding 模式) | `memory.md`(CUT-MEM1) |
| 外部记忆引擎桥接(bunfold 类) | ≥1 个真实用例要求框架侧提供桥接包(而非宿主侧自组装),且接受外部常驻服务依赖(独立服务 + 其 LLM 抽取管线 + 数据落盘);或此类引擎出现可嵌入(库)形态(无需常驻服务) | 能力包;缝 = memory 落库 hook / recall 增强(实施期裁决) | `memory.md`(CUT-MEM2) |
| Evals / scorers | ≥1 个用例要求在 CI 或线上做断言式评估 | Processor,或独立包消费 run 结果 | `agent.md`(CUT-AG1) |
| 字符串路由(models.dev 类) | ≥1 个真实用例要求按名切模型 / provider 目录(而非照搬 mastra 形态) | 能力包(不引入 core magic string) | `model.md` 砍单与承载缝(篇级) |
| OTel bridge 能力包 | ≥1 个用户已有 OTel 采集管线、要求原生接入(与 M5 的 OTLP 导出分属两件事) | 能力包 | `observability.md`(CUT-OBS2) |
| Background tasks | 「工具 ack + sendSignal 唤醒」文档范式的失效报告 ≥1:`untilIdle` 式自动续跑 / 并发限额 / 结果自动回灌任一成为硬需求 | 文档范式先行,能力包其次 | `harness.md`(CUT-H5) |
| Goals / State signals | WM + Processor 组合被证明不够:≥1 个用例需要 judge 判定 + 预算语义 | 能力包;前置 = thread 状态域 | `harness.md`(CUT-H2 / H6) |
| 跨实例 signals | ≥1 个部署要求 >1 进程共享同一 thread | 能力包(共享 PubSub + 租约) | `harness.md`「Signals(基础层)」运行时段 |
| resumable stream | ≥1 个断连重连 / 迟到订阅的真实诉求(用户报告,非推测) | 能力包(事件缓存) | `harness.md`(CUT-H1)· `model.md`(CUT-M3) |
| 外部 runner 适配 | ≥1 个用户在 Inngest / Temporal 类平台上要求跑 workflow | 能力包(引擎接缝已留) | `workflows.md`(CUT-W9) |
| 每步检查点 + 崩溃重放 | ≥1 个用户明确接受重发 LLM 与幂等成本、并要求自动恢复 | 能力包 / 部署方(ADR-0011 已裁) | `harness.md`(CUT-H1) |
| time-travel / restart | ≥1 个调试或审计场景要求从任意步重跑 | load→重进原语上的薄变种,无 port 变更 | `workflows.md`(CUT-W7) |

### 出域档(定位改变才重开)

| 缺口 | 重开条件(可观察) | 承载缝 | 承接(规范表行) |
| --- | --- | --- | --- |
| Studio / editor / stored agents | 定位裁决改变 = 做托管产品或协作面(ADR 级) | — | `agent.md` 裁单表(CUT-AG3) |
| channels / voice / workspaces & sandboxes / browser | 同上,或社区出现可用实现 | 生态 | `agent.md`(CUT-AG2) |
| 托管平台 | 商业决策(非技术触发) | — | —(商业决策,无技术承载缝可落) |
| OM 类后台压缩 | ≥1 个用例要求跨会话长期记忆、且接受后台 LLM 成本 | bunfold 类外部记忆桥 | `memory.md`(CUT-MEM2) |
| notification inbox | ≥1 个用例要求持久化收件箱 / 优先级投递 | 应用层或能力包 | `harness.md`(CUT-H3)· `storage.md`(CUT-ST3) |
| signal providers(webhook / poll 入口) | ≥1 个用例要求 webhook 接入且示例模式不可复用 | 示例模式 | `harness.md`(CUT-H4) |
| AgentController / session | ≥1 个用例要做交互式编码 agent 产品 | 应用层自组装 | `harness.md`(CUT-H7) |

### 现实差距(非功能)

| 差距 | 条件 / 状态 | 承载缝 |
| --- | --- | --- |
| 发布 0.5.0 | **已发布(2026-10-02)**:七包 0.5.0 在 npm 上线,单 tag `v0.5.0` + Release;核对与冒烟见 [#97](https://github.com/0xnicholas/oribos-framework/issues/97),口径收口见 [#99](https://github.com/0xnicholas/oribos-framework/issues/99) | — |
| 公开上手面(文档站、对外 quick start) | quick start 已随 0.5.0 可用(README 安装命令 + 子路径面经注册表冒烟,#97);文档站归 `balsats-docs` 动线(本图只出交接口径) | README 已有 quick start |
| 适配器生态 | ≥1 个真实第二后端诉求 | 社区 + 作者指南(`docs/architecture/storage.md`) |
| 公开可检验性(轻量主张的外部证据) | **结案(2026-10-02 身份裁决)**:数字一律不对外——沿 ADR-0001 立场(依赖数/字节数仅内部 CI 回归参考,不作公开承诺),**机制可讲**(零依赖硬闸门、字节预算黄灯等);balsats-website 侧同口径(不写 KB / 测试数) | — |

## 本图不覆盖

- **排期**:刻意不含时间与人力安排。
- **实现期选型**:构建/测试工具链、SQLite 驱动等留给各里程碑实施期。
- **出域项**:Workspaces/Sandboxes、Channels、Voice、Studio、托管平台、OM 类后台压缩管线、notification inbox、signal providers、AgentController(依据见地图的 Out of scope)。
