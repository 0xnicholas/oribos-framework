import { describe, expect, it, vi } from 'vitest';
import {
  createBackgroundTasks,
  createInMemoryLeaseStore,
  createInMemoryTaskStore,
} from '@oribos/background-tasks';
import type { TaskLease } from '@oribos/background-tasks';

/**
 * manager 公开表面(#190 冻结表面):`createBackgroundTasks({ store?, lease?, heartbeatMs?, onSettle? })`
 * ——`submit({ payload, run })` 落行 accepted → 领租约 → running → 进程内调 run(handler)→ settle;
 * `get` / `list` 行读;`adopt()` 孤儿重跑;`untilIdle()` 包级等待。此处先钉提交 → 执行 → settle 的时序。
 */

describe('createBackgroundTasks — 提交 → 执行 → settle', () => {
  it('时序:submit 即回 accepted;执行中被读为 running;settle 落 done(attempt 1、result、settledAt)', async () => {
    const tasks = createBackgroundTasks();
    let releaseWork!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const record = await tasks.submit({
      payload: { kind: 'revenue' },
      run: async (payload) => {
        await gate;
        return { url: `https://reports.example/${payload.kind}` };
      },
    });

    // submit 返回的是落行快照:accepted、attempt 0 —— ack 即回,不等执行。
    expect(record.status).toBe('accepted');
    expect(record.attempt).toBe(0);

    // 执行已在进行:行被翻成 running(attempt 1)。
    await vi.waitFor(async () => {
      expect((await tasks.get(record.id))?.status).toBe('running');
    });

    releaseWork();
    await vi.waitFor(async () => {
      expect((await tasks.get(record.id))?.status).toBe('done');
    });
    const settled = await tasks.get(record.id);
    expect(settled).toMatchObject({
      id: record.id,
      status: 'done',
      attempt: 1,
      payload: { kind: 'revenue' },
      result: { url: 'https://reports.example/revenue' },
    });
    expect(settled?.settledAt).toBeTypeOf('string');
  });

  it('handler 抛错 → failed,error 落行、result 缺席、attempt 1', async () => {
    const tasks = createBackgroundTasks();
    const record = await tasks.submit({
      payload: 'inventory',
      run: async () => {
        throw new Error('warehouse feed is down');
      },
    });
    await vi.waitFor(async () => {
      expect((await tasks.get(record.id))?.status).toBe('failed');
    });
    const settled = await tasks.get(record.id);
    expect(settled?.error).toBe('warehouse feed is down');
    expect(settled?.result).toBeUndefined();
    expect(settled?.attempt).toBe(1);
  });
});

describe('createBackgroundTasks — onSettle 与 untilIdle', () => {
  it('onSettle:成功与失败同门,各收到一次落定后的记录(status / result / error 在场)', async () => {
    const settled: { id: string; status: string; result?: unknown; error?: string }[] = [];
    const tasks = createBackgroundTasks({
      onSettle: (record) => {
        settled.push(record);
      },
    });
    const done = await tasks.submit({
      payload: 'revenue',
      run: async () => ({ url: 'https://reports.example/r-1' }),
    });
    const failed = await tasks.submit({
      payload: 'inventory',
      run: async () => {
        throw new Error('feed down');
      },
    });
    await tasks.untilIdle();
    expect(settled).toHaveLength(2);
    expect(settled.find((row) => row.id === done.id)).toMatchObject({
      status: 'done',
      result: { url: 'https://reports.example/r-1' },
    });
    expect(settled.find((row) => row.id === failed.id)).toMatchObject({
      status: 'failed',
      error: 'feed down',
    });
  });

  it('untilIdle:空载立即 resolve;有在跑的不 resolve,全部 settle 才 resolve', async () => {
    const tasks = createBackgroundTasks();
    await expect(tasks.untilIdle()).resolves.toBeUndefined();
    let releaseWork!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    await tasks.submit({
      payload: 1,
      run: async () => {
        await gate;
      },
    });
    await tasks.submit({ payload: 2, run: async () => 'done-2' });
    let idle = false;
    const waiting = tasks.untilIdle().then(() => {
      idle = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(idle).toBe(false);
    releaseWork();
    await waiting;
    expect(idle).toBe(true);
    expect((await tasks.list()).every((row) => row.status === 'done')).toBe(true);
  });

  it('onSettle 返回的 promise 被等到:untilIdle 覆盖 onSettle 完结,不是只覆盖 handler', async () => {
    let releaseSettle!: () => void;
    const settleGate = new Promise<void>((resolve) => {
      releaseSettle = resolve;
    });
    const tasks = createBackgroundTasks({
      onSettle: async () => {
        await settleGate;
      },
    });
    await tasks.submit({ payload: null, run: async () => 'ok' });
    let idle = false;
    const waiting = tasks.untilIdle().then(() => {
      idle = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(idle).toBe(false);
    releaseSettle();
    await waiting;
    expect(idle).toBe(true);
  });
});

describe('createBackgroundTasks — 租约:竞争失败方不作为、心跳、零定时器', () => {
  it('竞争失败方不作为:持有期间自 adopt 拿不走;无 handler 的 manager 只扫描、不执行', async () => {
    const store = createInMemoryTaskStore();
    const lease = createInMemoryLeaseStore();
    const tasks = createBackgroundTasks({ store, lease });
    let invocations = 0;
    let releaseWork!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const record = await tasks.submit({
      payload: null,
      run: async () => {
        invocations += 1;
        await gate;
        return 'ok';
      },
    });
    await vi.waitFor(async () => {
      expect((await tasks.get(record.id))?.status).toBe('running');
    });

    // 自己持着租约:adopt 的 acquire 拿不到,不作为。
    expect(await tasks.adopt()).toEqual([]);
    expect(invocations).toBe(1);

    // 另一 manager(同 store / 同 lease,但没有该行的 handler):扫到 running 行,同样不动它。
    const other = createBackgroundTasks({ store, lease });
    expect(await other.adopt()).toEqual([]);
    expect(invocations).toBe(1);
    expect((await other.get(record.id))?.attempt).toBe(1);

    releaseWork();
    await tasks.untilIdle();
    expect((await tasks.get(record.id))?.status).toBe('done');
  });

  it('心跳:配置 heartbeatMs 后执行期间按拍续约,TTL = 3 × heartbeatMs;settle 即释放', async () => {
    const renewals: number[] = [];
    const ttls: number[] = [];
    let released = 0;
    const inner = createInMemoryLeaseStore();
    const spy: TaskLease = {
      acquire: async (key, ttlMs) => {
        ttls.push(ttlMs);
        const handle = await inner.acquire(key, ttlMs);
        if (handle === null) return null;
        return {
          token: handle.token,
          renew: async (ttl) => {
            renewals.push(ttl);
            return handle.renew(ttl);
          },
          release: async () => {
            released += 1;
            return handle.release();
          },
        };
      },
    };
    const tasks = createBackgroundTasks({ lease: spy, heartbeatMs: 10 });
    const record = await tasks.submit({
      payload: null,
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 55));
        return 'ok';
      },
    });
    await tasks.untilIdle();
    expect(ttls).toEqual([30]); // acquire 的 TTL = 3 × heartbeatMs
    expect(renewals.length).toBeGreaterThanOrEqual(2); // 执行 55ms、心跳 10ms:至少两拍
    expect(released).toBe(1);
    expect((await tasks.get(record.id))?.status).toBe('done');
  });

  it('不配置 heartbeatMs = 零定时器;配置 = 执行期间恰一条 interval(handler 起跑时点读表)', async () => {
    vi.useFakeTimers();
    try {
      let timersOff = -1;
      const off = createBackgroundTasks();
      await off.submit({
        payload: null,
        run: async () => {
          timersOff = vi.getTimerCount();
          return 'ok';
        },
      });
      await off.untilIdle();
      expect(timersOff).toBe(0);

      let timersOn = -1;
      const on = createBackgroundTasks({ heartbeatMs: 50 });
      await on.submit({
        payload: null,
        run: async () => {
          timersOn = vi.getTimerCount();
          return 'ok';
        },
      });
      await on.untilIdle();
      expect(timersOn).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('createBackgroundTasks — 孤儿 adopt:租约过期仍 running → attempt+1 重跑', () => {
  it('死尝试占着 running 行;租约过期后 adopt 拿走并重跑,attempt 2 落定', async () => {
    let now = 0;
    const lease = createInMemoryLeaseStore({ now: () => now });
    const tasks = createBackgroundTasks({ lease });
    let invocations = 0;
    const record = await tasks.submit({
      payload: { kind: 'revenue' },
      run: async () => {
        invocations += 1;
        if (invocations === 1) {
          // 首跑死在途中:这次执行永不结算(进程崩塌的等价物),行留在 running。
          return new Promise<never>(() => {});
        }
        return { url: 'https://reports.example/r-1' };
      },
    });
    await vi.waitFor(async () => {
      expect((await tasks.get(record.id))?.status).toBe('running');
    });
    expect(invocations).toBe(1);

    // 租约还活着(持有期未过):adopt 拿不走,只扫描。
    expect(await tasks.adopt()).toEqual([]);
    expect((await tasks.get(record.id))?.attempt).toBe(1);

    // 时钟越过无心跳 TTL(30s):孤儿成立——adopt 领租约、attempt+1、重跑。
    now += 31_000;
    const adopted = await tasks.adopt();
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ id: record.id, status: 'running', attempt: 2 });

    await vi.waitFor(async () => {
      expect((await tasks.get(record.id))?.status).toBe('done');
    });
    const settled = await tasks.get(record.id);
    expect(settled).toMatchObject({ attempt: 2, result: { url: 'https://reports.example/r-1' } });
    expect(invocations).toBe(2);

    // 死尝试不阻塞包级等待:同一行的重跑结算即释放(按行计数,不是按执行链)。
    await expect(tasks.untilIdle()).resolves.toBeUndefined();
  });

  it('无孤儿时 adopt 返回空:已 settle 的行不再被扫', async () => {
    const tasks = createBackgroundTasks();
    await tasks.submit({ payload: null, run: async () => 'ok' });
    await tasks.untilIdle();
    expect(await tasks.adopt()).toEqual([]);
  });
});
