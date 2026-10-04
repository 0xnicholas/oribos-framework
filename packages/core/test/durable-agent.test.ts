import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent } from '@oribos/core/agent';
import { createDurableAgent, createInMemoryAgentRunSnapshotStore } from '@oribos/core/durable-agent';
import type { AgentRunSnapshot, AgentRunSnapshotStore } from '@oribos/core/durable-agent';
import { createStep, createWorkflow } from '@oribos/core/workflows';
import type {
  StepContext,
  WorkflowRunSnapshot,
  WorkflowSnapshotStore,
} from '@oribos/core/workflows';
import { AGENT_RUN_SPAN, createTracer, memoryExporter } from '@oribos/core/observability';
import { createTool } from '@oribos/core/tools';
import type { Tool, ToolContext } from '@oribos/core/tools';
import { Memory } from '@oribos/core/memory';
import type { RequestContext } from '@oribos/core/agent';
import { INSTRUCTIONS, assistantWithTools } from './helpers/agent.js';
import { fakeModel } from './helpers/fake-model.js';
import { captureRejection, expectSuccess } from './helpers/assertions.js';
import { collect } from './helpers/collect.js';
import { TRACE_ID, eventsOfType, kinds } from './helpers/spans.js';

/**
 * durable agent(M4 #57,`docs/architecture/harness.md`「Durable agents」/「AgentRunSnapshotStore」):
 * 审批闸挂起(命中清单的调用不执行、run 以 `'suspended'` 正常落定、loop 快照写 port)+ resume 两路
 * (true 执行该调用续跑 / false 以「用户拒绝」结果回喂模型续跑,不终止 run)+ span 锚点(挂起 =
 * status 属性 + 正常 end;resume = 同 traceId 新 span)。断言只走公开面(`@oribos/core/durable-agent`
 * / `@oribos/core/agent`)与脚本化假模型接缝;挂起语义只存在于包装内(裸 agent 永不产生
 * `'suspended'`)。
 */

/** 参考工具:zod 双接口 schema,输入 city 输出 celsius。 */
function weatherTool(execute: (input: { city: string }) => unknown): Tool {
  return createTool({
    description: 'Looks up the weather.',
    inputSchema: z.object({ city: z.string() }),
    execute,
  });
}

/** 参考工具:需要审批的资金转移(参考面里被审批闸拦下的那个)。 */
function transferTool(execute: (input: { to: string }) => unknown): Tool {
  return createTool({
    description: 'Moves money.',
    inputSchema: z.object({ to: z.string() }),
    execute,
  });
}

/** 审批闸挂起场景的脚本第一步:模型请求一次 transfer。 */
const TRANSFER_CALL = {
  text: 'I will move the funds.',
  toolCalls: [{ toolCallId: 'call-1', toolName: 'transfer', input: { to: 'charity' } }],
} as const;

const TRANSFER_CALL_CHUNK = {
  type: 'tool-call',
  toolCallId: 'call-1',
  toolName: 'transfer',
  input: { to: 'charity' },
} as const;

describe('createDurableAgent:审批闸挂起', () => {
  it('命中审批清单:调用不执行,run 以 suspended 落定,快照写进 port', async () => {
    const model = fakeModel([TRANSFER_CALL]);
    const transfer = transferTool(vi.fn(() => 'moved'));
    const storage = createInMemoryAgentRunSnapshotStore();
    const durable = createDurableAgent({
      agent: assistantWithTools(model, { transfer }),
      storage,
      approval: { tools: ['transfer'] },
    });

    const out = durable.stream('Transfer my funds.');

    expect(await out.finishReason).toBe('suspended');
    expect(await out.text).toBe('');
    expect(transfer.execute).not.toHaveBeenCalled();
    // 挂起不是错误:本步没跑完,run 的步骤记录里什么都没有
    expect(await out.toolResults).toEqual([]);
    expect(await out.steps).toEqual([]);

    const suspendPayload = { toolCalls: [TRANSFER_CALL_CHUNK], awaitingApproval: ['call-1'] };
    expect(await out.suspendPayload).toEqual(suspendPayload);
    // 快照形状逐字对齐 spec:消息列表(含本步 raw assistant 消息)+ step 计数 + 挂起点
    const snapshot: AgentRunSnapshot = {
      runId: out.runId,
      status: 'suspended',
      messages: [
        { role: 'system', content: INSTRUCTIONS },
        { role: 'user', content: [{ type: 'text', text: 'Transfer my funds.' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will move the funds.' },
            TRANSFER_CALL_CHUNK,
          ],
        },
      ],
      stepCount: 0,
      suspendPayload,
    };
    expect(await storage.load(out.runId)).toEqual(snapshot);
    // JSON-only:快照能原样过 JSON 往返
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(out.runId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('未命中清单:调用照常执行,run 与裸 agent 一致,port 里没有快照', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } }] },
      { text: 'It is 21°C.' },
    ]);
    const weather = weatherTool(vi.fn(() => ({ celsius: 21 })));
    const storage = createInMemoryAgentRunSnapshotStore();
    const durable = createDurableAgent({
      agent: assistantWithTools(model, { weather }),
      storage,
      approval: { tools: ['transfer'] },
    });

    const out = durable.stream('Weather in SF?');

    expect(await out.finishReason).toBe('stop');
    expect(await out.text).toBe('It is 21°C.');
    expect(await out.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'weather',
        output: { celsius: 21 },
        isError: false,
      },
    ]);
    expect(await out.suspendPayload).toBeUndefined();
    expect(await storage.load(out.runId)).toBeNull();
  });

  it('快照写入被 store 拒绝:suspendPayload 照常收敛(undefined),save 错误成为 run 的错误', async () => {
    const model = fakeModel([TRANSFER_CALL]);
    const transfer = transferTool(vi.fn(() => 'moved'));
    const refused = new Error('store unavailable');
    const storage: AgentRunSnapshotStore = {
      load: () => Promise.resolve(null),
      save: () => Promise.reject(refused),
    };
    const durable = createDurableAgent({
      agent: assistantWithTools(model, { transfer }),
      storage,
      approval: { tools: ['transfer'] },
    });

    const out = durable.stream('Transfer my funds.');

    // 存不下的快照不算挂起:payload 照常收敛(不悬空),save 的失败取代 run 自己的结局——
    // 终值与 chunk 流(缓冲排空后)都以它 reject。
    await expect(out.finishReason).rejects.toBe(refused);
    await expect(out.suspendPayload).resolves.toBeUndefined();
    expect(await captureRejection(() => collect(out))).toBe(refused);
  });

  it('调用方自己的 boundary 与闸共存:beforeNextStep 注入照旧生效', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } }] },
      { text: 'It is 21°C.' },
    ]);
    const durable = createDurableAgent({
      agent: assistantWithTools(model, { weather: weatherTool(() => ({ celsius: 21 })) }),
      approval: { tools: ['transfer'] },
    });

    const out = durable.stream('Weather in SF?', {
      stepBoundary: {
        beforeNextStep: (event) =>
          event.stepIndex === 1
            ? [{ role: 'user', content: [{ type: 'text', text: '[signal] extra info' }] }]
            : undefined,
      },
    });

    expect(await out.finishReason).toBe('stop');
    expect(model.streamCalls[1]?.prompt.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '[signal] extra info' }],
    });
  });

  it('未配 approval 的包装:工具调用照常执行,永不产生 suspended(裸 agent 语义)', async () => {
    const model = fakeModel([TRANSFER_CALL, { text: 'Done.' }]);
    const transfer = transferTool(vi.fn(() => 'moved'));
    const durable = createDurableAgent({ agent: assistantWithTools(model, { transfer }) });

    const out = durable.stream('Transfer my funds.');

    expect(await out.finishReason).toBe('stop');
    expect(transfer.execute).toHaveBeenCalledTimes(1);
    expect(await out.suspendPayload).toBeUndefined();
    expect(await out.text).toBe('Done.');
  });
});

/** 挂起一次 transfer 的 run:模型脚本第一步是 TRANSFER_CALL,其余按用例续写。 */
async function suspendedRun(rest: Parameters<typeof fakeModel>[0] = []) {
  const model = fakeModel([TRANSFER_CALL, ...rest]);
  const transfer = transferTool(vi.fn(() => 'moved'));
  const storage = createInMemoryAgentRunSnapshotStore();
  const durable = createDurableAgent({
    agent: assistantWithTools(model, { transfer }),
    storage,
    approval: { tools: ['transfer'] },
  });
  const out = durable.stream('Transfer my funds.');
  expect(await out.finishReason).toBe('suspended');
  return { model, transfer, storage, durable, runId: out.runId };
}

describe('createDurableAgent:resume 两路', () => {
  it('approved: true —— 执行被拦下的调用,续跑同一 run', async () => {
    const { model, transfer, durable, runId } = await suspendedRun([{ text: 'Money moved.' }]);

    const outcome = await durable.resume(runId, { approved: true });

    expect(outcome.runId).toBe(runId);
    expect(outcome.finishReason).toBe('stop');
    expect(outcome.text).toBe('Money moved.');
    expect(transfer.execute).toHaveBeenCalledTimes(1);
    expect(transfer.execute).toHaveBeenCalledWith({ to: 'charity' }, expect.anything());
    expect(outcome.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'transfer',
        output: 'moved',
        isError: false,
      },
    ]);
    // 本段的首个 step 就是被拦下的那一步:文本 + 调用 + 结果都在记录里
    expect(outcome.steps[0]).toEqual({
      text: 'I will move the funds.',
      toolCalls: [TRANSFER_CALL_CHUNK],
      toolResults: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'transfer',
          output: 'moved',
          isError: false,
        },
      ],
      usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
    });
    // 续跑 run 的 prompt = 快照消息 + 新执行的 tool 消息(assistant 消息不重复追加)
    expect(model.streamCalls[1]?.prompt).toEqual([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'Transfer my funds.' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'I will move the funds.' }, TRANSFER_CALL_CHUNK],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'transfer',
            output: { type: 'text', value: 'moved' },
          },
        ],
      },
    ]);
  });

  it('approved: false —— 调用不执行,「用户拒绝」结果回喂模型续跑(不终止 run)', async () => {
    const { model, transfer, durable, runId } = await suspendedRun([
      { text: 'Understood — I will not move the funds.' },
    ]);

    const outcome = await durable.resume(runId, { approved: false });

    expect(transfer.execute).not.toHaveBeenCalled();
    expect(outcome.finishReason).toBe('stop');
    expect(outcome.text).toBe('Understood — I will not move the funds.');
    const rejected = outcome.toolResults[0];
    expect(rejected?.isError).toBe(true);
    expect(rejected?.toolCallId).toBe('call-1');
    expect(String(rejected?.output)).toMatch(/reject/i);
    // 回喂到模型的 tool 消息携带同一个拒绝结果(与工具错误回喂同构)
    expect(model.streamCalls[1]?.prompt.at(-1)).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'transfer',
          output: { type: 'error-text', value: rejected?.output },
        },
      ],
    });
  });

  it('同一步混合:非清单调用照常执行,只有清单命中的调用等审批决定', async () => {
    const model = fakeModel([
      {
        toolCalls: [
          { toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } },
          { toolCallId: 'call-2', toolName: 'transfer', input: { to: 'charity' } },
        ],
      },
      { text: 'Done.' },
    ]);
    const weather = weatherTool(vi.fn(() => ({ celsius: 21 })));
    const transfer = transferTool(vi.fn(() => 'moved'));
    const durable = createDurableAgent({
      agent: assistantWithTools(model, { weather, transfer }),
      approval: { tools: ['transfer'] },
    });
    const out = durable.stream('Weather, then move funds.');

    expect(await out.finishReason).toBe('suspended');
    expect(await out.suspendPayload).toEqual({
      toolCalls: [
        { type: 'tool-call', toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } },
        { type: 'tool-call', toolCallId: 'call-2', toolName: 'transfer', input: { to: 'charity' } },
      ],
      awaitingApproval: ['call-2'],
    });

    const outcome = await durable.resume(out.runId, { approved: false });

    // 拒绝只落在命中清单的那个调用上:weather 照常执行
    expect(weather.execute).toHaveBeenCalledTimes(1);
    expect(transfer.execute).not.toHaveBeenCalled();
    expect(outcome.toolResults.map((result) => [result.toolCallId, result.isError])).toEqual([
      ['call-1', false],
      ['call-2', true],
    ]);
    expect(outcome.finishReason).toBe('stop');
    expect(outcome.text).toBe('Done.');
  });

  it('续跑段再次挂起:同一 runId 写新快照,step 计数继续', async () => {
    const { durable, storage, runId, model } = await suspendedRun([
      { toolCalls: [{ toolCallId: 'call-2', toolName: 'transfer', input: { to: 'friends' } }] },
      { text: 'Done.' },
    ]);

    const outcome = await durable.resume(runId, { approved: true });

    expect(outcome.runId).toBe(runId);
    expect(outcome.finishReason).toBe('suspended');
    expect(outcome.suspendPayload).toEqual({
      toolCalls: [
        { type: 'tool-call', toolCallId: 'call-2', toolName: 'transfer', input: { to: 'friends' } },
      ],
      awaitingApproval: ['call-2'],
    });
    // 新快照按全局 step 计数推进(第二次挂起挂在 run 的第 2 步上),消息列表接着第一次继续
    const snapshot = await storage.load(runId);
    expect(snapshot?.stepCount).toBe(1);
    expect(snapshot?.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'call-2', toolName: 'transfer', input: { to: 'friends' } },
      ],
    });
    expect(model.streamCalls).toHaveLength(2);

    // 再续跑一次可到终局:第三次模型调用收尾
    const finished = await durable.resume(runId, { approved: true });
    expect(finished.finishReason).toBe('stop');
    expect(finished.text).toBe('Done.');
    expect(finished.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-2',
        toolName: 'transfer',
        output: 'moved',
        isError: false,
      },
    ]);
  });

  it('resume 的 step 上限沿用 run 全局计数:maxSteps 用尽时不再回模型', async () => {
    const { durable, runId, model } = await suspendedRun([{ text: 'unused' }]);

    const outcome = await durable.resume(runId, { approved: true, maxSteps: 1 });

    // 挂起发生在 step 0,续跑段执行完该步即触顶:不发起新的模型调用
    expect(model.streamCalls).toHaveLength(1);
    expect(outcome.finishReason).toBe('tool-calls');
    expect(outcome.toolResults[0]?.output).toBe('moved');
  });

  it('续跑段带 memory:不重放历史,续跑的步落进 thread', async () => {
    const model = fakeModel([TRANSFER_CALL, { text: 'Money moved.' }]);
    const memory = new Memory();
    const durable = createDurableAgent({
      agent: new Agent({
        name: 'assistant',
        instructions: INSTRUCTIONS,
        model,
        tools: { transfer: transferTool(() => 'moved') },
        memory,
      }),
      approval: { tools: ['transfer'] },
    });
    const target = { thread: 't-1', resource: 'u-1' };

    const out = durable.stream('Transfer my funds.', { memory: target });
    expect(await out.finishReason).toBe('suspended');
    // 没跑完的步不落库:挂起时 thread 里什么都没有(消息全在快照里)
    expect(await memory.recall({ threadId: 't-1' })).toEqual([]);

    await durable.resume(out.runId, { approved: true, memory: target });

    // prompt 仍然就是快照消息 + 新 tool 消息:续跑段不 recall、不重放历史
    expect(model.streamCalls[1]?.prompt).toEqual([
      { role: 'system', content: INSTRUCTIONS },
      { role: 'user', content: [{ type: 'text', text: 'Transfer my funds.' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'I will move the funds.' }, TRANSFER_CALL_CHUNK],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'transfer',
            output: { type: 'text', value: 'moved' },
          },
        ],
      },
    ]);
    // 落库的是续跑段自己的步:挂起步的 assistant + tool,然后续跑步的 assistant
    const stored = await memory.recall({ threadId: 't-1' });
    expect(stored.map((message) => message.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(stored[2]?.content).toEqual([{ type: 'text', text: 'Money moved.' }]);
  });

  it('resume 的内部接线不进工具的 requestContext(执行控制不是上下文)', async () => {
    const model = fakeModel([TRANSFER_CALL, { text: 'Money moved.' }]);
    const seen: RequestContext[] = [];
    const transfer = createTool({
      description: 'Moves money.',
      inputSchema: z.object({ to: z.string() }),
      execute: (_input: { to: string }, ctx: ToolContext) => {
        seen.push(ctx.requestContext);
        return 'moved';
      },
    });
    const durable = createDurableAgent({
      agent: assistantWithTools(model, { transfer }),
      approval: { tools: ['transfer'] },
    });
    const out = durable.stream('Transfer my funds.');
    expect(await out.finishReason).toBe('suspended');

    await durable.resume(out.runId, { approved: true });

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('resume');
    expect(seen[0]).not.toHaveProperty('stepBoundary');
    expect(seen[0]?.runId).toEqual(expect.any(String));
  });

  it('续跑时 maxSteps 已被用尽:显式报错,不是空转(上限不随快照走)', async () => {
    const { durable, runId } = await suspendedRun([
      { toolCalls: [{ toolCallId: 'call-2', toolName: 'transfer', input: { to: 'friends' } }] },
      { text: 'unused' },
    ]);
    const first = await durable.resume(runId, { approved: true });
    // 第二次挂起挂在 run 全局 step 1 上
    expect(first.finishReason).toBe('suspended');

    const error = await captureRejection(() =>
      durable.resume(runId, { approved: true, maxSteps: 1 }),
    );

    expect(error.message).toMatch(/maxSteps/);
  });

  it('resume 不存在的 run 时显式报错', async () => {
    const durable = createDurableAgent({ agent: assistantWithTools(fakeModel([]), {}) });

    const error = await captureRejection(() => durable.resume('missing', { approved: true }));

    expect(error.message).toMatch(/missing/);
    expect(error.message).toMatch(/snapshot/i);
  });

  it('并发 resume 同一 run:合并为一次续跑,调用只执行一次', async () => {
    const { transfer, durable, runId } = await suspendedRun([{ text: 'Money moved.' }]);

    const [first, second] = await Promise.all([
      durable.resume(runId, { approved: true }),
      durable.resume(runId, { approved: true }),
    ]);

    expect(transfer.execute).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });
});

describe('createDurableAgent:resume 去重的键域 = (store, runId)(#119)', () => {
  it('跨 wrapper:两个 createDurableAgent 实例同一 store+runId 也合并为一次执行', async () => {
    // 去重不依赖工厂闭包的偶然:快照的持久化身份是 (store, runId),与哪个 wrapper 发起无关
    const model = fakeModel([TRANSFER_CALL, { text: 'Money moved.' }]);
    const transfer = transferTool(vi.fn(() => 'moved'));
    const storage = createInMemoryAgentRunSnapshotStore();
    const approval = { tools: ['transfer'] };
    const first = createDurableAgent({
      agent: assistantWithTools(model, { transfer }),
      storage,
      approval,
    });
    const second = createDurableAgent({
      agent: assistantWithTools(model, { transfer }),
      storage,
      approval,
    });
    const out = first.stream('Transfer my funds.');
    expect(await out.finishReason).toBe('suspended');

    const [a, b] = await Promise.all([
      first.resume(out.runId, { approved: true }),
      second.resume(out.runId, { approved: true }),
    ]);

    // 只续跑一次:工具执行一次,模型只在续跑段多被调一次;两个调用方拿到同一结局
    expect(transfer.execute).toHaveBeenCalledTimes(1);
    expect(model.streamCalls).toHaveLength(2);
    expect(a).toEqual(b);
  });

  it('跨子系统:同一 store 对象、同一 runId 的 workflow 与 durable resume 互不误并', async () => {
    // 统一 adapter 的最坏情形:两个快照 port 面是同一对象。store 按形状分槽(workflow 快照带
    // stepResults,durable 快照带 messages),load 合并两槽返回——任一子系统读回自己写的那部分。
    const slots = new Map<string, { workflow?: WorkflowRunSnapshot; durable?: AgentRunSnapshot }>();
    const store: WorkflowSnapshotStore & AgentRunSnapshotStore = {
      load: async (runId: string) => {
        const slot = slots.get(runId);
        return slot === undefined
          ? null
          : ({ ...slot.workflow, ...slot.durable } as unknown as WorkflowRunSnapshot &
              AgentRunSnapshot);
      },
      save: async (runId: string, snapshot: WorkflowRunSnapshot | AgentRunSnapshot) => {
        const slot = slots.get(runId) ?? {};
        if ('stepResults' in snapshot) slot.workflow = structuredClone(snapshot);
        else slot.durable = structuredClone(snapshot);
        slots.set(runId, slot);
      },
    };

    const runId = 'unified-run';
    const gateExecute = vi.fn((ctx: StepContext<string, string>) => {
      if (ctx.resumeData === undefined) ctx.suspend({ question: 'ok?' });
      return `gate:${ctx.resumeData}`;
    });
    const gate = createStep({
      id: 'gate',
      inputSchema: z.string(),
      outputSchema: z.string(),
      resumeSchema: z.string(),
      execute: gateExecute,
    });
    const workflow = createWorkflow({
      id: 'unified-workflow',
      inputSchema: z.string(),
      outputSchema: z.string(),
      storage: store,
    })
      .then(gate)
      .commit();
    const run = workflow.createRun({ runId });
    await run.start({ inputData: 'x' }).result;

    // durable 侧的挂起快照直接写 port(stream 的 runId 由包装铸造,同 runId 由 save 摆出)
    const model = fakeModel([{ text: 'Money moved.' }]);
    const transfer = transferTool(vi.fn(() => 'moved'));
    const durable = createDurableAgent({
      agent: assistantWithTools(model, { transfer }),
      storage: store,
      approval: { tools: ['transfer'] },
    });
    await store.save(runId, {
      runId,
      status: 'suspended',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Transfer my funds.' }] },
        { role: 'assistant', content: [TRANSFER_CALL_CHUNK] },
      ],
      stepCount: 0,
      suspendPayload: { toolCalls: [TRANSFER_CALL_CHUNK], awaitingApproval: ['call-1'] },
    });

    const [workflowOutcome, durableOutcome] = await Promise.all([
      run.resume({ step: 'gate', resumeData: 'yes' }),
      durable.resume(runId, { approved: true }),
    ]);

    // 锁的隔离是结构性的:误并会让 durable 拿到 workflow 的信封,transfer 永不执行
    expect(expectSuccess(workflowOutcome).output).toBe('gate:yes');
    expect(gateExecute).toHaveBeenCalledTimes(2);
    expect(durableOutcome.finishReason).toBe('stop');
    expect(durableOutcome.text).toBe('Money moved.');
    expect(transfer.execute).toHaveBeenCalledTimes(1);
  });
});

describe('createDurableAgent:span 锚点', () => {
  it('挂起 = agent-run span 的 status 属性 + 正常 end;快照持久化 traceId,resume 落同一 trace', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const model = fakeModel([TRANSFER_CALL, { text: 'Money moved.' }]);
    const transfer = transferTool(() => 'moved');
    const storage = createInMemoryAgentRunSnapshotStore();
    const durable = createDurableAgent({
      agent: new Agent({
        name: 'assistant',
        instructions: INSTRUCTIONS,
        model,
        tools: { transfer },
        tracer,
      }),
      storage,
      approval: { tools: ['transfer'] },
    });

    const out = durable.stream('Transfer my funds.');
    expect(await out.finishReason).toBe('suspended');

    // 挂起锚点:agent-run span 以 status 属性正常 end(非 error)
    const ended = eventsOfType(memory, AGENT_RUN_SPAN).at(-1);
    expect(kinds(eventsOfType(memory, AGENT_RUN_SPAN))).toEqual([
      'span_started',
      'span_updated',
      'span_updated',
      'span_ended',
    ]);
    expect(ended?.span.attributes).toMatchObject({ status: 'suspended' });
    expect(ended?.span.error).toBeUndefined();
    // traceId 随快照持久化
    const snapshot = await storage.load(out.runId);
    expect(snapshot?.traceId).toMatch(TRACE_ID);
    expect(snapshot?.traceId).toBe(ended?.span.traceId);

    await durable.resume(out.runId, { approved: true });

    // resume = 同一 traceId 下新的 agent-run span(一次 HITL 交互 = 同 trace 多 span)
    const runSpans = memory.spans().filter((span) => span.type === AGENT_RUN_SPAN);
    expect(runSpans).toHaveLength(2);
    expect(runSpans[1]?.traceId).toBe(runSpans[0]?.traceId);
    expect(runSpans[1]?.id).not.toBe(runSpans[0]?.id);
    expect(runSpans[1]?.error).toBeUndefined();
  });
});

describe('createInMemoryAgentRunSnapshotStore:内存默认实现', () => {
  it('深拷贝:save 后改写原快照不影响 load;load 返回值改写不影响 store;未知 runId 返回 null;同 runId 覆盖', async () => {
    const store = createInMemoryAgentRunSnapshotStore();
    const snapshot = {
      runId: 'r-1',
      status: 'suspended' as const,
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'go?' }] }],
      stepCount: 0,
      suspendPayload: { toolCalls: [], awaitingApproval: ['call-1'] },
    };

    await store.save('r-1', snapshot);
    // 写入后改写调用方对象:内存实现像序列化后端一样隔离
    snapshot.suspendPayload.awaitingApproval[0] = 'mutated';

    const loaded = await store.load('r-1');
    expect(loaded).toEqual({
      runId: 'r-1',
      status: 'suspended',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go?' }] }],
      stepCount: 0,
      suspendPayload: { toolCalls: [], awaitingApproval: ['call-1'] },
    });
    // 读出后改写返回值:store 内的快照不受影响(读向同样深拷贝过缝)
    (loaded?.suspendPayload.awaitingApproval as string[])[0] = 'mutated';
    expect((await store.load('r-1'))?.suspendPayload.awaitingApproval).toEqual(['call-1']);
    expect(await store.load('r-2')).toBeNull();

    await store.save('r-1', { ...snapshot, stepCount: 1 });
    expect((await store.load('r-1'))?.stepCount).toBe(1);
  });
});
