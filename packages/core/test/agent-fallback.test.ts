import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent } from '@oribos/core/agent';
import { ModelContractError, ModelFallbackError, ModelSpecificationVersionError } from '@oribos/core/model';
import type { Chunk, Model } from '@oribos/core/model';
import {
  AGENT_RUN_SPAN,
  AGENT_STEP_SPAN,
  TOOL_CALL_SPAN,
  createTracer,
  memoryExporter,
} from '@oribos/core/observability';
import { createTool } from '@oribos/core/tools';
import { fakeModel } from '@oribos/testing';
import { assistant, assistantWithTools } from './helpers/agent.js';
import { captureError, captureRejection } from './helpers/assertions.js';
import { spanOfType } from './helpers/spans.js';

/**
 * 模型 fallback 链(M1-11 #32,ADR-0004 / model.md「model 字段形状」):model 字段接受模型数组,
 * 每次模型调用按数组顺序逐项尝试;仅在"该次尝试尚未产出任何 chunk"的失败时切换下一项,流中途失败
 * 直接报错(部分输出已发给调用方,切换会产生拼接幻觉);链上全部失败时错误含沿链上下文。
 * 断言只走公开面(@oribos/core 子路径导出)与脚本化假模型接缝(@see @oribos/testing)。
 */
const INSTRUCTIONS = 'You are concise.';

/** 结构上像模型、但 spec 版本属于上一代的实例(模拟旧 provider 包)。 */
function outdatedModel(): unknown {
  return {
    specificationVersion: 'v3',
    provider: 'openai',
    modelId: 'gpt-4o',
    doGenerate: async () => ({}),
    doStream: async () => ({}),
  };
}

describe('fallback 链:未产 chunk 的失败才切换', () => {
  it('首模型未产 chunk 即失败:切换次模型并跑通,终值全部来自次模型', async () => {
    const primary = fakeModel([{ fail: new Error('primary down') }], { modelId: 'primary' });
    const backup = fakeModel([{ text: 'from backup', usage: { inputTokens: 1, outputTokens: 2 } }], {
      modelId: 'backup',
    });
    const agent = assistant([primary, backup]);

    const result = await agent.generate('Hi.');

    expect(result).toEqual({
      text: 'from backup',
      toolCalls: [],
      toolResults: [],
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      finishReason: 'stop',
      steps: [
        {
          text: 'from backup',
          toolCalls: [],
          toolResults: [],
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        },
      ],
    });
    // 两个候选看到同一份 prompt(同一 run 的同一请求)
    expect(primary.streamCalls).toHaveLength(1);
    expect(backup.streamCalls[0]?.prompt).toEqual(primary.streamCalls[0]?.prompt);
  });

  it('按数组顺序逐项尝试:第一个跑通的模型服务该步,其后的候选不再调用', async () => {
    const first = fakeModel([{ fail: new Error('first down') }], { modelId: 'first' });
    const second = fakeModel([{ text: 'second answer' }], { modelId: 'second' });
    const third = fakeModel([{ text: 'third answer' }], { modelId: 'third' });
    const agent = assistant([first, second, third]);

    const result = await agent.generate('Hi.');

    expect(result.text).toBe('second answer');
    expect(first.streamCalls).toHaveLength(1);
    expect(second.streamCalls).toHaveLength(1);
    expect(third.streamCalls).toHaveLength(0);
  });

  it('判据是 chunk 协议而非原生 part:只下了推理增量的失败仍算未产 chunk,照常切换', async () => {
    const primary = fakeModel([{ reasoning: ['th', 'ink'], errorAfter: new Error('primary down') }], {
      modelId: 'primary',
    });
    const backup = fakeModel([{ text: 'from backup' }], { modelId: 'backup' });
    const agent = assistant([primary, backup]);

    const result = await agent.generate('Hi.');

    expect(result.text).toBe('from backup');
    expect(backup.streamCalls).toHaveLength(1);
  });

  it('每一步的模型调用都从链首重新尝试:第一步由首模型服务,第二步首模型失败即切换', async () => {
    const primary = fakeModel(
      [
        {
          text: 'Checking.',
          toolCalls: [{ toolCallId: 'call-1', toolName: 'echo', input: { q: 'hi' } }],
        },
        { fail: new Error('primary down mid-run') },
      ],
      { modelId: 'primary' },
    );
    const backup = fakeModel([{ text: 'backup finished' }], { modelId: 'backup' });
    const echo = createTool({
      description: 'Echoes.',
      inputSchema: z.object({ q: z.string() }),
      execute: ({ q }) => `echo ${q}`,
    });
    const agent = assistantWithTools([primary, backup], { echo });

    const result = await agent.generate('Go.');

    expect(result.text).toBe('backup finished');
    expect(result.steps.map((step) => step.text)).toEqual(['Checking.', 'backup finished']);
    // 第二步仍先试首模型,失败后才轮到次模型
    expect(primary.streamCalls).toHaveLength(2);
    expect(backup.streamCalls).toHaveLength(1);
    // 第二步的次模型接着第一步的历史继续(assistant tool-call + tool 结果都在 prompt 里)
    expect(backup.streamCalls[0]?.prompt).toEqual([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'Go.' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'echo', input: { q: 'hi' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'echo',
            output: { type: 'text', value: 'echo hi' },
          },
        ],
      },
    ]);
  });

  it('动态 model 解析出的链同样参与 fallback,解析器每 run 只调用一次', async () => {
    const primary = fakeModel([{ fail: new Error('primary down') }], { modelId: 'primary' });
    const backup = fakeModel([{ text: 'from backup' }], { modelId: 'backup' });
    const model = vi.fn(() => [primary, backup]);
    const agent = assistant(model);

    const result = await agent.generate('Hi.', { tenant: 'acme' });

    expect(result.text).toBe('from backup');
    expect(model).toHaveBeenCalledTimes(1);
    expect(primary.generateCalls).toHaveLength(0);
  });
});

describe('fallback 链:流中途失败不切换', () => {
  it('首个 chunk 之后的失败:run 以原错误拒绝,链上后续模型不调用', async () => {
    const explosion = new Error('stream exploded');
    const primary = fakeModel([{ text: ['par', 'tial'], errorAfter: explosion }], {
      modelId: 'primary',
    });
    const backup = fakeModel([{ text: 'never used' }], { modelId: 'backup' });
    const agent = assistant([primary, backup]);

    const error = await captureRejection(() => agent.generate('Hi.'));

    expect(error).toBe(explosion);
    expect(backup.streamCalls).toHaveLength(0);
  });

  it('中途失败前已产出的 chunk 照常交付给消费者', async () => {
    const explosion = new Error('stream exploded');
    const primary = fakeModel([{ text: ['par', 'tial'], errorAfter: explosion }], {
      modelId: 'primary',
    });
    const agent = assistant([primary, fakeModel([{ text: 'never used' }])]);
    const chunks: Chunk[] = [];

    const error = await captureRejection(async () => {
      for await (const chunk of agent.stream('Hi.')) chunks.push(chunk);
    });

    expect(error).toBe(explosion);
    expect(chunks).toEqual([
      { type: 'text-delta', textDelta: 'par' },
      { type: 'text-delta', textDelta: 'tial' },
    ]);
  });

  it('run 已中止:原中止原因浮出,链上后续模型不调用(取消不是链失败)', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled by host'));
    const primary = fakeModel([{ text: 'never sent' }], { modelId: 'primary' });
    const backup = fakeModel([{ text: 'never sent either' }], { modelId: 'backup' });
    const agent = assistant([primary, backup]);

    const error = await captureRejection(() =>
      agent.generate('Hi.', { signal: controller.signal }),
    );

    expect(error).not.toBeInstanceOf(ModelFallbackError);
    expect(error.message).toBe('cancelled by host');
    expect(primary.streamCalls).toHaveLength(0);
    expect(backup.streamCalls).toHaveLength(0);
  });
});

describe('fallback 链:全部失败', () => {
  it('链上全部失败:错为 ModelFallbackError,消息含每个候选与各自错误,沿链上下文保留', async () => {
    const primaryError = new Error('primary down');
    const backupError = new Error('backup down');
    const primary = fakeModel([{ fail: primaryError }], { provider: 'openai', modelId: 'gpt-4o' });
    const backup = fakeModel([{ fail: backupError }], {
      provider: 'anthropic',
      modelId: 'claude-sonnet-4',
    });
    const agent = assistant([primary, backup]);

    const error = await captureRejection(() => agent.generate('Hi.'));

    expect(error).toBeInstanceOf(ModelFallbackError);
    expect(error.name).toBe('ModelFallbackError');
    expect(error.message).toContain("'openai/gpt-4o'");
    expect(error.message).toContain('primary down');
    expect(error.message).toContain("'anthropic/claude-sonnet-4'");
    expect(error.message).toContain('backup down');
    const fallback = error as ModelFallbackError;
    expect(fallback.failures.map((failure) => [failure.model.modelId, failure.error])).toEqual([
      ['gpt-4o', primaryError],
      ['claude-sonnet-4', backupError],
    ]);
    expect(fallback.cause).toBe(backupError);
    expect(primary.streamCalls).toHaveLength(1);
    expect(backup.streamCalls).toHaveLength(1);
  });

  it('单元素链:正常服务该步;失败时原错误原样浮出,不包装', async () => {
    const boom = new Error('provider down');
    const only = fakeModel([{ fail: boom }]);
    const agent = assistant([only]);

    const error = await captureRejection(() => agent.generate('Hi.'));

    expect(error).toBe(boom);
    expect(only.streamCalls).toHaveLength(1);
  });
});

describe('fallback 链:解析期断言与形状', () => {
  it('静态链中的候选不满足模型契约:构造 Agent 即报错(不是运行中途)', () => {
    const error = captureError(() =>
      assistant([fakeModel([{ text: 'ok' }]), outdatedModel() as Model]),
    );

    expect(error).toBeInstanceOf(ModelSpecificationVersionError);
    expect(error.message).toContain("'v3'");
  });

  it('动态解析出的链同样在解析期断言:run 拒绝且不发模型调用', async () => {
    const healthy = fakeModel([{ text: 'never sent' }]);
    const agent = assistant(() => [healthy, outdatedModel() as Model]);

    const error = await captureRejection(() => agent.generate('Hi.'));

    expect(error).toBeInstanceOf(ModelSpecificationVersionError);
    expect(healthy.streamCalls).toHaveLength(0);
  });

  it('空链:静态在构造期显式报错', () => {
    const error = captureError(() => assistant([]));

    expect(error).toBeInstanceOf(ModelContractError);
    expect(error.message).toMatch(/empty/i);
  });

  it('空链:动态解析出的空链在 run 解析期报错', async () => {
    const agent = assistant(() => []);

    const error = await captureRejection(() => agent.generate('Hi.'));

    expect(error).toBeInstanceOf(ModelContractError);
    expect(error.message).toMatch(/empty/i);
  });

  it('静态链原样持有:agent.model 是传入的数组(不复制)', () => {
    const chain = [fakeModel([{ text: 'a' }]), fakeModel([{ text: 'b' }])];
    const agent = assistant(chain);

    expect(agent.model).toBe(chain);
  });
});

describe('fallback 链:观测', () => {
  it('切换在 trace 里可见:每次尝试各成一个 agent-step span,失败带 error、服务该步的带 usage / finishReason', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const failure = new Error('primary down');
    const primary = fakeModel([{ fail: failure }], { provider: 'openai', modelId: 'primary' });
    const backup = fakeModel([{ text: 'ok', usage: { inputTokens: 1, outputTokens: 2 } }], {
      provider: 'anthropic',
      modelId: 'backup',
    });
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: [primary, backup],
      tracer,
    });

    await agent.generate('Hi.');

    const run = spanOfType(memory, AGENT_RUN_SPAN);
    const steps = memory.spans().filter((span) => span.type === AGENT_STEP_SPAN);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      name: 'primary',
      parentSpanId: run.id,
      traceId: run.traceId,
      error: { message: 'primary down', details: failure },
    });
    expect(steps[0]?.attributes).toMatchObject({ model: 'primary', provider: 'openai' });
    expect(steps[1]).toMatchObject({ name: 'backup', parentSpanId: run.id, output: 'ok' });
    expect(steps[1]?.attributes).toMatchObject({
      model: 'backup',
      provider: 'anthropic',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      finishReason: 'stop',
      timeToFirstChunk: expect.any(Number),
    });
    // 切换成功了:run 自身不落 error,output 是服务者的产出
    expect(run.error).toBeUndefined();
    expect(run.output).toBe('ok');
  });

  it('链上全部失败:run span 落 ModelFallbackError,每个尝试 span 各带自己的错误', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const primary = fakeModel([{ fail: new Error('primary down') }], { modelId: 'primary' });
    const backup = fakeModel([{ fail: new Error('backup down') }], { modelId: 'backup' });
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: [primary, backup],
      tracer,
    });

    await expect(agent.generate('Hi.')).rejects.toBeInstanceOf(ModelFallbackError);

    const run = spanOfType(memory, AGENT_RUN_SPAN);
    expect(run.error?.message).toContain('primary down');
    expect(run.error?.message).toContain('backup down');
    const steps = memory.spans().filter((span) => span.type === AGENT_STEP_SPAN);
    expect(steps.map((span) => span.name)).toEqual(['primary', 'backup']);
    expect(steps.map((span) => span.error?.message)).toEqual(['primary down', 'backup down']);
    for (const span of steps) expect(span.endTime).toBeInstanceOf(Date);
  });

  it('切换后工具调用 span 挂在实际服务该步的 step span 下', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const primary = fakeModel([{ fail: new Error('primary down') }], { modelId: 'primary' });
    const backup = fakeModel(
      [
        { toolCalls: [{ toolCallId: 'call-1', toolName: 'probe', input: {} }] },
        { text: 'done' },
      ],
      { modelId: 'backup' },
    );
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: [primary, backup],
      tools: { probe: { description: 'Probes.', execute: () => 'ok' } },
      tracer,
    });

    await agent.generate('Go.');

    const steps = memory.spans().filter((span) => span.type === AGENT_STEP_SPAN);
    // 每次模型调用都从链首走:两步各有一个失败的 primary span,服务该步的 backup span
    expect(steps.map((span) => span.name)).toEqual(['primary', 'backup', 'primary', 'backup']);
    expect(spanOfType(memory, TOOL_CALL_SPAN).parentSpanId).toBe(steps[1]?.id);
  });
});
