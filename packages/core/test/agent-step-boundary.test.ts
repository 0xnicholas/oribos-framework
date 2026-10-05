import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent } from '@oribos/core/agent';
import type {
  AgentStepBoundary,
  AgentStepBoundaryEvent,
  AgentToolCallsBoundaryEvent,
} from '@oribos/core/agent';
import { AGENT_RUN_SPAN, createTracer, memoryExporter } from '@oribos/core/observability';
import { createTool } from '@oribos/core/tools';
import type { Tool } from '@oribos/core/tools';
import { fakeModel } from '@oribos/testing';
import { INSTRUCTIONS, assistantWithTools } from './helpers/agent.js';
import { collect } from './helpers/collect.js';
import { SPAN_ID, TRACE_ID, eventsOfType, kinds, spanOfType } from './helpers/spans.js';

/**
 * agent loop step 边界缝(M4 #56,`docs/architecture/harness.md`「与其它子系统的关系」):
 * `AgentRunOptions.stepBoundary` 双相位挂接——`beforeToolCalls`(模型返回 tool-calls 后、
 * 执行前;durable 审批闸挂点,事件携带快照取数面 messages + stepIndex + traceId + 待执行调用,
 * suspend 决策把 run 正常终止为 finishReason 'suspended')与 `beforeNextStep`(每次模型调用前;
 * signals 注入挂点,返回的消息进入 prompt 参与该次调用)。缺席 = 裸 agent 行为完全不变
 * (既有 579 例零改动即证;此处再钉「缺席不拦截、不挂起」)。断言只走公开面
 * (@oribos/core 子路径导出)与脚本化假模型接缝(@see @oribos/testing):假模型录制的
 * prompt 就是"模型看到的历史",挂 tracer 时 memory exporter 是钦定断言抓手(issue #21)。
 */

/** 参考工具:zod 双接口 schema,输入 city 输出 celsius。 */
function weatherTool(execute: (input: { city: string }) => unknown): Tool {
  return createTool({
    description: 'Looks up the weather.',
    inputSchema: z.object({ city: z.string() }),
    execute,
  });
}

describe('Agent loop:step 边界缝', () => {
  it('beforeNextStep:每次模型调用前触发(含首次),返回的消息进 prompt 参与该次调用', async () => {
    const model = fakeModel([
      {
        text: 'Checking.',
        toolCalls: [{ toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } }],
      },
      { text: 'Done.' },
    ]);
    const agent = assistantWithTools(model, {
      weather: weatherTool(() => ({ celsius: 21 })),
    });
    const events: AgentStepBoundaryEvent[] = [];
    const boundary: AgentStepBoundary = {
      beforeNextStep: (event) => {
        events.push(event);
        if (event.stepIndex === 1) {
          return [{ role: 'user', content: [{ type: 'text', text: '[signal] new info' }] }];
        }
      },
    };

    const result = await agent.generate('Weather in SF?', { stepBoundary: boundary });

    expect(result.finishReason).toBe('stop');
    // 两次模型调用 = 两次边界:stepIndex 0(run 起点也检查注入队列)与 stepIndex 1
    expect(events).toHaveLength(2);
    expect(events[0]?.stepIndex).toBe(0);
    // 事件里的 messages 是注入前的列表:首次边界 = 初始 prompt
    expect(events[0]?.messages).toEqual([
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: [{ type: 'text', text: 'Weather in SF?' }] },
    ]);
    expect(events[1]?.stepIndex).toBe(1);
    // 第二次边界 = 完成后的 step 0 已入列(system + user + assistant 带 tool-call + tool 结果)
    expect(events[1]?.messages).toEqual([
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: [{ type: 'text', text: 'Weather in SF?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
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
    ]);
    // 注入的消息追加在列表尾部,参与第二次模型调用
    expect(model.streamCalls[1]?.prompt).toEqual([
      ...events[1]!.messages,
      { role: 'user', content: [{ type: 'text', text: '[signal] new info' }] },
    ]);
  });

  it('beforeToolCalls:执行前可观察,事件携带快照取数面;返回 void 则照常执行', async () => {
    const model = fakeModel([
      {
        text: 'Checking.',
        toolCalls: [
          { toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } },
          { toolCallId: 'call-2', toolName: 'ping', input: {} },
        ],
        toolResults: [{ toolCallId: 'call-1', toolName: 'weather', result: { celsius: 21 } }],
      },
      { text: 'Done.' },
    ]);
    const weather = weatherTool(() => ({ celsius: 21 }));
    const ping = createTool({ description: 'Pings.', execute: () => 'pong' });
    const agent = assistantWithTools(model, { weather, ping });
    const gate = vi.fn<(event: AgentToolCallsBoundaryEvent) => void>(() => {});

    const result = await agent.generate('Weather in SF?', { stepBoundary: { beforeToolCalls: gate } });

    // void 决策不拦截:工具照常执行,run 行为不变
    expect(result.finishReason).toBe('stop');
    expect(result.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'weather',
        output: { celsius: 21 },
        isError: false,
      },
      { type: 'tool-result', toolCallId: 'call-2', toolName: 'ping', output: 'pong', isError: false },
    ]);
    expect(gate).toHaveBeenCalledTimes(1);
    const event = gate.mock.calls[0]?.[0]!;
    expect(event.stepIndex).toBe(0);
    // 未挂 tracer 时 trace 续接面为空串(与 ToolContext 的编码一致)
    expect(event.traceId).toBe('');
    expect(event.spanId).toBe('');
    // pendingCalls 只含框架待执行的调用:provider 已执行的 call-1 不在
    expect(event.pendingCalls).toEqual([
      { type: 'tool-call', toolCallId: 'call-2', toolName: 'ping', input: {} },
    ]);
    // 快照取数面:prompt + 本步 assistant 消息(text + tool-calls + provider 已执行结果)
    expect(event.messages).toEqual([
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: [{ type: 'text', text: 'Weather in SF?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } },
          { type: 'tool-call', toolCallId: 'call-2', toolName: 'ping', input: {} },
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'weather',
            output: { type: 'json', value: { celsius: 21 } },
          },
        ],
      },
    ]);
  });

  it('beforeToolCalls 返回 suspend 决策:工具不执行,run 正常终止为 finishReason suspended', async () => {
    const model = fakeModel([
      {
        text: 'I will move the funds.',
        toolCalls: [{ toolCallId: 'call-1', toolName: 'transfer', input: { to: 'charity' } }],
      },
    ]);
    const transfer = createTool({
      description: 'Moves money.',
      inputSchema: z.object({ to: z.string() }),
      execute: vi.fn(() => 'moved'),
    });
    const agent = assistantWithTools(model, { transfer });

    const output = agent.stream('Transfer my funds.', {
      stepBoundary: {
        // 异步形状同样成立:闸门可以先查清单/查存储再裁决
        beforeToolCalls: async () => ({ suspend: true }),
      },
    });
    const chunks = await collect(output);

    // chunk 流如实转发模型本步的输出(含其自身 finishReason 的 finish chunk)
    expect(chunks).toEqual([
      { type: 'text-delta', textDelta: 'I will move the funds.' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'transfer', input: { to: 'charity' } },
      { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined } },
    ]);
    // 挂起不是错误:终值正常落定,工具未执行
    expect(await output.finishReason).toBe('suspended');
    expect(await output.text).toBe('');
    expect(await output.steps).toEqual([]);
    expect(await output.toolCalls).toEqual([]);
    expect(transfer.execute).not.toHaveBeenCalled();
  });

  it('缺席态:不传 stepBoundary 的 run 行为与裸 agent 完全一致(工具照常执行)', async () => {
    const model = fakeModel([
      {
        text: 'Checking.',
        toolCalls: [{ toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } }],
      },
      { text: 'It is 21°C.' },
    ]);
    const weather = weatherTool(vi.fn(() => ({ celsius: 21 })));
    const agent = assistantWithTools(model, { weather });

    const result = await agent.generate('Weather in SF?');

    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('It is 21°C.');
    expect(weather.execute).toHaveBeenCalledTimes(1);
  });

  it('挂 tracer 时:事件携带真 traceId / spanId(等于 agent-run span 的);挂起锚点 = status 属性正常 end', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const model = fakeModel([
      {
        text: 'I will move the funds.',
        toolCalls: [{ toolCallId: 'call-1', toolName: 'transfer', input: { to: 'charity' } }],
      },
    ]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tracer,
      tools: {
        transfer: createTool({
          description: 'Moves money.',
          inputSchema: z.object({ to: z.string() }),
          execute: () => 'moved',
        }),
      },
    });
    let event: AgentToolCallsBoundaryEvent | undefined;
    const result = await agent.generate('Transfer my funds.', {
      stepBoundary: {
        beforeToolCalls: (seen) => {
          event = seen;
          return { suspend: true };
        },
      },
    });

    expect(result.finishReason).toBe('suspended');
    // 事件 = agent-run span 的续接面:durable 快照持久化 traceId、signals 挂 isEvent 事件都靠它
    const runSpan = spanOfType(memory, AGENT_RUN_SPAN);
    expect(event?.traceId).toMatch(TRACE_ID);
    expect(event?.traceId).toBe(runSpan.traceId);
    expect(event?.spanId).toMatch(SPAN_ID);
    expect(event?.spanId).toBe(runSpan.id);
    // 挂起锚点(harness.md「Observability 锚点」):agent-run span 以 status 属性正常 end,非 error
    expect(runSpan.attributes).toMatchObject({ status: 'suspended' });
    expect(runSpan.error).toBeUndefined();
    expect(kinds(eventsOfType(memory, AGENT_RUN_SPAN)).at(-1)).toBe('span_ended');
  });
});
