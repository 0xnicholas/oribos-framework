import { Agent } from '@oribos/core/agent';
import type { Model } from '@oribos/core/model';
import { createTool } from '@oribos/core/tools';
import type { StandardSchema, Tool } from '@oribos/core/tools';
import { createInMemoryAgentRunCheckpointStore } from '@oribos/checkpoints';
import type { AgentRunCheckpoint, AgentRunCheckpointStore } from '@oribos/checkpoints';
import { fakeModel } from '@oribos/testing';
import type { FakeModel, FakeResponse } from '@oribos/testing';

/**
 * 包测试的共用场景件(#186):三步脚本 agent、手写 schema 的 note 工具、端口记录器、崩溃与
 * 残留的构造。断言仍各自写在测试文件里,这里只有构造与记录。
 */

/** 三步脚本:step 0 / step 1 各一次工具调用,step 2 终答。 */
export function script(): FakeResponse[] {
  return [
    {
      text: 'step zero',
      toolCalls: [{ toolCallId: 'call-a', toolName: 'note', input: { value: 'a' } }],
    },
    {
      text: 'step one',
      toolCalls: [{ toolCallId: 'call-b', toolName: 'note', input: { value: 'b' } }],
    },
    { text: 'done' },
  ];
}

/** note 工具的输入 schema —— 手写 Standard Schema 双接口,零 schema 库依赖(ADR-0003)。 */
export const noteInputSchema: StandardSchema<{ value: string }> = {
  '~standard': {
    version: 1,
    vendor: '@oribos/checkpoints-test',
    validate: (value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { issues: [{ message: 'note input must be an object with a string `value`' }] };
      }
      const note = (value as Record<string, unknown>)['value'];
      return typeof note === 'string'
        ? { value: { value: note } }
        : { issues: [{ message: 'note input `value` must be a string', path: [{ key: 'value' }] }] };
    },
    jsonSchema: {
      input: () => ({ type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }),
      output: () => ({ type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }),
    },
  },
};

/** note 工具容器;每次执行追加进 `executed`(幂等成本的证人)。 */
export function noteTools(executed: string[]): Record<string, Tool> {
  return {
    note: createTool({
      description: 'Records a note.',
      inputSchema: noteInputSchema,
      execute: ({ value }) => {
        executed.push(value);
        return { recorded: value };
      },
    }),
  };
}

/** 三步 agent。 */
export function buildAgent(model: Model, executed: string[]): Agent {
  return new Agent({
    name: 'test',
    instructions: 'test',
    model,
    tools: noteTools(executed),
  });
}

/** 端口调用的记录器:包装内存默认,断言只看调用序列;`cleared` 在首次 delete 落地时 resolve。 */
export function recordingStore(): {
  store: AgentRunCheckpointStore;
  saves: AgentRunCheckpoint[];
  deletes: string[];
  cleared: Promise<void>;
  inner: AgentRunCheckpointStore;
} {
  const inner = createInMemoryAgentRunCheckpointStore();
  const saves: AgentRunCheckpoint[] = [];
  const deletes: string[] = [];
  let notify: () => void = () => {};
  const cleared = new Promise<void>((resolve) => {
    notify = resolve;
  });
  return {
    inner,
    saves,
    deletes,
    cleared,
    store: {
      save: async (runId, checkpoint) => {
        saves.push(structuredClone(checkpoint));
        await inner.save(runId, checkpoint);
      },
      load: (runId) => inner.load(runId),
      delete: async (runId) => {
        deletes.push(runId);
        notify();
        await inner.delete(runId);
      },
      list: () => inner.list(),
    },
  };
}

/** 收流到尽,保留全部 chunk(与裸流的字节级对照)。 */
export async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/**
 * 假模型的挂起变体:第 `hangAt` 次 doStream 调用永不返回 —— 崩溃现场里 in-flight 的那次模型
 * 调用。每次 doStream 都计数(挂起那次也计);脚本条目只在真正走完的调用上消费,所以恢复的
 * 重发会拿到与崩溃进程相同的回答。
 */
export function hangingModel(
  responses: readonly FakeResponse[],
  hangAt: number,
): { model: Model; inner: FakeModel; attempts: () => number } {
  const inner = fakeModel(responses);
  let attempts = 0;
  return {
    inner,
    attempts: () => attempts,
    model: {
      specificationVersion: 'v4',
      provider: inner.provider,
      modelId: inner.modelId,
      doGenerate: (options) => inner.doGenerate(options),
      doStream: (options) => {
        attempts += 1;
        if (attempts === hangAt) return new Promise<never>(() => {});
        return inner.doStream(options);
      },
    },
  };
}

/**
 * 手工植入的崩溃残留:step 0 边界刚写完、工具尚未执行的现场(stepCount = 0,持有的调用 =
 * step 0 的 call-a;进程死在模型回答之后、工具执行之前)。消息表以 step 0 的 assistant 消息
 * 收尾 —— 恢复要读回的那份现场。
 */
export function seededStepZeroResidue(runId: string): AgentRunCheckpoint {
  return {
    runId,
    stepCount: 0,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'start' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'step zero' },
          { type: 'tool-call', toolCallId: 'call-a', toolName: 'note', input: { value: 'a' } },
        ],
      },
    ],
    toolCalls: [{ type: 'tool-call', toolCallId: 'call-a', toolName: 'note', input: { value: 'a' } }],
  };
}

/**
 * 手工植入的崩溃残留:step 1 已完成的现场(stepCount = 1,持有的调用 = step 1 的 call-b;
 * step 2 的模型调用 in-flight 时进程死了)。消息表逐条为规范形状,以 step 1 的 assistant 消息
 * 收尾 —— 恢复要读回的那份现场。
 */
export function seededResidue(runId: string): AgentRunCheckpoint {
  return {
    runId,
    stepCount: 1,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'start' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'step zero' },
          { type: 'tool-call', toolCallId: 'call-a', toolName: 'note', input: { value: 'a' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-a',
            toolName: 'note',
            output: { type: 'text', value: 'a' },
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'step one' },
          { type: 'tool-call', toolCallId: 'call-b', toolName: 'note', input: { value: 'b' } },
        ],
      },
    ],
    toolCalls: [{ type: 'tool-call', toolCallId: 'call-b', toolName: 'note', input: { value: 'b' } }],
  };
}
