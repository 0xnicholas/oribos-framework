import { describe, expect, it } from 'vitest';
import { Agent } from '@oribos/core/agent';
import type { Chunk } from '@oribos/core/model';
import { createInMemoryEventCache, withEventCache } from '@oribos/resumable-stream';
import type { EventCache } from '@oribos/resumable-stream';
import { fakeModel } from '@oribos/testing';

/**
 * `withEventCache` — the recording pass over an agent's output object (#184).
 *
 * 断言只走公开面:包装后的输出对象(`for await` 流 + 终值 getter)与注入的 cache(调用方自己
 * 的对象)。两根行为钉子:透传不改写(同一 run 的 chunk 序列与终值与裸流一致),断连不截流
 * (消费者中途离开,录制仍推进到 run 终态)。
 */

/** Collects a stream to completion, keeping every chunk in order. */
async function collect(stream: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** A run streaming `texts` as separate deltas, pacing each part by `delayMs`. */
function agentStreaming(texts: readonly string[], delayMs = 0) {
  const model = fakeModel([
    { text: texts, finishReason: 'stop', usage: { inputTokens: 1, outputTokens: texts.length }, delayMs },
  ]);
  return { model, agent: new Agent({ name: 'test', instructions: 'test', model }) };
}

/** Reads every chunk of a log as text, for order-checking at a glance. */
function textDeltas(chunks: readonly Chunk[]): string[] {
  return chunks.flatMap((chunk) =>
    chunk.type === 'text-delta' ? [chunk.textDelta] : [],
  );
}

describe('withEventCache', () => {
  it('passes the chunk stream through unchanged', async () => {
    const cache = createInMemoryEventCache();
    const bare = await collect(agentStreaming(['a', 'b', 'c']).agent.stream('hello'));
    const wrapped = await collect(
      withEventCache(agentStreaming(['a', 'b', 'c']).agent.stream('hello'), {
        runId: 'run-1',
        cache,
      }),
    );
    expect(wrapped).toEqual(bare);
  });

  it('forwards the terminal values: same object shape, same answers', async () => {
    const { agent } = agentStreaming(['a', 'b']);
    const cache = createInMemoryEventCache();
    const wrapped = withEventCache(agent.stream('hello'), { runId: 'run-1', cache });
    const text = await wrapped.text;
    const finishReason = await wrapped.finishReason;
    const steps = await wrapped.steps;
    expect(text).toBe('ab');
    expect(finishReason).toBe('stop');
    expect(steps.length).toBe(1);
    // The wrapper re-exposes the inner terminal keys: reading twice is the same promise-backed value.
    expect(await wrapped.text).toBe('ab');
  });

  it('records every chunk in order and marks the run done once consumed', async () => {
    const { agent } = agentStreaming(['a', 'b', 'c']);
    const cache = createInMemoryEventCache();
    const wrapped = withEventCache(agent.stream('hello'), { runId: 'run-1', cache });
    const live = await collect(wrapped);
    const log = await cache.read('run-1');
    expect(log?.status).toBe('done');
    expect(log?.chunks).toEqual(live);
    expect(textDeltas(log?.chunks ?? [])).toEqual(['a', 'b', 'c']);
  });

  it('keeps recording after its consumer leaves mid-stream (abandon does not truncate the cache)', async () => {
    const { agent } = agentStreaming(['a', 'b', 'c', 'd', 'e'], /* delayMs */ 5);
    const cache = createInMemoryEventCache();
    const wrapped = withEventCache(agent.stream('hello'), { runId: 'run-1', cache });

    const iterator = wrapped[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    await iterator.return?.(); // the SSE client hangs up

    // The run finishes on its own; the cache holds the whole story.
    await wrapped.text;
    const log = await cache.read('run-1');
    expect(log?.status).toBe('done');
    expect(textDeltas(log?.chunks ?? [])).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('records what a failing run produced and keeps the failure message', async () => {
    const model = fakeModel([{ text: ['a'], errorAfter: new Error('model exploded') }]);
    const agent = new Agent({ name: 'test', instructions: 'test', model });
    const cache = createInMemoryEventCache();
    const wrapped = withEventCache(agent.stream('hello'), { runId: 'run-1', cache });
    await expect(collect(wrapped)).rejects.toThrow('model exploded');
    const log = await cache.read('run-1');
    expect(log?.status).toBe('error');
    expect(log?.error).toContain('model exploded');
    expect(textDeltas(log?.chunks ?? [])).toEqual(['a']);
  });

  it('fails the run when the cache refuses an append', async () => {
    const { agent } = agentStreaming(['a', 'b']);
    const refusals: EventCache = {
      append: async () => {
        throw new Error('cache down');
      },
      close: async () => undefined,
      fail: async () => undefined,
      read: async () => undefined,
      drop: async () => undefined,
    };
    const wrapped = withEventCache(agent.stream('hello'), { runId: 'run-1', cache: refusals });
    await expect(collect(wrapped)).rejects.toThrow('cache down');
  });

  it('refuses to record the same run id twice on one cache while the first is live', async () => {
    const { agent } = agentStreaming(['a', 'b'], /* delayMs */ 5);
    const cache = createInMemoryEventCache();
    const first = withEventCache(agent.stream('hello'), { runId: 'run-1', cache });
    const iterator = first[Symbol.asyncIterator]();
    await iterator.next(); // the first recording is underway
    expect(() =>
      withEventCache(agent.stream('again'), { runId: 'run-1', cache }),
    ).toThrow(/already being recorded/);
    await iterator.return?.();
    await first.text;
  });
});
