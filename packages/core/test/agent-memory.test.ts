import { describe, expect, it } from 'vitest';
import { Agent } from '@oribos/core/agent';
import type { AgentMemoryOptions, ProcessInputArgs, RequestContext } from '@oribos/core/agent';
import { Memory, createInMemoryStore } from '@oribos/core/memory';
import type { MemoryStore, SaveMessage } from '@oribos/core/memory';
import { createTool } from '@oribos/core/tools';
import { fakeModel } from '@oribos/testing';
import { captureRejection } from './helpers/assertions.js';

/**
 * Agent 的 memory 集成(#40,docs/architecture/memory.md 身份模型节 + 消息历史时机/顺序语义 +
 * 配置表面节):`AgentConfig.memory` 持有实例,per-call `memory: { thread, resource }` 给出本次
 * run 的身份 —— recall 每 run 一次(run 开始、processInput 之前),save 每 step 一次
 * (processOutputStep 之后,首轮含用户输入消息)。断言只走公开面:假模型录制的 prompt 是
 * "模型看到的历史"(recall 注入的证据),Memory 的 recall 是"已落库"的证据,注入的 store port
 * 是 thread 生命周期的观察口(注入的 store 是调用方自己的对象,不是实现内部)。
 */

const INSTRUCTIONS = 'You are concise.';

function userMessage(text: string): SaveMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantMessage(text: string): SaveMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

/** 计数 store:包一层默认内存实现,记录 port 调用次数(recall = listMessages,save = saveMessages)。 */
function countingStore(): MemoryStore & {
  readonly calls: { listMessages: number; saveMessages: number; saveThread: number };
} {
  const inner = createInMemoryStore();
  const calls = { listMessages: 0, saveMessages: 0, saveThread: 0 };
  return {
    getThreadById: (id) => inner.getThreadById(id),
    saveThread: (thread) => {
      calls.saveThread += 1;
      return inner.saveThread(thread);
    },
    deleteThread: (id) => inner.deleteThread(id),
    listThreads: (query) => inner.listThreads(query),
    listMessages: (query) => {
      calls.listMessages += 1;
      return inner.listMessages(query);
    },
    saveMessages: (messages) => {
      calls.saveMessages += 1;
      return inner.saveMessages(messages);
    },
    calls,
  };
}

describe('recall:每 run 一次,run 开始、processInput 之前', () => {
  it('历史按时间正序注入 instructions 之后、本次输入之前;processInput 看到的 prompt 已含历史', async () => {
    const memory = new Memory();
    await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [userMessage('earlier question'), assistantMessage('earlier answer')],
    });
    const model = fakeModel([{ text: 'current answer' }]);
    const seen: ProcessInputArgs[] = [];
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory,
      processors: [{ processInput: (args) => void seen.push(args) }],
    });

    const result = await agent.generate('current question', {
      memory: { thread: 'thread-1', resource: 'user-1' },
    });

    const expected = [
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'earlier question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'current question' }] },
    ];
    expect(result.text).toBe('current answer');
    // 顺序即契约:instructions → 历史(时间正序)→ 本次输入
    expect(model.streamCalls[0]?.prompt).toMatchObject(expected);
    // recall 先于 processInput:输入处理器看到的 prompt 已含历史
    expect(seen).toHaveLength(1);
    expect(seen[0]?.messages).toMatchObject(expected);
  });

  it('每 run 恰好 recall 一次(store 的 listMessages 每 run 一次)', async () => {
    const store = countingStore();
    const memory = new Memory({ storage: store });
    await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [userMessage('earlier question')],
    });
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel([{ text: 'ok' }]),
      memory,
    });

    await agent.generate('hi', { memory: { thread: 'thread-1', resource: 'user-1' } });
    expect(store.calls.listMessages).toBe(1);
  });
});

describe('save:每 step 一次,processOutputStep 之后,首轮含用户输入消息', () => {
  it('多步 run 的消息逐步入库:用户输入 + 每步 assistant/tool 消息,recall 原样读回', async () => {
    const memory = new Memory();
    const model = fakeModel([
      {
        text: 'Let me check.',
        toolCalls: [{ toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } }],
      },
      { text: 'It is 21°C.' },
    ]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory,
      tools: {
        weather: createTool({ description: 'Looks up the weather.', execute: () => ({ celsius: 21 }) }),
      },
    });

    await agent.generate('What is the weather in SF?', {
      memory: { thread: 'thread-1', resource: 'user-1' },
    });

    const persisted = (await memory.recall({ threadId: 'thread-1' })).map(({ role, content }) => ({
      role,
      content,
    }));
    expect(persisted).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'What is the weather in SF?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'weather',
            output: { type: 'json', value: { celsius: 21 } },
          },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'It is 21°C.' }] },
    ]);
  });

  it('每个 step 一次 save:两步 run 的 saveMessages = 2(增量落库,不是 run 末一次性写入)', async () => {
    const store = countingStore();
    const memory = new Memory({ storage: store });
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'ping', input: {} }] },
      { text: 'done' },
    ]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory,
      tools: { ping: createTool({ description: 'Pings.', execute: () => 'pong' }) },
    });

    await agent.generate('go', { memory: { thread: 'thread-1', resource: 'user-1' } });

    expect(store.calls.saveMessages).toBe(2);
  });

  it('maxSteps 截断的末步也完整落库:工具结果与 call 成对(供后续 recall 回喂)', async () => {
    const memory = new Memory();
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'ping', input: {} }] },
    ]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory,
      tools: { ping: createTool({ description: 'Pings.', execute: () => 'pong' }) },
    });

    const result = await agent.generate('go', {
      maxSteps: 1,
      memory: { thread: 'thread-1', resource: 'user-1' },
    });

    expect(result.finishReason).toBe('tool-calls');
    const persisted = (await memory.recall({ threadId: 'thread-1' })).map(({ role, content }) => ({
      role,
      content,
    }));
    expect(persisted).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'ping', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'ping',
            output: { type: 'text', value: 'pong' },
          },
        ],
      },
    ]);
  });

  it('空白 step 不落空消息:模型只回 finish 时,首轮流库只有用户输入', async () => {
    const memory = new Memory();
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel([{}]),
      memory,
    });

    await agent.generate('hi', { memory: { thread: 'thread-1', resource: 'user-1' } });

    const persisted = (await memory.recall({ threadId: 'thread-1' })).map(({ role, content }) => ({
      role,
      content,
    }));
    expect(persisted).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });
});

describe('thread 生命周期:不存在自动创建,失败 run 不落库', () => {
  it('per-call thread 对象携带 title / metadata:首次 save 创建 thread,resource 归属随参数盖章', async () => {
    const store = countingStore();
    const memory = new Memory({ storage: store });
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel([{ text: 'ok' }]),
      memory,
    });

    await agent.generate('hi', {
      memory: {
        thread: { id: 'thread-1', title: 'first chat', metadata: { source: 'test' } },
        resource: 'user-1',
      },
    });

    const thread = await store.getThreadById('thread-1');
    expect(thread).toMatchObject({
      id: 'thread-1',
      resourceId: 'user-1',
      title: 'first chat',
      metadata: { source: 'test' },
    });
    expect(thread?.createdAt).toBeInstanceOf(Date);
  });

  it('recall 不创建 thread;首步未完成的失败 run 不落库(store 仍空)', async () => {
    const store = countingStore();
    const memory = new Memory({ storage: store });
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel([{ fail: new Error('provider down') }]),
      memory,
    });

    const error = await captureRejection(() =>
      agent.generate('hi', { memory: { thread: 'thread-1', resource: 'user-1' } }),
    );

    expect(error.message).toContain('provider down');
    // recall 跑了(读未知 thread 作空历史),但什么都没写
    expect(store.calls.listMessages).toBe(1);
    expect(store.calls.saveMessages).toBe(0);
    expect(store.calls.saveThread).toBe(0);
    await expect(store.getThreadById('thread-1')).resolves.toBeNull();
  });
});

describe('per-call 校验与失败语义:调用期显式报错,不静默', () => {
  it('传了 memory 却没有配置实例:调用期报错,不发起模型调用', async () => {
    const model = fakeModel([{ text: 'never sent' }]);
    const agent = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model });

    await expect(
      agent.generate('hi', { memory: { thread: 'thread-1', resource: 'user-1' } }),
    ).rejects.toThrow(/no memory configured/);
    expect(model.streamCalls).toHaveLength(0);
  });

  it('identity 缺 thread 或 resource:调用期显式报错(不默认、不半兑现)', async () => {
    const model = fakeModel([{ text: 'never sent' }, { text: 'never sent' }, { text: 'never sent' }]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory: new Memory(),
    });

    await expect(
      agent.generate('hi', { memory: { thread: 'thread-1' } as AgentMemoryOptions }),
    ).rejects.toThrow(/missing its resource/);
    await expect(
      agent.generate('hi', { memory: { resource: 'user-1' } as AgentMemoryOptions }),
    ).rejects.toThrow(/missing its thread/);
    await expect(
      agent.generate('hi', { memory: { thread: '', resource: 'user-1' } }),
    ).rejects.toThrow(/missing its thread/);
    await expect(
      agent.generate('hi', { memory: { thread: 'thread-1', resource: '' } }),
    ).rejects.toThrow(/missing its resource/);
    expect(model.streamCalls).toHaveLength(0);
  });

  it('thread 归属其他 resource:save 抛错,run 随之失败(错误不吞)', async () => {
    const memory = new Memory();
    await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [userMessage('first owner')],
    });
    const model = fakeModel([{ text: 'ok' }]);
    const agent = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model, memory });

    const error = await captureRejection(() =>
      agent.generate('hi', { memory: { thread: 'thread-1', resource: 'user-2' } }),
    );

    expect(error.message).toMatch(/belongs to resource 'user-1'/);
    // 模型调用已发生(save 在其后),但新消息没有写进去
    expect(model.streamCalls).toHaveLength(1);
    const persisted = await memory.recall({ threadId: 'thread-1' });
    expect(persisted).toHaveLength(1);
  });
});

describe('组合语义:无 per-call identity 即无状态,实例可逐 run 解析、可多 agent 共享', () => {
  it('配了 memory 但本次 run 不传 per-call identity:无状态 run——不注入历史、不落库', async () => {
    const memory = new Memory();
    await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [userMessage('earlier question')],
    });
    const model = fakeModel([{ text: 'ok' }]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory,
    });

    await agent.generate('stateless input');

    expect(model.streamCalls[0]?.prompt).toMatchObject([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'stateless input' }] },
    ]);
    // 本次 run 什么都没写:历史原样
    const persisted = await memory.recall({ threadId: 'thread-1' });
    expect(persisted).toHaveLength(1);
  });

  it('memory 是动态参数:逐 run 解析,两次 run 命中各自实例', async () => {
    const proMemory = new Memory();
    const cheapMemory = new Memory();
    const model = fakeModel([{ text: 'pro answer' }, { text: 'cheap answer' }]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory: (ctx) => (ctx.tier === 'pro' ? proMemory : cheapMemory),
    });

    await agent.generate('pro input', {
      tier: 'pro',
      memory: { thread: 'thread-1', resource: 'user-1' },
    });
    await agent.generate('cheap input', {
      tier: 'free',
      memory: { thread: 'thread-1', resource: 'user-1' },
    });

    const contents = async (memory: Memory): Promise<unknown[]> =>
      (await memory.recall({ threadId: 'thread-1' })).map(({ content }) => content);
    expect(await contents(proMemory)).toEqual([
      [{ type: 'text', text: 'pro input' }],
      [{ type: 'text', text: 'pro answer' }],
    ]);
    expect(await contents(cheapMemory)).toEqual([
      [{ type: 'text', text: 'cheap input' }],
      [{ type: 'text', text: 'cheap answer' }],
    ]);
  });

  it('recall 走实例自己的 lastMessages 窗口:只注入最近 N 条,再拼本次输入', async () => {
    const memory = new Memory({ lastMessages: 2 });
    await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [userMessage('m1'), userMessage('m2'), userMessage('m3')],
    });
    const model = fakeModel([{ text: 'ok' }]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory,
    });

    await agent.generate('current', {
      memory: { thread: 'thread-1', resource: 'user-1' },
    });

    expect(model.streamCalls[0]?.prompt).toMatchObject([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'm2' }] },
      { role: 'user', content: [{ type: 'text', text: 'm3' }] },
      { role: 'user', content: [{ type: 'text', text: 'current' }] },
    ]);
  });

  it('同一 Memory 实例可被多 agent 共享:agent B 的 run 读到 agent A 落下的历史', async () => {
    const memory = new Memory();
    const agentA = new Agent({
      name: 'a',
      instructions: 'A.',
      model: fakeModel([{ text: 'from A' }]),
      memory,
    });
    await agentA.generate('hello', {
      memory: { thread: 'shared-thread', resource: 'user-1' },
    });

    const modelB = fakeModel([{ text: 'from B' }]);
    const agentB = new Agent({ name: 'b', instructions: 'B.', model: modelB, memory });
    await agentB.generate('follow-up', {
      memory: { thread: 'shared-thread', resource: 'user-1' },
    });

    expect(modelB.streamCalls[0]?.prompt).toMatchObject([
      { role: 'system', content: 'B.' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'from A' }] },
      { role: 'user', content: [{ type: 'text', text: 'follow-up' }] },
    ]);
  });

  it('per-call memory 不进 RequestContext:工具 ctx 里看不到 memory / thread / resource', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'probe', input: {} }] },
      { text: 'done' },
    ]);
    let context: RequestContext | undefined;
    const probe = createTool({
      description: 'Probes.',
      execute: (_input, ctx) => {
        context = ctx.requestContext;
        return 'ok';
      },
    });
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory: new Memory(),
      tools: { probe },
    });

    await agent.generate('go', {
      memory: { thread: 'thread-1', resource: 'user-1' },
      userId: 'u-9',
    });

    expect(context).toMatchObject({ userId: 'u-9' });
    expect(context).not.toHaveProperty('memory');
    expect(context).not.toHaveProperty('thread');
    expect(context).not.toHaveProperty('resource');
  });
});

describe('顺序语义与消息形状:改写后才落库,provider 结果与调用成对', () => {
  it('processOutputStep 先于 save:改写后的记录才是落库内容(脱敏在落库前生效)', async () => {
    const memory = new Memory();
    const model = fakeModel([{ text: 'the secret is 42' }]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory,
      processors: [
        {
          processOutputStep: ({ step }) => ({
            step: { ...step, text: step.text.replace('42', 'REDACTED') },
          }),
        },
      ],
    });

    const result = await agent.generate('what is it?', {
      memory: { thread: 'thread-1', resource: 'user-1' },
    });

    expect(result.text).toBe('the secret is REDACTED');
    const persisted = await memory.recall({ threadId: 'thread-1' });
    expect(persisted.at(-1)?.content).toEqual([{ type: 'text', text: 'the secret is REDACTED' }]);
  });

  it('provider 自己执行的工具结果留在 assistant 消息里(与 tool-call 成对落库)', async () => {
    const memory = new Memory();
    const model = fakeModel([
      {
        toolCalls: [{ toolCallId: 'call-1', toolName: 'search', input: { q: 'x' } }],
        toolResults: [{ toolCallId: 'call-1', toolName: 'search', result: { hits: 2 } }],
      },
    ]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory,
    });

    const result = await agent.generate('search it', {
      memory: { thread: 'thread-1', resource: 'user-1' },
    });

    // provider 已执行 → 无 client-side 待办,run 单步收束
    expect(result.finishReason).toBe('tool-calls');
    const persisted = (await memory.recall({ threadId: 'thread-1' })).map(({ role, content }) => ({
      role,
      content,
    }));
    expect(persisted).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'search it' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'search', input: { q: 'x' } },
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'search',
            output: { type: 'json', value: { hits: 2 } },
          },
        ],
      },
    ]);
  });

  it('输入是消息数组:整组随首轮流库(不发明新形状)', async () => {
    const memory = new Memory();
    const model = fakeModel([{ text: 'ok' }]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory,
    });

    await agent.generate(
      [
        { role: 'user', content: [{ type: 'text', text: 'one' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
        { role: 'user', content: [{ type: 'text', text: 'three' }] },
      ],
      { memory: { thread: 'thread-1', resource: 'user-1' } },
    );

    const persisted = (await memory.recall({ threadId: 'thread-1' })).map(({ role, content }) => ({
      role,
      content,
    }));
    expect(persisted).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      { role: 'user', content: [{ type: 'text', text: 'three' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]);
    expect(model.streamCalls[0]?.prompt).toMatchObject([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      { role: 'user', content: [{ type: 'text', text: 'three' }] },
    ]);
  });
});
