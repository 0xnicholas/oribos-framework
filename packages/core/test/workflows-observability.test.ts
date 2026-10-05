import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  WORKFLOW_RUN_SPAN,
  WORKFLOW_STEP_SPAN,
  createTracer,
  memoryExporter,
} from '@oribos/core/observability';
import { createStep, createInMemorySnapshotStore, createWorkflow } from '@oribos/core/workflows';
import type { StepContext } from '@oribos/core/workflows';
import { expectSuccess } from './helpers/assertions.js';
import { SPAN_ID, TRACE_ID, eventsOfType, kinds, spanOfType, withSpanIdProbe } from './helpers/spans.js';

/**
 * workflow 边界的自动埋点(M3 #52,`docs/architecture/observability.md`「自动埋点」第 4/5 条、
 * `docs/architecture/workflows.md`「流式事件」):挂 tracer 后 `workflow-run` span 挂在 run 边界
 * (start / resume 到终态)、`workflow-step` span 挂在 step 边界(name = step id),parent 沿执行树显式
 * 传播(无 AsyncLocalStorage);run span 的 input / output = 校验后的触发输入 / 终态信封,step span 的
 * input / output = 边界校验值 / step 输出,失败落 error;不挂 tracer 时整个子系统零开销。
 *
 * 接缝 = 公开 `@oribos/core/workflows` 与 `@oribos/core/observability` 子路径,用规范钦定的 memory
 * exporter 读 span 树、事件序列与快照。
 */

const topicInput = z.object({ topic: z.string() });
const articleOutput = z.object({ polished: z.string() });

describe('workflow span 自动埋点:run / step 边界', () => {
  it('workflow-run root span(attributes workflowId + runId)+ workflow-step span(name = step id,挂 run span 下)', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const draft = createStep({
      id: 'draft',
      inputSchema: topicInput,
      outputSchema: z.object({ draft: z.string() }),
      execute: ({ inputData }) => ({ draft: inputData.topic.toUpperCase() }),
    });
    const polish = createStep({
      id: 'polish',
      inputSchema: z.object({ draft: z.string() }),
      outputSchema: articleOutput,
      execute: ({ inputData }) => ({ polished: `«${inputData.draft}»` }),
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: articleOutput,
      tracer,
    })
      .then(draft)
      .then(polish)
      .commit();

    const run = workflow.createRun({ runId: 'run-1' });
    const outcome = expectSuccess(await run.start({ inputData: { topic: 'ts' } }).result);

    // run span:root,名字 = workflow id,attributes 带 workflowId 与 runId(runId 是执行身份);
    // input 是校验后的 start 输入(校验在 walker 里,故以一次 span_updated 落定),output = 终态信封。
    const runSpan = spanOfType(memory, WORKFLOW_RUN_SPAN);
    expect(runSpan.name).toBe('article');
    expect(runSpan.id).toMatch(SPAN_ID);
    expect(runSpan.traceId).toMatch(TRACE_ID);
    expect(runSpan.parentSpanId).toBeUndefined();
    expect(runSpan.attributes).toEqual({ workflowId: 'article', runId: 'run-1' });
    expect(runSpan.input).toEqual({ topic: 'ts' });
    expect(runSpan.output).toEqual(outcome);
    expect(kinds(eventsOfType(memory, WORKFLOW_RUN_SPAN))).toEqual([
      'span_started',
      'span_updated',
      'span_updated',
      'span_ended',
    ]);

    // step span:一个 step 边界一个 span,name = step id,parent = run span,同一 trace。
    const stepSpans = memory.spans().filter((span) => span.type === WORKFLOW_STEP_SPAN);
    expect(stepSpans.map((span) => span.name)).toEqual(['draft', 'polish']);
    for (const span of stepSpans) {
      expect(span.parentSpanId).toBe(runSpan.id);
      expect(span.traceId).toBe(runSpan.traceId);
      expect(span.endTime).toBeInstanceOf(Date);
    }
    expect(stepSpans[0]?.input).toEqual({ topic: 'ts' });
    expect(stepSpans[0]?.output).toEqual({ draft: 'TS' });
    expect(stepSpans[1]?.input).toEqual({ draft: 'TS' });
    expect(stepSpans[1]?.output).toEqual({ polished: '«TS»' });
  });

  it('每执行一个 span:foreach 每迭代一个 workflow-step span,记录仍按块聚合', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const double = createStep({
      id: 'double',
      inputSchema: z.number(),
      outputSchema: z.number(),
      execute: ({ inputData }) => inputData * 10,
    });
    const workflow = createWorkflow({
      id: 'fanout',
      inputSchema: z.array(z.number()),
      outputSchema: z.array(z.number()),
      tracer,
    })
      .foreach(double, { concurrency: 2 })
      .commit();

    const outcome = expectSuccess(await workflow.createRun().start({ inputData: [1, 2, 3] }).result);

    const stepSpans = memory.spans().filter((span) => span.type === WORKFLOW_STEP_SPAN);
    expect(stepSpans.map((span) => span.input)).toEqual([1, 2, 3]);
    expect(stepSpans.map((span) => span.output)).toEqual([10, 20, 30]);
    expect(stepSpans.every((span) => span.name === 'double')).toBe(true);
    expect(outcome.stepResults['double']?.output).toEqual([10, 20, 30]);
  });
});

describe('workflow run span:终态与失败落法', () => {
  it('挂起:run span 正常收束(output = suspended 信封,不落 error);失败:step span 与 run span 都落 error', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const boom = new Error('boom');
    const failing = createStep({
      id: 'failing',
      inputSchema: topicInput,
      outputSchema: articleOutput,
      execute: () => {
        throw boom;
      },
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: articleOutput,
      tracer,
    })
      .then(failing)
      .commit();

    await expect(workflow.createRun().start({ inputData: { topic: 'ts' } }).result).rejects.toBe(boom);

    const stepSpan = spanOfType(memory, WORKFLOW_STEP_SPAN);
    const runSpan = spanOfType(memory, WORKFLOW_RUN_SPAN);
    expect(stepSpan.error).toEqual({ message: 'boom', details: boom });
    expect(runSpan.error).toEqual({ message: 'boom', details: boom });
    // 失败 run 的 run span 没有 output(终态信封只在 success / suspended 上)。
    expect(runSpan.output).toBeUndefined();
  });

  it('start 输入校验失败:run span 落 error,step span 一个都不开', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const echo = createStep({
      id: 'echo',
      inputSchema: topicInput,
      outputSchema: topicInput,
      execute: ({ inputData }) => inputData,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: topicInput,
      tracer,
    })
      .then(echo)
      .commit();

    const error = await workflow
      .createRun()
      .start({ inputData: { topic: 42 } as never })
      .result.then(
        () => undefined,
        (failure: unknown) => failure,
      );

    const runSpan = spanOfType(memory, WORKFLOW_RUN_SPAN);
    expect(runSpan.error).toEqual({ message: (error as Error).message, details: error });
    expect(runSpan.input).toBeUndefined();
    expect(memory.spans().some((span) => span.type === WORKFLOW_STEP_SPAN)).toBe(false);
  });

  it('step 边界校验失败:该 step span 无 input、error 落它', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const strict = createStep({
      id: 'strict',
      inputSchema: z.object({ topic: z.string().min(5) }),
      outputSchema: topicInput,
      execute: ({ inputData }) => inputData,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: topicInput,
      tracer,
    })
      .then(strict)
      .commit();

    await expect(
      workflow.createRun().start({ inputData: { topic: 'ts' } }).result,
    ).rejects.toBeInstanceOf(Error);

    const stepSpan = spanOfType(memory, WORKFLOW_STEP_SPAN);
    expect(stepSpan.input).toBeUndefined();
    expect(stepSpan.error?.message).toMatch(/does not match its inputSchema/);
  });
});

describe('tracer 缺席:零开销', () => {
  it('不挂 tracer:不创建任何 span 对象,事件流照常', async () => {
    const step = createStep({
      id: 'echo',
      inputSchema: topicInput,
      outputSchema: topicInput,
      execute: ({ inputData }) => inputData,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: topicInput,
    })
      .then(step)
      .commit();

    const { result, spanIdsCreated } = await withSpanIdProbe(async () => {
      const out = workflow.createRun().start({ inputData: { topic: 'ts' } });
      const events = [];
      for await (const event of out) events.push(event);
      return expectSuccess(await out.result).output;
    });

    expect(spanIdsCreated).toBe(false);
    expect(result).toEqual({ topic: 'ts' });
  });
});

describe('traceId 随快照持久化:resume 续同一 trace', () => {
  it('挂起快照带 traceId;resume 在同一 trace 下开新 run span(无 parent),恢复段 step span 挂它下', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const store = createInMemorySnapshotStore();
    const approval = createStep({
      id: 'approval',
      inputSchema: topicInput,
      outputSchema: articleOutput,
      resumeSchema: z.object({ approved: z.boolean() }),
      suspendSchema: z.object({ question: z.string() }),
      execute: (ctx: StepContext<{ topic: string }, { approved: boolean }, { question: string }>) => {
        if (ctx.resumeData === undefined) {
          ctx.suspend({ question: `approve ${ctx.inputData.topic}?` });
        }
        return { polished: `${ctx.inputData.topic}:${String(ctx.resumeData.approved)}` };
      },
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: articleOutput,
      tracer,
      storage: store,
    })
      .then(approval)
      .commit();

    const run = workflow.createRun({ runId: 'run-1' });
    const suspended = await run.start({ inputData: { topic: 'ts' } }).result;
    expect(suspended.status).toBe('suspended');

    const runSpans = () => memory.spans().filter((span) => span.type === WORKFLOW_RUN_SPAN);
    expect(runSpans()).toHaveLength(1);
    const snapshot = await store.load('run-1');
    expect(snapshot?.traceId).toMatch(TRACE_ID);
    expect(snapshot?.traceId).toBe(runSpans()[0]?.traceId);
    // 挂起不是失败:首段 run span 以 suspended 信封正常收束。
    expect(runSpans()[0]?.error).toBeUndefined();
    expect(runSpans()[0]?.output).toEqual(suspended);

    const resumed = expectSuccess(
      await run.resume({ step: 'approval', resumeData: { approved: true } }),
    );
    const resumedRunSpan = runSpans()[1];
    expect(resumedRunSpan?.traceId).toBe(snapshot?.traceId);
    expect(resumedRunSpan?.parentSpanId).toBeUndefined();
    // 恢复段的触发输入 = 校验后的 resumeData(start 输入不回灌)。
    expect(resumedRunSpan?.input).toEqual({ approved: true });
    expect(resumedRunSpan?.output).toEqual(resumed);

    // step span 挂各自段落的 run span:首段的挂第一个,恢复段挂第二个。
    const stepSpans = memory.spans().filter((span) => span.type === WORKFLOW_STEP_SPAN);
    expect(stepSpans.map((span) => span.parentSpanId)).toEqual([
      runSpans()[0]?.id,
      resumedRunSpan?.id,
    ]);
    expect(stepSpans.every((span) => span.traceId === snapshot?.traceId)).toBe(true);
  });

  it('采样拒绝(NoOpSpan):快照不写 traceId', async () => {
    const store = createInMemorySnapshotStore();
    const tracer = createTracer({ exporters: [memoryExporter()], sampler: 'never' });
    const step = createStep({
      id: 'echo',
      inputSchema: topicInput,
      outputSchema: topicInput,
      execute: ({ inputData }) => inputData,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: topicInput,
      tracer,
      storage: store,
    })
      .then(step)
      .commit();

    expectSuccess(await workflow.createRun({ runId: 'run-1' }).start({ inputData: { topic: 'ts' } }).result);

    const snapshot = await store.load('run-1');
    expect(snapshot !== null && 'traceId' in snapshot).toBe(false);
  });
});

describe('createRun:外部 trace 续接', () => {
  it('traceId / parentSpanId 原样落 run span;空串语义沿 agent(整对作废,起自己的新 trace)', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const step = createStep({
      id: 'echo',
      inputSchema: topicInput,
      outputSchema: topicInput,
      execute: ({ inputData }) => inputData,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: topicInput,
      tracer,
    })
      .then(step)
      .commit();

    const externalTrace = 'a'.repeat(32);
    const externalParent = 'b'.repeat(16);
    expectSuccess(
      await workflow
        .createRun({ traceId: externalTrace, parentSpanId: externalParent })
        .start({ inputData: { topic: 'ts' } }).result,
    );
    const continued = spanOfType(memory, WORKFLOW_RUN_SPAN);
    expect(continued.traceId).toBe(externalTrace);
    expect(continued.parentSpanId).toBe(externalParent);

    memory.clear();
    expectSuccess(
      await workflow
        .createRun({ traceId: '', parentSpanId: '' })
        .start({ inputData: { topic: 'ts' } }).result,
    );
    const fresh = spanOfType(memory, WORKFLOW_RUN_SPAN);
    expect(fresh.traceId).toMatch(TRACE_ID);
    expect(fresh.parentSpanId).toBeUndefined();
  });

  it('混合对(空 traceId + 真 parentSpanId)同样不接:起自己的新 trace,不报 tracer 契约错', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const step = createStep({
      id: 'echo',
      inputSchema: topicInput,
      outputSchema: topicInput,
      execute: ({ inputData }) => inputData,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: topicInput,
      tracer,
    })
      .then(step)
      .commit();

    // 与 agent 侧钉点对称(agent-observability 同题用例):半截续接(trace 空、parent 真)整对作废,
    // run 起自己的新 trace——真 parentSpanId 静默丢弃,而不是走到 tracer 的契约错
    expectSuccess(
      await workflow
        .createRun({ traceId: '', parentSpanId: 'b'.repeat(16) })
        .start({ inputData: { topic: 'ts' } }).result,
    );
    const run = spanOfType(memory, WORKFLOW_RUN_SPAN);
    expect(run.traceId).toMatch(TRACE_ID);
    expect(run.parentSpanId).toBeUndefined();
  });
});

describe('hideInput / hideOutput:沿 trace 继承', () => {
  it('tracer 级擦除:run span 与 step span 的每条导出事件都无 input / output,记录照旧', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory], hideInput: true, hideOutput: true });
    const step = createStep({
      id: 'echo',
      inputSchema: topicInput,
      outputSchema: topicInput,
      execute: ({ inputData }) => inputData,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: topicInput,
      tracer,
    })
      .then(step)
      .commit();

    const outcome = expectSuccess(
      await workflow.createRun().start({ inputData: { topic: 'ts' } }).result,
    );

    expect(memory.events.length).toBeGreaterThan(0);
    for (const event of memory.events) {
      expect('input' in event.span).toBe(false);
      expect('output' in event.span).toBe(false);
    }
    // 擦除只发生在导出侧:run 的记录与终值不受影响。
    expect(outcome.output).toEqual({ topic: 'ts' });
    expect(memory.spans().some((span) => span.type === WORKFLOW_STEP_SPAN)).toBe(true);
  });
});
