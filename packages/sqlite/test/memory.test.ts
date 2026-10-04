/**
 * `MemoryStore` behavior, mirroring the in-memory reference's pinned semantics
 * (`packages/core/src/memory/in-memory-store.ts`) across the serializing boundary: ordering and
 * cursor rules, `limit` anchoring, upserts, the date/JSON encodings, the NULL-vs-`'null'`
 * distinction, the working-memory capability flag, and the one adapter-owned divergence — the
 * `messages` foreign key that the reference does not have.
 */
import { describe, expect, it } from 'vitest';
import { supportsWorkingMemory } from '@oribos/core/memory';
import type { StoredMessage, StoredThread } from '@oribos/core/memory';
import type { SqliteStorage } from '@oribos/sqlite';
import { caught, memoryStorage, messageOf } from './helpers.js';

function thread(
  id: string,
  options: { resourceId?: string; updatedAt?: number; title?: string } = {},
): StoredThread {
  return {
    id,
    resourceId: options.resourceId ?? 'r1',
    ...(options.title === undefined ? {} : { title: options.title }),
    createdAt: new Date(options.updatedAt ?? 0),
    updatedAt: new Date(options.updatedAt ?? 0),
  };
}

function message(
  id: string,
  threadId: string,
  createdAt: number,
  text = id,
  resourceId = 'r1',
): StoredMessage {
  return {
    id,
    threadId,
    resourceId,
    createdAt: new Date(createdAt),
    role: 'user',
    content: [{ type: 'text', text }],
  };
}

/** The standard fixture: four threads of one resource (two with the same timestamp), one other. */
async function seedThreads(storage: SqliteStorage): Promise<void> {
  await storage.memory.saveThread(thread('t1', { updatedAt: 100 }));
  await storage.memory.saveThread(thread('t2', { updatedAt: 300 }));
  await storage.memory.saveThread(thread('t3', { updatedAt: 300 }));
  await storage.memory.saveThread(thread('t4', { updatedAt: 200 }));
  await storage.memory.saveThread(thread('other', { resourceId: 'r2', updatedAt: 400 }));
}

/** Four messages of one thread (two sharing a timestamp), one of another thread. */
async function seedMessages(storage: SqliteStorage): Promise<void> {
  await storage.memory.saveThread(thread('th1'));
  await storage.memory.saveThread(thread('th2'));
  await storage.memory.saveMessages([
    message('m1', 'th1', 100),
    message('m2', 'th1', 300),
    message('m3', 'th1', 300),
    message('m4', 'th1', 200),
    message('m5', 'th2', 400),
  ]);
}

describe('memory threads', () => {
  it('returns null for an absent thread and round-trips a full record through INTEGER ms and JSON', async () => {
    const storage = memoryStorage();
    expect(await storage.memory.getThreadById('none')).toBeNull();

    const stored: StoredThread = {
      id: 't',
      resourceId: 'r',
      title: 'A conversation',
      metadata: { nested: { a: [1, 2, 3] }, flag: true },
      createdAt: new Date(1_700_000_000_123),
      updatedAt: new Date(1_700_000_000_456),
    };
    await storage.memory.saveThread(stored);

    const loaded = await storage.memory.getThreadById('t');
    expect(loaded).toEqual(stored);
    expect(loaded?.createdAt).toBeInstanceOf(Date);
    expect(loaded?.createdAt.getTime()).toBe(1_700_000_000_123);
  });

  it('omits optional fields that were absent instead of returning undefined-valued keys', async () => {
    const storage = memoryStorage();
    await storage.memory.saveThread(thread('bare'));
    const loaded = await storage.memory.getThreadById('bare');
    expect(loaded).not.toBeNull();
    expect(Object.hasOwn(loaded as StoredThread, 'title')).toBe(false);
    expect(Object.hasOwn(loaded as StoredThread, 'metadata')).toBe(false);
  });

  it('upserts the whole record by id', async () => {
    const storage = memoryStorage();
    await storage.memory.saveThread(thread('t', { title: 'first' }));
    await storage.memory.saveThread({
      id: 't',
      resourceId: 'r2',
      title: 'second',
      metadata: { version: 2 },
      createdAt: new Date(5),
      updatedAt: new Date(7),
    });
    expect(await storage.memory.getThreadById('t')).toEqual({
      id: 't',
      resourceId: 'r2',
      title: 'second',
      metadata: { version: 2 },
      createdAt: new Date(5),
      updatedAt: new Date(7),
    });
  });

  it('lists one resource newest-first with the id tie-break and a newest-anchored limit', async () => {
    const storage = memoryStorage();
    await seedThreads(storage);

    expect((await storage.memory.listThreads({ resourceId: 'r1' })).map((t) => t.id)).toEqual([
      't3',
      't2',
      't4',
      't1',
    ]);
    expect(
      (await storage.memory.listThreads({ resourceId: 'r1', limit: 2 })).map((t) => t.id),
    ).toEqual(['t3', 't2']);
  });

  it('continues strictly past a before cursor and throws on dangling or foreign cursors', async () => {
    const storage = memoryStorage();
    await seedThreads(storage);

    expect(
      (await storage.memory.listThreads({ resourceId: 'r1', before: 't2' })).map((t) => t.id),
    ).toEqual(['t4', 't1']);
    expect(
      (await storage.memory.listThreads({ resourceId: 'r1', before: 't2', limit: 1 })).map(
        (t) => t.id,
      ),
    ).toEqual(['t4']);

    expect(
      messageOf(await caught(storage.memory.listThreads({ resourceId: 'r1', before: 'dangling' }))),
    ).toBe("memory.listThreads: before cursor 'dangling' is not a thread in this store");
    expect(
      messageOf(await caught(storage.memory.listThreads({ resourceId: 'r1', before: 'other' }))),
    ).toBe("memory.listThreads: before cursor 'other' is not a thread in this store");
    for (const limit of [0, -1, 1.5]) {
      expect(
        messageOf(await caught(storage.memory.listThreads({ resourceId: 'r1', limit }))),
        `limit ${limit}`,
      ).toBe(`memory.listThreads: limit must be a positive integer, got ${limit}`);
    }
  });

  it('cascades message deletion with the thread and leaves resources untouched', async () => {
    const storage = memoryStorage();
    await seedMessages(storage);
    await storage.memory.saveResource({
      id: 'r1',
      workingMemory: { note: 'keep me' },
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });

    await storage.memory.deleteThread('th1');
    expect(await storage.memory.listMessages({ threadId: 'th1' })).toEqual([]);
    expect((await storage.memory.listMessages({ threadId: 'th2' })).map((m) => m.id)).toEqual([
      'm5',
    ]);
    expect((await storage.memory.getResource('r1'))?.workingMemory).toEqual({ note: 'keep me' });

    await storage.memory.deleteThread('th1');
  });
});

describe('memory messages', () => {
  it('round-trips the message body plus its storage envelope', async () => {
    const storage = memoryStorage();
    await storage.memory.saveThread(thread('th1'));
    const assistant: StoredMessage = {
      id: 'm',
      threadId: 'th1',
      resourceId: 'r1',
      createdAt: new Date(42),
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'weather', input: { city: 'Paris' } },
      ],
      providerOptions: { openai: { reasoningEffort: 'low' } },
    };
    await storage.memory.saveMessages([assistant]);

    expect(await storage.memory.listMessages({ threadId: 'th1' })).toEqual([assistant]);
  });

  it('orders newest-first by default, asc flips presentation only, and limit anchors the newest end', async () => {
    const storage = memoryStorage();
    await seedMessages(storage);

    expect((await storage.memory.listMessages({ threadId: 'th1' })).map((m) => m.id)).toEqual([
      'm3',
      'm2',
      'm4',
      'm1',
    ]);
    expect(
      (await storage.memory.listMessages({ threadId: 'th1', order: 'asc' })).map((m) => m.id),
    ).toEqual(['m1', 'm4', 'm2', 'm3']);
    // The newest two, only the presentation flipped — never the oldest two.
    expect(
      (await storage.memory.listMessages({ threadId: 'th1', limit: 2, order: 'asc' })).map(
        (m) => m.id,
      ),
    ).toEqual(['m2', 'm3']);
  });

  it('pages strictly older messages with the cursor and rejects dangling or foreign cursors', async () => {
    const storage = memoryStorage();
    await seedMessages(storage);

    expect(
      (await storage.memory.listMessages({ threadId: 'th1', before: 'm2' })).map((m) => m.id),
    ).toEqual(['m4', 'm1']);
    expect(
      (await storage.memory.listMessages({ threadId: 'th1', before: 'm2', order: 'asc' })).map(
        (m) => m.id,
      ),
    ).toEqual(['m1', 'm4']);

    expect(
      messageOf(await caught(storage.memory.listMessages({ threadId: 'th1', before: 'nope' }))),
    ).toBe("memory.listMessages: before cursor 'nope' is not a message in this store");
    expect(
      messageOf(await caught(storage.memory.listMessages({ threadId: 'th1', before: 'm5' }))),
    ).toBe("memory.listMessages: before cursor 'm5' is not a message in this store");
    expect(
      messageOf(await caught(storage.memory.listMessages({ threadId: 'th1', limit: 0 }))),
    ).toBe('memory.listMessages: limit must be a positive integer, got 0');
  });

  it('upserts a batch by id, accepting an empty batch', async () => {
    const storage = memoryStorage();
    await seedMessages(storage);
    await storage.memory.saveMessages([]);
    await storage.memory.saveMessages([
      message('m1', 'th1', 100, 'replaced'),
      message('m6', 'th1', 500, 'new'),
    ]);

    expect(
      (await storage.memory.listMessages({ threadId: 'th1' })).map((m) => m.id),
    ).toEqual(['m6', 'm3', 'm2', 'm4', 'm1']);
    const replaced = (await storage.memory.listMessages({ threadId: 'th1' })).find(
      (m) => m.id === 'm1',
    );
    expect(replaced?.content).toEqual([{ type: 'text', text: 'replaced' }]);
  });

  it('rejects a message whose thread does not exist — the reference accepts it, the FK does not', async () => {
    const storage = memoryStorage();
    const error = await caught(storage.memory.saveMessages([message('m', 'ghost', 0)]));
    expect(error).toBeInstanceOf(Error);
    expect(messageOf(error)).toMatch(/FOREIGN KEY|constraint/i);
  });
});

describe('memory resources and the capability flag', () => {
  it('exposes the conditional resource pair, so the working-memory capability flag reads true', () => {
    expect(supportsWorkingMemory(memoryStorage().memory)).toBe(true);
  });

  it('round-trips a resource and keeps JSON null distinct from absent', async () => {
    const storage = memoryStorage();
    expect(await storage.memory.getResource('none')).toBeNull();

    await storage.memory.saveResource({
      id: 'a',
      workingMemory: null,
      metadata: { theme: 'dark' },
      createdAt: new Date(1),
      updatedAt: new Date(2),
    });
    await storage.memory.saveResource({ id: 'b', createdAt: new Date(3), updatedAt: new Date(4) });

    const a = await storage.memory.getResource('a');
    expect(a).toEqual({
      id: 'a',
      workingMemory: null,
      metadata: { theme: 'dark' },
      createdAt: new Date(1),
      updatedAt: new Date(2),
    });
    expect(Object.hasOwn(a as object, 'workingMemory')).toBe(true);

    const b = await storage.memory.getResource('b');
    expect(Object.hasOwn(b as object, 'workingMemory')).toBe(false);
    expect(Object.hasOwn(b as object, 'metadata')).toBe(false);

    await storage.memory.saveResource({
      id: 'a',
      workingMemory: { goal: 'ship M5' },
      createdAt: new Date(1),
      updatedAt: new Date(5),
    });
    expect((await storage.memory.getResource('a'))?.workingMemory).toEqual({ goal: 'ship M5' });
  });
});
