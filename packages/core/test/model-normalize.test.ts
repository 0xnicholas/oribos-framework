import { describe, expect, it } from 'vitest';
import { normalizePart, normalizeStream } from '@oribos/core/model';
import type { Chunk, ModelFinishReason, ModelStreamPart, ModelUsage } from '@oribos/core/model';
import { fakeModel } from '@oribos/testing';
import { collect } from './helpers/collect.js';

/**
 * chunk 协议与归一化层(ADR-0004):模型 spec 原生流是唯一输入,核心自有 chunk 词汇是唯一输出。
 * 归一化保持薄:一个 part 至多一个 chunk,不缓冲、不改写语义。
 */

function providerUsage(inputTokens?: number, outputTokens?: number): ModelUsage {
  return {
    inputTokens: { total: inputTokens, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: outputTokens, text: undefined, reasoning: undefined },
  };
}

function finishPart(unified: ModelFinishReason['unified'], usage: ModelUsage = providerUsage()): ModelStreamPart {
  return { type: 'finish', finishReason: { unified, raw: unified }, usage };
}

describe('normalizePart:模型原生 part → chunk', () => {
  it('text-delta 归一为 text-delta chunk', () => {
    expect(normalizePart({ type: 'text-delta', id: 'text-0', delta: 'Hel' })).toEqual([
      { type: 'text-delta', textDelta: 'Hel' },
    ]);
  });

  const IGNORED: Array<[string, ModelStreamPart]> = [
    ['text-start', { type: 'text-start', id: 'text-0' }],
    ['text-end', { type: 'text-end', id: 'text-0' }],
    ['reasoning-start', { type: 'reasoning-start', id: 'reasoning-0' }],
    ['reasoning-delta', { type: 'reasoning-delta', id: 'reasoning-0', delta: 'hmm' }],
    ['reasoning-end', { type: 'reasoning-end', id: 'reasoning-0' }],
    ['tool-input-start', { type: 'tool-input-start', id: 'call-1', toolName: 'weather' }],
    ['tool-input-delta', { type: 'tool-input-delta', id: 'call-1', delta: '{' }],
    ['tool-input-end', { type: 'tool-input-end', id: 'call-1' }],
    ['stream-start', { type: 'stream-start', warnings: [] }],
    ['response-metadata', { type: 'response-metadata', id: 'resp-1' }],
    ['raw', { type: 'raw', rawValue: 1 }],
    ['source', { type: 'source', sourceType: 'url', id: 'source-1', url: 'https://example.com' }],
    ['custom', { type: 'custom', kind: 'acme.block' }],
    ['file', { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'aGk=' } }],
    ['reasoning-file', { type: 'reasoning-file', mediaType: 'image/png', data: { type: 'data', data: 'aGk=' } }],
    ['tool-approval-request', { type: 'tool-approval-request', approvalId: 'a1', toolCallId: 'call-1' }],
  ];

  it.each(IGNORED)('协议外的 part(%s)不下发 chunk', (_type, part) => {
    expect(normalizePart(part)).toEqual([]);
  });

  it('tool-call 把字符串化 JSON 解析为 input', () => {
    expect(
      normalizePart({ type: 'tool-call', toolCallId: 'call-1', toolName: 'weather', input: '{"city":"SF"}' }),
    ).toEqual([{ type: 'tool-call', toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } }]);
  });

  it('tool-call 输入不是合法 JSON 时保留原始字符串(由工具边界回喂模型)', () => {
    expect(normalizePart({ type: 'tool-call', toolCallId: 'call-1', toolName: 'weather', input: '{oops' })).toEqual([
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'weather', input: '{oops' },
    ]);
  });

  it('tool-result 归一为带 isError 的 chunk(provider 执行的工具结果同样承载)', () => {
    expect(
      normalizePart({ type: 'tool-result', toolCallId: 'call-1', toolName: 'weather', result: { temp: 21 } }),
    ).toEqual([{ type: 'tool-result', toolCallId: 'call-1', toolName: 'weather', output: { temp: 21 }, isError: false }]);

    expect(
      normalizePart({ type: 'tool-result', toolCallId: 'call-1', toolName: 'weather', result: 'boom', isError: true }),
    ).toEqual([{ type: 'tool-result', toolCallId: 'call-1', toolName: 'weather', output: 'boom', isError: true }]);
  });

  it.each([
    ['stop', 'stop'],
    ['length', 'length'],
    ['tool-calls', 'tool-calls'],
    ['error', 'error'],
    ['content-filter', 'stop'],
    ['other', 'stop'],
  ] as const)('finish 的 unified 原因 %s 收敛为 %s', (unified, expected) => {
    const [chunk] = normalizePart(finishPart(unified));

    expect(chunk).toMatchObject({ type: 'finish', finishReason: expected });
  });

  it('finish 的 usage 展平为 inputTokens / outputTokens / totalTokens', () => {
    const [chunk] = normalizePart(finishPart('stop', providerUsage(3, 7)));

    expect(chunk).toEqual({
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
    });
  });

  it('provider 未报告 token 数时 usage 三项均未定义', () => {
    const [chunk] = normalizePart(finishPart('stop'));

    expect(chunk).toEqual({
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
    });
  });

  it('error part 以该错误终止归一化', () => {
    const error = new Error('upstream exploded');

    expect(() => normalizePart({ type: 'error', error })).toThrow(error);
  });

  it('error part 的非 Error 值包装为带 cause 的错误', () => {
    try {
      normalizePart({ type: 'error', error: 'oops' });
      expect.unreachable('normalizePart should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).cause).toBe('oops');
    }
  });
});

describe('normalizeStream:假模型流 → chunk 序列', () => {
  it('文本流归一为 text-delta 与 finish', async () => {
    const model = fakeModel([{ text: ['Hel', 'lo'], usage: { inputTokens: 3, outputTokens: 7 } }]);

    const { stream } = await model.doStream({ prompt: [] });
    const chunks: Chunk[] = await collect(normalizeStream(stream));

    expect(chunks).toEqual([
      { type: 'text-delta', textDelta: 'Hel' },
      { type: 'text-delta', textDelta: 'lo' },
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 } },
    ]);
  });

  it('工具调用流归一为 tool-call 与 finish(tool-calls),不承载参数增量 part', async () => {
    const model = fakeModel([{ toolCalls: [{ toolName: 'weather', input: { city: 'SF' } }] }]);

    const { stream } = await model.doStream({ prompt: [] });
    const chunks: Chunk[] = await collect(normalizeStream(stream));

    expect(chunks).toEqual([
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
      },
    ]);
  });

  it('推理增量不进入 chunk 协议', async () => {
    const model = fakeModel([{ reasoning: ['th', 'ink'], text: 'answer' }]);

    const { stream } = await model.doStream({ prompt: [] });
    const chunks: Chunk[] = await collect(normalizeStream(stream));

    expect(chunks).toEqual([
      { type: 'text-delta', textDelta: 'answer' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
      },
    ]);
  });

  it('流中途的 error part 让迭代拒绝', async () => {
    const model = fakeModel([{ text: 'partial', errorAfter: new Error('upstream exploded') }]);

    const { stream } = await model.doStream({ prompt: [] });

    await expect(collect(normalizeStream(stream))).rejects.toThrow('upstream exploded');
  });

  it('消费者提前退出时取消上游流', async () => {
    let cancelled = false;
    const stream = new ReadableStream<ModelStreamPart>({
      start(controller) {
        controller.enqueue({ type: 'text-delta', id: 'text-0', delta: 'a' });
        controller.enqueue({ type: 'text-delta', id: 'text-0', delta: 'b' });
      },
      cancel() {
        cancelled = true;
      },
    });

    for await (const chunk of normalizeStream(stream)) {
      expect(chunk).toEqual({ type: 'text-delta', textDelta: 'a' });
      break;
    }

    expect(cancelled).toBe(true);
  });
});
