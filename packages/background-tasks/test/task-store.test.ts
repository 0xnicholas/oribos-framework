import { describe, expect, it } from 'vitest';
import { createInMemoryTaskStore } from '@oribos/background-tasks';
import type { TaskRecord } from '@oribos/background-tasks';

/**
 * TaskStore port(#190 冻结表面):包自有、JSON-only,`save / get / list / delete` 四方法家族
 * (checkpoints store 先例);`createInMemoryTaskStore()` 默认,持久实现归部署方。
 */

/** 一行任务记录:显式字段 + 可选字段的条件铺开(exactOptionalPropertyTypes 下不沾 undefined)。 */
function record(
  id: string,
  extra: {
    status?: TaskRecord['status'];
    attempt?: number;
    result?: unknown;
    settledAt?: string;
  } = {},
): TaskRecord {
  return {
    id,
    status: extra.status ?? 'accepted',
    payload: { kind: 'report' },
    attempt: extra.attempt ?? 0,
    createdAt: '2026-10-15T00:00:00.000Z',
    ...(extra.result === undefined ? {} : { result: extra.result }),
    ...(extra.settledAt === undefined ? {} : { settledAt: extra.settledAt }),
  };
}

describe('createInMemoryTaskStore', () => {
  it('save → get 原样读回', async () => {
    const store = createInMemoryTaskStore();
    const saved = record('t-1', {
      status: 'done',
      attempt: 1,
      result: { url: 'https://reports.example/t-1' },
      settledAt: '2026-10-15T00:00:01.000Z',
    });
    await store.save(saved);
    expect(await store.get('t-1')).toEqual(saved);
  });

  it('get 未知 id 返回 null', async () => {
    const store = createInMemoryTaskStore();
    expect(await store.get('nope')).toBeNull();
  });

  it('save 同 id 即 upsert(整行替换)', async () => {
    const store = createInMemoryTaskStore();
    await store.save(record('t-1'));
    await store.save(record('t-1', { status: 'running', attempt: 1 }));
    expect((await store.get('t-1'))?.status).toBe('running');
  });

  it('读写都是深拷贝:改传入对象不影响已存行,改读回对象不影响存储', async () => {
    const store = createInMemoryTaskStore();
    const saved = record('t-1');
    await store.save(saved);
    (saved.payload as { kind: string }).kind = 'mutated';
    expect((await store.get('t-1'))?.payload).toEqual({ kind: 'report' });
    const read = await store.get('t-1');
    (read!.payload as { kind: string }).kind = 'mutated-again';
    expect((await store.get('t-1'))?.payload).toEqual({ kind: 'report' });
  });

  it('list 按写入序返回全部行,且同样是拷贝', async () => {
    const store = createInMemoryTaskStore();
    await store.save(record('a'));
    await store.save(record('b'));
    const rows = await store.list();
    expect(rows.map((row) => row.id)).toEqual(['a', 'b']);
    (rows[0]!.payload as { kind: string }).kind = 'mutated';
    expect((await store.list())[0]!.payload).toEqual({ kind: 'report' });
  });

  it('delete 移除行,未知 id 无害', async () => {
    const store = createInMemoryTaskStore();
    await store.save(record('t-1'));
    await store.delete('t-1');
    expect(await store.get('t-1')).toBeNull();
    await expect(store.delete('t-1')).resolves.toBeUndefined();
  });
});
