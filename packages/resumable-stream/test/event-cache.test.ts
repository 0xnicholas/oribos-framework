import { describe, expect, it } from 'vitest';
import {
  createInMemoryEventCache,
  createRedisEventCache,
} from '@oribos/resumable-stream';
import type { EventCache, RedisLikeClient } from '@oribos/resumable-stream';
import type { Chunk } from '@oribos/core/model';

const text = (textDelta: string): Chunk => ({ type: 'text-delta', textDelta });

/** A Map-backed stand-in for any Redis-compatible client (get / set / del). */
function fakeRedis(): RedisLikeClient {
  const store = new Map<string, string>();
  return {
    get: async (key) => store.get(key) ?? null,
    set: async (key, value) => void store.set(key, value),
    del: async (key) => void store.delete(key),
  };
}

/** The port contract every EventCache implementation must keep. */
function behavesLikeAnEventCache(make: () => EventCache): void {
  it('reads unknown runs as undefined', async () => {
    const cache = make();
    expect(await cache.read('nope')).toBeUndefined();
  });

  it('appends chunks in order under status active', async () => {
    const cache = make();
    await cache.append('run-1', text('a'));
    await cache.append('run-1', text('b'));
    const log = await cache.read('run-1');
    expect(log?.status).toBe('active');
    expect(log?.chunks).toEqual([text('a'), text('b')]);
  });

  it('close marks the run done and keeps the chunks for replay', async () => {
    const cache = make();
    await cache.append('run-1', text('a'));
    await cache.close('run-1');
    const log = await cache.read('run-1');
    expect(log?.status).toBe('done');
    expect(log?.chunks).toEqual([text('a')]);
  });

  it('fail marks the run error with the message kept', async () => {
    const cache = make();
    await cache.append('run-1', text('a'));
    await cache.fail('run-1', new Error('model exploded'));
    const log = await cache.read('run-1');
    expect(log?.status).toBe('error');
    expect(log?.error).toContain('model exploded');
  });

  it('close on a run with no chunks creates an empty done log', async () => {
    const cache = make();
    await cache.close('run-1');
    const log = await cache.read('run-1');
    expect(log?.status).toBe('done');
    expect(log?.chunks).toEqual([]);
  });

  it('drop removes the run', async () => {
    const cache = make();
    await cache.append('run-1', text('a'));
    await cache.close('run-1');
    await cache.drop('run-1');
    expect(await cache.read('run-1')).toBeUndefined();
  });
}

describe('createInMemoryEventCache', () => {
  behavesLikeAnEventCache(createInMemoryEventCache);

  it('holds runs isolated from each other', async () => {
    const cache = createInMemoryEventCache();
    await cache.append('run-1', text('a'));
    await cache.append('run-2', text('b'));
    expect((await cache.read('run-1'))?.chunks).toEqual([text('a')]);
    expect((await cache.read('run-2'))?.chunks).toEqual([text('b')]);
  });
});

describe('createRedisEventCache', () => {
  behavesLikeAnEventCache(() => createRedisEventCache({ client: fakeRedis() }));

  it('outlives the cache instance: a new cache over the same client replays the same run', async () => {
    const client = fakeRedis();
    const writer = createRedisEventCache({ client });
    await writer.append('run-1', text('a'));
    await writer.append('run-1', { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    await writer.close('run-1');

    const reader = createRedisEventCache({ client });
    const log = await reader.read('run-1');
    expect(log?.status).toBe('done');
    expect(log?.chunks).toEqual([
      text('a'),
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    ]);
  });

  it('isolates runs by key prefix', async () => {
    const client = fakeRedis();
    const a = createRedisEventCache({ client, prefix: 'app-a' });
    const b = createRedisEventCache({ client, prefix: 'app-b' });
    await a.append('run-1', text('a'));
    expect(await b.read('run-1')).toBeUndefined();
    expect((await a.read('run-1'))?.chunks).toEqual([text('a')]);
  });
});
