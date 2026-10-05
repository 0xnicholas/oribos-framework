import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent } from '@oribos/core/agent';
import type { ProcessInputArgs } from '@oribos/core/agent';
import { Memory, createInMemoryStore } from '@oribos/core/memory';
import type { MemoryStore, SaveMessage } from '@oribos/core/memory';
import type { ModelMessage } from '@oribos/core/model';
import { createTool } from '@oribos/core/tools';
import { fakeModel } from '@oribos/testing';
import { captureRejection } from './helpers/assertions.js';
import { INSTRUCTIONS } from './helpers/agent.js';

/**
 * 工作记忆(#41,docs/architecture/memory.md 工作记忆节 + 配置表面节):resource 作用域、
 * schema-only、merge 语义(深合并 / `null` 删字段 / 数组整换)、`updateWorkingMemory` 工具
 * 启用即自动挂载(校验失败走既有「工具错误回喂」语义)、作为独立 system message 注入
 * (追加在 instructions 之后,不改写 instructions 本体)、store 缺条件 2 方法时构造期显式报错。
 *
 * 断言只走公开面:Memory 实例方法、Agent 的 run 结果、假模型录制的 prompt / tools(模型看到的面)、
 * 注入的 store port(落库的面)。合并语义的单元面 = `Memory.updateWorkingMemory`(工具与编程式
 * 更新走同一条语义路径)。
 */

/** 工作记忆 schema:两个必填字段 + 一个可选字段(可选字段是 `null` 删除语义的演示面)。 */
const WM_SCHEMA = z.object({
  profile: z.object({ name: z.string(), city: z.string().optional() }),
  goals: z.array(z.string()),
  tone: z.string().optional(),
});

/** 一份完整的、过 schema 的工作记忆(必填字段齐备)。 */
const FULL = { profile: { name: 'Ada', city: 'SF' }, goals: ['ship #41'] };

function userMessage(text: string): SaveMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/** 启用工作记忆的 Memory 实例(默认内存 store 声明条件 2 能力)。 */
function memoryWithWorkingMemory(storage?: MemoryStore): Memory {
  return new Memory({
    ...(storage === undefined ? {} : { storage }),
    workingMemory: { schema: WM_SCHEMA },
  });
}

/** 只有 6 必备方法的 store:条件 2 缺席(能力标志降级的输入)。 */
function bareStore(): MemoryStore {
  return {
    getThreadById: async () => null,
    saveThread: async () => {},
    deleteThread: async () => {},
    listThreads: async () => [],
    listMessages: async () => [],
    saveMessages: async () => {},
  };
}

/** 取一条 system message 的文本(其余消息类型返回空串,断言面不关心)。 */
function systemContent(message: ModelMessage | undefined): string {
  return message !== undefined && message.role === 'system' ? message.content : '';
}

/** 供注入断言使用的 agent(一条 instructions,一个 scripted 模型)。 */
function agentWith(memory: Memory, model: ReturnType<typeof fakeModel>): Agent {
  return new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model, memory });
}

describe('merge 语义:深合并、null 删字段、数组整换', () => {
  it('空工作记忆 + 首块补丁:落库的是补丁;另一个 resource 互不影响(resource 作用域)', async () => {
    const memory = memoryWithWorkingMemory();

    const stored = await memory.updateWorkingMemory({ resource: 'user-1', patch: FULL });

    expect(stored).toEqual(FULL);
    await expect(memory.getWorkingMemory('user-1')).resolves.toEqual(FULL);
    await expect(memory.getWorkingMemory('user-2')).resolves.toBeUndefined();
  });

  it('未写过工作记忆时是 undefined;首次更新 upsert 出 resource 记录', async () => {
    const store = createInMemoryStore();
    const memory = memoryWithWorkingMemory(store);
    await expect(memory.getWorkingMemory('user-1')).resolves.toBeUndefined();

    await memory.updateWorkingMemory({ resource: 'user-1', patch: FULL });

    const record = await store.getResource('user-1');
    expect(record).toMatchObject({ id: 'user-1', workingMemory: FULL });
    expect(record?.createdAt).toBeInstanceOf(Date);
    expect(record?.updatedAt).toBeInstanceOf(Date);
  });

  it('深合并:补丁只带要改的字段(补丁本身不合整 schema),合成值合规即落库', async () => {
    const memory = memoryWithWorkingMemory();
    await memory.updateWorkingMemory({ resource: 'user-1', patch: FULL });

    const merged = await memory.updateWorkingMemory({
      resource: 'user-1',
      patch: { profile: { city: 'Berlin' } },
    });

    expect(merged).toEqual({ profile: { name: 'Ada', city: 'Berlin' }, goals: ['ship #41'] });
  });

  it('null 删字段:顶层与嵌套都删(删掉可选字段后的形状照常过 schema)', async () => {
    const memory = memoryWithWorkingMemory();
    await memory.updateWorkingMemory({ resource: 'user-1', patch: { ...FULL, tone: 'terse' } });

    const merged = (await memory.updateWorkingMemory({
      resource: 'user-1',
      patch: { tone: null, profile: { city: null } },
    })) as Record<string, unknown>;

    expect(merged).toEqual({ profile: { name: 'Ada' }, goals: ['ship #41'] });
    expect(Object.hasOwn(merged, 'tone')).toBe(false);
    expect(Object.hasOwn(merged['profile'] as object, 'city')).toBe(false);
  });

  it('数组整换:补丁数组替换旧数组,不逐项合并', async () => {
    const memory = memoryWithWorkingMemory();
    await memory.updateWorkingMemory({ resource: 'user-1', patch: { ...FULL, goals: ['a', 'b'] } });

    const merged = await memory.updateWorkingMemory({ resource: 'user-1', patch: { goals: ['c'] } });

    expect(merged).toEqual({ ...FULL, goals: ['c'] });
  });

  it('patch 里 undefined 的字段 = 未提及,保留旧值(JSON 之外的调用方友好)', async () => {
    const memory = memoryWithWorkingMemory();
    await memory.updateWorkingMemory({ resource: 'user-1', patch: { ...FULL, tone: 'terse' } });

    const merged = await memory.updateWorkingMemory({
      resource: 'user-1',
      patch: { tone: undefined },
    });

    expect(merged).toEqual({ ...FULL, tone: 'terse' });
  });

  it('schema 校验失败:显式报错(带 issues 路径),不落库', async () => {
    const store = createInMemoryStore();
    const memory = memoryWithWorkingMemory(store);

    const error = await captureRejection(() =>
      memory.updateWorkingMemory({ resource: 'user-1', patch: { goals: 'nope' } }),
    );

    expect(error.message).toMatch(/working memory/i);
    expect(error.message).toContain('goals');
    await expect(store.getResource('user-1')).resolves.toBeNull();
  });

  it('落库的是 schema 的输出值:未知键按 vendor 语义处理(zod 默认剥离)', async () => {
    const memory = memoryWithWorkingMemory();

    const merged = await memory.updateWorkingMemory({
      resource: 'user-1',
      patch: { ...FULL, extra: 'dropped' },
    });

    expect(merged).toEqual(FULL);
  });
});

describe('resource 记录:upsert 保留既有字段,与 thread 生命周期解耦', () => {
  it('既有 resource 的 metadata / createdAt 原样保留,只刷新 updatedAt', async () => {
    const store = createInMemoryStore();
    const memory = memoryWithWorkingMemory(store);
    const createdAt = new Date(1_700_000_000_000);
    await store.saveResource({
      id: 'user-1',
      metadata: { tier: 'pro' },
      createdAt,
      updatedAt: createdAt,
    });

    await memory.updateWorkingMemory({ resource: 'user-1', patch: FULL });

    const record = await store.getResource('user-1');
    expect(record?.metadata).toEqual({ tier: 'pro' });
    expect(record?.createdAt).toEqual(createdAt);
    expect(record?.updatedAt.getTime()).toBeGreaterThan(createdAt.getTime());
  });

  it('删 thread 不动 resource 级数据(工作记忆与消息历史各自的生命周期)', async () => {
    const store = createInMemoryStore();
    const memory = memoryWithWorkingMemory(store);
    await memory.updateWorkingMemory({ resource: 'user-1', patch: FULL });
    await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [userMessage('hi')],
    });

    await store.deleteThread('thread-1');

    await expect(memory.getWorkingMemory('user-1')).resolves.toEqual(FULL);
    await expect(memory.recall({ threadId: 'thread-1' })).resolves.toEqual([]);
  });
});

describe('能力标志降级:启用 WM 但 store 无条件 2 方法 → 构造期显式报错', () => {
  it('仅 6 必备方法的 store:启用 WM 即报错(显式,不静默降级);不启用则照常可用', () => {
    expect(() => new Memory({ storage: bareStore(), workingMemory: { schema: WM_SCHEMA } })).toThrow(
      /getResource\/saveResource/,
    );
    expect(() => new Memory({ storage: bareStore() })).not.toThrow();
  });

  it('条件 2 只实现一只 = 缺席(成对检测),同样报错', () => {
    const half: MemoryStore = { ...bareStore(), getResource: async () => null };
    expect(() => new Memory({ storage: half, workingMemory: { schema: WM_SCHEMA } })).toThrow(
      /getResource\/saveResource/,
    );
  });

  it('未配置工作记忆时,读 / 写方法显式报错(不静默无操作)', async () => {
    const memory = new Memory();
    await expect(memory.getWorkingMemory('user-1')).rejects.toThrow(/workingMemory/);
    await expect(memory.updateWorkingMemory({ resource: 'user-1', patch: {} })).rejects.toThrow(
      /workingMemory/,
    );
  });
});

describe('注入:独立 system message,追加在 instructions 之后', () => {
  it('已记忆的 resource:WM 是第二条 system message(instructions 之后、历史之前),instructions 不被改写', async () => {
    const memory = memoryWithWorkingMemory();
    await memory.updateWorkingMemory({ resource: 'user-1', patch: FULL });
    await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [userMessage('earlier question')],
    });
    const model = fakeModel([{ text: 'ok' }]);
    const agent = agentWith(memory, model);

    await agent.generate('current question', {
      memory: { thread: 'thread-1', resource: 'user-1' },
    });

    const prompt = model.streamCalls[0]?.prompt ?? [];
    expect(prompt[0]).toEqual({ role: 'system', content: INSTRUCTIONS });
    expect(prompt[1]?.role).toBe('system');
    expect(systemContent(prompt[1])).toContain(JSON.stringify(FULL));
    expect(systemContent(prompt[1])).toContain('updateWorkingMemory');
    expect(prompt[2]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'earlier question' }],
    });
    expect(prompt[3]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'current question' }],
    });
  });

  it('注入先于 processInput:输入处理器看到的 prompt 已含工作记忆', async () => {
    const memory = memoryWithWorkingMemory();
    await memory.updateWorkingMemory({ resource: 'user-1', patch: FULL });
    const seen: ProcessInputArgs[] = [];
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel([{ text: 'ok' }]),
      memory,
      processors: [{ processInput: (args) => void seen.push(args) }],
    });

    await agent.generate('hi', { memory: { thread: 'thread-1', resource: 'user-1' } });

    expect(seen[0]?.messages[1]?.role).toBe('system');
    expect(systemContent(seen[0]?.messages[1])).toContain(JSON.stringify(FULL));
  });

  it('resource 没有工作记忆:不注入空消息(prompt 只有 instructions + 本次输入)', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const agent = agentWith(memoryWithWorkingMemory(), model);

    await agent.generate('hi', { memory: { thread: 'thread-1', resource: 'user-1' } });

    expect(model.streamCalls[0]?.prompt).toMatchObject([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ]);
  });

  it('run 无 per-call identity:无状态 run,WM 既不注入也不挂工具', async () => {
    const memory = memoryWithWorkingMemory();
    await memory.updateWorkingMemory({ resource: 'user-1', patch: FULL });
    const model = fakeModel([{ text: 'ok' }]);
    const agent = agentWith(memory, model);

    await agent.generate('stateless input');

    expect(model.streamCalls[0]?.prompt).toMatchObject([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'stateless input' }] },
    ]);
    expect(model.streamCalls[0]?.tools).toBeUndefined();
  });
});

describe('updateWorkingMemory 工具:启用 WM 时自动挂载', () => {
  it('工具随 WM 启用出现:名字 + 入参 schema(原 schema 原样直通,零改写)', async () => {
    const tiny = z.object({ tone: z.string().optional() });
    const memory = new Memory({ workingMemory: { schema: tiny } });
    const model = fakeModel([{ text: 'ok' }]);
    const agent = agentWith(memory, model);

    await agent.generate('hi', { memory: { thread: 'thread-1', resource: 'user-1' } });

    const tools = model.streamCalls[0]?.tools ?? [];
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      type: 'function',
      name: 'updateWorkingMemory',
      description: expect.stringContaining('merge'),
    });
    const tool = tools[0];
    if (tool?.type !== 'function') throw new Error('expected a function tool');
    // 模型看到的 JSON Schema 就是转换器的产物:核心不包装、不改写(ADR-0003)
    expect(tool.inputSchema).toEqual(tiny['~standard'].jsonSchema.input({ target: 'draft-07' }));
  });

  it('递归 schema 同样原样直通:$ref 仍指向模型看到的根,不被容器改道', async () => {
    interface Node {
      name: string;
      child?: Node | undefined;
    }
    const node: z.ZodType<Node> = z.object({
      name: z.string(),
      get child() {
        return node.optional();
      },
    });
    const model = fakeModel([{ text: 'ok' }]);
    const agent = agentWith(new Memory({ workingMemory: { schema: node } }), model);

    await agent.generate('hi', { memory: { thread: 'thread-1', resource: 'user-1' } });

    const tool = model.streamCalls[0]?.tools?.[0];
    if (tool?.type !== 'function') throw new Error('expected a function tool');
    const jsonSchema = node['~standard'].jsonSchema.input({ target: 'draft-07' });
    // 该 schema 确实带根相对 $ref:放进任何容器都会让 '#' 改道,直通不会
    expect(JSON.stringify(jsonSchema)).toContain('"$ref":"#"');
    expect(tool.inputSchema).toEqual(jsonSchema);
  });

  it('工具与用户工具容器共存:框架工具追加在用户工具之后', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory: memoryWithWorkingMemory(),
      tools: { weather: createTool({ description: 'Looks up the weather.', execute: () => 21 }) },
    });

    await agent.generate('hi', { memory: { thread: 'thread-1', resource: 'user-1' } });

    expect(model.streamCalls[0]?.tools?.map((tool) => tool.name)).toEqual([
      'weather',
      'updateWorkingMemory',
    ]);
  });

  it('已配置 WM 但本次 run 不带 identity:不挂工具(无状态 run 的工具面不变)', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const agent = agentWith(memoryWithWorkingMemory(), model);

    await agent.generate('hi');

    expect(model.streamCalls[0]?.tools).toBeUndefined();
  });

  it('未配置 WM:即便带 identity 也不挂工具(消息历史单独成立)', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const agent = agentWith(new Memory(), model);

    await agent.generate('hi', { memory: { thread: 'thread-1', resource: 'user-1' } });

    expect(model.streamCalls[0]?.tools).toBeUndefined();
  });

  it('用户容器里已有同名工具:run 显式报错,不静默覆盖(模型不被调用)', async () => {
    const model = fakeModel([{ text: 'never sent' }]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory: memoryWithWorkingMemory(),
      tools: {
        updateWorkingMemory: createTool({ description: 'Mine.', execute: () => 'mine' }),
      },
    });

    const error = await captureRejection(() =>
      agent.generate('hi', { memory: { thread: 'thread-1', resource: 'user-1' } }),
    );

    expect(error.message).toContain("already has a tool named 'updateWorkingMemory'");
    expect(model.streamCalls).toHaveLength(0);
  });
});

describe('工具更新:合并落库,结果与错误回喂', () => {
  it('模型调用 updateWorkingMemory:合并结果落库,工具结果(合并后的值)回喂下一步', async () => {
    const memory = memoryWithWorkingMemory();
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'updateWorkingMemory', input: FULL }] },
      { text: 'noted' },
    ]);
    const agent = agentWith(memory, model);

    const result = await agent.generate('remember me', {
      memory: { thread: 'thread-1', resource: 'user-1' },
    });

    expect(result.text).toBe('noted');
    await expect(memory.getWorkingMemory('user-1')).resolves.toEqual(FULL);
    expect(model.streamCalls[1]?.prompt).toContainEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'updateWorkingMemory',
          output: { type: 'json', value: FULL },
        },
      ],
    });
  });

  it('null 删字段经工具生效,回喂的是合并后的值', async () => {
    const memory = memoryWithWorkingMemory();
    await memory.updateWorkingMemory({ resource: 'user-1', patch: { ...FULL, tone: 'terse' } });
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'updateWorkingMemory', input: { tone: null } }] },
      { text: 'forgotten' },
    ]);
    const agent = agentWith(memory, model);

    await agent.generate('drop the tone', { memory: { thread: 'thread-1', resource: 'user-1' } });

    await expect(memory.getWorkingMemory('user-1')).resolves.toEqual(FULL);
    expect(model.streamCalls[1]?.prompt).toContainEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'updateWorkingMemory',
          output: { type: 'json', value: FULL },
        },
      ],
    });
  });

  it('校验失败按工具错误回喂:error 工具结果带 issues、run 不中止,下一步可修正并落库', async () => {
    const memory = memoryWithWorkingMemory();
    const model = fakeModel([
      {
        toolCalls: [
          { toolCallId: 'call-1', toolName: 'updateWorkingMemory', input: { goals: 'nope' } },
        ],
      },
      { toolCalls: [{ toolCallId: 'call-2', toolName: 'updateWorkingMemory', input: FULL }] },
      { text: 'fixed' },
    ]);
    const agent = agentWith(memory, model);

    const result = await agent.generate('remember me', {
      memory: { thread: 'thread-1', resource: 'user-1' },
    });

    expect(result.text).toBe('fixed');
    const [failed, fixed] = result.toolResults;
    expect(failed?.isError).toBe(true);
    expect(String(failed?.output)).toContain("Tool 'updateWorkingMemory' failed");
    expect(String(failed?.output)).toContain('goals');
    expect(fixed?.isError).toBe(false);
    // 失败那次什么都没写,修正那次落了库
    await expect(memory.getWorkingMemory('user-1')).resolves.toEqual(FULL);
    // 错误文本进了下一步的 prompt:模型能读到并恢复
    expect(JSON.stringify(model.streamCalls[1]?.prompt)).toContain("Tool 'updateWorkingMemory' failed");
  });

  it('resource 作用域:同一 resource 的另一个 thread 的下一个 run 读到前次落下的工作记忆', async () => {
    const memory = memoryWithWorkingMemory();
    const first = agentWith(
      memory,
      fakeModel([
        { toolCalls: [{ toolCallId: 'call-1', toolName: 'updateWorkingMemory', input: FULL }] },
        { text: 'noted' },
      ]),
    );
    await first.generate('remember me', { memory: { thread: 'thread-a', resource: 'user-1' } });

    const secondModel = fakeModel([{ text: 'ok' }]);
    const second = agentWith(memory, secondModel);
    await second.generate('what do you know?', {
      memory: { thread: 'thread-b', resource: 'user-1' },
    });

    expect(systemContent(secondModel.streamCalls[0]?.prompt[1])).toContain(JSON.stringify(FULL));
    expect(secondModel.streamCalls[0]?.tools?.map((tool) => tool.name)).toEqual([
      'updateWorkingMemory',
    ]);
  });
});
