import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RequestContext } from '@oribos/core/agent';
import { createTracer } from '@oribos/core/observability';
import type { Logger } from '@oribos/core/observability';
import { createStep, createWorkflow } from '@oribos/core/workflows';
import type { Step, StepContext, WorkflowSnapshotStore } from '@oribos/core/workflows';
import { expectAssignable } from './helpers/assertions.js';

/**
 * Workflow 定义表面(M3 #47,`docs/architecture/workflows.md`「定义表面」):`createStep` 配置
 * 对象与 StepContext 参数包——本票只落定义表面与条目列表形状,执行语义归 walker 测试套件
 * (workflows-run / workflows-control-flow / workflows-loop-wait;suspend/resume 归
 * workflows-suspend-resume;lifecycle 事件流归 workflows-events;span 埋点与 trace 续接归
 * workflows-observability)。
 */
describe('createStep:冻结普通对象', () => {
  it('返回冻结的普通对象,配置字段原样(引用不复制)', () => {
    const inputSchema = z.object({ city: z.string() });
    const outputSchema = z.object({ celsius: z.number() });
    const resumeSchema = z.object({ approved: z.boolean() });
    const suspendSchema = z.object({ question: z.string() });
    const execute = (ctx: StepContext<{ city: string }, { approved: boolean }, { question: string }>) => ({
      celsius: ctx.inputData.city.length,
    });

    const step = createStep({
      id: 'lookup',
      inputSchema,
      outputSchema,
      resumeSchema,
      suspendSchema,
      retries: 2,
      execute,
    });

    expect(Object.isFrozen(step)).toBe(true);
    expect(Object.getPrototypeOf(step)).toBe(Object.prototype);
    expect(Object.keys(step).sort()).toEqual([
      'execute',
      'id',
      'inputSchema',
      'outputSchema',
      'resumeSchema',
      'retries',
      'suspendSchema',
    ]);
    expect(step.id).toBe('lookup');
    expect(step.inputSchema).toBe(inputSchema);
    expect(step.outputSchema).toBe(outputSchema);
    expect(step.resumeSchema).toBe(resumeSchema);
    expect(step.suspendSchema).toBe(suspendSchema);
    expect(step.retries).toBe(2);
    expect(step.execute).toBe(execute);
  });

  it('可选字段缺席时不出现(resumeSchema / suspendSchema / retries)', () => {
    const step = createStep({
      id: 'ping',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: () => ({ ok: true }),
    });

    expect(Object.keys(step).sort()).toEqual(['execute', 'id', 'inputSchema', 'outputSchema']);
    expect(step.resumeSchema).toBeUndefined();
    expect(step.suspendSchema).toBeUndefined();
    expect(step.retries).toBeUndefined();
  });

  it('冻结:字段不可改写(严格模式下改写抛 TypeError)', () => {
    const step = createStep({
      id: 'ping',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: () => ({ ok: true }),
    });

    expect(() => {
      (step as { id: string }).id = 'changed';
    }).toThrow(TypeError);
    expect(step.id).toBe('ping');
  });
});

describe('createStep:类型从 schema 推出(断言在编译期,tsc 阶段生效)', () => {
  it('execute 的 inputData / resumeData / suspend payload 类型由对应 schema 推出', () => {
    createStep({
      id: 'review',
      inputSchema: z.object({ draft: z.string() }),
      outputSchema: z.object({ approved: z.boolean() }),
      resumeSchema: z.object({ verdict: z.enum(['yes', 'no']) }),
      suspendSchema: z.object({ question: z.string() }),
      execute: (ctx) => {
        expectAssignable<{ draft: string }>(ctx.inputData);
        // @ts-expect-error inputData 类型由 inputSchema 推出,不是别的形状
        expectAssignable<{ draft: number }>(ctx.inputData);
        expectAssignable<{ verdict: 'yes' | 'no' } | undefined>(ctx.resumeData);
        expectAssignable<string>(ctx.runId);
        expectAssignable<AbortSignal>(ctx.signal);
        expectAssignable<RequestContext>(ctx.requestContext);
        expectAssignable<unknown>(ctx.getStepResult('earlier-step'));
        ctx.suspend({ question: 'Approve?' });
        // @ts-expect-error suspend payload 由 suspendSchema 推出
        ctx.suspend({ question: 42 });
        return { approved: true };
      },
    });
  });

  it('无 resumeSchema / suspendSchema 时:resumeData 是 undefined,suspend payload 任意', () => {
    createStep({
      id: 'plain',
      inputSchema: z.object({}),
      outputSchema: z.object({ done: z.boolean() }),
      execute: (ctx) => {
        expectAssignable<undefined>(ctx.resumeData);
        ctx.suspend({ anything: 'goes' });
        return { done: true };
      },
    });
  });
});

/**
 * builder 七算子各 push 一条 `{type, ...}` 条目;`.commit()` 冻结定义(本票只验定义形状,执行
 * 语义归 walker 测试套件:then/IO 在校 workflows-run,同步点算子在校 workflows-control-flow,
 * 循环与等待在校 workflows-loop-wait)。步骤链用同一 IO 主轴,便于条目形状断言。
 */
describe('createWorkflow:builder 七算子条目化 + commit 冻结', () => {
  const inputSchema = z.object({ topic: z.string() });
  const outputSchema = z.object({ polished: z.string() });

  const draft = createStep({
    id: 'draft',
    inputSchema: z.object({ topic: z.string() }),
    outputSchema: z.object({ draft: z.string() }),
    execute: ({ inputData }) => ({ draft: inputData.topic }),
  });
  const polish = createStep({
    id: 'polish',
    inputSchema: z.object({ draft: z.string() }),
    outputSchema: z.object({ polished: z.string() }),
    execute: ({ inputData }) => ({ polished: inputData.draft }),
  });
  const factCheck = createStep({
    id: 'fact-check',
    inputSchema: z.object({ draft: z.string() }),
    outputSchema: z.object({ checked: z.boolean() }),
    execute: () => ({ checked: true }),
  });
  const revise = createStep({
    id: 'revise',
    inputSchema: z.object({ draft: z.string() }),
    outputSchema: z.object({ revised: z.string() }),
    execute: ({ inputData }) => ({ revised: inputData.draft }),
  });

  const workflow = () => createWorkflow({ id: 'article', inputSchema, outputSchema });

  it('builder 面 = 七个算子 + commit(无其它键)', () => {
    expect(Object.keys(workflow()).sort()).toEqual([
      'branch',
      'commit',
      'dountil',
      'dowhile',
      'foreach',
      'parallel',
      'sleep',
      'then',
    ]);
  });

  it('then:push {type, step},step 引用不复制', () => {
    const wf = workflow().then(draft).commit();

    expect(wf.entries).toEqual([{ type: 'then', step: draft }]);
    const [entry] = wf.entries;
    if (entry?.type !== 'then') throw new Error('expected a then entry');
    expect(entry.step).toBe(draft);
  });

  it('parallel:push {type, steps},传入数组被复制(外部数组后续变化不影响定义)', () => {
    const steps: Step[] = [draft, factCheck];
    const wf = workflow().parallel(steps).commit();
    steps.push(polish);

    expect(wf.entries).toEqual([{ type: 'parallel', steps: [draft, factCheck] }]);
    const [entry] = wf.entries;
    if (entry?.type !== 'parallel') throw new Error('expected a parallel entry');
    expect(entry.steps).toHaveLength(2);
    expect(entry.steps[0]).toBe(draft);
    expect(entry.steps[1]).toBe(factCheck);
  });

  it('branch:push {type, branches} 的 [cond, step] 对,cond 收当前 tip 数据', () => {
    const wf = workflow()
      .then(draft)
      .branch([
        [(ctx) => ctx.inputData.draft.length > 3, factCheck],
        [(ctx) => ctx.inputData.draft.length > 3, revise],
      ])
      .commit();

    expect(wf.entries).toHaveLength(2);
    const [entry] = wf.entries.filter((candidate) => candidate.type === 'branch');
    if (entry?.type !== 'branch') throw new Error('expected a branch entry');
    expect(entry.branches).toHaveLength(2);
    expect(entry.branches[0]?.[1]).toBe(factCheck);
    expect(entry.branches[1]?.[1]).toBe(revise);
  });

  it('foreach:默认 concurrency=1;显式值原样进条目', () => {
    const wf = workflow()
      .then(draft)
      .foreach(revise)
      .foreach(revise, { concurrency: 4 })
      .commit();

    expect(wf.entries.slice(1)).toEqual([
      { type: 'foreach', step: revise, concurrency: 1 },
      { type: 'foreach', step: revise, concurrency: 4 },
    ]);
  });

  it('dowhile / dountil:push {type, step, cond}', () => {
    const again = (ctx: { iterationCount: number }) => ctx.iterationCount < 3;
    const wf = workflow()
      .then(draft)
      .dowhile(revise, again)
      .dountil(revise, again)
      .commit();

    expect(wf.entries.slice(1)).toEqual([
      { type: 'dowhile', step: revise, cond: again },
      { type: 'dountil', step: revise, cond: again },
    ]);
  });

  it('sleep:毫秒数与动态时长函数原样进条目', () => {
    const dynamic = () => 250;
    const wf = workflow()
      .then(draft)
      .sleep(200)
      .sleep(dynamic)
      .commit();

    expect(wf.entries.slice(1)).toEqual([
      { type: 'sleep', duration: 200 },
      { type: 'sleep', duration: dynamic },
    ]);
  });

  it('条目按 push 顺序排列(无 DAG,扁平条目列表)', () => {
    const wf = workflow()
      .then(draft)
      .parallel([draft, factCheck])
      .branch([[(ctx) => ctx.inputData.draft.draft.length > 0, factCheck]])
      .foreach(revise, { concurrency: 2 })
      .dowhile(revise, (ctx) => ctx.iterationCount < 1)
      .dountil(revise, (ctx) => ctx.iterationCount > 0)
      .sleep(50)
      .commit();

    expect(wf.entries.map((entry) => entry.type)).toEqual([
      'then',
      'parallel',
      'branch',
      'foreach',
      'dowhile',
      'dountil',
      'sleep',
    ]);
  });

  it('commit:返回冻结的普通对象,定义字段原样(tracer / logger / storage 挂接点、createRun 运行面在位)', () => {
    const tracer = createTracer({ exporters: [] });
    const logger: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
    const storage: WorkflowSnapshotStore = {
      load: async () => null,
      save: async () => {},
    };

    const wf = workflow().then(draft).commit();
    expect(Object.isFrozen(wf)).toBe(true);
    expect(Object.getPrototypeOf(wf)).toBe(Object.prototype);
    expect(Object.keys(wf).sort()).toEqual([
      'createRun',
      'entries',
      'id',
      'inputSchema',
      'logger',
      'outputSchema',
      'storage',
      'tracer',
    ]);
    expect(wf.createRun).toBeTypeOf('function');
    expect(wf.id).toBe('article');
    expect(wf.inputSchema).toBe(inputSchema);
    expect(wf.outputSchema).toBe(outputSchema);
    expect(wf.tracer).toBeUndefined();
    expect(wf.logger).toBeUndefined();
    expect(wf.storage).toBeUndefined();

    const wired = createWorkflow({ id: 'wired', inputSchema, outputSchema, tracer, logger, storage })
      .then(draft)
      .commit();
    expect(wired.tracer).toBe(tracer);
    expect(wired.logger).toBe(logger);
    expect(wired.storage).toBe(storage);
  });

  it('commit:条目与条目数组一起冻结,改写抛 TypeError', () => {
    const wf = workflow().then(draft).parallel([draft, factCheck]).commit();

    expect(Object.isFrozen(wf.entries)).toBe(true);
    const [thenEntry] = wf.entries;
    const [, parallelEntry] = wf.entries;
    expect(Object.isFrozen(thenEntry)).toBe(true);
    expect(Object.isFrozen(parallelEntry)).toBe(true);
    if (parallelEntry?.type !== 'parallel') throw new Error('expected a parallel entry');
    expect(Object.isFrozen(parallelEntry.steps)).toBe(true);

    expect(() => {
      (thenEntry as { type: string }).type = 'sleep';
    }).toThrow(TypeError);
    expect(() => {
      (wf as { id: string }).id = 'changed';
    }).toThrow(TypeError);
  });

  it('commit 幂等:再次 commit 返回同一冻结定义', () => {
    const builder = workflow().then(draft);
    const wf = builder.commit();

    expect(builder.commit()).toBe(wf);
  });

  it('未 commit 不可再改:commit 后算子调用显式报错', () => {
    const builder = workflow().then(draft);
    builder.commit();

    expect(() => builder.sleep(1)).toThrow(/committed/);
    expect(() => builder.then(polish)).toThrow(/committed/);
  });
});
