import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createInMemorySnapshotStore, createStep, createWorkflow } from '@oribos/core/workflows';
import type {
  StepContext,
  Workflow,
  WorkflowResumeOptions,
  WorkflowRunOutcome,
  WorkflowRunSnapshot,
  WorkflowSnapshotStore,
} from '@oribos/core/workflows';
import { captureRejection, expectAssignable, expectSuccess, expectSuspended } from './helpers/assertions.js';

/**
 * suspend/resume(M3 #51,`docs/architecture/workflows.md`「suspend/resume 与快照」):suspend 控制
 * 信号 + step 边界 JSON 快照 + `WorkflowSnapshotStore` port(内存 Map 默认实现)、固定持久化时机
 * (有 storage 时每个条目完成 + suspend + 终态)、`run.resume({ step, resumeData? })` 的 load →
 * resumeSchema 校验 → 从 position 重进、resume 进程内锁去重。
 *
 * 本票裁决(#54):块内挂起补上承载缝——parallel 臂 / branch 臂 / foreach / dowhile / dountil
 * 体内 `suspend()` 真挂起:迭代现场进快照的可选 `iterationSite` 字段(additive,旧快照无此字段走顶层
 * 路径),resume 按 site 重进块内(完成部分按记录回放,洞与挂起点重跑)。事件/记录/快照三处读法
 * 对齐「块内挂起 = 真挂起」:块内 step 的 `step-end` 读 `suspended`。
 *
 * 接缝 = 公开 `@oribos/core/workflows` 子路径:定义 → `createRun` → `run.start` / `run.resume`,
 * 以及 step `execute` 收到的 ctx 与注入的 store 观察到的快照。
 */

const topicInput = z.object({ topic: z.string() });
const draftOutput = z.object({ draft: z.string() });
const articleOutput = z.object({ polished: z.string() });

/** 记录每次 save 的快照(深拷贝,模拟真实序列化后端),load 返回最近一份。 */
function recordingStore(): {
  readonly store: WorkflowSnapshotStore;
  readonly saves: WorkflowRunSnapshot[];
} {
  const saves: WorkflowRunSnapshot[] = [];
  let latest: WorkflowRunSnapshot | null = null;
  return {
    saves,
    store: {
      load: async (runId) =>
        latest !== null && latest.runId === runId ? structuredClone(latest) : null,
      save: async (_runId, snapshot) => {
        saves.push(structuredClone(snapshot));
        latest = snapshot;
      },
    },
  };
}

/** draft → approval(suspend) → polish 三条目链:主轴的挂起/恢复叙事。 */
function approvalWorkflow(options: { readonly storage?: WorkflowSnapshotStore } = {}): {
  readonly workflow: Workflow<typeof topicInput, typeof articleOutput>;
  readonly draftExecute: ReturnType<typeof vi.fn>;
  readonly approvalExecute: ReturnType<typeof vi.fn>;
  readonly polishExecute: ReturnType<typeof vi.fn>;
} {
  const draftExecute = vi.fn((ctx: StepContext<{ topic: string }>) => ({
    draft: ctx.inputData.topic.toUpperCase(),
  }));
  const draft = createStep({
    id: 'draft',
    inputSchema: topicInput,
    outputSchema: draftOutput,
    execute: draftExecute,
  });
  const approvalExecute = vi.fn(
    (ctx: StepContext<{ draft: string }, { approved: boolean }, { question: string }>) => {
      if (ctx.resumeData === undefined) {
        ctx.suspend({ question: `approve ${ctx.inputData.draft}?` });
      }
      return { polished: `${ctx.inputData.draft}:${String(ctx.resumeData.approved)}` };
    },
  );
  const approval = createStep({
    id: 'approval',
    inputSchema: draftOutput,
    outputSchema: articleOutput,
    resumeSchema: z.object({ approved: z.boolean() }),
    suspendSchema: z.object({ question: z.string() }),
    execute: approvalExecute,
  });
  const polishExecute = vi.fn((ctx: StepContext<{ polished: string }>) => ({
    polished: `«${ctx.inputData.polished}»`,
  }));
  const polish = createStep({
    id: 'polish',
    inputSchema: articleOutput,
    outputSchema: articleOutput,
    execute: polishExecute,
  });
  const workflow = createWorkflow({
    id: 'article',
    inputSchema: topicInput,
    outputSchema: articleOutput,
    ...options,
  })
    .then(draft)
    .then(approval)
    .then(polish)
    .commit();
  return { workflow, draftExecute, approvalExecute, polishExecute };
}

describe('suspend:控制信号展开 + 记录 + 终态信封', () => {
  it('suspend(payload) 展开 run:result 落 suspended 信封,当前 step 记录 suspended,后续条目不执行', async () => {
    const { workflow, approvalExecute, polishExecute } = approvalWorkflow();
    const before = Date.now();

    const outcome = expectSuspended(
      await workflow.createRun().start({ inputData: { topic: 'ts' } }).result,
    );
    const after = Date.now();
    // 挂起点:信封点名 step,后续条目不再执行
    expect(outcome.stepId).toBe('approval');
    expect(approvalExecute).toHaveBeenCalledTimes(1);
    expect(polishExecute).not.toHaveBeenCalled();

    expect(Object.keys(outcome.stepResults)).toEqual(['draft', 'approval']);
    const record = outcome.stepResults['approval'];
    expect(record?.status).toBe('suspended');
    expect(record?.suspendPayload).toEqual({ question: 'approve TS?' });
    // 挂起的 step 没有 output(未完成)
    expect(record !== undefined && 'output' in record).toBe(false);
    expect(record?.startedAt).toBeGreaterThanOrEqual(before);
    expect(record?.endedAt).toBeLessThanOrEqual(after);
    // 前序条目照常记录
    expect(outcome.stepResults['draft']).toMatchObject({
      status: 'success',
      output: { draft: 'TS' },
    });
  });

  it('suspend 不经过重试:挂起不是失败,retries 不重跑挂起的 step', async () => {
    const execute = vi.fn((ctx: StepContext<{ draft: string }, undefined, { question: string }>) =>
      ctx.suspend({ question: 'anyone?' }),
    );
    const approval = createStep({
      id: 'approval',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
      retries: 3,
      execute,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
    })
      .then(approval)
      .commit();

    const outcome = await workflow.createRun().start({ inputData: { draft: 'ts' } }).result;

    expect(outcome.status).toBe('suspended');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('无 storage 即纯内存:内存默认实现让同一 run 的 suspend → resume 跑通', async () => {
    const { workflow, approvalExecute } = approvalWorkflow();

    const run = workflow.createRun();
    const suspended = expectSuspended(await run.start({ inputData: { topic: 'ts' } }).result);
    expect(suspended.stepId).toBe('approval');

    const outcome = expectSuccess(
      await run.resume({ step: 'approval', resumeData: { approved: true } }),
    );

    expect(outcome.output).toEqual({ polished: '«TS:true»' });
    expect(approvalExecute).toHaveBeenCalledTimes(2);
  });
});

describe('快照形状与持久化时机', () => {
  it('字段恰为 {runId,status,input,stepResults,position}:input 是校验后的运行输入,position = 重进下标', async () => {
    const input = z.object({ topic: z.string().transform((value) => value.toUpperCase()) });
    const approvalExecute = vi.fn(
      (ctx: StepContext<{ topic: string }, { approved: boolean }, { question: string }>) => {
        if (ctx.resumeData === undefined) ctx.suspend({ question: 'go?' });
        return { polished: `${ctx.inputData.topic}:${String(ctx.resumeData.approved)}` };
      },
    );
    const approval = createStep({
      id: 'approval',
      inputSchema: topicInput,
      outputSchema: articleOutput,
      resumeSchema: z.object({ approved: z.boolean() }),
      suspendSchema: z.object({ question: z.string() }),
      execute: approvalExecute,
    });
    const { store, saves } = recordingStore();
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: input,
      outputSchema: articleOutput,
      storage: store,
    })
      .then(approval)
      .commit();

    const runId = 'shape-run';
    const run = workflow.createRun({ runId });
    await run.start({ inputData: { topic: 'ts' } }).result;

    const suspended = saves.at(-1);
    expect(suspended).toEqual({
      runId,
      status: 'suspended',
      // 校验后的输入(transform 已生效),不是原始 inputData
      input: { topic: 'TS' },
      stepResults: {
        approval: {
          status: 'suspended',
          suspendPayload: { question: 'go?' },
          startedAt: expect.any(Number),
          endedAt: expect.any(Number),
        },
      },
      // position = 挂起条目下标(从该条目重进);startIdx 等价物
      position: 0,
    });

    await run.resume({ step: approval, resumeData: { approved: false } });

    // resume 后重进的 tip 来自快照的校验输入(不重跑 transform,也不重复校验 start 输入)
    expect(approvalExecute).toHaveBeenLastCalledWith(
      expect.objectContaining({ inputData: { topic: 'TS' }, resumeData: { approved: false } }),
    );
    expect(saves.at(-1)).toMatchObject({
      runId,
      status: 'success',
      input: { topic: 'TS' },
      position: 1,
      stepResults: { approval: { status: 'success', output: { polished: 'TS:false' } } },
    });
  });

  it('有 storage:每个条目完成后写 running 快照(position = 下一条目),suspend / 终态固定写', async () => {
    const { store, saves } = recordingStore();
    const { workflow } = approvalWorkflow({ storage: store });

    const run = workflow.createRun({ runId: 'timing-run' });
    await run.start({ inputData: { topic: 'ts' } }).result;
    expect(saves.map((snapshot) => [snapshot.status, snapshot.position])).toEqual([
      ['running', 1],
      ['suspended', 1],
    ]);

    await run.resume({ step: 'approval', resumeData: { approved: true } });

    expect(saves.map((snapshot) => [snapshot.status, snapshot.position])).toEqual([
      ['running', 1],
      ['suspended', 1],
      ['running', 2],
      ['running', 3],
      ['success', 3],
    ]);
    // running 快照带已完成条目的记录(每步 status / output / 起止时间)
    expect(saves[0]?.stepResults['draft']).toMatchObject({
      status: 'success',
      output: { draft: 'TS' },
    });
    expect(saves.at(-1)?.stepResults['polish']).toMatchObject({ status: 'success' });
  });

  it('失败终态写:step 抛错 → failed 快照(position = 失败条目),原错误原样拒绝', async () => {
    const boom = new Error('boom');
    const brokenExecute = vi.fn(() => {
      throw boom;
    });
    const broken = createStep({
      id: 'broken',
      inputSchema: topicInput,
      outputSchema: articleOutput,
      execute: brokenExecute,
    });
    const { store, saves } = recordingStore();
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: articleOutput,
      storage: store,
    })
      .then(broken)
      .commit();

    const error = await captureRejection(async () =>
      workflow.createRun({ runId: 'failed-run' }).start({ inputData: { topic: 'ts' } }).result,
    );

    expect(error).toBe(boom);
    expect(saves.map((snapshot) => snapshot.status)).toEqual(['failed']);
    expect(saves[0]).toMatchObject({ position: 0, stepResults: { broken: { status: 'failed' } } });
  });
});

describe('run.resume:load 快照 → resumeData 校验 → 从 position 重进', () => {
  it('恢复挂起条目:resumeData 过 resumeSchema、前序条目回放、后续条目继续', async () => {
    const { workflow, draftExecute, approvalExecute, polishExecute } = approvalWorkflow();
    const run = workflow.createRun({ runId: 'resume-run' });
    await run.start({ inputData: { topic: 'ts' } }).result;

    const outcome = expectSuccess(
      await run.resume({
        step: 'approval',
        resumeData: { approved: true },
      }),
    );

    expect(outcome.output).toEqual({ polished: '«TS:true»' });
    expect(outcome.stepResults['approval']).toMatchObject({
      status: 'success',
      output: { polished: 'TS:true' },
    });
    // 前序条目只执行一次(记录回放,不重跑);挂起 step 两次(挂起 + 恢复);后续条目恢复后继续
    expect(draftExecute).toHaveBeenCalledTimes(1);
    expect(approvalExecute).toHaveBeenCalledTimes(2);
    expect(polishExecute).toHaveBeenCalledTimes(1);
    // 恢复的 step 拿到的 inputData 是回放的 tip(上一条目记录输出)
    expect(approvalExecute).toHaveBeenLastCalledWith(
      expect.objectContaining({ inputData: { draft: 'TS' }, resumeData: { approved: true } }),
    );
  });

  it('resumeData 过 resumeSchema 的返回值替换原数据(default 生效)', async () => {
    let seen: unknown;
    const approvalExecute = vi.fn(
      (ctx: StepContext<{ draft: string }, { approved: boolean; note: string }, unknown>) => {
        if (ctx.resumeData === undefined) ctx.suspend({ question: 'go?' });
        seen = ctx.resumeData;
        return { polished: ctx.inputData.draft };
      },
    );
    const approval = createStep({
      id: 'approval',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
      resumeSchema: z.object({
        approved: z.boolean(),
        note: z.string().default('none'),
      }),
      execute: approvalExecute,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
    })
      .then(approval)
      .commit();
    const run = workflow.createRun();
    await run.start({ inputData: { draft: 'ts' } }).result;

    await run.resume({ step: 'approval', resumeData: { approved: true } });

    expect(seen).toEqual({ approved: true, note: 'none' });
  });

  it('tip 回放:then / parallel / sleep 前缀的已记录输出重建 tip,一条都不重跑', async () => {
    const aExecute = vi.fn((ctx: StepContext<{ topic: string }>) => ({
      a: ctx.inputData.topic.length,
    }));
    const a = createStep({
      id: 'a',
      inputSchema: topicInput,
      outputSchema: z.object({ a: z.number() }),
      execute: aExecute,
    });
    const bExecute = vi.fn(() => ({ b: 'b' }));
    const b = createStep({
      id: 'b',
      inputSchema: topicInput,
      outputSchema: z.object({ b: z.string() }),
      execute: bExecute,
    });
    const approvalExecute = vi.fn(
      (
        ctx: StepContext<
          { a: { a: number }; b: { b: string } },
          { approved: boolean },
          { question: string }
        >,
      ) => {
        if (ctx.resumeData === undefined) ctx.suspend({ question: 'bundle ok?' });
        return { polished: `${String(ctx.inputData.a.a)}:${ctx.inputData.b.b}` };
      },
    );
    const approval = createStep({
      id: 'approval',
      inputSchema: z.object({
        a: z.object({ a: z.number() }),
        b: z.object({ b: z.string() }),
      }),
      outputSchema: articleOutput,
      resumeSchema: z.object({ approved: z.boolean() }),
      execute: approvalExecute,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: articleOutput,
    })
      .parallel([a, b])
      .sleep(1)
      .then(approval)
      .commit();
    const run = workflow.createRun();
    await run.start({ inputData: { topic: 'ts' } }).result;

    const outcome = await run.resume({ step: 'approval', resumeData: { approved: true } });

    expect(outcome.status).toBe('success');
    // parallel 的 keyed 输出 + sleep 透传,全部由记录回放
    expect(approvalExecute).toHaveBeenLastCalledWith(
      expect.objectContaining({ inputData: { a: { a: 2 }, b: { b: 'b' } } }),
    );
    expect(aExecute).toHaveBeenCalledTimes(1);
    expect(bExecute).toHaveBeenCalledTimes(1);
  });

  it('tip 回放:branch 前缀取已执行臂的记录(条件不重估、臂不重跑)', async () => {
    const cond = vi.fn(() => true);
    const armExecute = vi.fn((ctx: StepContext<{ draft: string }>) => ({
      revised: `r:${ctx.inputData.draft}`,
    }));
    const arm = createStep({
      id: 'revise',
      inputSchema: draftOutput,
      outputSchema: z.object({ revised: z.string() }),
      execute: armExecute,
    });
    const approvalExecute = vi.fn(
      (
        ctx: StepContext<
          { revise?: { revised: string } | undefined },
          { approved: boolean },
          { question: string }
        >,
      ) => {
        if (ctx.resumeData === undefined) ctx.suspend({ question: 'ok?' });
        return { polished: ctx.inputData.revise?.revised ?? '' };
      },
    );
    const approval = createStep({
      id: 'approval',
      // branch 块的 keyed 输出每个键都可缺席(未执行分支无值),下游按 optional 接
      inputSchema: z.object({ revise: z.object({ revised: z.string() }).optional() }),
      outputSchema: articleOutput,
      resumeSchema: z.object({ approved: z.boolean() }),
      execute: approvalExecute,
    });
    const draft = createStep({
      id: 'draft',
      inputSchema: topicInput,
      outputSchema: draftOutput,
      execute: ({ inputData }) => ({ draft: inputData.topic }),
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: articleOutput,
    })
      .then(draft)
      .branch([[cond, arm]])
      .then(approval)
      .commit();
    const run = workflow.createRun();
    await run.start({ inputData: { topic: 'ts' } }).result;

    const outcome = await run.resume({ step: 'approval', resumeData: { approved: true } });

    expect(outcome.status).toBe('success');
    expect(approvalExecute).toHaveBeenLastCalledWith(
      expect.objectContaining({ inputData: { revise: { revised: 'r:ts' } } }),
    );
    expect(cond).toHaveBeenCalledTimes(1);
    expect(armExecute).toHaveBeenCalledTimes(1);
  });

  it('恢复的 step 看得到前序记录:getStepResult 从快照种子恢复', async () => {
    let seenDraft: unknown;
    const approvalExecute = vi.fn(
      (ctx: StepContext<{ draft: string }, { approved: boolean }, unknown>) => {
        if (ctx.resumeData === undefined) ctx.suspend({ question: 'ok?' });
        seenDraft = ctx.getStepResult('draft');
        return { polished: ctx.inputData.draft };
      },
    );
    const draft = createStep({
      id: 'draft',
      inputSchema: topicInput,
      outputSchema: draftOutput,
      execute: ({ inputData }) => ({ draft: inputData.topic }),
    });
    const approval = createStep({
      id: 'approval',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
      resumeSchema: z.object({ approved: z.boolean() }),
      execute: approvalExecute,
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: topicInput,
      outputSchema: articleOutput,
    })
      .then(draft)
      .then(approval)
      .commit();
    const run = workflow.createRun();
    await run.start({ inputData: { topic: 'ts' } }).result;

    await run.resume({ step: 'approval', resumeData: { approved: true } });

    expect(seenDraft).toEqual({ draft: 'ts' });
  });

  it('resumeData 校验失败(第三处 IO):带 stepId 的 WorkflowValidationError,execute 不执行且快照仍可恢复', async () => {
    const { workflow, approvalExecute } = approvalWorkflow();
    const run = workflow.createRun();
    await run.start({ inputData: { topic: 'ts' } }).result;

    const error = await captureRejection(() =>
      run.resume({ step: 'approval', resumeData: { approved: 'yes' } }),
    );

    expect(error.name).toBe('WorkflowValidationError');
    expect((error as { stepId?: string }).stepId).toBe('approval');
    expect(error.message).toMatch(/resumeSchema/);
    expect(approvalExecute).toHaveBeenCalledTimes(1);

    // 校验失败不消费挂起快照:换合法 resumeData 仍可恢复
    const outcome = await run.resume({ step: 'approval', resumeData: { approved: true } });
    expect(outcome.status).toBe('success');
  });

  it('无 resumeSchema 的 step 不接受 resumeData(显式报错,不静默丢弃);不传 resumeData 则可恢复', async () => {
    const approval = createStep({
      id: 'approval',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
      execute: (ctx: StepContext<{ draft: string }, undefined, { question: string }>) =>
        ctx.suspend({ question: 'ok?' }),
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
    })
      .then(approval)
      .commit();
    const run = workflow.createRun();
    await run.start({ inputData: { draft: 'ts' } }).result;

    const error = await captureRejection(() =>
      run.resume({ step: 'approval', resumeData: { approved: true } }),
    );

    expect(error.message).toMatch(/resumeSchema/);
    const outcome = await run.resume({ step: 'approval' });
    expect(outcome.status).toBe('suspended');
  });

  it('resume 目标校验:step 名不是挂起 step → 显式报错,不执行任何 step', async () => {
    const { workflow, approvalExecute } = approvalWorkflow();
    const run = workflow.createRun();
    await run.start({ inputData: { topic: 'ts' } }).result;

    const error = await captureRejection(() =>
      run.resume({ step: 'polish', resumeData: { approved: true } }),
    );

    expect(error.message).toMatch(/approval/);
    expect(error.message).toMatch(/polish/);
    expect(approvalExecute).toHaveBeenCalledTimes(1);
  });

  it('resume 非挂起 run:未启动(无快照)与终态都显式报错', async () => {
    const { workflow } = approvalWorkflow();

    const neverStarted = await captureRejection(() =>
      workflow.createRun({ runId: 'never-started' }).resume({ step: 'approval' }),
    );
    expect(neverStarted.message).toMatch(/never-started/);
    expect(neverStarted.message).toMatch(/snapshot/);

    const run = workflow.createRun({ runId: 'finished' });
    await run.start({ inputData: { topic: 'ts' } }).result;
    await run.resume({ step: 'approval', resumeData: { approved: true } });
    const afterSuccess = await captureRejection(() =>
      run.resume({ step: 'approval', resumeData: { approved: true } }),
    );
    expect(afterSuccess.message).toMatch(/success/);
    expect(afterSuccess.message).toMatch(/suspended/);
  });

  it('快照与定义不匹配:position 指向的不是挂起 step 的 then 条目 → 显式报错(快照不被消费)', async () => {
    const store: WorkflowSnapshotStore = {
      load: async () => ({
        runId: 'stale',
        status: 'suspended',
        input: { draft: 'ts' },
        stepResults: { approval: { status: 'suspended', suspendPayload: { question: 'go?' } } },
        position: 0,
      }),
      save: async () => {},
    };
    const replaced = createStep({
      id: 'replaced',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
      execute: () => ({ polished: 'x' }),
    });
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
      storage: store,
    })
      .then(replaced)
      .commit();

    const error = await captureRejection(() =>
      workflow.createRun({ runId: 'stale' }).resume({ step: 'approval', resumeData: {} }),
    );

    expect(error.message).toMatch(/approval/);
    expect(error.message).toMatch(/position 0/);
  });

  it('无 storage 的内存默认按 run 对象持有:新 run 对象恢复报 no snapshot(跨对象要接真实 storage)', async () => {
    const { workflow } = approvalWorkflow();
    const runId = 'memory-only';
    await workflow.createRun({ runId }).start({ inputData: { topic: 'ts' } }).result;

    const error = await captureRejection(() =>
      workflow.createRun({ runId }).resume({ step: 'approval', resumeData: { approved: true } }),
    );

    expect(error.message).toMatch(/no snapshot/);
  });

  it('resume 并发去重:同一 runId 的并发 resume 返回同一 promise,step 只恢复一次', async () => {
    const { workflow, approvalExecute } = approvalWorkflow();
    const run = workflow.createRun({ runId: 'dedupe-run' });
    await run.start({ inputData: { topic: 'ts' } }).result;

    const first = run.resume({ step: 'approval', resumeData: { approved: true } });
    const second = run.resume({ step: 'approval', resumeData: { approved: true } });

    expect(second).toBe(first);
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    expect(firstOutcome.status).toBe('success');
    expect(secondOutcome.status).toBe('success');
    expect(approvalExecute).toHaveBeenCalledTimes(2);
  });

  it('resume 锁的键域是 (store, runId):两个 store 上的同 runId 各自独立 resume,互不 join(#119)', async () => {
    // 快照的持久化身份是 (store, runId):两个 store 各自挂起同一 runId,是两场互不相干的 resume
    const a = recordingStore();
    const b = recordingStore();
    const workflowA = approvalWorkflow({ storage: a.store });
    const workflowB = approvalWorkflow({ storage: b.store });
    const runId = 'cross-store';
    const runA = workflowA.workflow.createRun({ runId });
    const runB = workflowB.workflow.createRun({ runId });
    await runA.start({ inputData: { topic: 'a' } }).result;
    await runB.start({ inputData: { topic: 'b' } }).result;

    const [outcomeA, outcomeB] = await Promise.all([
      runA.resume({ step: 'approval', resumeData: { approved: true } }),
      runB.resume({ step: 'approval', resumeData: { approved: false } }),
    ]);

    // 各自的快照各自的结局:join 会让 B 拿到 A 的错型 outcome,且 B 自己的快照从未被消费
    expect(expectSuccess(outcomeA).output).toEqual({ polished: '«A:true»' });
    expect(expectSuccess(outcomeB).output).toEqual({ polished: '«B:false»' });
    expect(workflowA.approvalExecute).toHaveBeenCalledTimes(2);
    expect(workflowB.approvalExecute).toHaveBeenCalledTimes(2);
  });

  it('resume 进程内锁在失败后释放:中止的 resume 不消费快照,下一次仍可恢复', async () => {
    const { workflow, approvalExecute } = approvalWorkflow();
    const run = workflow.createRun();
    await run.start({ inputData: { topic: 'ts' } }).result;
    const controller = new AbortController();
    controller.abort();

    const error = await captureRejection(() =>
      run.resume({ step: 'approval', resumeData: { approved: true }, signal: controller.signal }),
    );

    expect(error.name).toBe('AbortError');
    expect(approvalExecute).toHaveBeenCalledTimes(1);

    const outcome = await run.resume({ step: 'approval', resumeData: { approved: true } });
    expect(outcome.status).toBe('success');
  });

  it('resume 走 storage 的跨 run 对象路径:同一 runId 新 run 恢复,requestContext 传给 resumed step', async () => {
    const { store } = recordingStore();
    const { workflow, approvalExecute } = approvalWorkflow({ storage: store });
    const runId = 'durable-run';
    await workflow.createRun({ runId }).start({ inputData: { topic: 'ts' } }).result;

    const resumed = workflow.createRun({ runId });
    const outcome = await resumed.resume({
      step: 'approval',
      resumeData: { approved: true },
      requestContext: { userId: 'u-1' },
    });

    expect(outcome.status).toBe('success');
    const lastCtx = approvalExecute.mock.calls.at(-1)?.[0] as
      | { readonly requestContext: { readonly userId?: unknown; readonly runId?: unknown } }
      | undefined;
    expect(lastCtx?.requestContext['userId']).toBe('u-1');
    expect(lastCtx?.requestContext['runId']).toBe(runId);
  });

  it('再次挂起:resume 后 step 再 suspend → 再落 suspended 快照,可二次 resume', async () => {
    const rounds: number[] = [];
    const execute = vi.fn(
      (
        ctx: StepContext<{ draft: string }, { verdict: string; round: number }, { round: number }>,
      ) => {
        rounds.push(ctx.resumeData?.round ?? 0);
        if (ctx.resumeData === undefined) ctx.suspend({ round: 1 });
        if (ctx.resumeData.round === 1) ctx.suspend({ round: 2 });
        return { polished: `${ctx.inputData.draft}:${ctx.resumeData.verdict}` };
      },
    );
    const approval = createStep({
      id: 'approval',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
      resumeSchema: z.object({ verdict: z.string(), round: z.number() }),
      suspendSchema: z.object({ round: z.number() }),
      execute,
    });
    const { store, saves } = recordingStore();
    const workflow = createWorkflow({
      id: 'article',
      inputSchema: draftOutput,
      outputSchema: articleOutput,
      storage: store,
    })
      .then(approval)
      .commit();
    const run = workflow.createRun({ runId: 'two-rounds' });

    const first = await run.start({ inputData: { draft: 'ts' } }).result;
    expect(first.status).toBe('suspended');
    const second = expectSuspended(
      await run.resume({ step: 'approval', resumeData: { verdict: 'ok', round: 1 } }),
    );
    expect(second.stepResults['approval']?.suspendPayload).toEqual({ round: 2 });
    expect(saves.at(-1)).toMatchObject({ status: 'suspended', position: 0 });

    const third = await run.resume({ step: 'approval', resumeData: { verdict: 'ok', round: 2 } });
    expect(third.status).toBe('success');
    expect(rounds).toEqual([0, 1, 2]);
    expect(saves.at(-1)?.status).toBe('success');
  });
});

describe('块内 suspend:branch 臂挂起 → 条件不重估,所选臂重进', () => {
  it('臂挂起:run 落 suspended,快照带 { kind: branch };resume 不重估条件,直接重进所选臂', async () => {
    const cond = vi.fn((ctx: StepContext<string>) => ctx.inputData === 'x');
    const armExecute = vi.fn(
      (ctx: StepContext<string, string, { question: string }>) => {
        if (ctx.resumeData === undefined) ctx.suspend({ question: 'which lane?' });
        return `lane:${ctx.resumeData}`;
      },
    );
    const arm = createStep({
      id: 'review',
      inputSchema: z.string(),
      outputSchema: z.string(),
      resumeSchema: z.string(),
      execute: armExecute,
    });
    const otherExecute = vi.fn(() => 'other');
    const other = createStep({
      id: 'auto',
      inputSchema: z.string(),
      outputSchema: z.string(),
      execute: otherExecute,
    });
    const afterExecute = vi.fn((ctx: StepContext<{ review?: string }>) => ({
      done: ctx.inputData.review ?? 'none',
    }));
    const after = createStep({
      id: 'after',
      inputSchema: z.object({ review: z.string().optional() }),
      outputSchema: z.object({ done: z.string() }),
      execute: afterExecute,
    });
    const { store, saves } = recordingStore();
    const workflow = createWorkflow({
      id: 'lane',
      inputSchema: z.string(),
      outputSchema: z.object({ done: z.string() }),
      storage: store,
    })
      .branch([
        [cond, arm],
        [() => true, other],
      ])
      .then(after)
      .commit();
    const run = workflow.createRun({ runId: 'branch-gate' });
    const suspended = expectSuspended(await run.start({ inputData: 'x' }).result);

    expect(suspended.stepId).toBe('review');
    expect(suspended.stepResults['review']?.status).toBe('suspended');
    expect(saves.at(-1)).toMatchObject({
      status: 'suspended',
      position: 0,
      iterationSite: { kind: 'branch' },
    });

    const outcome = expectSuccess(await run.resume({ step: 'review', resumeData: 'fast' }));

    // 条件只在首段求值一次(挂起前);resume 重进不重估——所选臂由挂起记录钉死
    expect(cond).toHaveBeenCalledTimes(1);
    expect(otherExecute).not.toHaveBeenCalled();
    expect(armExecute).toHaveBeenCalledTimes(2);
    expect(armExecute).toHaveBeenLastCalledWith(expect.objectContaining({ resumeData: 'fast' }));
    expect(outcome.output).toEqual({ done: 'lane:fast' });
  });
});

describe('块内 suspend:foreach 迭代挂起 → 已收集前缀 + 挂起索引,洞重跑', () => {
  /** gate:对指定元素挂起一次(问一句),拿到结论后放行;其余元素直通。 */
  function foreachGate(gateOn: (element: string) => boolean) {
    const seenResume: (unknown | undefined)[] = [];
    const execute = vi.fn((ctx: StepContext<string, string, { question: string }>) => {
      seenResume.push(ctx.resumeData);
      if (gateOn(ctx.inputData) && ctx.resumeData === undefined) {
        ctx.suspend({ question: `ok to use ${ctx.inputData}?` });
      }
      return `done:${ctx.inputData}:${String(ctx.resumeData ?? '-')}`;
    });
    const step = createStep({
      id: 'item',
      inputSchema: z.string(),
      outputSchema: z.string(),
      resumeSchema: z.string(),
      execute,
    });
    return { step, execute, seenResume };
  }

  it('c=1:迭代挂起 → site 带已收集前缀与挂起索引;resume 前缀回放、挂起迭代收 resumeData、后续迭代照跑', async () => {
    const gate = foreachGate((element) => element === 'b');
    const { store, saves } = recordingStore();
    const workflow = createWorkflow({
      id: 'batch',
      inputSchema: z.array(z.string()),
      outputSchema: z.array(z.string()),
      storage: store,
    })
      .foreach(gate.step)
      .commit();
    const run = workflow.createRun({ runId: 'foreach-gate' });
    const suspended = expectSuspended(await run.start({ inputData: ['a', 'b', 'c'] }).result);

    // 挂起:块记录落 suspended(块聚合,payload = 挂起迭代的);site 带前缀与索引
    expect(suspended.stepId).toBe('item');
    expect(suspended.stepResults['item']).toMatchObject({
      status: 'suspended',
      suspendPayload: { question: 'ok to use b?' },
    });
    expect(saves.at(-1)).toMatchObject({
      status: 'suspended',
      position: 0,
      iterationSite: {
        kind: 'foreach',
        suspendedIndex: 1,
        collected: { '0': 'done:a:-' },
      },
    });

    const outcome = expectSuccess(await run.resume({ step: 'item', resumeData: 'yes' }));

    // 前缀 a 不重跑(回放);挂起迭代 b 收 resumeData;后续 c 照跑(无 resumeData);保序数组
    expect(outcome.output).toEqual(['done:a:-', 'done:b:yes', 'done:c:-']);
    expect(gate.seenResume).toEqual([undefined, undefined, 'yes', undefined]);
    expect(saves.at(-1)).toMatchObject({
      status: 'success',
      position: 1,
      stepResults: { item: { status: 'success' } },
    });
  });

  it('c>1:挂起后闸门停拉新索引,在飞迭代落定后进 site;resume 洞重跑、挂起索引收 resumeData', async () => {
    let release!: (value: void) => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: number[] = [];
    const seenResume: (unknown | undefined)[] = [];
    const step = createStep({
      id: 'item',
      inputSchema: z.number(),
      outputSchema: z.string(),
      resumeSchema: z.string(),
      execute: async (ctx: StepContext<number, string, { question: string }>) => {
        calls.push(ctx.inputData);
        seenResume.push(ctx.resumeData);
        if (ctx.inputData === 2 && ctx.resumeData === undefined) {
          ctx.suspend({ question: 'ok to use 2?' });
        }
        if (ctx.inputData === 1) {
          // 元素 1 真正驻留在飞:挂起落在它身上时,它的输出只能靠“等落定”进 site
          await inFlight;
        }
        return `done:${ctx.inputData}:${String(ctx.resumeData ?? '-')}`;
      },
    });
    const workflow = createWorkflow({
      id: 'fanout',
      inputSchema: z.array(z.number()),
      outputSchema: z.array(z.string()),
    })
      .foreach(step, { concurrency: 2 })
      .commit();
    const run = workflow.createRun();
    const started = run.start({ inputData: [1, 2, 3, 4] });
    const settled = started.result;
    // 让闸门拉起 0、1(0 在飞、1 挂起),3、4 不再拉;挂起快照等 0 落定
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const suspended = expectSuspended(await settled);

    // 在飞落定后的现场:挂起索引 1,已收集只有前一个索引;3、4 从未起跑
    expect(suspended.stepResults['item']).toMatchObject({ status: 'suspended' });
    expect(calls).toEqual([1, 2]);

    const outcome = expectSuccess(await run.resume({ step: 'item', resumeData: 'yes' }));

    // 保序输出;resumeData 只落在挂起迭代(索引 1),洞与后续迭代拿 undefined
    expect(outcome.output).toEqual([
      'done:1:-',
      'done:2:yes',
      'done:3:-',
      'done:4:-',
    ]);
    expect(seenResume.slice(0, 2)).toEqual([undefined, undefined]);
    expect(seenResume[2]).toBe('yes');
    expect(seenResume.slice(3)).toEqual([undefined, undefined]);
  });
});

describe('块内 suspend:循环体内挂起 → iterationCount + 现值重进', () => {
  it('dountil:体内挂起 → site 带已完成迭代数与挂起迭代输入;resume 重进收 resumeData,条件计数连续', async () => {
    const condCalls: number[] = [];
    const cond = vi.fn((ctx: { iterationCount: number }) => {
      condCalls.push(ctx.iterationCount);
      return ctx.iterationCount >= 3;
    });
    const execute = vi.fn(
      (ctx: StepContext<number, number, { question: string }>) => {
        if (ctx.inputData === 2 && ctx.resumeData === undefined) {
          ctx.suspend({ question: `enough at ${ctx.inputData}?` });
        }
        return ctx.resumeData !== undefined ? ctx.resumeData : ctx.inputData + 1;
      },
    );
    const body = createStep({
      id: 'grow',
      inputSchema: z.number(),
      outputSchema: z.number(),
      resumeSchema: z.number(),
      execute,
    });
    const { store, saves } = recordingStore();
    const workflow = createWorkflow({
      id: 'until-grow',
      inputSchema: z.number(),
      outputSchema: z.number(),
      storage: store,
    })
      .dountil(body, cond)
      .commit();
    const run = workflow.createRun({ runId: 'loop-gate' });
    const suspended = expectSuspended(await run.start({ inputData: 1 }).result);

    // 第 1 次迭代完成(1→2),第 2 次体内挂起:site 记已完成迭代数与挂起迭代的输入
    expect(suspended.stepResults['grow']).toMatchObject({
      status: 'suspended',
      suspendPayload: { question: 'enough at 2?' },
    });
    expect(saves.at(-1)).toMatchObject({
      status: 'suspended',
      position: 0,
      iterationSite: { kind: 'loop', iterationCount: 1, value: 2 },
    });

    const outcome = expectSuccess(await run.resume({ step: 'grow', resumeData: 5 }));

    // 挂起迭代重进:input 2 + resumeData 5 → 输出 5;再一迭代 5→6 后条件退出;计数连续
    expect(outcome.output).toBe(6);
    expect(condCalls).toEqual([1, 2, 3]);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(saves.at(-1)).toMatchObject({
      status: 'success',
      position: 1,
      stepResults: { grow: { status: 'success', output: 6 } },
    });
  });

  it('dowhile:挂起迭代已获准进入,resume 跳过首次前置检查;后续迭代照常检查', async () => {
    const condCalls: number[] = [];
    const execute = vi.fn(
      (ctx: StepContext<number, number, { question: string }>) => {
        if (execute.mock.calls.length === 1) ctx.suspend({ question: 'go on?' });
        return ctx.resumeData !== undefined ? ctx.resumeData : ctx.inputData;
      },
    );
    const body = createStep({
      id: 'body',
      inputSchema: z.number(),
      outputSchema: z.number(),
      resumeSchema: z.number(),
      execute,
    });
    const workflow = createWorkflow({
      id: 'while-gate',
      inputSchema: z.number(),
      outputSchema: z.number(),
    })
      .dowhile(body, (ctx) => {
        condCalls.push(ctx.iterationCount);
        return ctx.iterationCount < 2;
      })
      .commit();
    const run = workflow.createRun();
    const suspended = expectSuspended(await run.start({ inputData: 1 }).result);

    // 首段:前置检查通过(0 < 2)后体内挂起——该迭代已获准进入
    expect(suspended.stepId).toBe('body');
    expect(condCalls).toEqual([0]);

    const outcome = expectSuccess(await run.resume({ step: 'body', resumeData: 7 }));

    // resume 重进:不重估首次前置条件(仍只 1 次);挂起迭代完成(count=1)后下一次前置检查照常(1 < 2 过),
    // 第二次迭代(resumeData 缺席 → 再挂起……不:resumeData 缺席时返回 inputData 7)→ count=2 → 检查退出
    expect(outcome.output).toBe(7);
    expect(condCalls).toEqual([0, 1, 2]);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('循环块挂起时记录 suspended,完成时替换为终值;再挂起可二次 resume', async () => {
    const execute = vi.fn(
      (ctx: StepContext<number, string, { round: number }>) => {
        const round = execute.mock.calls.length;
        if (round <= 2) ctx.suspend({ round });
        return 100 + round;
      },
    );
    const body = createStep({
      id: 'body',
      inputSchema: z.number(),
      outputSchema: z.number(),
      resumeSchema: z.string(),
      execute,
    });
    const { store, saves } = recordingStore();
    const workflow = createWorkflow({
      id: 'rounds',
      inputSchema: z.number(),
      outputSchema: z.number(),
      storage: store,
    })
      .dountil(body, (ctx) => ctx.iterationCount >= 3)
      .commit();
    const run = workflow.createRun({ runId: 'rounds-run' });

    const first = expectSuspended(await run.start({ inputData: 0 }).result);
    expect(first.stepResults['body']?.suspendPayload).toEqual({ round: 1 });
    expect(saves.at(-1)?.iterationSite).toMatchObject({ kind: 'loop', iterationCount: 0, value: 0 });

    const second = expectSuspended(await run.resume({ step: 'body', resumeData: 'again' }));
    expect(second.stepResults['body']?.suspendPayload).toEqual({ round: 2 });
    expect(saves.at(-1)?.iterationSite).toMatchObject({ kind: 'loop', iterationCount: 0, value: 0 });

    // 第三次执行不挂起(103),后续迭代直近条件闸(计数连续),终值 = 最后一次迭代输出
    const outcome = expectSuccess(await run.resume({ step: 'body', resumeData: 'final' }));
    expect(execute).toHaveBeenCalledTimes(5);
    expect(outcome.output).toBe(105);
    expect(saves.at(-1)).toMatchObject({ status: 'success' });
    expect('iterationSite' in (saves.at(-1) ?? {})).toBe(false);
  });
});

describe('块内 resume 的目标校验:site 与定义不匹配 → 显式报错', () => {
  function forgedStore(snapshot: Record<string, unknown>): WorkflowSnapshotStore {
    return {
      load: async () => snapshot as unknown as WorkflowRunSnapshot,
      save: async () => {},
    };
  }

  it('site 的 kind 与 position 处的条目类型不一致 → 显式报错(快照不被消费)', async () => {
    const ok = createStep({
      id: 'ok',
      inputSchema: z.string(),
      outputSchema: z.string(),
      execute: () => 'ok',
    });
    const workflow = createWorkflow({
      id: 'mismatch',
      inputSchema: z.string(),
      outputSchema: z.string(),
      storage: forgedStore({
        runId: 'forged',
        status: 'suspended',
        input: 'x',
        stepResults: { ok: { status: 'suspended', suspendPayload: {} } },
        position: 0,
        iterationSite: { kind: 'foreach', suspendedIndex: 0, collected: {} },
      }),
    })
      .parallel([ok])
      .commit();

    const error = await captureRejection(() =>
      workflow.createRun({ runId: 'forged' }).resume({ step: 'ok' }),
    );

    expect(error.message).toMatch(/foreach/);
    expect(error.message).toMatch(/parallel/);
    expect(error.message).toMatch(/do not match/);
  });

  it('命名的 step 不在 site 指向的块内 → 显式报错', async () => {
    const item = createStep({
      id: 'item',
      inputSchema: z.string(),
      outputSchema: z.string(),
      execute: () => 'x',
    });
    const workflow = createWorkflow({
      id: 'outside',
      inputSchema: z.array(z.string()),
      outputSchema: z.array(z.string()),
      storage: forgedStore({
        runId: 'forged-2',
        status: 'suspended',
        input: ['x'],
        stepResults: { stranger: { status: 'suspended', suspendPayload: {} } },
        position: 0,
        iterationSite: { kind: 'foreach', suspendedIndex: 0, collected: {} },
      }),
    })
      .foreach(item)
      .commit();

    const error = await captureRejection(() =>
      workflow.createRun({ runId: 'forged-2' }).resume({ step: 'stranger' }),
    );

    expect(error.message).toMatch(/stranger/);
    expect(error.message).toMatch(/foreach/);
    expect(error.message).toMatch(/not a step of/);
  });

  it('旧形状快照(无 site):position 处不是挂起 step 的顶层 then 条目 → 显式报错', async () => {
    const item = createStep({
      id: 'item',
      inputSchema: z.string(),
      outputSchema: z.string(),
      execute: () => 'x',
    });
    const workflow = createWorkflow({
      id: 'legacy',
      inputSchema: z.array(z.string()),
      outputSchema: z.array(z.string()),
      storage: forgedStore({
        runId: 'forged-3',
        status: 'suspended',
        input: ['x'],
        stepResults: { item: { status: 'suspended', suspendPayload: {} } },
        position: 0,
      }),
    })
      .foreach(item)
      .commit();

    const error = await captureRejection(() =>
      workflow.createRun({ runId: 'forged-3' }).resume({ step: 'item' }),
    );

    expect(error.message).toMatch(/iteration site/);
    expect(error.message).toMatch(/then/);
  });
});

describe('块内 suspend:parallel 臂挂起 → 迭代现场快照 + resume 重进', () => {
  /** gate:resumeData 缺席即挂起(问一句),拿到结论后放行。 */
  function gateStep<TId extends string>(id: TId, opts: { readonly resumeSchema?: z.ZodType } = {}) {
    const execute = vi.fn(
      (ctx: StepContext<string, string, { question: string }>) => {
        if (ctx.resumeData === undefined) ctx.suspend({ question: `${id}?` });
        return `${id}:${ctx.resumeData}`;
      },
    );
    const step = createStep({
      id,
      inputSchema: z.string(),
      outputSchema: z.string(),
      ...(opts.resumeSchema === undefined ? {} : { resumeSchema: opts.resumeSchema }),
      execute,
    });
    return { step, execute };
  }

  it('臂挂起:run 落 suspended,挂起臂记录 suspended + payload,完成臂保留 success;快照带 iterationSite', async () => {
    const okExecute = vi.fn((ctx: StepContext<string>) => `ok:${ctx.inputData}`);
    const ok = createStep({
      id: 'ok',
      inputSchema: z.string(),
      outputSchema: z.string(),
      execute: okExecute,
    });
    const gate = gateStep('needs-human', { resumeSchema: z.string() });
    const { store, saves } = recordingStore();
    const workflow = createWorkflow({
      id: 'fanout',
      inputSchema: z.string(),
      outputSchema: z.string(),
      storage: store,
    })
      .parallel([ok, gate.step])
      .commit();

    const outcome = expectSuspended(
      await workflow.createRun({ runId: 'parallel-gate' }).start({ inputData: 'x' }).result,
    );

    // 挂起目标 = 挂起臂;各臂记录各落(完成臂 success、挂起臂 suspended + payload)
    expect(outcome.stepId).toBe('needs-human');
    expect(outcome.stepResults['ok']).toMatchObject({ status: 'success', output: 'ok:x' });
    expect(outcome.stepResults['needs-human']).toMatchObject({
      status: 'suspended',
      suspendPayload: { question: 'needs-human?' },
    });
    // 快照:position = 块条目下标,iterationSite = { kind: 'parallel' }(记录即现场,无额外数据)
    expect(saves.at(-1)).toMatchObject({
      runId: 'parallel-gate',
      status: 'suspended',
      position: 0,
      iterationSite: { kind: 'parallel' },
    });
  });

  it('resume:完成臂按记录回放不重跑,挂起臂收 resumeData,后续条目继续,keyed 输出按定义序', async () => {
    const okExecute = vi.fn((ctx: StepContext<string>) => `ok:${ctx.inputData}`);
    const ok = createStep({
      id: 'ok',
      inputSchema: z.string(),
      outputSchema: z.string(),
      execute: okExecute,
    });
    const gate = gateStep('needs-human', { resumeSchema: z.string() });
    const afterExecute = vi.fn((ctx: StepContext<{ ok: string; 'needs-human': string }>) => ({
      done: `${ctx.inputData.ok}+${ctx.inputData['needs-human']}`,
    }));
    const after = createStep({
      id: 'after',
      inputSchema: z.object({ ok: z.string(), 'needs-human': z.string() }),
      outputSchema: z.object({ done: z.string() }),
      execute: afterExecute,
    });
    const { store, saves } = recordingStore();
    const workflow = createWorkflow({
      id: 'fanout',
      inputSchema: z.string(),
      outputSchema: z.object({ done: z.string() }),
      storage: store,
    })
      .parallel([ok, gate.step])
      .then(after)
      .commit();
    const run = workflow.createRun({ runId: 'parallel-resume' });
    await run.start({ inputData: 'x' }).result;

    const outcome = expectSuccess(
      await run.resume({ step: 'needs-human', resumeData: 'yes' }),
    );

    // 完成臂只执行一次(记录回放);挂起臂两次(挂起 + 恢复);后续条目恢复后继续
    expect(okExecute).toHaveBeenCalledTimes(1);
    expect(gate.execute).toHaveBeenCalledTimes(2);
    expect(gate.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ resumeData: 'yes' }),
    );
    expect(outcome.output).toEqual({ done: 'ok:x+needs-human:yes' });
    // 恢复后的 keyed 输出按定义序,块完成后快照走正常 running(position = 下一条目,无 site)
    expect(saves.at(-1)).toMatchObject({
      status: 'success',
      position: 2,
      stepResults: {
        ok: { status: 'success', output: 'ok:x' },
        'needs-human': { status: 'success', output: 'needs-human:yes' },
        after: { status: 'success' },
      },
    });
    expect('iterationSite' in (saves.at(-1) ?? {})).toBe(false);
  });

  it('多臂同时挂起:各落 suspended 记录;resume 命名谁谁收 resumeData,其余臂重跑(无 resumeData)再收敛', async () => {
    const first = gateStep('gate-a', { resumeSchema: z.string() });
    const second = gateStep('gate-b', { resumeSchema: z.string() });
    const workflow = createWorkflow({
      id: 'two-gates',
      inputSchema: z.string(),
      outputSchema: z.object({ 'gate-a': z.string(), 'gate-b': z.string() }),
    })
      .parallel([first.step, second.step])
      .commit();
    const run = workflow.createRun();
    const suspended = expectSuspended(await run.start({ inputData: 'x' }).result);

    // 两个臂都挂起:信封点名先落定的臂,两条 suspended 记录都在(各自真相)
    expect(suspended.stepId).toBe('gate-a');
    expect(suspended.stepResults['gate-a']?.status).toBe('suspended');
    expect(suspended.stepResults['gate-b']?.status).toBe('suspended');

    // resume 命名 gate-b:它收 resumeData;gate-a 无 success 记录 → 重跑(无 resumeData)→ 再挂起
    const again = expectSuspended(await run.resume({ step: 'gate-b', resumeData: 'go' }));
    expect(again.stepId).toBe('gate-a');
    expect(second.execute).toHaveBeenLastCalledWith(expect.objectContaining({ resumeData: 'go' }));
    expect(first.execute).toHaveBeenLastCalledWith(
      expect.objectContaining({ resumeData: undefined }),
    );

    const outcome = expectSuccess(await run.resume({ step: 'gate-a', resumeData: 'fine' }));
    expect(outcome.output).toEqual({ 'gate-a': 'gate-a:fine', 'gate-b': 'gate-b:go' });
  });

  it('挂起优先于兄弟失败:失败臂落 failed 记录,run 仍挂起;resume 时失败臂随重跑规则再跑', async () => {
    const boom = new Error('sibling boom');
    const failingExecute = vi.fn((_ctx: StepContext<string>) => {
      if (failingExecute.mock.calls.length === 1) throw boom;
      return 'recovered';
    });
    const failing = createStep({
      id: 'failing',
      inputSchema: z.string(),
      outputSchema: z.string(),
      execute: failingExecute,
    });
    const gate = gateStep('gate', { resumeSchema: z.string() });
    const workflow = createWorkflow({
      id: 'suspend-vs-fail',
      inputSchema: z.string(),
      outputSchema: z.object({ failing: z.string(), gate: z.string() }),
    })
      .parallel([failing, gate.step])
      .commit();
    const run = workflow.createRun();
    const suspended = expectSuspended(await run.start({ inputData: 'x' }).result);

    // 挂起信号赢了同窗的兄弟失败:run 挂起(失败臂记录 failed,不吞)
    expect(suspended.stepId).toBe('gate');
    expect(suspended.stepResults['failing']?.status).toBe('failed');

    // resume:failed 臂无 success 记录 → 重跑(这里换一次成功);挂起臂收 resumeData
    const outcome = expectSuccess(await run.resume({ step: 'gate', resumeData: 'ok' }));
    expect(outcome.output).toEqual({ failing: 'recovered', gate: 'gate:ok' });
  });

  it('挂起时等在飞臂落定:后完成的臂输出进记录与快照(resume 不重跑它)', async () => {
    let release!: (value: void) => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowExecute = vi.fn(async (ctx: StepContext<string>) => {
      await inFlight;
      return `slow:${ctx.inputData}`;
    });
    const slow = createStep({
      id: 'slow',
      inputSchema: z.string(),
      outputSchema: z.string(),
      execute: slowExecute,
    });
    const gate = gateStep('gate', { resumeSchema: z.string() });
    const { store, saves } = recordingStore();
    const workflow = createWorkflow({
      id: 'settle',
      inputSchema: z.string(),
      outputSchema: z.object({ slow: z.string(), gate: z.string() }),
      storage: store,
    })
      .parallel([slow, gate.step])
      .commit();
    const run = workflow.createRun({ runId: 'settle-run' });
    const settled = run.start({ inputData: 'x' }).result;
    // 让 microtask 走到 gate 挂起、slow 仍在飞:挂起快照必须等 slow 落定才写
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const suspended = expectSuspended(await settled);

    expect(suspended.stepResults['slow']).toMatchObject({ status: 'success', output: 'slow:x' });
    expect(saves.at(-1)?.stepResults['slow']).toMatchObject({ status: 'success' });

    const outcome = expectSuccess(await run.resume({ step: 'gate', resumeData: 'go' }));
    expect(slowExecute).toHaveBeenCalledTimes(1);
    expect(outcome.output).toEqual({ slow: 'slow:x', gate: 'gate:go' });
  });
});

describe('createInMemorySnapshotStore:内存默认实现', () => {
  it('深拷贝:save 后改写原快照不影响 load;load 返回值改写不影响 store;未知 runId 返回 null;同 runId 覆盖', async () => {
    const store = createInMemorySnapshotStore();
    const snapshot = {
      runId: 'r-1',
      status: 'suspended' as const,
      input: { topic: 'ts' },
      stepResults: { approval: { status: 'suspended' as const, suspendPayload: { q: 'q?' } } },
      position: 0,
    };

    await store.save('r-1', snapshot);
    // 写入后改写调用方对象:内存实现像序列化后端一样隔离
    snapshot.stepResults.approval.suspendPayload.q = 'mutated';

    const loaded = await store.load('r-1');
    expect(loaded).toEqual({
      runId: 'r-1',
      status: 'suspended',
      input: { topic: 'ts' },
      stepResults: { approval: { status: 'suspended', suspendPayload: { q: 'q?' } } },
      position: 0,
    });
    // 读出后改写返回值:store 内的快照不受影响(读向同样深拷贝过缝)
    (loaded?.stepResults['approval']?.suspendPayload as { q: string }).q = 'mutated';
    expect((await store.load('r-1'))?.stepResults['approval']?.suspendPayload).toEqual({ q: 'q?' });
    expect(await store.load('r-2')).toBeNull();

    await store.save('r-1', { ...snapshot, status: 'success', position: 1 });
    expect((await store.load('r-1'))?.status).toBe('success');
  });
});

describe('公开面:suspend/resume 的形状与类型(断言在编译期,tsc 阶段生效)', () => {
  it('run 面 = runId / start / resume;resume 选项收 step 对象或 id', () => {
    const { workflow } = approvalWorkflow();
    const run = workflow.createRun();

    expect(Object.keys(run).sort()).toEqual(['resume', 'runId', 'start']);
    expectAssignable<WorkflowResumeOptions>({ step: 'approval' });
    expectAssignable<WorkflowResumeOptions>({ step: 'approval', resumeData: { approved: true } });
    expectAssignable<ReturnType<typeof run.resume>>(
      Promise.resolve({ status: 'suspended' as const, stepId: 'approval', stepResults: {} }),
    );

    const suspendedOutcome: WorkflowRunOutcome = {
      status: 'suspended',
      stepId: 'approval',
      stepResults: {},
    };
    if (suspendedOutcome.status === 'suspended') {
      expectAssignable<string>(suspendedOutcome.stepId);
    }
    const successOutcome: WorkflowRunOutcome<{ polished: string }> = {
      status: 'success',
      output: { polished: 'x' },
      stepResults: {},
    };
    if (successOutcome.status === 'success') {
      expectAssignable<{ polished: string }>(successOutcome.output);
    }
  });
});
