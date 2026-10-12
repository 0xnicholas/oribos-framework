import { describe, expect, it } from 'vitest';
import { Agent } from '@oribos/core/agent';
import { Memory, createInMemoryStore } from '@oribos/core/memory';
import type { ExportedSpan } from '@oribos/core/observability';
import {
  AGENT_RUN_SPAN,
  TOOL_CALL_SPAN,
  createTracer,
  memoryExporter,
} from '@oribos/core/observability';
import { createTool } from '@oribos/core/tools';
import { fakeModel } from '@oribos/testing';
import { createSupervisor } from '@oribos/supervisor';

/**
 * `@oribos/supervisor` — Supervisor 能力包(追赶面首批,#175;ADR-0012 演化门落点 = 能力包)。
 *
 * as-tool 公开表面的标准化封装:`createSupervisor` 把子 Agent 包装成委派工具挂进父 agent 容器,
 * 委派即一次普通工具调用;核心零新缝。断言只走公开面与 fake model / memory exporter 抓手
 * (issue #21 测试决策),与 core 的 agent-as-tool recipe 测试同抓手。
 */

const SUPERVISOR_INSTRUCTIONS = 'You are a supervisor. Delegate research to your tools.';
const RESEARCHER_INSTRUCTIONS = 'You are a researcher. Answer in one sentence.';

/** 委派工具的 { prompt } JSON Schema(下发给 provider 的形状,与包内手写 Standard Schema 一致)。 */
const delegationJsonSchema = {
  type: 'object',
  properties: { prompt: { type: 'string' } },
  required: ['prompt'],
  additionalProperties: false,
};

/** 16-hex span id 与 32-hex trace id(与 core 测试 helpers/spans 同形,此处自留)。 */
const SPAN_ID = /^[0-9a-f]{16}$/;
const TRACE_ID = /^[0-9a-f]{32}$/;

/** memory exporter 里按 type + name 找唯一 span。 */
function findSpan(spans: readonly ExportedSpan[], type: string, name: string): ExportedSpan {
  const span = spans.find((candidate) => candidate.type === type && candidate.name === name);
  if (span === undefined) throw new Error(`no span of type '${type}' named '${name}' was exported`);
  return span;
}

/** 捕获 `run()` 拒绝的 Error;未拒绝、或拒绝的不是 Error 时失败。 */
async function captureRejection(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected the call to reject with an Error');
}

describe('委派即一次普通工具调用', () => {
  it('父模型调用委派工具:子 agent 完成 generate,stop 收尾时纯文本结果回喂', async () => {
    const childModel = fakeModel([{ text: 'Oribos is a lightweight TypeScript agent framework.' }]);
    const researcher = new Agent({
      name: 'researcher',
      instructions: RESEARCHER_INSTRUCTIONS,
      model: childModel,
      description: 'Researches topics.',
    });
    const parentModel = fakeModel([
      {
        toolCalls: [
          { toolCallId: 'delegate-1', toolName: 'researcher', input: { prompt: 'What is oribos?' } },
        ],
      },
      { text: 'Oribos is a lightweight framework.' },
    ]);
    const supervisor = createSupervisor({
      name: 'coordinator',
      instructions: SUPERVISOR_INSTRUCTIONS,
      model: parentModel,
      agents: { researcher },
    });

    const result = await supervisor.generate('Tell me about oribos.');

    // 子 agent 完成一次 generate:prompt 由委派工具显式构造(子 instructions + 委派 prompt,父输入不掺入)
    expect(childModel.streamCalls).toHaveLength(1);
    expect(childModel.streamCalls[0]?.prompt).toEqual([
      { role: 'system', content: RESEARCHER_INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'What is oribos?' }] },
    ]);

    // stop 收尾的委派结果 = 纯文本(不回喂整个 run 结果对象)
    expect(result.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'delegate-1',
        toolName: 'researcher',
        output: 'Oribos is a lightweight TypeScript agent framework.',
        isError: false,
      },
    ]);
    expect(result.text).toBe('Oribos is a lightweight framework.');
  });

  it('工具面:Record 键即工具名(与子 agent 名无关),静态 description 直取,{ prompt } JSON Schema 随工具下发', async () => {
    const childModel = fakeModel([{ text: 'answer' }]);
    const researcher = new Agent({
      name: 'researcher-agent',
      instructions: RESEARCHER_INSTRUCTIONS,
      model: childModel,
      description: 'Researches topics.',
    });
    const parentModel = fakeModel([
      { toolCalls: [{ toolCallId: 'delegate-1', toolName: 'research', input: { prompt: 'q' } }] },
      { text: 'done' },
    ]);
    const supervisor = createSupervisor({
      name: 'coordinator',
      instructions: SUPERVISOR_INSTRUCTIONS,
      model: parentModel,
      agents: { research: researcher },
    });

    await supervisor.generate('Go.');

    expect(parentModel.streamCalls[0]?.tools).toEqual([
      {
        type: 'function',
        name: 'research',
        description: 'Researches topics.',
        inputSchema: delegationJsonSchema,
      },
    ]);
  });

  it('动态 description 在包装处经父 ctx 逐 run 取值(委派 run 之外的显式选择)', async () => {
    const childModel = fakeModel([{ text: 'a' }, { text: 'b' }]);
    const researcher = new Agent({
      name: 'researcher',
      instructions: RESEARCHER_INSTRUCTIONS,
      model: childModel,
      description: (ctx) => `Researches topics for ${String(ctx.tenant)}.`,
    });
    const parentModel = fakeModel([
      { toolCalls: [{ toolCallId: 'delegate-1', toolName: 'researcher', input: { prompt: 'x' } }] },
      { text: 'first' },
      { text: 'second' },
    ]);
    const supervisor = createSupervisor({
      name: 'coordinator',
      instructions: SUPERVISOR_INSTRUCTIONS,
      model: parentModel,
      agents: { researcher },
    });

    await supervisor.generate('Go.', { tenant: 'acme' });
    await supervisor.generate('Again.', { tenant: 'globex' });

    expect(parentModel.streamCalls[0]?.tools).toEqual([
      {
        type: 'function',
        name: 'researcher',
        description: 'Researches topics for acme.',
        inputSchema: delegationJsonSchema,
      },
    ]);
    expect(parentModel.streamCalls[2]?.tools).toEqual([
      {
        type: 'function',
        name: 'researcher',
        description: 'Researches topics for globex.',
        inputSchema: delegationJsonSchema,
      },
    ]);
  });

  it('description 缺席时工具描述回落子 agent 的 name', async () => {
    const childModel = fakeModel([{ text: 'a' }]);
    const researcher = new Agent({
      name: 'researcher',
      instructions: RESEARCHER_INSTRUCTIONS,
      model: childModel,
    });
    const parentModel = fakeModel([
      { toolCalls: [{ toolCallId: 'delegate-1', toolName: 'researcher', input: { prompt: 'q' } }] },
      { text: 'done' },
    ]);
    const supervisor = createSupervisor({
      name: 'coordinator',
      instructions: SUPERVISOR_INSTRUCTIONS,
      model: parentModel,
      agents: { researcher },
    });

    await supervisor.generate('Go.');

    expect(parentModel.streamCalls[0]?.tools).toEqual([
      {
        type: 'function',
        name: 'researcher',
        description: 'researcher',
        inputSchema: delegationJsonSchema,
      },
    ]);
  });

  it('委派输入缺 prompt:Standard Schema 校验失败成为 error 工具结果,子模型零调用,父 run 继续', async () => {
    const childModel = fakeModel([]);
    const researcher = new Agent({
      name: 'researcher',
      instructions: RESEARCHER_INSTRUCTIONS,
      model: childModel,
    });
    const parentModel = fakeModel([
      { toolCalls: [{ toolCallId: 'delegate-1', toolName: 'researcher', input: {} }] },
      { text: 'recovered without research' },
    ]);
    const supervisor = createSupervisor({
      name: 'coordinator',
      instructions: SUPERVISOR_INSTRUCTIONS,
      model: parentModel,
      agents: { researcher },
    });

    const result = await supervisor.generate('Go.');

    expect(result.finishReason).toBe('stop');
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]?.isError).toBe(true);
    expect(String(result.toolResults[0]?.output)).toContain('prompt');
    expect(childModel.streamCalls).toHaveLength(0);
    expect(result.text).toBe('recovered without research');
  });

  it('委派 run 非 stop 收尾:回喂 { text, finishReason },截断对父模型可见(随 delegation.maxSteps)', async () => {
    const childModel = fakeModel([
      { toolCalls: [{ toolCallId: 'lookup-1', toolName: 'lookup', input: {} }] },
    ]);
    const researcher = new Agent({
      name: 'researcher',
      instructions: RESEARCHER_INSTRUCTIONS,
      model: childModel,
      tools: {
        lookup: createTool({
          description: 'Looks things up.',
          execute: () => ({ hits: 3 }),
        }),
      },
    });
    const parentModel = fakeModel([
      { toolCalls: [{ toolCallId: 'delegate-1', toolName: 'researcher', input: { prompt: 'q' } }] },
      { text: 'partial is fine' },
    ]);
    const supervisor = createSupervisor({
      name: 'coordinator',
      instructions: SUPERVISOR_INSTRUCTIONS,
      model: parentModel,
      agents: { researcher },
      delegation: { maxSteps: 1 },
    });

    const result = await supervisor.generate('Go.');

    // 子 run 一步耗尽(maxSteps 透传):finishReason 'tool-calls' 随结果形状对父模型可见
    expect(result.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'delegate-1',
        toolName: 'researcher',
        output: { text: '', finishReason: 'tool-calls' },
        isError: false,
      },
    ]);
    expect(result.text).toBe('partial is fine');
  });

  it('子 run 失败:框架的 error 工具结果框原样保留(Tool 前缀),父 run 不中止、模型自行恢复', async () => {
    const childModel = fakeModel([{ fail: new Error('child provider down') }]);
    const researcher = new Agent({
      name: 'researcher',
      instructions: RESEARCHER_INSTRUCTIONS,
      model: childModel,
    });
    const parentModel = fakeModel([
      { toolCalls: [{ toolCallId: 'delegate-1', toolName: 'researcher', input: { prompt: 'q' } }] },
      { text: 'recovered without research' },
    ]);
    const supervisor = createSupervisor({
      name: 'coordinator',
      instructions: SUPERVISOR_INSTRUCTIONS,
      model: parentModel,
      agents: { researcher },
    });

    const result = await supervisor.generate('Go.');

    expect(result.finishReason).toBe('stop');
    expect(result.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'delegate-1',
        toolName: 'researcher',
        output: expect.stringContaining("Tool 'researcher' failed: child provider down"),
        isError: true,
      },
    ]);
    expect(result.text).toBe('recovered without research');
  });
});

describe('委派 run 的 trace 续接', () => {
  it('双侧挂 tracer:子 run 的 agent-run span 挂为父 tool-call span 的子 span,同一条 trace', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const childModel = fakeModel([{ text: 'child answer' }]);
    const researcher = new Agent({
      name: 'researcher',
      instructions: RESEARCHER_INSTRUCTIONS,
      model: childModel,
      tracer,
    });
    const parentModel = fakeModel([
      { toolCalls: [{ toolCallId: 'delegate-1', toolName: 'researcher', input: { prompt: 'q' } }] },
      { text: 'done' },
    ]);
    const supervisor = createSupervisor({
      name: 'coordinator',
      instructions: SUPERVISOR_INSTRUCTIONS,
      model: parentModel,
      agents: { researcher },
      tracer,
    });

    await supervisor.generate('Go.');

    const spans = memory.spans();
    const parentRun = findSpan(spans, AGENT_RUN_SPAN, 'coordinator');
    const tool = findSpan(spans, TOOL_CALL_SPAN, 'researcher');
    const childRun = findSpan(spans, AGENT_RUN_SPAN, 'researcher');
    // 透传一行:委派 run 挂为当前 tool-call span 的子 span,观测树不断裂
    expect(parentRun.parentSpanId).toBeUndefined();
    expect(childRun.parentSpanId).toBe(tool.id);
    expect(childRun.traceId).toBe(parentRun.traceId);
    expect(tool.traceId).toBe(parentRun.traceId);
    expect(childRun.id).toMatch(SPAN_ID);
    expect(childRun.traceId).toMatch(TRACE_ID);
  });

  it('父侧无 trace(空串):子 run 从自己的新 trace 起,不产生残破 span', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const childModel = fakeModel([{ text: 'child answer' }]);
    const researcher = new Agent({
      name: 'researcher',
      instructions: RESEARCHER_INSTRUCTIONS,
      model: childModel,
      tracer,
    });
    const parentModel = fakeModel([
      { toolCalls: [{ toolCallId: 'delegate-1', toolName: 'researcher', input: { prompt: 'q' } }] },
      { text: 'done' },
    ]);
    const supervisor = createSupervisor({
      name: 'coordinator',
      instructions: SUPERVISOR_INSTRUCTIONS,
      model: parentModel,
      agents: { researcher },
    });

    const result = await supervisor.generate('Go.');

    expect(result.text).toBe('done');
    const childRun = findSpan(memory.spans(), AGENT_RUN_SPAN, 'researcher');
    // 工具 ctx 的 traceId / spanId 是空串:空串不是可续接的 parent,委派 run 自起新 trace
    expect(childRun.traceId).toMatch(TRACE_ID);
    expect(childRun.parentSpanId).toBeUndefined();
    for (const span of memory.spans()) expect(span.traceId).toMatch(TRACE_ID);
  });
});

describe('signal 透传与取消沿链', () => {
  it('signal 透传一行:委派 run 的模型调用拿到父 run 的 signal 实例', async () => {
    const controller = new AbortController();
    const childModel = fakeModel([{ text: 'child answer' }]);
    const researcher = new Agent({
      name: 'researcher',
      instructions: RESEARCHER_INSTRUCTIONS,
      model: childModel,
    });
    const parentModel = fakeModel([
      { toolCalls: [{ toolCallId: 'delegate-1', toolName: 'researcher', input: { prompt: 'q' } }] },
      { text: 'done' },
    ]);
    const supervisor = createSupervisor({
      name: 'coordinator',
      instructions: SUPERVISOR_INSTRUCTIONS,
      model: parentModel,
      agents: { researcher },
    });

    const result = await supervisor.generate('Go.', { signal: controller.signal });

    expect(result.text).toBe('done');
    expect(parentModel.streamCalls[0]?.abortSignal).toBe(controller.signal);
    expect(childModel.streamCalls[0]?.abortSignal).toBe(controller.signal);
    expect(controller.signal.aborted).toBe(false);
  });

  it('取消沿链生效:子 run 先中止,父 run 以同一原因收尾,两侧都不再发起模型调用', async () => {
    const controller = new AbortController();
    const childModel = fakeModel([
      { toolCalls: [{ toolCallId: 'stop-1', toolName: 'stop', input: {} }] },
      { text: 'never sent' },
    ]);
    const researcher = new Agent({
      name: 'researcher',
      instructions: RESEARCHER_INSTRUCTIONS,
      model: childModel,
      tools: {
        stop: createTool({
          description: 'Cancels the host signal.',
          execute: () => {
            controller.abort(new Error('cancelled by host'));
            return 'stopping';
          },
        }),
      },
    });
    const parentModel = fakeModel([
      { toolCalls: [{ toolCallId: 'delegate-1', toolName: 'researcher', input: { prompt: 'q' } }] },
      { text: 'never sent' },
    ]);
    const supervisor = createSupervisor({
      name: 'coordinator',
      instructions: SUPERVISOR_INSTRUCTIONS,
      model: parentModel,
      agents: { researcher },
    });

    const error = await captureRejection(() =>
      supervisor.generate('Go.', { signal: controller.signal }),
    );

    // 链上的中止是同一个原因实例;两侧的第二次模型调用都没有发起(被 signal 拦下)
    expect(error.message).toBe('cancelled by host');
    expect(childModel.streamCalls).toHaveLength(1);
    expect(parentModel.streamCalls).toHaveLength(1);
  });
});

describe('委派 memory:默认无状态,显式 opt-in', () => {
  it('默认:委派 run 不做 memory I/O——子 agent 配了 memory 也不落库', async () => {
    const childMemory = new Memory({ storage: createInMemoryStore() });
    const childModel = fakeModel([{ text: 'child answer' }]);
    const researcher = new Agent({
      name: 'researcher',
      instructions: RESEARCHER_INSTRUCTIONS,
      model: childModel,
      memory: childMemory,
    });
    const parentModel = fakeModel([
      { toolCalls: [{ toolCallId: 'delegate-1', toolName: 'researcher', input: { prompt: 'q' } }] },
      { text: 'done' },
    ]);
    const supervisor = createSupervisor({
      name: 'coordinator',
      instructions: SUPERVISOR_INSTRUCTIONS,
      model: parentModel,
      agents: { researcher },
    });

    await supervisor.generate('Go.');

    await expect(childMemory.recall({ threadId: 'delegations' })).resolves.toEqual([]);
  });

  it('静态 memory:每次委派落在同一 thread,委派历史经 recall 可读', async () => {
    const childMemory = new Memory({ storage: createInMemoryStore() });
    const childModel = fakeModel([{ text: 'child answer' }]);
    const researcher = new Agent({
      name: 'researcher',
      instructions: RESEARCHER_INSTRUCTIONS,
      model: childModel,
      memory: childMemory,
    });
    const parentModel = fakeModel([
      { toolCalls: [{ toolCallId: 'delegate-1', toolName: 'researcher', input: { prompt: 'q' } }] },
      { text: 'done' },
    ]);
    const supervisor = createSupervisor({
      name: 'coordinator',
      instructions: SUPERVISOR_INSTRUCTIONS,
      model: parentModel,
      agents: { researcher },
      delegation: { memory: { thread: 'delegations', resource: 'coordinator' } },
    });

    await supervisor.generate('Go.');

    // 落库的是显式构造的委派输入与子回答,不是父输入
    const recalled = await childMemory.recall({ threadId: 'delegations' });
    expect(recalled.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(recalled[0]?.content).toEqual([{ type: 'text', text: 'q' }]);
  });

  it('函数形态 memory:thread 由委派输入逐次派生(thread 策略归应用)', async () => {
    const childMemory = new Memory({ storage: createInMemoryStore() });
    const childModel = fakeModel([{ text: 'child answer' }]);
    const researcher = new Agent({
      name: 'researcher',
      instructions: RESEARCHER_INSTRUCTIONS,
      model: childModel,
      memory: childMemory,
    });
    const parentModel = fakeModel([
      { toolCalls: [{ toolCallId: 'delegate-1', toolName: 'researcher', input: { prompt: 'alpha' } }] },
      { text: 'done' },
    ]);
    const supervisor = createSupervisor({
      name: 'coordinator',
      instructions: SUPERVISOR_INSTRUCTIONS,
      model: parentModel,
      agents: { researcher },
      delegation: {
        memory: (input) => ({ thread: `delegation-${input.prompt}`, resource: 'coordinator' }),
      },
    });

    await supervisor.generate('Go.');

    const recalled = await childMemory.recall({ threadId: 'delegation-alpha' });
    expect(recalled.map((message) => message.role)).toEqual(['user', 'assistant']);
    await expect(childMemory.recall({ threadId: 'delegations' })).resolves.toEqual([]);
  });
});

describe('自有 tools 与委派工具的合并', () => {
  it('两类工具并挂:同一步都可调,按调用序执行(默认 serial 不变)', async () => {
    const childModel = fakeModel([{ text: 'researched' }]);
    const researcher = new Agent({
      name: 'researcher',
      instructions: RESEARCHER_INSTRUCTIONS,
      model: childModel,
    });
    const parentModel = fakeModel([
      {
        toolCalls: [
          { toolCallId: 'call-ping', toolName: 'ping', input: {} },
          { toolCallId: 'delegate-1', toolName: 'researcher', input: { prompt: 'q' } },
        ],
      },
      { text: 'done' },
    ]);
    const supervisor = createSupervisor({
      name: 'coordinator',
      instructions: SUPERVISOR_INSTRUCTIONS,
      model: parentModel,
      tools: {
        ping: createTool({ description: 'Ping.', execute: () => 'pong' }),
      },
      agents: { researcher },
    });

    const result = await supervisor.generate('Go.');

    expect(result.toolResults.map((toolResult) => toolResult.toolName)).toEqual([
      'ping',
      'researcher',
    ]);
    expect(result.toolResults[0]?.output).toBe('pong');
    expect(result.toolResults[1]?.output).toBe('researched');
    expect(result.text).toBe('done');
  });

  it('tools 与 agents 撞名:run 在 tools 解析处失败、报出撞名键,首次模型调用之前', async () => {
    const childModel = fakeModel([]);
    const researcher = new Agent({
      name: 'researcher',
      instructions: RESEARCHER_INSTRUCTIONS,
      model: childModel,
    });
    const parentModel = fakeModel([{ text: 'never' }]);
    const supervisor = createSupervisor({
      name: 'coordinator',
      instructions: SUPERVISOR_INSTRUCTIONS,
      model: parentModel,
      tools: {
        researcher: createTool({ description: 'Occupies the name.', execute: () => 'pong' }),
      },
      agents: { researcher },
    });

    const error = await captureRejection(() => supervisor.generate('Go.'));

    expect(error.message).toContain('collides');
    expect(error.message).toContain("'researcher'");
    expect(parentModel.streamCalls).toHaveLength(0);
    expect(childModel.streamCalls).toHaveLength(0);
  });
});

describe('构造期校验与产物形状', () => {
  it('agents 空记录:立即失败,不建出无委派能力的 supervisor', () => {
    expect(() =>
      createSupervisor({
        name: 'coordinator',
        instructions: SUPERVISOR_INSTRUCTIONS,
        model: fakeModel([]),
        agents: {},
      }),
    ).toThrow(/at least one/);
  });

  it('delegation.maxSteps 非正整数:立即失败', () => {
    const researcher = new Agent({
      name: 'researcher',
      instructions: RESEARCHER_INSTRUCTIONS,
      model: fakeModel([]),
    });
    expect(() =>
      createSupervisor({
        name: 'coordinator',
        instructions: SUPERVISOR_INSTRUCTIONS,
        model: fakeModel([]),
        agents: { researcher },
        delegation: { maxSteps: 0 },
      }),
    ).toThrow(/positive integer/);
  });

  it('产物是真正的 Agent:定义字段透传,自身可再经 as-tool 组合 / durable 包装', () => {
    const researcher = new Agent({
      name: 'researcher',
      instructions: RESEARCHER_INSTRUCTIONS,
      model: fakeModel([]),
    });
    const supervisor = createSupervisor({
      name: 'coordinator',
      instructions: SUPERVISOR_INSTRUCTIONS,
      model: fakeModel([]),
      description: 'Coordinates research.',
      agents: { researcher },
    });

    expect(supervisor).toBeInstanceOf(Agent);
    expect(supervisor.name).toBe('coordinator');
    expect(supervisor.instructions).toBe(SUPERVISOR_INSTRUCTIONS);
    expect(supervisor.description).toBe('Coordinates research.');
  });
});
