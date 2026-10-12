import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent } from '@oribos/core/agent';
import type { Processor, RequestContext } from '@oribos/core/agent';
import { ModelContractError } from '@oribos/core/model';
import type { Chunk, ToolResultChunk } from '@oribos/core/model';
import {
  AGENT_RUN_SPAN,
  AGENT_STEP_SPAN,
  TOOL_CALL_SPAN,
  createTracer,
  memoryExporter,
} from '@oribos/core/observability';
import { createTool } from '@oribos/core/tools';
import type { Tool, ToolContext } from '@oribos/core/tools';
import { fakeModel } from '@oribos/testing';
import { INSTRUCTIONS, assistant, assistantWithTools } from './helpers/agent.js';
import { collect } from './helpers/collect.js';
import { TRACE_ID, spanOfType } from './helpers/spans.js';

/**
 * 内建工具 loop 与三线错误回喂(M1-07 #28):模型返回 tool-call 时 loop 执行工具并把结果以
 * vendor prompt 类型回喂,多轮直至无 tool-call 或达到 maxSteps(默认 5);耗尽而模型仍要工具时
 * 终值 finishReason 为 'tool-calls';steps[] 与全 run 累计 usage 正确;input 校验失败 / execute
 * 抛错 / output 校验失败三线(另加未知工具)统一转为 error 工具结果回喂,run 不中止;工具 execute
 * 拿到六件套(未挂 tracer 时 traceId / spanId 为空串;挂上后为真值,断言见
 * `agent-observability.test.ts`)。断言只走公开面(@oribos/core 子路径导出)与
 * 脚本化假模型接缝(@see @oribos/testing):假模型录制的 prompt 就是"模型看到的历史"。
 */

/** 参考工具:zod 双接口 schema,输入 city 输出 celsius。 */
function weatherTool(execute: (input: { city: string }) => unknown): Tool {
  return createTool({
    description: 'Looks up the weather.',
    inputSchema: z.object({ city: z.string() }),
    execute,
  });
}

/** 外部可控的 deferred:测试用它把 run 按在工具执行中间(与 signals.test.ts 同一手法)。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onValue) => {
    resolve = onValue;
  });
  return { promise, resolve };
}

describe('Agent loop:多轮工具调用', () => {
  it('模型返回 tool-call 即执行工具并把结果回喂:多轮直至无 tool-call,终值正确', async () => {
    const model = fakeModel([
      {
        text: 'Let me check.',
        toolCalls: [{ toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } }],
        usage: { inputTokens: 3, outputTokens: 4 },
      },
      { text: 'It is 21°C.', usage: { inputTokens: 5, outputTokens: 6 } },
    ]);
    const agent = assistantWithTools(model, {
      weather: weatherTool(({ city }) => ({ celsius: city === 'SF' ? 21 : 0 })),
    });

    const result = await agent.generate('What is the weather in SF?');

    expect(model.streamCalls).toHaveLength(2);
    expect(result.text).toBe('It is 21°C.');
    expect(result.finishReason).toBe('stop');
    // 全 run 累计 usage = 各步之和
    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 10, totalTokens: 18 });
    // run 级 toolCalls / toolResults = steps 的展平
    expect(result.toolCalls).toEqual([
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } },
    ]);
    expect(result.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'weather',
        output: { celsius: 21 },
        isError: false,
      },
    ]);
    // steps[]:一步 = 一轮模型调用 + 该步工具执行,结果归请求它们的步骤
    expect(result.steps).toEqual([
      {
        text: 'Let me check.',
        toolCalls: [
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } },
        ],
        toolResults: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'weather',
            output: { celsius: 21 },
            isError: false,
          },
        ],
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
      {
        text: 'It is 21°C.',
        toolCalls: [],
        toolResults: [],
        usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
      },
    ]);
  });

  it('工具结果以 vendor prompt 类型回喂:assistant 消息带 tool-call,tool 消息带 tool-result', async () => {
    const model = fakeModel([
      {
        text: 'Checking.',
        toolCalls: [
          { toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } },
          { toolCallId: 'call-2', toolName: 'ping', input: {} },
        ],
      },
      { text: 'done' },
    ]);
    const agent = assistantWithTools(model, {
      weather: weatherTool(() => ({ celsius: 21 })),
      ping: createTool({ description: 'Pings.', execute: () => 'pong' }),
    });

    await agent.generate('Weather in SF?');

    expect(model.streamCalls[1]?.prompt).toEqual([
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: [{ type: 'text', text: 'Weather in SF?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } },
          { type: 'tool-call', toolCallId: 'call-2', toolName: 'ping', input: {} },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'weather',
            // 非字符串输出 → json;字符串输出 → text(AI SDK 同一约定)
            output: { type: 'json', value: { celsius: 21 } },
          },
          {
            type: 'tool-result',
            toolCallId: 'call-2',
            toolName: 'ping',
            output: { type: 'text', value: 'pong' },
          },
        ],
      },
    ]);
  });

  it('同一步混合 provider 执行与框架执行的调用:每个 tool-call 都有配对的 tool-result', async () => {
    const model = fakeModel([
      {
        toolCalls: [
          { toolCallId: 'call-client', toolName: 'weather', input: { city: 'SF' } },
          { toolCallId: 'call-provider', toolName: 'web_search', input: { query: 'weather SF' } },
        ],
        toolResults: [
          { toolCallId: 'call-provider', toolName: 'web_search', result: { snippets: ['21°C'] } },
        ],
      },
      { text: 'done' },
    ]);
    const execute = vi.fn(() => ({ celsius: 21 }));
    const agent = assistantWithTools(model, { weather: weatherTool(execute) });

    await agent.generate('Weather in SF?');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.streamCalls[1]?.prompt).toEqual([
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: [{ type: 'text', text: 'Weather in SF?' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-client',
            toolName: 'weather',
            input: { city: 'SF' },
          },
          {
            type: 'tool-call',
            toolCallId: 'call-provider',
            toolName: 'web_search',
            input: { query: 'weather SF' },
          },
          // provider 已执行的结果回显在 assistant 消息里(AI SDK toResponseMessages 的同一形状):
          // provider 调用 ↔ provider 结果、框架调用 ↔ tool 消息里的框架结果,不留悬空 tool-call
          {
            type: 'tool-result',
            toolCallId: 'call-provider',
            toolName: 'web_search',
            output: { type: 'json', value: { snippets: ['21°C'] } },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-client',
            toolName: 'weather',
            output: { type: 'json', value: { celsius: 21 } },
          },
        ],
      },
    ]);
  });

  it('无 inputSchema 的工具:input 为 undefined(模型给的参数不参与校验)', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'ping', input: { stray: true } }] },
      { text: 'done' },
    ]);
    const execute = vi.fn((_input: unknown) => 'pong');
    const agent = assistantWithTools(model, { ping: createTool({ description: 'Pings.', execute }) });

    await agent.generate('Go.');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toBeUndefined();
  });

  it('for-await 顺序:模型 chunk → finish → 框架执行的 tool-result chunk → 下一步模型 chunk', async () => {
    const model = fakeModel([
      { text: 'Checking.', toolCalls: [{ toolCallId: 'call-1', toolName: 'ping', input: {} }] },
      { text: 'done' },
    ]);
    const agent = assistantWithTools(model, {
      ping: createTool({ description: 'Pings.', execute: () => 'pong' }),
    });

    const chunks = await collect(agent.stream('Go.'));

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      'text-delta',
      'tool-call',
      'finish',
      'tool-result',
      'text-delta',
      'finish',
    ]);
    expect(chunks[3]).toEqual({
      type: 'tool-result',
      toolCallId: 'call-1',
      toolName: 'ping',
      output: 'pong',
      isError: false,
    });
  });
});

describe('Agent loop:maxSteps 封顶', () => {
  it('maxSteps 默认 5:5 次模型调用封顶,末步工具照常执行,终值 finishReason 为 tool-calls', async () => {
    const model = fakeModel(
      Array.from({ length: 5 }, (_, step) => ({
        text: `step ${step + 1}`,
        toolCalls: [{ toolName: 'ping', input: {} }],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    );
    const execute = vi.fn(() => 'pong');
    const agent = assistantWithTools(model, { ping: createTool({ description: 'Pings.', execute }) });

    const result = await agent.generate('Go.');

    expect(model.streamCalls).toHaveLength(5);
    expect(execute).toHaveBeenCalledTimes(5);
    expect(result.steps).toHaveLength(5);
    expect(result.steps[4]?.toolResults).toHaveLength(1);
    expect(result.text).toBe('step 5');
    expect(result.finishReason).toBe('tool-calls');
  });

  it('maxSteps 可覆盖:达到自定义上限即停,finishReason 为 tool-calls', async () => {
    const model = fakeModel([
      { text: 'one', toolCalls: [{ toolName: 'ping', input: {} }] },
      { text: 'two', toolCalls: [{ toolName: 'ping', input: {} }] },
    ]);
    const execute = vi.fn(() => 'pong');
    const agent = assistantWithTools(model, { ping: createTool({ description: 'Pings.', execute }) });

    const result = await agent.generate('Go.', { maxSteps: 2 });

    expect(model.streamCalls).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.finishReason).toBe('tool-calls');
  });

  it('耗尽而模型仍要工具:provider 报 stop 时终值 finishReason 也为 tool-calls(截断信号归框架)', async () => {
    const model = fakeModel([
      { text: 'partial', toolCalls: [{ toolName: 'ping', input: {} }], finishReason: 'stop' },
    ]);
    const agent = assistantWithTools(model, {
      ping: createTool({ description: 'Pings.', execute: () => 'pong' }),
    });

    const result = await agent.generate('Go.', { maxSteps: 1 });

    expect(result.finishReason).toBe('tool-calls');
  });

  it('maxSteps 非正整数:显式报错,不发起模型调用', async () => {
    const model = fakeModel([{ text: 'never sent' }]);
    const agent = assistantWithTools(model, {});

    await expect(agent.generate('Go.', { maxSteps: 0 })).rejects.toThrow(/maxSteps/);
    expect(model.streamCalls).toHaveLength(0);
  });
});

describe('Agent loop:三线错误回喂', () => {
  it('input 校验失败:execute 不被调用,error 工具结果回喂模型、run 继续', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'weather', input: { city: 42 } }] },
      { text: 'Sorry, retrying.' },
    ]);
    const execute = vi.fn(() => ({ celsius: 21 }));
    const agent = assistantWithTools(model, { weather: weatherTool(execute) });

    const result = await agent.generate('Weather in SF?');

    expect(execute).not.toHaveBeenCalled();
    expect(result.finishReason).toBe('stop');
    expect(result.steps[0]?.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'weather',
        output: expect.stringContaining('city'),
        isError: true,
      },
    ]);
    expect(model.streamCalls[1]?.prompt[3]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'weather',
          output: { type: 'error-text', value: expect.stringContaining('city') },
        },
      ],
    });
  });

  it('execute 抛错:error 工具结果回喂模型、run 继续', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } }] },
      { text: 'The lookup failed, sorry.' },
    ]);
    const agent = assistantWithTools(model, {
      weather: weatherTool(() => {
        throw new Error('upstream 500');
      }),
    });

    const result = await agent.generate('Weather in SF?');

    expect(result.text).toBe('The lookup failed, sorry.');
    expect(result.finishReason).toBe('stop');
    expect(result.steps[0]?.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'weather',
        output: expect.stringContaining('upstream 500'),
        isError: true,
      },
    ]);
  });

  it('output 校验失败:error 工具结果回喂模型、run 继续(副作用已发生)', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } }] },
      { text: 'Got a malformed result.' },
    ]);
    const execute = vi.fn(() => ({ celsius: 'hot' }));
    // 手写字面量绕过工厂的编译期类型,构造出 execute 返回值不合 outputSchema 的工具
    const malformed: Tool = {
      description: 'Looks up the weather.',
      inputSchema: z.object({ city: z.string() }),
      outputSchema: z.object({ celsius: z.number() }),
      execute,
    };
    const agent = assistantWithTools(model, { weather: malformed });

    const result = await agent.generate('Weather in SF?');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.finishReason).toBe('stop');
    expect(result.steps[0]?.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'weather',
        output: expect.stringContaining('celsius'),
        isError: true,
      },
    ]);
  });

  it('模型调用不存在的工具:同样转为 error 工具结果回喂、run 继续', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'nope', input: {} }] },
      { text: 'recovered' },
    ]);
    const agent = assistantWithTools(model, {});

    const result = await agent.generate('Go.');

    expect(result.text).toBe('recovered');
    expect(result.steps[0]?.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'nope',
        output: expect.stringContaining('nope'),
        isError: true,
      },
    ]);
  });
});

describe('Agent loop:工具上下文六件套', () => {
  it('toolCallId 为 provider 真值;未挂 tracer 时 traceId / spanId 为空串;signal / runId / requestContext 贯通', async () => {
    const model = fakeModel([
      {
        toolCalls: [
          { toolCallId: 'provider-call-42', toolName: 'probe', input: { q: 'a' } },
          { toolCallId: 'provider-call-43', toolName: 'probe', input: { q: 'b' } },
        ],
      },
      { text: 'done' },
    ]);
    const seen: ToolContext[] = [];
    const probe = createTool({
      description: 'Probes.',
      inputSchema: z.object({ q: z.string() }),
      execute: (input, ctx) => {
        seen.push(ctx);
        return input.q;
      },
    });
    const agent = assistantWithTools(model, { probe });
    const controller = new AbortController();

    await agent.generate('Go.', { signal: controller.signal, userId: 'u-9' });

    expect(seen.map((ctx) => ctx.toolCallId)).toEqual(['provider-call-42', 'provider-call-43']);
    const [first, second] = seen;
    expect(first?.signal).toBe(controller.signal);
    expect(first?.traceId).toBe('');
    expect(first?.spanId).toBe('');
    expect(first?.runId).toBeTypeOf('string');
    expect(first?.runId).not.toBe('');
    // 同一 run 的所有工具调用共享同一 runId
    expect(second?.runId).toBe(first?.runId);
    // requestContext = 框架写入的 signal / runId + 用户 per-call 开放袋
    expect(first?.requestContext).toMatchObject({
      signal: controller.signal,
      runId: first?.runId,
      userId: 'u-9',
    });
  });

  it('requestContext 只含用户袋 + 框架写入的 signal / runId,不掺入框架 run options', async () => {
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
    const agent = assistantWithTools(model, { probe });

    await agent.generate('Go.', {
      maxSteps: 3,
      modelSettings: { temperature: 0.1 },
      traceId: 'a'.repeat(32),
      parentSpanId: 'b'.repeat(16),
      hideInput: true,
      userId: 'u-1',
    });

    expect(context).toMatchObject({ userId: 'u-1' });
    expect(context).not.toHaveProperty('maxSteps');
    expect(context).not.toHaveProperty('modelSettings');
    expect(context).not.toHaveProperty('providerOptions');
    expect(context).not.toHaveProperty('traceId');
    expect(context).not.toHaveProperty('parentSpanId');
    expect(context).not.toHaveProperty('hideInput');
    expect(context).not.toHaveProperty('hideOutput');
  });

  it('未传 signal 时工具 ctx 仍拿到 AbortSignal(空转信号)', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'probe', input: {} }] },
      { text: 'done' },
    ]);
    let signal: unknown;
    const probe = createTool({
      description: 'Probes.',
      execute: (_input, ctx) => {
        signal = ctx.signal;
        return 'ok';
      },
    });
    const agent = assistantWithTools(model, { probe });

    await agent.generate('Go.');

    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('provider 已执行的工具调用不重复执行(同 toolCallId 已有结果即跳过)', async () => {
    const model = fakeModel([
      {
        toolCalls: [{ toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } }],
        toolResults: [{ toolCallId: 'call-1', toolName: 'weather', result: { temp: 21 } }],
        finishReason: 'stop',
      },
    ]);
    const execute = vi.fn(() => ({ celsius: 21 }));
    const agent = assistantWithTools(model, { weather: weatherTool(execute) });

    const result = await agent.generate('Go.');

    expect(execute).not.toHaveBeenCalled();
    expect(model.streamCalls).toHaveLength(1);
    expect(result.steps[0]?.toolResults).toEqual([
      { type: 'tool-result', toolCallId: 'call-1', toolName: 'weather', output: { temp: 21 }, isError: false },
    ]);
  });
});

describe('Agent loop:取消传播', () => {
  it('工具执行中宿主取消:下一步模型调用以中止原因拒绝、run 中止', async () => {
    const controller = new AbortController();
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'cancel', input: {} }] },
      { text: 'never sent' },
    ]);
    const agent = assistantWithTools(model, {
      cancel: createTool({
        description: 'Cancels the run.',
        execute: () => {
          controller.abort(new Error('cancelled by host'));
          return 'ok';
        },
      }),
    });

    await expect(agent.generate('Go.', { signal: controller.signal })).rejects.toThrow(
      'cancelled by host',
    );
    expect(model.streamCalls).toHaveLength(1);
  });
});

describe('Agent loop:无工具 run 不受影响', () => {
  it('无 tools 的 agent 单步直达(既有纯文本闭环不回退)', async () => {
    const model = fakeModel([{ text: 'ok' }]);

    const result = await assistant(model).generate('Say hi.');

    expect(result.steps).toHaveLength(1);
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toEqual([]);
    expect(result.toolResults).toEqual([]);
  });
});

describe('Agent loop:模型流契约', () => {
  it('第 2 步模型流缺 finish part:run 以契约错误收尾,不用前一步的 finish 静默收敛', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'ping', input: {} }] },
      { text: 'partial', omitFinish: true },
    ]);
    const agent = assistantWithTools(model, {
      ping: createTool({ description: 'Pings.', execute: () => 'pong' }),
    });
    const result = agent.stream('Go.');

    await expect(collect(result)).rejects.toBeInstanceOf(ModelContractError);
    await expect(result.finishReason).rejects.toBeInstanceOf(ModelContractError);
  });
});

describe('Agent loop:并发 run 互不串(#131)', () => {
  it('同一 agent 两个并发 run:steps / usage / traceId 各自独立,prompt 互不染', async () => {
    const exported = memoryExporter();
    const tracer = createTracer({ exporters: [exported] });
    const gate = deferred<void>();
    const execute = vi.fn((_input: unknown, _ctx: ToolContext) => gate.promise);
    const model = fakeModel([
      // run A 第一步:要工具,工具按在 gate 上(制造两个 run 真实交叠的活跃窗口)
      {
        text: 'A checking.',
        toolCalls: [{ toolCallId: 'call-a', toolName: 'wait', input: {} }],
        usage: { inputTokens: 1, outputTokens: 2 },
      },
      // run B 的唯一一步:在窗口内完整跑完
      { text: 'B answer.', usage: { inputTokens: 10, outputTokens: 20 } },
      // run A 第二步:gate 放行后才发起
      { text: 'A final.', usage: { inputTokens: 3, outputTokens: 4 } },
    ]);
    const agent = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model,
      tools: { wait: createTool({ description: 'Waits for the gate.', execute }) },
      tracer,
    });

    const runA = agent.generate('question A');
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    // run A 停在工具执行中间;run B 在此期间完整跑完
    const resultB = await agent.generate('question B');
    gate.resolve();
    const resultA = await runA;

    // 终值互不串:各自的 text / steps / usage / toolCalls 都是自己的
    expect(resultB.text).toBe('B answer.');
    expect(resultB.steps).toHaveLength(1);
    expect(resultB.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    expect(resultB.toolCalls).toEqual([]);
    expect(resultA.text).toBe('A final.');
    expect(resultA.steps.map((step) => step.text)).toEqual(['A checking.', 'A final.']);
    expect(resultA.usage).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 10 });
    expect(resultA.toolCalls).toEqual([
      { type: 'tool-call', toolCallId: 'call-a', toolName: 'wait', input: {} },
    ]);

    // prompt 互不染:B 的模型调用只见自己的输入;A 的第二步只见自己的历史
    expect(model.streamCalls[1]?.prompt).toEqual([
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: [{ type: 'text', text: 'question B' }] },
    ]);
    const secondCallOfA = JSON.stringify(model.streamCalls[2]?.prompt);
    expect(secondCallOfA).toContain('question A');
    expect(secondCallOfA).not.toContain('question B');

    // traceId 互不串:两个 run 各起一条 trace,各自的 step span 挂在自己的 trace 下;
    // 窗口内执行的工具,其 span 与 ctx 身份都属 run A
    const runs = exported.spans().filter((span) => span.type === AGENT_RUN_SPAN);
    const runSpanOf = (question: string) => {
      const span = runs.find((candidate) => JSON.stringify(candidate.input).includes(question));
      if (span === undefined) throw new Error(`no run span for '${question}'`);
      return span;
    };
    const runSpanA = runSpanOf('question A');
    const runSpanB = runSpanOf('question B');
    expect(runSpanA.traceId).toMatch(TRACE_ID);
    expect(runSpanA.traceId).not.toBe(runSpanB.traceId);
    const stepsOf = (traceId: string) =>
      exported
        .spans()
        .filter((span) => span.type === AGENT_STEP_SPAN && span.traceId === traceId);
    expect(stepsOf(runSpanA.traceId)).toHaveLength(2);
    expect(stepsOf(runSpanB.traceId)).toHaveLength(1);
    expect(spanOfType(exported, TOOL_CALL_SPAN).traceId).toBe(runSpanA.traceId);
    const contextA = execute.mock.calls[0]?.[1];
    expect(runSpanA.attributes).toMatchObject({ runId: contextA?.runId });
  });
});

describe('Agent loop:同一步多工具串行执行(SEM-A2,#134)', () => {
  it('第二个工具在第一个 settle 前不启动:gate 按住第一个期间第二个零调用,放行后按调用序执行并入', async () => {
    const gate = deferred<string>();
    /** 工具 execute 的启动顺序录制(gated 假工具,与「并发 run」例同一手法)。 */
    const started: string[] = [];
    const model = fakeModel([
      {
        toolCalls: [
          { toolCallId: 'call-1', toolName: 'first', input: {} },
          { toolCallId: 'call-2', toolName: 'second', input: {} },
        ],
      },
      { text: 'done' },
    ]);
    const secondExecute = vi.fn(() => {
      started.push('second');
      return 'second-done';
    });
    const agent = assistantWithTools(model, {
      first: createTool({
        description: 'First, held by the gate.',
        execute: () => {
          started.push('first');
          return gate.promise;
        },
      }),
      second: createTool({ description: 'Second.', execute: secondExecute }),
    });

    const run = agent.generate('Go.');
    // 第一个工具已启动、被 gate 按在执行中间;此时若 loop 并发执行,第二个早已启动
    await vi.waitFor(() => expect(started).toEqual(['first']));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 钉点(变异敏感):第一个 settle 之前,第二个的 execute 一次都不应被调用
    expect(secondExecute).not.toHaveBeenCalled();

    gate.resolve('first-done');
    const result = await run;

    // 放行后第二个才启动;启动序 = 调用序,结果按调用序并入本步
    expect(started).toEqual(['first', 'second']);
    expect(secondExecute).toHaveBeenCalledTimes(1);
    expect(result.steps[0]?.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'first',
        output: 'first-done',
        isError: false,
      },
      {
        type: 'tool-result',
        toolCallId: 'call-2',
        toolName: 'second',
        output: 'second-done',
        isError: false,
      },
    ]);
    expect(result.finishReason).toBe('stop');
  });
});

describe('Agent loop:eager 工具执行(A2 转追赶项 opt-in 开关,#172)', () => {
  it('参数流完即启动:两个工具在本步 finish 之前都已启动;乱序 settle 仍按调用序发射', async () => {
    const gate = deferred<string>();
    /** 启动 / settle 双录制:启动面钉 eager(与 SEM-A2 例同一手法),乱序 settle 钉发射序。 */
    const started: string[] = [];
    const settled: string[] = [];
    const model = fakeModel([
      {
        toolCalls: [
          { toolCallId: 'call-1', toolName: 'first', input: {} },
          { toolCallId: 'call-2', toolName: 'second', input: {} },
        ],
      },
      { text: 'done' },
    ]);
    const agent = assistantWithTools(model, {
      first: createTool({
        description: 'Slow, held by the gate.',
        execute: async () => {
          started.push('first');
          const value = await gate.promise;
          settled.push('first');
          return value;
        },
      }),
      second: createTool({
        description: 'Instant.',
        execute: () => {
          started.push('second');
          settled.push('second');
          return 'second-done';
        },
      }),
    });

    const stream = agent.stream('Go.', { toolExecution: 'eager' });
    const chunks: Chunk[] = [];
    const iterator = stream[Symbol.asyncIterator]();
    // 消费到本步 finish 为止,此刻钉启动面
    let startedAtFinish: string[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      chunks.push(next.value);
      if (next.value.type === 'finish') {
        startedAtFinish = [...started];
        break;
      }
    }

    // 钉点(变异敏感):串行实装此刻一个工具都没启动,eager 下两个都已启动
    expect(startedAtFinish).toEqual(['first', 'second']);
    // 第二个乱序先 settle,但发射被调用序按住:消费者尚未看到任何 tool-result
    expect(settled).toEqual(['second']);
    expect(chunks.filter((chunk) => chunk.type === 'tool-result')).toEqual([]);

    gate.resolve('first-done');
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      chunks.push(next.value);
    }

    // 发射序 = 调用序,不是 settle 序(确定性钉点)
    const results = chunks.filter((chunk): chunk is ToolResultChunk => chunk.type === 'tool-result');
    expect(results.map((chunk) => chunk.toolCallId)).toEqual(['call-1', 'call-2']);
    expect(settled).toEqual(['second', 'first']);
    const steps = await stream.steps;
    expect(steps[0]?.toolResults.map((result) => result.toolCallId)).toEqual(['call-1', 'call-2']);
    expect(await stream.finishReason).toBe('stop');
  });

  it('abort 打断 eager 中途执行:在途工具观察到中止并先 settle,run 以 abort reason 原样拒绝', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    const started: string[] = [];
    /** 在途工具的中止观察(延迟 settle:钉「settle 先于拒绝上抛」,泄漏则乱序)。 */
    const observed: string[] = [];
    const model = fakeModel([
      {
        toolCalls: [{ toolCallId: 'call-1', toolName: 'held', input: {} }],
        // 流在 finish 前挂起直到中止:error part 携带 signal.reason(真实 provider 的中途取消)
        abortAfter: 5,
      },
    ]);
    const agent = assistantWithTools(model, {
      held: createTool({
        description: 'Holds until aborted.',
        execute: (_input: unknown, ctx: ToolContext) =>
          new Promise((_resolve, reject) => {
            started.push('held');
            ctx.signal.addEventListener('abort', () => {
              setTimeout(() => {
                observed.push('held-aborted');
                reject(ctx.signal.reason);
              }, 0);
            });
          }),
      }),
    });

    const failure = agent
      .generate('Go.', { toolExecution: 'eager', signal: controller.signal })
      .then(
        () => null,
        (error: unknown) => error,
      );
    // 钉点(变异敏感):串行实装永远走不到这里——模型流挂着,工具零启动
    await vi.waitFor(() => expect(started).toEqual(['held']));

    controller.abort(reason);
    const error = await failure;

    // run 以 abort reason 原样拒绝(取消是 run 的结局,不经 processError 替换)
    expect(error).toBe(reason);
    // 在途 eager 执行被打断,且先于拒绝上抛 settle(loop 不泄漏在途执行)
    expect(observed).toEqual(['held-aborted']);
  });

  it('eager 失败路径与流交织:processError 在本步 finish 之前观察失败,error 结果按调用序回喂', async () => {
    /** 同一事件日志:processor 记失败观察,消费者记 chunk 到达 —— 交错即钉点。 */
    const events: string[] = [];
    const model = fakeModel([
      {
        toolCalls: [
          { toolCallId: 'call-1', toolName: 'failing', input: {} },
          { toolCallId: 'call-2', toolName: 'ok', input: {} },
        ],
        // 慢流(每 part 50ms):call-1 的失败路径有充足窗口在模型流收尾之前跑完
        delayMs: 50,
      },
      { text: 'done' },
    ]);
    const spy: Processor = {
      processError: ({ source, toolCall }) => {
        events.push(`processError:${source}:${toolCall?.toolCallId ?? ''}`);
      },
    };
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: {
        failing: createTool({
          description: 'Throws at once.',
          execute: () => {
            throw new Error('boom');
          },
        }),
        ok: createTool({ description: 'Fine.', execute: () => 'ok-done' }),
      },
      processors: [spy],
    });

    const stream = agent.stream('Go.', { toolExecution: 'eager' });
    for await (const chunk of stream) {
      events.push(chunk.type === 'finish' ? 'chunk:finish' : `chunk:${chunk.type}`);
    }

    // 钉点(变异敏感):串行实装的失败路径在本步 finish 之后才启动,交错即破
    expect(events).toContain('processError:tool:call-1');
    expect(events.indexOf('processError:tool:call-1')).toBeLessThan(events.indexOf('chunk:finish'));
    // 失败 = error 工具结果(框架框 + 原错细节),两结果按调用序并入;run 照常走完
    const steps = await stream.steps;
    expect(steps[0]?.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'failing',
        output: "Tool 'failing' failed: boom",
        isError: true,
      },
      {
        type: 'tool-result',
        toolCallId: 'call-2',
        toolName: 'ok',
        output: 'ok-done',
        isError: false,
      },
    ]);
    expect(await stream.text).toBe('done');
    expect(await stream.finishReason).toBe('stop');
  });

  it('eager 与 beforeToolCalls 审批闸互斥:run 边界显式报错,模型调用未发起', async () => {
    const model = fakeModel([{ text: 'unused' }]);
    const agent = assistant(model);

    // 闸的存在意义是按住调用,eager 的参数流完即启动会直接架空它 —— 组合在 run 边界即败
    await expect(
      agent.generate('Go.', {
        toolExecution: 'eager',
        stepBoundary: { beforeToolCalls: () => undefined },
      }),
    ).rejects.toThrow(
      "toolExecution: 'eager' cannot combine with a stepBoundary.beforeToolCalls gate",
    );
    expect(model.streamCalls).toEqual([]);
  });

  it('eager 与 beforeNextStep 注入缝相容(signals 同缝):注入器照常咨询,工具照常执行', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'only', input: {} }] },
      { text: 'done' },
    ]);
    const injector = vi.fn(() => undefined);
    const agent = assistantWithTools(model, {
      only: createTool({ description: 'Only tool.', execute: () => 'only-done' }),
    });

    const result = await agent.generate('Go.', {
      toolExecution: 'eager',
      stepBoundary: { beforeNextStep: injector },
    });

    expect(result.finishReason).toBe('stop');
  });

  it('provider 后到的自身结果为准:eager 已启动的同 id 执行作废,流与记录各恰一份', async () => {
    const started: string[] = [];
    const model = fakeModel([
      {
        toolCalls: [{ toolCallId: 'call-1', toolName: 'hybrid', input: {} }],
        toolResults: [{ toolCallId: 'call-1', toolName: 'hybrid', result: 'by-provider' }],
      },
    ]);
    const agent = assistantWithTools(model, {
      hybrid: createTool({
        description: 'The provider also executes this one.',
        execute: () => {
          started.push('hybrid');
          return 'by-framework';
        },
      }),
    });

    const stream = agent.stream('Go.', { toolExecution: 'eager' });
    const chunks = await collect(stream);

    // eager 的代价(明写):provider 结果到达前无法预知,框架那次执行已经启动 —— 但其结果作废,
    // provider 的才是权威(与串行「不重复执行、provider 结果为准」同一条不变量的 eager 形态)
    expect(started).toEqual(['hybrid']);
    const expected = [
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'hybrid',
        output: 'by-provider',
        isError: false,
      },
    ];
    expect(chunks.filter((chunk): chunk is ToolResultChunk => chunk.type === 'tool-result')).toEqual(
      expected,
    );
    expect((await stream.steps)[0]?.toolResults).toEqual(expected);
    // 全 provider 执行的步:无 framework 执行的结果,run 以模型自身 finishReason 收尾
    expect(await stream.finishReason).toBe('tool-calls');
  });
});

describe('Agent loop:A4 增量帧 opt-in(run option `deltas`,#173)', () => {
  /** 两步脚本:首步推理 + 文本 + 一次工具调用,次步推理 + 文本收尾。 */
  const script = () => [
    {
      reasoning: ['th', 'ink'],
      text: 'Let me check.',
      toolCalls: [{ toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } }],
      usage: { inputTokens: 3, outputTokens: 4 },
    },
    {
      reasoning: ['hm'],
      text: 'It is 21°C.',
      usage: { inputTokens: 5, outputTokens: 6 },
    },
  ];

  /** 缺省 run 的 chunk 序列:最小四帧,逐字节不变(验证面「不消费方零影响」的默认半)。 */
  const minimalChunks = [
    { type: 'text-delta', textDelta: 'Let me check.' },
    { type: 'tool-call', toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } },
    {
      type: 'finish',
      finishReason: 'tool-calls',
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    },
    {
      type: 'tool-result',
      toolCallId: 'call-1',
      toolName: 'weather',
      output: { celsius: 21 },
      isError: false,
    },
    { type: 'text-delta', textDelta: 'It is 21°C.' },
    {
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
    },
  ];

  it('缺省不发射:chunk 流逐字节等于最小四帧序列(推理 / 参数增量 part 不下发)', async () => {
    const model = fakeModel(script());
    const agent = assistantWithTools(model, {
      weather: weatherTool(() => ({ celsius: 21 })),
    });

    const chunks = await collect(agent.stream('Go.'));

    expect(chunks).toEqual(minimalChunks);
  });

  it('deltas opt-in:两族增量帧随流发射、次序与字段保真;工具仍恰执行一次,终值不受影响', async () => {
    const execute = vi.fn(() => ({ celsius: 21 }));
    const model = fakeModel(script());
    const agent = assistantWithTools(model, { weather: weatherTool(execute) });

    const run = agent.stream('Go.', { deltas: { reasoning: true, toolInput: true } });
    const chunks = await collect(run);

    expect(chunks).toEqual([
      { type: 'reasoning-delta', reasoningDelta: 'th' },
      { type: 'reasoning-delta', reasoningDelta: 'ink' },
      { type: 'text-delta', textDelta: 'Let me check.' },
      { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'weather' },
      { type: 'tool-input-delta', toolCallId: 'call-1', inputDelta: '{"city":"SF"}' },
      { type: 'tool-input-end', toolCallId: 'call-1' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'weather',
        output: { celsius: 21 },
        isError: false,
      },
      { type: 'reasoning-delta', reasoningDelta: 'hm' },
      { type: 'text-delta', textDelta: 'It is 21°C.' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
      },
    ]);
    // 参数增量是预告,不是记录:工具只在 tool-call chunk 上执行一次;终值全部来自步记录,与增量帧无关
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await run.text).toBe('It is 21°C.');
    expect(await run.finishReason).toBe('stop');
    expect(await run.usage).toEqual({ inputTokens: 8, outputTokens: 10, totalTokens: 18 });
    expect((await run.steps).length).toBe(2);
  });

  it('不消费增量帧的消费方零影响:只认最小四帧的过滤序列与缺省 run 逐字节一致', async () => {
    const defaultRun = assistantWithTools(fakeModel(script()), {
      weather: weatherTool(() => ({ celsius: 21 })),
    }).stream('Go.');
    const optInRun = assistantWithTools(fakeModel(script()), {
      weather: weatherTool(() => ({ celsius: 21 })),
    }).stream('Go.', { deltas: { reasoning: true, toolInput: true } });

    const MINIMAL = new Set(['text-delta', 'tool-call', 'tool-result', 'finish']);
    const knownOnly = (chunks: Chunk[]) => chunks.filter((chunk) => MINIMAL.has(chunk.type));

    expect(knownOnly(await collect(optInRun))).toEqual(await collect(defaultRun));
    expect(await optInRun.text).toBe(await defaultRun.text);
    expect(await optInRun.usage).toEqual(await defaultRun.usage);
  });

  it('两族开关独立:只开 reasoning 时参数增量不下发', async () => {
    const model = fakeModel(script());
    const agent = assistantWithTools(model, {
      weather: weatherTool(() => ({ celsius: 21 })),
    });

    const chunks = await collect(agent.stream('Go.', { deltas: { reasoning: true } }));

    expect(chunks).toEqual([
      { type: 'reasoning-delta', reasoningDelta: 'th' },
      { type: 'reasoning-delta', reasoningDelta: 'ink' },
      ...minimalChunks.slice(0, 4),
      { type: 'reasoning-delta', reasoningDelta: 'hm' },
      ...minimalChunks.slice(4),
    ]);
  });
});
