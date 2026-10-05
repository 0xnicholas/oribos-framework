import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent } from '@oribos/core/agent';
import type { RequestContext } from '@oribos/core/agent';
import { ModelContractError } from '@oribos/core/model';
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
import { assistant, assistantWithTools } from './helpers/agent.js';
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
