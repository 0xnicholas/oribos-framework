import { describe, expect, it } from 'vitest';
import {
  UI_MESSAGE_STREAM_HEADERS as OFFICIAL_HEADERS,
  parseJsonEventStream,
  readUIMessageStream,
  uiMessageChunkSchema,
} from 'ai';
import type { UIMessage, UIMessageChunk } from 'ai';
import type { Chunk } from '@oribos/core/model';
import type { StoredMessage } from '@oribos/core/memory';
import {
  UI_MESSAGE_STREAM_HEADERS,
  toAISdkMessages,
  toAISdkStream,
  type AISdkStreamChunk,
} from '@oribos/ai-sdk';

/**
 * The three drift guards of the frozen spec (spec: `docs/architecture/model.md`
 * 「目标协议与漂移纪律」): the closed frame union stays assignable to the real `UIMessageChunk`,
 * the emitted SSE bytes survive the official client-side parse path, and the response header
 * constant stays equal to the official one. `ai` is pinned exactly (`7.0.123`, devDependency) —
 * upgrading it is a deliberate PR that re-runs exactly these checks.
 */

/** Core's convention for type-level assertions (`packages/core/test/helpers/assertions.ts`). */
function expectAssignable<To>(_value: To): void {}

describe('cross-checks against the real ai@7.0.123', () => {
  it('check 1: the closed frame union is assignable to UIMessageChunk', () => {
    const frame = undefined as unknown as AISdkStreamChunk;
    expectAssignable<UIMessageChunk>(frame);
    // And the read-back messages are real UI messages.
    const messages = toAISdkMessages([]);
    expectAssignable<UIMessage[]>(messages);
  });

  it('check 2: emitted SSE bytes round-trip through uiMessageChunkSchema and readUIMessageStream', async () => {
    // What a route would emit for one tool-using run (message-level frames included).
    const frames: AISdkStreamChunk[] = [
      { type: 'start' },
      { type: 'start-step' },
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: 'Let me check.' },
      { type: 'text-end', id: 'text-0' },
      {
        type: 'tool-input-available',
        toolCallId: 'c1',
        toolName: 'weather',
        input: { city: 'Oslo' },
        providerExecuted: true,
        dynamic: true,
      },
      { type: 'finish-step' },
      { type: 'tool-output-available', toolCallId: 'c1', output: { celsius: 18 }, providerExecuted: true },
      { type: 'start-step' },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'It is 18°C.' },
      { type: 'text-end', id: 'text-1' },
      { type: 'finish-step' },
      {
        type: 'finish',
        finishReason: 'stop',
        messageMetadata: { usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } },
      },
    ];

    // The route's exact SSE encoding: one JSON per data line, [DONE] terminator.
    const encoder = new TextEncoder();
    const bytes = encoder.encode(
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
    );

    // The official client parse path: DefaultChatTransport uses exactly this pair.
    const parsed = parseJsonEventStream({
      stream: new Blob([bytes]).stream(),
      schema: uiMessageChunkSchema,
    });
    const chunks = await unwrapParsed(parsed);
    expect(chunks).toEqual(frames);

    // The official reader folds the same bytes into one UI message.
    const message = await last(
      readUIMessageStream({
        stream: new ReadableStream<UIMessageChunk>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      }),
    );
    expect(message.role).toBe('assistant');
    const parts = message.parts as Array<Record<string, unknown>>;
    expect(parts.filter((part) => part.type === 'text').map((part) => part.text)).toEqual([
      'Let me check.',
      'It is 18°C.',
    ]);
    const tool = parts.find((part) => part.type === 'dynamic-tool')!;
    expect(tool.toolName).toBe('weather');
    expect(tool.state).toBe('output-available');
    expect(tool.output).toEqual({ celsius: 18 });
    expect(parts.filter((part) => part.type === 'step-start').length).toBe(2);
    expect(message.metadata).toEqual({ usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } });
  });

  it('check 2b: the converter output alone (no message-level frames) parses through the official schema', async () => {
    async function* source(): AsyncGenerator<Chunk> {
      yield { type: 'text-delta', textDelta: 'hi' };
      yield { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    }
    const frames: AISdkStreamChunk[] = [];
    for await (const frame of toAISdkStream(source())) frames.push(frame);

    const encoder = new TextEncoder();
    const bytes = encoder.encode(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''));
    const parsed = parseJsonEventStream({
      stream: new Blob([bytes]).stream(),
      schema: uiMessageChunkSchema,
    });
    const chunks = await unwrapParsed(parsed);
    expect(chunks).toEqual([
      { type: 'start-step' },
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: 'hi' },
      { type: 'text-end', id: 'text-0' },
      { type: 'finish-step' },
    ]);
  });

  it('check 3: the response header constant equals the official UI_MESSAGE_STREAM_HEADERS', () => {
    expect(UI_MESSAGE_STREAM_HEADERS).toEqual(OFFICIAL_HEADERS);
    expect(UI_MESSAGE_STREAM_HEADERS['x-vercel-ai-ui-message-stream']).toBe('v1');
  });

  it('check 2c: opt-in delta frames round-trip through the official parse path and fold into the UI message', async () => {
    // One reasoning step with a streamed tool input, exactly as a `deltas`-opted-in run emits.
    const frames: AISdkStreamChunk[] = [
      { type: 'start' },
      { type: 'start-step' },
      { type: 'reasoning-start', id: 'reasoning-0' },
      { type: 'reasoning-delta', id: 'reasoning-0', delta: 'th' },
      { type: 'reasoning-delta', id: 'reasoning-0', delta: 'ink' },
      { type: 'reasoning-end', id: 'reasoning-0' },
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'weather', providerExecuted: true, dynamic: true },
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: '{"city"' },
      { type: 'tool-input-delta', toolCallId: 'c1', inputTextDelta: ':"Oslo"}' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'weather', input: { city: 'Oslo' }, providerExecuted: true, dynamic: true },
      { type: 'finish-step' },
      { type: 'finish', finishReason: 'tool-calls' },
    ];

    const encoder = new TextEncoder();
    const bytes = encoder.encode(
      frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
    );

    const parsed = parseJsonEventStream({
      stream: new Blob([bytes]).stream(),
      schema: uiMessageChunkSchema,
    });
    const chunks = await unwrapParsed(parsed);
    expect(chunks).toEqual(frames);

    const message = await last(
      readUIMessageStream({
        stream: new ReadableStream<UIMessageChunk>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      }),
    );
    const parts = message.parts as Array<Record<string, unknown>>;
    expect(parts.find((part) => part.type === 'reasoning')).toMatchObject({ text: 'think' });
    const tool = parts.find((part) => part.type === 'dynamic-tool')!;
    expect(tool.toolName).toBe('weather');
    expect(tool.state).toBe('input-available');
    expect(tool.input).toEqual({ city: 'Oslo' });
  });

  it('check 4 (bonus): read-back messages survive the official reader as prior history', async () => {
    const stored: StoredMessage[] = [
      {
        id: 'm1',
        threadId: 't',
        resourceId: 'r',
        createdAt: new Date(0),
        role: 'user',
        content: [{ type: 'text', text: 'weather in Oslo?' }],
      },
      {
        id: 'm2',
        threadId: 't',
        resourceId: 'r',
        createdAt: new Date(1),
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool-call', toolCallId: 'c1', toolName: 'weather', input: { city: 'Oslo' } },
        ],
      },
      {
        id: 'm3',
        threadId: 't',
        resourceId: 'r',
        createdAt: new Date(2),
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'weather', output: { type: 'json', value: { celsius: 18 } } },
        ],
      },
      {
        id: 'm4',
        threadId: 't',
        resourceId: 'r',
        createdAt: new Date(3),
        role: 'assistant',
        content: [{ type: 'text', text: 'It is 18°C.' }],
      },
    ];

    const [userMessage, assistantMessage] = toAISdkMessages(stored);
    expect(userMessage).toBeDefined();
    expect(assistantMessage).toBeDefined();
    expect(userMessage!.parts).toEqual([{ type: 'text', text: 'weather in Oslo?' }]);

    const frames: AISdkStreamChunk[] = [
      { type: 'start' },
      { type: 'start-step' },
      ...assistantPartChunks(assistantMessage!),
      { type: 'finish-step' },
      { type: 'finish' },
    ];
    const message = await last(
      readUIMessageStream({
        stream: new ReadableStream<UIMessageChunk>({
          start(controller) {
            for (const frame of frames) controller.enqueue(frame as UIMessageChunk);
            controller.close();
          },
        }),
        message: { id: assistantMessage!.id, role: 'assistant', parts: [] } as UIMessage,
      }),
    );
    const parts = message.parts as Array<Record<string, unknown>>;
    expect(parts.filter((part) => part.type === 'text').map((part) => part.text)).toEqual([
      'Checking.',
      'It is 18°C.',
    ]);
    const tool = parts.find((part) => part.type === 'dynamic-tool')!;
    expect(tool.state).toBe('output-available');
    expect(tool.output).toEqual({ celsius: 18 });
  });
});

/** Re-emits a folded assistant message's parts as the chunks that would rebuild it. */
function assistantPartChunks(message: { parts: readonly unknown[] }): AISdkStreamChunk[] {
  const frames: AISdkStreamChunk[] = [];
  let textId = 0;
  for (const raw of message.parts) {
    const part = raw as Record<string, unknown>;
    if (part.type === 'text') {
      const id = `text-${textId++}`;
      frames.push({ type: 'text-start', id }, { type: 'text-delta', id, delta: part.text as string }, { type: 'text-end', id });
    } else if (part.type === 'step-start') {
      frames.push({ type: 'start-step' });
    } else if (part.type === 'dynamic-tool') {
      frames.push({
        type: 'tool-input-available',
        toolCallId: part.toolCallId as string,
        toolName: part.toolName as string,
        input: part.input,
        providerExecuted: true,
        dynamic: true,
      });
      frames.push({
        type: 'tool-output-available',
        toolCallId: part.toolCallId as string,
        output: part.output,
        providerExecuted: true,
      });
    }
  }
  return frames;
}

/** The DefaultChatTransport discipline: every frame parsed, an invalid one throws. */
async function unwrapParsed(
  stream: ReadableStream<{ success: boolean; value?: unknown; error?: unknown }>,
): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value.success) throw value.error;
    chunks.push(value.value as UIMessageChunk);
  }
  return chunks;
}

async function last<T>(stream: AsyncIterable<T>): Promise<T> {
  let value: T | undefined;
  let seen = false;
  for await (const item of stream) {
    value = item;
    seen = true;
  }
  if (!seen) throw new Error('stream produced no message');
  return value!;
}
