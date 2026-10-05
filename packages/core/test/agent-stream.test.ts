import { describe, expect, it, vi } from 'vitest';
import { ModelContractError } from '@oribos/core/model';
import type { Chunk } from '@oribos/core/model';
import { fakeModel } from '@oribos/testing';
import type { FakeResponse } from '@oribos/testing';
import { assistant } from './helpers/agent.js';
import { collect } from './helpers/collect.js';
import { describeOutputObjectContract } from './helpers/output-object-contract.js';
import { UNKNOWN_USAGE } from './helpers/usage.js';

/**
 * stream() 输出对象双消费(M1-05 #26):同一个对象既可 `for await` 消费核心自有 chunk 协议流,
 * 又可 await 其终值 getter(text / toolCalls / toolResults / usage / steps / finishReason);
 * `generate()` = `stream()` + await 终值,单一代码路径、行为一致(agent.md「执行语义」)。断言只走
 * 公开面(@oribos/core/agent)与脚本化假模型接缝(@see @oribos/testing),不触内部实现。
 *
 * 共享泵的行为矩阵(懒启动 / 缓冲 / 错误序 / abandon / 提前 settle / 迭代器同一性)由
 * helpers/output-object-contract.ts 钉住,本文件以拉源(generator)一侧喂它;推源
 * (promise+emit)一侧在 workflows-events.test.ts。
 */
describeOutputObjectContract<Chunk>({
  success: () => {
    const model = fakeModel([{ text: ['Hel', 'lo'], usage: { inputTokens: 1, outputTokens: 2 } }]);
    const result = assistant(model).stream('Say hi.');
    return {
      output: result,
      readTerminal: () => result.text,
      started: () => model.streamCalls.length > 0,
      chunks: [
        { type: 'text-delta', textDelta: 'Hel' },
        { type: 'text-delta', textDelta: 'lo' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
      ],
      terminal: 'Hello',
    };
  },
  failure: () => {
    const boom = new Error('upstream exploded');
    const model = fakeModel([{ text: ['Hel', 'lo'], errorAfter: boom }]);
    const result = assistant(model).stream('Say hi.');
    return {
      output: result,
      readTerminal: () => result.text,
      started: () => model.streamCalls.length > 0,
      chunks: [
        { type: 'text-delta', textDelta: 'Hel' },
        { type: 'text-delta', textDelta: 'lo' },
      ],
      error: boom,
    };
  },
});
describe('Agent.stream:for-await 消费 chunk 协议流', () => {
  it('按流序下发 text-delta / tool-call / tool-result / finish,chunk 形状全部来自自有协议', async () => {
    const model = fakeModel([
      {
        text: ['Hel', 'lo'],
        toolCalls: [{ toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } }],
        toolResults: [{ toolCallId: 'call-1', toolName: 'weather', result: { temp: 21 } }],
        usage: { inputTokens: 3, outputTokens: 7 },
      },
    ]);

    const chunks = await collect(assistant(model).stream('Say hi.'));

    // 深比较:不夹带 provider 流的 id / providerMetadata 等外部字段(ADR-0004 不透出 AI SDK 格式)。
    expect(chunks).toEqual([
      { type: 'text-delta', textDelta: 'Hel' },
      { type: 'text-delta', textDelta: 'lo' },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } },
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'weather',
        output: { temp: 21 },
        isError: false,
      },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
      },
    ]);
  });

  it('协议外 part(推理增量 / 结构标记)不下发 chunk', async () => {
    const model = fakeModel([{ reasoning: ['th', 'ink'], text: 'answer' }]);

    const chunks = await collect(assistant(model).stream('Say hi.'));

    expect(chunks).toEqual([
      { type: 'text-delta', textDelta: 'answer' },
      { type: 'finish', finishReason: 'stop', usage: UNKNOWN_USAGE },
    ]);
  });

  it('未消费前不发起模型调用:首次 for-await 才启动 run', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const result = assistant(model).stream('Say hi.');

    expect(model.streamCalls).toHaveLength(0);

    await collect(result);

    expect(model.streamCalls).toHaveLength(1);
  });

  it('提前 break 不取消 run:终值照常收敛;该次 chunk 消费到此为止(取消走 per-call signal)', async () => {
    const model = fakeModel([{ text: ['a', 'b'] }]);
    const result = assistant(model).stream('Say hi.');

    for await (const chunk of result) {
      expect(chunk).toEqual({ type: 'text-delta', textDelta: 'a' });
      break;
    }

    await expect(result.text).resolves.toBe('ab');
    // 消费是单次的:离开循环后不再有 chunk,也不再为它缓冲
    await expect(collect(result)).resolves.toEqual([]);
  });
});

describe('Agent.stream:await 终值', () => {
  it('不迭代即可拿 text / usage / finishReason / steps', async () => {
    const model = fakeModel([{ text: ['Hel', 'lo'], usage: { inputTokens: 3, outputTokens: 7 } }]);
    const result = assistant(model).stream('Say hi.');

    await expect(result.text).resolves.toBe('Hello');
    await expect(result.usage).resolves.toEqual({ inputTokens: 3, outputTokens: 7, totalTokens: 10 });
    await expect(result.finishReason).resolves.toBe('stop');
    await expect(result.steps).resolves.toEqual([
      {
        text: 'Hello',
        toolCalls: [],
        toolResults: [],
        usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
      },
    ]);
  });

  it('终值 promise 在消费前取用、与 for-await 并行消费同一 run,值一致', async () => {
    const model = fakeModel([{ text: ['Hel', 'lo'], usage: { inputTokens: 1, outputTokens: 2 } }]);
    const result = assistant(model).stream('Say hi.');
    const text = result.text;

    const deltas: string[] = [];
    for await (const chunk of result) {
      if (chunk.type === 'text-delta') deltas.push(chunk.textDelta);
    }

    expect(deltas.join('')).toBe('Hello');
    await expect(text).resolves.toBe('Hello');
    await expect(result.usage).resolves.toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  });

  it('模型未报告 token 数时 usage 三项均未定义(unknown 不塌成 0)', async () => {
    const model = fakeModel([{ text: 'ok' }]);

    await expect(assistant(model).stream('Say hi.').usage).resolves.toEqual(UNKNOWN_USAGE);
  });

  it('先 await 终值再 for-await:chunk 流从同一 run 回放,顺序不变', async () => {
    const model = fakeModel([{ text: ['Hel', 'lo'], usage: { inputTokens: 1, outputTokens: 2 } }]);
    const result = assistant(model).stream('Say hi.');

    await expect(result.text).resolves.toBe('Hello');

    expect(await collect(result)).toEqual([
      { type: 'text-delta', textDelta: 'Hel' },
      { type: 'text-delta', textDelta: 'lo' },
      { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
    ]);
  });

  it('steps 记录每步 text / toolCalls / toolResults / usage(provider 执行的结果同样承载)', async () => {
    const model = fakeModel([
      {
        text: 'Let me check.',
        toolCalls: [{ toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } }],
        toolResults: [{ toolCallId: 'call-1', toolName: 'weather', result: { temp: 21 } }],
        usage: { inputTokens: 3, outputTokens: 7 },
      },
    ]);

    const result = assistant(model).stream('Say hi.');

    await expect(result.steps).resolves.toEqual([
      {
        text: 'Let me check.',
        toolCalls: [
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'weather', input: { city: 'SF' } },
        ],
        toolResults: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'weather',
            output: { temp: 21 },
            isError: false,
          },
        ],
        usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
      },
    ]);
  });
});

describe('单一路径回归:generate() = stream() + await 终值', () => {
  it('同一输入下 generate() 与 stream() 的终值一致', async () => {
    const script: readonly FakeResponse[] = [
      { text: ['Hel', 'lo'], usage: { inputTokens: 3, outputTokens: 7 } },
    ];

    const viaGenerate = await assistant(fakeModel(script)).generate('Say hi.');
    const result = assistant(fakeModel(script)).stream('Say hi.');
    const viaStream = {
      text: await result.text,
      toolCalls: await result.toolCalls,
      toolResults: await result.toolResults,
      usage: await result.usage,
      finishReason: await result.finishReason,
      steps: await result.steps,
    };

    expect(viaGenerate).toEqual(viaStream);
  });

  it('generate() 内部走 stream():单一代码路径,不存在第二套实现', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const agent = assistant(model);
    const stream = vi.spyOn(agent, 'stream');

    const result = await agent.generate('Say hi.');

    expect(stream).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('ok');
  });
});

describe('Agent.stream:错误路径', () => {
  it('模型流中途报错:迭代在错误处拒绝,终值 promise 同样拒绝', async () => {
    const model = fakeModel([{ text: 'partial', errorAfter: new Error('upstream exploded') }]);
    const result = assistant(model).stream('Say hi.');
    const received: Chunk[] = [];

    await expect(
      (async () => {
        for await (const chunk of result) received.push(chunk);
      })(),
    ).rejects.toThrow('upstream exploded');

    expect(received).toEqual([{ type: 'text-delta', textDelta: 'partial' }]);
    await expect(result.text).rejects.toThrow('upstream exploded');
    await expect(result.toolCalls).rejects.toThrow('upstream exploded');
    await expect(result.toolResults).rejects.toThrow('upstream exploded');
    await expect(result.steps).rejects.toThrow('upstream exploded');
  });

  it('模型流缺 finish part:迭代与终值都以契约错误拒绝,不静默给默认值', async () => {
    const model = fakeModel([{ text: 'no finish', omitFinish: true }]);
    const result = assistant(model).stream('Say hi.');

    await expect(collect(result)).rejects.toBeInstanceOf(ModelContractError);
    await expect(result.finishReason).rejects.toBeInstanceOf(ModelContractError);
  });

  it('调用前已中止的 signal:消费时以中止原因拒绝,不发起模型调用', async () => {
    const model = fakeModel([{ text: 'never sent' }]);
    const agent = assistant(model);
    const controller = new AbortController();
    controller.abort(new Error('cancelled by host'));

    const result = agent.stream('Say hi.', { signal: controller.signal });

    await expect(result.text).rejects.toThrow('cancelled by host');
    expect(model.streamCalls).toHaveLength(0);
  });
});
