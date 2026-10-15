import { describe, expect, it } from 'vitest';
import type { AgentStepBoundary } from '@oribos/core/agent';
import {
  createCheckpointedAgent,
  createInMemoryAgentRunCheckpointStore,
} from '@oribos/checkpoints';
import type { AgentRunCheckpointStore } from '@oribos/checkpoints';
import { fakeModel } from '@oribos/testing';
import { buildAgent, collect, recordingStore, script } from './helpers/checkpoints.js';

/**
 * `createCheckpointedAgent` 的录制面(#186):每个继续的步骤在边界写一条检查点,run 终态把
 * 检查点清干净。
 *
 * 断言只走公开面:包装后的输出对象(chunk 流 + 终值 getter + `runId`)与调用方自己的 store
 * (端口调用序列 = 检查点写在哪里、何时被清的完整证据)。「继续的步骤」 = 模型给出了工具调用、
 * 框架即将执行它们的那一步 —— 步骤边界(`stepBoundary.beforeToolCalls`)的公开语义。
 *
 * 清除是终态之后的簿记(不阻断 run 的结算),所以断言先等 store 的 delete 落地再查。
 */

describe('createCheckpointedAgent:每步检查点与终态清除', () => {
  it('每个继续的步骤写一条检查点(边界快照),run 终态清掉且 runId 贯穿', async () => {
    const executed: string[] = [];
    const spy = recordingStore();
    const cp = createCheckpointedAgent({
      agent: buildAgent(fakeModel(script()), executed),
      storage: spy.store,
    });

    const output = cp.stream('start');
    expect(typeof output.runId).toBe('string');
    expect(output.runId.length).toBeGreaterThan(0);
    expect(await output.text).toBe('done');

    // 两条检查点:step 0 与 step 1 的边界各一条,stepCount / 持有的调用与该步一致。
    expect(spy.saves.map((entry) => entry.stepCount)).toEqual([0, 1]);
    expect(spy.saves.map((entry) => entry.toolCalls.map((call) => call.toolCallId))).toEqual([
      ['call-a'],
      ['call-b'],
    ]);
    expect(spy.saves.map((entry) => entry.runId)).toEqual([output.runId, output.runId]);

    // 快照面:消息表以该步自己的 assistant 消息收尾,逐步增长(step 1 的边界已含 step 0 的工具回喂)。
    const first = spy.saves[0];
    const second = spy.saves[1];
    expect(first?.messages.at(-1)).toMatchObject({ role: 'assistant' });
    expect(second?.messages.at(-1)).toMatchObject({ role: 'assistant' });
    expect(second!.messages.length).toBeGreaterThan(first!.messages.length);
    expect(first?.traceId).toBeUndefined();

    // 工具照常执行;终态清干净,store 里没有残留。
    expect(executed).toEqual(['a', 'b']);
    await spy.cleared;
    expect(spy.deletes).toEqual([output.runId]);
    expect(await spy.inner.load(output.runId)).toBeNull();
  });

  it('失败的 run 同样清干净:失败是终态,不是崩溃', async () => {
    const executed: string[] = [];
    const spy = recordingStore();
    const cp = createCheckpointedAgent({
      agent: buildAgent(fakeModel([script()[0]!, { fail: new Error('provider down') }]), executed),
      storage: spy.store,
    });

    const output = cp.stream('start');
    await expect(output.text).rejects.toThrow('provider down');

    expect(spy.saves.map((entry) => entry.stepCount)).toEqual([0]);
    await spy.cleared;
    expect(spy.deletes).toEqual([output.runId]);
    expect(await spy.inner.load(output.runId)).toBeNull();
  });

  it('用户自己的闸挂起 run:该步不写检查点,先前步骤的检查点随终态清掉', async () => {
    const spy = recordingStore();
    const cp = createCheckpointedAgent({
      agent: buildAgent(fakeModel(script()), []),
      storage: spy.store,
    });

    let boundaries = 0;
    const gate: AgentStepBoundary = {
      beforeToolCalls: () => {
        boundaries += 1;
        return boundaries === 2 ? { suspend: true } : undefined;
      },
    };

    const output = cp.stream('start', { stepBoundary: gate });
    expect(await output.finishReason).toBe('suspended');

    // step 0 写了;step 1 被挂起点名,不写(挂起 run 的现场归挂起机器,不归本包)。
    expect(boundaries).toBe(2);
    expect(spy.saves.map((entry) => entry.stepCount)).toEqual([0]);
    await spy.cleared;
    expect(spy.deletes).toEqual([output.runId]);
    expect(await spy.inner.load(output.runId)).toBeNull();
  });

  it('store 拒收 save:该 run 以存储错误失败(录制是 run 的一部分,不做尽力而为)', async () => {
    const refusing: AgentRunCheckpointStore = {
      save: async () => {
        throw new Error('store down');
      },
      load: async () => null,
      delete: async () => undefined,
      list: async () => [],
    };
    const cp = createCheckpointedAgent({
      agent: buildAgent(fakeModel(script()), []),
      storage: refusing,
    });

    await expect(collect(cp.stream('start'))).rejects.toThrow('store down');
  });

  it('store 拒收 delete:不改写 run 的结局,残留留待下次恢复(已知代价)', async () => {
    const inner = createInMemoryAgentRunCheckpointStore();
    const store: AgentRunCheckpointStore = {
      save: (runId, checkpoint) => inner.save(runId, checkpoint),
      load: (runId) => inner.load(runId),
      delete: async () => {
        throw new Error('delete down');
      },
      list: () => inner.list(),
    };
    const cp = createCheckpointedAgent({
      agent: buildAgent(fakeModel(script()), []),
      storage: store,
    });

    const output = cp.stream('start');
    expect(await output.text).toBe('done');
    // 结局不受存储影响;残留可见 —— 一次恢复会从它重放(应用侧应让 delete 失败响起来)。
    expect(await store.load(output.runId)).not.toBeNull();
  });

  it('透传:chunk 序列与终值与裸 run 一致,runId 逐 run 唯一', async () => {
    const bare = buildAgent(fakeModel(script()), []);
    const wrapped = createCheckpointedAgent({ agent: buildAgent(fakeModel(script()), []) });

    const bareChunks = await collect(bare.stream('start'));
    const first = wrapped.stream('start');
    expect(await collect(first)).toEqual(bareChunks);
    expect(await first.text).toBe('done');
    expect(await first.finishReason).toBe('stop');

    // 同一 wrapper 的第二个 run:新 runId(惰性 —— 不读它就不会启动)。
    const second = wrapped.stream('start');
    expect(second.runId).not.toBe(first.runId);
  });
});
