import { describe, expect, it } from 'vitest';
import { createInMemoryLeaseStore, createRedisLease } from '@oribos/lease';
import type { Lease, RedisLeaseClient } from '@oribos/lease';

/**
 * Lease 契约(ADR-0020 机制单源):`acquire(key, ttlMs) → LeaseHandle | null`,
 * `LeaseHandle = { token, renew(ttlMs): Promise<boolean>, release(): Promise<void> }`。
 * 竞争失败方拿 `null`;过期由推进时钟惰性判定;`renew` 延长 TTL、丢失后返回 `false`;
 * `release` 只删自己的租约。
 *
 * 行为矩阵只有一份,内存默认与 Redis 结构适配各跑一遍;Redis 侧另以结构假件按命令语义
 * 验证 `set(NX/PX)` 与 token 守卫的 Lua,不重复行为断言。
 */

/** 一次 `set` 调用的实参录制。 */
interface SetCall {
  readonly key: string;
  readonly value: string;
  readonly mode: 'PX';
  readonly ttlMs: number;
  readonly flag: 'NX';
}

/** 一次 `eval` 调用的实参录制。 */
interface EvalCall {
  readonly script: string;
  readonly numKeys: number;
  readonly key: string;
  readonly args: readonly string[];
}

/** 两个脚本共用的 token 守卫:值仍是本次 token 才执行后续命令。 */
const TOKEN_GUARD = 'redis.call("get", KEYS[1]) == ARGV[1]';

/** 一个真的按命令语义执行的迷你 Redis 假件:set(NX/PX) / pexpire / del / eval(token 比对)。 */
function fakeRedis() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const setCalls: SetCall[] = [];
  const evalCalls: EvalCall[] = [];
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
      setCalls.push({ key, value, mode, ttlMs, flag });
      if (mode !== 'PX' || flag !== 'NX') throw new Error(`fake: unsupported set form ${mode}/${flag}`);
      if (alive(key)) return Promise.resolve(null);
      store.set(key, { value, expiresAt: now + ttlMs });
      return Promise.resolve('OK');
    },
    async eval(script, numKeys, key, ...args) {
      evalCalls.push({ script, numKeys, key, args });
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
    setCalls,
    evalCalls,
  };
}

/** 一个适配器实例 + 它的时间推进器(内存用注入 clock,Redis 用假件时钟)。 */
interface LeaseFixture {
  readonly leases: Lease;
  advance(ms: number): void;
}

/** 一个被契约覆盖的适配器:名字进 suite 标题,工厂每次造一只新实例。 */
interface LeaseAdapter {
  readonly name: string;
  readonly makeFixture: () => LeaseFixture;
}

/** 契约跑两遍:离线默认与 Redis 结构适配。 */
const ADAPTERS: readonly LeaseAdapter[] = [
  {
    name: '内存默认',
    makeFixture: () => {
      let now = 0;
      return {
        leases: createInMemoryLeaseStore({ now: () => now }),
        advance(ms) {
          now += ms;
        },
      };
    },
  },
  {
    name: 'Redis 结构适配',
    makeFixture: () => {
      const fake = fakeRedis();
      return {
        leases: createRedisLease({ client: fake.client }),
        advance(ms) {
          fake.advance(ms);
        },
      };
    },
  },
];

describe.each(ADAPTERS)('Lease 契约 — $name', ({ makeFixture }) => {
  it('acquire 空闲 key 得到 handle 与 token;竞争者得到 null', async () => {
    const { leases } = makeFixture();
    const first = await leases.acquire('k1', 1_000);
    expect(first).not.toBeNull();
    expect(first!.token).not.toBe('');
    expect(await leases.acquire('k1', 1_000)).toBeNull();
  });

  it('TTL 到期后 key 腾出(惰性过期),旧 handle 的 renew 返回 false', async () => {
    const { leases, advance } = makeFixture();
    const handle = await leases.acquire('k1', 1_000);
    advance(2_000);
    expect(await leases.acquire('k1', 1_000)).not.toBeNull();
    await expect(handle!.renew(1_000)).resolves.toBe(false);
  });

  it('renew 延长 TTL:原到期点之后仍持有,延长点之后才腾出', async () => {
    const { leases, advance } = makeFixture();
    const handle = await leases.acquire('k1', 1_000);
    advance(900);
    await expect(handle!.renew(1_000)).resolves.toBe(true);
    advance(600);
    expect(await leases.acquire('k1', 1_000)).toBeNull();
    advance(500);
    expect(await leases.acquire('k1', 1_000)).not.toBeNull();
  });

  it('过期后被别人领走:旧 handle 的 renew 返回 false,且不延长新租约', async () => {
    const { leases, advance } = makeFixture();
    const stale = await leases.acquire('k1', 1_000);
    advance(1_500);
    expect(await leases.acquire('k1', 1_000)).not.toBeNull();
    await expect(stale!.renew(5_000)).resolves.toBe(false);
    advance(1_100);
    expect(await leases.acquire('k1', 1_000)).not.toBeNull();
  });

  it('过期后被别人领走:旧 handle 的 release 不删除新租约', async () => {
    const { leases, advance } = makeFixture();
    const stale = await leases.acquire('k1', 1_000);
    advance(1_500);
    const current = await leases.acquire('k1', 1_000);
    expect(current).not.toBeNull();
    await stale!.release();
    // 外来 release 无副作用:新持有者仍在,且 token 仍然有效。
    expect(await leases.acquire('k1', 1_000)).toBeNull();
    await expect(current!.renew(1_000)).resolves.toBe(true);
  });

  it('release 释放后可再领;旧 handle 的 renew 返回 false、release 无害', async () => {
    const { leases } = makeFixture();
    const handle = await leases.acquire('k1', 1_000);
    await handle!.release();
    const next = await leases.acquire('k1', 1_000);
    expect(next).not.toBeNull();
    await expect(handle!.renew(1_000)).resolves.toBe(false);
    await expect(handle!.release()).resolves.toBeUndefined();
    // 已释放的旧 handle 再 release 也不删新持有者的租约。
    expect(await leases.acquire('k1', 1_000)).toBeNull();
  });

  it('不同 key 互不干扰', async () => {
    const { leases } = makeFixture();
    expect(await leases.acquire('a', 1_000)).not.toBeNull();
    expect(await leases.acquire('b', 1_000)).not.toBeNull();
  });
});

describe('Redis 结构适配的命令面', () => {
  /** 一只已领到 `k1` 的 Redis 适配器,连同假件与 handle(命令面断言只看调用形状)。 */
  async function acquired() {
    const fake = fakeRedis();
    const leases = createRedisLease({ client: fake.client });
    const handle = await leases.acquire('k1', 5_000);
    return { fake, handle: handle! };
  }

  it("acquire 以 set(key, token, 'PX', ttlMs, 'NX') 写入本次 token", async () => {
    const { fake, handle } = await acquired();
    expect(fake.setCalls).toEqual([
      { key: 'k1', value: handle.token, mode: 'PX', ttlMs: 5_000, flag: 'NX' },
    ]);
  });

  it('renew 走 token 守卫的 Lua:GET 比对后 PEXPIRE 新 TTL', async () => {
    const { fake, handle } = await acquired();
    await expect(handle.renew(3_000)).resolves.toBe(true);
    const call = fake.evalCalls.at(-1)!;
    expect(call).toMatchObject({ numKeys: 1, key: 'k1', args: [handle.token, '3000'] });
    expect(call.script).toContain(TOKEN_GUARD);
    expect(call.script).toContain('redis.call("pexpire", KEYS[1], ARGV[2])');
  });

  it('release 走 token 守卫的 Lua:GET 比对后 DEL', async () => {
    const { fake, handle } = await acquired();
    await handle.release();
    const call = fake.evalCalls.at(-1)!;
    expect(call).toMatchObject({ numKeys: 1, key: 'k1', args: [handle.token] });
    expect(call.script).toContain(TOKEN_GUARD);
    expect(call.script).toContain('redis.call("del", KEYS[1])');
  });
});
