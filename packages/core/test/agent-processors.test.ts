import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent } from '@oribos/core/agent';
import type {
  ProcessErrorArgs,
  ProcessInputArgs,
  ProcessOutputStepArgs,
  Processor,
} from '@oribos/core/agent';
import { ModelContractError, ModelFallbackError } from '@oribos/core/model';
import type { Chunk } from '@oribos/core/model';
import {
  AGENT_RUN_SPAN,
  AGENT_STEP_SPAN,
  createTracer,
  memoryExporter,
} from '@oribos/core/observability';
import { createTool } from '@oribos/core/tools';
import { fakeModel } from '@oribos/testing';
import { collect } from './helpers/collect.js';
import { spanOfType } from './helpers/spans.js';

/**
 * Processor 三钩(M1-12 #33,ADR-0005;docs/architecture/agent.md「扩展点:Processor」):挂在
 * `AgentConfig.processors` 上的有序处理器,按声明顺序串行执行,前一个的返回是后一个的输入。
 *
 * 三钩的触发时机与改写能力:
 * - `processInput`:run 开始一次(动态解析之后、首次模型调用之前),返回 `{ messages }` 改写本次 prompt;
 * - `processOutputStep`:每个 step 完成后一次(该步模型流结束、工具执行完),返回 `{ step }` 改写 step
 *   记录——改写后的记录是 run 的权威记录(steps[] / text / usage / 下一轮 prompt),chunk 流本身仍是
 *   模型原始产出(chunk 级流式 processor 裁出 v1,ADR-0005);
 * - `processError`:provider / 工具错误时,返回 `{ error }` 替换错误;provider 错误替换 run 终错,工具
 *   错误替换进入 error 工具结果的错误;不做 abort/retry,取消(abort)不触发。
 *
 * 断言只走公开面(@oribos/core/agent)与脚本化假模型接缝(@see @oribos/testing):假模型录制的
 * prompt 就是"模型看到的历史",是改写能力的最终证据。
 */

const INSTRUCTIONS = 'You are concise.';

/** 参考处理器:把 user 消息整体替换为一行文本(processInput 改写的最小样例)。 */
function redactingInput(seen: ProcessInputArgs[], replacement: string): Processor {
  return {
    processInput(args) {
      seen.push(args);
      return {
        messages: args.messages.map((message) =>
          message.role === 'user'
            ? { role: 'user' as const, content: [{ type: 'text' as const, text: replacement }] }
            : message,
        ),
      };
    },
  };
}

describe('processInput:run 开始一次,可改写输入消息', () => {
  it('改写后的消息成为模型 prompt(instructions 已解析进来);请求上下文随手取用', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const seen: ProcessInputArgs[] = [];
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      processors: [redactingInput(seen, 'REDACTED')],
    });

    await agent.generate('top secret', { tenant: 'acme' });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.requestContext.tenant).toBe('acme');
    expect(seen[0]?.requestContext.runId).toBeTypeOf('string');
    expect(model.streamCalls[0]?.prompt).toEqual([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'REDACTED' }] },
    ]);
  });

  it('run 级触发:多 step 的 run 只触发一次,第二次 run 再触发一次', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'ping', input: {} }] },
      { text: 'done' },
      { text: 'second run' },
    ]);
    const seen: ProcessInputArgs[] = [];
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: { ping: createTool({ description: 'Pings.', execute: () => 'pong' }) },
      processors: [redactingInput(seen, 'REDACTED')],
    });

    await agent.generate('one');
    await agent.generate('two');

    expect(seen).toHaveLength(2);
    expect(model.streamCalls).toHaveLength(3);
  });

  it('动态 instructions 解析之后才触发:processor 看到解析后的系统消息', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const seen: ProcessInputArgs[] = [];
    const agent = new Agent({
      name: 'assistant',
      instructions: (ctx) => `You serve ${String(ctx.tenant)}.`,
      model,
      processors: [{ processInput: (args) => void seen.push(args) }],
    });

    await agent.generate('Hi.', { tenant: 'acme' });

    expect(seen[0]?.messages).toEqual([
      { role: 'system', content: 'You serve acme.' },
      { role: 'user', content: [{ type: 'text', text: 'Hi.' }] },
    ]);
  });

  it('返回 void 时 prompt 原样;钩子可异步', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const ran: string[] = [];
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      processors: [
        {
          async processInput() {
            await Promise.resolve();
            ran.push('async');
          },
        },
      ],
    });

    await agent.generate('Hi.');

    expect(ran).toEqual(['async']);
    expect(model.streamCalls[0]?.prompt).toEqual([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'Hi.' }] },
    ]);
  });

  it('多 processor 按声明顺序链式执行:后一个看到前一个改写后的消息', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const order: string[] = [];
    const first: Processor = {
      processInput({ messages }) {
        order.push('first');
        return {
          messages: [...messages, { role: 'user', content: [{ type: 'text', text: 'first' }] }],
        };
      },
    };
    const second: Processor = {
      processInput({ messages }) {
        order.push('second');
        return {
          messages: [...messages, { role: 'user', content: [{ type: 'text', text: 'second' }] }],
        };
      },
    };
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      processors: [first, second],
    });

    await agent.generate('Hi.');

    expect(order).toEqual(['first', 'second']);
    expect(model.streamCalls[0]?.prompt).toEqual([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'Hi.' }] },
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ]);
  });
});

describe('processOutputStep:每个 step 完成后可见可改 step 记录', () => {
  it('每步一次,时机在该步工具执行之后;记录完整(含工具结果与 usage)', async () => {
    const order: string[] = [];
    const seen: ProcessOutputStepArgs[] = [];
    const model = fakeModel([
      {
        text: 'Checking.',
        toolCalls: [{ toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } }],
        usage: { inputTokens: 3, outputTokens: 4 },
      },
      { text: 'It is 21°C.', usage: { inputTokens: 5, outputTokens: 6 } },
    ]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: {
        weather: createTool({
          description: 'Looks up the weather.',
          execute: () => {
            order.push('tool');
            return { celsius: 21 };
          },
        }),
      },
      processors: [
        {
          processOutputStep(args) {
            seen.push(args);
            // 触发时刻的证据:该步的模型调用已发生,且该步的工具已执行
            order.push(`step-${args.stepIndex}:${model.streamCalls.length}`);
          },
        },
      ],
    });

    const result = await agent.generate('Weather in SF?');

    expect(order).toEqual(['tool', 'step-0:1', 'step-1:2']);
    expect(seen.map((args) => args.stepIndex)).toEqual([0, 1]);
    expect(seen[0]?.step).toEqual({
      text: 'Checking.',
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
    });
    expect(seen[1]?.step).toEqual({
      text: 'It is 21°C.',
      toolCalls: [],
      toolResults: [],
      usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
    });
    expect(result.text).toBe('It is 21°C.');
  });

  it('改写 step 记录 = 改写 run 的权威记录:终值 text / steps / usage 反映改写,chunk 流仍是原始产出', async () => {
    const model = fakeModel([{ text: 'secret answer', usage: { inputTokens: 1, outputTokens: 2 } }]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      processors: [
        {
          processOutputStep({ step }) {
            return {
              step: {
                ...step,
                text: '[redacted]',
                usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              },
            };
          },
        },
      ],
    });

    const stream = agent.stream('Q.');
    const chunks = await collect(stream);

    // chunk 协议是模型的原始流(chunk 级改写裁出 v1)
    expect(chunks).toEqual([
      { type: 'text-delta', textDelta: 'secret answer' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    ]);
    // 权威记录是改写后的
    await expect(stream.text).resolves.toBe('[redacted]');
    await expect(stream.steps).resolves.toEqual([
      {
        text: '[redacted]',
        toolCalls: [],
        toolResults: [],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    ]);
    await expect(stream.usage).resolves.toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });

  it('改写工具结果:下一轮模型 prompt 与 steps[] 都反映改写后的结果', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } }] },
      { text: 'done' },
    ]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: { weather: createTool({ description: 'Looks up the weather.', execute: () => '21°C' }) },
      processors: [
        {
          processOutputStep({ step, stepIndex }) {
            if (stepIndex !== 0) return;
            return { step: { ...step, toolResults: step.toolResults.map((result) => ({ ...result, output: 'REDACTED' })) } };
          },
        },
      ],
    });

    const result = await agent.generate('Weather in SF?');

    expect(model.streamCalls[1]?.prompt).toEqual([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'Weather in SF?' }] },
      {
        role: 'assistant',
        content: [
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
            output: { type: 'text', value: 'REDACTED' },
          },
        ],
      },
    ]);
    expect(result.steps[0]?.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'weather',
        output: 'REDACTED',
        isError: false,
      },
    ]);
  });

  it('provider 执行的结果同样进入记录且可改写:assistant 消息里的回显随之改写', async () => {
    const model = fakeModel([
      {
        toolCalls: [
          { toolCallId: 'call-provider', toolName: 'web_search', input: { q: 'x' } },
          { toolCallId: 'call-client', toolName: 'ping', input: {} },
        ],
        toolResults: [
          { toolCallId: 'call-provider', toolName: 'web_search', result: { hits: 1 } },
        ],
      },
      { text: 'done' },
    ]);
    const seen: ProcessOutputStepArgs[] = [];
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: { ping: createTool({ description: 'Pings.', execute: () => 'pong' }) },
      processors: [
        {
          processOutputStep(args) {
            seen.push(args);
            if (args.stepIndex !== 0) return;
            return {
              step: {
                ...args.step,
                toolResults: args.step.toolResults.map((result) =>
                  result.toolCallId === 'call-provider'
                    ? { ...result, output: 'REDACTED' }
                    : result,
                ),
              },
            };
          },
        },
      ],
    });

    const result = await agent.generate('Q.');

    // processor 看到原始记录:provider 执行的结果与框架执行的结果同列
    expect(seen[0]?.step.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-provider',
        toolName: 'web_search',
        output: { hits: 1 },
        isError: false,
      },
      {
        type: 'tool-result',
        toolCallId: 'call-client',
        toolName: 'ping',
        output: 'pong',
        isError: false,
      },
    ]);
    // provider 结果在 assistant 消息里回显;改写后进下一轮 prompt
    expect(model.streamCalls[1]?.prompt).toEqual([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'Q.' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-provider',
            toolName: 'web_search',
            input: { q: 'x' },
          },
          { type: 'tool-call', toolCallId: 'call-client', toolName: 'ping', input: {} },
          {
            type: 'tool-result',
            toolCallId: 'call-provider',
            toolName: 'web_search',
            output: { type: 'text', value: 'REDACTED' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-client',
            toolName: 'ping',
            output: { type: 'text', value: 'pong' },
          },
        ],
      },
    ]);
    expect(result.steps[0]?.toolResults[0]?.output).toBe('REDACTED');
  });

  it('run span 的 output 是改写后的终值;agent-step 仍是模型原始响应', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const model = fakeModel([{ text: 'secret answer' }]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tracer,
      processors: [{ processOutputStep: ({ step }) => ({ step: { ...step, text: '[redacted]' } }) }],
    });

    await agent.generate('Q.');

    expect(spanOfType(memory, AGENT_RUN_SPAN).output).toBe('[redacted]');
    expect(spanOfType(memory, AGENT_STEP_SPAN).output).toBe('secret answer');
  });

  it('多 processor 按声明顺序链式执行:后一个收到前一个改写后的记录', async () => {
    const model = fakeModel([{ text: 'a' }]);
    const order: string[] = [];
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      processors: [
        {
          processOutputStep({ step }) {
            order.push(`first:${step.text}`);
            return { step: { ...step, text: `${step.text}b` } };
          },
        },
        {
          processOutputStep({ step }) {
            order.push(`second:${step.text}`);
            return { step: { ...step, text: `${step.text}c` } };
          },
        },
      ],
    });

    const result = await agent.generate('Q.');

    expect(order).toEqual(['first:a', 'second:ab']);
    expect(result.text).toBe('abc');
  });

  it('模型流中途失败:step 未完成,processOutputStep 不触发(run 以错误拒绝)', async () => {
    const model = fakeModel([{ text: 'partial', errorAfter: new Error('upstream exploded') }]);
    const processOutputStep = vi.fn();
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      processors: [{ processOutputStep }],
    });

    await expect(agent.generate('Q.')).rejects.toThrow('upstream exploded');
    expect(processOutputStep).not.toHaveBeenCalled();
  });
});

describe('processError:provider / 工具错误时观察并可替换错误', () => {
  it('provider 失败(链耗尽):收到 source model 与原错误;替换后 run 以替换错误拒绝', async () => {
    const original = new Error('provider down');
    const model = fakeModel([{ fail: original }]);
    const seen: ProcessErrorArgs[] = [];
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      processors: [
        {
          processError(args) {
            seen.push(args);
            return { error: new Error('masked', { cause: args.error }) };
          },
        },
      ],
    });

    const stream = agent.stream('Hi.');
    await expect(stream.text).rejects.toThrow('masked');

    expect(seen).toHaveLength(1);
    expect(seen[0]?.source).toBe('model');
    expect(seen[0]?.stepIndex).toBe(0);
    expect(seen[0]?.toolCall).toBeUndefined();
    expect(seen[0]?.error).toBe(original);
    expect((seen[0]?.requestContext.runId ?? '')).not.toBe('');
  });

  it('模型流中途失败同样触发:已产 chunk 照常交付,终值以替换错误拒绝', async () => {
    const model = fakeModel([{ text: 'partial', errorAfter: new Error('upstream exploded') }]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      processors: [{ processError: () => ({ error: new Error('masked') }) }],
    });

    const stream = agent.stream('Hi.');
    const received: Chunk[] = [];

    await expect(
      (async () => {
        for await (const chunk of stream) received.push(chunk);
      })(),
    ).rejects.toThrow('masked');

    expect(received).toEqual([{ type: 'text-delta', textDelta: 'partial' }]);
    await expect(stream.text).rejects.toThrow('masked');
  });

  it('工具 execute 抛错:source tool 带 toolCall;替换后的错误进入回喂结果,run 不中止', async () => {
    const explosion = new Error('token=abc123');
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'boom', input: {} }] },
      { text: 'recovered' },
    ]);
    const seen: ProcessErrorArgs[] = [];
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: {
        boom: {
          description: 'Always fails.',
          execute: () => {
            throw explosion;
          },
        },
      },
      processors: [
        {
          processError(args) {
            seen.push(args);
            return { error: new Error('[redacted]') };
          },
        },
      ],
    });

    const result = await agent.generate('Go.');

    expect(seen).toHaveLength(1);
    expect(seen[0]?.source).toBe('tool');
    expect(seen[0]?.stepIndex).toBe(0);
    expect(seen[0]?.toolCall).toEqual({
      type: 'tool-call',
      toolCallId: 'call-1',
      toolName: 'boom',
      input: {},
    });
    expect(seen[0]?.error).toBe(explosion);

    // 替换后的错误进入 error 工具结果:回喂模型、落 steps[](框架的 Tool 'x' failed: 前缀保持,替换只填细节)
    expect(model.streamCalls[1]?.prompt).toEqual([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'Go.' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'boom', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'boom',
            output: { type: 'error-text', value: "Tool 'boom' failed: [redacted]" },
          },
        ],
      },
    ]);
    expect(result.steps[0]?.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'boom',
        output: "Tool 'boom' failed: [redacted]",
        isError: true,
      },
    ]);
    expect(result.text).toBe('recovered');
  });

  it('未替换(void)时错误语义不变:原消息回喂,run 照常继续', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'boom', input: {} }] },
      { text: 'recovered' },
    ]);
    const observed: unknown[] = [];
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: {
        boom: {
          description: 'Always fails.',
          execute: () => {
            throw new Error('boom');
          },
        },
      },
      processors: [{ processError: ({ error }) => void observed.push(error) }],
    });

    const result = await agent.generate('Go.');

    expect(observed).toHaveLength(1);
    expect((observed[0] as Error).message).toBe('boom');
    expect(result.steps[0]?.toolResults[0]?.output).toBe("Tool 'boom' failed: boom");
    expect(result.text).toBe('recovered');
  });

  it('工具 input 校验失败同样走 processError:替换后的错误进入 error 工具结果', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'weather', input: { city: 123 } }] },
      { text: 'recovered' },
    ]);
    const seen: ProcessErrorArgs[] = [];
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: {
        weather: createTool({
          description: 'Looks up the weather.',
          inputSchema: z.object({ city: z.string() }),
          execute: () => '21°C',
        }),
      },
      processors: [
        {
          processError(args) {
            seen.push(args);
            return { error: new Error('bad arguments') };
          },
        },
      ],
    });

    const result = await agent.generate('Go.');

    expect(seen[0]?.source).toBe('tool');
    expect(result.steps[0]?.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'weather',
        output: 'bad arguments',
        isError: true,
      },
    ]);
    expect(result.text).toBe('recovered');
  });

  it('未知工具与 output 校验失败同样走 processError:source 为 tool', async () => {
    const unknownModel = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'nope', input: {} }] },
      { text: 'recovered' },
    ]);
    const unknownSeen: ProcessErrorArgs[] = [];
    const unknownAgent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: unknownModel,
      processors: [{ processError: (args) => void unknownSeen.push(args) }],
    });

    await unknownAgent.generate('Go.');

    expect(unknownSeen[0]?.source).toBe('tool');
    expect((unknownSeen[0]?.error as Error).message).toContain("Unknown tool 'nope'");

    const invalidModel = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } }] },
      { text: 'recovered' },
    ]);
    const invalidSeen: ProcessErrorArgs[] = [];
    const invalidAgent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: invalidModel,
      tools: {
        // 手写字面量(合法工具)故意返回不合 outputSchema 的值
        weather: {
          description: 'Looks up the weather.',
          outputSchema: z.object({ celsius: z.number() }),
          execute: () => ({ celsius: 'warm' }),
        },
      },
      processors: [
        {
          processError(args) {
            invalidSeen.push(args);
            return { error: new Error('contract broken') };
          },
        },
      ],
    });

    const result = await invalidAgent.generate('Go.');

    expect(invalidSeen[0]?.source).toBe('tool');
    expect((invalidSeen[0]?.error as Error).message).toContain('invalid output');
    expect(result.steps[0]?.toolResults[0]?.output).toBe('contract broken');
    expect(result.text).toBe('recovered');
  });

  it('流契约违背(缺 finish part)也走 processError:替换后 run 以替换错误拒绝', async () => {
    const model = fakeModel([{ text: 'no finish', omitFinish: true }]);
    const seen: ProcessErrorArgs[] = [];
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      processors: [
        {
          processError(args) {
            seen.push(args);
            return { error: new Error('masked contract') };
          },
        },
      ],
    });

    await expect(agent.generate('Hi.')).rejects.toThrow('masked contract');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.source).toBe('model');
    expect(seen[0]?.error).toBeInstanceOf(ModelContractError);
  });

  it('多 processor 按声明顺序链式替换:后一个收到前一个的错误', async () => {
    const model = fakeModel([{ fail: new Error('provider down') }]);
    const order: string[] = [];
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      processors: [
        {
          processError({ error }) {
            order.push(`first:${(error as Error).message}`);
            return { error: new Error('first') };
          },
        },
        {
          processError({ error }) {
            order.push(`second:${(error as Error).message}`);
            return { error: new Error('second') };
          },
        },
      ],
    });

    await expect(agent.generate('Hi.')).rejects.toThrow('second');
    expect(order).toEqual(['first:provider down', 'second:first']);
  });

  it('回退链内部失败不触发,链耗尽才以链错误触发一次', async () => {
    // 第一步:首个候选失败、第二候选接住 —— 回退是内部恢复,processError 不参与
    const first = fakeModel([{ text: 'ok' }]);
    const recovered = fakeModel([{ fail: new Error('first down') }]);
    const seen: ProcessErrorArgs[] = [];
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: [recovered, first],
      processors: [{ processError: (args) => void seen.push(args) }],
    });

    await expect(agent.generate('Hi.')).resolves.toMatchObject({ text: 'ok' });
    expect(seen).toEqual([]);

    // 全链失败:processError 只收到一次,错误是携带各候选的 ModelFallbackError
    const exhausted = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: [fakeModel([{ fail: new Error('a down') }]), fakeModel([{ fail: new Error('b down') }])],
      processors: [{ processError: (args) => void seen.push(args) }],
    });

    await expect(exhausted.generate('Hi.')).rejects.toBeInstanceOf(ModelFallbackError);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.source).toBe('model');
    expect(seen[0]?.error).toBeInstanceOf(ModelFallbackError);
  });

  it('工具错误的两个钩子次序:processError(错误边界)先于 processOutputStep(step 完成)', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'boom', input: {} }] },
      { text: 'recovered' },
    ]);
    const order: string[] = [];
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: {
        boom: {
          description: 'Always fails.',
          execute: () => {
            throw new Error('boom');
          },
        },
      },
      processors: [
        {
          processError: () => void order.push('error'),
          processOutputStep: ({ step }) => void order.push(`step:${step.toolResults.length}`),
        },
      ],
    });

    await agent.generate('Go.');

    expect(order).toEqual(['error', 'step:1', 'step:0']);
  });

  it('取消(abort)不触发 processError:run 以中止原因拒绝,processError 未被调用', async () => {
    const model = fakeModel([{ text: 'never sent' }]);
    const processError = vi.fn();
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      processors: [{ processError }],
    });
    const controller = new AbortController();
    controller.abort(new Error('cancelled by host'));

    await expect(agent.generate('Hi.', { signal: controller.signal })).rejects.toThrow(
      'cancelled by host',
    );
    expect(processError).not.toHaveBeenCalled();
  });
});

describe('钩子自身抛错(AG-40):即 run 失败,不再交给 processError(处理器不互相处理)', () => {
  it('processInput 抛错:run 以该错误拒绝,模型调用未发起,processError 零调用', async () => {
    const boom = new Error('processInput boom');
    const model = fakeModel([{ text: 'ok' }]);
    const processError = vi.fn();
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      processors: [
        {
          processInput: () => {
            throw boom;
          },
        },
        { processError },
      ],
    });

    await expect(agent.generate('Hi.')).rejects.toBe(boom);
    expect(processError).not.toHaveBeenCalled();
    expect(model.streamCalls).toHaveLength(0);
  });

  it('processOutputStep 抛错:run 以该错误拒绝,processError 零调用', async () => {
    const boom = new Error('processOutputStep boom');
    const model = fakeModel([{ text: 'ok' }]);
    const processError = vi.fn();
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      processors: [
        {
          processOutputStep: () => {
            throw boom;
          },
        },
        { processError },
      ],
    });

    await expect(agent.generate('Hi.')).rejects.toBe(boom);
    expect(processError).not.toHaveBeenCalled();
  });

  it('processError 抛错:run 以钩子抛出的错误拒绝(非原错误),链上后续 processError 不再被喂', async () => {
    const original = new Error('provider down');
    const boom = new Error('processError boom');
    const model = fakeModel([{ fail: original }]);
    const downstream = vi.fn();
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      processors: [
        {
          processError: () => {
            throw boom;
          },
        },
        { processError: downstream },
      ],
    });

    await expect(agent.generate('Hi.')).rejects.toBe(boom);
    expect(downstream).not.toHaveBeenCalled();
  });
});
