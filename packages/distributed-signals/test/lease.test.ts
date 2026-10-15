import { describe, expect, it } from 'vitest';
import { createInMemoryLeaseStore, createRedisLease } from '@oribos/distributed-signals';
import type { RedisLeaseClient } from '@oribos/distributed-signals';

/**
 * SignalLease port(#187 冻结表面):`acquire(key, ttlMs) → LeaseHandle | null`,
 * `LeaseHandle = { token, renew(ttlMs): Promise<boolean>, release(): Promise<void> }`。
 * 租约 = thread 活跃 run 所有权——唤醒竞态的裁定者。内存默认;`createRedisLease(client)`
 * 走 `set(NX/PX)` / `eval` 结构子集(客户端随调用方)。
 */

/** 一个真的按命令语义执行的迷你 Redis 假件:set(NX/PX) / pexpire / del / eval(token 比对)。 */
function fakeRedisLease() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  let now = 1_000_000;
  const alive = (key: string) => {
    const entry = store.get(key);
    if (entry === undefined) return false;
    if (entry.expiresAt <= now) {
      store.delete(key);
      return false;
    }
    return true;
  };
  const client: RedisLeaseClient = {
    set(key, value, mode, ttlMs, flag) {
      if (mode !== 'PX' || flag !== 'NX') throw new Error(`fake: unsupported set form ${mode}/${flag}`);
      if (alive(key)) return Promise.resolve(null);
      store.set(key, { value, expiresAt: now + ttlMs });
      return Promise.resolve('OK');
    },
    async eval(script, numKeys, key, ...args) {
      if (numKeys !== 1) throw new Error('fake: eval expects one key');
      if (!alive(key)) return 0;
      const entry = store.get(key)!;
      if (script.includes('pexpire')) {
        if (entry.value !== args[0]) return 0;
        entry.expiresAt = now + Number(args[1]);
        return 1;
      }
      if (script.includes('del')) {
        if (entry.value !== args[0]) return 0;
        store.delete(key);
        return 1;
      }
      throw new Error('fake: unknown script');
    },
  };
  return {
    client,
    /** 推进假时钟,让 TTL 到期。 */
    advance(ms: number): void {
      now += ms;
    },
    held(key: string): string | undefined {
      return alive(key) ? store.get(key)!.value : undefined;
    },
  };
}

describe('createInMemoryLeaseStore', () => {
  it('acquire 空闲 key 拿到 handle,竞争者拿 null', async () => {
    const leases = createInMemoryLeaseStore();
    const first = await leases.acquire('t1', 1_000);
    expect(first).not.toBeNull();
    expect(first!.token).not.toBe('');
    const second = await leases.acquire('t1', 1_000);
    expect(second).toBeNull();
  });

  it('release 释放后 key 可再被领', async () => {
    const leases = createInMemoryLeaseStore();
    const handle = await leases.acquire('t1', 1_000);
    await handle!.release();
    expect(await leases.acquire('t1', 1_000)).not.toBeNull();
  });

  it('TTL 过期后自动腾出(惰性检查),旧 handle 的 renew 变 false', async () => {
    let now = 0;
    const leases = createInMemoryLeaseStore({ now: () => now });
    const handle = await leases.acquire('t1', 1_000);
    now = 2_000;
    expect(await leases.acquire('t1', 1_000)).not.toBeNull();
    await expect(handle!.renew(1_000)).resolves.toBe(false);
  });

  it('renew 由持有者调用刷新租期并返回 true', async () => {
    const leases = createInMemoryLeaseStore();
    const handle = await leases.acquire('t1', 1_000);
    await expect(handle!.renew(1_000)).resolves.toBe(true);
  });

  it('release 之后的旧 handle:renew false、release 无害', async () => {
    const leases = createInMemoryLeaseStore();
    const handle = await leases.acquire('t1', 1_000);
    await handle!.release();
    await expect(handle!.renew(1_000)).resolves.toBe(false);
    await expect(handle!.release()).resolves.toBeUndefined();
  });

  it('不同 key 互不干扰', async () => {
    const leases = createInMemoryLeaseStore();
    expect(await leases.acquire('a', 1_000)).not.toBeNull();
    expect(await leases.acquire('b', 1_000)).not.toBeNull();
  });
});

describe('createRedisLease', () => {
  it('acquire 走 set(NX/PX):空闲得 handle,被占返回 null', async () => {
    const fake = fakeRedisLease();
    const leases = createRedisLease({ client: fake.client });
    const first = await leases.acquire('t1', 5_000);
    expect(first).not.toBeNull();
    expect(fake.held('t1')).toBe(first!.token);
    expect(await leases.acquire('t1', 5_000)).toBeNull();
  });

  it('TTL 到期后 key 腾出(NX 语义)', async () => {
    const fake = fakeRedisLease();
    const leases = createRedisLease({ client: fake.client });
    await leases.acquire('t1', 5_000);
    fake.advance(6_000);
    expect(await leases.acquire('t1', 5_000)).not.toBeNull();
  });

  it('renew 由持有者调用刷新并返回 true;过期/被占后返回 false', async () => {
    const fake = fakeRedisLease();
    const leases = createRedisLease({ client: fake.client });
    const handle = await leases.acquire('t1', 5_000);
    await expect(handle!.renew(5_000)).resolves.toBe(true);
    fake.advance(6_000);
    await expect(handle!.renew(5_000)).resolves.toBe(false);
    // 过期后的旧 handle release 不复活别人的租约
    await handle!.release();
    expect(fake.held('t1')).toBeUndefined();
  });

  it('release 只删自己的租约:token 不符不删', async () => {
    const fake = fakeRedisLease();
    const leases = createRedisLease({ client: fake.client });
    const handle = await leases.acquire('t1', 5_000);
    fake.advance(6_000);
    const second = await leases.acquire('t1', 5_000);
    await handle!.release();
    expect(fake.held('t1')).toBe(second!.token);
    await second!.release();
    expect(fake.held('t1')).toBeUndefined();
  });
});
