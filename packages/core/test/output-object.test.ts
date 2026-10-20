import { describe, expect, it, vi } from 'vitest';
import * as outputObjectEntry from '@oribos/core/output-object';
import {
  createOutputObject,
  materialize,
  teeOutputObject,
  type OutputObject,
  type OutputProjections,
  type OutputSource,
  type TeeHooks,
} from '@oribos/core/output-object';
import { captureRejection } from './helpers/assertions.js';
import { collect } from './helpers/collect.js';

/**
 * `@oribos/core/output-object` 的公开契约(ADR-0018):能力包作者用 `createOutputObject` 从自定义源
 * 构造输出对象、用 `teeOutputObject` 观察一次执行、用 `materialize` 一次读齐终值。泵的完整行为矩阵
 * 由 agent / workflows 套件经公开面钉住(`helpers/output-object-contract.ts`);本文件只管公开面的
 * 形状与钩子时序。
 */

function pullSource(chunks: readonly string[], result: number): {
  readonly source: OutputSource<string, { result: number }>;
  readonly projections: OutputProjections<{ result: number }, { result: number }>;
  readonly started: ReturnType<typeof vi.fn>;
} {
  const started = vi.fn();
  return {
    started,
    source: {
      async start(deliver) {
        started();
        for (const chunk of chunks) deliver(chunk);
        return { result };
      },
    },
    projections: { result: (outcome) => outcome.result },
  };
}

function create(chunks: readonly string[], result: number): {
  readonly output: OutputObject<string, { result: number }>;
  readonly started: ReturnType<typeof vi.fn>;
} {
  const { source, projections, started } = pullSource(chunks, result);
  return { output: createOutputObject(source, projections), started };
}

function failing(chunks: readonly string[], error: Error): OutputObject<string, { result: number }> {
  return createOutputObject<string, { result: number }, { result: number }>(
    {
      async start(deliver) {
        for (const chunk of chunks) deliver(chunk);
        throw error;
      },
    },
    { result: (outcome) => outcome.result },
  );
}

describe('@oribos/core/output-object 导出面', () => {
  it('运行时只导出三个函数', () => {
    expect(Object.keys(outputObjectEntry).sort()).toEqual([
      'createOutputObject',
      'materialize',
      'teeOutputObject',
    ]);
  });

  it('类型导出可被引用且可构造', () => {
    // 类型导入在编译期消费:任一类型缺席,pnpm typecheck 即红。
    const source: OutputSource<string, number> = { start: async () => 1 };
    const projections: OutputProjections<number, { value: number }> = {
      value: (outcome) => outcome,
    };
    const hooks: TeeHooks<string, { value: number }> = {};
    const output: OutputObject<string, { value: number }> = createOutputObject(source, projections);
    const tee = teeOutputObject(output, hooks);

    expect(typeof tee[Symbol.asyncIterator]).toBe('function');
  });
});

describe('createOutputObject:自定义源', () => {
  it('懒启动:首次消费前不启动;迭代与读终值共享同一次执行', async () => {
    const { output, started } = create(['a', 'b'], 7);
    expect(started).not.toHaveBeenCalled();

    expect(await collect(output)).toEqual(['a', 'b']);
    expect(started).toHaveBeenCalledTimes(1);
    await expect(output.result).resolves.toBe(7);
    expect(started).toHaveBeenCalledTimes(1);
  });

  it('先读终值再迭代:终值先 settle,缓冲的 chunk 随后按流序交付', async () => {
    const { output } = create(['a', 'b'], 7);

    await expect(materialize<{ result: number }>(output)).resolves.toEqual({ result: 7 });
    expect(await collect(output)).toEqual(['a', 'b']);
  });

  it('源失败:已产 chunk 交付完才 reject,迭代器与终值拿同一错误', async () => {
    const error = new Error('source failed');
    const output = failing(['a'], error);

    const seen: string[] = [];
    const rejection = await captureRejection(async () => {
      for await (const chunk of output) seen.push(chunk);
    });

    expect(seen).toEqual(['a']);
    expect(rejection).toBe(error);
    await expect(output.result).rejects.toBe(error);
  });

  it('abandon 不影响 run:提前 break 后终值仍 settle', async () => {
    const { output } = create(['a', 'b'], 7);

    for await (const chunk of output) {
      expect(chunk).toBe('a');
      break;
    }

    await expect(output.result).resolves.toBe(7);
    expect(await collect(output)).toEqual([]);
  });
});

describe('teeOutputObject:观察一次执行', () => {
  it('onChunk 按流序观察 chunk,终值原样转发', async () => {
    const { output } = create(['a', 'b'], 7);
    const seen: string[] = [];
    const tee = teeOutputObject(output, { onChunk: (chunk) => seen.push(chunk) });

    await expect(materialize<{ result: number }>(tee)).resolves.toEqual({ result: 7 });
    expect(seen).toEqual(['a', 'b']);
    expect(await collect(tee)).toEqual(['a', 'b']);
  });

  it('beforeSettle 在终值 settle 之前运行;失败路径同样运行', async () => {
    const order: string[] = [];
    const { output } = create(['a'], 7);
    const tee = teeOutputObject(output, {
      beforeSettle: async () => {
        order.push('beforeSettle');
      },
    });

    await materialize<{ result: number }>(tee).then(() => order.push('terminal'));
    expect(order).toEqual(['beforeSettle', 'terminal']);

    const error = new Error('source failed');
    const failedOrder: string[] = [];
    const failedTee = teeOutputObject(failing([], error), {
      beforeSettle: () => {
        failedOrder.push('beforeSettle');
      },
    });

    const rejection = await captureRejection(() => materialize<{ result: number }>(failedTee));
    expect(rejection).toBe(error);
    expect(failedOrder).toEqual(['beforeSettle']);
  });

  it('onChunk 不依赖 tee 的消费者:消费者提前离开,钩子仍观察到整跑', async () => {
    const { output } = create(['a', 'b', 'c'], 7);
    const seen: string[] = [];
    const tee = teeOutputObject(output, { onChunk: (chunk) => seen.push(chunk) });

    for await (const chunk of tee) {
      expect(chunk).toBe('a');
      break;
    }

    await expect(tee.result).resolves.toBe(7);
    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('collect 可替换终值的收集方式', async () => {
    const { output } = create(['a'], 7);
    const tee = teeOutputObject(output, {
      collect: async (inner) => ({ result: (await inner.result) + 1 }),
    });

    await expect(materialize<{ result: number }>(tee)).resolves.toEqual({ result: 8 });
  });

  it('钩子抛错替换 run 的结局', async () => {
    const error = new Error('hook failed');
    const { output } = create(['a'], 7);
    const tee = teeOutputObject(output, {
      beforeSettle: () => {
        throw error;
      },
    });

    await expect(materialize<{ result: number }>(tee)).rejects.toBe(error);
  });
});

describe('materialize:一次读齐终值', () => {
  it('按终值键重组记录,读两遍返回同一只 promise', async () => {
    const { output } = create([], 7);

    await expect(materialize<{ result: number }>(output)).resolves.toEqual({ result: 7 });
    expect(output.result).toBe(output.result);
  });
});
