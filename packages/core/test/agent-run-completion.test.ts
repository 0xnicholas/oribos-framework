import { describe, expect, it, vi } from 'vitest';
import { Agent } from '@oribos/core/agent';
import type { AgentRunOptions } from '@oribos/core/agent';
import {
  createDurableAgent,
  createInMemoryAgentRunSnapshotStore,
} from '@oribos/core/durable-agent';
import {
  AGENT_RUN_SPAN,
  createTracer,
  memoryExporter,
} from '@oribos/core/observability';
import { fakeModel } from '@oribos/testing';
import {
  INSTRUCTIONS,
  assistantWithTools,
  transferTool,
  weatherSchema,
  weatherTool,
} from './helpers/agent.js';
import { collect } from './helpers/collect.js';
import { spanOfType } from './helpers/spans.js';
import { UNKNOWN_USAGE } from './helpers/usage.js';

/**
 * Run completion 契约(ADR-0019):一次 run 如何以其终态记录收尾。`finishReason === 'suspended'`
 * 是唯一的挂起判据——挂起是正常终态,不是结构化输出校验失败:挂起 Run 保留已完成 Step 的
 * text / steps / toolCalls / toolResults / usage,`object` 为 `undefined`,跳过结构化校验;
 * 完成的 Run 行为不变(含 strict 校验);失败的 Run 仍以 rejection 表达。
 *
 * 断言只走公开面(`@oribos/core/agent` / `@oribos/core/durable-agent`)与脚本化假模型接缝
 * (@see @oribos/testing);挂起在裸 Agent 上经公开 `stepBoundary` 触发,在 Durable agent 上
 * 经审批闸触发——两条入口共享同一挂起语义。
 */

/** 第一步:一次已完成的 weather 调用(文本 + 调用 + usage,结果由框架执行)。 */
const WEATHER_CALL = {
  text: 'Checking.',
  toolCalls: [{ toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } }],
  usage: { inputTokens: 3, outputTokens: 4 },
} as const;

/** 挂起步:一次待审批的 transfer 调用。 */
const TRANSFER_CALL = {
  text: 'I will move the funds.',
  toolCalls: [{ toolCallId: 'call-2', toolName: 'transfer', input: { to: 'charity' } }],
  usage: { inputTokens: 5, outputTokens: 6 },
} as const;

const WEATHER_CALL_CHUNK = {
  type: 'tool-call',
  toolCallId: 'call-1',
  toolName: 'weather',
  input: { city: 'SF' },
} as const;

const WEATHER_RESULT_CHUNK = {
  type: 'tool-result',
  toolCallId: 'call-1',
  toolName: 'weather',
  output: { celsius: 21 },
  isError: false,
} as const;

describe('Run completion:裸 Agent 经 stepBoundary 挂起', () => {
  it('第 0 步挂起:结构化 Run 以 suspended 正常落定,空终值与 object undefined', async () => {
    const model = fakeModel([TRANSFER_CALL]);
    const transfer = transferTool(vi.fn(() => 'moved'));
    const agent = assistantWithTools(model, { transfer });

    const out = agent.stream('Transfer my funds.', {
      structuredOutput: { schema: weatherSchema },
      stepBoundary: { beforeToolCalls: () => ({ suspend: true }) },
    });

    // 挂起不是错误:不抛 StructuredOutputError,chunk 流照常回放本步模型输出
    expect(await collect(out)).toEqual([
      { type: 'text-delta', textDelta: 'I will move the funds.' },
      { type: 'tool-call', toolCallId: 'call-2', toolName: 'transfer', input: { to: 'charity' } },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
      },
    ]);
    expect(await out.finishReason).toBe('suspended');
    await expect(out.object).resolves.toBeUndefined();
    expect(await out.text).toBe('');
    expect(await out.steps).toEqual([]);
    expect(await out.toolCalls).toEqual([]);
    expect(await out.toolResults).toEqual([]);
    expect(await out.usage).toEqual(UNKNOWN_USAGE);
    expect(transfer.execute).not.toHaveBeenCalled();
  });

  it('第 N 步挂起:已完成 Step 的 text / steps / toolCalls / toolResults / usage 保留', async () => {
    const model = fakeModel([WEATHER_CALL, TRANSFER_CALL]);
    const weather = weatherTool(() => ({ celsius: 21 }));
    const transfer = transferTool(vi.fn(() => 'moved'));
    const agent = assistantWithTools(model, { weather, transfer });

    const out = agent.stream('Weather, then move funds.', {
      structuredOutput: { schema: weatherSchema },
      stepBoundary: {
        beforeToolCalls: (event) => (event.stepIndex === 1 ? { suspend: true } : undefined),
      },
    });

    expect(await out.finishReason).toBe('suspended');
    await expect(out.object).resolves.toBeUndefined();
    const step = {
      text: 'Checking.',
      toolCalls: [WEATHER_CALL_CHUNK],
      toolResults: [WEATHER_RESULT_CHUNK],
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    };
    expect(await out.steps).toEqual([step]);
    expect(await out.text).toBe('Checking.');
    expect(await out.toolCalls).toEqual([WEATHER_CALL_CHUNK]);
    expect(await out.toolResults).toEqual([WEATHER_RESULT_CHUNK]);
    expect(await out.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
    expect(transfer.execute).not.toHaveBeenCalled();
  });

  it('挂起 Run 的 agent-run span 保留已完成 Step 的 output,不写入 undefined', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const model = fakeModel([WEATHER_CALL, TRANSFER_CALL]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tracer,
      tools: {
        weather: weatherTool(() => ({ celsius: 21 })),
        transfer: transferTool(vi.fn(() => 'moved')),
      },
    });

    const out = agent.stream('Weather, then move funds.', {
      structuredOutput: { schema: weatherSchema },
      stepBoundary: {
        beforeToolCalls: (event) => (event.stepIndex === 1 ? { suspend: true } : undefined),
      },
    });

    expect(await out.finishReason).toBe('suspended');
    await expect(out.object).resolves.toBeUndefined();
    // 挂起锚点:span 正常 end、带 status;结构化结果的 undefined 不覆盖已完成 Step 的 output
    const runSpan = spanOfType(memory, AGENT_RUN_SPAN);
    expect(runSpan.output).toBe('Checking.');
    expect(runSpan.attributes).toMatchObject({ status: 'suspended' });
    expect(runSpan.error).toBeUndefined();
  });

  it('generate() 与 stream() 对同一挂起 Run 报告同一组终态值', async () => {
    const options = (): AgentRunOptions => ({
      structuredOutput: { schema: weatherSchema },
      stepBoundary: { beforeToolCalls: () => ({ suspend: true }) },
    });
    const generateModel = fakeModel([TRANSFER_CALL]);
    const streamModel = fakeModel([TRANSFER_CALL]);

    const generated = await assistantWithTools(generateModel, {
      transfer: transferTool(vi.fn(() => 'moved')),
    }).generate('Transfer my funds.', options());
    const streamed = assistantWithTools(streamModel, {
      transfer: transferTool(vi.fn(() => 'moved')),
    }).stream('Transfer my funds.', options());

    expect({
      text: await streamed.text,
      object: await streamed.object,
      toolCalls: await streamed.toolCalls,
      toolResults: await streamed.toolResults,
      usage: await streamed.usage,
      steps: await streamed.steps,
      finishReason: await streamed.finishReason,
    }).toEqual({
      text: generated.text,
      object: generated.object,
      toolCalls: generated.toolCalls,
      toolResults: generated.toolResults,
      usage: generated.usage,
      steps: generated.steps,
      finishReason: generated.finishReason,
    });
  });
});

describe('Run completion:Durable agent 经审批闸挂起', () => {
  it('第 0 步挂起:object undefined,suspendPayload 与 Snapshot 形状不变', async () => {
    const model = fakeModel([TRANSFER_CALL]);
    const transfer = transferTool(vi.fn(() => 'moved'));
    const storage = createInMemoryAgentRunSnapshotStore();
    const durable = createDurableAgent({
      agent: assistantWithTools(model, { transfer }),
      storage,
      approval: { tools: ['transfer'] },
    });

    const out = durable.stream('Transfer my funds.', {
      structuredOutput: { schema: weatherSchema },
    });

    expect(await out.finishReason).toBe('suspended');
    await expect(out.object).resolves.toBeUndefined();
    expect(await out.text).toBe('');
    expect(await out.steps).toEqual([]);
    expect(await out.suspendPayload).toEqual({
      toolCalls: [
        { type: 'tool-call', toolCallId: 'call-2', toolName: 'transfer', input: { to: 'charity' } },
      ],
      awaitingApproval: ['call-2'],
    });
    // Snapshot 行为不变:挂起点、消息列表(含本步 raw assistant 消息)与 payload 原样
    const snapshot = await storage.load(out.runId);
    expect(snapshot).toMatchObject({
      runId: out.runId,
      status: 'suspended',
      stepCount: 0,
      suspendPayload: {
        toolCalls: [
          { type: 'tool-call', toolCallId: 'call-2', toolName: 'transfer', input: { to: 'charity' } },
        ],
        awaitingApproval: ['call-2'],
      },
    });
    expect(snapshot?.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will move the funds.' },
        { type: 'tool-call', toolCallId: 'call-2', toolName: 'transfer', input: { to: 'charity' } },
      ],
    });
    expect(transfer.execute).not.toHaveBeenCalled();
  });

  it('第 N 步挂起:已完成 Step 的值保留,object undefined,快照接着已完成步计数', async () => {
    const model = fakeModel([WEATHER_CALL, TRANSFER_CALL]);
    const weather = weatherTool(() => ({ celsius: 21 }));
    const transfer = transferTool(vi.fn(() => 'moved'));
    const storage = createInMemoryAgentRunSnapshotStore();
    const durable = createDurableAgent({
      agent: assistantWithTools(model, { weather, transfer }),
      storage,
      approval: { tools: ['transfer'] },
    });

    const out = durable.stream('Weather, then move funds.', {
      structuredOutput: { schema: weatherSchema },
    });

    expect(await out.finishReason).toBe('suspended');
    await expect(out.object).resolves.toBeUndefined();
    expect(await out.text).toBe('Checking.');
    expect(await out.steps).toEqual([
      {
        text: 'Checking.',
        toolCalls: [WEATHER_CALL_CHUNK],
        toolResults: [WEATHER_RESULT_CHUNK],
        usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
    ]);
    expect(await out.usage).toEqual({ inputTokens: 3, outputTokens: 4, totalTokens: 7 });
    expect(await out.toolCalls).toEqual([WEATHER_CALL_CHUNK]);
    expect(await out.toolResults).toEqual([WEATHER_RESULT_CHUNK]);
    expect(await out.suspendPayload).toEqual({
      toolCalls: [
        { type: 'tool-call', toolCallId: 'call-2', toolName: 'transfer', input: { to: 'charity' } },
      ],
      awaitingApproval: ['call-2'],
    });
    expect((await storage.load(out.runId))?.stepCount).toBe(1);
    expect(transfer.execute).not.toHaveBeenCalled();
  });

  it('resume 后完成的挂起 Run:object 正常落值(挂起只推迟结构化校验,不取消它)', async () => {
    const answer = '{"city":"Paris","temperatureCelsius":18}';
    const model = fakeModel([TRANSFER_CALL, { text: answer }]);
    const transfer = transferTool(vi.fn(() => 'moved'));
    const storage = createInMemoryAgentRunSnapshotStore();
    const durable = createDurableAgent({
      agent: assistantWithTools(model, { transfer }),
      storage,
      approval: { tools: ['transfer'] },
    });

    const out = durable.stream('Transfer my funds.', {
      structuredOutput: { schema: weatherSchema },
    });
    expect(await out.finishReason).toBe('suspended');
    await expect(out.object).resolves.toBeUndefined();

    const outcome = await durable.resume(out.runId, {
      approved: true,
      structuredOutput: { schema: weatherSchema },
    });

    expect(outcome.finishReason).toBe('stop');
    expect(outcome.object).toEqual({ city: 'Paris', temperatureCelsius: 18 });
    expect(outcome.text).toBe(answer);
    expect(transfer.execute).toHaveBeenCalledTimes(1);
  });
});

describe('Run completion:非挂起路径保持原语义', () => {
  it('完成的普通 Run:终态值不变', async () => {
    const model = fakeModel([{ text: 'Hello.', usage: { inputTokens: 1, outputTokens: 2 } }]);
    const agent = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model });

    const result = await agent.generate('Say hi.');

    expect(result).toEqual({
      text: 'Hello.',
      object: undefined,
      toolCalls: [],
      toolResults: [],
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      finishReason: 'stop',
      steps: [
        {
          text: 'Hello.',
          toolCalls: [],
          toolResults: [],
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        },
      ],
    });
  });
});
