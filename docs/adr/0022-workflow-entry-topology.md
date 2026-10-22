# Workflow 条目拓扑:per-kind 事实单源 + 一个公共重入目标答案

2026-10-22 裁决(架构 review 候选 05;实施 #218)。在 workflow 条目模块建立按 kind 声明的 `EntryDescriptor` 表,作为 per-kind 静态事实的唯一真相源;执行分派仍留在 walker。公共面只开 `restartTargetAt` 一个答案函数,不导出条目代数。`@oribos/inngest` 的本地条目→step 副本删除。

## 背景

七种条目(`then` / `parallel` / `branch` / `foreach` / `dowhile` / `dountil` / `sleep`,ADR-0006 钉死)的 per-kind 知识散落在至少五处,各自持有 switch:

- `entry.ts` 的 `entryStepIds` 回答"条目拥有哪些 step";
- `walker.ts` 的 `resumeTargetStep` 回答"step 属于哪个条目"(`default: return undefined`,签名却不含 `undefined`);
- `walker.ts` 的 `replayEntry` 回答"如何从记录重建输出";
- `walker.ts` 的 `checkIterationSite` 用三元把 `dowhile` / `dountil` 映射成 `loop`;
- `walker.ts` 的 `runLoop` 直接 `entry.type === 'dowhile'` / `'dountil'` 决定前置 / 后置检查;
- `workflow.ts` 的 `freezeEntry` 回答"commit 冻结哪些数组"。

`@oribos/inngest` 为崩溃恢复又复制了一份 `entryStepIds`,并加了 `default: return []`。同一个未知 kind:核心的副本返回 `undefined`(与 `readonly string[]` 签名不符,下游在截断/回放时炸成 TypeError),inngest 的副本返回 `[]` 并让 `crashRestartOptions` 返回 `{}`——整条 workflow 从头静默重跑。两份复制连静默失败的方式都不一致,编译器不能强制任何一处处理新 kind。

`position` 则有三套读法:public `restart` 从 step id 找第一个包含它的条目;`@oribos/inngest` 从 `position` 向后扫描找 step id,再交回核心映射回下标;快照读者按 status 解释 `position`(suspended = 挂起条目,running = 下一个未执行条目,success = 条目数)。外部 runner 没有公共出口,只能复制核心的条目代数。

## 决定

1. **`EntryDescriptor` 表是 per-kind 静态事实的唯一真相源**,居 `packages/core/src/workflows/entry.ts`,以七种 kind 的封闭联合键控(`satisfies` 映射:新增第八种 kind 漏行 = 编译错误)。每行声明:拥有哪些 step、`replayShape`(`single` / `parallel` / `branch` / `pass`)、commit 冻结哪些数组(`ownedArrays`)、块内挂起携带哪种 `iterationSiteKind`(`dowhile` / `dountil` 都映射为 `loop`)、循环条件在体前还是体后(`loopTiming`)。
2. **`steps(entry)` 是唯一提取函数**:`entryStepIds` 与 `findStep` 由它派生,`resumeTargetStep` 删除。replay、截断、resume 校验、commit 冻结、restart 目标全部读同一份成员关系。
3. **执行分派留在 walker**:`runEntry` 仍是唯一的执行 switch,末端 `assertNever`;手搓 / cast 输入的未知 kind 运行时报错。descriptor 不读 walk state、不依赖 runner——它是数据表加提取函数,不是执行策略。`replayEntry` 按 `replayShape` 重建输出(继续用 `recordedOutput`),`freezeEntry` 按 `ownedArrays` 冻结,`checkIterationSite` 按 `iterationSiteKind` 比较,`runLoop` 按 `loopTiming` 决定条件检查位置。
4. **公共面只开一个答案函数**,从 `@oribos/core/workflows` 导出:

   ```ts
   restartTargetAt(
     workflow: { readonly id?: string; readonly entries: readonly WorkflowEntry[] },
     position: number,
   ): string | undefined
   ```

   - `position` 钳到 `[0, entries.length - 1]`;空条目列表返回 `undefined`。
   - 从钳制点向后扫描,返回第一个拥有 step 的条目的**首个** step id;`sleep` 拥有零 step,崩在 sleep 附近回到最近的有 step 条目。
   - `undefined` 表示没有可重入条目,调用方从头重启——不是失败。
   - 未知 kind 抛错,不再静默降级;错误点名 workflow id(调用方提供时)与未知 kind。
   - 不读 `snapshot.status`;status 语义留在调用方与 `docs/architecture/workflows.md` 的 position 读法。
   - 重复 step id:第一个包含它的条目获胜(public `restart` 的既有解析),重入宁可多执行,不会少执行。
   - 接受 commit 后的 workflow 与手搓定义;不新增类型导出,不导出 descriptor 代数。
5. **`@oribos/inngest` 删除本地 `entryStepIds`**:`crashRestartOptions` 改调 `restartTargetAt`,`undefined` 映射为 `{}`。未知 kind 在触碰任何记录之前抛错。快照格式、`position` 字段形状、public `restart` 的 step-id 入参都不变;七种条目保持封闭(ADR-0006),不新增依赖边。

## Considered Options

- **把整个条目代数(descriptor 表、`steps`、shape 类型)导出为公共面**:否决。外部消费者只需要"从 position 反查重入 step"这一个答案;导出代数等于把内部表结构冻结成契约,以后加字段都要走公共面审查。`restartTargetAt` 是答案,不是机制。
- **把执行也搬进 descriptor(每行带 executor)**:否决。descriptor 会依赖 walk state、runner、span 与事件 sink,条目模块变成第二个 walker;执行分派分散到七行后,`runEntry` 的单一可读入口消失。ADR-0006 的语义内核边界是 walker。
- **答案函数感知 `snapshot.status`**:否决。status 的读法属于调用方(同一 `position` 在 suspended / running / success 下含义不同),把 status 塞进签名会让函数承担快照解读;外部 runner 已经知道自己持有哪种快照。
- **答案函数返回条目下标而不是 step id**:否决。public `restart` 的入参是 step id,返回下标会迫使每个调用方再做一次映射;step id 是已经公开、已经稳定的地址。
- **保留 inngest 副本,补一份一致性契约测试**:否决。#193 / #206 已确立"单一真相源可行时不接受复制 + 一致性测试";契约测试只能覆盖测试里想到的 kind,漏掉未来第八种时仍会静默。
- **空条目 / 无目标时抛错**:否决。没有可重入条目是合法状态(空定义、全 sleep 尾窗),调用方的正确答案是从头重启;把它当失败会制造无谓的运维分支。
- **非整数 / NaN position 抛错**:首版不做。钳制已覆盖越界与 success 的 `entries.length`;损坏快照的其余字段属于 store 与调用方的校验面,答案函数保持最小。

## Consequences

- 新增第八种 kind 的固定动作:表加一行(`satisfies` 强制)、`runEntry` 加一个 case(`assertNever` 强制)、类型测试与矩阵测试各一格。per-kind 知识不再散落五处。
- 未知 kind 在核心的截断 / replay / resume / restart / inngest 恢复路径上统一显式失败;不再出现"签名说数组、运行时是 undefined"或"静默从头重跑"。
- `restartTargetAt` 成为外部 durable runner 的公共出口;`@oribos/inngest` 是第一个消费者,包边界不变(仍以 peer core 依赖)。
- 快照五字段 + 可选 `traceId` / `iterationSite` 不变,既有快照继续有效;`restart` 的公开签名与语义不变。
- 核心 workflows 子路径字节预算随表与函数增加,由 `byte-budget:update` 吸收;`check:export-surface` 需要 `restartTargetAt` 的公共 JSDoc(已随实现落地)。
- `docs/architecture/workflows.md` 增「条目拓扑与重入目标」节;`CONTEXT.md` 的「条目拓扑」「重入目标」词条点名该公共函数。
- 复核条件:出现第二个需要条目代数的消费者(要求更多问题,而非"从 position 找 step")、或快照 status 语义变化导致调用方无法自持解读时,重开本裁决。

## 实施状态

**已实施**(2026-10-22,#218)。`EntryDescriptor` 表居 `packages/core/src/workflows/entry.ts`;`entryStepIds` / `findStep` 由 `steps` 派生,`resumeTargetStep` 删除;`replayEntry` / `freezeEntry` / `checkIterationSite` / `runLoop` 改读 descriptor 事实;`runEntry` 以 `assertNever` 收口。`restartTargetAt` 从 `@oribos/core/workflows` 导出,`@oribos/inngest` 删除本地 `entryStepIds` 并改调它。测试面:七种 kind 的矩阵(`packages/core/test/workflows-entry-topology.test.ts`,`satisfies` 表钉住漏格)、位置钳制 / 向后扫描 / 空目标 / 未知 kind、inngest 崩溃恢复不得静默重跑已完成条目(`packages/inngest/test/inngest.test.ts`)。快照与公开 `restart` 签名未变;`pnpm verify` 全绿。

**#219 复核**(2026-10-22):未知 kind 在公共 `restart` 与 `restartTargetAt` 边界以命名错误失败,错误点名 workflow id 与未知 kind;一次性编译期 probe(临时加第八变体)确认表缺行即 typecheck 失败,随后移除。

(来源:架构 review 2026-10-22 候选 05;关联 ADR-0006 / 0010 / 0018;实施 #218)
