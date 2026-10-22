import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createInMemorySnapshotStore,
  createStep,
  createWorkflow,
  createWorkflowRun,
  restartTargetAt,
} from '@oribos/core/workflows';
import type { WorkflowEntry } from '@oribos/core/workflows';
import { expectSuccess, expectSuspended } from './helpers/assertions.js';

/**
 * 条目拓扑(#218,`CONTEXT.md`「条目拓扑」/「重入目标」):per-kind 静态事实的唯一真相源是
 * `entry.ts` 的 descriptor 表,公共面只开 `restartTargetAt` 一个答案函数。接缝 =
 * `@oribos/core/workflows` 公共面。
 *
 * 矩阵列与实际覆盖(测试不 import descriptor,每个事实走公共行为):
 * - step 归属 / stepIds / findStep 命中与 miss → 本文件两套表驱动测试;
 * - replayShape → 本文件的七种 kind resume 矩阵(#220:已完成条目不重跑,tip 由记录重建);
 * - iterationSiteKind → `workflows-suspend-resume.test.ts`(块内挂起、resume、site 不匹配);
 * - loopTiming → `workflows-loop-wait.test.ts`(dowhile 体前 / dountil 体后);
 * - ownedArrays / freeze → 本文件 commit 冻结测试。
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

describe('commit:descriptor 驱动的冻结', () => {
  it('parallel / branch 的块数组按 ownedArrays 冻结;单 step 与 sleep 只冻结条目', () => {
    const workflow = createWorkflow({
      id: 'frozen',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
    })
      .parallel([stepFor('p1'), stepFor('p2')])
      .branch([[() => true, stepFor('b1')]])
      .then(stepFor('t1'))
      .sleep(0)
      .commit();
    const [parallel, branch] = workflow.entries;

    expect(Object.isFrozen(parallel)).toBe(true);
    expect(parallel?.type).toBe('parallel');
    if (parallel?.type !== 'parallel') throw new Error('expected a parallel entry');
    expect(Object.isFrozen(parallel.steps)).toBe(true);

    expect(Object.isFrozen(branch)).toBe(true);
    expect(branch?.type).toBe('branch');
    if (branch?.type !== 'branch') throw new Error('expected a branch entry');
    expect(Object.isFrozen(branch.branches)).toBe(true);
    expect(Object.isFrozen(branch.branches[0])).toBe(true);

    for (const entry of workflow.entries) expect(Object.isFrozen(entry)).toBe(true);
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
    const gate = createStep({
      id: 'gate',
      inputSchema: anySchema,
      outputSchema: anySchema,
      resumeSchema: z.object({ approved: z.boolean() }),
      execute: (ctx) => {
        seen.push(ctx.inputData);
        if (ctx.resumeData === undefined) ctx.suspend({ question: 'ok?' });
        return { resumed: ctx.resumeData };
      },
    });
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
    expect(outcome.output).toEqual({ resumed: { approved: true } });
  });
});
