import { describe, expect, it } from 'vitest';
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from '@ai-sdk/provider';
import { fakeModel } from '@oribos/testing';
import { collect } from './helpers/collect.js';

/**
 * 规范假模型底座自身的契约钉点:`@ai-sdk/provider` 的真实类型保证其 spec 保真(见 @oribos/testing),
 * 本文件钉住它发出的流结构、脚本消费与录制行为——全部消费方套件都站在这个接缝上(#120:底座
 * 居 `@oribos/testing` 共享包、包内不放测试,本文件留在消费侧盯防这个 seam 的原始流形状)。
 */

const noUsage: LanguageModelV4Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

describe('fakeModel:脚本化假模型', () => {
  it('文本回答发出真实结构的 spec 流:stream-start → text-start/delta…/text-end → finish', async () => {
    const model = fakeModel([{ text: ['Hel', 'lo'], usage: { inputTokens: 3, outputTokens: 7 } }]);

    const { stream } = await model.doStream({ prompt: [] });

    expect(await collect(stream)).toEqual([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'text-0' },
      { type: 'text-delta', id: 'text-0', delta: 'Hel' },
      { type: 'text-delta', id: 'text-0', delta: 'lo' },
      { type: 'text-end', id: 'text-0' },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 3, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 7, text: undefined, reasoning: undefined },
        },
      },
    ] satisfies LanguageModelV4StreamPart[]);
  });

  it('工具调用先流式下发参数再落成 tool-call part,缺省 finish reason 为 tool-calls', async () => {
    const model = fakeModel([{ toolCalls: [{ toolName: 'weather', input: { city: 'SF' } }] }]);

    const { stream } = await model.doStream({ prompt: [] });

    expect(await collect(stream)).toEqual([
      { type: 'stream-start', warnings: [] },
      { type: 'tool-input-start', id: 'call-1', toolName: 'weather' },
      { type: 'tool-input-delta', id: 'call-1', delta: '{"city":"SF"}' },
      { type: 'tool-input-end', id: 'call-1' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'weather', input: '{"city":"SF"}' },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: noUsage },
    ] satisfies LanguageModelV4StreamPart[]);
  });

  it('工具调用 id 按模型实例内的顺序生成,可显式覆盖', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolName: 'a', input: {} }, { toolCallId: 'given', toolName: 'b', input: {} }] },
      { toolCalls: [{ toolName: 'c', input: {} }] },
    ]);

    const first = await model.doStream({ prompt: [] });
    const second = await model.doStream({ prompt: [] });
    const calls = [...(await collect(first.stream)), ...(await collect(second.stream))].filter(
      (part) => part.type === 'tool-call',
    );

    expect(calls).toEqual([
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'a', input: '{}' },
      { type: 'tool-call', toolCallId: 'given', toolName: 'b', input: '{}' },
      { type: 'tool-call', toolCallId: 'call-3', toolName: 'c', input: '{}' },
    ]);
  });

  it('记录每次调用的 call options(doStream / doGenerate 分开),供断言模型收到的 prompt', async () => {
    const model = fakeModel([{ text: 'a' }, { text: 'b' }]);

    await model.doStream({ prompt: [{ role: 'system', content: 'system-stream' }] });
    await model.doGenerate({ prompt: [{ role: 'system', content: 'system-generate' }] });

    expect(model.streamCalls).toHaveLength(1);
    expect(model.streamCalls[0]?.prompt).toEqual([{ role: 'system', content: 'system-stream' }]);
    expect(model.generateCalls).toHaveLength(1);
    expect(model.generateCalls[0]?.prompt).toEqual([{ role: 'system', content: 'system-generate' }]);
  });

  it('脚本逐次消费,耗尽后再被调用即显式报错', async () => {
    const model = fakeModel([{ text: 'only one' }]);

    await model.doStream({ prompt: [] });

    await expect(model.doStream({ prompt: [] })).rejects.toThrow(/script exhausted/);
  });

  it('fail 在产出任何内容前拒绝调用,并照常消费一次脚本', async () => {
    const model = fakeModel([{ fail: new Error('provider down') }, { text: 'recovered' }]);

    await expect(model.doStream({ prompt: [] })).rejects.toThrow('provider down');
    await expect(model.doStream({ prompt: [] })).resolves.toBeDefined();
  });

  it('errorAfter 在脚本输出之后追发 error part(流中途失败)', async () => {
    const model = fakeModel([{ text: 'partial', errorAfter: new Error('upstream exploded') }]);

    const { stream } = await model.doStream({ prompt: [] });
    const parts = await collect(stream);

    expect(parts.at(-1)).toEqual({ type: 'error', error: new Error('upstream exploded') });
    expect(parts.some((part) => part.type === 'finish')).toBe(false);
  });

  it('omitFinish 让流在没有 finish 也没有 error 的情况下结束', async () => {
    const model = fakeModel([{ text: 'partial', omitFinish: true }]);

    const { stream } = await model.doStream({ prompt: [] });
    const parts = await collect(stream);

    expect(parts.some((part) => part.type === 'finish')).toBe(false);
    expect(parts.some((part) => part.type === 'error')).toBe(false);
  });

  it('调用时已中止的 signal 直接拒绝(不消费脚本)', async () => {
    const model = fakeModel([{ text: 'never sent' }]);
    const controller = new AbortController();
    controller.abort(new Error('cancelled by test'));

    await expect(
      model.doStream({ prompt: [], abortSignal: controller.signal }),
    ).rejects.toThrow('cancelled by test');
  });

  it('doGenerate 从同一脚本构造 content / finishReason / usage', async () => {
    const model = fakeModel([
      {
        reasoning: 'think',
        text: ['Hel', 'lo'],
        toolCalls: [{ toolName: 'weather', input: { city: 'SF' } }],
        usage: { inputTokens: 1, outputTokens: 2 },
      },
    ]);

    const result = await model.doGenerate({ prompt: [] });

    expect(result.content).toEqual([
      { type: 'reasoning', text: 'think' },
      { type: 'text', text: 'Hello' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'weather', input: '{"city":"SF"}' },
    ]);
    expect(result.finishReason).toEqual({ unified: 'tool-calls', raw: 'tool-calls' });
    expect(result.usage.inputTokens.total).toBe(1);
    expect(result.usage.outputTokens.total).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  it('toolResults 在 tool-call 之后下发 provider 原生的 tool-result part', async () => {
    const model = fakeModel([
      {
        toolCalls: [{ toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } }],
        toolResults: [
          { toolCallId: 'call-1', toolName: 'weather', result: { temp: 21 } },
          { toolCallId: 'call-1', toolName: 'weather', result: 'boom', isError: true },
        ],
      },
    ]);

    const { stream } = await model.doStream({ prompt: [] });
    const results = (await collect(stream)).filter((part) => part.type === 'tool-result');

    expect(results).toEqual([
      { type: 'tool-result', toolCallId: 'call-1', toolName: 'weather', result: { temp: 21 } },
      { type: 'tool-result', toolCallId: 'call-1', toolName: 'weather', result: 'boom', isError: true },
    ] satisfies LanguageModelV4StreamPart[]);
  });

  it('provider / modelId 可定制,缺省为 fake 身份', async () => {
    const model = fakeModel([{ text: 'hi' }], { provider: 'anthropic', modelId: 'claude-haiku' });

    expect(model.provider).toBe('anthropic');
    expect(model.modelId).toBe('claude-haiku');
    expect(model.specificationVersion).toBe('v4');
    expect(fakeModel([{ text: 'hi' }]).provider).toBe('fake');
  });
});
