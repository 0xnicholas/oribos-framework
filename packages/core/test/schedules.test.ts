import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '@oribos/core/agent';
import { Memory } from '@oribos/core/memory';
import {
  createInMemoryScheduleStore,
  createSchedules,
  type ScheduleRecord,
  type ScheduleStore,
} from '@oribos/core/schedules';
import { createSignals } from '@oribos/core/signals';
import { createTool } from '@oribos/core/tools';
import { assistant, INSTRUCTIONS } from './helpers/agent.js';
import { fakeModel } from './helpers/fake-model.js';

afterEach(() => {
  vi.useRealTimers();
});

/**
 * schedules(M4 #59,`docs/architecture/harness.md`「Schedules」/「ScheduleStore」节):
 * `createInMemoryScheduleStore` 是 `ScheduleStore` port 的语义参考实现——CRUD 走深拷贝、
 * listDue 边界(到期 / 未到期 / enabled: false / 无下一次)、list 的到期升序 + null 末置 +
 * 游标。断言只走公开面(@oribos/core/schedules 子路径)。
 */

/** 最小目标(threadless 形态;store 层不解释 target,仅为记录形状)。 */
function agentTarget(): ScheduleRecord['target'] {
  return { agent: 'assistant', input: 'Go.' };
}

function record(id: string, nextFireAt: number | null, enabled = true): ScheduleRecord {
  return { id, nextFireAt, target: agentTarget(), enabled };
}

const NOW = new Date(1_000_000);

/** 外部可控的 deferred:把触发的 run 按在工具执行中间(慢拍场景)。 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onValue) => {
    resolve = onValue;
  });
  return { promise, resolve };
}

describe('schedules:ScheduleStore(内存默认实现)', () => {
  it('save 后 get 取回同一记录;未知 id 返回 null', async () => {
    const store: ScheduleStore = createInMemoryScheduleStore();
    const stored = record('daily', NOW.getTime());

    await store.save(stored);

    expect(await store.get('daily')).toEqual(stored);
    expect(await store.get('missing')).toBeNull();
  });

  it('save 是 upsert:同 id 覆盖前值', async () => {
    const store = createInMemoryScheduleStore();
    await store.save(record('daily', 100));
    await store.save(record('daily', 200));

    expect((await store.get('daily'))?.nextFireAt).toBe(200);
    expect(await store.list()).toHaveLength(1);
  });

  it('delete 移除记录;删除不存在的 id 是无操作', async () => {
    const store = createInMemoryScheduleStore();
    await store.save(record('daily', 100));

    await store.delete('daily');
    await store.delete('daily');

    expect(await store.get('daily')).toBeNull();
  });

  it('读写跨 port 即深拷贝:存后改输入、取后改输出,都不影响存储', async () => {
    const store = createInMemoryScheduleStore();
    const input = record('daily', 100);
    await store.save(input);

    input.metadata = { mutated: true };
    const first = await store.get('daily');
    first!.metadata = { alsoMutated: true };

    expect((await store.get('daily'))?.metadata).toBeUndefined();
  });

  it('listDue:nextFireAt <= now 且 enabled 的记录才到期;无下一次(null)永不到期', async () => {
    const store = createInMemoryScheduleStore();
    await store.save(record('due', NOW.getTime() - 1));
    await store.save(record('boundary', NOW.getTime())); // 到点即到期(<=)
    await store.save(record('early', NOW.getTime() + 1));
    await store.save(record('paused', NOW.getTime() - 1, false));
    await store.save(record('exhausted', null));

    expect((await store.listDue(NOW)).map((entry) => entry.id)).toEqual(['due', 'boundary']);
  });

  it('listDue 按到期时间升序(同刻以 id 定序)', async () => {
    const store = createInMemoryScheduleStore();
    await store.save(record('later', NOW.getTime() - 1));
    await store.save(record('sooner', NOW.getTime() - 100));
    await store.save(record('tie-b', NOW.getTime() - 50));
    await store.save(record('tie-a', NOW.getTime() - 50));

    expect((await store.listDue(NOW)).map((entry) => entry.id)).toEqual([
      'sooner',
      'tie-a',
      'tie-b',
      'later',
    ]);
  });

  it('list:到期时间升序,无下一次(null)排在末尾', async () => {
    const store = createInMemoryScheduleStore();
    await store.save(record('exhausted', null));
    await store.save(record('later', 200));
    await store.save(record('sooner', 100));

    expect((await store.list()).map((entry) => entry.id)).toEqual(['sooner', 'later', 'exhausted']);
  });

  it('list:limit 取头部;before 是游标,只返回其后的记录(分页)', async () => {
    const store = createInMemoryScheduleStore();
    await store.save(record('a', 100));
    await store.save(record('b', 200));
    await store.save(record('c', 300));

    expect((await store.list({ limit: 2 })).map((entry) => entry.id)).toEqual(['a', 'b']);
    expect((await store.list({ limit: 2, before: 'b' })).map((entry) => entry.id)).toEqual(['c']);
  });

  it('list:悬空游标 / 非法 limit 是调用方错误,显式抛错', async () => {
    const store = createInMemoryScheduleStore();
    await store.save(record('a', 100));

    await expect(store.list({ before: 'missing' })).rejects.toThrow(/before/);
    await expect(store.list({ limit: 0 })).rejects.toThrow(/limit/);
  });
});

describe('schedules:记录(save)', () => {
  it('save 缺省 mint id、以 next(now) 计算 nextFireAt,返回落库记录;缺省 enabled = true', async () => {
    const storage = createInMemoryScheduleStore();
    const schedules = createSchedules({ storage, agents: { assistant: assistant(fakeModel([])) } });
    let seen: Date | undefined;

    const saved = await schedules.save({
      next: (from) => {
        seen = from;
        return new Date(9_999_999);
      },
      target: { agent: 'assistant', input: 'Go.' },
      timezone: 'Asia/Shanghai',
      metadata: { label: 'daily' },
    });

    expect(seen).toBeInstanceOf(Date);
    expect(saved).toEqual({
      id: saved.id,
      nextFireAt: 9_999_999,
      target: { agent: 'assistant', input: 'Go.' },
      timezone: 'Asia/Shanghai',
      enabled: true,
      metadata: { label: 'daily' },
    });
    expect(saved.id).not.toBe('');
    expect(await storage.get(saved.id)).toEqual(saved);
  });

  it('save 是 upsert:同 id 覆盖记录并重新登记 next', async () => {
    const storage = createInMemoryScheduleStore();
    const schedules = createSchedules({ storage, agents: { assistant: assistant(fakeModel([])) } });

    await schedules.save({ id: 'daily', next: () => new Date(100), target: { agent: 'assistant', input: 'v1' } });
    const second = await schedules.save({
      id: 'daily',
      next: () => new Date(200),
      target: { agent: 'assistant', input: 'v2' },
      enabled: false,
    });

    expect(second.enabled).toBe(false);
    expect(await storage.list()).toEqual([second]);
  });

  it('target 校验:未登记的 agent / 未配置 signals / thread 或 resource 缺失,都在 save 时抛错', async () => {
    const noSignals = createSchedules({ agents: { assistant: assistant(fakeModel([])) } });

    await expect(
      noSignals.save({ next: () => null, target: { agent: 'ghost', input: 'Go.' } }),
    ).rejects.toThrow(/ghost/);
    await expect(
      noSignals.save({
        next: () => null,
        target: { thread: 't1', resource: 'u1', payload: { type: 'x' } },
      }),
    ).rejects.toThrow(/signals/);

    const memory = new Memory();
    const withSignals = createSchedules({
      agents: {},
      signals: createSignals({
        agent: new Agent({
          name: 'assistant',
          instructions: INSTRUCTIONS,
          model: fakeModel([]),
          memory,
        }),
        memory,
      }),
    });
    await expect(
      withSignals.save({ next: () => null, target: { thread: '', resource: 'u1', payload: { type: 'x' } } }),
    ).rejects.toThrow(/missing its thread/);
    await expect(
      withSignals.save({ next: () => null, target: { thread: 't1', resource: '', payload: { type: 'x' } } }),
    ).rejects.toThrow(/missing its resource/);
  });
});

describe('schedules:tick(触发并推进)', () => {
  it('threadless:到期才 agent.generate(input),随后按 tick 的 now 推进 nextFireAt', async () => {
    const model = fakeModel([{ text: 'Ran.' }]);
    const storage = createInMemoryScheduleStore();
    const schedules = createSchedules({
      storage,
      agents: { assistant: assistant(model) },
    });
    const saved = await schedules.save({
      next: (from) => new Date(from.getTime() + 60_000),
      target: { agent: 'assistant', input: 'Go!' },
    });
    const due = saved.nextFireAt!;

    await schedules.tick({ now: new Date(due - 1) });
    expect(model.streamCalls).toHaveLength(0);
    expect((await storage.get(saved.id))?.nextFireAt).toBe(due);

    await schedules.tick({ now: new Date(due) });
    expect(model.streamCalls).toHaveLength(1);
    expect(model.streamCalls[0]?.prompt.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Go!' }],
    });
    expect((await storage.get(saved.id))?.nextFireAt).toBe(due + 60_000);

    // 推进后的再次 tick:不再到期,不重复触发
    await schedules.tick({ now: new Date(due) });
    expect(model.streamCalls).toHaveLength(1);
  });

  it('tick 只碰到期的记录:enabled: false 的到期记录不触发', async () => {
    const model = fakeModel([{ text: 'Ran.' }]);
    const storage = createInMemoryScheduleStore();
    const schedules = createSchedules({ storage, agents: { assistant: assistant(model) } });
    await schedules.save({
      next: () => new Date(5_000),
      target: { agent: 'assistant', input: 'Go!' },
      enabled: false,
    });

    await schedules.tick({ now: new Date(6_000) });

    expect(model.streamCalls).toHaveLength(0);
  });

  it('threaded:经 signals.sendSignal 注入 thread,payload 进会话与历史', async () => {
    const model = fakeModel([{ text: 'Noted.' }]);
    const memory = new Memory();
    const agent = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model, memory });
    const signals = createSignals({ agent, memory });
    const storage = createInMemoryScheduleStore();
    const schedules = createSchedules({ storage, agents: {}, signals });
    await schedules.save({
      next: () => new Date(5_000),
      target: { thread: 't1', resource: 'u1', payload: { type: 'daily', note: 'go' } },
    });

    await schedules.tick({ now: new Date(5_000) });

    const rendered = '[signal] {"type":"daily","note":"go"}';
    await vi.waitFor(() => expect(model.streamCalls).toHaveLength(1));
    expect(model.streamCalls[0]?.prompt.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: rendered }],
    });
    await vi.waitFor(async () => {
      const stored = await memory.recall({ threadId: 't1' });
      expect(stored.map((message) => message.content)).toContainEqual([
        { type: 'text', text: rendered },
      ]);
    });
  });
});

describe('schedules:tick 健壮性', () => {
  it('触发失败不打断 tick:错误吞掉、记录照常推进,后续到期记录仍触发', async () => {
    const failing = fakeModel([{ fail: new Error('boom') }]);
    const working = fakeModel([{ text: 'Ran.' }]);
    const storage = createInMemoryScheduleStore();
    const schedules = createSchedules({
      storage,
      agents: { failing: assistant(failing), working: assistant(working) },
    });
    const broken = await schedules.save({
      next: (from) => new Date(from.getTime() + 60_000),
      target: { agent: 'failing', input: 'Go!' },
    });
    const healthy = await schedules.save({
      next: (from) => new Date(from.getTime() + 60_000),
      target: { agent: 'working', input: 'Go!' },
    });

    // Both records must be due at the tick. The two saves anchor `nextFireAt` at their own
    // wall-clock `new Date()` and may straddle a millisecond, so the tick's now is the later of
    // the two — and both advance from that same now (tick's contract: advance from its `now`).
    const due = Math.max(broken.nextFireAt!, healthy.nextFireAt!);

    await expect(schedules.tick({ now: new Date(due) })).resolves.toBeUndefined();

    expect(failing.streamCalls).toHaveLength(1); // 失败也算本次到期已花出
    expect(working.streamCalls).toHaveLength(1); // 坏目标不阻塞后续记录
    expect((await storage.get(broken.id))?.nextFireAt).toBe(due + 60_000);
    expect((await storage.get(healthy.id))?.nextFireAt).toBe(due + 60_000);
  });

  it('进程内无 next 登记的到期记录被跳过:不触发、不推进(不能重排就不重发)', async () => {
    const storage = createInMemoryScheduleStore();
    const modelA = fakeModel([{ text: 'A.' }]);
    const schedulesA = createSchedules({ storage, agents: { assistant: assistant(modelA) } });
    const modelB = fakeModel([{ text: 'B.' }]);
    const schedulesB = createSchedules({ storage, agents: { assistant: assistant(modelB) } });
    await schedulesB.save({
      id: 'daily',
      next: () => new Date(0),
      target: { agent: 'assistant', input: 'Go!' },
    });

    await schedulesA.tick({ now: new Date(10) });

    expect(modelA.streamCalls).toHaveLength(0);
    expect(modelB.streamCalls).toHaveLength(0);
    expect((await storage.get('daily'))?.nextFireAt).toBe(0);
  });

  it('next 返回 null:nextFireAt 落 null,此后永不到期', async () => {
    const model = fakeModel([]);
    const storage = createInMemoryScheduleStore();
    const schedules = createSchedules({ storage, agents: { assistant: assistant(model) } });

    const saved = await schedules.save({
      next: () => null,
      target: { agent: 'assistant', input: 'Go!' },
    });
    await schedules.tick({ now: new Date(10_000_000) });

    expect(saved.nextFireAt).toBeNull();
    expect(model.streamCalls).toHaveLength(0);
  });
});

describe('schedules:startTicker(进程内便利件)', () => {
  it('每 intervalMs 一拍:到期的记录被触发;stop() 后不再触发', async () => {
    vi.useFakeTimers();
    const model = fakeModel([{ text: 'Ran.' }]);
    const schedules = createSchedules({ agents: { assistant: assistant(model) } });
    let first = true;
    await schedules.save({
      next: (from) => {
        const occurrence = first ? from.getTime() + 100 : from.getTime() + 100_000;
        first = false;
        return new Date(occurrence);
      },
      target: { agent: 'assistant', input: 'Go!' },
    });

    const ticker = schedules.startTicker({ intervalMs: 50 });
    await vi.advanceTimersByTimeAsync(50); // 第一拍:尚未到期
    expect(model.streamCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(200); // 到点 → 触发一次,重排到远期
    expect(model.streamCalls).toHaveLength(1);

    ticker.stop();
    ticker.stop(); // stop 幂等
    await vi.advanceTimersByTimeAsync(1_000);
    expect(model.streamCalls).toHaveLength(1);
  });

  it('慢拍不叠加:上一拍 tick 未离开时跳过本拍', async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    let firings = 0; // 每次触发 = 一次工具执行(一次 run 内只执行一次;不叠加则不增长)
    const model = fakeModel([
      { text: 'Working.', toolCalls: [{ toolCallId: 'call-1', toolName: 'wait', input: {} }] },
      { text: 'Done.' },
    ]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: {
        wait: createTool({
          description: 'Waits for the gate.',
          execute: () => {
            firings += 1;
            return gate.promise;
          },
        }),
      },
    });
    const schedules = createSchedules({ agents: { assistant: agent } });
    let first = true;
    await schedules.save({
      next: (from) => {
        const occurrence = first ? 0 : from.getTime() + 1_000_000;
        first = false;
        return new Date(occurrence);
      },
      target: { agent: 'assistant', input: 'Go!' },
    });

    const ticker = schedules.startTicker({ intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(350); // 三拍:首拍触发并卡在工具里,后两拍跳过
    expect(firings).toBe(1);

    gate.resolve();
    await vi.advanceTimersByTimeAsync(200); // 首拍离开并重排到远期
    ticker.stop();
    expect(firings).toBe(1);
  });

  it('intervalMs 非正数显式抛错', () => {
    const schedules = createSchedules({ agents: { assistant: assistant(fakeModel([])) } });

    expect(() => schedules.startTicker({ intervalMs: 0 })).toThrow(/intervalMs/);
    expect(() => schedules.startTicker({ intervalMs: -1 })).toThrow(/intervalMs/);
    expect(() => schedules.startTicker({ intervalMs: Number.NaN })).toThrow(/intervalMs/);
  });
});
