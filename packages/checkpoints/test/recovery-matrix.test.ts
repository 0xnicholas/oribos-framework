import { describe, expect, it, vi } from 'vitest';
import type { AgentStepBoundary } from '@oribos/core/agent';
import {
  createCheckpointedAgent,
  createInMemoryAgentRunCheckpointStore,
} from '@oribos/checkpoints';
import type { AgentRunCheckpoint, CheckpointedRunOutcome } from '@oribos/checkpoints';
import { fakeModel } from '@oribos/testing';
import {
  buildAgent,
  seededResidue,
  seededStepZeroResidue,
} from './helpers/checkpoints.js';

/**
 * 恢复矩阵(#203):残留的崩溃点 × 恢复段的终态。每个格子钉住同一条公开承诺 ——
 *
 * - 重放步零模型调用(它的输出来自检查点),其持有工具重执行一次;
 * - 恢复段只把 in-flight/后续的模型调用发给模型;
 * - 无论恢复段成功、失败还是挂起,残留都随终态清除(恢复不是留下现场的重试);
 * - `runId` 贯穿恢复结果。
 *
 * 断言只走公开面(`recover` 的返回值 / rejection 与调用方自己的 store、假模型计数)。
 */

interface Cell {
  /** 崩溃点的人类可读名。 */
  readonly crash: string;
  /** 该崩溃点的残留构造器。 */
  readonly residue: (runId: string) => AgentRunCheckpoint;
  /** 重放步会重执行的持有工具。 */
  readonly replayedTool: string;
}

const CELLS: readonly Cell[] = [
  { crash: 'step 0 边界(持有 call-a)', residue: seededStepZeroResidue, replayedTool: 'a' },
  { crash: 'step N 边界(step 1,持有 call-b)', residue: seededResidue, replayedTool: 'b' },
];

describe.each(CELLS)('恢复矩阵:$crash', ({ residue, replayedTool }) => {
  it('成功终态:重放步零模型调用,恢复段完成并清除残留', async () => {
    const executed: string[] = [];
    const model = fakeModel([{ text: 'done' }]);
    const storage = createInMemoryAgentRunCheckpointStore();
    const cp = createCheckpointedAgent({ agent: buildAgent(model, executed), storage });
    await storage.save('run-1', residue('run-1'));

    const outcome = await cp.recover('run-1');

    expect(outcome.runId).toBe('run-1');
    expect(outcome.finishReason).toBe('stop');
    expect(outcome.text).toBe('done');
    // 重放步不问模型;只发生恢复段自己的那一次调用。
    expect(model.streamCalls).toHaveLength(1);
    expect(model.streamCalls[0]?.prompt.at(-1)).toMatchObject({ role: 'tool' });
    // 持有工具重执行一次(幂等成本显式可见)。
    expect(executed).toEqual([replayedTool]);
    await vi.waitFor(async () => expect(await storage.load('run-1')).toBeNull());
  });

  it('失败终态:恢复以 rejection 表达,残留同样清除', async () => {
    const executed: string[] = [];
    const model = fakeModel([{ fail: new Error('provider down') }]);
    const storage = createInMemoryAgentRunCheckpointStore();
    const cp = createCheckpointedAgent({ agent: buildAgent(model, executed), storage });
    await storage.save('run-1', residue('run-1'));

    await expect(cp.recover('run-1')).rejects.toThrow('provider down');

    expect(model.streamCalls).toHaveLength(1);
    expect(executed).toEqual([replayedTool]);
    // 失败是终态,不是崩溃:残留不再留下。
    await vi.waitFor(async () => expect(await storage.load('run-1')).toBeNull());
  });

  it('挂起终态:恢复段以 suspended 落定,残留同样清除', async () => {
    const executed: string[] = [];
    const model = fakeModel([
      {
        text: 'step next',
        toolCalls: [{ toolCallId: 'call-next', toolName: 'note', input: { value: 'next' } }],
      },
    ]);
    const storage = createInMemoryAgentRunCheckpointStore();
    const cp = createCheckpointedAgent({ agent: buildAgent(model, executed), storage });
    await storage.save('run-1', residue('run-1'));

    const gate: AgentStepBoundary = { beforeToolCalls: () => ({ suspend: true }) };
    const outcome: CheckpointedRunOutcome = await cp.recover('run-1', { stepBoundary: gate });

    expect(outcome.runId).toBe('run-1');
    expect(outcome.finishReason).toBe('suspended');
    // 重放步不问模型;挂起步的持有工具不执行。
    expect(model.streamCalls).toHaveLength(1);
    expect(executed).toEqual([replayedTool]);
    // 挂起同样是终态(现场归挂起机器,不归本包):残留清掉。
    await vi.waitFor(async () => expect(await storage.load('run-1')).toBeNull());
  });
});
