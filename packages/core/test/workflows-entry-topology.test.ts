import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createInMemorySnapshotStore,
  createStep,
  createWorkflow,
  createWorkflowRun,
  restartTargetAt,
} from '@oribos/core/workflows';
import type {
  DountilEntry,
  DowhileEntry,
  WorkflowEntry,
  WorkflowIterationSite,
  WorkflowSnapshotStore,
} from '@oribos/core/workflows';
import { captureRejection, expectSuccess, expectSuspended } from './helpers/assertions.js';

/**
 * 条目拓扑(#218,`CONTEXT.md`「条目拓扑」/「重入目标」):per-kind 静态事实的唯一真相源是
 * `entry.ts` 的 descriptor 表,公共面只开 `restartTargetAt` 一个答案函数。接缝 =
 * `@oribos/core/workflows` 公共面。
 *
 * 矩阵列与实际覆盖(测试不 import descriptor,每个事实走公共行为):
 * - step 归属 / stepIds / findStep 命中与 miss → 本文件两套表驱动测试;
 * - replayShape → 本文件的七种 kind resume 矩阵(#220:已完成条目不重跑,tip 由记录重建);
 * - iterationSiteKind → 本文件的七种 kind 挂起 / 不匹配矩阵(#222;逐块叙事仍在
 *   `workflows-suspend-resume.test.ts`);
 * - loopTiming → 本文件的两格循环时机矩阵(#222:dowhile 体前 / dountil 体后;逐循环叙事仍在
 *   `workflows-loop-wait.test.ts`);
 * - ownedArrays / freeze → 本文件的七种 kind 冻结面矩阵(#221)。
 */

const anySchema = z.unknown();

/** 一个不执行任何东西的 step,只提供 id 与 IO 形状。 */
function stepFor(id: string) {
  return createStep({
    id,
    inputSchema: anySchema,
    outputSchema: anySchema,
    execute: () => undefined,
  });
}

/**
 * 一次挂起的观察点(多个矩阵共用):首跑 suspend,resume 收到 resumeData 后放行——公共
 * `resume` 的既有约定。`onExecute` 让需要它的矩阵记下每次拿到的输入(replay 矩阵用)。
 */
function gateStep(id: string, onExecute?: (inputData: unknown) => void) {
  return createStep({
    id,
    inputSchema: anySchema,
    outputSchema: anySchema,
    resumeSchema: z.object({ approved: z.boolean() }),
    execute: (ctx) => {
      onExecute?.(ctx.inputData);
      if (ctx.resumeData === undefined) ctx.suspend({ question: `${id}?` });
      return { approved: ctx.resumeData?.approved };
    },
  });
}

/**
 * 七种条目的矩阵正本:`satisfies` 让"新增第八种 kind 却漏了格子"成为编译错误。
 * `stepIds` 是条目拥有的全部 id 字面量(独立于实现),`input` 让该条目在 public restart 的
 * 测试里能跑成 success。
 */
const ENTRY_CASES = {
  then: {
    entry: { type: 'then', step: stepFor('then-step') },
    stepIds: ['then-step'],
    input: undefined,
  },
  parallel: {
    entry: { type: 'parallel', steps: [stepFor('parallel-a'), stepFor('parallel-b')] },
    stepIds: ['parallel-a', 'parallel-b'],
    input: undefined,
  },
  branch: {
    entry: {
      type: 'branch',
      branches: [
        [() => true, stepFor('branch-a')],
        [() => false, stepFor('branch-b')],
      ],
    },
    stepIds: ['branch-a', 'branch-b'],
    input: undefined,
  },
  foreach: {
    entry: { type: 'foreach', step: stepFor('foreach-step'), concurrency: 1 },
    stepIds: ['foreach-step'],
    input: [0],
  },
  dowhile: {
    entry: { type: 'dowhile', step: stepFor('dowhile-step'), cond: () => false },
    stepIds: ['dowhile-step'],
    input: undefined,
  },
  dountil: {
    entry: { type: 'dountil', step: stepFor('dountil-step'), cond: () => true },
    stepIds: ['dountil-step'],
    input: undefined,
  },
  sleep: {
    entry: { type: 'sleep', duration: 0 },
    stepIds: [],
    input: undefined,
  },
} satisfies {
  readonly [TKind in WorkflowEntry['type']]: {
    readonly entry: Extract<WorkflowEntry, { readonly type: TKind }>;
    readonly stepIds: readonly string[];
    readonly input: unknown;
  };
};

/** 表正本 → `it.each` 的行;record 的 `satisfies` 已保证七种 kind 一格不缺。 */
const MATRIX = Object.entries(ENTRY_CASES);

describe('restartTargetAt:七种 kind 矩阵', () => {
  it.each(MATRIX)(
    '%s 条目在自身位置给出首个 step id;无 step 的 kind 给出 undefined',
    (_kind, testCase) => {
      expect(restartTargetAt({ entries: [testCase.entry] }, 0)).toBe(testCase.stepIds[0]);
    },
  );
});

describe('public restart:七种 kind 的成员关系矩阵', () => {
  it.each(MATRIX)(
    '%s:每个拥有的 step id 都命中该条目,未知 id 显式报错',
    async (kind, testCase) => {
      const run = createWorkflowRun({
        id: `matrix-${kind}`,
        inputSchema: anySchema,
        entries: [testCase.entry],
      });
      const started = await (await run.start({ inputData: testCase.input })).result;
      expect(started.status).toBe('success');

      // 命中:命中任一步 id(含 branch 第二臂 / parallel 第二臂)都重进该条目。
      for (const stepId of testCase.stepIds) {
        const restarted = await run.restart({ step: stepId });
        expect(restarted.status).toBe('success');
      }
      // sleep 没有 step:不点名 step 的 restart 从头重进。
      if (testCase.stepIds.length === 0) {
        const restarted = await run.restart();
        expect(restarted.status).toBe('success');
      }
      // miss:该条目不含此 id,显式报错(不静默从头重跑)。
      await expect(run.restart({ step: 'not-a-step' })).rejects.toThrow(
        /has no entry holding that step/,
      );
    },
  );
});

describe('restartTargetAt:位置读法与扫描', () => {
  it('position 钳到 [0, entries.length - 1]:越界读末尾条目,负数读首条目', () => {
    const entries: readonly WorkflowEntry[] = [
      ENTRY_CASES.then.entry,
      ENTRY_CASES.sleep.entry,
      ENTRY_CASES.parallel.entry,
    ];

    expect(restartTargetAt({ entries }, 0)).toBe('then-step');
    expect(restartTargetAt({ entries }, 2)).toBe('parallel-a');
    // success 快照的 position = 条目数(列表末尾):钳回最后一条目,不崩。
    expect(restartTargetAt({ entries }, entries.length)).toBe('parallel-a');
    expect(restartTargetAt({ entries }, 99)).toBe('parallel-a');
    expect(restartTargetAt({ entries }, -5)).toBe('then-step');
  });

  it('从位置向后扫描,跳过没有 step 的 sleep 条目', () => {
    const entries: readonly WorkflowEntry[] = [
      ENTRY_CASES.then.entry,
      ENTRY_CASES.sleep.entry,
      ENTRY_CASES.sleep.entry,
    ];

    // 崩在 sleep 附近:回答最近一个拥有 step 的条目,而不是「没有目标」。
    expect(restartTargetAt({ entries }, 1)).toBe('then-step');
    expect(restartTargetAt({ entries }, 2)).toBe('then-step');
  });

  it('position 0 是 sleep:向后没有条目,返回 undefined——扫描不越过钳制点向前看', () => {
    const entries: readonly WorkflowEntry[] = [ENTRY_CASES.sleep.entry, ENTRY_CASES.then.entry];

    // 崩在第一条目(sleep)上:窗口里没有拥有 step 的条目,调用方从头重启。
    expect(restartTargetAt({ entries }, 0)).toBeUndefined();
    // 同一列表,位置推进一步就命中:答案只看位置本身及其之前的条目。
    expect(restartTargetAt({ entries }, 1)).toBe('then-step');
  });

  it('空条目列表 / 全部条目都没有 step:返回 undefined(从头重启,不是失败)', () => {
    expect(restartTargetAt({ entries: [] }, 0)).toBeUndefined();
    expect(restartTargetAt({ entries: [] }, 7)).toBeUndefined();
    expect(
      restartTargetAt({ entries: [ENTRY_CASES.sleep.entry, ENTRY_CASES.sleep.entry] }, 1),
    ).toBeUndefined();
  });

  it('未知 kind 显式抛错,错误点名 workflow id 与未知 kind,不静默降级成「没有 step」', () => {
    const entries = [{ type: 'quantum' } as unknown as WorkflowEntry];

    expect(() => restartTargetAt({ id: 'forged-answer', entries }, 0)).toThrow(
      /workflow "forged-answer": unknown workflow entry type "quantum"/,
    );
    // 手搓定义没有 id:仍点名未知 kind,不硬造一个 workflow id。
    expect(() => restartTargetAt({ entries }, 0)).toThrow(
      /^unknown workflow entry type "quantum"$/,
    );
  });
});

describe('public restart:未知 kind 的命名错误', () => {
  /** 手搓定义:未知条目在列表头(成员查询先撞上)或列表尾(截断先撞上)。 */
  const FORGED_CASES = [
    { path: '截断', workflowId: 'forged-truncate', unknownFirst: false, byStep: false },
    { path: 'step 成员查询', workflowId: 'forged-lookup', unknownFirst: true, byStep: true },
  ] as const;

  it.each(FORGED_CASES)(
    '$path 路径以 workflow id + 未知 kind 失败,不静默跳过未知条目',
    async ({ workflowId, unknownFirst, byStep }) => {
      const first = stepFor('first');
      const base = createWorkflow({
        id: workflowId,
        inputSchema: anySchema,
        outputSchema: anySchema,
      })
        .then(first)
        .commit();
      // 手搓定义(cast 过类型):一个核心不认识的第八种条目。
      const known: WorkflowEntry = { type: 'then', step: first };
      const unknown = { type: 'quantum' } as unknown as WorkflowEntry;
      const entries: readonly WorkflowEntry[] = unknownFirst
        ? [unknown, known]
        : [known, unknown];
      const run = createWorkflowRun({ ...base, entries }, { runId: workflowId });

      // 首跑在未知条目上失败(执行分派已带 workflow id),留下 failed 快照。
      await expect((await run.start({ inputData: undefined })).result).rejects.toThrow(
        new RegExp(`workflow "${workflowId}": unknown workflow entry type "quantum"`),
      );

      // 公共 restart:成员查询 / 截断都必须命名失败,而不是跳过未知条目。
      await expect(byStep ? run.restart({ step: 'first' }) : run.restart()).rejects.toThrow(
        new RegExp(`workflow "${workflowId}": unknown workflow entry type "quantum"`),
      );
    },
  );
});

/**
 * commit 冻结面(候选 05 第三片,#221):表里「该 kind 拥有哪些数组」那一列是唯一声明——
 * `parallel` 的 steps 数组、`branch` 的 branches 数组与每个 pair,其余五种 kind 无自有数组;
 * `freezeEntry` 留在 commit 路径,只按这一列冻结,再冻结条目本体。接缝 = builder + `commit()`,
 * 测试不 import descriptor:每格用条目上的路径声明自己那一格的正本,`satisfies` 让第八种 kind
 * 漏格成为编译错误。「commit 幂等」与「commit 后仍不可 push」的既有钉子不重复落在这里,
 * 仍由 `workflows-surface.test.ts` 钉住(再次 commit 返回同一份冻结定义 / 算子调用报 committed)。
 */

interface FreezeCase {
  /** 经 builder + `commit()` 造出该 kind 的一个条目;顺带交出作者交给 builder 的数组。 */
  readonly commit: (workflowId: string) => {
    readonly entry: WorkflowEntry;
    /** 作者写进 builder 的数组:条目持有的是副本,commit 不得冻结它们。 */
    readonly authored: readonly (readonly unknown[])[];
  };
  /** 该 kind 拥有的数组:条目上的路径,嵌套的先于持有它的数组;无自有数组的 kind 为空。 */
  readonly ownedPaths: readonly string[];
}

/** 只声明 id 与 IO 形状的空 builder:每格从它起手,冻结只在 `commit()` 里发生。 */
function emptyBuilder(workflowId: string) {
  return createWorkflow({ id: workflowId, inputSchema: anySchema, outputSchema: anySchema });
}

/** 断言定义刚好一个条目并交回它——冻结面按 kind 一格一格看。 */
function onlyEntry(
  workflow: { readonly entries: readonly WorkflowEntry[] },
  kind: WorkflowEntry['type'],
): WorkflowEntry {
  expect(workflow.entries).toHaveLength(1);
  const [entry] = workflow.entries;
  if (entry?.type !== kind) throw new Error(`expected a ${kind} entry, got ${String(entry?.type)}`);
  return entry;
}

/** 按路径取条目上的数组(`steps` / `branches.0`):矩阵用同一条路径声明拥有的数组。 */
function arrayAt(entry: WorkflowEntry, path: string): readonly unknown[] {
  let value: unknown = entry;
  for (const key of path.split('.')) {
    value = (value as Record<string, unknown> | undefined)?.[key];
  }
  if (!Array.isArray(value)) throw new Error(`no array at "${path}"`);
  return value;
}

/**
 * 条目可达的数组:条目属性上的数组,加上这些数组元素里的数组(`branch` 的 pair)。
 * 冻结面只在条目这一层可达——表里没声明的数组不在这里,也就不该被冻。
 */
function arraysInEntry(entry: WorkflowEntry): readonly (readonly unknown[])[] {
  const found: (readonly unknown[])[] = [];
  const visit = (value: unknown): void => {
    if (!Array.isArray(value) || found.includes(value)) return;
    found.push(value);
    for (const item of value) visit(item);
  };
  for (const value of Object.values(entry)) visit(value);
  return found;
}

/**
 * 七种 kind 的冻结面正本:`satisfies` 让「新增第八种 kind 却漏了格子」成为编译错误。
 * 路径是测试自己的声明(条目没写 `step` 属性的 `sleep` 也算一格空),不从 descriptor 派生。
 * 这里不复用 `ENTRY_CASES`:那张表手搓条目,而冻结只发生在 builder + `commit()` 这条路上,
 * 且 `authored` 要留着作者交进来的数组身份。
 */
const FREEZE_CASES = {
  then: {
    commit: (workflowId) => ({
      entry: onlyEntry(emptyBuilder(workflowId).then(stepFor('then-step')).commit(), 'then'),
      authored: [],
    }),
    ownedPaths: [],
  },
  parallel: {
    commit: (workflowId) => {
      const authoredSteps = [stepFor('parallel-a'), stepFor('parallel-b')];
      return {
        entry: onlyEntry(emptyBuilder(workflowId).parallel(authoredSteps).commit(), 'parallel'),
        authored: [authoredSteps],
      };
    },
    ownedPaths: ['steps'],
  },
  branch: {
    commit: (workflowId) => {
      const authoredPairs = [
        [() => true, stepFor('branch-a')],
        [() => false, stepFor('branch-b')],
      ] as const;
      return {
        entry: onlyEntry(emptyBuilder(workflowId).branch(authoredPairs).commit(), 'branch'),
        authored: [authoredPairs, authoredPairs[0], authoredPairs[1]],
      };
    },
    ownedPaths: ['branches', 'branches.0', 'branches.1'],
  },
  foreach: {
    commit: (workflowId) => ({
      entry: onlyEntry(
        emptyBuilder(workflowId).foreach(stepFor('foreach-step')).commit(),
        'foreach',
      ),
      authored: [],
    }),
    ownedPaths: [],
  },
  dowhile: {
    commit: (workflowId) => ({
      entry: onlyEntry(
        emptyBuilder(workflowId).dowhile(stepFor('dowhile-step'), () => false).commit(),
        'dowhile',
      ),
      authored: [],
    }),
    ownedPaths: [],
  },
  dountil: {
    commit: (workflowId) => ({
      entry: onlyEntry(
        emptyBuilder(workflowId).dountil(stepFor('dountil-step'), () => true).commit(),
        'dountil',
      ),
      authored: [],
    }),
    ownedPaths: [],
  },
  sleep: {
    commit: (workflowId) => ({
      entry: onlyEntry(emptyBuilder(workflowId).sleep(0).commit(), 'sleep'),
      authored: [],
    }),
    ownedPaths: [],
  },
} satisfies { readonly [TKind in WorkflowEntry['type']]: FreezeCase };

/** 表正本 → `it.each` 的行;`satisfies` 已保证七种 kind 一格不缺。 */
const FREEZE_MATRIX = Object.entries(FREEZE_CASES);

describe('commit:七种 kind 的冻结面矩阵', () => {
  it.each(FREEZE_MATRIX)('%s:条目本体与该 kind 拥有的数组冻结,不多冻一格', (kind, testCase) => {
    const { entry, authored } = testCase.commit(`freeze-${kind}`);
    expect(entry.type).toBe(kind);
    expect(Object.isFrozen(entry)).toBe(true);

    const owned = testCase.ownedPaths.map((path) => arrayAt(entry, path));
    for (const array of owned) expect(Object.isFrozen(array)).toBe(true);

    // 「不多冻」的第一半:条目可达的数组集合与声明的冻结面相等——多声明的路径会在这里找不到
    // 数组,条目新增了却没声明的数组则让数量对不上。第二半是作者交来的数组(条目持有的是副本)
    // 也必须可写:builder 的复制边界一破,这一格就红。
    expect(arraysInEntry(entry)).toHaveLength(owned.length);
    for (const array of authored) expect(Object.isFrozen(array)).toBe(false);
  });
});

describe('restartTargetAt:公共面兼容', () => {
  it('同时接受 commit 后的 workflow 与手搓定义(createWorkflowRun 的公开入口)', () => {
    const workflow = createWorkflow({
      id: 'committed',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
    })
      .then(stepFor('committed-step'))
      .sleep(0)
      .commit();

    expect(restartTargetAt(workflow, 1)).toBe('committed-step');
  });

  it('重复 step id:public restart 按首个包含该 id 的条目重入(多执行,不跳过)', async () => {
    const executed: string[] = [];
    const duplicate = (tag: string) =>
      createStep({
        id: 'dup',
        inputSchema: z.object({ n: z.number() }),
        outputSchema: z.object({ n: z.number() }),
        execute: () => {
          executed.push(tag);
          return { n: 1 };
        },
      });
    const workflow = createWorkflow({
      id: 'duplicates',
      inputSchema: z.object({ n: z.number() }),
      outputSchema: z.object({ n: z.number() }),
      storage: createInMemorySnapshotStore(),
    })
      .then(duplicate('first-entry'))
      .then(duplicate('second-entry'))
      .commit();
    const run = workflow.createRun({ runId: 'r-dup' });

    await (await run.start({ inputData: { n: 0 } })).result;
    expect(executed).toEqual(['first-entry', 'second-entry']);

    // 快照崩在第二个条目:答案是重名 id,public restart 解析回第一个包含它的条目。
    const target = restartTargetAt(workflow, 1);
    expect(target).toBe('dup');
    if (target === undefined) throw new Error('expected a restart target');
    await run.restart({ step: target });

    expect(executed).toEqual([
      'first-entry',
      'second-entry',
      'first-entry',
      'second-entry',
    ]);
  });
});

/**
 * replay 形状(候选 05 第二片,#220):resume 从记录重建 tip,已完成的条目一条都不重跑。
 *
 * 每格是一条已完成条目放在挂起 step 之前:start 时它正常执行并写下记录;resume 时
 * `replayEntry` 按该 kind 的 replay 形状重建 tip,挂起 step 因此拿到的输入必须与首次执行一致
 * ——`then` / `foreach` / 两种 loop 取那一条记录,`parallel` 取 keyed 多记录,`branch` 取
 * 已执行臂(无记录 = `{}`),`sleep` 直通且无记录。执行日志在 resume 前后必须相同:
 * step、迭代、条件与时长解析都不得再发生。
 *
 * 块内挂起本身的 resume(iteration site 重进)仍由 `workflows-suspend-resume.test.ts` 钉住;
 * 本矩阵抠的是已完成条目的记录重建(快照 `position` 之前的部分)。
 */

/** 各格共用的运行输入:`foreach` 要数组,其余 kind 原样消费。 */
const replayInput = ['one', 'two'];

interface ReplayCase {
  /** 可选前缀条目:让 tip 区别于运行输入(否则「直通」与「错取输入」无法区分)。 */
  readonly preface?: readonly WorkflowEntry[];
  /** 挂在挂起 step 之前的已完成条目。 */
  readonly entry: WorkflowEntry;
  /** 该条目写下的记录(step id → 期望输出);`sleep` 与未命中任何臂的 `branch` 没有记录。 */
  readonly records: Readonly<Record<string, unknown>>;
  /** 由那些记录重建出的 tip;`sleep` 直通输入。 */
  readonly tip: unknown;
}

/** 表正本的一格:每次测试新造条目,共享同一份执行日志。 */
type ReplayCaseFactory = (log: string[]) => ReplayCase;

/** 一个只记日志、返回固定输出的 step(单记录 / 块内的执行体)。 */
function replayStep(id: string, log: string[], output: unknown) {
  return createStep({
    id,
    inputSchema: anySchema,
    outputSchema: anySchema,
    execute: () => {
      log.push(id);
      return output;
    },
  });
}

/** `satisfies` 让七种 kind 漏格成为编译错误;`branch` 有两格(命中 / 无记录)。 */
const REPLAY_CASES = {
  then: [
    {
      label: '单条记录 = 那一步的输出',
      make: (log: string[]): ReplayCase => ({
        entry: { type: 'then', step: replayStep('then-step', log, { kind: 'then' }) },
        records: { 'then-step': { kind: 'then' } },
        tip: { kind: 'then' },
      }),
    },
  ],
  parallel: [
    {
      label: 'keyed 多记录',
      make: (log: string[]): ReplayCase => ({
        entry: {
          type: 'parallel',
          steps: [
            replayStep('parallel-a', log, 'a-out'),
            replayStep('parallel-b', log, 'b-out'),
          ],
        },
        records: { 'parallel-a': 'a-out', 'parallel-b': 'b-out' },
        tip: { 'parallel-a': 'a-out', 'parallel-b': 'b-out' },
      }),
    },
  ],
  branch: [
    {
      label: '已执行臂的记录',
      make: (log: string[]): ReplayCase => ({
        entry: {
          type: 'branch',
          branches: [
            [
              () => {
                log.push('branch-cond-1');
                return true;
              },
              replayStep('branch-arm', log, 'arm-out'),
            ],
            [
              () => {
                log.push('branch-cond-2');
                return false;
              },
              replayStep('branch-skipped', log, 'skipped-out'),
            ],
          ],
        },
        records: { 'branch-arm': 'arm-out' },
        tip: { 'branch-arm': 'arm-out' },
      }),
    },
    {
      label: '无记录 = 空对象',
      make: (log: string[]): ReplayCase => ({
        entry: {
          type: 'branch',
          branches: [
            [
              () => {
                log.push('branch-cond-1');
                return false;
              },
              replayStep('branch-never-a', log, 'never-a'),
            ],
            [
              () => {
                log.push('branch-cond-2');
                return false;
              },
              replayStep('branch-never-b', log, 'never-b'),
            ],
          ],
        },
        records: {},
        tip: {},
      }),
    },
  ],
  foreach: [
    {
      label: '迭代聚合 = 记录里的数组',
      make: (log: string[]): ReplayCase => {
        const step = createStep({
          id: 'foreach-step',
          inputSchema: anySchema,
          outputSchema: anySchema,
          execute: (ctx) => {
            log.push(`foreach:${String(ctx.inputData)}`);
            return String(ctx.inputData).toUpperCase();
          },
        });
        return {
          entry: { type: 'foreach', step, concurrency: 1 },
          records: { 'foreach-step': ['ONE', 'TWO'] },
          tip: ['ONE', 'TWO'],
        };
      },
    },
  ],
  dowhile: [
    {
      label: '最后一次迭代输出',
      make: (log: string[]): ReplayCase => {
        const step = createStep({
          id: 'loop-body',
          inputSchema: anySchema,
          outputSchema: anySchema,
          execute: () => {
            log.push('dowhile-body');
            return 'while-out';
          },
        });
        return {
          entry: {
            type: 'dowhile',
            step,
            cond: (ctx) => {
              log.push(`dowhile-cond:${String(ctx.iterationCount)}`);
              return ctx.iterationCount < 1;
            },
          },
          records: { 'loop-body': 'while-out' },
          tip: 'while-out',
        };
      },
    },
  ],
  dountil: [
    {
      label: '最后一次迭代输出',
      make: (log: string[]): ReplayCase => {
        const step = createStep({
          id: 'loop-body',
          inputSchema: anySchema,
          outputSchema: anySchema,
          execute: () => {
            log.push('dountil-body');
            return 'until-out';
          },
        });
        return {
          entry: {
            type: 'dountil',
            step,
            cond: (ctx) => {
              log.push(`dountil-cond:${String(ctx.iterationCount)}`);
              return ctx.iterationCount >= 1;
            },
          },
          records: { 'loop-body': 'until-out' },
          tip: 'until-out',
        };
      },
    },
  ],
  sleep: [
    {
      label: '直通输入且无记录',
      make: (log: string[]): ReplayCase => ({
        // 前缀让 tip 区别于运行输入:直通若错取 `state.input` 就会失败。
        preface: [
          { type: 'then', step: replayStep('preface-step', log, { transformed: 'sleep-tip' }) },
        ],
        entry: {
          type: 'sleep',
          duration: () => {
            log.push('sleep');
            return 0;
          },
        },
        records: { 'preface-step': { transformed: 'sleep-tip' } },
        tip: { transformed: 'sleep-tip' },
      }),
    },
  ],
} satisfies {
  readonly [TKind in WorkflowEntry['type']]: readonly {
    readonly label: string;
    readonly make: ReplayCaseFactory;
  }[];
};

/** 表正本 → `it.each` 的行;`satisfies` 已保证七种 kind 一格不缺。 */
const REPLAY_MATRIX = Object.entries(REPLAY_CASES).flatMap(([kind, cases]) =>
  cases.map(({ label, make }): [string, ReplayCaseFactory] => [`${kind}:${label}`, make]),
);

describe('replay 形状:已完成条目在 resume 时按记录重建(七种 kind 矩阵)', () => {
  it.each(REPLAY_MATRIX)('%s:resume 不重跑已完成条目,tip 由记录重建', async (label, make) => {
    const log: string[] = [];
    const { preface, entry, records, tip } = make(log);
    /** 挂起 step:首跑 suspend,resume 收到 resumeData;记下每次拿到的输入。 */
    const seen: unknown[] = [];
    const gate = gateStep('gate', (input) => seen.push(input));
    const run = createWorkflowRun(
      {
        id: `replay-${label}`,
        inputSchema: anySchema,
        entries: [...(preface ?? []), entry, { type: 'then', step: gate }],
      },
      { runId: `replay-${label}` },
    );

    const suspended = expectSuspended(await run.start({ inputData: replayInput }).result);
    expect(suspended.stepId).toBe('gate');
    // 记录正本:该 kind 写下的键与输出;无记录的 kind 只有挂起 step 自己的记录。
    expect(Object.keys(suspended.stepResults).sort()).toEqual(
      [...Object.keys(records), 'gate'].sort(),
    );
    for (const [stepId, output] of Object.entries(records)) {
      expect(suspended.stepResults[stepId]).toMatchObject({ status: 'success', output });
    }
    const executedBeforeResume = [...log];

    const outcome = expectSuccess(
      await run.resume({ step: 'gate', resumeData: { approved: true } }),
    );

    // tip = 记录的重建:重进 step 拿到的输入与首跑一致。
    expect(seen).toEqual([tip, tip]);
    // 已完成的条目一条都不重跑:step / 迭代 / 条件 / sleep 时长解析都没有新调用。
    expect(log).toEqual(executedBeforeResume);
    expect(outcome.output).toEqual({ approved: true });
  });
});

/**
 * iteration-site kind(候选 05 第四片,#222):表里「块内挂起携带哪种现场」那一列是唯一声明——
 * `parallel` / `branch` / `foreach` 各对应自己,`dowhile` / `dountil` 都映射为 `loop`,
 * `then` 与 `sleep` 不携带(不适用者为空)。`checkIterationSite` 只读这一列:site 与条目不匹配
 * (kind 与表里那一列不同)时继续显式失败,不静默重进。接缝 = 公共 `start` / `resume`,以及
 * store 里观察到的挂起快照。
 */

/**
 * 七种 kind 的现场正本:`siteKind` 是表里该 kind 携带的 kind(空 = 不适用),`suspends` 标注该
 * kind 能否在块内挂起(`sleep` 没有 step,挂不起来——它的空格子由不匹配矩阵逐 site 观察)。
 */
const SITE_CASES = {
  then: {
    entry: { type: 'then', step: gateStep('then-gate') },
    input: 'value',
    resumeStepId: 'then-gate',
    suspends: true,
    siteKind: undefined,
  },
  parallel: {
    entry: { type: 'parallel', steps: [gateStep('parallel-gate')] },
    input: 'value',
    resumeStepId: 'parallel-gate',
    suspends: true,
    siteKind: 'parallel',
  },
  branch: {
    entry: { type: 'branch', branches: [[() => true, gateStep('branch-gate')]] },
    input: 'value',
    resumeStepId: 'branch-gate',
    suspends: true,
    siteKind: 'branch',
  },
  foreach: {
    entry: { type: 'foreach', step: gateStep('foreach-gate'), concurrency: 1 },
    input: ['value'],
    resumeStepId: 'foreach-gate',
    suspends: true,
    siteKind: 'foreach',
  },
  dowhile: {
    entry: {
      type: 'dowhile',
      step: gateStep('dowhile-gate'),
      cond: (ctx) => ctx.iterationCount < 1,
    },
    input: 'value',
    resumeStepId: 'dowhile-gate',
    suspends: true,
    siteKind: 'loop',
  },
  dountil: {
    entry: {
      type: 'dountil',
      step: gateStep('dountil-gate'),
      cond: (ctx) => ctx.iterationCount >= 1,
    },
    input: 'value',
    resumeStepId: 'dountil-gate',
    suspends: true,
    siteKind: 'loop',
  },
  sleep: {
    entry: { type: 'sleep', duration: 0 },
    input: 'value',
    // sleep 没有 step:伪造快照只能指名一个不存在的 id——不匹配的现场先于成员关系报错。
    resumeStepId: 'sleep-ghost',
    suspends: false,
    siteKind: undefined,
  },
} satisfies {
  readonly [TKind in WorkflowEntry['type']]: {
    readonly entry: Extract<WorkflowEntry, { readonly type: TKind }>;
    readonly input: unknown;
    readonly resumeStepId: string;
    readonly suspends: boolean;
    readonly siteKind: WorkflowIterationSite['kind'] | undefined;
  };
};

/** 表正本 → `it.each` 的行;`satisfies` 已保证七种 kind 一格不缺。 */
const SITE_MATRIX = Object.entries(SITE_CASES);

/** 四种 site 现场的正本:不匹配格对每个 kind 试遍「不是表里那一列」的每一种。 */
const ALL_SITES: readonly WorkflowIterationSite[] = [
  { kind: 'parallel' },
  { kind: 'branch' },
  { kind: 'foreach', suspendedIndex: 0, collected: {} },
  { kind: 'loop', iterationCount: 0, value: 'value' },
];

/**
 * 不匹配格 = 每个 kind × 每一种不是表里那一列的 site kind:五种块 kind 三种错法,`then` / `sleep`
 * 四种全错——表里给 leaf kind 填任何值、或给块 kind 填错值,都至少有一格变红。
 */
const SITE_MISMATCH_MATRIX = SITE_MATRIX.flatMap(([kind, testCase]) =>
  ALL_SITES.filter((site) => site.kind !== testCase.siteKind).map(
    (site) => [`${kind} + ${site.kind}`, { kind, testCase, site }] as const,
  ),
);

describe('iteration-site kind:挂起携带表里的 site kind(顶层 then 无 site),匹配的 resume 重进(#222)', () => {
  it.each(SITE_MATRIX.filter(([, testCase]) => testCase.suspends))(
    '%s:挂起快照的 site kind = 表里那一列;匹配 site 的 resume 成功',
    async (kind, testCase) => {
      const runId = `site-${kind}`;
      const store = createInMemorySnapshotStore();
      const run = createWorkflowRun(
        { id: runId, inputSchema: anySchema, storage: store, entries: [testCase.entry] },
        { runId },
      );

      const suspended = expectSuspended(await run.start({ inputData: testCase.input }).result);
      expect(suspended.stepId).toBe(testCase.resumeStepId);

      const snapshot = await store.load(runId);
      if (snapshot === null) throw new Error(`expected a suspended snapshot for "${runId}"`);
      // 块内挂起:site 的 kind 与表里声明一致(dowhile / dountil 都读 loop);
      // 顶层 then 不携带 site —— 不适用者为空。
      expect(snapshot.iterationSite?.kind).toBe(testCase.siteKind);
      if (testCase.siteKind === undefined) {
        expect('iterationSite' in snapshot).toBe(false);
      }

      const resumed = expectSuccess(
        await run.resume({ step: testCase.resumeStepId, resumeData: { approved: true } }),
      );
      expect(resumed.stepResults[testCase.resumeStepId]).toMatchObject({ status: 'success' });
    },
  );
});

describe('iteration-site kind:site 与条目不匹配 → 显式失败(七种 kind × 每一种错 site)', () => {
  it.each(SITE_MISMATCH_MATRIX)(
    '%s:报错点名 site kind 与条目 kind,不重进',
    async (label, { kind, testCase, site }) => {
      const runId = `site-mismatch-${label}`;
      const store: WorkflowSnapshotStore = {
        load: async () => ({
          runId,
          status: 'suspended',
          input: testCase.input,
          stepResults: {
            [testCase.resumeStepId]: { status: 'suspended', suspendPayload: { question: 'ok?' } },
          },
          position: 0,
          iterationSite: site,
        }),
        save: async () => {},
      };
      const run = createWorkflowRun(
        { id: runId, inputSchema: anySchema, storage: store, entries: [testCase.entry] },
        { runId },
      );

      const error = await captureRejection(() => run.resume({ step: testCase.resumeStepId }));

      expect(error.message).toMatch(new RegExp(`iteration site \\(kind "${site.kind}"\\)`));
      expect(error.message).toMatch(new RegExp(`the ${kind} block at position 0`));
      expect(error.message).toMatch(/do not match/);
    },
  );
});

/**
 * loop timing(候选 05 第四片,#222):表里「条件在体前还是体后」只声明一次,`runLoop` 只读它——
 * `dowhile` 体前(条件在 iterationCount 0 就假,体一次不跑),`dountil` 体后(至少跑一次)。
 * 两格用**同一个条件**(已完成 1 次迭代即停)与同一份输入,差异只来自求值点;日志 = 求值点
 * 相对体的位置,由公共 `start()` 观察。
 */

/** 体内一步:输入 + 1,并把「体在哪个输入上跑过」记进日志。 */
function timingBody(log: string[]) {
  return createStep({
    id: 'body',
    inputSchema: z.number(),
    outputSchema: z.number(),
    execute: ({ inputData }) => {
      log.push(`body@${inputData}`);
      return inputData + 1;
    },
  });
}

/** 两格共用的条件:求值点由 kind 决定,条件本身一模一样。 */
function timingCond(log: string[]) {
  return (ctx: { readonly iterationCount: number }): boolean => {
    log.push(`cond@${ctx.iterationCount}`);
    return ctx.iterationCount >= 1;
  };
}

/** 表正本:`expectedLog` 就是条件求值点相对体的位置(体前 = 先 cond;体后 = 先 body)。 */
const LOOP_TIMING_CASES = {
  dowhile: {
    entry: (log: string[]): DowhileEntry => ({
      type: 'dowhile',
      step: timingBody(log),
      cond: timingCond(log),
    }),
    expectedLog: ['cond@0'],
    expectedOutput: 0,
  },
  dountil: {
    entry: (log: string[]): DountilEntry => ({
      type: 'dountil',
      step: timingBody(log),
      cond: timingCond(log),
    }),
    expectedLog: ['body@0', 'cond@1'],
    expectedOutput: 1,
  },
} satisfies {
  readonly [TKind in 'dowhile' | 'dountil']: {
    readonly entry: (log: string[]) => Extract<WorkflowEntry, { readonly type: TKind }>;
    readonly expectedLog: readonly string[];
    readonly expectedOutput: number;
  };
};

/** 表正本 → `it.each` 的行;两种 loop 一格不缺。 */
const LOOP_TIMING_MATRIX = Object.entries(LOOP_TIMING_CASES);

describe('loop timing:条件求值点在体前 / 体后(公共 start,#222)', () => {
  it.each(LOOP_TIMING_MATRIX)(
    '%s:同一条件与输入下,日志 = 求值点相对体的位置',
    async (kind, testCase) => {
      const log: string[] = [];
      const runId = `timing-${kind}`;
      const run = createWorkflowRun(
        { id: runId, inputSchema: z.number(), entries: [testCase.entry(log)] },
        { runId },
      );

      const outcome = expectSuccess(await run.start({ inputData: 0 }).result);

      expect(log).toEqual(testCase.expectedLog);
      expect(outcome.output).toBe(testCase.expectedOutput);
      expect(outcome.stepResults['body']).toMatchObject({
        status: 'success',
        output: testCase.expectedOutput,
      });
    },
  );
});
