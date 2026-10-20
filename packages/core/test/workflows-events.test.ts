import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createStep, createWorkflow, WorkflowValidationError } from '@oribos/core/workflows';
import type { StepContext, WorkflowEvent, WorkflowRunOutput } from '@oribos/core/workflows';
import { describeOutputObjectContract } from '@oribos/testing';
import { captureRejection, expectAssignable, expectSuccess } from './helpers/assertions.js';

/**
 * lifecycle 事件流(M3 #52,`docs/architecture/workflows.md`「流式事件」):run 输出对象的第二种消费
 * ——`for await` 消费 run / step 边界事件(run-start / step-start / step-end / run-end),与
 * `await out.result` 共享同一次执行(单路径)。事件带边界值(step 输入 / 输出、run 输入 / 终值),
 * 包络复用 chunk 协议(`{ type, … }` 判别联合、kebab-case 词汇)。
 *
 * 接缝 = 公开 `@oribos/core/workflows` 子路径:`run.start` 返回的输出对象,以及 step execute 收到的
 * ctx;不触内部模块。
 *
 * 共享泵的行为矩阵由 `@oribos/testing` 的共享契约套件钉住,本文件以推源(promise+emit)一侧
 * 喂它;拉源(generator)一侧在 agent-stream.test.ts。
 */
describeOutputObjectContract<WorkflowEvent>({
  success: () => {
    let ran = 0;
    const step = createStep({
      id: 'work',
      inputSchema: topicInput,
      outputSchema: topicInput,
      execute: ({ inputData }) => {
        ran += 1;
        return inputData;
      },
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: topicInput,
    })
      .then(step)
      .commit();
    const run = workflow.createRun();
    const out = run.start({ inputData: { topic: 'ts' } });
    return {
      output: out,
      readTerminal: () => out.result,
      started: () => ran > 0,
      chunks: [
        { type: 'run-start', runId: run.runId, workflowId: 'article', input: { topic: 'ts' } },
        { type: 'step-start', stepId: 'work', input: { topic: 'ts' } },
        { type: 'step-end', stepId: 'work', status: 'success', output: { topic: 'ts' } },
        { type: 'run-end', status: 'success', output: { topic: 'ts' } },
      ],
      terminal: {
        status: 'success',
        output: { topic: 'ts' },
        stepResults: {
          work: {
            status: 'success',
            output: { topic: 'ts' },
            startedAt: expect.any(Number),
            endedAt: expect.any(Number),
          },
        },
      },
    };
  },
  failure: () => {
    const boom = new Error('boom');
    const failing = createStep({
      id: 'failing',
      inputSchema: topicInput,
      outputSchema: topicInput,
      execute: () => {
        throw boom;
      },
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: topicInput,
    })
      .then(failing)
      .commit();
    const run = workflow.createRun();
    const out = run.start({ inputData: { topic: 'ts' } });
    return {
      output: out,
      readTerminal: () => out.result,
      started: () => true,
      chunks: [
        { type: 'run-start', runId: run.runId, workflowId: 'article', input: { topic: 'ts' } },
        { type: 'step-start', stepId: 'failing', input: { topic: 'ts' } },
        { type: 'step-end', stepId: 'failing', status: 'failed' },
      ],
      error: boom,
    };
  },
});

const topicInput = z.object({ topic: z.string() });
const articleOutput = z.object({ polished: z.string() });

/** 消费一条事件流的全部事件(for-await 是输出对象的第二种消费)。 */
async function collect(out: WorkflowRunOutput<unknown>): Promise<WorkflowEvent[]> {
  const events: WorkflowEvent[] = [];
  for await (const event of out) events.push(event);
  return events;
}

describe('输出对象:for-await lifecycle 事件流', () => {
  it('then 主轴:run-start → (step-start → step-end)×2 → run-end;事件带边界值;两种消费同一次执行', async () => {
    let drafts = 0;
    const draft = createStep({
      id: 'draft',
      inputSchema: topicInput,
      outputSchema: z.object({ draft: z.string() }),
      execute: ({ inputData }) => {
        drafts += 1;
        return { draft: inputData.topic.toUpperCase() };
      },
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
    })
      .then(draft)
      .then(polish)
      .commit();

    const run = workflow.createRun();
    const out = run.start({ inputData: { topic: 'ts' } });
    expectAssignable<AsyncIterable<WorkflowEvent>>(out);

    const events = await collect(out);
    expect(events).toEqual([
      { type: 'run-start', runId: run.runId, workflowId: 'article', input: { topic: 'ts' } },
      { type: 'step-start', stepId: 'draft', input: { topic: 'ts' } },
      { type: 'step-end', stepId: 'draft', status: 'success', output: { draft: 'TS' } },
      { type: 'step-start', stepId: 'polish', input: { draft: 'TS' } },
      { type: 'step-end', stepId: 'polish', status: 'success', output: { polished: '«TS»' } },
      { type: 'run-end', status: 'success', output: { polished: '«TS»' } },
    ]);

    // 单一代码路径:流消费完再读 result,拿到的是同一次执行的终值,step 不重跑。
    expect(expectSuccess(await out.result).output).toEqual({ polished: '«TS»' });
    expect(drafts).toBe(1);
  });

  it('块内每次执行一对:foreach 迭代各自 step-start / step-end(并发闸下交错),聚记录仍按块', async () => {
    const gates = new Map<number, () => void>();
    const releases = new Map<number, Promise<void>>();
    for (const element of [1, 2, 3]) {
      releases.set(
        element,
        new Promise<void>((resolve) => gates.set(element, resolve)),
      );
    }
    const double = createStep({
      id: 'double',
      inputSchema: z.number(),
      outputSchema: z.number(),
      execute: async ({ inputData }) => {
        await releases.get(inputData)!;
        return inputData * 10;
      },
    });
    const workflow = createWorkflow({
      id: 'fanout',
      inputSchema: z.array(z.number()),
      outputSchema: z.array(z.number()),
    })
      .foreach(double, { concurrency: 2 })
      .commit();

    const run = workflow.createRun();
    const out = run.start({ inputData: [1, 2, 3] });
    const events: WorkflowEvent[] = [];
    const consuming = (async () => {
      for await (const event of out) events.push(event);
    })();

    // 并发闸宽 2:1、2 先开,各自的 execute 停在闸门前。
    await flush();
    expect(events).toEqual([
      { type: 'run-start', runId: run.runId, workflowId: 'fanout', input: [1, 2, 3] },
      { type: 'step-start', stepId: 'double', input: 1 },
      { type: 'step-start', stepId: 'double', input: 2 },
    ]);

    // 2 先完成:它的 step-end 先落,槽位立刻补上第三次迭代(流式闸,不是分批 Promise.all)。
    gates.get(2)!();
    await flush();
    expect(events.slice(3)).toEqual([
      { type: 'step-end', stepId: 'double', status: 'success', output: 20 },
      { type: 'step-start', stepId: 'double', input: 3 },
    ]);

    gates.get(1)!();
    gates.get(3)!();
    await consuming;
    expect(events.slice(5)).toEqual([
      { type: 'step-end', stepId: 'double', status: 'success', output: 10 },
      { type: 'step-end', stepId: 'double', status: 'success', output: 30 },
      { type: 'run-end', status: 'success', output: [10, 20, 30] },
    ]);

    // 事件按执行拆开,run 的记录仍按块聚合(#49 / #50 的块记录语义不变)。
    expect(expectSuccess(await out.result).stepResults['double']?.output).toEqual([10, 20, 30]);
  });

  it('start 输入校验失败:没有 run-start 事件(运行从未开始),迭代器以校验错误 reject', async () => {
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
    })
      .then(echo)
      .commit();

    const out = workflow.createRun().start({ inputData: { topic: 42 } as never });
    const error = await captureRejection(() => collect(out));
    expect(error).toBeInstanceOf(WorkflowValidationError);
  });
});

describe('失败与挂起:终态的流语义', () => {
  it('失败 step:step-end status failed 落地后迭代器 reject(与 result 同错),已产事件按序交付', async () => {
    const boom = new Error('boom');
    const failing = createStep({
      id: 'failing',
      inputSchema: topicInput,
      outputSchema: articleOutput,
      execute: () => {
        throw boom;
      },
    });
    const unreached = createStep({
      id: 'unreached',
      inputSchema: articleOutput,
      outputSchema: articleOutput,
      execute: ({ inputData }) => inputData,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: articleOutput,
    })
      .then(failing)
      .then(unreached)
      .commit();

    const run = workflow.createRun();
    const out = run.start({ inputData: { topic: 'ts' } });
    const events: WorkflowEvent[] = [];
    const streamError = await captureRejection(async () => {
      for await (const event of out) events.push(event);
    });

    // 没有 failed 的 run-end:错误就是 run 的终态事实,两条消费给出同一个错误。
    expect(streamError).toBe(boom);
    expect(events).toEqual([
      { type: 'run-start', runId: run.runId, workflowId: 'article', input: { topic: 'ts' } },
      { type: 'step-start', stepId: 'failing', input: { topic: 'ts' } },
      { type: 'step-end', stepId: 'failing', status: 'failed' },
    ]);
    expect(await captureRejection(() => out.result)).toBe(boom);
  });

  it('挂起:step-end status suspended → run-end status suspended;恢复段走 resume 的 promise,流不再有事件', async () => {
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
    })
      .then(approval)
      .commit();

    const run = workflow.createRun();
    const out = run.start({ inputData: { topic: 'ts' } });
    const events = await collect(out);
    expect(events).toEqual([
      { type: 'run-start', runId: run.runId, workflowId: 'article', input: { topic: 'ts' } },
      { type: 'step-start', stepId: 'approval', input: { topic: 'ts' } },
      { type: 'step-end', stepId: 'approval', status: 'suspended' },
      { type: 'run-end', status: 'suspended' },
    ]);

    // 流已收束(done);恢复是 resume 的 promise,不是同一条流的续写。
    const resumed = expectSuccess(await run.resume({ step: 'approval', resumeData: { approved: true } }));
    expect(resumed.output).toEqual({ polished: 'ts:true' });
  });
  it('块内 suspend:step-end 读 suspended(该边界真能挂起 run),run-end 落 suspended', async () => {
    const gate = createStep({
      id: 'gate',
      inputSchema: z.number(),
      outputSchema: z.number(),
      suspendSchema: z.object({ question: z.string() }),
      execute: (ctx: StepContext<number, undefined, { question: string }>) =>
        ctx.suspend({ question: 'ok?' }),
    });
    const workflow = createWorkflow({
      id: 'fanout',
      inputSchema: z.array(z.number()),
      outputSchema: z.array(z.number()),
    })
      .foreach(gate)
      .commit();

    const run = workflow.createRun();
    const out = run.start({ inputData: [1] });
    const events: WorkflowEvent[] = [];
    const outcome = await out.result;
    // 迭代器不 break,消费到流末(#54:块内挂起 = 真挂起,不再是失败拒绝)
    for await (const event of out) events.push(event);

    // 事件、记录、快照同读法:块内 step 的挂起边界读 suspended,run 以 suspended 终态收束
    expect(outcome.status).toBe('suspended');
    expect(events).toEqual([
      { type: 'run-start', runId: run.runId, workflowId: 'fanout', input: [1] },
      { type: 'step-start', stepId: 'gate', input: 1 },
      { type: 'step-end', stepId: 'gate', status: 'suspended' },
      { type: 'run-end', status: 'suspended' },
    ]);
  });
});

describe('输出对象:懒启动与提前离开', () => {
  it('懒启动:start 零执行;首个 next() 才开始,流与 result 仍是同一次执行', async () => {
    let ran = 0;
    const step = createStep({
      id: 'work',
      inputSchema: topicInput,
      outputSchema: topicInput,
      execute: ({ inputData }) => {
        ran += 1;
        return inputData;
      },
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: topicInput,
    })
      .then(step)
      .commit();

    const run = workflow.createRun();
    const out = run.start({ inputData: { topic: 'ts' } });
    expect(ran).toBe(0);

    const iterator = out[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({
      type: 'run-start',
      runId: run.runId,
      workflowId: 'article',
      input: { topic: 'ts' },
    });

    expect(expectSuccess(await out.result).output).toEqual({ topic: 'ts' });
    expect(ran).toBe(1);
  });

  it('迭代器提前 break:不再缓冲事件,run 照跑完,result 仍落定', async () => {
    const seen: string[] = [];
    const makeStep = (id: string) =>
      createStep({
        id,
        inputSchema: topicInput,
        outputSchema: topicInput,
        execute: ({ inputData }) => {
          seen.push(id);
          return inputData;
        },
      });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: topicInput,
    })
      .then(makeStep('first'))
      .then(makeStep('second'))
      .commit();

    const out = workflow.createRun().start({ inputData: { topic: 'ts' } });
    const events: WorkflowEvent[] = [];
    for await (const event of out) {
      events.push(event);
      break;
    }

    expect(events).toEqual([
      { type: 'run-start', runId: expect.any(String), workflowId: 'article', input: { topic: 'ts' } },
    ]);
    // 消费者离开只停掉事件缓冲,不停 run:两步照跑,终值照落定。
    expect(expectSuccess(await out.result).output).toEqual({ topic: 'ts' });
    expect(seen).toEqual(['first', 'second']);
  });
});

/** 让在途的微任务全部落定后再断言事件序列。 */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
