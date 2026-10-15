import { describe, expect, it, vi } from 'vitest';
import { Agent } from '@oribos/core/agent';
import { AGENT_RUN_SPAN, createTracer, memoryExporter } from '@oribos/core/observability';
import {
  createCheckpointedAgent,
  createInMemoryAgentRunCheckpointStore,
} from '@oribos/checkpoints';
import { fakeModel } from '@oribos/testing';
import {
  buildAgent,
  hangingModel,
  noteTools,
  recordingStore,
  script,
  seededResidue,
} from './helpers/checkpoints.js';

/**
 * `recover`(#186):从崩溃残留重放一条 run —— fake model 重发计数是主断言。
 *
 * 钉子(逐条):
 * - **重发上界一次**:恢复只重发 in-flight 的那一次模型调用;已完成步骤的调用都在检查点的消息表
 *   里,不再问模型。崩溃进程 + 恢复合计 = 崩溃前已完成的调用数 + 2。
 * - **重放步零模型调用**:残留里的持有调用直接执行(工具**重执行**一次 —— 幂等成本显式可见),
 *   该步不再问模型。
 * - **结局清干净**:恢复的 run 结算即清检查点;残留被消费,store 空。
 * - 未知 runId 显式报错;并发 recover 同一 runId 合并为一次重放(锁语义与 durable resume 同)。
 */

describe('recover:崩溃重放与重发计数', () => {
  it('崩溃后恢复:只重发 in-flight 那一次模型调用,已完成步骤不重发', async () => {
    const executed: string[] = [];
    const { model, inner, attempts } = hangingModel(script(), 3);
    const spy = recordingStore();
    const cp = createCheckpointedAgent({ agent: buildAgent(model, executed), storage: spy.store });

    // 崩溃进程的驱动器:读终值 = 启动 run;run 停在第 3 次模型调用上(step 2 的调用,in-flight)。
    const crashed = cp.stream('start');
    void crashed.text.catch(() => undefined);
    await vi.waitFor(() => expect(attempts()).toBe(3));

    // 残留 = 进程死前的最后一步边界:step 1(step 0 / step 1 已完成,两个工具各执行过一次)。
    const residue = await spy.inner.load(crashed.runId);
    expect(residue?.stepCount).toBe(1);
    expect(residue?.toolCalls.map((call) => call.toolCallId)).toEqual(['call-b']);
    expect(executed).toEqual(['a', 'b']);

    // 启动恢复 = 一次函数调用;从残留重放,run 走完。
    const outcome = await cp.recover(crashed.runId);
    expect(outcome.runId).toBe(crashed.runId);
    expect(outcome.finishReason).toBe('stop');
    expect(outcome.text).toBe('done');

    // 重发计数:模型总共被问了 4 次 —— 崩溃进程 3 次(第 3 次 in-flight 未走完)+ 恢复 1 次;
    // step 0 / step 1 都没有被重问(否则计数更高)。恢复那一次完整走完,录进假模型,其 prompt 以
    // step 1 的工具回喂收尾 —— 检查点带回的历史。
    expect(attempts()).toBe(4);
    expect(inner.streamCalls).toHaveLength(3);
    expect(inner.streamCalls[2]?.prompt.at(-1)).toMatchObject({ role: 'tool' });

    // 幂等成本显式可见:重放步(step 1)的工具重执行一次 —— b 共两次,a 一次。
    expect(executed).toEqual(['a', 'b', 'b']);

    // 结局清干净:残留被恢复消费,store 空。
    await spy.cleared;
    expect(spy.deletes).toEqual([crashed.runId]);
    expect(await spy.inner.load(crashed.runId)).toBeNull();
  });

  it('恢复从残留快照重放:重放步不再问模型,其工具执行一次', async () => {
    const executed: string[] = [];
    // 脚本只够一次回答:恢复若重问了已完成步骤,脚本即耗尽而失败。
    const model = fakeModel([{ text: 'done' }]);
    const storage = createInMemoryAgentRunCheckpointStore();
    const cp = createCheckpointedAgent({ agent: buildAgent(model, executed), storage });

    await storage.save('run-1', seededResidue('run-1'));
    const outcome = await cp.recover('run-1');

    expect(outcome.text).toBe('done');
    expect(model.streamCalls).toHaveLength(1);
    expect(model.streamCalls[0]?.prompt.at(-1)).toMatchObject({ role: 'tool' });
    expect(executed).toEqual(['b']);
    await vi.waitFor(async () => expect(await storage.load('run-1')).toBeNull());
  });

  it('未知 runId 显式报错,不冒烟', async () => {
    const cp = createCheckpointedAgent({ agent: buildAgent(fakeModel([]), []) });
    await expect(cp.recover('missing')).rejects.toThrow(/no checkpoint/);
  });

  it('并发 recover 同一 runId 合并为一次重放(两个调用拿到同一结局)', async () => {
    const executed: string[] = [];
    const model = fakeModel([{ text: 'done', delayMs: 5 }]);
    const storage = createInMemoryAgentRunCheckpointStore();
    const cp = createCheckpointedAgent({ agent: buildAgent(model, executed), storage });
    await storage.save('run-1', seededResidue('run-1'));

    const [first, second] = await Promise.all([cp.recover('run-1'), cp.recover('run-1')]);

    expect(first).toEqual(second);
    expect(model.streamCalls).toHaveLength(1);
    expect(executed).toEqual(['b']);
  });

  it('trace 续接:检查点持久化 traceId,恢复段落在同一 trace 上', async () => {
    const executed: string[] = [];
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const { model, attempts } = hangingModel(script(), 3);
    const agent = new Agent({
      name: 'test',
      instructions: 'test',
      model,
      tracer,
      tools: noteTools(executed),
    });
    const storage = createInMemoryAgentRunCheckpointStore();
    const cp = createCheckpointedAgent({ agent, storage });

    const crashed = cp.stream('start');
    void crashed.text.catch(() => undefined);
    await vi.waitFor(() => expect(attempts()).toBe(3));

    const residue = await storage.load(crashed.runId);
    expect(residue?.traceId).toMatch(/^[0-9a-f]{32}$/);

    await cp.recover(crashed.runId);

    // 恢复 = 同一 traceId 下新的 agent-run span(一次崩溃重放 = 同 trace 多 span)。
    const runSpans = memory.spans().filter((span) => span.type === AGENT_RUN_SPAN);
    expect(runSpans.length).toBeGreaterThanOrEqual(2);
    expect(runSpans.at(-1)?.traceId).toBe(residue?.traceId);
    expect(runSpans.at(-1)?.error).toBeUndefined();
  });
});
