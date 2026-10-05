# 存储适配策略

> 来源:wayfinder ticket #15(决策:存储适配策略)。本文件是存储层的架构规范。
> 决策记录见 `docs/adr/0010-storage-port-strategy.md`;术语见 `CONTEXT.md`。

## 定位

存储层是子系统持久化需求的 **port 集合 + adapter 家族**,本身不是子系统:核心只定义 port 类型与内存默认实现,真实后端经能力包接入。**无 mastra 式分域 composite**——`MastraCompositeStore` 的存在前提是强制中央实例(所有子系统共享一个 storage 入口,「不同域放不同后端」才需要框架内路由);本框架组合根可选(ADR-0002),子系统各自接收 store 实例,分后端是用户侧自由,不构成框架概念。**观测无 storage port**:tracing 走 exporter 流式模型(ADR-0009),span 不落库。

## Port 清单(v1 四个,形状冻结)

- **`MemoryStore`**(6 必备 + 2 条件):定义见 `docs/architecture/memory.md`。
- **`WorkflowSnapshotStore`**(2 方法 + JSON-only):定义见 `docs/architecture/workflows.md`。
- **`AgentRunSnapshotStore`**(load/save + JSON-only;#18 新增):定义见 `docs/architecture/harness.md`。
- **`ScheduleStore`**(5 方法;#18 新增):定义见 `docs/architecture/harness.md`。

各 port 独立定义、独立演化;一个 adapter 包可实现任意子集(**统一 adapter 家族**)。port 类型由核心定义,adapter 包对核心仅 types 级依赖(同构于模型契约的反向)。

## 扩展面:可选方法 + 能力标志

基础 port 一个字不动。扩展能力以**可选方法**出现:存在性即能力声明,核心调用前检测,缺席按既定语义降级或显式报错(同构于 `MemoryStore` 条件 2)。

| 可选扩展 | 所属 port | 语义 | 缺席行为 |
| --- | --- | --- | --- |
| `compareAndSave(runId, snapshot, expected): Promise<boolean>` | WorkflowSnapshotStore | 跨进程 resume 去重 CAS:`expected` = 上次 load 的快照或 `null`(期望不存在),期望不匹配则不写、返回 `false` | 退回单进程语义(进程内锁已有);跨进程安全归部署方 |
| `deleteSnapshot(runId): Promise<void>` | WorkflowSnapshotStore | 保留期清理——终态快照非永久数据 | 快照按实现自身保留策略存活 |
| `listSnapshots(q?: { status?, limit?, before? }): Promise<WorkflowRunSnapshot[]>` | WorkflowSnapshotStore | 枚举:suspended 恢复列表、#18 的恢复扫描 | 无枚举能力 |
| `deleteSnapshot(runId): Promise<void>` | AgentRunSnapshotStore | 保留期清理——同 workflow 侧 | 快照按实现自身保留策略存活 |
| `listSuspended(q?: { limit?, before? }): Promise<AgentRunSnapshot[]>` | AgentRunSnapshotStore | 待审批 / 待恢复 run 枚举(最新挂起在前) | 无枚举能力 |

签名已在 M5 SQLite 参考 adapter 设计冻结中钉死(见下文该节;`listSnapshots` / `listSuspended` 各守其名——port 独立定义,不承诺跨 port 齐名),语义边界钉死:CAS = 期望匹配才写;JSON-only 约束不变,不引入版本计数字段。

## 连接生命周期

adapter 自拥连接生命周期:可选暴露 `init?()` / `close?()`;**核心永不隐式调用、不 hook 进程退出**(无运行时负担)。应用或组合根负责打开与关闭;内存实现无生命周期。

## 第一方 adapter 清单

- **内存实现**:核心自带,四个 port 各一;不接 storage 即纯内存(已钉于各子系统规范)。SQLite 侧也有一个完整实现的参照件(下节)。
- **SQLite 系参考 adapter** = `@oribos/sqlite`(能力包,恰好一个 durable 第一方):嵌入式文件库、零服务,覆盖最常见自托管形态,同时充当四个 port 的真实后端验证。驱动已冻 = `node:sqlite`,engines 基线 `>=22.13.0`(M5 设计冻结,见下节);build 时机归路线图(#16)。
- **其余后端(Postgres / Redis / Upstash / Mongo 等)不做第一方**,留社区。

### Adapter 作者指南(要点)

1. 实现任一 port 或任意子集;可选方法按需实现,存在性即声明,无需注册。完整参照件 = 下节 SQLite 参考 adapter。
2. port 类型从核心包引入(types-only,无运行时依赖)。
3. semver 承诺(下节)同样适用于第三方 adapter 面向的 port 形状。

## SQLite 参考 adapter(M5 设计冻结)

第一方 durable adapter = `@oribos/sqlite` 一包(目录与清单字段沿 ADR-0002 M5 修订记;对核心走 peer,零外部依赖)。本节是冻结态:实施图按此直落,表结构、编码、并发与迁移口径都不留实现期判断。

### 驱动与版本基线

- 驱动 = **`node:sqlite`**(Node 内置,0 依赖、0 安装体积):22.12 需 `--experimental-sqlite`,**22.13 起免 flag**(仍 experimental,25.7 起 RC;捆绑 SQLite 随 Node 走,adapter 不锁版本特性面)。libsql 排除:原生二进制(单平台 ≈12.8 MiB)、Turso 官方「本地 / 嵌入」推荐位已转向 `@tursodatabase/database`、本地并发写 Not supported(事实与来源见 `docs/research/sqlite-driver-landscape.md`)。
- **engines 基线自 `>=22.12.0` 抬至 `>=22.13.0`**(root `engines` / core 与能力包清单 / CI `node-version` 同步;ADR-0014 与 ADR-0002 M5 修订记):22.13 仍高于 `require(esm)` 下限,性质不变。
- edge 运行时(Bun / Deno / Workers 的 node:sqlite stub)不作承诺;需要 edge 的宿主自布线。

### 工厂面

```ts
const storage = createSqliteStorage({ path: 'oribos.db', busyTimeoutMs: 5_000 })

storage.memory              // MemoryStore(条件对已实现 → supportsWorkingMemory 为真)
storage.workflowSnapshots   // WorkflowSnapshotStore + compareAndSave / deleteSnapshot / listSnapshots
storage.agentRunSnapshots   // AgentRunSnapshotStore + deleteSnapshot / listSuspended
storage.schedules           // ScheduleStore
storage.init()               // 同步 void;幂等:打开 + pragma + 迁移
storage.close()             // 幂等;close 后再用任何 port 方法抛错
```

- `path` = 文件路径或 `':memory:'`,原样交给 `DatabaseSync`;**每实例一个连接**,不做池。
- 不暴露原始 `DatabaseSync`(裸 SQL 逃生口 = 宿主按同一 path 自开连接,WAL 下安全);导出类型 = 选项类型 + 返回类型(各扩展接口具名)。
- 未 `init()` 调用 port 方法 → 抛「call init() first」,不做隐式 DDL。

### 生命周期与并发口径

- `init()` 顺序:打开 → `journal_mode=WAL` / `synchronous=NORMAL` / `foreign_keys=ON` / busy timeout(构造选项 `timeout`,默认 5 000 ms,`busyTimeoutMs` 覆盖)→ 迁移 → `user_version`。文件库读回 `journal_mode` 非 `wal` 抛错(网络文件系统类);`:memory:` 读回 `memory` 放过。
- **同步 API 即原子面**:单次 port 调用天然原子;多语句单元(`saveMessages` 批量、迁移)走显式 `BEGIN IMMEDIATE` … `COMMIT`(出错 `ROLLBACK`);单语句(含 CAS 条件写)不额外包事务。
- **跨进程**:同文件 + WAL + busy timeout = 多进程可用(写者串行化、读者不阻塞);跨进程 resume 去重的正确性前提 = 调用方用 `compareAndSave`。不做 lease / 认领 / 重试层——`SQLITE_BUSY` 原样抛给调用方(重试策略属部署方);`:memory:` 每连接独立库,仅供测试与单进程。

### 迁移纪律

- forward-only、additive-only;包内有序数组 `{ version, up(db) }`,**不建迁移表**——`PRAGMA user_version` 即版本;迁移在事务内整体应用。
- 库的 `user_version` 高于本包已知版本 → 抛错(不支持降级);扩容只增表 / 列 / 索引,不改既有形状。

### 表结构(v1,六表)

编码规则:端口 `Date` → `INTEGER` Unix ms(`getTime()` 写、`new Date(ms)` 读);可选字段(`title?` / `metadata?` / `workingMemory?` / `timezone?`)缺席 = SQL NULL,读回**字段省略**;JSON 文本列一律 `JSON.stringify` 文本,**NULL(无值)与 `'null'`(存了 JSON `null`)严格区分**;`STRICT` 表,不加触发器 / 视图 / `AUTOINCREMENT`。

```sql
CREATE TABLE threads (
  id TEXT PRIMARY KEY, resource_id TEXT NOT NULL, title TEXT, metadata TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
CREATE INDEX threads_by_resource ON threads (resource_id, updated_at DESC, id DESC);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL) STRICT;
-- payload = ModelMessage 本体;信封(id / threadId / resourceId / createdAt)在列里
CREATE INDEX messages_by_thread ON messages (thread_id, created_at DESC, id DESC);

CREATE TABLE resources (
  id TEXT PRIMARY KEY, working_memory TEXT, metadata TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;

CREATE TABLE workflow_snapshots (
  run_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
-- payload = 整条 WorkflowRunSnapshot(含 runId);updated_at = 存储侧写入时刻(ms),仅服务
-- list 排序 / 游标与保留期清理,不参与 CAS,不进记录形状

CREATE TABLE agent_run_snapshots (
  run_id TEXT PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;

CREATE TABLE schedules (
  id TEXT PRIMARY KEY, next_fire_at INTEGER, enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  timezone TEXT, target TEXT NOT NULL, metadata TEXT) STRICT;
-- next_fire_at: NULL = 耗尽;target = ScheduleTarget JSON
CREATE INDEX schedules_by_next_fire ON schedules (next_fire_at, id);
```

- **须知的语义分歧**:内存参照对「给不存在的 thread 存消息」是接受的(Map 无所谓);FK 级联版抛约束错误。`messages` 是 `threads` 的子记录——框架写路径(`Memory.save` → `ensureThread` → `saveMessages`)永远先建 thread,直连 port 的调用方自负前置。
- 快照两表**不投影 `status` 列**:`listSnapshots({ status })` 用 `json_extract(payload, '$.status')` 过滤——规则是「记录能告诉你的不落列,记录告诉不了的(写入时刻)才落列」。

### 查询的 SQL 形状(总序与游标)

内存参照的总序即规范,SQL 只是它的翻译:

- `listThreads` / `listMessages`:游标行须存在且归属相符(`resource_id` / `thread_id`),否则抛错(同参照);谓词 = 行值比较 `(updated_at, id) < (?, ?)` / `(created_at, id) < (?, ?)`;`ORDER BY … DESC LIMIT ?`。`listMessages` 的 `limit` 永远锚最新端,`order: 'asc'` 只在 JS 里 `reverse()` 呈现。
- `schedules.list`:总序 = `nextFireAt ASC`、NULL 最后、`id ASC`——排序 `ORDER BY (next_fire_at IS NULL) ASC, next_fire_at ASC, id ASC`;游标谓词用哨兵 `COALESCE(next_fire_at, 9223372036854775807)` 做行值比较(内存参照 `?? Infinity` 的直译)。`listDue` = `WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ? ORDER BY next_fire_at ASC, id ASC`。
- 快照两表 list:`ORDER BY updated_at DESC, run_id DESC`(最新挂起在前);游标 = run id,`(updated_at, run_id) < (?, ?)` 续页。
- `limit` 非正整数、游标悬空,一律抛错——port 层判据,adapter 不放宽。

### 扩展实现(全做,签名冻结)

四个 port 的全部已声明扩展都实现;core 类型**零改动**,扩展接口由包自导出(鸭子类型检测维持不变):

```ts
// WorkflowSnapshotStore 扩展
compareAndSave(runId: string, snapshot: WorkflowRunSnapshot, expected: WorkflowRunSnapshot | null): Promise<boolean>
deleteSnapshot(runId: string): Promise<void>
listSnapshots(query?: { status?: WorkflowRunStatus; limit?: number; before?: string }): Promise<WorkflowRunSnapshot[]>

// AgentRunSnapshotStore 扩展
deleteSnapshot(runId: string): Promise<void>
listSuspended(query?: { limit?: number; before?: string }): Promise<AgentRunSnapshot[]>
```

- **CAS 实现**:条件单语句,原子,无需显式事务——`expected === null` → `INSERT … ON CONFLICT(run_id) DO NOTHING`;否则 `UPDATE … SET payload = ?, updated_at = ? WHERE run_id = ? AND payload = ?`;判 `changes() === 1`。比较串 = `save` 用的同一个序列化函数(即 `JSON.stringify`);**`expected` 必须取自本 adapter 的 `load`**(手搓同形对象键序不同即判 false)——写进包文档。不引入版本计数或哈希列(上表语义边界)。
- `compareAndSave` 失败 = 返回 `false` 且不写;`deleteSnapshot` = 单条 DELETE,缺席 no-op;`list*` 的排序 / 游标口径见上节。

## semver 承诺

port 是框架唯一面向「生态作者」的契约,稳定性与核心同步:**1.0 起 stable;演化纪律 additive-only**——新能力只以可选方法 + 能力标志增加,必需方法签名永不改;breaking 只在 major。0.x 阶段 minor 可破,changelog 明示。

## 砍单与承载缝

判定口径见 `docs/ROADMAP.md`「下一阶段(完善)」;`CUT-ST*` 行 = 审计 §2 砍单行集(`docs/research/completeness-audit.md`)。判定三值:有意分叉 / 已兑现(非差异) / 提升(→ 必须项表 ID)。

| 项 | 承载缝 | 判定 | 理由·ADR 指针 |
| --- | --- | --- | --- |
| **CUT-ST1** 分域 composite / 域路由 | 四子系统 config 各收 store 实例 | 有意分叉 | 一个 store 实例一个域;分后端是用户侧自由(ADR-0010) |
| **CUT-ST2** 观测存储域(span 落库) | exporter 流式模型;落库归用户侧 exporter / collector | 有意分叉 | span 出进程即观测模型(ADR-0009) |
| **CUT-ST3** harness 专属存储域(lease / notifications / thread-state) | `AgentRunSnapshotStore` / `ScheduleStore` 已落;lease / PubSub 归能力包,inbox 裁出 | 有意分叉 | 挂起快照与调度 = 两个最小 port(#18 已裁)(ADR-0011);`harness.md` CUT-H3 行互引 |
| **CUT-ST4** PG / Redis 等第一方 adapter | 统一 adapter 家族 + 作者指南(上文) | 有意分叉 | 第一方清单只收内存 + SQLite;后端生态归社区(ADR-0010);延后清单「适配器生态」 |
| **CUT-ST5** CAS 进基础 port | SQLite 已实现 `compareAndSave`;基础 port 只留 `load` / `save` | 有意分叉 | 可选扩展 + 能力标志;内存版不必假装支持(ADR-0010) |
| **CUT-ST6** 核心托管连接生命周期(进程 hook / settled 式) | adapter 自拥 `init?()` / `close?()`(`@oribos/sqlite` 已落),应用调用;组合根**不代管** | 有意分叉 | 核心永不隐式 init / close;生命周期归 adapter 与应用(ADR-0010 / 0002) |

## 与其它子系统的关系

- **Workflows(#11,已定)**:钉 `WorkflowSnapshotStore` 需求;CAS 与快照管理扩展承载其「跨进程 resume 去重」「保留期清理」缝。
- **Memory(#12,已定)**:钉 `MemoryStore` 需求(6+2);其条件 2 即能力标志模式的首个实例。
- **Observability(#14,已定)**:无 storage port;span 经 exporter 出进程。
- **Harness(#18,已定)**:`AgentRunSnapshotStore` 与 `ScheduleStore` 两个新 port 定义见 `docs/architecture/harness.md`,进统一 adapter 家族;lease / PubSub / notifications / thread-state 域不建。
- **组合根(ADR-0002)**:可选薄注入点;**不代管** adapter 的 `init`/`close`——核心永不隐式 init / close,生命周期归 adapter 与应用;子系统独立 `new` 仍是一等用法。

## 依赖预算

核心(含存储 port 与内存实现)运行时依赖硬线 = 0(数字按 ADR-0001 作内部 CI 回归参考)。SQLite 系参考 adapter 归能力包,依赖隔离在包边界。
