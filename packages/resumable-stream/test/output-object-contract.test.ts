import { Agent } from '@oribos/core/agent';
import type { Chunk } from '@oribos/core/model';
import { createInMemoryEventCache, withEventCache } from '@oribos/resumable-stream';
import { describeOutputObjectContract, fakeModel } from '@oribos/testing';

/**
 * `withEventCache` 的输出对象行为契约(#205):录制泵改走 `@oribos/core/output-object` 的共享泵
 * 后,包装对象必须与裸 agent 流跑出同一矩阵——懒启动、单迭代器同一性、缓冲排空序、失败在缓冲后
 * 到达、abandon 不传播、终值惰性。断言只走公开面(包装后的输出对象 + 假模型探针)。
 */

let runs = 0;

/** An agent streaming `texts` as separate deltas. */
function agentStreaming(texts: readonly string[]) {
  const model = fakeModel([
    { text: texts, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 2 } },
  ]);
  return { model, agent: new Agent({ name: 'test', instructions: 'test', model }) };
}

/** Wraps a fresh agent stream in a fresh cache/run id — one script instance per contract case. */
function recording(texts: readonly string[]) {
  runs += 1;
  const { model, agent } = agentStreaming(texts);
  const output = withEventCache(agent.stream('hello'), {
    runId: `contract-${runs}`,
    cache: createInMemoryEventCache(),
  });
  return { model, output };
}

const FINISH: Chunk = {
  type: 'finish',
  finishReason: 'stop',
  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
};

describeOutputObjectContract<Chunk>({
  success: () => {
    const { model, output } = recording(['a', 'b']);
    return {
      output,
      readTerminal: () => output.text,
      started: () => model.streamCalls.length > 0,
      chunks: [
        { type: 'text-delta', textDelta: 'a' },
        { type: 'text-delta', textDelta: 'b' },
        FINISH,
      ],
      terminal: 'ab',
    };
  },
  failure: () => {
    const boom = new Error('upstream exploded');
    runs += 1;
    const model = fakeModel([{ text: ['a', 'b'], errorAfter: boom }]);
    const agent = new Agent({ name: 'test', instructions: 'test', model });
    const output = withEventCache(agent.stream('hello'), {
      runId: `contract-${runs}`,
      cache: createInMemoryEventCache(),
    });
    return {
      output,
      readTerminal: () => output.text,
      started: () => model.streamCalls.length > 0,
      chunks: [
        { type: 'text-delta', textDelta: 'a' },
        { type: 'text-delta', textDelta: 'b' },
      ],
      error: boom,
    };
  },
});
