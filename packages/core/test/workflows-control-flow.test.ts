import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createStep, createWorkflow } from '@oribos/core/workflows';
import { WorkflowValidationError } from '@oribos/core/workflows';
import type { StepContext } from '@oribos/core/workflows';
import { captureError, captureRejection, expectSuccess } from './helpers/assertions.js';

/**
 * 控制流算子同步点(M3 #49,`docs/architecture/workflows.md`「控制流算子」):parallel / branch /
 * foreach 的执行语义,以及 `getStepResult` 在 keyed 输出下的读法。
 *
 * - parallel:`Promise.all` 全并发、无并发上限、任一步失败整块失败、同步点,输出 `{ [step.id]: output }`;
 * - branch:按定义序求值、第一个真分支执行,输出只有一个 key 有值的 keyed 对象(分支臂按规范共享
 *   IO schema;不一致的臂在运行期由该臂的 input 边界拦下);无真分支 = `{}`;
 * - foreach:输入必须是数组、concurrency 默认 1、>1 用自写并发闸(流式补位,不引 fastq)、保序收集、同步点,输出数组。
 *
 * 接缝 = 公开 `@oribos/core/workflows` 子路径,不触内部模块;并发断言用一次性闸门(deferred)自行
 * 控制 step 何时完成,不靠计时器。块内(parallel / branch 臂 / foreach)每次执行的事件与 span 归
 * workflows-events / workflows-observability(run 的记录仍按块聚合一条)。
 */

const topicInput = z.object({ topic: z.string() });
const draftOut = z.object({ draft: z.string() });
const checkedOut = z.object({ checked: z.boolean() });
const laneOut = z.object({ lane: z.string() });
const elementIn = z.object({ draft: z.string() });
const polishedOut = z.object({ polished: z.string() });
const draftsInput = z.object({ drafts: z.array(z.string()) });

const draft = createStep({
  id: 'draft',
  inputSchema: topicInput,
  outputSchema: draftOut,
  execute: ({ inputData }) => ({ draft: inputData.topic.toUpperCase() }),
});

/** 数组输入 → 元素数组:foreach 的上游(输入必须是数组,元素过 step 的 inputSchema)。 */
const fanOut = createStep({
  id: 'fan-out',
  inputSchema: draftsInput,
  outputSchema: z.array(elementIn),
  execute: ({ inputData }) => inputData.drafts.map((value) => ({ draft: value })),
});

/** 一次性闸门 / 信号:测试自行控制 step 何时完成,并发断言不依赖计时。 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((onRelease) => {
    resolve = onRelease;
  });
  return { promise, resolve };
}

describe('parallel:Promise.all 全并发 + keyed 输出', () => {
  it('各 step 收到同一个 inputData,全部启动后才过同步点;输出 { [step.id]: output }', async () => {
    const started: string[] = [];
    const finished: string[] = [];
    const seenInputs: unknown[] = [];
    const gate = deferred();

    const draftStep = createStep({
      id: 'draft',
      inputSchema: topicInput,
      outputSchema: draftOut,
      execute: async ({ inputData }) => {
        seenInputs.push(inputData);
        started.push('draft');
        await gate.promise;
        finished.push('draft');
        return { draft: inputData.topic.toUpperCase() };
      },
    });
    const factCheck = createStep({
      id: 'fact-check',
      inputSchema: topicInput,
      outputSchema: checkedOut,
      execute: async ({ inputData }) => {
        seenInputs.push(inputData);
        started.push('fact-check');
        await gate.promise;
        finished.push('fact-check');
        return { checked: inputData.topic.length > 0 };
      },
    });
    const merge = createStep({
      id: 'merge',
      inputSchema: z.object({ draft: draftOut, 'fact-check': checkedOut }),
      outputSchema: z.object({ article: z.string() }),
      execute: ({ inputData }) => {
        finished.push('merge');
        return { article: `${inputData.draft.draft}:${inputData['fact-check'].checked}` };
      },
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: z.object({ article: z.string() }),
    })
      .parallel([draftStep, factCheck])
      .then(merge)
      .commit();

    const out = workflow.createRun().start({ inputData: { topic: 'ts' } });
    const result = out.result;
    await vi.waitFor(() => expect(started).toHaveLength(2));

    // 两块都在飞(同步点未过):下游不执行,两个 step 收到同一个 tip 值
    expect(finished).toEqual([]);
    expect(seenInputs).toEqual([{ topic: 'ts' }, { topic: 'ts' }]);

    gate.resolve();
    const outcome = expectSuccess(await result);

    expect(finished).toHaveLength(3);
    expect(finished.at(-1)).toBe('merge');
    expect(finished).toContain('draft');
    expect(finished).toContain('fact-check');
    expect(outcome.output).toEqual({ article: 'TS:true' });
    expect(outcome.stepResults['draft']?.status).toBe('success');
    expect(outcome.stepResults['draft']?.output).toEqual({ draft: 'TS' });
    expect(outcome.stepResults['fact-check']?.status).toBe('success');
    expect(outcome.stepResults['fact-check']?.output).toEqual({ checked: true });
  });

  it('无并发上限:三个 step 同时进行(Promise.all,不是分批)', async () => {
    const aStarted = deferred();
    const bStarted = deferred();
    const cStarted = deferred();
    const gate = deferred();
    const finished: string[] = [];

    const gated = (id: 'a' | 'b' | 'c', signal: { resolve: () => void }) =>
      createStep({
        id,
        inputSchema: topicInput,
        outputSchema: z.object({ [id]: z.string() }),
        execute: async ({ inputData }) => {
          signal.resolve();
          await gate.promise;
          finished.push(id);
          return { [id]: inputData.topic };
        },
      });

    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: z.object({
        a: z.object({ a: z.string() }),
        b: z.object({ b: z.string() }),
        c: z.object({ c: z.string() }),
      }),
    })
      .parallel([gated('a', aStarted), gated('b', bStarted), gated('c', cStarted)])
      .commit();

    const out = workflow.createRun().start({ inputData: { topic: 'ts' } });
    const result = out.result;
    await Promise.all([aStarted.promise, bStarted.promise, cStarted.promise]);

    // 三个都启动了、一个都没完成:无并发上限
    expect(finished).toEqual([]);

    gate.resolve();
    const outcome = expectSuccess(await result);

    expect(finished).toHaveLength(3);
    // keyed 对象按定义序;每个 step 的输出挂在它自己的 id 下
    expect(Object.keys(outcome.output)).toEqual(['a', 'b', 'c']);
    expect(outcome.output).toEqual({ a: { a: 'ts' }, b: { b: 'ts' }, c: { c: 'ts' } });
  });

  it('任一步失败整块失败:run 以该错误拒绝,下游条目不执行', async () => {
    const boom = new Error('boom');
    const failing = createStep({
      id: 'failing',
      inputSchema: topicInput,
      outputSchema: draftOut,
      execute: () => {
        throw boom;
      },
    });
    const later = createStep({
      id: 'later',
      inputSchema: topicInput,
      outputSchema: checkedOut,
      execute: () => ({ checked: true }),
    });
    const afterExecute = vi.fn(() => ({ article: 'x' }));
    const after = createStep({
      id: 'after',
      inputSchema: z.object({ failing: draftOut.optional(), later: checkedOut.optional() }),
      outputSchema: z.object({ article: z.string() }),
      execute: afterExecute,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: z.object({ article: z.string() }),
    })
      .parallel([failing, later])
      .then(after)
      .commit();

    const error = await captureRejection(async () =>
      workflow.createRun().start({ inputData: { topic: 'ts' } }).result.then(() => undefined),
    );

    // 错误原样(不包装、不聚合)
    expect(error).toBe(boom);
    expect(afterExecute).not.toHaveBeenCalled();
  });

  it('getStepResult:块内可查块之前已运行 step;下游按 step id 取到各 step 的 output', async () => {
    const seenInside: unknown[] = [];
    const seenSelf: unknown[] = [];
    let seenDownstream: unknown;
    let seenMissing: unknown;

    const seed = createStep({
      id: 'seed',
      inputSchema: topicInput,
      outputSchema: z.object({ seed: z.string() }),
      execute: ({ inputData }) => ({ seed: inputData.topic }),
    });
    const probe = (id: 'probe-a' | 'probe-b') =>
      createStep({
        id,
        inputSchema: z.object({ seed: z.string() }),
        outputSchema: z.object({ seen: z.string() }),
        execute: (ctx) => {
          seenInside.push(ctx.getStepResult('seed'));
          seenSelf.push(ctx.getStepResult(id));
          return { seen: ctx.inputData.seed };
        },
      });
    const merge = createStep({
      id: 'merge',
      inputSchema: z.object({
        'probe-a': z.object({ seen: z.string() }),
        'probe-b': z.object({ seen: z.string() }),
      }),
      outputSchema: z.object({ merged: z.string() }),
      execute: (ctx) => {
        seenDownstream = ctx.getStepResult('probe-a');
        seenMissing = ctx.getStepResult('never-ran');
        return { merged: ctx.inputData['probe-a'].seen + ctx.inputData['probe-b'].seen };
      },
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: z.object({ merged: z.string() }),
    })
      .then(seed)
      .parallel([probe('probe-a'), probe('probe-b')])
      .then(merge)
      .commit();

    const outcome = expectSuccess(await workflow.createRun().start({ inputData: { topic: 'ts' } }).result);

    expect(seenInside).toEqual([{ seed: 'ts' }, { seed: 'ts' }]);
    // 块内查自己(尚未有记录)一律 undefined
    expect(seenSelf).toEqual([undefined, undefined]);
    // keyed 对象本身是下游的 inputData;各 step 的记录按 step id 独立可查
    expect(outcome.output).toEqual({ merged: 'tsts' });
    expect(seenDownstream).toEqual({ seen: 'ts' });
    expect(seenMissing).toBeUndefined();
  });
});

describe('branch:按定义序求值,第一个真分支执行', () => {
  const fastLane = createStep({
    id: 'fast-lane',
    inputSchema: draftOut,
    outputSchema: laneOut,
    execute: ({ inputData }) => ({ lane: `fast:${inputData.draft}` }),
  });
  const slowLane = createStep({
    id: 'slow-lane',
    inputSchema: draftOut,
    outputSchema: laneOut,
    execute: ({ inputData }) => ({ lane: `slow:${inputData.draft}` }),
  });
  it('按定义序求值:第一个真分支执行,后续 cond 不再求值', async () => {
    const firstCond = vi.fn((ctx: StepContext<{ draft: string }>) => {
      expect(ctx.inputData).toEqual({ draft: 'TS' });
      return false;
    });
    const secondCond = vi.fn(async (_ctx: StepContext<{ draft: string }>) => true);
    const thirdCond = vi.fn((_ctx: StepContext<{ draft: string }>) => true);
    const fastExecute = vi.fn((_ctx: StepContext<{ draft: string }>) => ({ lane: 'fast' }));
    const slowExecute = vi.fn((_ctx: StepContext<{ draft: string }>) => ({ lane: 'slow' }));
    const fast = createStep({ id: 'fast-lane', inputSchema: draftOut, outputSchema: laneOut, execute: fastExecute });
    const slow = createStep({ id: 'slow-lane', inputSchema: draftOut, outputSchema: laneOut, execute: slowExecute });
    const record = createStep({
      id: 'lane-record',
      inputSchema: z.object({ 'fast-lane': laneOut.optional(), 'slow-lane': laneOut.optional() }),
      outputSchema: z.object({ lane: z.string().optional() }),
      execute: ({ inputData }) => ({ lane: inputData['slow-lane']?.lane }),
    });
    const branched = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: z.object({ lane: z.string().optional() }),
    })
      .then(draft)
      .branch([
        [firstCond, fast],
        [secondCond, slow],
        [thirdCond, fast],
      ])
      .then(record)
      .commit();

    const run = branched.createRun({ runId: 'run-1' });
    const outcome = expectSuccess(await run.start({ inputData: { topic: 'ts' } }).result);

    expect(firstCond).toHaveBeenCalledTimes(1);
    expect(secondCond).toHaveBeenCalledTimes(1);
    // 第一个真分支已定,后续条件完全不求值(不是全部求值后挑一个)
    expect(thirdCond).not.toHaveBeenCalled();
    expect(fastExecute).not.toHaveBeenCalled();
    expect(slowExecute).toHaveBeenCalledTimes(1);
    expect(outcome.output).toEqual({ lane: 'slow' });

    // cond 与 execute 收同一个 ctx 包;异步 cond 生效
    const condCtx = secondCond.mock.calls[0]?.[0];
    expect(condCtx?.runId).toBe('run-1');
    expect(condCtx?.requestContext.runId).toBe('run-1');
    expect(condCtx?.getStepResult('draft')).toEqual({ draft: 'TS' });
    expect(condCtx?.resumeData).toBeUndefined();
  });

  it('输出 keyed 对象:只有一个 key 有值,下游按 optional 接', async () => {
    let seenInput: unknown;
    const record = createStep({
      id: 'lane-record',
      inputSchema: z.object({ 'fast-lane': laneOut.optional(), 'slow-lane': laneOut.optional() }),
      outputSchema: z.object({ lane: z.string().optional() }),
      execute: (ctx) => {
        seenInput = ctx.inputData;
        return { lane: ctx.inputData['slow-lane']?.lane };
      },
    });
    const branched = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: z.object({ lane: z.string().optional() }),
    })
      .then(draft)
      .branch([
        [() => false, fastLane],
        [() => true, slowLane],
      ])
      .then(record)
      .commit();

    const outcome = await branched.createRun().start({ inputData: { topic: 'ts' } }).result;

    expect(seenInput).toEqual({ 'slow-lane': { lane: 'slow:TS' } });
    expect(Object.keys(seenInput as object)).toEqual(['slow-lane']);
    expect(outcome.stepResults['slow-lane']?.output).toEqual({ lane: 'slow:TS' });
    expect(outcome.stepResults['fast-lane']).toBeUndefined();
  });

  it('无真分支:输出 {}(没有分支 step 执行)', async () => {
    const execute = vi.fn((_ctx: StepContext<{ draft: string }>) => ({ lane: 'fast' }));
    const fast = createStep({ id: 'fast-lane', inputSchema: draftOut, outputSchema: laneOut, execute });
    const none = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: z.object({ 'fast-lane': laneOut.optional() }),
    })
      .then(draft)
      .branch([[() => false, fast]])
      .commit();

    const outcome = expectSuccess(await none.createRun().start({ inputData: { topic: 'ts' } }).result);

    expect(outcome.output).toEqual({});
    expect(execute).not.toHaveBeenCalled();
  });

  it('cond 抛错:run 以该错误失败,分支 step 不执行', async () => {
    const boom = new Error('cond boom');
    const execute = vi.fn((_ctx: StepContext<{ draft: string }>) => ({ lane: 'fast' }));
    const fast = createStep({ id: 'fast-lane', inputSchema: draftOut, outputSchema: laneOut, execute });
    const branched = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: z.object({ 'fast-lane': laneOut.optional() }),
    })
      .then(draft)
      .branch([
        [
          () => {
            throw boom;
          },
          fast,
        ],
      ])
      .commit();

    const error = await captureRejection(async () =>
      branched.createRun().start({ inputData: { topic: 'ts' } }).result.then(() => undefined),
    );

    expect(error).toBe(boom);
    expect(execute).not.toHaveBeenCalled();
  });

  it('分支 step 的输入边界照常校验:tip 不被该 step 的 inputSchema 接受 → run failed(带 step id)', async () => {
    const strict = createStep({
      id: 'strict-lane',
      inputSchema: z.object({ note: z.string() }),
      outputSchema: laneOut,
      execute: () => ({ lane: 'strict' }),
    });
    const branched = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: z.object({ 'strict-lane': laneOut.optional() }),
    })
      .then(draft)
      .branch([[() => true, strict]])
      .commit();

    const error = await captureRejection(async () =>
      branched.createRun().start({ inputData: { topic: 'ts' } }).result.then(() => undefined),
    );

    expect(error).toBeInstanceOf(WorkflowValidationError);
    expect((error as WorkflowValidationError).stepId).toBe('strict-lane');
  });

  it('臂间 schema 不一致是调用方保证(DOC-4):不一致的臂由下游步的输入边界校验拦截', async () => {
    // branch 行(workflows.md「控制流算子」):各分支 IO schema 一致类型层不强制;不一致时
    // 拦截点 = 下游步的固定输入边界(三处校验点之一),不是臂自身的边界。
    const oddLane = createStep({
      id: 'odd-lane',
      inputSchema: draftOut,
      outputSchema: z.object({ other: z.number() }),
      execute: () => ({ other: 1 }),
    });
    const record = createStep({
      id: 'lane-record',
      inputSchema: z.object({ 'fast-lane': laneOut.optional(), 'odd-lane': laneOut.optional() }),
      outputSchema: z.object({ lane: z.string().optional() }),
      execute: ({ inputData }) => ({ lane: inputData['fast-lane']?.lane ?? inputData['odd-lane']?.lane }),
    });
    const branched = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: z.object({ lane: z.string().optional() }),
    })
      .then(draft)
      .branch([
        [() => false, fastLane],
        [() => true, oddLane],
      ])
      // 静态声明的不一致会被 .then 的 type-state 品牌拦在编译期;DOC-4 钉的是品牌之后的运行期
      // 后站——类型被擦除的调用方(手写字面量 / 动态构图,仓内惯例 `as never`)由下游步的固定
      // 输入边界拦截。
      .then(record as never)
      .commit();

    const error = await captureRejection(async () =>
      branched.createRun().start({ inputData: { topic: 'ts' } }).result.then(() => undefined),
    );

    // odd-lane 的输出 { other: 1 } 不满足下游按「两臂同形」假设声明的 inputSchema → run failed,
    // 错误钉在下游步(校验拦截点),臂自身的输入 / 输出边界都已通过
    expect(error).toBeInstanceOf(WorkflowValidationError);
    expect((error as WorkflowValidationError).stepId).toBe('lane-record');
  });
});

describe('foreach:数组输入 + 自写并发闸 + 保序收集', () => {
  const polish = createStep({
    id: 'polish',
    inputSchema: elementIn,
    outputSchema: polishedOut,
    execute: ({ inputData }) => ({ polished: inputData.draft.toUpperCase() }),
  });

  it('默认 concurrency=1:逐元素顺序执行,输出数组保序;step 的记录 = 收集到的数组', async () => {
    const events: string[] = [];
    const ownViews: unknown[] = [];
    let seenBefore: unknown;
    let seenArray: unknown;
    let seenRecord: unknown;
    const sequential = createStep({
      id: 'polish',
      inputSchema: elementIn,
      outputSchema: polishedOut,
      execute: async (ctx) => {
        events.push(`start:${ctx.inputData.draft}`);
        ownViews.push(ctx.getStepResult('polish'));
        seenBefore = ctx.getStepResult('fan-out');
        await Promise.resolve();
        events.push(`end:${ctx.inputData.draft}`);
        return { polished: ctx.inputData.draft.toUpperCase() };
      },
    });
    const join = createStep({
      id: 'join',
      inputSchema: z.array(polishedOut),
      outputSchema: z.object({ joined: z.string() }),
      execute: (ctx) => {
        seenArray = ctx.inputData;
        seenRecord = ctx.getStepResult('polish');
        return { joined: ctx.inputData.map((item) => item.polished).join('+') };
      },
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: draftsInput,
      outputSchema: z.object({ joined: z.string() }),
    })
      .then(fanOut)
      .foreach(sequential)
      .then(join)
      .commit();

    const outcome = expectSuccess(await workflow.createRun().start({ inputData: { drafts: ['a', 'b', 'c'] } }).result);

    // concurrency=1:上一元素做完才开下一元素
    expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
    expect(outcome.output).toEqual({ joined: 'A+B+C' });
    // 下游拿到的是数组;getStepResult(step id) = 同一份收集数组
    expect(seenArray).toEqual([{ polished: 'A' }, { polished: 'B' }, { polished: 'C' }]);
    expect(seenRecord).toEqual(seenArray);
    // 块之前已运行 step 的记录可见;块内查自己(尚未记录)undefined
    expect(seenBefore).toEqual([{ draft: 'a' }, { draft: 'b' }, { draft: 'c' }]);
    expect(ownViews).toEqual([undefined, undefined, undefined]);
    expect(outcome.stepResults['polish']?.status).toBe('success');
    expect(outcome.stepResults['polish']?.output).toEqual([{ polished: 'A' }, { polished: 'B' }, { polished: 'C' }]);
  });

  it('concurrency>1:闸宽 = concurrency,槽位空出立刻补位(流式,非分批),保序收集', async () => {
    const started: string[] = [];
    const completed: string[] = [];
    const releases = new Map<string, () => void>();
    let active = 0;
    let peak = 0;
    const gated = createStep({
      id: 'polish',
      inputSchema: elementIn,
      outputSchema: polishedOut,
      execute: async ({ inputData }) => {
        started.push(inputData.draft);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((release) => releases.set(inputData.draft, release));
        active -= 1;
        completed.push(inputData.draft);
        return { polished: inputData.draft };
      },
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: draftsInput,
      outputSchema: z.array(polishedOut),
    })
      .then(fanOut)
      .foreach(gated, { concurrency: 2 })
      .commit();

    const out = workflow.createRun().start({ inputData: { drafts: ['a', 'b', 'c'] } });
    const result = out.result;
    await vi.waitFor(() => expect(started).toEqual(['a', 'b']));
    expect(peak).toBe(2);

    // b 先完成 → 空出的槽位立刻给 c(a 仍在飞):流式补位,不是等整批
    releases.get('b')!();
    await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c']));
    releases.get('c')!();
    await vi.waitFor(() => expect(completed).toEqual(['b', 'c']));
    releases.get('a')!();

    const outcome = expectSuccess(await result);

    expect(completed).toEqual(['b', 'c', 'a']);
    // 完成序与输入序不同,收集仍按输入下标保序
    expect(outcome.output).toEqual([{ polished: 'a' }, { polished: 'b' }, { polished: 'c' }]);
    expect(peak).toBe(2);
  });

  it('空数组:step 不执行,输出 [](记录同样是空数组)', async () => {
    const execute = vi.fn((_ctx: StepContext<{ draft: string }>) => ({ polished: 'x' }));
    const empty = createStep({ id: 'polish', inputSchema: elementIn, outputSchema: polishedOut, execute });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: draftsInput,
      outputSchema: z.array(polishedOut),
    })
      .then(fanOut)
      .foreach(empty)
      .commit();

    const outcome = expectSuccess(await workflow.createRun().start({ inputData: { drafts: [] } }).result);

    expect(execute).not.toHaveBeenCalled();
    expect(outcome.output).toEqual([]);
    expect(outcome.stepResults['polish']?.output).toEqual([]);
  });

  it('输入不是数组:显式报错(run failed),step 不执行', async () => {
    const execute = vi.fn((_ctx: StepContext<{ draft: string }>) => ({ polished: 'x' }));
    const objectStep = createStep({ id: 'polish', inputSchema: elementIn, outputSchema: polishedOut, execute });
    // then 主轴产出对象,foreach 需要数组——类型面只严格约束 then,执行期显式报错
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: z.array(polishedOut),
    })
      .then(draft)
      .foreach(objectStep)
      .commit();

    const error = await captureRejection(async () =>
      workflow.createRun().start({ inputData: { topic: 'ts' } }).result.then(() => undefined),
    );

    expect(error.message).toMatch(/article/);
    expect(error.message).toMatch(/polish/);
    expect(error.message).toMatch(/array/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('元素边界:某元素不过 step inputSchema → WorkflowValidationError(带 step id),后续迭代不执行', async () => {
    const started: string[] = [];
    const strict = createStep({
      id: 'polish',
      inputSchema: z.object({ draft: z.string().min(3) }),
      outputSchema: polishedOut,
      execute: ({ inputData }) => {
        started.push(inputData.draft);
        return { polished: inputData.draft };
      },
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: draftsInput,
      outputSchema: z.array(polishedOut),
    })
      .then(fanOut)
      .foreach(strict)
      .commit();

    const error = await captureRejection(async () =>
      workflow
        .createRun()
        .start({ inputData: { drafts: ['alpha', 'x', 'omega'] } })
        .result.then(() => undefined),
    );

    expect(error).toBeInstanceOf(WorkflowValidationError);
    expect((error as WorkflowValidationError).stepId).toBe('polish');
    expect(started).toEqual(['alpha']);
  });

  it('迭代失败整块失败:不再开新迭代,在飞迭代完成;错误原样', async () => {
    const boom = new Error('iteration boom');
    const started: string[] = [];
    const completed: string[] = [];
    const releaseA = deferred();
    const releaseB = deferred();
    const failing = createStep({
      id: 'polish',
      inputSchema: elementIn,
      outputSchema: polishedOut,
      execute: async ({ inputData }) => {
        started.push(inputData.draft);
        if (inputData.draft === 'a') {
          await releaseA.promise;
          completed.push('a');
          return { polished: 'a' };
        }
        await releaseB.promise;
        throw boom;
      },
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: draftsInput,
      outputSchema: z.array(polishedOut),
    })
      .then(fanOut)
      .foreach(failing, { concurrency: 2 })
      .commit();

    const out = workflow.createRun().start({ inputData: { drafts: ['a', 'b', 'c', 'd'] } });
    const result = out.result;
    await vi.waitFor(() => expect(started).toEqual(['a', 'b']));

    releaseB.resolve();
    releaseA.resolve();
    // 同步点在满意义上等在飞落定(#54):b 失败后闸门不再拉新迭代,在飞的 a 落定后 run 才以原错误拒绝
    const error = await captureRejection(() => result.then(() => undefined));
    expect(error).toBe(boom);

    // 在飞迭代完成收尾,失败后不得再开新迭代
    await vi.waitFor(() => expect(completed).toEqual(['a']));
    expect(started).toEqual(['a', 'b']);
  });

  it('concurrency:缺省 1;非正整数在定义期显式报错(不静默改写)', () => {
    const entryFor = (options?: { readonly concurrency?: number }) =>
      createWorkflow({
        id: 'article',
        inputSchema: draftsInput,
        outputSchema: z.array(polishedOut),
      })
        .foreach(polish, options)
        .commit().entries[0];

    expect(entryFor()).toEqual({ type: 'foreach', step: polish, concurrency: 1 });
    expect(entryFor({ concurrency: 4 })).toEqual({ type: 'foreach', step: polish, concurrency: 4 });
    for (const invalid of [0, -2, 2.7, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = captureError(() => entryFor({ concurrency: invalid }));
      expect(error.message).toMatch(/article/);
      expect(error.message).toMatch(/concurrency/);
    }
  });
});
