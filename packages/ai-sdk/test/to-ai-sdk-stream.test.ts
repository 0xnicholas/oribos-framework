import { describe, expect, it } from 'vitest';
import type { Chunk } from '@oribos/core/model';
import { toAISdkStream } from '@oribos/ai-sdk';

/** An in-memory chunk source: what every consumer of the converter hands it. */
function source(...chunks: Chunk[]): AsyncIterable<Chunk> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          return i < chunks.length ? { done: false, value: chunks[i++]! } : { done: true, value: undefined };
        },
      };
    },
  };
}

/** A source that yields some chunks, then fails. */
async function* failingSource(chunks: readonly Chunk[], error: unknown): AsyncIterable<Chunk> {
  for (const chunk of chunks) yield chunk;
  throw error;
}

/** Collects every frame produced before the stream ends or fails. */
async function collect(
  stream: AsyncIterable<unknown>,
): Promise<{ frames: unknown[]; error: unknown }> {
  const frames: unknown[] = [];
  try {
    for await (const frame of stream) frames.push(frame);
    return { frames, error: undefined };
  } catch (error) {
    return { frames, error };
  }
}

const usage = { inputTokens: 3, outputTokens: 5, totalTokens: 8 };

describe('toAISdkStream', () => {
  it('opens a step before the first model output and closes the text block at finish', async () => {
    const { frames, error } = await collect(
      toAISdkStream(source({ type: 'text-delta', textDelta: 'Hello' }, { type: 'text-delta', textDelta: ' world' }, { type: 'finish', finishReason: 'stop', usage })),
    );
    expect(error).toBeUndefined();
    expect(frames).toEqual([
      { type: 'start-step' },
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: 'Hello' },
      { type: 'text-delta', id: 'text-0', delta: ' world' },
      { type: 'text-end', id: 'text-0' },
      { type: 'finish-step' },
    ]);
  });

  it('maps a tool round trip: call → finish-step in original order, then the result without a new step', async () => {
    const { frames, error } = await collect(
      toAISdkStream(
        source(
          { type: 'text-delta', textDelta: 'Let me check.' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'weather', input: { city: 'Oslo' } },
          { type: 'finish', finishReason: 'tool-calls', usage },
          { type: 'tool-result', toolCallId: 'call-1', toolName: 'weather', output: { celsius: 18 }, isError: false },
          { type: 'text-delta', textDelta: 'It is 18°C.' },
          { type: 'finish', finishReason: 'stop', usage },
        ),
      ),
    );
    expect(error).toBeUndefined();
    expect(frames).toEqual([
      { type: 'start-step' },
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: 'Let me check.' },
      { type: 'text-end', id: 'text-0' },
      {
        type: 'tool-input-available',
        toolCallId: 'call-1',
        toolName: 'weather',
        input: { city: 'Oslo' },
        providerExecuted: true,
        dynamic: true,
      },
      { type: 'finish-step' },
      { type: 'tool-output-available', toolCallId: 'call-1', output: { celsius: 18 }, providerExecuted: true },
      { type: 'start-step' },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'It is 18°C.' },
      { type: 'text-end', id: 'text-1' },
      { type: 'finish-step' },
    ]);
  });

  it('splits consecutive text segments into separate blocks when a tool call sits between them', async () => {
    const { frames, error } = await collect(
      toAISdkStream(
        source(
          { type: 'text-delta', textDelta: 'a' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 't', input: 1 },
          { type: 'text-delta', textDelta: 'b' },
          { type: 'finish', finishReason: 'stop', usage },
        ),
      ),
    );
    expect(error).toBeUndefined();
    expect(frames).toEqual([
      { type: 'start-step' },
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: 'a' },
      { type: 'text-end', id: 'text-0' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 't', input: 1, providerExecuted: true, dynamic: true },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'b' },
      { type: 'text-end', id: 'text-1' },
      { type: 'finish-step' },
    ]);
  });

  it('routes error results to tool-output-error, stringifying non-string outputs', async () => {
    const stringOutput = await collect(
      toAISdkStream(
        source(
          { type: 'tool-call', toolCallId: 'c1', toolName: 't', input: null },
          { type: 'finish', finishReason: 'tool-calls', usage },
          { type: 'tool-result', toolCallId: 'c1', toolName: 't', output: 'boom', isError: true },
          { type: 'finish', finishReason: 'stop', usage },
        ),
      ),
    );
    expect(stringOutput.frames).toContainEqual({
      type: 'tool-output-error',
      toolCallId: 'c1',
      errorText: 'boom',
      providerExecuted: true,
    });

    const objectOutput = await collect(
      toAISdkStream(
        source(
          { type: 'tool-call', toolCallId: 'c1', toolName: 't', input: null },
          { type: 'finish', finishReason: 'tool-calls', usage },
          { type: 'tool-result', toolCallId: 'c1', toolName: 't', output: { code: 500 }, isError: true },
          { type: 'finish', finishReason: 'stop', usage },
        ),
      ),
    );
    expect(objectOutput.frames).toContainEqual({
      type: 'tool-output-error',
      toolCallId: 'c1',
      errorText: '{"code":500}',
      providerExecuted: true,
    });
  });

  it('closes the open text block and emits a sanitized error frame when the source fails, then rethrows', async () => {
    const failure = new Error('model exploded');
    const { frames, error } = await collect(
      toAISdkStream(failingSource([{ type: 'text-delta', textDelta: 'partial' }], failure)),
    );
    expect(error).toBe(failure);
    expect(frames).toEqual([
      { type: 'start-step' },
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: 'partial' },
      { type: 'text-end', id: 'text-0' },
      { type: 'error', errorText: 'An error occurred.' },
    ]);
  });

  it('lets onError replace the sanitized error text', async () => {
    const { frames } = await collect(
      toAISdkStream(failingSource([], new Error('x')), { onError: () => 'custom text' }),
    );
    expect(frames).toEqual([{ type: 'error', errorText: 'custom text' }]);
  });

  it('produces nothing for an empty source', async () => {
    const { frames, error } = await collect(toAISdkStream(source()));
    expect(error).toBeUndefined();
    expect(frames).toEqual([]);
  });

  describe('opt-in delta families (A4)', () => {
    it('maps the full round trip: reasoning and tool-input deltas become their UI stream frames', async () => {
      const { frames, error } = await collect(
        toAISdkStream(
          source(
            { type: 'reasoning-delta', reasoningDelta: 'th' },
            { type: 'reasoning-delta', reasoningDelta: 'ink' },
            { type: 'text-delta', textDelta: 'Let me check.' },
            { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'weather' },
            { type: 'tool-input-delta', toolCallId: 'call-1', inputDelta: '{"city' },
            { type: 'tool-input-delta', toolCallId: 'call-1', inputDelta: ':"SF"}' },
            { type: 'tool-input-end', toolCallId: 'call-1' },
            { type: 'tool-call', toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } },
            { type: 'finish', finishReason: 'tool-calls', usage },
          ),
        ),
      );
      expect(error).toBeUndefined();
      expect(frames).toEqual([
        { type: 'start-step' },
        { type: 'reasoning-start', id: 'reasoning-0' },
        { type: 'reasoning-delta', id: 'reasoning-0', delta: 'th' },
        { type: 'reasoning-delta', id: 'reasoning-0', delta: 'ink' },
        { type: 'reasoning-end', id: 'reasoning-0' },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: 'Let me check.' },
        { type: 'text-end', id: 'text-1' },
        {
          type: 'tool-input-start',
          toolCallId: 'call-1',
          toolName: 'weather',
          providerExecuted: true,
          dynamic: true,
        },
        { type: 'tool-input-delta', toolCallId: 'call-1', inputTextDelta: '{"city' },
        { type: 'tool-input-delta', toolCallId: 'call-1', inputTextDelta: ':"SF"}' },
        {
          type: 'tool-input-available',
          toolCallId: 'call-1',
          toolName: 'weather',
          input: { city: 'SF' },
          providerExecuted: true,
          dynamic: true,
        },
        { type: 'finish-step' },
      ]);
    });

    it('opens a fresh reasoning block when reasoning resumes after text', async () => {
      const { frames, error } = await collect(
        toAISdkStream(
          source(
            { type: 'reasoning-delta', reasoningDelta: 'a' },
            { type: 'text-delta', textDelta: 't' },
            { type: 'reasoning-delta', reasoningDelta: 'b' },
            { type: 'finish', finishReason: 'stop', usage },
          ),
        ),
      );
      expect(error).toBeUndefined();
      expect(frames).toEqual([
        { type: 'start-step' },
        { type: 'reasoning-start', id: 'reasoning-0' },
        { type: 'reasoning-delta', id: 'reasoning-0', delta: 'a' },
        { type: 'reasoning-end', id: 'reasoning-0' },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: 't' },
        { type: 'text-end', id: 'text-1' },
        { type: 'reasoning-start', id: 'reasoning-2' },
        { type: 'reasoning-delta', id: 'reasoning-2', delta: 'b' },
        { type: 'reasoning-end', id: 'reasoning-2' },
        { type: 'finish-step' },
      ]);
    });

    it('keeps two tool inputs streaming apart by toolCallId', async () => {
      const { frames, error } = await collect(
        toAISdkStream(
          source(
            { type: 'tool-input-start', toolCallId: 'c1', toolName: 'a' },
            { type: 'tool-input-start', toolCallId: 'c2', toolName: 'b' },
            { type: 'tool-input-delta', toolCallId: 'c1', inputDelta: '{"x":1}' },
            { type: 'tool-input-delta', toolCallId: 'c2', inputDelta: '{"y":2}' },
            { type: 'tool-input-end', toolCallId: 'c1' },
            { type: 'tool-input-end', toolCallId: 'c2' },
            { type: 'tool-call', toolCallId: 'c1', toolName: 'a', input: { x: 1 } },
            { type: 'tool-call', toolCallId: 'c2', toolName: 'b', input: { y: 2 } },
            { type: 'finish', finishReason: 'tool-calls', usage },
          ),
        ),
      );
      expect(error).toBeUndefined();
      expect(frames).toEqual([
        { type: 'start-step' },
        { type: 'tool-input-start', toolCallId: 'c1', toolName: 'a', providerExecuted: true, dynamic: true },
        { type: 'tool-input-start', toolCallId: 'c2', toolName: 'b', providerExecuted: true, dynamic: true },
        { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"x":1}' },
        { type: 'tool-input-delta', toolCallId: 'c2', inputTextDelta: '{"y":2}' },
        { type: 'tool-input-available', toolCallId: 'c1', toolName: 'a', input: { x: 1 }, providerExecuted: true, dynamic: true },
        { type: 'tool-input-available', toolCallId: 'c2', toolName: 'b', input: { y: 2 }, providerExecuted: true, dynamic: true },
        { type: 'finish-step' },
      ]);
    });

    it('emits no frame for tool-input-end — the UI vocabulary has none; the chunk only closes converter state', async () => {
      const { frames, error } = await collect(
        toAISdkStream(
          source(
            { type: 'tool-input-start', toolCallId: 'c1', toolName: 'a' },
            { type: 'tool-input-delta', toolCallId: 'c1', inputDelta: '{}' },
            { type: 'tool-input-end', toolCallId: 'c1' },
            { type: 'tool-call', toolCallId: 'c1', toolName: 'a', input: {} },
            { type: 'finish', finishReason: 'tool-calls', usage },
          ),
        ),
      );
      expect(error).toBeUndefined();
      expect(frames).toEqual([
        { type: 'start-step' },
        { type: 'tool-input-start', toolCallId: 'c1', toolName: 'a', providerExecuted: true, dynamic: true },
        { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{}' },
        { type: 'tool-input-available', toolCallId: 'c1', toolName: 'a', input: {}, providerExecuted: true, dynamic: true },
        { type: 'finish-step' },
      ]);
    });

    it('closes the open reasoning block at finish (a step ends whatever streamed before it)', async () => {
      const { frames, error } = await collect(
        toAISdkStream(
          source(
            { type: 'reasoning-delta', reasoningDelta: 'a' },
            { type: 'tool-input-start', toolCallId: 'c1', toolName: 'a' },
            { type: 'finish', finishReason: 'tool-calls', usage },
          ),
        ),
      );
      expect(error).toBeUndefined();
      expect(frames).toEqual([
        { type: 'start-step' },
        { type: 'reasoning-start', id: 'reasoning-0' },
        { type: 'reasoning-delta', id: 'reasoning-0', delta: 'a' },
        { type: 'reasoning-end', id: 'reasoning-0' },
        { type: 'tool-input-start', toolCallId: 'c1', toolName: 'a', providerExecuted: true, dynamic: true },
        { type: 'finish-step' },
      ]);
    });

    it('closes the open reasoning block before the error frame when the source fails', async () => {
      const failure = new Error('model exploded');
      const { frames, error } = await collect(
        toAISdkStream(failingSource([{ type: 'reasoning-delta', reasoningDelta: 'partial' }], failure)),
      );
      expect(error).toBe(failure);
      expect(frames).toEqual([
        { type: 'start-step' },
        { type: 'reasoning-start', id: 'reasoning-0' },
        { type: 'reasoning-delta', id: 'reasoning-0', delta: 'partial' },
        { type: 'reasoning-end', id: 'reasoning-0' },
        { type: 'error', errorText: 'An error occurred.' },
      ]);
    });
  });
});
