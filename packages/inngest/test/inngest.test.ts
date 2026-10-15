import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Inngest } from 'inngest';
import { createInMemorySnapshotStore, createStep, createWorkflow } from '@oribos/core/workflows';
import type { StepContext, Workflow, WorkflowSnapshotStore } from '@oribos/core/workflows';
import { createInngestRunner } from '@oribos/inngest';

/**
 * `@oribos/inngest`(触发级外包,#195,表面冻结 #188):
 *
 * 接缝全部走公开面——包装器 `createInngestRunner({ client, store })` 的四件表面
 * (`functions` / `start` / `resume` / `recover`)+ 调用方自己的快照 store(端口调用序列 =
 * 状态真相落在哪、何时落)。单测用内存假事件总线离线跑通全链:触发 → 悬挂 → resume 重发 →
 * 崩溃重试 → 快照续起。walker 与快照 store 原样在进程内,核心零改动。
 *
 * 崩溃 = 同一触发事件被引擎重试重投:第一次调用把 run 留在 `running` 快照上不再返回(进程死了),
 * 第二次调用读到 `running` 快照、从快照 position 续起(在途条目重执行,已完成条目按记录回放)。
 */

/** 事件总线的记录面:start / resume 各发了什么触发事件。 */
interface SentEvent {
  readonly id?: string;
  readonly name: string;
  readonly data: unknown;
}

/** 假事件总线 + 假 client:createFunction 只登记(id / 触发事件 / 可直接调用的 handler)。 */
function fakeBus(): {
  readonly client: Inngest;
  readonly sent: SentEvent[];
  readonly registrations: readonly { readonly id: string; readonly trigger: string }[];
  readonly functions: readonly { readonly id: string; readonly trigger: string; readonly invoke: (data: unknown) => Promise<unknown> }[];
} {
  const sent: SentEvent[] = [];
  const registrations: { id: string; trigger: string }[] = [];
  const functions: { id: string; trigger: string; invoke: (data: unknown) => Promise<unknown> }[] = [];
  const client = {
    // 真 SDK 的 isInngest 品牌检查(Symbol.toStringTag):假 client 照真件带牌。
    [Symbol.toStringTag]: 'Inngest.App',
    send: async (event: SentEvent) => {
      sent.push(event);
      return { ids: [event.id ?? 'evt-test'] };
    },
    createFunction: (
      config: { id: string; triggers?: readonly { event: string }[] },
      handler: (ctx: { event: { name: string; data: unknown } }) => Promise<unknown>,
    ) => {
      const trigger = config.triggers?.[0]?.event ?? '';
      registrations.push({ id: config.id, trigger });
      functions.push({
        id: config.id,
        trigger,
        invoke: (data) => handler({ event: { name: trigger, data } }),
      });
      return {};
    },
  } as unknown as Inngest;
  return { client, sent, registrations, functions };
}

/** 带 save 记录的内存快照 store:断言状态真相的落点与时机。 */
function recordingStore(): {
  readonly store: WorkflowSnapshotStore;
  readonly inner: WorkflowSnapshotStore;
  readonly saves: () => readonly string[];
} {
  const inner = createInMemorySnapshotStore();
  const saves: string[] = [];
  const store: WorkflowSnapshotStore = {
    load: (runId) => inner.load(runId),
    save: async (runId, snapshot) => {
      saves.push(`${runId}:${snapshot.status}`);
      await inner.save(runId, snapshot);
    },
  };
  return { store, inner, saves: () => saves };
}

/** 两步直线链(无悬挂):draft → polish,执行序列可断言。 */
function twoStepChain(storage: WorkflowSnapshotStore): {
  readonly workflow: Workflow<z.ZodType<{ topic: string }>, z.ZodType<{ polished: string }>>;
  readonly executed: string[];
} {
  const executed: string[] = [];
  const draft = createStep({
    id: 'draft',
    inputSchema: z.object({ topic: z.string() }),
    outputSchema: z.object({ draft: z.string() }),
    execute: (ctx: StepContext<{ topic: string }>) => {
      executed.push('draft');
      return { draft: ctx.inputData.topic.toUpperCase() };
    },
  });
  const polish = createStep({
    id: 'polish',
    inputSchema: z.object({ draft: z.string() }),
    outputSchema: z.object({ polished: z.string() }),
    execute: (ctx: StepContext<{ draft: string }>) => {
      executed.push('polish');
      return { polished: ctx.inputData.draft.replaceAll(' ', '-') };
    },
  });
  const workflow = createWorkflow({
    id: 'publish',
    inputSchema: z.object({ topic: z.string() }),
    outputSchema: z.object({ polished: z.string() }),
    storage,
  })
    .then(draft)
    .then(polish)
    .commit();
  return { workflow, executed };
}

/** draft → approve(悬挂) → polish 三条目链:主轴的悬挂/恢复叙事。 */
function approvalChain(storage: WorkflowSnapshotStore): {
  readonly workflow: Workflow<z.ZodType<{ topic: string }>, z.ZodType<{ polished: string }>>;
  readonly executed: string[];
} {
  const executed: string[] = [];
  const draft = createStep({
    id: 'draft',
    inputSchema: z.object({ topic: z.string() }),
    outputSchema: z.object({ draft: z.string() }),
    execute: (ctx: StepContext<{ topic: string }>) => {
      executed.push('draft');
      return { draft: ctx.inputData.topic.toUpperCase() };
    },
  });
  const approve = createStep({
    id: 'approve',
    inputSchema: z.object({ draft: z.string() }),
    outputSchema: z.object({ approved: z.boolean() }),
    resumeSchema: z.object({ approved: z.boolean() }),
    execute: (ctx: StepContext<{ draft: string }, { approved: boolean }>) => {
      if (ctx.resumeData !== undefined) {
        executed.push('approve:resumed');
        return { approved: ctx.resumeData.approved };
      }
      executed.push('approve:suspend');
      ctx.suspend({ reason: 'needs approval' });
    },
  });
  const polish = createStep({
    id: 'polish',
    inputSchema: z.object({ approved: z.boolean() }),
    outputSchema: z.object({ polished: z.string() }),
    execute: (ctx: StepContext<{ approved: boolean }>) => {
      executed.push('polish');
      return { polished: ctx.inputData.approved ? 'polished' : 'dropped' };
    },
  });
  const workflow = createWorkflow({
    id: 'approval',
    inputSchema: z.object({ topic: z.string() }),
    outputSchema: z.object({ polished: z.string() }),
    storage,
  })
    .then(draft)
    .then(approve)
    .then(polish)
    .commit();
  return { workflow, executed };
}

describe('createInngestRunner:表面', () => {
  it('工厂返回四件表面:两个 Inngest 函数 + start / resume / recover', () => {
    const bus = fakeBus();
    const store = createInMemorySnapshotStore();
    const runner = createInngestRunner({ client: bus.client, store });

    expect(typeof runner.start).toBe('function');
    expect(typeof runner.resume).toBe('function');
    expect(typeof runner.recover).toBe('function');
    // functions = client.createFunction 的产物,原样交给 serve():两个函数分别是 start / resume
    // 触发事件的 handler(登记面 = 假 client 捕获的 id + 触发事件)。
    expect(runner.functions).toHaveLength(2);
    expect(bus.registrations.map((fn) => fn.id).sort()).toEqual([
      'oribos-workflow-resume',
      'oribos-workflow-start',
    ]);
    expect(new Set(bus.registrations.map((fn) => fn.trigger))).toEqual(
      new Set(['oribos-workflow-start', 'oribos-workflow-resume']),
    );
  });

  it('client 不是 Inngest 实例:工厂处即拒(SDK 品牌检查),不留到首次 serve', () => {
    const store = createInMemorySnapshotStore();
    const notAClient = { send: async () => ({ ids: [] }) } as unknown as Inngest;
    expect(() => createInngestRunner({ client: notAClient, store })).toThrow('Inngest instance');
  });
});

describe('createInngestRunner:触发与执行', () => {
  it('start 发触发事件并返回 runId;函数执行 run 到 success,状态真相落 store', async () => {
    const bus = fakeBus();
    const recorder = recordingStore();
    const runner = createInngestRunner({ client: bus.client, store: recorder.store });
    const { workflow, executed } = twoStepChain(recorder.store);

    const runId = await runner.start(workflow, { topic: 'hello world' });
    expect(typeof runId).toBe('string');

    // 触发事件带 workflowId / runId / 输入;事件 id 由 runId 决定(同 runId 的重复触发被引擎去重)。
    expect(bus.sent).toEqual([
      { id: `oribos-start-${runId}`, name: 'oribos-workflow-start', data: { workflowId: 'publish', runId, input: { topic: 'hello world' } } },
    ]);

    // handler 执行 run:outcome 信封返回,快照终态落 store,两步各执行一次。
    const startFn = bus.functions.find((fn) => fn.trigger === 'oribos-workflow-start');
    const outcome = (await startFn?.invoke(bus.sent[0]?.data)) as { status: string; output: unknown };
    expect(outcome).toMatchObject({ status: 'success', output: { polished: 'HELLO-WORLD' } });
    expect(executed).toEqual(['draft', 'polish']);
    expect((await recorder.inner.load(runId))?.status).toBe('success');
    expect(recorder.saves()).toContain(`${runId}:success`);
  });

  it('悬挂:函数正常结束(run 在 approve 挂起),不透出失败', async () => {
    const bus = fakeBus();
    const recorder = recordingStore();
    const runner = createInngestRunner({ client: bus.client, store: recorder.store });
    const { workflow } = approvalChain(recorder.store);

    const runId = await runner.start(workflow, { topic: 'hi' });
    const startFn = bus.functions.find((fn) => fn.trigger === 'oribos-workflow-start');
    const outcome = (await startFn?.invoke(bus.sent[0]?.data)) as { status: string; stepId?: string };

    // 悬挂不是失败:outcome 信封读 suspended,快照停在 approve,函数正常结束。
    expect(outcome).toMatchObject({ status: 'suspended', stepId: 'approve' });
    expect((await recorder.inner.load(runId))?.status).toBe('suspended');
  });

  it('resume 重发触发事件;函数经 load → resumeData 校验 → re-enter 续起到 success', async () => {
    const bus = fakeBus();
    const recorder = recordingStore();
    const runner = createInngestRunner({ client: bus.client, store: recorder.store });
    const { workflow, executed } = approvalChain(recorder.store);

    const runId = await runner.start(workflow, { topic: 'hi' });
    const startFn = bus.functions.find((fn) => fn.trigger === 'oribos-workflow-start');
    await startFn?.invoke(bus.sent[0]?.data);

    await runner.resume(runId, { approved: true });
    // resume 事件带 workflowId(从托管登记读出)+ runId + resumeData。
    expect(bus.sent).toHaveLength(2);
    expect(bus.sent[1]).toMatchObject({
      name: 'oribos-workflow-resume',
      data: { workflowId: 'approval', runId, resumeData: { approved: true } },
    });

    const resumeFn = bus.functions.find((fn) => fn.trigger === 'oribos-workflow-resume');
    const outcome = (await resumeFn?.invoke(bus.sent[1]?.data)) as { status: string; output: unknown };
    expect(outcome).toMatchObject({ status: 'success', output: { polished: 'polished' } });
    // 已完成条目(draft)按记录回放不重跑;approve 带 resumeData 重入,polish 收尾。
    expect(executed).toEqual(['draft', 'approve:suspend', 'approve:resumed', 'polish']);
    expect((await recorder.inner.load(runId))?.status).toBe('success');
  });

  it('resume 只到达本 runner 托管过的 run:未托管 runId 在客户端被拒', async () => {
    const bus = fakeBus();
    const store = createInMemorySnapshotStore();
    const runner = createInngestRunner({ client: bus.client, store });

    await expect(runner.resume('no-such-run')).rejects.toThrow('no-such-run');
    expect(bus.sent).toEqual([]);
  });

  it('resume 触达非悬挂快照(重复投递)为 no-op', async () => {
    const bus = fakeBus();
    const recorder = recordingStore();
    const runner = createInngestRunner({ client: bus.client, store: recorder.store });
    const { workflow, executed } = approvalChain(recorder.store);

    const runId = await runner.start(workflow, { topic: 'hi' });
    const startFn = bus.functions.find((fn) => fn.trigger === 'oribos-workflow-start');
    await startFn?.invoke(bus.sent[0]?.data);
    await runner.resume(runId, { approved: true });
    const resumeFn = bus.functions.find((fn) => fn.trigger === 'oribos-workflow-resume');
    await resumeFn?.invoke(bus.sent[1]?.data);

    // 同一 resume 事件被引擎重复投递:run 已 success,handler no-op(不再执行任何步)。
    const before = [...executed];
    const outcome = await resumeFn?.invoke(bus.sent[1]?.data);
    expect(outcome).toBeUndefined();
    expect(executed).toEqual(before);
  });

  it('终态后的重复 start 投递为 no-op(不重跑任何步)', async () => {
    const bus = fakeBus();
    const recorder = recordingStore();
    const runner = createInngestRunner({ client: bus.client, store: recorder.store });
    const { workflow, executed } = twoStepChain(recorder.store);

    const runId = await runner.start(workflow, { topic: 'hi' });
    expect(typeof runId).toBe('string');
    const startFn = bus.functions.find((fn) => fn.trigger === 'oribos-workflow-start');
    await startFn?.invoke(bus.sent[0]?.data);
    const before = [...executed];

    // 同一触发事件被引擎重复投递:快照已 success,handler no-op。
    const outcome = await startFn?.invoke(bus.sent[0]?.data);
    expect(outcome).toBeUndefined();
    expect(executed).toEqual(before);
  });
});

/** draft → polish 之外的三号链:crash 复用与幽灵 workflow 都用它(不同 id 的同形链)。 */
function crashChain(storage: WorkflowSnapshotStore, id = 'crashy'): {
  readonly workflow: Workflow<z.ZodType<{ topic: string }>, z.ZodType<{ done: boolean }>>;
  readonly executed: string[];
  readonly release: (index: number) => void;
  readonly pendingGates: () => number;
} {
  const executed: string[] = [];
  const gates: ((value?: unknown) => void)[] = [];
  const first = createStep({
    id: 'first',
    inputSchema: z.object({ topic: z.string() }),
    outputSchema: z.object({ first: z.string() }),
    execute: (ctx: StepContext<{ topic: string }>) => {
      executed.push('first');
      return { first: ctx.inputData.topic };
    },
  });
  const gate = createStep({
    id: 'gate',
    inputSchema: z.object({ first: z.string() }),
    outputSchema: z.object({ done: z.boolean() }),
    execute: async () => {
      await new Promise((resolve) => gates.push(resolve));
      executed.push('gate');
      return { done: true };
    },
  });
  const workflow = createWorkflow({
    id,
    inputSchema: z.object({ topic: z.string() }),
    outputSchema: z.object({ done: z.boolean() }),
    storage,
  })
    .then(first)
    .then(gate)
    .commit();
  return { workflow, executed, release: (index) => gates[index]?.(), pendingGates: () => gates.length };
}

describe('createInngestRunner:崩溃重试', () => {
  it('引擎重试重投同一触发事件:running 快照续起,已完成条目回放一次、在途条目重执行', async () => {
    const bus = fakeBus();
    const recorder = recordingStore();
    const runner = createInngestRunner({ client: bus.client, store: recorder.store });
    const { workflow, executed, release, pendingGates } = crashChain(recorder.store);

    const runId = await runner.start(workflow, { topic: 'hi' });
    const startFn = bus.functions.find((fn) => fn.trigger === 'oribos-workflow-start');
    const event = bus.sent[0]?.data;

    // 第一次投递:first 完成(running 快照 position=1),gate 挂在闸 0 上——进程死在这里,
    // 该次调用的 promise 永不返回。
    void startFn?.invoke(event);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await recorder.inner.load(runId))?.status).toBe('running');
    expect(executed).toEqual(['first']);

    // 引擎重试 = 同一事件重投:handler 读到 running 快照,从 position 续起——first 按记录回放
    // (不重执行),gate 作为在途条目重执行(第二次挂闸)。
    const retry = startFn?.invoke(event) as Promise<{ status: string }>;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executed).toEqual(['first']);
    expect(pendingGates()).toBe(2);

    // 放行闸 1:重试调用走到 success;快照是状态真相,终态落 store。
    release(1);
    const outcome = await retry;
    expect(outcome).toMatchObject({ status: 'success', output: { done: true } });
    // first 只执行过一次(回放),gate 也只算重试那一次(闸 0 的分支从未走到 push)。
    expect(executed).toEqual(['first', 'gate']);
    expect((await recorder.inner.load(runId))?.status).toBe('success');
  });
});

describe('createInngestRunner:recover 与登记', () => {
  /** 死在 gate 上的 run:第一次投递挂闸不返回,留下 running 快照(recover 的续起对象)。 */
  async function crashedRun(
    runner: ReturnType<typeof createInngestRunner>,
    bus: ReturnType<typeof fakeBus>,
    workflow: Workflow<z.ZodType<{ topic: string }>, z.ZodType<{ done: boolean }>>,
  ): Promise<{ readonly runId: string }> {
    const runId = await runner.start(workflow, { topic: 'hi' });
    const startFn = bus.functions.find((fn) => fn.trigger === 'oribos-workflow-start');
    void startFn?.invoke(bus.sent.at(-1)?.data);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { runId };
  }

  it('recover():running 续起、suspended 跳过、未登记 workflow 报 pending、终态条目清理', async () => {
    const bus = fakeBus();
    const recorder = recordingStore();
    const runner = createInngestRunner({ client: bus.client, store: recorder.store });
    const crash = crashChain(recorder.store);
    const approval = approvalChain(recorder.store);
    const plain = twoStepChain(recorder.store);

    // (a) 崩溃 run:running 快照,闸 0 永不放行。
    const { runId: crashedId } = await crashedRun(runner, bus, crash.workflow);
    // (b) 悬挂 run:等 resume 的答案。
    const suspendedId = await runner.start(approval.workflow, { topic: 'hi' });
    const startFn = bus.functions.find((fn) => fn.trigger === 'oribos-workflow-start');
    await startFn?.invoke(bus.sent.find((event) => (event.data as { runId: string }).runId === suspendedId)?.data);
    expect((await recorder.inner.load(suspendedId))?.status).toBe('suspended');
    // (c) 终态 run:登记条目已成陈账。
    const doneId = await runner.start(plain.workflow, { topic: 'hi' });
    await startFn?.invoke(bus.sent.find((event) => (event.data as { runId: string }).runId === doneId)?.data);
    expect((await recorder.inner.load(doneId))?.status).toBe('success');
    // (d) 未登记 workflow 的 running 快照:另一个 runner(共享 store)用不同 id 的链触发,
    // handler 未被投递——快照手工补成 running。
    const ghostBus = fakeBus();
    const ghostRunner = createInngestRunner({ client: ghostBus.client, store: recorder.store });
    const ghostId = await ghostRunner.start(crashChain(recorder.store, 'ghost-workflow').workflow, {
      topic: 'hi',
    });
    await recorder.inner.save(ghostId, {
      runId: ghostId,
      status: 'running',
      input: { topic: 'hi' },
      stepResults: {},
      position: 0,
    });

    // 扫描:崩溃 run 的续起挂在 gate 的新闸上,放行后 recover 返回。
    const sweep = runner.recover();
    await new Promise((resolve) => setTimeout(resolve, 10));
    crash.release(1);
    const report = await sweep;

    expect(report.recovered.map((entry) => entry.runId)).toEqual([crashedId]);
    expect(report.recovered[0]?.outcome).toMatchObject({ status: 'success' });
    expect(report.suspended).toEqual([suspendedId]);
    expect(report.pending).toEqual([{ runId: ghostId, workflowId: 'ghost-workflow' }]);
    expect(report.failed).toEqual([]);

    // 登记清理:已结算的条目出账(crash / done / ghost 前身),悬挂的留账。
    await expect(runner.resume(crashedId)).rejects.toThrow('no managed run');
    await expect(runner.resume(doneId)).rejects.toThrow('no managed run');
    await expect(runner.resume(suspendedId)).resolves.toBeUndefined();
  });

  it('登记持久在 store:新 runner 实例(共享 store)凭登记发出 resume 事件', async () => {
    const bus1 = fakeBus();
    const store = createInMemorySnapshotStore();
    const runner1 = createInngestRunner({ client: bus1.client, store });
    const { workflow } = approvalChain(store);

    const runId = await runner1.start(workflow, { topic: 'hi' });

    // 另一个进程/实例:进程登记为空,resume 仍读 store 里的持久登记发出事件。
    const bus2 = fakeBus();
    const runner2 = createInngestRunner({ client: bus2.client, store });
    await runner2.resume(runId, { approved: true });
    expect(bus2.sent).toEqual([
      { name: 'oribos-workflow-resume', data: { workflowId: 'approval', runId, resumeData: { approved: true } } },
    ]);
    await expect(runner2.resume('unknown-run')).rejects.toThrow('unknown-run');
  });
});
