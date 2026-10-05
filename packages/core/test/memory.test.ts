import { describe, expect, it } from 'vitest';
import { Memory, createInMemoryStore } from '@oribos/core/memory';
import type { SaveMessage } from '@oribos/core/memory';
import { captureError, captureRejection } from './helpers/assertions.js';

/**
 * `Memory` 类的消息历史机制(#39,docs/architecture/memory.md 消息历史节 + 配置表面节):
 * recall 单一查询入口、save 的信封生成归属、lastMessages 窗口(只按条数截断)、
 * thread 不存在时自动创建。断言只走公开面 —— Memory 实例方法;thread 状态经注入的 store port
 * 观察(注入的 store 是调用方自己的对象,不是实现内部)。
 */

function userMessage(text: string): SaveMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

describe('save → recall 往返', () => {
  it('save 落库后 recall 读回;threadId / resourceId 由调用参数盖章(不取调用方填的信封)', async () => {
    const memory = new Memory();

    const saved = await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [userMessage('hello')],
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]?.threadId).toBe('thread-1');
    expect(saved[0]?.resourceId).toBe('user-1');
    expect(saved[0]?.content).toEqual([{ type: 'text', text: 'hello' }]);

    // recall 返回的就是落库的那条(带完整信封,可直接喂模型)
    await expect(memory.recall({ threadId: 'thread-1' })).resolves.toEqual(saved);
  });
});

describe('save 的信封生成归属', () => {
  it('缺省的 id / createdAt 由 Memory 生成(id 唯一,createdAt 按 save 顺序递增)', async () => {
    const memory = new Memory();

    const saved = await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [userMessage('one'), userMessage('two'), userMessage('three')],
    });

    const ids = saved.map((message) => message.id);
    expect(ids.every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(3);
    expect(saved.every((message) => message.createdAt instanceof Date)).toBe(true);

    // 同批消息的时间戳严格递增:recall 的顺序 = save 的顺序(时间戳同刻会退到 id 平局,顺序不再可控)
    const times = saved.map((message) => message.createdAt.getTime());
    expect(times[1]).toBeGreaterThan(times[0] as number);
    expect(times[2]).toBeGreaterThan(times[1] as number);
  });

  it('调用方给的 id / createdAt 原样持久化(调用方是时间戳的主人)', async () => {
    const memory = new Memory();
    const createdAt = new Date(1_700_000_000_000);

    await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [{ ...userMessage('pinned'), id: 'm-1', createdAt }],
    });

    const [message] = await memory.recall({ threadId: 'thread-1' });
    expect(message?.id).toBe('m-1');
    expect(message?.createdAt).toEqual(createdAt);
  });

  it('消息顺序 = save 顺序:同批与跨批(连续 save)都按时间正序读回', async () => {
    const memory = new Memory();

    await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [userMessage('a'), userMessage('b')],
    });
    await memory.save({ thread: 'thread-1', resource: 'user-1', messages: [userMessage('c')] });

    const contents = (await memory.recall({ threadId: 'thread-1' })).map((message) =>
      message.content,
    );
    expect(contents).toEqual([
      [{ type: 'text', text: 'a' }],
      [{ type: 'text', text: 'b' }],
      [{ type: 'text', text: 'c' }],
    ]);
  });
});

describe('lastMessages 窗口', () => {
  it('recall 不带 limit 时取最近 lastMessages 条(默认 10),按时间正序', async () => {
    const memory = new Memory();
    const messages = Array.from({ length: 12 }, (_, index) => userMessage(`m${index + 1}`));
    await memory.save({ thread: 'thread-1', resource: 'user-1', messages });

    const recalled = await memory.recall({ threadId: 'thread-1' });

    expect(recalled).toHaveLength(10);
    // 窗口锚定最新端:丢掉的是最旧两条,不是最新两条
    expect(recalled.map((message) => message.content[0])).toEqual(
      messages.slice(2).map((message) => message.content[0]),
    );
  });

  it('lastMessages 可在构造时改;窗口只按条数截断,与消息内容无关', async () => {
    const memory = new Memory({ lastMessages: 2 });
    expect(memory.lastMessages).toBe(2);

    await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: [userMessage('m1'), userMessage('m2'), userMessage('m3')],
    });

    const recalled = await memory.recall({ threadId: 'thread-1' });
    expect(recalled.map((message) => message.content[0])).toEqual([
      { type: 'text', text: 'm2' },
      { type: 'text', text: 'm3' },
    ]);
  });
});

describe('recall 的分页与排序', () => {
  async function seedHistory(memory: Memory): Promise<void> {
    await memory.save({
      thread: 'thread-1',
      resource: 'user-1',
      messages: ['m1', 'm2', 'm3', 'm4', 'm5'].map((id) => ({
        ...userMessage(id),
        id,
        createdAt: new Date(1_700_000_000_000 + Number(id.slice(1)) * 1_000),
      })),
    });
  }

  it('before 游标向更旧翻页,与 order 无关;翻页在窗口之内', async () => {
    const memory = new Memory({ lastMessages: 2 });
    await seedHistory(memory);

    const olderAsc = await memory.recall({ threadId: 'thread-1', before: 'm4' });
    expect(olderAsc.map((message) => message.id)).toEqual(['m2', 'm3']);

    const olderDesc = await memory.recall({ threadId: 'thread-1', before: 'm4', order: 'desc' });
    expect(olderDesc.map((message) => message.id)).toEqual(['m3', 'm2']);
  });

  it('显式 limit 覆盖窗口;order: desc 只翻转呈现(限量仍锚定最新端)', async () => {
    const memory = new Memory();
    await seedHistory(memory);

    const wide = await memory.recall({ threadId: 'thread-1', limit: 4 });
    expect(wide.map((message) => message.id)).toEqual(['m2', 'm3', 'm4', 'm5']);

    const descending = await memory.recall({ threadId: 'thread-1', limit: 2, order: 'desc' });
    expect(descending.map((message) => message.id)).toEqual(['m5', 'm4']);
  });

  it('recall 不写:未知 thread 读作空历史,不自动建 thread', async () => {
    const store = createInMemoryStore();
    const memory = new Memory({ storage: store });

    await expect(memory.recall({ threadId: 'nope' })).resolves.toEqual([]);
    await expect(store.getThreadById('nope')).resolves.toBeNull();
  });

  it('lastMessages 与 recall 的 limit 都必须是正整数,显式报错', async () => {
    expect(captureError(() => new Memory({ lastMessages: 0 })).message).toContain('lastMessages');
    expect(captureError(() => new Memory({ lastMessages: 1.5 })).message).toContain(
      'lastMessages',
    );

    const memory = new Memory();
    const badLimit = await captureRejection(() =>
      memory.recall({ threadId: 'thread-1', limit: 0 }),
    );
    expect(badLimit.message).toContain('limit');
  });
});

describe('thread 生命周期(自动创建 / ref 元数据 / 归属)', () => {
  it('save 到不存在的 thread 时自动创建(id + resourceId 来自调用;空 messages 也建)', async () => {
    const store = createInMemoryStore();
    const memory = new Memory({ storage: store });

    await memory.save({ thread: 'thread-1', resource: 'user-1', messages: [] });

    const thread = await store.getThreadById('thread-1');
    expect(thread?.resourceId).toBe('user-1');
    expect(thread?.title).toBeUndefined();
    expect(thread?.createdAt).toEqual(thread?.updatedAt);
  });

  it('新建时带上 ref 的 title / metadata', async () => {
    const store = createInMemoryStore();
    const memory = new Memory({ storage: store });

    await memory.save({
      thread: { id: 'thread-1', title: '新会话', metadata: { source: 'test' } },
      resource: 'user-1',
      messages: [userMessage('hi')],
    });

    const thread = await store.getThreadById('thread-1');
    expect(thread?.title).toBe('新会话');
    expect(thread?.metadata).toEqual({ source: 'test' });
  });

  it('已存在的 thread:ref 提供了就更新,未提供保持;createdAt 不变,updatedAt 随落库刷新', async () => {
    const store = createInMemoryStore();
    const memory = new Memory({ storage: store });
    const long = new Date(1_700_000_000_000);
    await store.saveThread({
      id: 'thread-1',
      resourceId: 'user-1',
      title: '旧标题',
      metadata: { keep: true },
      createdAt: long,
      updatedAt: long,
    });

    await memory.save({ thread: 'thread-1', resource: 'user-1', messages: [userMessage('a')] });
    const kept = await store.getThreadById('thread-1');
    expect(kept?.title).toBe('旧标题');
    expect(kept?.metadata).toEqual({ keep: true });
    expect(kept?.createdAt).toEqual(long);
    expect(kept?.updatedAt.getTime()).toBeGreaterThan(long.getTime());

    const renamed = await memory.save({
      thread: { id: 'thread-1', title: '新标题' },
      resource: 'user-1',
      messages: [userMessage('b')],
    });
    expect(renamed).toHaveLength(1);
    const renamedThread = await store.getThreadById('thread-1');
    expect(renamedThread?.title).toBe('新标题');
    expect(renamedThread?.metadata).toEqual({ keep: true });
    expect(renamedThread?.createdAt).toEqual(long);
  });

  it('resource 对不上是显式报错(不做所有权迁移),且什么都不写', async () => {
    const store = createInMemoryStore();
    const memory = new Memory({ storage: store });
    await memory.save({ thread: 'thread-1', resource: 'user-1', messages: [userMessage('a')] });

    const failure = await captureRejection(() =>
      memory.save({ thread: 'thread-1', resource: 'user-2', messages: [userMessage('b')] }),
    );
    expect(failure.message).toContain('thread-1');
    expect(failure.message).toContain('user-2');

    const thread = await store.getThreadById('thread-1');
    expect(thread?.resourceId).toBe('user-1');
    await expect(store.listMessages({ threadId: 'thread-1' })).resolves.toHaveLength(1);
  });
});

describe('同 thread 并发写(#131)', () => {
  it('并发 save 同一 thread:不丢消息、按调用序读回;另一 thread 的并发写不串', async () => {
    const store = createInMemoryStore();
    const memory = new Memory({ storage: store });

    // 「非事务 read-modify-write」口径(memory.md 工作记忆节的同一措辞,消息历史的 save 同形):
    // save 内部的 ensureThread(getThreadById → saveThread)不是事务——并发首写同一新 thread
    // 时各写者都读到 null、都 upsert 同内容的 thread 记录,last-write-wins 只落在 thread 的
    // updatedAt 等字段上;消息侧 saveMessages 按唯一 id 落库。本用例钉住的正是这条边界——
    // 不丢消息、不串 thread——而不是更强的隔离级别。
    // 顺序可断言的原因:save 在首个 await 之前同步生成 id / createdAt,故并发 save 的信封
    // 顺序 = 调用序,recall 按 createdAt 正序读回即调用序。
    const textsA = Array.from({ length: 8 }, (_, index) => `a-${index}`);
    const textsB = Array.from({ length: 8 }, (_, index) => `b-${index}`);
    const interleaved = textsA.flatMap((text, index) => [
      { thread: 'thread-1', text },
      { thread: 'thread-2', text: textsB[index]! },
    ]);
    await Promise.all(
      interleaved.map(({ thread, text }) =>
        memory.save({ thread, resource: 'user-1', messages: [userMessage(text)] }),
      ),
    );

    // 不丢消息:16 条全部落库;不串 thread:各自 recall 只见自己的,按调用序
    const thread1 = await memory.recall({ threadId: 'thread-1', limit: 100 });
    const thread2 = await memory.recall({ threadId: 'thread-2', limit: 100 });
    expect(thread1.map((message) => message.content)).toEqual(
      textsA.map((text) => [{ type: 'text', text }]),
    );
    expect(thread2.map((message) => message.content)).toEqual(
      textsB.map((text) => [{ type: 'text', text }]),
    );
    // 信封由各自调用盖章;16 个 id 互不相同(不丢是真不丢,不是 upsert 撞 id 恰好蒙对)
    expect(
      thread1.every((message) => message.threadId === 'thread-1' && message.resourceId === 'user-1'),
    ).toBe(true);
    expect(
      thread2.every((message) => message.threadId === 'thread-2' && message.resourceId === 'user-1'),
    ).toBe(true);
    expect(new Set([...thread1, ...thread2].map((message) => message.id)).size).toBe(16);

    // thread 记录:两个 thread 各一条,归属 user-1(并发首写不产生重复或错配)
    expect((await store.getThreadById('thread-1'))?.resourceId).toBe('user-1');
    expect((await store.getThreadById('thread-2'))?.resourceId).toBe('user-1');
  });
});
