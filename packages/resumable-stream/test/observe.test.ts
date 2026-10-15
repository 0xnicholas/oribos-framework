import { describe, expect, it } from 'vitest';
import { Agent } from '@oribos/core/agent';
import type { Chunk } from '@oribos/core/model';
import {
  createInMemoryEventCache,
  observe,
  withEventCache,
} from '@oribos/resumable-stream';
import {
  RunNotLiveError,
  UnknownRunError,
} from '@oribos/resumable-stream';
import { fakeModel } from '@oribos/testing';

/**
 * `observe` — the reconnecting read side (#184): replay a run's cached chunks in order, then
 * follow the run live until it ends. 断言只走公开面:`observe` 返回的迭代器与注入的 cache。
 */

async function collect(stream: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const textOf = (chunks: readonly Chunk[]): string =>
  chunks.flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.textDelta] : [])).join('');

/** An agent streaming `texts` as separate deltas, pacing each part by `delayMs`. */
function pacedAgent(texts: readonly string[], delayMs: number) {
  return new Agent({
    name: 'test',
    instructions: 'test',
    model: fakeModel([{ text: texts, finishReason: 'stop', delayMs }]),
  });
}

describe('observe', () => {
  it('throws UnknownRunError for a run the cache never heard of', async () => {
    const cache = createInMemoryEventCache();
    await expect(collect(observe(cache, 'nope'))).rejects.toThrow(UnknownRunError);
  });

  it('replays a finished run in order and ends', async () => {
    const cache = createInMemoryEventCache();
    const agent = pacedAgent(['a', 'b', 'c'], 0);
    await collect(withEventCache(agent.stream('hello'), { runId: 'run-1', cache }));
    const replayed = await collect(observe(cache, 'run-1'));
    expect(textOf(replayed)).toBe('abc');
    expect(replayed.at(-1)).toMatchObject({ type: 'finish', finishReason: 'stop' });
  });

  it('replays a failed run and then rejects with the recorded failure', async () => {
    const cache = createInMemoryEventCache();
    const agent = new Agent({
      name: 'test',
      instructions: 'test',
      model: fakeModel([{ text: ['a'], errorAfter: new Error('model exploded') }]),
    });
    await expect(
      collect(withEventCache(agent.stream('hello'), { runId: 'run-1', cache })),
    ).rejects.toThrow('model exploded');
    await expect(collect(observe(cache, 'run-1'))).rejects.toThrow('model exploded');
  });

  it('follows a live run: cached chunks replay, the tail streams, the end ends', async () => {
    const cache = createInMemoryEventCache();
    const agent = pacedAgent(['a', 'b', 'c', 'd'], /* delayMs */ 10);
    const wrapped = withEventCache(agent.stream('hello'), { runId: 'run-1', cache });

    // The run is underway: consume two deltas, then "hang up" — the recording keeps going.
    const liveIterator = wrapped[Symbol.asyncIterator]();
    await liveIterator.next();
    await liveIterator.next();
    await liveIterator.return?.();

    const observed: Chunk[] = [];
    const observing = collect(observe(cache, 'run-1')).then((chunks) => {
      observed.push(...chunks);
      return chunks;
    });
    const replayed = await observing;
    expect(textOf(replayed)).toBe('abcd');
    expect(replayed.filter((chunk) => chunk.type === 'text-delta').length).toBe(4); // no duplicates
    expect(replayed.at(-1)).toMatchObject({ type: 'finish', finishReason: 'stop' });
    expect((await cache.read('run-1'))?.status).toBe('done');
  });

  it('follows a live run that has cached nothing yet', async () => {
    const cache = createInMemoryEventCache();
    const agent = pacedAgent(['x', 'y'], /* delayMs */ 10);
    const wrapped = withEventCache(agent.stream('hello'), { runId: 'run-1', cache });
    // Start the run (first consumption) but observe before any chunk can land.
    const firstChunk = wrapped[Symbol.asyncIterator]().next();
    const replayed = await collect(observe(cache, 'run-1'));
    expect(textOf(replayed)).toBe('xy');
    expect(await firstChunk).toMatchObject({ done: false });
  });

  it('refuses to wait on an active run no one in this process is recording', async () => {
    const cache = createInMemoryEventCache();
    // A run another instance recorded (or a crashed process left behind): active, not live here.
    await cache.append('run-1', { type: 'text-delta', textDelta: 'a' });
    const chunks: Chunk[] = [];
    const iterator = observe(cache, 'run-1')[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    chunks.push(first.value);
    await expect(iterator.next()).rejects.toThrow(RunNotLiveError);
    expect(textOf(chunks)).toBe('a'); // the cached part replayed before the refusal
  });
});
