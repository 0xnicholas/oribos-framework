import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApp } from '@oribos/core';
import type { App, AppConfig, Logger } from '@oribos/core';
import { Agent } from '@oribos/core/agent';
import type { AgentConfig } from '@oribos/core/agent';
import {
  createInMemoryAgentRunSnapshotStore,
} from '@oribos/core/durable-agent';
import type { AgentRunSnapshot, AgentRunSnapshotStore, DurableAgent } from '@oribos/core/durable-agent';
import { createInMemoryStore, Memory } from '@oribos/core/memory';
import { createInMemoryScheduleStore } from '@oribos/core/schedules';
import type { ScheduleRecord, ScheduleStore, Schedules } from '@oribos/core/schedules';
import type { Signals } from '@oribos/core/signals';
import {
  AGENT_RUN_SPAN,
  AGENT_STEP_SPAN,
  TOOL_CALL_SPAN,
  createTracer,
  memoryExporter,
} from '@oribos/core/observability';
import { createInMemorySnapshotStore, createStep } from '@oribos/core/workflows';
import type {
  StepContext,
  Workflow,
  WorkflowBuilder,
  WorkflowRunSnapshot,
  WorkflowSnapshotStore,
} from '@oribos/core/workflows';
import { expectAssignable, expectSuspended } from './helpers/assertions.js';
import { INSTRUCTIONS } from './helpers/agent.js';
import { fakeModel } from './helpers/fake-model.js';
import { spanOfType, withSpanIdProbe } from './helpers/spans.js';

/**
 * 组合根(M1-15 #36 + M4 #60,ADR-0002):`createApp({ tracer, storage })` 是可选薄组装点,把横切
 * 依赖分发给挂上来的子系统——五个工厂(agent / workflow / durableAgent / signals / schedules)被动
 * 接受分发的 tracer 与四个 storage 槽(memory / workflow / durableAgent / schedules,各自缺省内存
 * 实现),无需逐实例传入;per-instance config 自带依赖时显式优先(显式装配不被接管)。独立 `new`
 * 不挂组合根仍是一等用法,缺席零开销。断言只走公开面(根入口与子路径导出)与规范钦定的 memory
 * exporter 抓手(issue #21 测试决策)。
 */
describe('createApp:横切依赖分发', () => {
  it('经 app.agent() 建出的 agent 无需逐 agent 传 tracer:run 自动开三边界 span', async () => {
    const memory = memoryExporter();
    const app = createApp({ tracer: createTracer({ exporters: [memory] }) });
    const model = fakeModel([
      {
        text: 'Let me check.',
        toolCalls: [{ toolCallId: 'call-1', toolName: 'probe', input: { q: 'x' } }],
      },
      { text: 'done' },
    ]);

    const agent = app.agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: { probe: { description: 'Probes.', execute: () => 'ok' } },
    });

    const result = await agent.generate('Go.');

    expect(result.text).toBe('done');
    const run = spanOfType(memory, AGENT_RUN_SPAN);
    const step = spanOfType(memory, AGENT_STEP_SPAN);
    const tool = spanOfType(memory, TOOL_CALL_SPAN);
    expect(run.name).toBe('assistant');
    expect(run.attributes).toEqual({ agentName: 'assistant', runId: expect.any(String) });
    // 子树沿显式 parent 传播:step 挂 run,tool 挂所属 step
    expect(step.parentSpanId).toBe(run.id);
    expect(tool.parentSpanId).toBe(step.id);
    expect(tool.traceId).toBe(run.traceId);
  });

  it('同一 app 的多个 agent 共用分发的 tracer:各自 run 都落在同一 exporter', async () => {
    const memory = memoryExporter();
    const app = createApp({ tracer: createTracer({ exporters: [memory] }) });
    const first = app.agent({
      name: 'first',
      instructions: INSTRUCTIONS,
      model: fakeModel([{ text: 'a' }]),
    });
    const second = app.agent({
      name: 'second',
      instructions: INSTRUCTIONS,
      model: fakeModel([{ text: 'b' }]),
    });

    await Promise.all([first.generate('Hi.'), second.generate('Hi.')]);

    const runs = memory.spans().filter((span) => span.type === AGENT_RUN_SPAN);
    expect(runs.map((run) => run.name).sort()).toEqual(['first', 'second']);
  });

  it('AgentConfig 自带的 tracer 优先于组合根分发:显式装配不被接管', async () => {
    const byApp = memoryExporter();
    const byAgent = memoryExporter();
    const app = createApp({ tracer: createTracer({ exporters: [byApp] }) });
    const agent = app.agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel([{ text: 'done' }]),
      tracer: createTracer({ exporters: [byAgent] }),
    });

    await agent.generate('Hi.');

    expect(byApp.events).toEqual([]);
    expect(spanOfType(byAgent, AGENT_RUN_SPAN).name).toBe('assistant');
  });
});

describe('不挂组合根:一等用法与零开销', () => {
  it('app.agent() 建出真正的 Agent:五字段原样,动态字段照常逐次解析', async () => {
    const model = fakeModel([{ text: 'done' }]);
    const agent = createApp().agent({
      name: 'assistant',
      instructions: (ctx) => `tenant ${String(ctx.tenant)}`,
      model,
      description: 'Answers.',
    });

    expect(agent).toBeInstanceOf(Agent);
    expect(agent.name).toBe('assistant');
    const result = await agent.generate('Hi.', { tenant: 'acme' });
    expect(result.text).toBe('done');
    expect(model.streamCalls[0]?.prompt).toEqual([
      { role: 'system', content: 'tenant acme' },
      { role: 'user', content: [{ type: 'text', text: 'Hi.' }] },
    ]);
  });

  it('组合根缺席与独立 new Agent 同一零开销:一整轮带工具的 run 都不创建任何 span 对象', async () => {
    const viaApp = createApp().agent(noTracerRun('via-app'));
    // 不挂组合根的独立用法(本票不改 Agent 代码):与组合根路径在同一探针下对照
    const standalone = new Agent(noTracerRun('standalone'));

    const appRun = await withSpanIdProbe(() => viaApp.generate('Go.'));
    const standaloneRun = await withSpanIdProbe(() => standalone.generate('Go.'));

    expect(appRun.result.text).toBe('done');
    expect(standaloneRun.result.text).toBe('done');
    expect([appRun.spanIdsCreated, standaloneRun.spanIdsCreated]).toEqual([false, false]);
  });
});

describe('组合根类型表面', () => {
  it('AppConfig 全字段可选;logger 槽按 Logger 类型开(规范已定)', () => {
    expectAssignable<AppConfig>({});
    expectAssignable<AppConfig>({ tracer: createTracer({ exporters: [] }) });
    // console 即合法 Logger(四级方法结构):用户自带 logger 直吃
    expectAssignable<AppConfig>({ logger: console });
    // @ts-expect-error logger 槽按类型开:缺级别方法的对象不收
    expectAssignable<AppConfig>({ logger: {} });
  });

  it('logger 缝只开在 workflow:AgentConfig 不收(logger 不焊死字段)', () => {
    // @ts-expect-error AgentConfig 缝集 = tracer/processors(agent.md 钦定):logger 不开缝
    expectAssignable<AgentConfig>({ name: 'a', instructions: INSTRUCTIONS, model: fakeModel([]), logger: console });
  });

  it('AppConfig.storage 四槽各可选,形状即四个 port', () => {
    expectAssignable<AppConfig>({ storage: {} });
    expectAssignable<AppConfig>({
      storage: {
        memory: createInMemoryStore(),
        workflow: createInMemorySnapshotStore(),
        durableAgent: createInMemoryAgentRunSnapshotStore(),
        schedules: createInMemoryScheduleStore(),
      },
    });
    // @ts-expect-error 槽按 port 命名:未声明的槽不接受
    expectAssignable<AppConfig>({ storage: { logger: {} } });
  });

  it('App 暴露 agent 工厂;工厂接受完整 AgentConfig(含动态形状)', () => {
    const app: App = createApp();

    expectAssignable<Agent>(
      app.agent({ name: 'assistant', instructions: 'You are concise.', model: fakeModel([]) }),
    );
    expectAssignable<Agent>(
      app.agent({
        name: 'assistant',
        instructions: (ctx) => `tenant ${String(ctx.tenant)}`,
        model: () => fakeModel([]),
        tools: async () => ({ probe: { description: 'Probes.', execute: () => 'ok' } }),
      }),
    );
  });

  it('App 暴露 harness 四工厂:workflow 保留 schema 泛型,三件套返回各自入口对象', () => {
    const app: App = createApp();

    expectAssignable<WorkflowBuilder<typeof topicInput, typeof articleOutput, typeof topicInput>>(
      app.workflow({ id: 'typed', inputSchema: topicInput, outputSchema: articleOutput }),
    );
    const agent = app.agent({ name: 'assistant', instructions: INSTRUCTIONS, model: fakeModel([]) });
    expectAssignable<DurableAgent>(app.durableAgent({ agent, approval: { tools: ['transfer'] } }));
    expectAssignable<Signals>(app.signals({ agent }));
    expectAssignable<Schedules>(app.schedules({ agents: { assistant: agent } }));
  });
});

const topicInput = z.object({ topic: z.string() });
const articleOutput = z.object({ article: z.string() });

/** 记录调用面的 workflow 快照 store:转发到内存实现,记下每次 save 的快照与每次 load 的 runId。 */
function recordingSnapshotStore(): {
  readonly store: WorkflowSnapshotStore;
  readonly saves: WorkflowRunSnapshot[];
  readonly loads: string[];
} {
  const inner = createInMemorySnapshotStore();
  const saves: WorkflowRunSnapshot[] = [];
  const loads: string[] = [];
  return {
    saves,
    loads,
    store: {
      load: async (runId) => {
        loads.push(runId);
        return inner.load(runId);
      },
      save: async (runId, snapshot) => {
        saves.push(structuredClone(snapshot));
        return inner.save(runId, snapshot);
      },
    },
  };
}

/** 单条目审批 workflow:首跑挂起(无 resumeData),resume 以决定收尾。 */
function approvalWorkflow(app: App): Workflow<typeof topicInput, typeof articleOutput> {
  return app
    .workflow({ id: 'app-approval', inputSchema: topicInput, outputSchema: articleOutput })
    .then(
      createStep({
        id: 'approval',
        inputSchema: topicInput,
        outputSchema: articleOutput,
        resumeSchema: z.object({ approved: z.boolean() }),
        suspendSchema: z.object({ question: z.string() }),
        execute: (ctx: StepContext<{ topic: string }, { approved: boolean }, { question: string }>) => {
          if (ctx.resumeData === undefined) {
            ctx.suspend({ question: `approve ${ctx.inputData.topic}?` });
          }
          return { article: `${ctx.inputData.topic}:${String(ctx.resumeData.approved)}` };
        },
      }),
    )
    .commit();
}

describe('createApp:storage 槽分发(组合根建出的子系统缺省吃槽)', () => {
  it('app.workflow() 的缺省快照 store 即组合根的 workflow 槽:挂起写它,resume 从它加载', async () => {
    const recorded = recordingSnapshotStore();
    const app = createApp({ storage: { workflow: recorded.store } });
    const workflow = approvalWorkflow(app);

    const run = workflow.createRun({ runId: 'app-workflow-run' });
    expectSuspended(await run.start({ inputData: { topic: 'ts' } }).result);

    // 挂起快照落组合根的槽(缺省路径不传 storage 也写到这里)
    const suspended = recorded.saves.at(-1);
    expect(suspended?.runId).toBe('app-workflow-run');
    expect(suspended?.status).toBe('suspended');

    // resume 从同一个槽加载:load 收到该 runId,且走完拿到终态
    const outcome = await run.resume({ step: 'approval', resumeData: { approved: true } });
    expect(recorded.loads).toContain('app-workflow-run');
    expect(outcome.status).toBe('success');
  });

  it('app.durableAgent() 的缺省快照 store 即组合根的 durableAgent 槽:挂起写它,resume 从它加载', async () => {
    const recorded = recordingRunStore();
    const app = createApp({ storage: { durableAgent: recorded.store } });
    const transfer = vi.fn(() => 'moved');
    const agent = app.agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel([TRANSFER_CALL, { text: 'Money moved.' }]),
      tools: { transfer: { description: 'Moves money.', execute: transfer } },
    });
    const durable = app.durableAgent({ agent, approval: { tools: ['transfer'] } });

    const out = durable.stream('Transfer my funds.');
    expect(await out.finishReason).toBe('suspended');
    expect(recorded.saves.at(-1)?.runId).toBe(out.runId);
    expect(transfer).not.toHaveBeenCalled();

    const outcome = await durable.resume(out.runId, { approved: true });
    expect(recorded.loads).toContain(out.runId);
    expect(outcome.finishReason).toBe('stop');
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it('app.schedules() 的缺省记录 store 即组合根的 schedules 槽:save 写它,tick 从它读到到期项', async () => {
    const recorded = recordingScheduleStore();
    const app = createApp({ storage: { schedules: recorded.store } });
    const model = fakeModel([{ text: 'Noted.' }]);
    const agent = app.agent({ name: 'writer', instructions: INSTRUCTIONS, model });
    const schedules = app.schedules({ agents: { writer: agent } });
    const first = new Date(1_000_000);
    const second = new Date(3_000_000);
    let occurrences = 0;

    await schedules.save({
      id: 'daily',
      next: () => (occurrences++ === 0 ? first : second),
      target: { agent: 'writer', input: 'Go.' },
    });
    expect(recorded.saves.map((record) => record.nextFireAt)).toEqual([first.getTime()]);

    await schedules.tick({ now: first });
    expect(recorded.dueChecks).toEqual([first.getTime()]);
    expect(model.streamCalls).toHaveLength(1);
    // 触发后推进 nextFireAt:也写回同一个槽
    expect(recorded.saves.map((record) => record.nextFireAt)).toEqual([
      first.getTime(),
      second.getTime(),
    ]);
  });

  it('app.agent() 的缺省 memory 即组合根的 memory 槽:per-call 身份的 run 落历史进它', async () => {
    const store = createInMemoryStore();
    const app = createApp({ storage: { memory: store } });
    const agent = app.agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel([{ text: 'Noted.' }]),
    });

    await agent.generate('Hello.', { memory: { thread: 't1', resource: 'u1' } });

    // 用同一个 store 另建 reader Memory:历史确实写进了组合根的槽
    const stored = await new Memory({ storage: store }).recall({ threadId: 't1' });
    expect(stored.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('app.signals() 与 app.agent() 共用组合根的 memory 槽:唤醒 run 的历史落同一 store', async () => {
    const store = createInMemoryStore();
    const app = createApp({ storage: { memory: store } });
    const model = fakeModel([{ text: 'Noted.' }]);
    const agent = app.agent({ name: 'assistant', instructions: INSTRUCTIONS, model });
    const signals = app.signals({ agent });

    await signals.sendMessage({ thread: 't1', resource: 'u1' }, 'wake');

    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(1));
    const reader = new Memory({ storage: store });
    await vi.waitFor(async () => {
      const stored = await reader.recall({ threadId: 't1' });
      expect(stored.map((message) => message.content)).toContainEqual([
        { type: 'text', text: 'wake' },
      ]);
    });
  });
});

describe('createApp:logger 通道分发(缝只开 workflow)', () => {
  it('app.workflow() 建出的 committed 定义携带组合根 logger:Workflow.logger 可见,配置自带显式优先', () => {
    const app = createApp({ logger: console });

    const distributed = app
      .workflow({ id: 'log-channel', inputSchema: topicInput, outputSchema: articleOutput })
      .commit();
    expect(distributed.logger).toBe(console);

    const own: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const explicit = app
      .workflow({
        id: 'log-channel-own',
        inputSchema: topicInput,
        outputSchema: articleOutput,
        logger: own,
      })
      .commit();
    expect(explicit.logger).toBe(own);

    // 通道缺席:不挂 logger 的 app 建出的定义与独立 createWorkflow 同一形状(undefined)
    const absent = createApp()
      .workflow({ id: 'log-channel-absent', inputSchema: topicInput, outputSchema: articleOutput })
      .commit();
    expect(absent.logger).toBeUndefined();
  });
});

describe('createApp:显式优先(per-instance 配置不被接管)', () => {
  it('WorkflowConfig 自带的 storage 收快照:组合根槽零写入', async () => {
    const byApp = recordingSnapshotStore();
    const byWorkflow = recordingSnapshotStore();
    const app = createApp({ storage: { workflow: byApp.store } });

    const workflow = app
      .workflow({
        id: 'explicit-approval',
        inputSchema: topicInput,
        outputSchema: articleOutput,
        storage: byWorkflow.store,
      })
      .then(
        createStep({
          id: 'approval',
          inputSchema: topicInput,
          outputSchema: articleOutput,
          resumeSchema: z.object({ approved: z.boolean() }),
          suspendSchema: z.object({ question: z.string() }),
          execute: (ctx: StepContext<{ topic: string }, { approved: boolean }, { question: string }>) => {
            if (ctx.resumeData === undefined) {
              ctx.suspend({ question: 'ok?' });
            }
            return { article: String(ctx.resumeData.approved) };
          },
        }),
      )
      .commit();

    await workflow.createRun({ runId: 'explicit-run' }).start({ inputData: { topic: 'ts' } })
      .result;

    expect(byWorkflow.saves.at(-1)?.runId).toBe('explicit-run');
    expect(byApp.saves).toEqual([]);
  });

  it('DurableAgentConfig 自带的 storage 收快照:组合根槽零写入', async () => {
    const byApp = recordingRunStore();
    const byDurable = recordingRunStore();
    const app = createApp({ storage: { durableAgent: byApp.store } });
    const agent = app.agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel([TRANSFER_CALL]),
      tools: { transfer: { description: 'Moves money.', execute: () => 'moved' } },
    });
    const durable = app.durableAgent({
      agent,
      storage: byDurable.store,
      approval: { tools: ['transfer'] },
    });

    const out = durable.stream('Transfer my funds.');
    expect(await out.finishReason).toBe('suspended');

    expect(byDurable.saves.at(-1)?.runId).toBe(out.runId);
    expect(byApp.saves).toEqual([]);
  });

  it('SchedulesConfig 自带的 storage 收记录:组合根槽零写入', async () => {
    const byApp = recordingScheduleStore();
    const bySchedules = recordingScheduleStore();
    const app = createApp({ storage: { schedules: byApp.store } });
    const agent = app.agent({
      name: 'writer',
      instructions: INSTRUCTIONS,
      model: fakeModel([{ text: 'Noted.' }]),
    });
    const schedules = app.schedules({ agents: { writer: agent }, storage: bySchedules.store });

    await schedules.save({
      id: 'daily',
      next: () => null,
      target: { agent: 'writer', input: 'Go.' },
    });

    expect(bySchedules.saves.map((record) => record.id)).toEqual(['daily']);
    expect(byApp.saves).toEqual([]);
  });

  it('AgentConfig / SignalsConfig 自带的 memory 优先:自备实例收历史,组合根槽零写入', async () => {
    const store = createInMemoryStore();
    const own = new Memory();
    const app = createApp({ storage: { memory: store } });
    const model = fakeModel([{ text: 'Noted.' }]);
    const agent = app.agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      memory: own,
    });
    expect(agent.memory).toBe(own);
    const signals = app.signals({ agent, memory: own });

    await signals.sendMessage({ thread: 't1', resource: 'u1' }, 'wake');

    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(1));
    await vi.waitFor(async () =>
      expect((await own.recall({ threadId: 't1' })).length).toBeGreaterThan(0),
    );
    expect(await new Memory({ storage: store }).recall({ threadId: 't1' })).toEqual([]);
  });

  it('非本组合根建出的 agent:共享 Memory 不硬塞给 signals(历史不被切成两段)', async () => {
    const store = createInMemoryStore();
    const own = new Memory();
    const app = createApp({ storage: { memory: store } });
    const model = fakeModel([{ text: 'Noted.' }]);
    const agent = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model, memory: own });

    const signals = app.signals({ agent });
    await signals.sendMessage({ thread: 't1', resource: 'u1' }, 'wake');

    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(1));
    // 不硬塞就退到文档化语义(无 memory = 不落历史):两个 store 都零写入——
    // 若错了共享实例,消息会同时落组合根槽与 agent 自备实例,历史被切开
    expect(await own.recall({ threadId: 't1' })).toEqual([]);
    expect(await new Memory({ storage: store }).recall({ threadId: 't1' })).toEqual([]);
  });
});

describe('createApp:缺省即内存实现(不挂 storage 也不回归)', () => {
  it('createApp() 的 workflow 与 durableAgent 本进程内挂起/恢复全可走', async () => {
    const app = createApp();
    const workflow = approvalWorkflow(app);
    const run = workflow.createRun({ runId: 'default-workflow-run' });
    expectSuspended(await run.start({ inputData: { topic: 'ts' } }).result);
    expect((await run.resume({ step: 'approval', resumeData: { approved: true } })).status).toBe(
      'success',
    );

    const transfer = vi.fn(() => 'moved');
    const durable = app.durableAgent({
      agent: app.agent({
        name: 'assistant',
        instructions: INSTRUCTIONS,
        model: fakeModel([TRANSFER_CALL, { text: 'Money moved.' }]),
        tools: { transfer: { description: 'Moves money.', execute: transfer } },
      }),
      approval: { tools: ['transfer'] },
    });
    const out = durable.stream('Transfer my funds.');
    expect(await out.finishReason).toBe('suspended');
    expect((await durable.resume(out.runId, { approved: true })).finishReason).toBe('stop');
    expect(transfer).toHaveBeenCalledTimes(1);
  });

  it('createApp() 的 schedules 与 signals 本进程内可用:触发落模型、唤醒送达 prompt', async () => {
    const app = createApp();
    const model = fakeModel([{ text: 'Noted.' }]);
    const agent = app.agent({ name: 'assistant', instructions: INSTRUCTIONS, model });

    const schedules = app.schedules({ agents: { assistant: agent } });
    const now = new Date(1_000_000);
    await schedules.save({
      id: 'daily',
      next: () => now,
      target: { agent: 'assistant', input: 'Scheduled.' },
    });
    await schedules.tick({ now });
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(1));

    const signals = app.signals({ agent });
    await signals.sendMessage({ thread: 't1', resource: 'u1' }, 'wake');
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(2));
    expect(model.streamCalls[1]?.prompt.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'wake' }],
    });
  });

  it('app.signals() 的注入事件落组合根 tracer:isEvent 挂在当前 run 的 agent-run span 上', async () => {
    const exported = memoryExporter();
    const app = createApp({ tracer: createTracer({ exporters: [exported] }) });
    const gate = deferred<void>();
    const model = fakeModel([
      { text: 'Working.', toolCalls: [{ toolCallId: 'call-1', toolName: 'wait', input: {} }] },
      { text: 'Done.' },
    ]);
    const agent = app.agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: { wait: { description: 'Waits.', execute: () => gate.promise } },
    });
    const signals = app.signals({ agent });

    const text = signals.stream('Start.', { memory: { thread: 't1', resource: 'u1' } }).text;
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(1));
    await signals.sendMessage({ thread: 't1', resource: 'u1' }, 'New info!');
    gate.resolve();
    expect(await text).toBe('Done.');

    const run = spanOfType(exported, AGENT_RUN_SPAN);
    const events = exported.spans().filter((span) => span.isEvent);
    expect(events).toHaveLength(1);
    expect(events[0]?.traceId).toBe(run.traceId);
    expect(events[0]?.parentSpanId).toBe(run.id);
  });
});

/** 记录调用面的 agent run 快照 store:转发到内存实现,记下每次 save 的快照与每次 load 的 runId。 */
function recordingRunStore(): {
  readonly store: AgentRunSnapshotStore;
  readonly saves: AgentRunSnapshot[];
  readonly loads: string[];
} {
  const inner = createInMemoryAgentRunSnapshotStore();
  const saves: AgentRunSnapshot[] = [];
  const loads: string[] = [];
  return {
    saves,
    loads,
    store: {
      load: async (runId) => {
        loads.push(runId);
        return inner.load(runId);
      },
      save: async (runId, snapshot) => {
        saves.push(structuredClone(snapshot));
        return inner.save(runId, snapshot);
      },
    },
  };
}

/** 记录调用面的 schedule store:转发到内存实现,记下每次 save 的记录与每次 listDue 的时刻。 */
function recordingScheduleStore(): {
  readonly store: ScheduleStore;
  readonly saves: ScheduleRecord[];
  readonly dueChecks: number[];
} {
  const inner = createInMemoryScheduleStore();
  const saves: ScheduleRecord[] = [];
  const dueChecks: number[] = [];
  return {
    saves,
    dueChecks,
    store: {
      save: async (record) => {
        saves.push(structuredClone(record));
        return inner.save(record);
      },
      get: (id) => inner.get(id),
      list: (query) => inner.list(query),
      delete: (id) => inner.delete(id),
      listDue: async (now) => {
        dueChecks.push(now.getTime());
        return inner.listDue(now);
      },
    },
  };
}

/** 审批闸挂起场景的模型脚本第一步:请求一次 transfer。 */
const TRANSFER_CALL = {
  text: 'I will move the funds.',
  toolCalls: [{ toolCallId: 'call-1', toolName: 'transfer', input: { to: 'charity' } }],
} as const;

/** 外部可控的 deferred:测试用它把 run 按在工具执行中间(活跃窗口)。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onValue) => {
    resolve = onValue;
  });
  return { promise, resolve };
}

/** 一次带工具调用的无 tracer run 配置;组合根路径与独立 new 路径各用一份模型实例。 */
function noTracerRun(name: string): AgentConfig {
  return {
    name,
    instructions: INSTRUCTIONS,
    model: fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'probe', input: {} }] },
      { text: 'done' },
    ]),
    tools: { probe: { description: 'Probes.', execute: () => 'ok' } },
  };
}
