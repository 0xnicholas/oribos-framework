import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createInMemorySnapshotStore,
  createStep,
  createWorkflow,
  restartTargetAt,
} from '@oribos/core/workflows';
import type { WorkflowEntry } from '@oribos/core/workflows';

/**
 * 条目拓扑(#218,`CONTEXT.md`「条目拓扑」/「重入目标」):per-kind 静态事实的唯一真相源是
 * `entry.ts` 的 descriptor 表,公共面只开 `restartTargetAt` 一个答案函数。接缝 =
 * `@oribos/core/workflows` 公共面:七种 kind 的矩阵、位置钳制、向后扫描跳 sleep、首匹配、
 * 空定义 / 无目标、未知 kind 显式抛错;再与 public `restart` 的 step-id 解析对齐,钉住
 * 「重复 step id 重入宁可多执行」。
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
 * `firstStepId` 是该条目在自身位置应给出的重启目标(id 字面量独立于实现)。
 */
const ENTRY_CASES = {
  then: {
    entry: { type: 'then', step: stepFor('then-step') },
    firstStepId: 'then-step',
  },
  parallel: {
    entry: { type: 'parallel', steps: [stepFor('parallel-a'), stepFor('parallel-b')] },
    firstStepId: 'parallel-a',
  },
  branch: {
    entry: {
      type: 'branch',
      branches: [
        [() => true, stepFor('branch-a')],
        [() => false, stepFor('branch-b')],
      ],
    },
    firstStepId: 'branch-a',
  },
  foreach: {
    entry: { type: 'foreach', step: stepFor('foreach-step'), concurrency: 1 },
    firstStepId: 'foreach-step',
  },
  dowhile: {
    entry: { type: 'dowhile', step: stepFor('dowhile-step'), cond: () => false },
    firstStepId: 'dowhile-step',
  },
  dountil: {
    entry: { type: 'dountil', step: stepFor('dountil-step'), cond: () => true },
    firstStepId: 'dountil-step',
  },
  sleep: {
    entry: { type: 'sleep', duration: 0 },
    firstStepId: undefined,
  },
} satisfies {
  readonly [TKind in WorkflowEntry['type']]: {
    readonly entry: Extract<WorkflowEntry, { readonly type: TKind }>;
    readonly firstStepId: string | undefined;
  };
};

describe('restartTargetAt:七种 kind 矩阵', () => {
  for (const [kind, testCase] of Object.entries(ENTRY_CASES)) {
    it(`${kind} 条目在自身位置给出首个 step id;无 step 的 kind 给出 undefined`, () => {
      expect(restartTargetAt({ entries: [testCase.entry] }, 0)).toBe(testCase.firstStepId);
    });
  }
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
    await run.restart({ step: target! });

    expect(executed).toEqual([
      'first-entry',
      'second-entry',
      'first-entry',
      'second-entry',
    ]);
  });
});
