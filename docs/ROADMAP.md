# 实施路线图

Oribos(TypeScript/Node agent 框架:agent / 记忆 / 工作流 / Harness 三件套 / 六能力包能力面,零运行时依赖)的粗粒度实施路线图:**只讲顺序、依赖与可验证产出,不含排期**。规范本体见 `docs/architecture/`(入口:`docs/architecture/README.md`),术语见 `CONTEXT.md`,决策依据见 `docs/adr/`。定位措辞两层结构(2026-10-11,ADR-0016):公开叙事 = 品类语言 + 能力广度 + 零依赖事实担纲(oribos-website 为正典),「轻量」退为内部轴名、不作公开身份词。(2026-10-11 转向重裁:ADR-0017 取代 ADR-0016——定位 = **转向追赶 mastra、轻量轴保留**;公开叙事面随转向再翻转、归后续叙事票,翻转前现行公开口径如实保留。)本图由 [决策:粗粒度实施路线图](https://github.com/0xnicholas/oribos-framework/issues/16) 产出。

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

## 完善阶段(0.6,已收口)

**目标形态 = 子系统完整判据**(不绑版本号):把八个子系统(模型 / Agent / 工具 / 工作流 / 记忆 / 观测 / 存储 / Harness)各自的「什么算完整」定死——规范承诺兑现 + 已记录砍单项清账 + 有意分叉写明 + 质量面达标——再以它为准判掉三份盘点:**有意分叉**写明理由并落各篇规范的「砍单与承载缝」表,**欠账**提升为下「必须项」表(自定触发 = 完整判据本身,验证面 = 兑现的第二半)。判定口径:二元结论(有意分叉 / 欠账)+ 两道门(写不出分叉理由的按欠账;写不出验证面的欠账不得提升)+ 禁跟单(mastra 有 / 以后有用 / 不贵);**信号源条款(2026-10-11 增补,ADR-0016)**:禁跟单与需求侧重开条件原样不动——明文判读「无用户期纪律悬空」(需求侧重开条件以用户基数为前提,无用户期候选池静默是结构性的,不构成定位失败证据);轴级公开痛点证据(edge 部署受阻、框架 overhead 抱怨等)是定位/市场面工作的合法输入,**不构成延后清单功能行的晋升理由**。术语见 `CONTEXT.md`(完整判据 / 自定触发 / 有意分叉·欠账 / 形状内语义差异 / 验证面 / 信号源建设期)。

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

- **八篇规范的「砍单与承载缝」表已归一**为目标表形 `项 | 承载缝 | 判定 | 理由·ADR 指针`(model 篇另留「重开条件」列),共 95 行;判定侧落定:§3 形状内语义差异 33 条 + 审计 §2 砍单行集 60 行 + 延后清单能力项 20 行——**有意分叉 110 行 / 已兑现(非差异)3 段 / 净提升 0 行**(2026-10-11 更正:110 口径经 [#162](https://github.com/0xnicholas/oribos-framework/issues/162) 逐行清点证伪——全量实为 **94 行**、纯 CUT-* 编号 60、审计原计 61 差 1;更正后口径见上「追赶面」段,本行数字按 dated record 保留)。
- **单一真相源**:分叉理由与承载缝只在规范表(本节不复制理由);「重开条件」只在延后清单(规范表只写承接指针)。
- **提升项与分叉的边界**:唯一从 §3 走出的提升是 `P-1`(三条已实装但无验证面的语义,按判据不构成兑现);§2 与延后清单**零提升**。

### 与延后清单的关系

延后清单 20 个能力项(延后档 13 + 出域档 7)逐条判定为**有意分叉**:全部**原地留**,重开条件一律不变——「重开条件」的单一真相源仍是延后清单(新增「承接」列只为指到规范表行,判定与理由见各篇规范表)。因此本阶段**不从延后清单移出任何行**;必须项表 11 行全部来自承诺面(§1)、语义面(§3)与质量面(§4)。

### 版本口径

- **标注 0.6**(序列 0.5.0 → 0.6,0.4 已跳空):提升项内容量 = 断言补齐 + 两个闸门 + 一个 additive 配置槽 + 文档对齐——**无破型、无新子系统**。
- **与 1.0 门槛的关系**:倾向「与 1.0 门槛合并评估」——**本阶段不定义 1.0**(1.0 门槛自 M5 口径修订起搁置,见下「发布节奏与 v1.0 门槛」);若 0.6 收线后提升项自然构成门槛,另起 effort 正式定义。
- **随 0.6 记账的既有破型**:品牌改名把 OTel 属性族 `balsa.*` → `oribos.*`、`service.name` 默认 `oribos`、console 前缀与 mcp-client vendor 同步——**线上 0.5.0 tarball 实测仍是 `balsa.*` / `balsa`**(`balsats` 一次换名只落在仓库、未随发布上线),故下一次发布承载的是**合并后的一次破型**,对 0.5.0 消费者是观测 wire 面破型(pre-1.0 窗口内落,ADR-0009 已注记)——与本节提升项无关,但同一发布承载。

## 信号源建设期(2026-10-11 即日终结:转向追赶 mastra)

**裁决:0.7 不存在(2026-10-11)**——三路 0.7 候选池全空:mastra 侧定点刷新(`docs/research/mastra-gap-analysis.md` 第三版,快照 2026-10-11)+ 延后清单 20 能力行禁跟单核对零行满足重开条件([#145](https://github.com/0xnicholas/oribos-framework/issues/145));内部欠账三核账项逐项落定、无 0.7 内容候选([#146](https://github.com/0xnicholas/oribos-framework/issues/146));owner 无新输入。每项进版本必须答得出「为什么是现在」;三路皆答不出,**0.7 不立项**——空池是合法结论,不是缺口([#147](https://github.com/0xnicholas/oribos-framework/issues/147))。空池根因判读:需求侧重开条件以用户基数为前提,而 0.6.0 首发于 2026-10-05——**结构性静默(无信号源),不构成定位失败的证据**;定位根裁决 = **维持有意分叉,不转向追赶 mastra**([#151](https://github.com/0xnicholas/oribos-framework/issues/151),ADR-0016)。

**本期主题 = 采用与上手面建设**:让利基找得到 oribos、让需求侧信号获得来源(术语见 `CONTEXT.md`「信号源建设期」)。**功能面一行不动,不 reopen 延后清单任何行**;oribos-website 叙事改版(2026-10-11)为该姿态首个已执行动作,由 #151 追认为 de jure。本期实施动作沿两段式先例另开地图,本段只定主题与口径。

**版本口径**:**0.7 不立项、版本号不预占**——下一功能内容的唯一入口 = 延后清单重开条件被外部可观察信号满足(满足即单独评估,不自动进入路线图);内容到达时按内容定号。1.0 门槛沿既有口径(未定义、另起 effort),空池不构成其触发。

依据 [Wayfinder 地图:定位裁决](https://github.com/0xnicholas/oribos-framework/issues/149)(调研票 #150 / 根裁决票 #151 / 处置票 #152)与 ADR-0016。

**本期终结(2026-10-11,即日)**:owner 行使决定权硬转——定位重裁 = **转向追赶 mastra、轻量轴保留**([#158](https://github.com/0xnicholas/oribos-framework/issues/158);ADR-0017 取代 ADR-0016,ADR-0016 重开条件未满足、非条件翻案)。本期主题(采用与上手面建设、功能面一行不动)与「0.7 不存在」裁决随硬转**作废**——功能面入口不再是延后清单需求侧重开条件,而是「mastra 采用 = 需求证据(二手需求)」触发下的追赶面重估(重估不自动晋升;程序见 ADR-0017「翻案程序」);版本号不预占口径不变,下一功能版本按追赶面内容定号,1.0 门槛沿既有口径(未定义、另起 effort)。本期产出(公开叙事两层结构 #154、发现面 #155、skills 包 #157)为 dated 交付物保留、不撤销——采用与上手面在追赶定位下仍是正资产;叙事面随转向再翻转,归后续叙事票(公开记录第三次定位摆动,翻转文案须写明理由)。本节内容按 dated record 原样保留。

## 追赶面(ADR-0017 重判,重判程序完成)

定位硬转(2026-10-11,ADR-0017)后的功能面入口与判定口径:**「mastra 已采用且未弃的功能面 = 需求证据(二手需求)」触发重估,不自动晋升**——判定两道门 = 需求证据(已弃方向如 `.network()`、纯营销动作不计;证据 = 上游实装存在且未弃)+ 保轴硬门(按需组合 + 无运行时负担,ADR-0001;**轴级判词**:opt-in、不配置即零成本、不接管宿主的进程内后台工作 ≠ 运行时负担,ADR-0017 修订记 / #160;零依赖硬闸门不挡功能,能力包携外部依赖沿 ADR-0015 M5 口径)。**三态判定**:维持分叉 / 转追赶项(带承载缝与验证面形状)/ 维持分叉但理由改写;判定结论的单一真相源 = 各篇规范「砍单与承载缝」表行与下「延后清单」行,本段只做索引不复制理由。重判执行归 [Wayfinder 地图:追赶面重判](https://github.com/0xnicholas/oribos-framework/issues/159),首批从与现有承载缝最近的行起步;**实施沿两段式先例另开实施地图**(本图只出清单、顺序与验证面形状),`pnpm verify` 全绿是硬门。

### 已裁定转追赶项(15 行:13 行 2026-10-11 + 2 行 2026-10-12)

出域档 2 行([#160](https://github.com/0xnicholas/oribos-framework/issues/160))+ 延后档 11 行([#161](https://github.com/0xnicholas/oribos-framework/issues/161));批 1 / 批 3 重判补 §3 形状内语义差异 2 行(A2 经 [#164](https://github.com/0xnicholas/oribos-framework/issues/164)、A4 经 [#166](https://github.com/0xnicholas/oribos-framework/issues/166),2026-10-12)。距离 = 与既有承载缝的距离(#161 三层,#160 同参照系):

| 追赶项 | 承载缝 | 验证面形状 | 距离 |
| --- | --- | --- | --- |
| signal providers(webhook / poll 入口) | 示例形态:webhook 入口例 + 配方,薄 HTTP 端点 → `sendSignal`,零新缝零依赖 | example 进 `check:examples` 闸门 | **最近(首批候选)** |
| Evals / scorers | 独立 scorer 能力包 + Processor 接线(`steps` / `text` / `usage` 均公开面) | scorer 单测 + 接线 example | **最近(首批候选)** |
| Supervisor 能力包 | as-tool 公开表面,零新缝 | fake model 单测 + 多 agent example | **最近(首批候选)** |
| time-travel / restart | load→重进原语薄变种(先截断该位之后的记录,无 port 变更) | 截断 + 重进单测 + 调试场景 example | **最近(首批候选)** |
| Background tasks(一期) | 配方文档 + example(「工具 ack + `sendSignal` 唤醒」,ADR-0011 判等效) | example 进 `check:examples` 闸门 | **最近(首批候选)**;二期(manager/lease 包)= 远 |
| A2 同一步多工具并发(opt-in) | run options additive 的 opt-in 开关,默认串行不变 | 调用序确定性 / abort 打断 eager 中途 / eager 失败路径与流交织 | **最近(首批候选)** |
| A4 chunk 协议推理 / 参数增量帧(opt-in) | 核心 chunk 协议 additive 两族帧(推理增量 / 参数增量),opt-in 发射、默认四帧不变;互操作包归一层映射、不再静默丢弃 | 推理 / 参数增量帧往返保真(核心 → 互操作 → UI stream)+ 不消费方零影响(默认四帧流逐字节不变)+ 未知帧忽略语义 | **最近(首批候选)** |
| RAG / 语义召回 | 能力包:落库 hook 索引 + recall 语义增强(`Memory.save → saveMessages` 缝;向量库依赖随包) | save→索引 / recall 增强单测 + example | 中 |
| OTel bridge | 能力包:TracerProvider 接入 + trace-context 传播,复用 `@oribos/otlp` semconv 映射(metrics / logs 维持砍单) | TracerProvider 互操作单测 + example | 中 |
| resumable stream | 能力包:事件缓存 + `observe`(内存默认零负担、Redis opt-in) | 缓存单测 + 断连重连 example | 中 |
| 字符串路由(models.dev 类) | 能力包:目录 + 解析映射(核心「无注册表 / magic string」钉子不动) | 解析单测 + 目录快照 example | 中 |
| 每步检查点 + 崩溃重放 | 能力包 / 部署方(boot 恢复 = 用户调用的函数、非常驻循环) | fake model 重发计数单测 + 崩溃重放 example | 中 |
| 跨实例 signals | 能力包:共享 PubSub + 租约抽象 + Redis 适配(核心单进程语义不变) | fake PubSub/lease 单测 + 双进程 example | 远 |
| 外部 runner 适配 | 能力包:引擎接缝已留(Inngest / Temporal) | 引擎适配单测 +(可选)Inngest example | 远 |
| OM 类后台压缩 | 能力包(Observer/Reflector 进程内 opt-in 式),消费 memory 落库 hook——**核心新缝,须过演化门**;存储 additive 可选方法 + 能力标志 | fake model 单测 + example | **最远**(新缝 + 存储扩展),不进首批 |

维持分叉但理由改写 7 行:延后档 2(外部记忆引擎桥接——证据不成立 + 轴冲突;Goals / State signals——thread 状态域前置缺席)+ 出域档 5(Studio / channels·voice·workspaces / 托管平台 / notification inbox / AgentController)——逐行理由见各规范表行与延后清单行,不在此复述。观察项:mastra knowledge v2(仅 alpha 线,非证据),稳定线转正后随 gap analysis 刷新重估;「thread 状态域立不立」为 Goals / State signals 行唯一真前置,登记地图 Fog。

### 重判余量与程序(77 行,已判毕)

**行数口径更正(2026-10-11,#162)**:「有意分叉 110 行」在任何口径下都不成立——全量 **94 行**(CUT-T3 按文档自身逐项展开口径计 14 行;CUT-T3 作单行计则 81);纯 CUT-* 编号 **60**(审计报告原计 61 差 1,已随本节更正)。17 行已被 #160/#161 裁定(上两节),**待判余量 = 77 行**(近 59 / 中 13 / 远 5)。程序(五要素 + 批次清单 + 预分类制,冻结于 [#162](https://github.com/0xnicholas/oribos-framework/issues/162)):6 批、距离升序、同缝同簇不拆票(批 1 = agent Processor 相邻 + harness durable/signals 相邻 + workflows load→重进簇,16 行);批 2–6 逐批 graduate;批次结论经单一写者写回记录面;疑点行另立 research 票定点深查、不阻塞同批其余行。

**重判程序完成(2026-10-12,批 6/6 收口)**:批 1–6 逐批判定落锤([#164](https://github.com/0xnicholas/oribos-framework/issues/164)–[#169](https://github.com/0xnicholas/oribos-framework/issues/169)),**77 行程序对象判毕、待判余量 = 0 行**;转追赶项 +2 行(批 1 A2、批 3 A4,见上「已裁定转追赶项」表,首批候选集随补 A2 / A4),余 75 行维持分叉(其中批 5 CUT-AG4 / CUT-M2、批 6 D5 三行**维持分叉、理由改写**指针化,逐行见各篇规范表);各批均记计数无更正、ADR-0017 修订记无需新增。批次结论由单一写者统一写回本段与各规范表行(任务票 [#170](https://github.com/0xnicholas/oribos-framework/issues/170))。

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

- **修订(M-2 落地,2026-10-05)**:必须项表 **M-2** 交付([#132](https://github.com/0xnicholas/oribos-framework/issues/132),f7ec681)——行为性未验断言五用例全落:**M-52 终帧 `finishReason` 逐值映射**补齐 `length` / `tool-calls` 两透传值(`length` 截断直透终帧;路由永不从 body 读 `maxSteps`,默认上限 5 耗尽、末步工具照常执行,终值 `tool-calls`;随钉 `messageMetadata.usage` 恒写 = run 累计,`stop` / `error` / `suspended→other` 三值存量例已钉,M-52 收全);**AG-40 Processor 三钩自身抛错** = `processInput` 抛错模型调用未发起、`processOutputStep` 抛错、`processError` 抛错以钩子抛出的错误拒绝(非原错误)且链上后续 `processError` 不再被喂——三钩均即 run 失败、处理器不互相处理;**P-11 快照写失败两路** = `suspended` 快照写抛错随 run 失败(失败后的 `failed` 终态写照常补上,终态真相不丢),`failed` 终态那一写 best-effort(store 同失败时 run 自身错误**原样上抛**、不被 save 错误替换);**M-51 route 取消直通** = 在途 abort `request.signal` → run 的 signal 中止、`onError` 收到的错误与 `request.signal.reason` **同一对象**(abort 接力保原因)、中断点前已吐增量照交、其后脚本不发,脱敏 error 帧 + `finish{error}` + `[DONE]` 收尾;响应流 `cancel()` 同接 abort(模型调用收到的 signal 随之中止);**DOC-4 臂间 schema 不一致** = 类型擦除的调用方(仓内惯例 `as never` 绕 `.then` 品牌)由下游步的固定输入边界拦截,`WorkflowValidationError` 钉在下游步 id(臂自身边界均已通过)。纯断言票:公开包 `src` 零改动(唯一触点 = 四个测试文件,+275 行);`pnpm verify` 全绿(**943 例 / 72 文件**,+10)。断言未暴露实装缺陷,无另开票。0.6 到达判据余批 2 一票(P-1)。依据 [#132](https://github.com/0xnicholas/oribos-framework/issues/132) 决议评论。

- **修订(P-1 落地,2026-10-05)**:必须项表 **P-1** 交付([#134](https://github.com/0xnicholas/oribos-framework/issues/134),cdda3da)——§3 语义钉子三条行为断言全落:**SEM-A2 同一步多工具串行** = gated 假工具把首工具按在执行中间,第二个工具的 `execute` 在第一个 settle 前**零调用**(变异核对:loop 改并发即红),放行后启动序 = 调用序、结果按序并入本步;**SEM-B16 条件内 `suspend()` 报错** = branch 条件与 dowhile 循环条件同一路(walker 以 `step === undefined` 组包,`suspend` 由 `suspendOutsideStep` 顶替),run 以裸 `Error` **失败而非挂起**,消息逐字钉死(「suspend() is not available in a branch or loop condition — only a step can suspend a run」),臂不执行、后续条件不再求值、循环体一次都不执行;**SEM-D7 / H-48 `tick` 自身无 span** = 挂 tracer 的 target 被触发后,导出 span 恰为该 run 的 `agent-run` + `agent-step` 两个、同属一条 trace(tick 没有添一个);反向不挂 tracer 时整拍(触发 + 重锚)不触碰 span id 生成(`withSpanIdProbe` 零开销探针)。纯断言票:公开包 `src` 零改动,`@oribos/testing` 正本桩未动(三条断言直接消费既有 `fakeModel` / `deferred` / 探针面);`pnpm verify` 全绿(**946 例 / 72 文件**,+3)。断言未暴露实装缺陷,无另开票。**批 2 自此收口**(M-1 / M-2 / M-3 / P-1 全交付);0.6 到达判据余发布票 [#139](https://github.com/0xnicholas/oribos-framework/issues/139)。依据 [#134](https://github.com/0xnicholas/oribos-framework/issues/134) 决议评论。

- **修订(发布 0.6.0,2026-10-05)**:七包 **0.6.0** 已在 npm 上线(**`@oribos/*` scope 首发**,接替 `@balsats/*` 0.5.0)——未认证七端点全 200、`latest=0.6.0` ×7、`engines >=22.13.0`、peer 互指已改写 `^0.6.0`;线上 tarball 逐包 = `dist/`(非空)+ README + LICENSE;干净目录安装冒烟 16 面(core 根 + 9 子路径 + 六能力包)全过;单 tag `v0.6.0` → `034417a` + [GitHub Release](https://github.com/0xnicholas/oribos-framework/releases/tag/v0.6.0)(notes 覆盖七包 + 完善阶段 + 合并破型记账)。本发布承载 `balsa.*` → `oribos.*` 合并后一次 wire 面破型(线上 0.5.0 tarball 实测仍为 `balsa.*`,`balsats` 换名未随发布上线;pre-1.0 窗口,ADR-0009 已注记)。**`@balsats/*` 处置**:owner 有意下架(七包已全 404),deprecate 无对象、#139 票面该项作废。**插曲(如实记账)**:首发跑未带 bump,0.5.0(及 core / croner / mcp-server 三包 `0.0.0-stage` 占位)先行上线;registry 传播延迟曾致 otlp / sqlite 端点短窗 404、误判「未发出」;0.6.0 全量重发后 `latest` 全归位——杂版(0.5.0 ×7 + 0.0.0-stage ×3)撤除归 owner 动作(72h 窗口至 2026-10-08),结果另记。**口径收口**:README Status / Install / 能力包段随本行翻转为 0.6.0 已发布(沿 #99 先例)。依据 [#139](https://github.com/0xnicholas/oribos-framework/issues/139) 决议评论。

- **修订(信号源建设期成文,2026-10-11)**:新增上「下一阶段(信号源建设期)」段——**0.7 不存在**的裁决如实记入(三路候选池全空:mastra 侧 [#145](https://github.com/0xnicholas/oribos-framework/issues/145) / 内部侧 [#146](https://github.com/0xnicholas/oribos-framework/issues/146) / owner 无输入;[#147](https://github.com/0xnicholas/oribos-framework/issues/147)),版本号不预占、1.0 门槛沿既有口径;本期主题 = 采用与上手面建设,**功能面一行不动、不 reopen 延后清单任何行**。纪律增补:上「完善阶段」判定口径行增补**信号源条款**(禁跟单与需求侧重开条件原样不动;明文「无用户期纪律悬空」判读 + 轴级公开痛点证据为定位/市场面工作的合法输入、不构成延后行晋升理由;ADR-0016)。定位句两层改写:本文件开头定位句按两层结构重写(公开叙事 = 品类语言 + 能力广度 + 零依赖事实担纲,oribos-website commit `788a563` 为正典;「轻量」退为内部轴名)——**框架 README 与 oribos-docs 的 ultralight 旧口径失同步,在此记账;同步动作归实施 effort,不进本票**。「完善阶段」段随 0.6.0 发布收口,标题由「下一阶段(完善)」改记为「完善阶段(0.6,已收口)」。依据 [Wayfinder 地图:定位裁决](https://github.com/0xnicholas/oribos-framework/issues/149) 处置票 [#152](https://github.com/0xnicholas/oribos-framework/issues/152)。

- **修订(信号源建设期实施开图 + 公开叙事同步,2026-10-11)**:本期实施地图 [Wayfinder 地图:信号源建设期实施](https://github.com/0xnicholas/oribos-framework/issues/153)(#153)开图——沿两段式先例第二段(实施),到达判据 = 公开面 ultralight 旧口径清零 + 发现面与正典同调 + [#84](https://github.com/0xnicholas/oribos-framework/issues/84) 触发评估落定;子票 [#154](https://github.com/0xnicholas/oribos-framework/issues/154) / [#155](https://github.com/0xnicholas/oribos-framework/issues/155) / [#156](https://github.com/0xnicholas/oribos-framework/issues/156)。**#154 交付**——公开叙事同步:根 README(tagline 按两层结构重写 = 品类语言 + 能力广度枚举 + 零依赖事实担纲、Why Oribos 轴句删、Development 行去身份词)、`packages/core` README(tagline 重写 + 五包「## Lightweight」节改「## Install only what you use」,零依赖硬闸门 / 字节预算内部回归参考 / peer 单例等机制事实保留)、十 example README boilerplate 统一改写、`packages/core/package.json` description 去 ultralight(保持 `Oribos ` 开头,沿发布后核对单口径;随下次发布生效,线上 0.6.0 元数据不可原地改沿既有口径);正典 = oribos-website commit `788a563`;「轻量」退为内部轴名——CONTEXT 词条 / `docs/architecture/**` / ADR 内部文档原样不动,测试桩台词(非公开面)不动。纯文档票 `src` 零改动,`pnpm verify` 全绿(**947 例 / 72 文件**,与基线同数),`check:examples` 4 案通过。依据 [#154](https://github.com/0xnicholas/oribos-framework/issues/154) 决议评论。

- **修订(发现面同步,2026-10-11)**:[#155](https://github.com/0xnicholas/oribos-framework/issues/155) 交付——GitHub 仓面 description 按正典重写(品类语言 + 能力广度枚举 + 零依赖事实担纲;旧 ultralight 口径退役)+ topics 补足 8 枚(`ai-agents` / `llm` / `typescript` / `agent-framework` / `ai-sdk` / `mcp` / `workflows` / `durable-execution`;homepage 留空待域名根裁决,地图 #153 Fog);七包 `package.json` 补 `keywords`(npm 搜索发现面,贴品类与能力、不点名竞品、不写数字;随下次发布生效,线上 0.6.0 元数据不可原地改沿既有口径)。manifest-only + 仓面元数据,`src` 零改动,`pnpm verify` 全绿(**947 例 / 72 文件**)。依据 [#155](https://github.com/0xnicholas/oribos-framework/issues/155) 决议评论。

- **修订(#84 触发评估 + skills 包首发,2026-10-11)**:[#156](https://github.com/0xnicholas/oribos-framework/issues/156) 裁定——**skills 包本期动手**(采用与上手面正属目的地、无外部前置、内容源已就位);**npm 内嵌文档维持等待**(manifest 契约已产出但离线消费诉求零信号、发布管线成本真实,触发保持 #84 口径);**`.well-known` 维持不发布**(草案未进 agentskills 主规范,skills 包发出后文档站侧动作归 oribos-docs 动线)。[#157](https://github.com/0xnicholas/oribos-framework/issues/157) 交付——`skills/oribos/SKILL.md` 首发(import map + 最小配方 + 防臆造清单,内容提炼自正典文档、指路 docs.oribos.dev / CONTEXT / `docs/architecture/` / `examples/`,数字不对外、不点名竞品)+ `skills/README.md` 消费说明 + 根 README 指路行;与代码同仓随版本 tag 发布,npm tarball 不含(七包 `files` 面不动,字节/依赖预算无涉);不加 CI 闸门(文档面先例,漂移风险由指路正典吸收)。纯文档票 `src` 零改动,`pnpm verify` 全绿(**947 例 / 72 文件**)。依据 [#156](https://github.com/0xnicholas/oribos-framework/issues/156) / [#157](https://github.com/0xnicholas/oribos-framework/issues/157) 决议评论。

- **修订(定位硬转:转向追赶 mastra,2026-10-11)**:owner 行使决定权硬转(ADR-0016 自写重开条件**未满足**,非条件翻案;反方证据 #150 已呈并听完)——决策票 [#158](https://github.com/0xnicholas/oribos-framework/issues/158),**ADR-0017 取代 ADR-0016**(旧文不删不改,dated records)。**红线分叉点裁决 = 保轴**:轻量轴两层含义(按需组合 + 无运行时负担)原样保留,追赶面 = 与两含义兼容的 mastra 功能面子集(挡路的是「无运行时负担」而非零依赖闸门——能力包携外部依赖有 MCP/OTel 先例;OM 类常驻管线、voice、重型集成仍不可直行);废/改轴被否(= 品牌与产品实质更换,买到的恰是采用证据最薄的行、交出唯一有近义痛点证据的差异轴)。**被否三件处置**:ADR-0001 / ADR-0015 保留原样(CI 机器零改动,新功能行走既有闸门),ADR-0012 本体保留、演化门触发条款改受新纪律(supervisor 行进入首批重估,落点仍能力包优先)。**禁跟单纪律改写**:「mastra 已采用且未弃的功能面 = 需求证据(二手需求)」触发**重估**而非自动晋升;已弃方向(`.network()`)与纯营销动作不构成证据。**翻案程序**:延后清单 20 行需求侧重开条件全部作废按追赶面重估、出域档 7 行自动解封(重开条件 = 定位裁决改变,已满足;解封 = 进入重估非晋升)、110 行有意分叉逐行三态重判(维持 / 转追赶项 / 维持但理由改写)——执行归规划型地图,首批从与现有承载缝最近的行起步;实施沿两段式先例另开地图,`pnpm verify` 全绿是硬门。**目的重定义** = 追赶采用(检验:追赶面交付后采用曲线无实质起色,或 mastra 重大形态变化,本裁决可再翻案)。文档处置:上「下一阶段(信号源建设期)」段改题「信号源建设期(2026-10-11 即日终结)」收口、本期产出不撤销;本文件开头定位句补转向注记;下「延后清单」头注重开条件作废记账;`CONTEXT.md`「信号源建设期 / 重开条件 / 轻量」三条注记终态;叙事层(README / topics / skills / 仓 description)翻转**最后动**、归后续叙事票——公开记录第三次定位摆动,翻转文案须写明理由。纯文档票 src 零改动,`pnpm verify` 全绿(947 例 / 72 文件,与基线同数)。依据 [#158](https://github.com/0xnicholas/oribos-framework/issues/158) 决议评论。

- **修订(追赶面重判首批落记录面,2026-10-11)**:出域档 7 行([#160](https://github.com/0xnicholas/oribos-framework/issues/160))与延后档 13 行([#161](https://github.com/0xnicholas/oribos-framework/issues/161))逐行重判落锤、110 行(更正为 94/77 口径)重判程序与 6 批清单落定([#162](https://github.com/0xnicholas/oribos-framework/issues/162))——三份决议按单一写者机制经成文票 [#163](https://github.com/0xnicholas/oribos-framework/issues/163) 落记录面:**上「追赶面」段新增**(判定口径两道门 + 轴级判词 + 13 行转追赶项清单带承载缝 / 验证面形状 / 距离三层 + 77 行余量与批次程序;实施沿两段式先例另开实施地图,不进本图);**延后清单 20 行逐行改记**(「重开条件」列按作废口径改记为「判定」列:13 转追赶项 / 7 维持分叉但理由改写,dated records);**规范表行改记随各判定票**(CUT-AG1 / AG2 / AG3、CUT-MEM1 / MEM2、CUT-OBS2、CUT-H1–H5 / H7、CUT-ST3、CUT-W7 / W9、CUT-M3、model.md 篇级字符串路由行、agent.md 演化门行;七篇规范表判定口径行统一增「转追赶项 / 维持分叉但理由改写」两值);**行数口径更正落记录面**(110 → 94/77:全量 94 行、17 行已裁、待判 77;上「完善阶段」落点行就地注记更正,`completeness-audit.md` 砍单复核计数 61 → 60 / 仍是砍单 59 → 58);**ADR-0017 修订记补轴级判词一行**(opt-in、不配置即零成本、不接管宿主的进程内后台工作 ≠ 运行时负担);「本图不覆盖」出域项行随重判更新(OM 类后台压缩与 signal providers 移出,转追赶项)。纯文档票 `src` 零改动,`pnpm verify` 全绿。依据 [#160](https://github.com/0xnicholas/oribos-framework/issues/160) / [#161](https://github.com/0xnicholas/oribos-framework/issues/161) / [#162](https://github.com/0xnicholas/oribos-framework/issues/162) 决议评论;成文 [#163](https://github.com/0xnicholas/oribos-framework/issues/163)。

- **修订(追赶面重判批 1–6 写回 + 重判程序收口,2026-10-12)**:[#163](https://github.com/0xnicholas/oribos-framework/issues/163) 评论排队的批 1–6 写回点([#164](https://github.com/0xnicholas/oribos-framework/issues/164)–[#169](https://github.com/0xnicholas/oribos-framework/issues/169) 决议)经任务票 [#170](https://github.com/0xnicholas/oribos-framework/issues/170) 一次性落记录面——**规范表行改记**:`agent.md` A2 转追赶项 / CUT-AG4 理由改写指针化(已落三件 vs 已裁三件分列);`model.md` A4 转追赶项 / CUT-M2 理由改写(networkRoute 前提失据 + workflowRoute 无需求信号);`harness.md` D5 理由改写指针化(承载缝改指跨实例 signals 追赶项能力包);`workflows.md` B5 / B7 / B8 尾注互注 #161 time-travel 转项、CUT-W4 尾注互注「run 内黑板 ≠ thread 状态域」、B16「验证面欠账 → P-1」改记已兑现(P-1 随 #130 落地);`memory.md` 裁单行两处旧口径措辞改记(listMessagesById / listMessagesByResourceId 转项 pointer)、C2·CUT-MEM4 尾注互注 #161 CUT-MEM1;`observability.md` CUT-OBS7 尾注互注 #166 A4;`docs/research/mastra-gap-analysis.md` §4.2 / §4.3 互注指向 ADR-0017 修订记。**上「追赶面」段落净终态**:转追赶项 13 → **15 行**(+A2 / A4,首批候选集随补)、待判余量 77 → **0 行**(77 行程序对象判毕)、批次进度记**批 6/6 收口、重判程序完成**;各批均记计数无更正、ADR-0017 修订记无需新增。纯文档票 `src` 零改动,`pnpm verify` 全绿(947 例 / 72 文件,与基线同数)。依据 [#164](https://github.com/0xnicholas/oribos-framework/issues/164)–[#169](https://github.com/0xnicholas/oribos-framework/issues/169) 决议与 [#163](https://github.com/0xnicholas/oribos-framework/issues/163) 移交评论;写回 [#170](https://github.com/0xnicholas/oribos-framework/issues/170)。

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

以下能力经路线图裁决**延后或出域**。「重开条件」的单一真相源地位已随 ADR-0017 终结(见下修订记);本清单现为 **2026-10-11 重判结论的记录面**:逐行三态判定 + 理由 gist,完整理由的单一真相源仍在 `docs/architecture/*.md` 各篇「砍单与承载缝」表行。缺口与差异的完整对账见 `docs/research/mastra-gap-analysis.md`(对比视图)。M5 能力包(OTLP exporter / MCP server + client / SQLite adapter / AI SDK 互操作)已在路线图内,不属本清单。

> 修订(2026-09-30,对比 ticket [#63](https://github.com/0xnicholas/oribos-framework/issues/63)):清单升级为四列表,重开条件统一为可观察、可累计的判定信号。

> 修订(2026-10-02,判定票 [#106](https://github.com/0xnicholas/oribos-framework/issues/106)):能力项 20 行(延后档 13 + 出域档 7)逐条判定为**有意分叉**——全部**原地留**、重开条件不变;新增「承接」列指到规范表行(判定与理由的单一真相源在 `docs/architecture/*.md` 的「砍单与承载缝」表,本清单不复制理由)。

> 修订(2026-10-11,决策票 [#158](https://github.com/0xnicholas/oribos-framework/issues/158) / ADR-0017):定位硬转——**本清单 20 能力行的需求侧重开条件全部作废**,「重开条件」的单一真相源地位随 ADR-0017 终结;新纪律 = 「mastra 已采用且未弃的功能面 = 需求证据(二手需求)」,触发**重估**而非自动晋升(轴兼容 + 承载缝逐行判定,程序见 ADR-0017「翻案程序」)。**出域档 7 行随裁决自动解封**(其重开条件 = 定位裁决改变,已满足;解封 = 进入重估,不是晋升)。重判执行归追赶面规划地图;行内容在重判落锤前原样保留(dated records)。

> 修订(2026-10-11,判定票 [#160](https://github.com/0xnicholas/oribos-framework/issues/160) / [#161](https://github.com/0xnicholas/oribos-framework/issues/161),程序见上「追赶面」段):20 行逐行重判落锤——**13 行转追赶项**(延后档 11 + 出域档 2,清单与距离分层见上「追赶面」段)、**7 行维持分叉但理由改写**(延后档 2 + 出域档 5);下两表「重开条件」列按作废口径改记为**判定**列(dated records,原条件文本见 git 历史与票链);行与「承接」列保留。

### 延后档(13 行已重判:11 转追赶项 / 2 维持分叉)

| 缺口 | 判定(2026-10-11 重判) | 承载缝 | 承接(规范表行) |
| --- | --- | --- | --- |
| Supervisor 能力包(createSupervisor 类) | **转追赶项**——证据 = `agents:` 字段 + delegation 钩子实装未弃,官方迁移文档确认 supervisor 方向;纯公开表面组合、零负担;**首批候选** | 能力包(as-tool 公开表面,零新缝);演化门落点纪律不变(ADR-0012) | `agent.md`「多 agent 组合」演化门行(ADR-0012) |
| RAG / 语义召回 | **转追赶项**——semantic recall 实装未弃(1.0 起默认关 ≠ 已弃)+ 17+ 向量适配器;knowledge v2 仅 alpha 线、记观察项;中层 | 能力包(落库 hook 索引 + recall 语义增强;向量库依赖随包) | `memory.md`(CUT-MEM1) |
| 外部记忆引擎桥接(bunfold 类) | **维持分叉、理由改写**——mastra 无外部桥实装,新纪律下证据不成立;轴冲突依旧(外部常驻服务 + 后台 LLM 管线 + 数据落盘);bunfold 调研证实服务器优先、不可嵌入;与 OM 行互注(共享 CUT-MEM2 缝,独立判定) | —(宿主侧自组装或上游零代码路径) | `memory.md`(CUT-MEM2) |
| Evals / scorers | **转追赶项**——scorers 挂 Agent 配置 + 独立评估包,实装未弃;零负担;**首批候选** | 独立 scorer 能力包 + Processor 接线 | `agent.md`(CUT-AG1) |
| 字符串路由(models.dev 类) | **转追赶项**——211-provider 注册表 + 网关链 + `ModelSelectionProcessor`,活跃维护;中层 | 能力包(目录 + 解析映射;核心无注册表 / magic string 钉子不动) | `model.md` 砍单与承载缝(篇级) |
| OTel bridge 能力包 | **转追赶项**——mastra 观测 OTel 生态向 + 1.71 能力协商;范围 = 宿主 OTel SDK 原生互操作;metrics / logs 维持砍单;中层 | 能力包(复用 `@oribos/otlp` semconv 映射) | `observability.md`(CUT-OBS2) |
| Background tasks | **转追赶项(分两期)**——manager + 持久化租约(1.72)+ 心跳 + `untilIdle` + `adopt()`,实装未弃;一期配方零负担(**首批候选**)、二期包 opt-in 不接管宿主(远) | 一期 = 配方 + example(「工具 ack + sendSignal 唤醒」);二期 = manager/lease 能力包 | `harness.md`(CUT-H5) |
| Goals / State signals | **维持分叉、理由改写**——证据成立(judge + 预算 + thread state 持久化,Beta 未弃),但前置 thread 状态域未建且未进任何清单(转项先立新核心域,超出本行判定面;登记地图 Fog,唯一真前置) | —(thread 状态域立不立为前置) | `harness.md`(CUT-H2 / H6) |
| 跨实例 signals | **转追赶项**——Redis Streams PubSub + LeaseProvider + `PubSub.trimTopic()`(1.72),实装未弃;opt-in 包 + 外部 Redis,不装不配零成本,核心单进程语义不变;远 | 能力包(共享 PubSub + 租约抽象 + Redis 适配) | `harness.md`「Signals(基础层)」运行时段 |
| resumable stream | **转追赶项**——事件缓存(内存默认 / 生产 Redis)+ `observe(runId)` + `closeOnSuspend`(1.70),实装未弃;内存默认零负担、Redis opt-in;中层 | 能力包(事件缓存 + observe) | `harness.md`(CUT-H1)· `model.md`(CUT-M3) |
| 外部 runner 适配 | **转追赶项**——Inngest / Temporal 引擎实装未弃;外部平台 = opt-in 基础设施;远 | 能力包(引擎接缝已留) | `workflows.md`(CUT-W9) |
| 每步检查点 + 崩溃重放 | **转追赶项**——`recovery: 'auto'` + boot 时 `recoverAllDurableAgents()` 实装未弃;boot 恢复 = 用户调用的函数、非常驻循环;中层 | 能力包 / 部署方(ADR-0011 已裁) | `harness.md`(CUT-H1) |
| time-travel / restart | **转追赶项**——快照 + `serializedStepGraph` 免费变种实装未弃;追赶形状 = 扁平 `position` + `stepResults` 等价物;既有「非薄变种」表述是设计点非障碍;**首批候选** | load→重进原语薄变种(先截断该位之后的记录,无 port 变更) | `workflows.md`(CUT-W7) |

### 出域档(7 行已重判:2 转追赶项 / 5 维持出域)

| 缺口 | 判定(2026-10-11 重判) | 承载缝 | 承接(规范表行) |
| --- | --- | --- | --- |
| Studio / editor / stored agents | **维持出域、理由改写**——证据成立(mastra Editor = agent 的 CMS,DB/code 双轨 + draft/published;Studio 云化持续活跃),但 = 托管产品 / 协作面,撞「嵌入宿主而不接管」;stored agents 无需框架能力(agent 配置 = 普通对象,无缝可承),不拆行 | — | `agent.md` 裁单表(CUT-AG3) |
| channels / voice / workspaces & sandboxes / browser | **维持出域、理由改写**——证据成立(渠道解析器 1.72 起运行时热更新),但产品 / 生态面;voice 附装率 1.5%(全清单最薄)且与「无运行时负担」直接冲突 | 生态 | `agent.md`(CUT-AG2) |
| 托管平台 | **维持出域**——商业决策,不在技术判定面 | — | —(商业决策,无技术承载缝可落) |
| OM 类后台压缩 | **转追赶项**——轴级判词:opt-in 进程内后台工作 ≠ 运行时负担(ADR-0017 修订记);mastra OM = Observer/Reflector 进程内 opt-in 库形态,实装存在且未弃;**距离最远**(新缝 + 存储扩展),不进首批 | 能力包(Observer/Reflector 式,消费 memory 落库 hook——核心新缝须过演化门) | `memory.md`(CUT-MEM2) |
| notification inbox | **维持出域、理由改写**——收件箱 schema 是应用域,框架化只能给最小公倍 CRUD、宿主自有 DB 即可,框架不提供增量价值;即时注入 `sendSignal({ type: 'notification' })` 已覆盖主路径;mastra 侧仅 3/31 adapter 支持,采纳亦薄 | 应用层 | `harness.md`(CUT-H3)· `storage.md`(CUT-ST3) |
| signal providers(webhook / poll 入口) | **转追赶项(示例形态)**——原承载缝即示例模式,缺口只是「没人写出来」;薄 HTTP 端点 → `sendSignal`,零新缝零依赖;**距离最近**,首批候选 | `examples/` webhook 入口例 + 配方;验证面 = `check:examples` 闸门 | `harness.md`(CUT-H4) |
| AgentController / session | **维持出域、理由改写**——证据成立(modes / permissions / channels / workspace 成品运行时 + `createCodingAgent()` + mastracode),但 = 交互式编码 agent 产品面的成品运行时,接管宿主交互循环;三件套 + signals 已支撑宿主自组装,「应用层自组装」语义仍更优 | 应用层自组装 | `harness.md`(CUT-H7) |

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
- **出域项(2026-10-11 重判后口径)**:Workspaces/Sandboxes、Channels、Voice、Studio、托管平台、notification inbox、AgentController(经 [#160](https://github.com/0xnicholas/oribos-framework/issues/160) 重判维持出域;OM 类后台压缩与 signal providers 已转追赶项,见上「追赶面」段)。
