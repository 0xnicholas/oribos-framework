import { describe, expect, it, vi } from 'vitest';
import {
  createCheckpointedAgent,
  createInMemoryAgentRunCheckpointStore,
} from '@oribos/checkpoints';
import type { AgentRunCheckpointStore } from '@oribos/checkpoints';
import { fakeModel } from '@oribos/testing';
import { buildAgent, seededResidue } from './helpers/checkpoints.js';

/**
 * `recoverAll`(#186):boot 扫描 —— store 里每一条残留按 list 顺序重放,逐条给出结局;一条的
 * 失败不毁批次(evals 批量条的同一纪律:失败是条目自己的 ok:false,不是整批的异常)。
 *
 * 断言只走公开面:返回值(条目形状)与调用方自己的 store(残留的去向)。
 */

describe('recoverAll:启动扫描', () => {
  it('每一条残留按 list 顺序重放,逐个给出结局并清干净', async () => {
    const executed: string[] = [];
    // 两条残留都在 step 2 起点:各需一次模型调用(重放步不问模型)。
    const model = fakeModel([{ text: 'done' }, { text: 'done' }]);
    const storage = createInMemoryAgentRunCheckpointStore();
    const cp = createCheckpointedAgent({ agent: buildAgent(model, executed), storage });
    await storage.save('run-a', seededResidue('run-a'));
    await storage.save('run-b', seededResidue('run-b'));

    const results = await cp.recoverAll();

    expect(results.map((entry) => entry.runId)).toEqual(['run-a', 'run-b']);
    expect(results.map((entry) => entry.ok)).toEqual([true, true]);
    const outcomes = results.map((entry) => (entry.ok ? entry.outcome : undefined));
    expect(outcomes.map((outcome) => outcome?.runId)).toEqual(['run-a', 'run-b']);
    expect(outcomes.map((outcome) => outcome?.text)).toEqual(['done', 'done']);
    expect(outcomes.map((outcome) => outcome?.finishReason)).toEqual(['stop', 'stop']);

    // 每条残留各一次重发;各自的持有调用重执行一次(幂等成本)。
    expect(model.streamCalls).toHaveLength(2);
    expect(executed).toEqual(['b', 'b']);

    await vi.waitFor(async () => expect(await storage.list()).toEqual([]));
  });

  it('一条重放失败不毁批次:该条 ok:false 带错误,其余照常恢复', async () => {
    const executed: string[] = [];
    const model = fakeModel([{ text: 'done' }, { fail: new Error('provider down') }]);
    const storage = createInMemoryAgentRunCheckpointStore();
    const cp = createCheckpointedAgent({ agent: buildAgent(model, executed), storage });
    await storage.save('run-a', seededResidue('run-a'));
    await storage.save('run-b', seededResidue('run-b'));

    const results = await cp.recoverAll();

    expect(results[0]).toMatchObject({ runId: 'run-a', ok: true });
    expect(results[0]?.ok === true && results[0].outcome.text).toBe('done');

    const failed = results[1];
    if (failed === undefined || failed.ok !== false) {
      throw new Error('expected the second entry to be a failure');
    }
    expect(failed.runId).toBe('run-b');
    expect(failed.error).toBeInstanceOf(Error);
    expect((failed.error as Error).message).toContain('provider down');

    // 失败的恢复同样消费残留(run 已结算,不留可重放的现场);成功的那个也清了。
    await vi.waitFor(async () => expect(await storage.list()).toEqual([]));
  });

  it('空 store:无残留可扫,返回空数组', async () => {
    const executed: string[] = [];
    const cp = createCheckpointedAgent({ agent: buildAgent(fakeModel([]), executed) });
    expect(await cp.recoverAll()).toEqual([]);
  });

  it('list 失败:recoverAll 拒绝,不静默吞(扫不动就是扫不动)', async () => {
    const broken: AgentRunCheckpointStore = {
      save: async () => undefined,
      load: async () => null,
      delete: async () => undefined,
      list: async () => {
        throw new Error('store offline');
      },
    };
    const cp = createCheckpointedAgent({ agent: buildAgent(fakeModel([]), []), storage: broken });
    await expect(cp.recoverAll()).rejects.toThrow('store offline');
  });
});
