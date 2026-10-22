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

**#220 复核**(2026-10-22):`replayShape` 覆盖七种 kind(`then` / `foreach` / 两种 loop 为 `single`,`parallel` 为 `parallel`,`branch` 为 `branch`,`sleep` 为 `pass`),`replayEntry` 不再自带 switch——按 shape 查 walker 的 `REPLAY_BUILDERS` 表,新 shape 漏行即 typecheck 失败(一次性 probe:临时加第五种 shape 报 TS2741,随后移除)。测试补七种 kind 的 resume 矩阵(`workflows-entry-topology.test.ts`):已完成条目不重跑,tip 与记录重建一致,`branch` 无记录仍为 `{}`。

**#221 复核**(2026-10-22):`ownedArrays` 覆盖七种 kind——`parallel` → 自己的 steps 数组,`branch` → 每个 pair 再 branches 数组(嵌套的先于持有它的数组),`then` / `foreach` / `dowhile` / `dountil` / `sleep` → 无自有数组;`freezeEntry` 留在 commit 路径,只做「按这一列冻结,再冻结条目本体」。测试补七种 kind 的冻结面矩阵(`workflows-entry-topology.test.ts`,`satisfies` 表钉住漏格):每格断言条目本体冻结、声明的数组逐路径冻结、表里没声明的数组与作者交给 builder 的数组都保持可写;commit 幂等与「commit 后仍不可 push」的既有钉子留在 `workflows-surface.test.ts`。probe(逐条改坏 → 对应格变红 → 恢复):去掉 `branch` 的 pair 声明、去掉 `parallel` 的 steps 声明、拆掉 builder 的 parallel steps 复制、拆掉 branch 的 pair 复制。

**#222 复核**(2026-10-22):`iterationSiteKind` 覆盖七种 kind(`parallel` / `branch` / `foreach` 各对应自己,`dowhile` / `dountil` → `loop`,`then` / `sleep` → 空),`checkIterationSite` 只读这一列、不再有 `dowhile` / `dountil` 三元;`loopTiming` = `dowhile` `before` / `dountil` `after`、其余五 kind 空,`runLoop` 只读它,恢复迭代跳过 `dowhile` 预检查的行为不变(既有 #54 钉子)。测试补 `workflows-entry-topology.test.ts` 的两套表驱动矩阵:七种 kind 的挂起 site kind + 匹配 site 的 resume(`dowhile` / `dountil` 都读 `loop`,顶层 `then` 的挂起快照没有 site),以及每个 kind × 每一种「不是表里那一列」的 site kind 的不匹配失败(五种块 kind 三种错法,`then` / `sleep` 四种全错——表里给 leaf kind 填任何值都会有一格变红;报错点名 site kind 与条目 kind);两种 loop 用同一条件与输入,公共 `start()` 观察求值点位置——`dowhile` 先 `cond@0`(零迭代),`dountil` 先 `body@0` 再 `cond@1`。probe(逐条改坏 → 对应格变红 → 恢复):dowhile 的 `loopTiming` 改成 `after`;dountil 的 `iterationSiteKind` 改成 `parallel`(挂起格 + 该 site 的不匹配格变红);`then` 的 `iterationSiteKind` 改成 `foreach`(leaf 不适用格变红);关掉 `checkIterationSite` 的 kind 比较(23 个不匹配格全红)。

**#223 复核**(2026-10-22):公共答案函数与 inngest 迁移已随 #218 落地——`restartTargetAt` 从 `@oribos/core/workflows` 导出,入参 `{ id?, entries }`,commit 后的 workflow 与手搓定义同用,JSDoc 写明钳制 / 向后扫描 / `undefined` / 未知 kind 四条契约;`@oribos/inngest` 本地 `entryStepIds` 已删,`crashRestartOptions` 改调它并把 `undefined` 映射为 `{}`,依赖边仍只有 `@oribos/core` peer。边界矩阵逐项核对(空 entries、position 0 是 sleep、有 step 的条目、尾部 sleep、`position = entries.length`、重复 step id、branch 第二臂、parallel、两种 loop、未知 kind 抛错):每格都有直接或间接覆盖,其中三格原先只被间接覆盖,本轮补成直接钉子。`workflows-entry-topology.test.ts` 显式钉住「position 0 是 sleep 且后面有条目 → `undefined`」——答案只看位置本身及其之前的条目,同一列表位置推进一步才命中;inngest「崩溃窗口落在尾部 sleep」钉住回退到最近的 step 条目且已完成的 `first` 从记录回放(既有崩溃重试钉子只覆盖在途第二条目);inngest「窗口里没有拥有 step 的条目」钉住 `undefined → {}` 是整跑重启而不是失败(空目标不进 `report.failed`)。probe(逐条改坏 → 对应格变红 → 恢复):`restartTargetAt` 的扫描改成向前(`index += 1`)→ 位置读法两格 + 公共面兼容格变红;`crashRestartOptions` 恒返回 `{}` → 尾部 sleep 格与既有崩溃重试格变红;`crashRestartOptions` 在 `undefined` 时抛错 → 空目标格变红。`pnpm verify` 全绿。

(来源:架构 review 2026-10-22 候选 05;关联 ADR-0006 / 0010 / 0018;实施 #218)
