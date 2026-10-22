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

/**
 * 条目拓扑(#218,`CONTEXT.md`「条目拓扑」/「重入目标」):per-kind 静态事实的唯一真相源是
 * `entry.ts` 的 descriptor 表,公共面只开 `restartTargetAt` 一个答案函数。接缝 =
 * `@oribos/core/workflows` 公共面。
 *
 * 矩阵列与实际覆盖(测试不 import descriptor,每个事实走公共行为):
 * - step 归属 / stepIds / findStep 命中与 miss → 本文件两套表驱动测试;
 * - replayShape / iterationSiteKind → `workflows-suspend-resume.test.ts`(块内挂起、resume、
 *   site 不匹配);
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

  it('未知 kind 显式抛错,不静默降级成「没有 step」', () => {
    const entries = [{ type: 'quantum' } as unknown as WorkflowEntry];

    expect(() => restartTargetAt({ entries }, 0)).toThrow(
      /unknown workflow entry type "quantum"/,
    );
  });
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
