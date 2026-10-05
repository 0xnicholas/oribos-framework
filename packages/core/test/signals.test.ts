import { describe, expect, it, vi } from 'vitest';
import { Agent } from '@oribos/core/agent';
import type { AgentMemoryOptions } from '@oribos/core/agent';
import { Memory } from '@oribos/core/memory';
import { AGENT_RUN_SPAN, createTracer, memoryExporter } from '@oribos/core/observability';
import { createSignals } from '@oribos/core/signals';
import { createTool } from '@oribos/core/tools';
import { fakeModel } from '@oribos/testing';
import { INSTRUCTIONS } from './helpers/agent.js';
import { eventsOfType, kinds, spanOfType } from './helpers/spans.js';

/**
 * signals 基础层(M4 #58,`docs/architecture/harness.md`「Signals」节):`createSignals({ agent,
 * memory?, tracer? })` 四方法,语义固定三句——活跃 = 注入当前 run(下一 step 生效);空闲 = 唤醒
 * 新 run;queueMessage = 排队保序。单进程语义(内存 pubsub + thread → 活跃 run 注册表);注入/唤醒
 * 内容落消息历史(复用 MemoryStore);memory 缺席时唤醒 = 无历史新 run。断言只走公开面
 * (@oribos/core/signals 子路径)与脚本化假模型接缝;历史断言走真实 Memory 实例的 recall。
 */

/** 目标 thread/resource(与 per-call memory 身份同形)。 */
const TARGET: AgentMemoryOptions = { thread: 't1', resource: 'u1' };

/** memory-configured agent 工厂:signals 的 memory 契约 = agent 挂同一实例。 */
function memoryAgent(model: ReturnType<typeof fakeModel>, memory: Memory): Agent {
  return new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model, memory });
}

/** 外部可控的 deferred:测试用它把 run 按在工具执行中间(活跃窗口)。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onValue) => {
    resolve = onValue;
  });
  return { promise, resolve };
}

/** 一个会等到外部放行才返回的工具:把 run 按在工具执行中间。 */
function gateTool(gate: Promise<void>) {
  return createTool({ description: 'Waits for the gate.', execute: () => gate });
}

describe('signals:注入(活跃 = 注入当前 run,下一 step 生效)', () => {
  it('sendMessage 打向活跃 run:消息进入下一次模型调用的 prompt 尾部,并落历史可 recall', async () => {
    const model = fakeModel([
      { text: 'Working.', toolCalls: [{ toolCallId: 'call-1', toolName: 'wait', input: {} }] },
      { text: 'Done.' },
    ]);
    const memory = new Memory();
    const gate = deferred<void>();
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory,
      tools: { wait: gateTool(gate.promise) },
    });
    const signals = createSignals({ agent, memory });

    const run = signals.stream('Start.', { memory: TARGET });
    const text = run.text; // 读取终值即启动 run
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(1));
    // run 活跃于 t1:注入而非唤醒——sendMessage 不等 run 完成
    await signals.sendMessage(TARGET, 'New info!');
    gate.resolve();
    expect(await text).toBe('Done.');

    // 注入消息成为第二次模型调用 prompt 的尾部(下一 step 生效)
    expect(model.streamCalls[1]?.prompt.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'New info!' }],
    });
    // 且作为普通消息落历史(loop 不保存注入消息,保存者是 signals)
    const stored = await memory.recall({ threadId: 't1' });
    expect(stored.map((message) => message.content)).toContainEqual([
      { type: 'text', text: 'New info!' },
    ]);
  });
});

describe('signals:排队(queueMessage = 排队保序)', () => {
  it('活跃期排队的消息:等 run 完再开一个续跑 run,按到达顺序作其输入', async () => {
    const model = fakeModel([
      { text: 'Working.', toolCalls: [{ toolCallId: 'call-1', toolName: 'wait', input: {} }] },
      { text: 'First done.' },
      { text: 'Continuation noted.' },
    ]);
    const memory = new Memory();
    const gate = deferred<void>();
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory,
      tools: { wait: gateTool(gate.promise) },
    });
    const signals = createSignals({ agent, memory });

    const text = signals.stream('Start.', { memory: TARGET }).text;
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(1));
    await signals.queueMessage(TARGET, 'first');
    await signals.queueMessage(TARGET, 'second');
    gate.resolve();
    expect(await text).toBe('First done.');

    // 续跑 run = 第三个模型调用:排队两条按序作输入(此前历史已 recall)
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(3));
    const continuationPrompt = model.streamCalls[2]?.prompt!;
    expect(continuationPrompt.slice(-2)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ]);
    // 排队消息不重不漏地落历史一次(续跑 run 自存输入,signals 不另存)
    await vi.waitFor(async () => {
      const stored = await memory.recall({ threadId: 't1' });
      expect(stored.filter((message) => message.role === 'user').map((message) => message.content)).toEqual(
        [
          [{ type: 'text', text: 'Start.' }],
          [{ type: 'text', text: 'first' }],
          [{ type: 'text', text: 'second' }],
        ],
      );
    });
  });

  it('queueMessage 打向空闲 thread:直接唤醒(与 sendMessage 同路)', async () => {
    const model = fakeModel([{ text: 'Noted.' }]);
    const memory = new Memory();
    const signals = createSignals({ agent: memoryAgent(model, memory), memory });

    await signals.queueMessage(TARGET, 'queued while idle');

    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(1));
    expect(model.streamCalls[0]?.prompt.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'queued while idle' }],
    });
  });
});

describe('signals:系统信号(sendSignal,type 开放)', () => {
  it('sendSignal 打向空闲 thread:payload 渲染为一条普通用户消息,唤醒 run', async () => {
    const model = fakeModel([{ text: 'Noted.' }]);
    const memory = new Memory();
    const signals = createSignals({ agent: memoryAgent(model, memory), memory });

    await signals.sendSignal(TARGET, { type: 'notification', source: 'github', pr: 123 });

    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(1));
    const rendered = '[signal] {"type":"notification","source":"github","pr":123}';
    expect(model.streamCalls[0]?.prompt.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: rendered }],
    });
    // 渲染消息随唤醒 run 落历史一次
    await vi.waitFor(async () => {
      const stored = await memory.recall({ threadId: 't1' });
      expect(stored.map((message) => message.content)).toContainEqual([
        { type: 'text', text: rendered },
      ]);
    });
  });

  it('sendSignal 打向活跃 run:与 sendMessage 同一注入路(渲染消息进 prompt 尾部)', async () => {
    const model = fakeModel([
      { text: 'Working.', toolCalls: [{ toolCallId: 'call-1', toolName: 'wait', input: {} }] },
      { text: 'Done.' },
    ]);
    const memory = new Memory();
    const gate = deferred<void>();
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory,
      tools: { wait: gateTool(gate.promise) },
    });
    const signals = createSignals({ agent, memory });

    const text = signals.stream('Start.', { memory: TARGET }).text;
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(1));
    await signals.sendSignal(TARGET, { type: 'wake-up' });
    gate.resolve();
    expect(await text).toBe('Done.');

    expect(model.streamCalls[1]?.prompt.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '[signal] {"type":"wake-up"}' }],
    });
  });
});

describe('signals:订阅(subscribeToThread)', () => {
  it('订阅先于唤醒:唤醒 run 的 chunk 依序流入;退订(return)后不再接收', async () => {
    const model = fakeModel([{ text: 'Hello.' }]);
    const memory = new Memory();
    const signals = createSignals({ agent: memoryAgent(model, memory), memory });

    const iterator = signals.subscribeToThread(TARGET)[Symbol.asyncIterator]();
    await signals.sendMessage(TARGET, 'wake');

    // 唤醒 run 的 chunk 协议原样流入订阅:text-delta + finish,依流序
    expect(await iterator.next()).toEqual({ value: { type: 'text-delta', textDelta: 'Hello.' }, done: false });
    const finish = await iterator.next();
    expect(finish.done).toBe(false);
    expect(finish.value).toMatchObject({ type: 'finish', finishReason: 'stop' });

    // 退订 = 迭代器 return:此后 next 直接 done,push 不再抵达
    expect(await iterator.return?.()).toEqual({ value: undefined, done: true });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it('run 进行中订阅:从订阅时刻起接收(无重放),已流过的 chunk 不补发', async () => {
    const model = fakeModel([
      { text: 'Working.', toolCalls: [{ toolCallId: 'call-1', toolName: 'wait', input: {} }] },
      { text: 'Done.' },
    ]);
    const memory = new Memory();
    const gate = deferred<void>();
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory,
      tools: { wait: gateTool(gate.promise) },
    });
    const signals = createSignals({ agent, memory });

    const text = signals.stream('Start.', { memory: TARGET }).text;
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(1));
    // 步 0 的 chunk 已流过;此刻订阅只能看到之后的内容(门放行后:工具结果 → 步 1)
    const iterator = signals.subscribeToThread(TARGET)[Symbol.asyncIterator]();
    gate.resolve();
    expect(await text).toBe('Done.');

    const first = await iterator.next();
    expect(first.value).toMatchObject({ type: 'tool-result', toolName: 'wait' });
    const second = await iterator.next();
    expect(second.value).toEqual({ type: 'text-delta', textDelta: 'Done.' });
    await iterator.return?.();
  });
});

describe('signals:observability 锚点', () => {
  it('注入 = 活跃 run 的 agent-run span 上一个 isEvent 事件;唤醒 run 自身一个 agent-run span', async () => {
    const exported = memoryExporter();
    const tracer = createTracer({ exporters: [exported] });
    const model = fakeModel([
      { text: 'Working.', toolCalls: [{ toolCallId: 'call-1', toolName: 'wait', input: {} }] },
      { text: 'Done.' },
    ]);
    const memory = new Memory();
    const gate = deferred<void>();
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory,
      tracer,
      tools: { wait: gateTool(gate.promise) },
    });
    const signals = createSignals({ agent, memory, tracer });

    const text = signals.stream('Start.', { memory: TARGET }).text;
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(1));
    await signals.sendMessage(TARGET, 'New info!');
    gate.resolve();
    expect(await text).toBe('Done.');

    // 锚点一:注入 = agent-run span 上的 isEvent 事件(open 类型字面量 'signal',非框架常量)
    const runSpan = spanOfType(exported, AGENT_RUN_SPAN);
    const events = eventsOfType(exported, 'signal');
    expect(events).toHaveLength(1);
    const eventSpan = events[0]!.span;
    expect(eventSpan.isEvent).toBe(true);
    expect(eventSpan.traceId).toBe(runSpan.traceId);
    expect(eventSpan.parentSpanId).toBe(runSpan.id);
    expect(eventSpan.input).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'New info!' }] },
    ]);
    expect(eventSpan.attributes).toMatchObject({ threadId: 't1', resource: 'u1' });
    // isEvent 机制:创建即完结,只发一次 span_ended
    expect(kinds(events)).toEqual(['span_ended']);

    // 锚点二:唤醒的新 run 自身一个 agent-run span(agent 自建,与既有埋点同形)
    const idleModel = fakeModel([{ text: 'Woken.' }]);
    const idleAgent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: idleModel,
      memory,
      tracer,
    });
    const idleSignals = createSignals({ agent: idleAgent, memory, tracer });
    await idleSignals.sendMessage({ thread: 't2', resource: 'u1' }, 'wake');
    await vi.waitFor(() => expect(idleModel.streamCalls).toHaveLength(1));
    const runSpans = exported.spans().filter((span) => span.type === AGENT_RUN_SPAN);
    expect(runSpans).toHaveLength(2);
  });
});

describe('signals:边界语义', () => {
  it('memory 缺席:唤醒 = 无历史新 run(不 recall、不落盘),注入只进 prompt', async () => {
    const model = fakeModel([
      { text: 'Working.', toolCalls: [{ toolCallId: 'call-1', toolName: 'wait', input: {} }] },
      { text: 'Done.' },
    ]);
    const gate = deferred<void>();
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: { wait: gateTool(gate.promise) },
    });
    const signals = createSignals({ agent });

    // 唤醒照常发生(memory 缺席文档化:无历史新 run)
    await signals.sendMessage(TARGET, 'wake');
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(1));
    expect(model.streamCalls[0]?.prompt).toEqual([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'wake' }] },
    ]);
    gate.resolve(); // 放行挂着的唤醒 run,让其干净收尾

    // 活跃注入也照常(只进 prompt,不落任何历史)
    const idleModel = fakeModel([{ text: 'Noted.' }]);
    const idleSignals = createSignals({
      agent: new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model: idleModel }),
    });
    await idleSignals.sendMessage(TARGET, 'hello');
    await vi.waitFor(() => expect(idleModel.streamCalls).toHaveLength(1));
    expect(idleModel.streamCalls[0]?.prompt.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    });
  });

  it('同 thread 第二个 run 被拒:一次一个活跃 run 是三句语义的前提', async () => {
    const model = fakeModel([
      { text: 'Working.', toolCalls: [{ toolCallId: 'call-1', toolName: 'wait', input: {} }] },
      { text: 'Done.' },
      { text: 'After too.' },
    ]);
    const memory = new Memory();
    const gate = deferred<void>();
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory,
      tools: { wait: gateTool(gate.promise) },
    });
    const signals = createSignals({ agent, memory });

    const first = signals.stream('Start.', { memory: TARGET });
    const text = first.text;
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(1));
    expect(() => signals.stream('Second.', { memory: TARGET })).toThrowError(/already has a live run/);
    gate.resolve();
    expect(await text).toBe('Done.');
    // run 结束后 thread 回到空闲:再次开 run 不再报错
    const second = await signals.generate('After.', { memory: TARGET });
    expect(second.finishReason).toBe('stop');
  });

  it('无 memory 身份的 run 纯透传:不经注册,行为与裸 agent 一致', async () => {
    const model = fakeModel([{ text: 'Plain.' }]);
    const memory = new Memory();
    const signals = createSignals({ agent: memoryAgent(model, memory), memory });

    const result = await signals.generate('No identity.');

    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('Plain.');
    expect(model.streamCalls[0]?.prompt).toEqual([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'No identity.' }] },
    ]);
  });

  it('用户自带的 stepBoundary 与注入缝组合:用户注入接在 signals 注入之后,审批闸照常被咨询', async () => {
    const model = fakeModel([
      { text: 'Working.', toolCalls: [{ toolCallId: 'call-1', toolName: 'wait', input: {} }] },
      { text: 'Done.' },
    ]);
    const memory = new Memory();
    const gate = deferred<void>();
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory,
      tools: { wait: gateTool(gate.promise) },
    });
    const signals = createSignals({ agent, memory });
    const gate2 = vi.fn<() => undefined>(() => undefined);

    const text = signals
      .stream('Start.', {
        memory: TARGET,
        stepBoundary: {
          beforeNextStep: (event) =>
            event.stepIndex === 1
              ? [{ role: 'user', content: [{ type: 'text', text: 'user hook' }] }]
              : undefined,
          beforeToolCalls: gate2,
        },
      })
      .text;
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(1));
    await signals.sendMessage(TARGET, 'New info!');
    gate.resolve();
    expect(await text).toBe('Done.');

    // 组合序:signals 注入在前,用户边界返回的消息在后(同一缝,同一 prompt 尾部)
    const tail = model.streamCalls[1]?.prompt.slice(-2);
    expect(tail).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'New info!' }] },
      { role: 'user', content: [{ type: 'text', text: 'user hook' }] },
    ]);
    // 用户审批闸透传照常被咨询(步 0 有待执行调用)
    expect(gate2).toHaveBeenCalledTimes(1);
  });

  it('构造防护:给了 memory 但 agent 未配置 memory 直接报错(同实例契约)', () => {
    const model = fakeModel([]);
    const agent = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model });
    expect(() => createSignals({ agent, memory: new Memory() })).toThrowError(
      /requires the agent to be configured/,
    );
  });

  it('目标身份显式校验:缺 thread 或缺 resource 在投递前报错', async () => {
    const model = fakeModel([{ text: 'Noted.' }]);
    const signals = createSignals({ agent: memoryAgent(model, new Memory()), memory: new Memory() });
    await expect(signals.sendMessage({ thread: '', resource: 'u1' }, 'x')).rejects.toThrowError(
      /missing its thread/,
    );
    await expect(
      signals.sendMessage({ thread: 't1', resource: '' }, 'x'),
    ).rejects.toThrowError(/missing its resource/);
  });
});

describe('signals:唤醒(空闲 = 唤醒新 run)', () => {
  it('sendMessage 打向空闲 thread:开新 run,输入经 run 自身落历史,可 recall', async () => {
    const model = fakeModel([{ text: 'Noted.' }]);
    const memory = new Memory();
    const signals = createSignals({ agent: memoryAgent(model, memory), memory });

    await signals.sendMessage(TARGET, 'ping?');

    // 唤醒 run 由 signals 驱动到完成:模型被调用,prompt = 指令 + 输入(首轮历史为空)
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(1));
    expect(model.streamCalls[0]?.prompt).toEqual([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'ping?' }] },
    ]);
    // 输入随首轮 step 落历史(run 自带 memory 身份),recall 可见;run 的回答同样落历史
    await vi.waitFor(async () => {
      const stored = await memory.recall({ threadId: 't1' });
      expect(stored.map((message) => message.content)).toEqual([
        [{ type: 'text', text: 'ping?' }],
        [{ type: 'text', text: 'Noted.' }],
      ]);
    });
  });
});
