import { describe, expect, it, vi } from 'vitest';
import { Agent } from '@oribos/core/agent';
import type { AgentMemoryOptions } from '@oribos/core/agent';
import { Memory } from '@oribos/core/memory';
import { AGENT_RUN_SPAN, createTracer, memoryExporter } from '@oribos/core/observability';
import { createSignals } from '@oribos/core/signals';
import { createTool } from '@oribos/core/tools';
import type { Tool } from '@oribos/core/tools';
import type { SignalPubSub, SignalLease } from '@oribos/distributed-signals';
import {
  createDistributedSignals,
  createInMemoryLeaseStore,
  createInMemoryPubSub,
} from '@oribos/distributed-signals';
import { fakeModel } from '@oribos/testing';

/**
 * createDistributedSignals(#187 冻结表面 / #194 实施):包装式跨实例路由——send 三原语跨实例,
 * stream / generate 永远本地,subscribeToThread 仅本实例;租约 = thread 活跃 run 所有权,广播
 * 冗余由租约收敛;心跳可配可关(关 = step 边界续约 + 注入前 token 自检);信封 traceparent 接收
 * 侧延续,解析失败降级独立 trace。断言只走公开面 + 脚本化假模型;双「实例」= 两个包装共享同一
 * 内存 pubsub / lease。手工构造信封直推 bus 是公开线格式(wire shape),发送侧 v1 不回填
 * traceparent,接收侧延续由信封直接验证。
 */

const TARGET: AgentMemoryOptions = { thread: 't1', resource: 'u1' };
const INSTRUCTIONS = 'You are concise.';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onValue) => {
    resolve = onValue;
  });
  return { promise, resolve };
}

function gateTool(gate: Promise<void>): Tool {
  return createTool({ description: 'Waits for the gate.', execute: () => gate });
}

/** 记录 publish 的内存 pubsub(其余直通内建实现)。 */
function recordingPubSub() {
  const inner = createInMemoryPubSub();
  const published: { topic: string; payload: string }[] = [];
  const pubsub: SignalPubSub = {
    publish: async (topic, payload) => {
      published.push({ topic, payload });
      await inner.publish(topic, payload);
    },
    subscribe: (topics, handler) => inner.subscribe(topics, handler),
  };
  return { pubsub, published };
}

/** 记录 acquire key 与 renew 的内存租约(可注入时钟)。 */
function recordingLease(): SignalLease & { acquired: string[]; renews: number[] } {
  const inner = createInMemoryLeaseStore();
  const acquired: string[] = [];
  const renews: number[] = [];
  return {
    acquired,
    renews,
    acquire: async (key, ttlMs) => {
      const handle = await inner.acquire(key, ttlMs);
      if (handle === null) return null;
      acquired.push(key);
      return {
        token: handle.token,
        renew: async (ttl) => {
          const ok = await handle.renew(ttl);
          renews.push(1);
          return ok;
        },
        release: handle.release,
      };
    },
  };
}

interface InstanceOptions {
  readonly memory?: Memory;
  readonly tools?: Record<string, Tool>;
  readonly tracer?: ReturnType<typeof createTracer>;
  readonly heartbeatMs?: number;
  readonly channelPrefix?: string;
}

/** 一对「实例」共享同一内存 pubsub / lease;makeInstance 造各自的 agent + signals + 包装。 */
function cluster() {
  const { pubsub, published } = recordingPubSub();
  const lease = recordingLease();
  const makeInstance = (model: ReturnType<typeof fakeModel>, options: InstanceOptions = {}) => {
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      ...(options.memory === undefined ? {} : { memory: options.memory }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
    });
    const signals = createSignals({
      agent,
      ...(options.memory === undefined ? {} : { memory: options.memory }),
    });
    return createDistributedSignals({
      signals,
      pubsub,
      lease,
      ...(options.channelPrefix === undefined ? {} : { channelPrefix: options.channelPrefix }),
      ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    });
  };
  return { makeInstance, pubsub, published, lease };
}

/** 内存租约的 key 推导(与实现的命名约定对齐;channelPrefix 测试单独断言前缀)。 */
const leaseKeyFor = (threadId: string) => `oribos:signals-lease:${threadId}`;

/** 把一条信封直推 bus(公开线格式;接收侧由此验证)。 */
async function publishEnvelope(
  pubsub: SignalPubSub,
  envelope: Record<string, unknown>,
  topic = 'oribos:signals:t1',
): Promise<void> {
  await pubsub.publish(topic, JSON.stringify(envelope));
}

const wakeEnvelope = (payload: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'message',
  thread: 't1',
  resource: 'u1',
  payload,
  ...extra,
});

describe('routing:stream / generate 永远本地,send 本地活跃 = 注入(零发布)', () => {
  it('sendMessage 打向本实例活跃 run:注入 prompt 尾部,published 为空', async () => {
    const model = fakeModel([
      { text: 'Working.', toolCalls: [{ toolCallId: 'c1', toolName: 'wait', input: {} }] },
      { text: 'Done.' },
    ]);
    const memory = new Memory();
    const gate = deferred<void>();
    const { makeInstance, published } = cluster();
    const distributed = makeInstance(model, {
      memory,
      tools: { wait: gateTool(gate.promise) },
    });

    const run = distributed.stream('Start.', { memory: TARGET });
    const text = run.text;
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(1));

    await distributed.sendMessage(TARGET, 'New info!');
    gate.resolve();
    expect(await text).toBe('Done.');

    expect(model.streamCalls[1]?.prompt.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'New info!' }],
    });
    expect(published).toHaveLength(0);
  });

  it('generate 直通本地:终值即 agent 的', async () => {
    const model = fakeModel([{ text: 'Hi.' }]);
    const { makeInstance, published } = cluster();
    const distributed = makeInstance(model);
    const result = await distributed.generate('Hello');
    expect(result.text).toBe('Hi.');
    expect(published).toHaveLength(0);
  });
});

describe('send 空闲 = 发布信封到 thread 频道', () => {
  it('sendMessage 空闲:信封 { kind, thread, resource, payload } 到 oribos:signals:<thread>,无 traceparent', async () => {
    const model = fakeModel([{ text: 'Woken.' }]);
    const memory = new Memory();
    const { makeInstance, published } = cluster();
    const distributed = makeInstance(model, { memory });

    await distributed.sendMessage(TARGET, 'Hello across');

    expect(published).toHaveLength(1);
    expect(published[0]!.topic).toBe('oribos:signals:t1');
    const envelope = JSON.parse(published[0]!.payload) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      kind: 'message',
      thread: 't1',
      resource: 'u1',
      payload: 'Hello across',
    });
    expect(envelope.traceparent).toBeUndefined();
  });

  it('channelPrefix 同时进频道名与租约 key', async () => {
    const model = fakeModel([{ text: 'Woken.' }]);
    const memory = new Memory();
    const { makeInstance, published, lease } = cluster();
    const distributed = makeInstance(model, { memory, channelPrefix: 'prod:' });

    await distributed.sendMessage(TARGET, 'x');

    expect(published[0]!.topic).toBe('prod:oribos:signals:t1');
    expect(lease.acquired).toContain('prod:oribos:signals-lease:t1');
  });

  it('sendSignal / queueMessage 的 kind 与 payload 形状(各自独立 thread,空闲即发布)', async () => {
    const model = fakeModel([{ text: 'w' }]);
    const { makeInstance, published } = cluster();
    const distributed = makeInstance(model);

    await distributed.sendSignal({ thread: 't-sig', resource: 'u1' }, { type: 'refresh', at: 7 });
    await distributed.queueMessage({ thread: 't-queue', resource: 'u1' }, 'Queued.');

    expect(published).toHaveLength(2);
    const signal = JSON.parse(published[0]!.payload) as Record<string, unknown>;
    expect(signal.kind).toBe('signal');
    expect(signal.thread).toBe('t-sig');
    expect(signal.payload).toEqual({ type: 'refresh', at: 7 });
    const queue = JSON.parse(published[1]!.payload) as Record<string, unknown>;
    expect(queue.kind).toBe('queue');
    expect(queue.thread).toBe('t-queue');
    expect(queue.payload).toBe('Queued.');
  });

  it('非法 target 在发送前抛(memory 身份规则同形)', async () => {
    const model = fakeModel([{ text: 'w' }]);
    const { makeInstance } = cluster();
    const distributed = makeInstance(model);
    await expect(
      distributed.sendMessage({ thread: 't1' } as AgentMemoryOptions, 'x'),
    ).rejects.toThrow(/missing its resource/);
  });
});

describe('跨实例注入:活跃在他实例', () => {
  it('A stream 持有 thread,B sendSignal → A 注入下一 step,B 零模型调用,恰一次发布', async () => {
    const modelA = fakeModel([
      { text: 'Working.', toolCalls: [{ toolCallId: 'c1', toolName: 'wait', input: {} }] },
      { text: 'Saw it.' },
    ]);
    const modelB = fakeModel([{ text: 'should never run' }]);
    const memory = new Memory();
    const gate = deferred<void>();
    const { makeInstance, published } = cluster();
    const a = makeInstance(modelA, { memory, tools: { wait: gateTool(gate.promise) } });
    const b = makeInstance(modelB, { memory });

    const run = a.stream('Start.', { memory: TARGET });
    const text = run.text;
    await vi.waitFor(() => expect(modelA.streamCalls).toHaveLength(1));

    await b.sendSignal(TARGET, { type: 'nudge', n: 1 });
    gate.resolve();
    expect(await text).toBe('Saw it.');
    expect(modelA.streamCalls[1]?.prompt.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: '[signal] {"type":"nudge","n":1}' }],
    });
    expect(published).toHaveLength(1);
    expect(modelB.streamCalls).toHaveLength(0);
  });
});

describe('空闲唤醒:租约收敛广播冗余', () => {
  it('A engage 过 thread,B send → 恰一处唤醒(A 赢得租约),B 零调用', async () => {
    const modelA = fakeModel([{ text: 'First.' }, { text: 'Woken.' }]);
    const modelB = fakeModel([{ text: 'should never run' }]);
    const memory = new Memory();
    const { makeInstance } = cluster();
    const a = makeInstance(modelA, { memory });
    const b = makeInstance(modelB, { memory });

    await a.generate('First', { memory: TARGET });
    await b.sendMessage(TARGET, 'Wake up');

    await vi.waitFor(() => expect(modelA.streamCalls).toHaveLength(2));
    expect(modelB.streamCalls).toHaveLength(0);
    expect(modelA.streamCalls[1]!.prompt.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Wake up' }],
    });
  });

  it('run 持有期间租约不可领;settle 后释放;唤醒 run settle 后同样释放', async () => {
    const model = fakeModel([
      { text: 'First.' },
      { text: 'Working.', toolCalls: [{ toolCallId: 'c1', toolName: 'wait', input: {} }] },
      { text: 'Done.' },
    ]);
    const memory = new Memory();
    const gate = deferred<void>();
    const { makeInstance, pubsub, lease } = cluster();
    const a = makeInstance(model, { memory, tools: { wait: gateTool(gate.promise) } });

    // 用户 stream 持有期间:另一实例视角 acquire = null
    await a.generate('First', { memory: TARGET }); // engage
    const run = a.stream('Start.', { memory: TARGET });
    void run.text;
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(2));
    expect(await lease.acquire(leaseKeyFor('t1'), 1_000)).toBeNull();

    gate.resolve();
    let handle = await lease.acquire(leaseKeyFor('t1'), 1_000);
    while (handle === null) {
      await sleep(10);
      handle = await lease.acquire(leaseKeyFor('t1'), 1_000);
    }
    await handle.release();

    // 唤醒 run:settle 后租约同样释放
    await publishEnvelope(pubsub, wakeEnvelope('Wake'));
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(4));
    handle = await lease.acquire(leaseKeyFor('t1'), 1_000);
    while (handle === null) {
      await sleep(10);
      handle = await lease.acquire(leaseKeyFor('t1'), 1_000);
    }
    await handle.release();
  });

  it('唤醒 run 活跃期间,后到的信封注入当前 run 而非二次唤醒', async () => {
    const model = fakeModel([
      { text: 'First.' },
      { text: 'W.', toolCalls: [{ toolCallId: 'c1', toolName: 'wait', input: {} }] },
      { text: 'Saw.' },
    ]);
    const memory = new Memory();
    const gate = deferred<void>();
    const { makeInstance, pubsub } = cluster();
    const a = makeInstance(model, { memory, tools: { wait: gateTool(gate.promise) } });

    await a.generate('First', { memory: TARGET }); // engage
    await publishEnvelope(pubsub, wakeEnvelope('Wake'));
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(2));

    await publishEnvelope(pubsub, wakeEnvelope('Inject'));
    gate.resolve();
    await vi.waitFor(() =>
      expect(model.streamCalls[2]?.prompt.at(-1)).toEqual({
        role: 'user',
        content: [{ type: 'text', text: 'Inject' }],
      }),
    );
  });
});

describe('冲突:租约持有者之外的 stream 拒绝', () => {
  it('A 持 run,B distributed.stream 同 thread → 消费时抛「another instance」', async () => {
    const modelA = fakeModel([
      { text: 'Working.', toolCalls: [{ toolCallId: 'c1', toolName: 'wait', input: {} }] },
      { text: 'Done.' },
    ]);
    const modelB = fakeModel([{ text: 'should never run' }]);
    const memory = new Memory();
    const gate = deferred<void>();
    const { makeInstance } = cluster();
    const a = makeInstance(modelA, { memory, tools: { wait: gateTool(gate.promise) } });
    const b = makeInstance(modelB, { memory });

    const runA = a.stream('Start.', { memory: TARGET });
    void runA.text;
    await vi.waitFor(() => expect(modelA.streamCalls).toHaveLength(1));

    const runB = b.stream('Me too.', { memory: TARGET });
    await expect(runB.text).rejects.toThrow(/another instance/);

    gate.resolve();
  });
});

describe('subscribeToThread:仅本实例 run', () => {
  it('本地 run 的 chunk 流向订阅者', async () => {
    const model = fakeModel([{ text: 'Hello.' }]);
    const memory = new Memory();
    const { makeInstance } = cluster();
    const distributed = makeInstance(model, { memory });

    const chunks: unknown[] = [];
    const subscription = distributed.subscribeToThread(TARGET);
    const consuming = (async () => {
      for await (const chunk of subscription) {
        chunks.push(chunk);
        break;
      }
    })();

    const run = distributed.stream('Start.', { memory: TARGET });
    await run.text;
    await consuming;

    expect(chunks.length).toBeGreaterThan(0);
  });
});

describe('trace 延续:信封 traceparent 接收侧延续,解析失败降级', () => {
  it('合法 traceparent → 唤醒 run 的 agent-run span 延续该 trace', async () => {
    const model = fakeModel([{ text: 'First.' }, { text: 'Woken.' }]);
    const memory = new Memory();
    const exporter = memoryExporter();
    const { makeInstance, pubsub } = cluster();
    const a = makeInstance(model, { memory, tracer: createTracer({ exporters: [exporter] }) });

    await a.generate('First', { memory: TARGET }); // engage
    const traceId = 'a'.repeat(32);
    await publishEnvelope(pubsub, wakeEnvelope('Wake', { traceparent: `00-${traceId}-${'b'.repeat(16)}-01` }));

    await vi.waitFor(() =>
      expect(exporter.spans().some((span) => span.type === AGENT_RUN_SPAN && span.traceId === traceId)).toBe(
        true,
      ),
    );
  });

  it('解析失败 → 唤醒照常,独立 trace(降级不新增失败面)', async () => {
    const model = fakeModel([{ text: 'First.' }, { text: 'Woken.' }]);
    const memory = new Memory();
    const exporter = memoryExporter();
    const { makeInstance, pubsub } = cluster();
    const a = makeInstance(model, { memory, tracer: createTracer({ exporters: [exporter] }) });

    await a.generate('First', { memory: TARGET });
    await publishEnvelope(pubsub, wakeEnvelope('Wake', { traceparent: 'not-a-traceparent' }));

    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(2));
    expect(
      exporter.spans().every((span) => span.type !== AGENT_RUN_SPAN || span.traceId !== 'a'.repeat(32)),
    ).toBe(true);
  });

  it('坏 JSON 信封 → 丢弃,不抛、不唤醒', async () => {
    const model = fakeModel([{ text: 'quiet' }]);
    const memory = new Memory();
    const { makeInstance, pubsub } = cluster();
    const a = makeInstance(model, { memory });

    await a.generate('First', { memory: TARGET }); // engage(订阅)
    await pubsub.publish('oribos:signals:t1', '{{{ not json');
    await sleep(20);

    expect(model.streamCalls).toHaveLength(1);
  });
});

describe('租约生命周期:心跳与 step 边界续约', () => {
  it('heartbeatMs 配置:持有期内 interval 续约(长闸后租约仍在),settle 后释放', async () => {
    const model = fakeModel([
      { text: 'Working.', toolCalls: [{ toolCallId: 'c1', toolName: 'wait', input: {} }] },
      { text: 'Done.' },
    ]);
    const memory = new Memory();
    const gate = deferred<void>();
    const { makeInstance, lease } = cluster();
    const distributed = makeInstance(model, {
      memory,
      tools: { wait: gateTool(gate.promise) },
      heartbeatMs: 25,
    });

    const run = distributed.stream('Start.', { memory: TARGET });
    void run.text;
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(1));

    await sleep(150); // TTL = 3 × 25 = 75ms;无续约早已过期
    expect(await lease.acquire(leaseKeyFor('t1'), 1_000)).toBeNull();

    gate.resolve();
    await vi.waitFor(async () => {
      const handle = await lease.acquire(leaseKeyFor('t1'), 1_000);
      expect(handle).not.toBeNull();
    });
  });

  it('heartbeat 关:wrapper run 的 step 边界续约(多步 run 至少续约一次)', async () => {
    const model = fakeModel([
      { text: 'Working.', toolCalls: [{ toolCallId: 'c1', toolName: 'wait', input: {} }] },
      { text: 'Done.' },
    ]);
    const memory = new Memory();
    const gate = deferred<void>();
    const { makeInstance, lease } = cluster();
    const distributed = makeInstance(model, {
      memory,
      tools: { wait: gateTool(gate.promise) },
    });

    const run = distributed.stream('Start.', { memory: TARGET });
    void run.text;
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(1));
    gate.resolve();
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(2));

    expect(lease.renews.length).toBeGreaterThanOrEqual(1);
  });
});

describe('memory 缺席的唤醒', () => {
  it('inner signals 无 memory:跨实例唤醒降级无历史 run,不抛 memory-option 错', async () => {
    const model = fakeModel([{ text: 'First.' }, { text: 'Woken.' }]);
    const { makeInstance, pubsub } = cluster();
    const a = makeInstance(model);

    await a.sendMessage(TARGET, 'Hello'); // engage(订阅 + 自发信封 → 唤醒降级无历史 run)
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(1));

    await publishEnvelope(pubsub, wakeEnvelope('Wake'));
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(2));
  });
});
