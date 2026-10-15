import { describe, expect, it } from 'vitest';
import { createInMemoryAgentRunCheckpointStore } from '@oribos/checkpoints';
import type { ModelMessage, ToolCallChunk } from '@oribos/core/model';

/**
 * 内存默认 store(#186):端口四方法的基线行为 —— save / load / delete / list。
 *
 * 读写在端口两侧走深拷贝(structuredClone,核心内存默认 store 的同一纪律):存进去的记录再被
 * 调用方改动不影响 store,取出来的记录改动不回落。list 按写入顺序 —— `recoverAll` 的重放顺序
 * 由它定义。
 */

/** save 后可自由改写的可变视图(端口只要求 readonly;测试要拿它当「调用方手里那份」)。 */
interface MutableCheckpoint {
  runId: string;
  messages: ModelMessage[];
  stepCount: number;
  toolCalls: ToolCallChunk[];
  traceId?: string;
}

function checkpoint(runId: string, stepCount = 0): MutableCheckpoint {
  return {
    runId,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    stepCount,
    toolCalls: [
      {
        type: 'tool-call',
        toolCallId: `call-${stepCount}`,
        toolName: 'note',
        input: { value: runId },
      },
    ],
  };
}

describe('createInMemoryAgentRunCheckpointStore:内存默认实现', () => {
  it('load 取到 save 的那条记录;未知 runId 返回 null;同 runId 覆盖', async () => {
    const store = createInMemoryAgentRunCheckpointStore();
    await store.save('run-1', checkpoint('run-1', 2));
    expect(await store.load('run-1')).toEqual(checkpoint('run-1', 2));
    expect(await store.load('run-2')).toBeNull();

    await store.save('run-1', checkpoint('run-1', 3));
    expect((await store.load('run-1'))?.stepCount).toBe(3);
  });

  it('深拷贝:save 后改写调用方对象不影响 load;load 返回值改写不影响 store', async () => {
    const store = createInMemoryAgentRunCheckpointStore();
    const saved = checkpoint('run-1', 1);
    await store.save('run-1', saved);

    saved.messages[0] = { role: 'user', content: [{ type: 'text', text: 'mutated' }] };
    saved.toolCalls[0] = { type: 'tool-call', toolCallId: 'mutated', toolName: 'note', input: null };
    expect(await store.load('run-1')).toEqual(checkpoint('run-1', 1));

    const loaded = (await store.load('run-1')) as MutableCheckpoint;
    loaded.stepCount = 9;
    loaded.messages.length = 0;
    expect((await store.load('run-1'))?.stepCount).toBe(1);
    expect((await store.load('run-1'))?.messages).toEqual(checkpoint('run-1', 1).messages);
  });

  it('list 按写入顺序列出全部记录;delete 单独遗忘一条', async () => {
    const store = createInMemoryAgentRunCheckpointStore();
    await store.save('run-1', checkpoint('run-1', 0));
    await store.save('run-2', checkpoint('run-2', 1));
    await store.save('run-1', checkpoint('run-1', 5));

    const listed = await store.list();
    expect(listed.map((entry) => entry.runId)).toEqual(['run-1', 'run-2']);
    expect(listed[0]?.stepCount).toBe(5);

    await store.delete('run-1');
    expect(await store.load('run-1')).toBeNull();
    expect((await store.list()).map((entry) => entry.runId)).toEqual(['run-2']);
    // 读链已断开的记录:再 delete 是 no-op,不报错。
    await store.delete('run-1');
  });
});
