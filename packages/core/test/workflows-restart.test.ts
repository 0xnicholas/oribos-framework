import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { WORKFLOW_RUN_SPAN, createTracer, memoryExporter } from '@oribos/core/observability';
import {
  createInMemorySnapshotStore,
  createStep,
  createWorkflow,
} from '@oribos/core/workflows';
import type {
  StepContext,
  Workflow,
  WorkflowRunSnapshot,
  WorkflowSnapshotStore,
} from '@oribos/core/workflows';
import { captureRejection, expectSuccess } from './helpers/assertions.js';

/**
 * time-travel / restart(#174,`docs/architecture/workflows.md` CUT-W7 行转追赶项):load → 重进
 * 原语的薄变种——`run.restart({ step? })` load 快照、**先截断该位之后的记录**、从该位重进同一个
 * for 循环。records-first 语义不变(B5):截断位之前的条目按记录回放、绝不重执行,条件不重估;
 * 目标位及其后条目重新执行。无 port 变更、不动快照五字段(B7)、不建路径模型(B8:重进粒度 =
 * 扁平条目,点名块内 step 即重进整个块)。
 *
 * 接缝 = 公开 `@oribos/core/workflows` 子路径:定义 → `createRun` → `run.start` / `run.restart`,
 * 以及注入的 store 观察到的快照收敛。
 */

const countInput = z.object({ n: z.number() });
const countValue = z.object({ n: z.number() });

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

/** inc → double → render 三条目链:截断 + 重进叙事的主轴。 */
function chainWorkflow(options: { readonly storage?: WorkflowSnapshotStore } = {}): {
  readonly workflow: Workflow<typeof countInput, typeof countValue>;
  readonly incExecute: ReturnType<typeof vi.fn>;
  readonly doubleExecute: ReturnType<typeof vi.fn>;
  readonly renderExecute: ReturnType<typeof vi.fn>;
  readonly doubleInputs: number[];
} {
  const doubleInputs: number[] = [];
  const incExecute = vi.fn((ctx: StepContext<{ n: number }>) => ({ n: ctx.inputData.n + 1 }));
  const doubleExecute = vi.fn((ctx: StepContext<{ n: number }>) => {
    doubleInputs.push(ctx.inputData.n);
    return { n: ctx.inputData.n * 2 };
  });
  const renderExecute = vi.fn((ctx: StepContext<{ n: number }>) => ({ n: ctx.inputData.n * 100 }));
  const workflow = createWorkflow({
    id: 'chain',
    inputSchema: countInput,
    outputSchema: countValue,
    ...(options.storage === undefined ? {} : { storage: options.storage }),
  })
    .then(createStep({ id: 'inc', inputSchema: countInput, outputSchema: countValue, execute: incExecute }))
    .then(createStep({ id: 'double', inputSchema: countValue, outputSchema: countValue, execute: doubleExecute }))
    .then(createStep({ id: 'render', inputSchema: countValue, outputSchema: countValue, execute: renderExecute }))
    .commit();
  return { workflow, incExecute, doubleExecute, renderExecute, doubleInputs };
}

describe('restart:截断 + 重进', () => {
  it('从 double 重进:inc 按记录回放不重执行,double / render 重跑,记录表截断后重建', async () => {
    const { store, saves } = recordingStore();
    const { workflow, incExecute, doubleExecute, renderExecute, doubleInputs } = chainWorkflow({
      storage: store,
    });
    const run = workflow.createRun({ runId: 'r-1' });

    const first = expectSuccess(await (await run.start({ inputData: { n: 1 } })).result);
    expect(first.output).toEqual({ n: 400 });
    expect(incExecute).toHaveBeenCalledTimes(1);
    expect(doubleExecute).toHaveBeenCalledTimes(1);
    expect(renderExecute).toHaveBeenCalledTimes(1);

    const restarted = expectSuccess(await run.restart({ step: 'double' }));

    // records-first:截断位之前的 inc 绝不重执行(B5);double / render 重新执行。
    expect(incExecute).toHaveBeenCalledTimes(1);
    expect(doubleExecute).toHaveBeenCalledTimes(2);
    expect(renderExecute).toHaveBeenCalledTimes(2);
    // 重进处的 tip 由记录回放重建:double 第二次收到的输入 = inc 的记录输出,不是重算。
    expect(doubleInputs).toEqual([2, 2]);
    expect(restarted.output).toEqual({ n: 400 });

    // 截断的证据(存储日志):首跑 success 快照三条记录齐全;重进 walk 的第一写(running)
    // 只剩 inc + double——render 的旧记录被截掉,待 render 重跑后才重回快照。
    const firstSuccessIndex = saves.findIndex((snapshot) => snapshot.status === 'success');
    const firstWriteAfterRestart = saves[firstSuccessIndex + 1];
    expect(firstWriteAfterRestart?.status).toBe('running');
    expect(Object.keys(firstWriteAfterRestart?.stepResults ?? {}).sort()).toEqual([
      'double',
      'inc',
    ]);
    const terminal = saves.at(-1);
    expect(terminal?.status).toBe('success');
    expect(Object.keys(terminal?.stepResults ?? {}).sort()).toEqual(['double', 'inc', 'render']);
  });

  it('不点名 step = 从头重启:记录全截断,三条目全重跑,起点输入用快照里那份(起点边界不重跑)', async () => {
    const { store, saves } = recordingStore();
    const { workflow, incExecute, doubleExecute, renderExecute } = chainWorkflow({ storage: store });
    const run = workflow.createRun({ runId: 'r-1' });

    expectSuccess(await (await run.start({ inputData: { n: 1 } })).result);

    const restarted = expectSuccess(await run.restart());

    expect(incExecute).toHaveBeenCalledTimes(2);
    expect(doubleExecute).toHaveBeenCalledTimes(2);
    expect(renderExecute).toHaveBeenCalledTimes(2);
    expect(restarted.output).toEqual({ n: 400 });
    // 重进 walk 的第一写(position 1)只剩 inc 一条:快照的记录表被整体截断。
    const firstSuccessIndex = saves.findIndex((snapshot) => snapshot.status === 'success');
    const firstWriteAfterRestart = saves[firstSuccessIndex + 1];
    expect(firstWriteAfterRestart?.status).toBe('running');
    expect(firstWriteAfterRestart?.position).toBe(1);
    expect(Object.keys(firstWriteAfterRestart?.stepResults ?? {})).toEqual(['inc']);
  });

  it('失败的 run 可从失败位重进:修好后 restart 重跑失败步与其后,前序步不重执行', async () => {
    const { store } = recordingStore();
    let broken = true;
    const incExecute = vi.fn((ctx: StepContext<{ n: number }>) => ({ n: ctx.inputData.n + 1 }));
    const doubleExecute = vi.fn((ctx: StepContext<{ n: number }>) => {
      if (broken) throw new Error('double is broken');
      return { n: ctx.inputData.n * 2 };
    });
    const renderExecute = vi.fn((ctx: StepContext<{ n: number }>) => ({ n: ctx.inputData.n * 100 }));
    const workflow = createWorkflow({
      id: 'chain',
      inputSchema: countInput,
      outputSchema: countValue,
      storage: store,
    })
      .then(createStep({ id: 'inc', inputSchema: countInput, outputSchema: countValue, execute: incExecute }))
      .then(createStep({ id: 'double', inputSchema: countValue, outputSchema: countValue, execute: doubleExecute }))
      .then(createStep({ id: 'render', inputSchema: countValue, outputSchema: countValue, execute: renderExecute }))
      .commit();
    const run = workflow.createRun({ runId: 'r-1' });

    const failure = await captureRejection(async () => (await run.start({ inputData: { n: 1 } })).result);
    expect(failure.message).toBe('double is broken');
    expect(renderExecute).not.toHaveBeenCalled();

    broken = false;
    const restarted = expectSuccess(await run.restart({ step: 'double' }));

    expect(restarted.output).toEqual({ n: 400 });
    expect(incExecute).toHaveBeenCalledTimes(1);
    expect(doubleExecute).toHaveBeenCalledTimes(2);
    expect(renderExecute).toHaveBeenCalledTimes(1);
    // 终态快照收敛:失败记录被重跑的成功记录替换。
    expect(restarted.stepResults['double']).toMatchObject({ status: 'success', output: { n: 4 } });
  });

  it('挂起的 run 可 restart 丢弃挂起:目标步全新重跑(无 resumeData、无 resumeSchema 边界)', async () => {
    const { store } = recordingStore();
    let gateOpen = false;
    const seenResumeData: unknown[] = [];
    const gateExecute = vi.fn((ctx: StepContext<{ n: number }, { n: number }>) => {
      seenResumeData.push(ctx.resumeData);
      if (!gateOpen) return ctx.suspend({ reason: 'hold' });
      return { n: ctx.inputData.n * 2 };
    });
    const workflow = createWorkflow({
      id: 'gated',
      inputSchema: countInput,
      outputSchema: countValue,
      storage: store,
    })
      .then(
        createStep({
          id: 'gate',
          inputSchema: countInput,
          outputSchema: countValue,
          resumeSchema: z.object({ n: z.number() }),
          execute: gateExecute,
        }),
      )
      .commit();
    const run = workflow.createRun({ runId: 'r-1' });

    const suspended = await (await run.start({ inputData: { n: 3 } })).result;
    expect(suspended.status).toBe('suspended');

    // 调试者不想要这次挂起(譬如输入已够、不应再问):restart 让 gate 全新重跑,不是回答它。
    gateOpen = true;
    const restarted = expectSuccess(await run.restart({ step: 'gate' }));

    expect(restarted.output).toEqual({ n: 6 });
    expect(gateExecute).toHaveBeenCalledTimes(2);
    // 两次执行收到的都是 undefined:restart 不携带 resumeData,与 resume 的回答语义分开。
    expect(seenResumeData).toEqual([undefined, undefined]);
    expect(restarted.stepResults['gate']).toMatchObject({ status: 'success', output: { n: 6 } });
  });

  it('点名块内 step = 重进整个块(B8 无路径模型:重进粒度 = 扁平条目)', async () => {
    const { store } = recordingStore();
    const leftExecute = vi.fn((ctx: StepContext<{ n: number }>) => ({ n: ctx.inputData.n + 10 }));
    const rightExecute = vi.fn((ctx: StepContext<{ n: number }>) => ({ n: ctx.inputData.n + 20 }));
    const left = createStep({ id: 'left', inputSchema: countValue, outputSchema: countValue, execute: leftExecute });
    const right = createStep({ id: 'right', inputSchema: countValue, outputSchema: countValue, execute: rightExecute });
    const finishExecute = vi.fn(
      (ctx: StepContext<{ left: { n: number }; right: { n: number } }>) => ({
        n: ctx.inputData.left.n + ctx.inputData.right.n,
      }),
    );
    const workflow = createWorkflow({
      id: 'fanned',
      inputSchema: countInput,
      outputSchema: countValue,
      storage: store,
    })
      .then(createStep({ id: 'seed', inputSchema: countInput, outputSchema: countValue, execute: (ctx) => ({ n: ctx.inputData.n }) }))
      .parallel([left, right])
      .then(
        createStep({
          id: 'finish',
          inputSchema: z.object({ left: countValue, right: countValue }),
          outputSchema: countValue,
          execute: finishExecute,
        }),
      )
      .commit();
    const run = workflow.createRun({ runId: 'r-1' });

    const first = expectSuccess(await (await run.start({ inputData: { n: 1 } })).result);
    expect(first.output).toEqual({ n: 32 });

    const restarted = expectSuccess(await run.restart({ step: 'right' }));

    // 整条 parallel 块重跑:只想要 right 重来也会带上 left——条目是最小重进粒度。
    expect(leftExecute).toHaveBeenCalledTimes(2);
    expect(rightExecute).toHaveBeenCalledTimes(2);
    expect(finishExecute).toHaveBeenCalledTimes(2);
    expect(restarted.output).toEqual({ n: 32 });
  });

  it('截断位之前的 branch 条件不重估(B5 records-first:条件的回答属于问它的那一遍)', async () => {
    const { store } = recordingStore();
    const condEvals: number[] = [];
    const lowExecute = vi.fn((ctx: StepContext<{ n: number }>) => ({ n: ctx.inputData.n + 1 }));
    const highExecute = vi.fn((ctx: StepContext<{ n: number }>) => ({ n: ctx.inputData.n + 100 }));
    const tail = createStep({
      id: 'tail',
      inputSchema: z.object({ low: countValue.optional(), high: countValue.optional() }),
      outputSchema: countValue,
      execute: (ctx) => ({ n: (ctx.inputData.low?.n ?? ctx.inputData.high?.n ?? 0) * 10 }),
    });
    const workflow = createWorkflow({
      id: 'branched',
      inputSchema: countInput,
      outputSchema: countValue,
      storage: store,
    })
      .branch([
        [
          (ctx) => {
            condEvals.push(ctx.inputData.n);
            return ctx.inputData.n < 50;
          },
          createStep({ id: 'low', inputSchema: countInput, outputSchema: countValue, execute: lowExecute }),
        ],
        [
          () => true,
          createStep({ id: 'high', inputSchema: countInput, outputSchema: countValue, execute: highExecute }),
        ],
      ])
      .then(tail)
      .commit();
    const run = workflow.createRun({ runId: 'r-1' });

    const first = expectSuccess(await (await run.start({ inputData: { n: 1 } })).result);
    expect(first.output).toEqual({ n: 20 });
    expect(condEvals).toEqual([1]);

    const restarted = expectSuccess(await run.restart({ step: 'tail' }));

    // 条件仍只被评估过一次:branch 的选择按记录回放(low 有记录),不重问。
    expect(condEvals).toEqual([1]);
    expect(lowExecute).toHaveBeenCalledTimes(1);
    expect(highExecute).not.toHaveBeenCalled();
    expect(restarted.output).toEqual({ n: 20 });
  });
});

describe('restart:错误面', () => {
  it('点名的 step 不在定义里:报错指名,不碰快照', async () => {
    const { store, saves } = recordingStore();
    const { workflow } = chainWorkflow({ storage: store });
    const run = workflow.createRun({ runId: 'r-1' });
    expectSuccess(await (await run.start({ inputData: { n: 1 } })).result);
    const savesBefore = saves.length;

    const error = await captureRejection(() => run.restart({ step: 'nope' }));
    expect(error.message).toContain('step "nope"');
    expect(error.message).toContain('workflow "chain"');
    expect(saves.length).toBe(savesBefore);
  });

  it('无快照:报错说明 restart 需要一份已执行的快照', async () => {
    const { store } = recordingStore();
    const { workflow } = chainWorkflow({ storage: store });
    const run = workflow.createRun({ runId: 'never-ran' });

    const error = await captureRejection(() => run.restart());
    expect(error.message).toContain('run "never-ran" has no snapshot');
    expect(error.message).toContain('restart()');
  });

  it('目标位超出记录覆盖:回放显式报错,不静默重放', async () => {
    // 挂起在 gate 的 run:gate 无 success 记录。restart 越过它点名下游 step 时,
    // 回放必须经过 gate 的记录——缺席即显式失败,不悄悄当作跑过。
    const { store } = recordingStore();
    const workflow = createWorkflow({
      id: 'gated-chain',
      inputSchema: countInput,
      outputSchema: countValue,
      storage: store,
    })
      .then(
        createStep({
          id: 'gate',
          inputSchema: countInput,
          outputSchema: countValue,
          execute: (ctx) => ctx.suspend({ reason: 'hold' }),
        }),
      )
      .then(createStep({ id: 'after', inputSchema: countValue, outputSchema: countValue, execute: (ctx) => ctx.inputData }))
      .commit();
    const run = workflow.createRun({ runId: 'r-1' });
    const suspended = await (await run.start({ inputData: { n: 1 } })).result;
    expect(suspended.status).toBe('suspended');

    const error = await captureRejection(() => run.restart({ step: 'after' }));
    expect(error.message).toContain('no completed record for step "gate"');
  });
});

describe('restart:与 resume 同规的运转语义', () => {
  it('restart 并发去重:同一 (store, runId) 的并发 restart join 同一次重进,目标步只重跑一遍', async () => {
    const { store } = recordingStore();
    const { workflow, doubleExecute } = chainWorkflow({ storage: store });
    const run = workflow.createRun({ runId: 'dedupe-restart' });
    expectSuccess(await (await run.start({ inputData: { n: 1 } })).result);

    const first = run.restart({ step: 'double' });
    const second = run.restart({ step: 'double' });

    expect(second).toBe(first);
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    expect(firstOutcome.status).toBe('success');
    expect(secondOutcome.status).toBe('success');
    expect(doubleExecute).toHaveBeenCalledTimes(2);
  });

  it('不挂 storage 也能 restart:终态快照落在 run 自带的内存默认实现里(不配置即零成本)', async () => {
    const { workflow, incExecute, doubleExecute } = chainWorkflow();
    const run = workflow.createRun({ runId: 'in-memory' });

    expectSuccess(await (await run.start({ inputData: { n: 1 } })).result);
    const restarted = expectSuccess(await run.restart({ step: 'double' }));

    expect(restarted.output).toEqual({ n: 400 });
    expect(incExecute).toHaveBeenCalledTimes(1);
    expect(doubleExecute).toHaveBeenCalledTimes(2);
  });

  it('durable 路径:新 run 对象跨同一 (store, runId) restart——跨进程调试的形状', async () => {
    const { store } = recordingStore();
    const { workflow, incExecute, doubleExecute, renderExecute } = chainWorkflow({ storage: store });
    const first = workflow.createRun({ runId: 'durable-r' });
    expectSuccess(await (await first.start({ inputData: { n: 1 } })).result);

    // 新进程的样子:同一个 workflow 定义、同一个 store、同一个 runId,新 run 对象。
    const fresh = workflow.createRun({ runId: 'durable-r' });
    const restarted = expectSuccess(await fresh.restart({ step: 'double' }));

    expect(restarted.output).toEqual({ n: 400 });
    expect(incExecute).toHaveBeenCalledTimes(1);
    expect(doubleExecute).toHaveBeenCalledTimes(2);
    expect(renderExecute).toHaveBeenCalledTimes(2);
  });

  it('块内挂起的 run restart 该块:迭代现场被丢弃,块从零重跑', async () => {
    const { store } = recordingStore();
    let open = false;
    const itemExecute = vi.fn((ctx: StepContext<number>) => {
      if (!open && ctx.inputData > 1) return ctx.suspend({ item: ctx.inputData });
      return ctx.inputData * 10;
    });
    const workflow = createWorkflow({
      id: 'batch',
      inputSchema: z.array(z.number()),
      outputSchema: z.array(z.number()),
      storage: store,
    })
      .foreach(createStep({ id: 'item', inputSchema: z.number(), outputSchema: z.number(), execute: itemExecute }))
      .commit();
    const run = workflow.createRun({ runId: 'r-block' });

    const suspended = await (await run.start({ inputData: [1, 2, 3] })).result;
    expect(suspended.status).toBe('suspended');
    const suspendedCount = itemExecute.mock.calls.length;

    open = true;
    const restarted = expectSuccess(await run.restart({ step: 'item' }));

    // 块从零重跑:已完成的第 1 个迭代也重新执行(不沿 iterationSite 的 collected)。
    expect(restarted.output).toEqual([10, 20, 30]);
    expect(itemExecute.mock.calls.length).toBe(suspendedCount + 3);
  });

  it('restart 段续同一 trace:快照钉的 traceId 传给重进段的新 run span(与 resume 同规)', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const store = createInMemorySnapshotStore();
    const workflow = createWorkflow({
      id: 'chain',
      inputSchema: countInput,
      outputSchema: countValue,
      tracer,
      storage: store,
    })
      .then(createStep({ id: 'inc', inputSchema: countInput, outputSchema: countValue, execute: (ctx) => ({ n: ctx.inputData.n + 1 }) }))
      .then(createStep({ id: 'double', inputSchema: countValue, outputSchema: countValue, execute: (ctx) => ({ n: ctx.inputData.n * 2 }) }))
      .commit();
    const run = workflow.createRun({ runId: 'r-trace' });
    expectSuccess(await (await run.start({ inputData: { n: 1 } })).result);

    const snapshot = await store.load('r-trace');
    expect(snapshot?.traceId).toMatch(/^[0-9a-f]{32}$/);

    await run.restart({ step: 'double' });

    const runSpans = memory.spans().filter((span) => span.type === WORKFLOW_RUN_SPAN);
    expect(runSpans).toHaveLength(2);
    expect(runSpans[1]?.traceId).toBe(snapshot?.traceId);
    expect(runSpans[1]?.parentSpanId).toBeUndefined();
  });
});
