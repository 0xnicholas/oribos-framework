import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, resolveDynamicArgument } from '@oribos/core/agent';
import type { RequestContext } from '@oribos/core/agent';
import {
  AGENT_RUN_SPAN,
  AGENT_STEP_SPAN,
  TOOL_CALL_SPAN,
  createTracer,
  memoryExporter,
} from '@oribos/core/observability';
import type { ExportedSpan } from '@oribos/core/observability';
import { createTool } from '@oribos/core/tools';
import type { Tool } from '@oribos/core/tools';
import { fakeModel } from '@oribos/testing';
import { captureRejection } from './helpers/assertions.js';
import { SPAN_ID, TRACE_ID } from './helpers/spans.js';

/**
 * 多 agent 协作:as-tool 组合(M1-14 #35,ADR-0012 / agent.md「多 agent 组合」/ tools.md「组合范式」)。
 *
 * 规范形态 = 把 Agent 一行包装成 Tool 挂进父 agent 容器——委派即一次普通工具调用;委派输入由包装器
 * 显式构造,父 run 上下文零透传;signal 透传一行;委派 run 经工具 ctx 的 traceId / spanId 与 run
 * option 挂为当前 tool-call span 的子 span,多 agent 观测树不断裂。核心不为 as-tool 添任何 API:
 * 本文件的包装器逐字取自 agent.md 的 recipe,断言只走公开面与 memory exporter 抓手(issue #21 测试
 * 决策)。
 */

const COORDINATOR_INSTRUCTIONS = 'You are a coordinator. Delegate research to your tool.';
const RESEARCHER_INSTRUCTIONS = 'You are a researcher. Answer in one sentence.';

/** 委派工具的输入契约:一行 prompt(zod@4 走 Standard Schema 双接口)。 */
const delegationInput = z.object({ prompt: z.string() });

/**
 * 规范钦定的包装形态(agent.md「多 agent 组合」):Agent 的 `description` + `generate` 签名天然
 * 是一个 Tool 的 execute。description 在包装处经 `resolveDynamicArgument` 逐请求取值(Tool 的
 * description 是构造期静态字段);委派输入显式构造;signal 与 trace 一行透传。
 */
function asTool(agent: Agent): (ctx: RequestContext) => Promise<Tool<{ prompt: string }>> {
  return async (ctx) =>
    createTool({
      description: (await resolveDynamicArgument(agent.description, ctx)) ?? agent.name,
      inputSchema: delegationInput,
      execute: (input, { signal, traceId, spanId }) =>
        agent.generate(input.prompt, { signal, traceId, parentSpanId: spanId }),
    });
}

/** memory exporter 里按 type + name 找唯一 span——组合里 `agent-run` / `tool-call` 会出现多次。 */
function findSpan(spans: readonly ExportedSpan[], type: string, name: string): ExportedSpan {
  const span = spans.find((candidate) => candidate.type === type && candidate.name === name);
  if (span === undefined) throw new Error(`no span of type '${type}' named '${name}' was exported`);
  return span;
}

describe('委派即一次普通工具调用', () => {
  it('父模型调用委派工具:子 agent 完成 generate,文本结果经普通工具结果回喂', async () => {
    const childModel = fakeModel([{ text: 'Oribos is a lightweight TypeScript agent framework.' }]);
    const researcher = new Agent({
      name: 'researcher',
      instructions: RESEARCHER_INSTRUCTIONS,
      model: childModel,
      description: (ctx) => `Researches topics for ${String(ctx.tenant)}.`,
    });
    const parentModel = fakeModel([
      {
        toolCalls: [
          { toolCallId: 'delegate-1', toolName: 'researcher', input: { prompt: 'What is oribos?' } },
        ],
      },
      { text: 'Oribos is a lightweight framework.' },
    ]);
    const coordinator = new Agent({
      name: 'coordinator',
      instructions: COORDINATOR_INSTRUCTIONS,
      model: parentModel,
      // 包装本身是父 agent 动态 tools 解析器里的一次逐请求构造(agent.md「多 agent 组合」)
      tools: async (ctx) => ({ researcher: await asTool(researcher)(ctx) }),
    });

    const result = await coordinator.generate('Tell me about oribos.', { tenant: 'acme' });

    // 委派 = 普通工具调用:父模型收到的工具列表带包装处解析出的 description 与 input schema
    expect(parentModel.streamCalls[0]?.tools).toEqual([
      {
        type: 'function',
        name: 'researcher',
        description: 'Researches topics for acme.',
        inputSchema: delegationInput['~standard'].jsonSchema.input({ target: 'draft-07' }),
      },
    ]);

    // 子 agent 完成一次 generate:prompt 由包装器显式构造(子 instructions + 委派 prompt,父输入不掺入)
    expect(childModel.streamCalls).toHaveLength(1);
    expect(childModel.streamCalls[0]?.prompt).toEqual([
      { role: 'system', content: RESEARCHER_INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'What is oribos?' }] },
    ]);

    // 子 run 的结果作为普通工具结果回喂:父模型第二步的 prompt 末尾是 tool 消息
    expect(parentModel.streamCalls[1]?.prompt.at(-1)).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'delegate-1',
          toolName: 'researcher',
          output: {
            type: 'json',
            value: expect.objectContaining({
              text: 'Oribos is a lightweight TypeScript agent framework.',
            }),
          },
        },
      ],
    });

    expect(result.text).toBe('Oribos is a lightweight framework.');
    expect(result.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'delegate-1',
        toolName: 'researcher',
        output: expect.objectContaining({
          text: 'Oribos is a lightweight TypeScript agent framework.',
        }),
        isError: false,
      },
    ]);
  });

  it('子 run 非取消失败:作为 error 工具结果回喂,父 run 不中止、模型自行恢复', async () => {
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
    const coordinator = new Agent({
      name: 'coordinator',
      instructions: COORDINATOR_INSTRUCTIONS,
      model: parentModel,
      tools: async (ctx) => ({ researcher: await asTool(researcher)(ctx) }),
    });

    const result = await coordinator.generate('Go.');

    // 委派的失败继承普通工具语义(error 结果回喂、run 不中止):父 run 继续到自己的终值
    expect(result.text).toBe('recovered without research');
    expect(result.finishReason).toBe('stop');
    expect(result.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'delegate-1',
        toolName: 'researcher',
        output: expect.stringContaining('child provider down'),
        isError: true,
      },
    ]);
    // 父模型第二步看到 error-text 工具结果
    expect(parentModel.streamCalls[1]?.prompt.at(-1)).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'delegate-1',
          toolName: 'researcher',
          output: { type: 'error-text', value: expect.stringContaining('child provider down') },
        },
      ],
    });
  });
});

describe('上下文零透传', () => {
  it('子 run 的动态参数解析只看到自己的 requestContext:父袋一字节都不过去', async () => {
    const controller = new AbortController();
    const parentContexts: RequestContext[] = [];
    const descriptionContexts: RequestContext[] = [];
    const childContexts: RequestContext[] = [];
    const childModel = fakeModel([{ text: 'researched' }]);
    const researcher = new Agent({
      name: 'researcher',
      instructions: (ctx) => {
        childContexts.push(ctx);
        return RESEARCHER_INSTRUCTIONS;
      },
      model: (ctx) => {
        childContexts.push(ctx);
        return childModel;
      },
      tools: (ctx) => {
        childContexts.push(ctx);
        return {};
      },
      description: (ctx) => {
        descriptionContexts.push(ctx);
        return `Researches for ${String(ctx.tenant)}.`;
      },
    });
    const parentModel = fakeModel([
      { toolCalls: [{ toolCallId: 'delegate-1', toolName: 'researcher', input: { prompt: 'q' } }] },
      { text: 'done' },
    ]);
    const coordinator = new Agent({
      name: 'coordinator',
      instructions: COORDINATOR_INSTRUCTIONS,
      model: parentModel,
      tools: async (ctx) => {
        parentContexts.push(ctx);
        return { researcher: await asTool(researcher)(ctx) };
      },
    });

    await coordinator.generate('Go.', { signal: controller.signal, tenant: 'acme', userId: 'u-1' });

    const parentContext = parentContexts[0];
    if (parentContext === undefined) throw new Error('the tools resolver did not run');
    // 父袋在父侧原样可达
    expect(parentContext).toMatchObject({
      signal: controller.signal,
      tenant: 'acme',
      userId: 'u-1',
    });

    // 子 run 每个动态参数各解析一次,解析上下文里只有框架写入的 signal / runId——没有父袋
    expect(childContexts).toHaveLength(3);
    for (const ctx of childContexts) {
      expect(Object.keys(ctx).sort()).toEqual(['runId', 'signal']);
      // signal 是唯一被显式透传的一行
      expect(ctx.signal).toBe(controller.signal);
      // 委派是另一次 run:执行身份不复用
      expect(ctx.runId).not.toBe(parentContext.runId);
    }

    // 动态 description 在包装处经父 ctx 取值(委派 run 之外):父袋可见是包装器的显式选择,不是透传
    expect(descriptionContexts).toHaveLength(1);
    expect(descriptionContexts[0]).toBe(parentContext);
  });
});

describe('委派 run 的 trace 续接', () => {
  it('memory exporter:子 run 的 agent-run span 挂为父 tool-call span 的子 span,两棵子树连成一条 trace', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const childModel = fakeModel([{ text: 'child answer' }], { modelId: 'researcher-model' });
    const researcher = new Agent({
      name: 'researcher',
      instructions: RESEARCHER_INSTRUCTIONS,
      model: childModel,
      tracer,
    });
    const parentModel = fakeModel(
      [
        {
          toolCalls: [
            { toolCallId: 'delegate-1', toolName: 'researcher', input: { prompt: 'q' } },
          ],
        },
        { text: 'done' },
      ],
      { modelId: 'coordinator-model' },
    );
    const coordinator = new Agent({
      name: 'coordinator',
      instructions: COORDINATOR_INSTRUCTIONS,
      model: parentModel,
      tracer,
      tools: async (ctx) => ({ researcher: await asTool(researcher)(ctx) }),
    });

    await coordinator.generate('Go.');

    const spans = memory.spans();
    const byId = new Map(spans.map((span) => [span.id, span]));
    const parentRun = findSpan(spans, AGENT_RUN_SPAN, 'coordinator');
    const parentStep = findSpan(spans, AGENT_STEP_SPAN, 'coordinator-model');
    const tool = findSpan(spans, TOOL_CALL_SPAN, 'researcher');
    const childRun = findSpan(spans, AGENT_RUN_SPAN, 'researcher');
    const childStep = findSpan(spans, AGENT_STEP_SPAN, 'researcher-model');

    // 子 run 直接挂父 tool-call span 下,续接同一条 trace;它自己的 step 照常挂自己
    expect(parentRun.parentSpanId).toBeUndefined();
    expect(childRun.parentSpanId).toBe(tool.id);
    expect(childRun.traceId).toBe(parentRun.traceId);
    expect(childStep.parentSpanId).toBe(childRun.id);
    expect(childStep.traceId).toBe(childRun.traceId);
    expect(tool.traceId).toBe(parentRun.traceId);
    expect(childRun.id).toMatch(SPAN_ID);
    expect(childRun.traceId).toMatch(TRACE_ID);

    // 树不断裂:每个 span 的 parent 都在同一 trace 里存在
    for (const span of spans) {
      if (span.parentSpanId === undefined) continue;
      expect(byId.get(span.parentSpanId)?.traceId).toBe(span.traceId);
    }
    // 祖先链一路回到父 run:childRun → tool → parentStep → parentRun
    const ancestors: string[] = [];
    let cursor: ExportedSpan | undefined = childRun;
    while (cursor?.parentSpanId !== undefined) {
      cursor = byId.get(cursor.parentSpanId);
      if (cursor === undefined) break;
      ancestors.push(cursor.id);
    }
    expect(ancestors).toEqual([tool.id, parentStep.id, parentRun.id]);

    // 生命周期包含:子 run 完整发生在父 tool-call span 之内
    const at = (kind: string, id: string): number =>
      memory.events.findIndex((event) => event.kind === kind && event.span.id === id);
    expect(at('span_started', tool.id)).toBeLessThan(at('span_started', childRun.id));
    expect(at('span_ended', childRun.id)).toBeLessThan(at('span_ended', tool.id));

    // tool-call span 携带 provider 真值 toolCallId;两次 run 是执行身份不同的两次执行
    expect(tool.attributes).toEqual({ toolCallId: 'delegate-1' });
    expect((childRun.attributes as { runId?: string }).runId).not.toBe(
      (parentRun.attributes as { runId?: string }).runId,
    );
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
    const coordinator = new Agent({
      name: 'coordinator',
      instructions: COORDINATOR_INSTRUCTIONS,
      model: parentModel,
      tools: async (ctx) => ({ researcher: await asTool(researcher)(ctx) }),
    });

    const result = await coordinator.generate('Go.', { signal: controller.signal });

    expect(result.text).toBe('done');
    expect(parentModel.streamCalls[0]?.abortSignal).toBe(controller.signal);
    expect(childModel.streamCalls[0]?.abortSignal).toBe(controller.signal);
    expect(controller.signal.aborted).toBe(false);
  });

  it('取消沿链生效:子 run 先中止,父 run 以同一原因收尾,两侧都不再发起模型调用', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const controller = new AbortController();
    const childModel = fakeModel([
      { toolCalls: [{ toolCallId: 'stop-1', toolName: 'stop', input: {} }] },
      { text: 'never sent' },
    ]);
    const researcher = new Agent({
      name: 'researcher',
      instructions: RESEARCHER_INSTRUCTIONS,
      model: childModel,
      tracer,
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
    const coordinator = new Agent({
      name: 'coordinator',
      instructions: COORDINATOR_INSTRUCTIONS,
      model: parentModel,
      tracer,
      tools: async (ctx) => ({ researcher: await asTool(researcher)(ctx) }),
    });

    const parentError = await captureRejection(() =>
      coordinator.generate('Go.', { signal: controller.signal }),
    );

    // 链上的中止是同一个原因实例:子 run 的取消原因经 error 工具结果与下一步模型调用原样成为父 run 终错
    expect(parentError.message).toBe('cancelled by host');
    const spans = memory.spans();
    expect(findSpan(spans, AGENT_RUN_SPAN, 'researcher').error?.details).toBe(parentError);
    // 观测树两侧都记录同一条中止:子 run / 父 run / 委派工具各落 error
    expect(findSpan(spans, AGENT_RUN_SPAN, 'researcher').error?.message).toBe('cancelled by host');
    expect(findSpan(spans, TOOL_CALL_SPAN, 'researcher').error?.message).toBe('cancelled by host');
    expect(findSpan(spans, AGENT_RUN_SPAN, 'coordinator').error?.message).toBe('cancelled by host');
    // 两侧的第二次模型调用都没有发起(被 signal 拦下)
    expect(childModel.streamCalls).toHaveLength(1);
    expect(parentModel.streamCalls).toHaveLength(1);
  });
});

describe('委派一侧无 trace:空串不是可续接的 parent', () => {
  it('父 run 不挂 tracer 而子 agent 挂:子 run 从自己的新 trace 起,不产生空 trace id 的残破 span', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const childModel = fakeModel([{ text: 'child answer' }], { modelId: 'researcher-model' });
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
    const coordinator = new Agent({
      name: 'coordinator',
      instructions: COORDINATOR_INSTRUCTIONS,
      model: parentModel,
      tools: async (ctx) => ({ researcher: await asTool(researcher)(ctx) }),
    });

    const result = await coordinator.generate('Go.');

    expect(result.text).toBe('done');
    const childRun = findSpan(memory.spans(), AGENT_RUN_SPAN, 'researcher');
    // 父侧的 traceId / spanId 是空串(无 tracer):空串不是可续接的 parent,子 run 起自己的新 trace
    expect(childRun.traceId).toMatch(TRACE_ID);
    expect(childRun.parentSpanId).toBeUndefined();
    // 所有导出的 span 都有真 trace id,树里没有挂到空 id 上的断枝
    for (const span of memory.spans()) expect(span.traceId).toMatch(TRACE_ID);
  });

  it('父 trace 采样不通过:委派 run 从自己的新 trace 起,采样在委派侧各自判定', async () => {
    const memory = memoryExporter();
    let roots = 0;
    const tracer = createTracer({
      exporters: [memory],
      // 第一个 root(父 run)不采样;委派 run 是第二个 root,采样照常判定
      sampler: () => {
        roots += 1;
        return roots > 1;
      },
    });
    const childModel = fakeModel([{ text: 'child answer' }], { modelId: 'researcher-model' });
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
    const coordinator = new Agent({
      name: 'coordinator',
      instructions: COORDINATOR_INSTRUCTIONS,
      model: parentModel,
      tracer,
      tools: async (ctx) => ({ researcher: await asTool(researcher)(ctx) }),
    });

    const result = await coordinator.generate('Go.');

    expect(result.text).toBe('done');
    // 父 run 是 NoOp(采样不通过),委派 run 是根:空串不作 parent,它起自己的新 trace
    const spans = memory.spans();
    expect(
      spans.some((span) => span.type === AGENT_RUN_SPAN && span.name === 'coordinator'),
    ).toBe(false);
    const childRun = findSpan(spans, AGENT_RUN_SPAN, 'researcher');
    expect(childRun.traceId).toMatch(TRACE_ID);
    expect(childRun.parentSpanId).toBeUndefined();
  });
});
