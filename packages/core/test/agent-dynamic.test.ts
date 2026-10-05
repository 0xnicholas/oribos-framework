import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, resolveDynamicArgument } from '@oribos/core/agent';
import type { RequestContext } from '@oribos/core/agent';
import { ModelSpecificationVersionError } from '@oribos/core/model';
import type { Model } from '@oribos/core/model';
import { createTool } from '@oribos/core/tools';
import { fakeModel } from '@oribos/testing';

/**
 * 动态参数与 RequestContext(M1-10 #31,ADR-0005):instructions / model / tools / description 四个
 * 配置字段接受静态值或 `(ctx) => T | Promise<T>` 函数,每次执行按请求上下文逐次解析;RequestContext
 * 是纯对象——框架写入 `signal` / `runId`,其余是用户 per-call 传入的开放属性袋,在动态参数解析与工具
 * ctx 中都是同一份。断言只走公开面(@oribos/core/agent 子路径)与脚本化假模型接缝
 * (@see @oribos/testing)。
 */
describe('动态参数:逐次解析', () => {
  it('instructions 函数形状每次 run 解析一次:两次调用按各自上下文拿到不同指令', async () => {
    const model = fakeModel([{ text: 'one' }, { text: 'two' }]);
    const instructions = vi.fn((ctx: RequestContext) => `You serve ${String(ctx.tenant)}.`);
    const agent = new Agent({ name: 'assistant', instructions, model });

    await agent.generate('hi', { tenant: 'acme' });
    await agent.generate('hi', { tenant: 'globex' });

    expect(instructions).toHaveBeenCalledTimes(2);
    expect(model.streamCalls.map((call) => call.prompt[0])).toEqual([
      { role: 'system', content: 'You serve acme.' },
      { role: 'system', content: 'You serve globex.' },
    ]);
  });

  it('model 函数形状每次 run 解析一次:两次调用命中各自上下文选出的模型', async () => {
    const pro = fakeModel([{ text: 'pro answer' }], { modelId: 'pro' });
    const cheap = fakeModel([{ text: 'cheap answer' }], { modelId: 'cheap' });
    const model = vi.fn((ctx: RequestContext) => (ctx.tier === 'pro' ? pro : cheap));
    const agent = new Agent({ name: 'assistant', instructions: 'You are concise.', model });

    const first = await agent.generate('hi', { tier: 'pro' });
    const second = await agent.generate('hi', { tier: 'free' });

    expect(model).toHaveBeenCalledTimes(2);
    expect(first.text).toBe('pro answer');
    expect(second.text).toBe('cheap answer');
    expect(pro.streamCalls).toHaveLength(1);
    expect(cheap.streamCalls).toHaveLength(1);
  });

  it('动态 model 的 spec 版本不匹配:解析期即报错,该 run 未发出任何模型调用', async () => {
    const outdated = {
      specificationVersion: 'v3',
      provider: 'openai',
      modelId: 'gpt-4o',
      doGenerate: async () => ({}),
      doStream: async () => ({}),
    } as unknown as Model;
    const agent = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model: () => outdated,
    });

    await expect(agent.generate('hi')).rejects.toThrow(ModelSpecificationVersionError);
    await expect(agent.generate('hi')).rejects.toThrow("'v3'");
  });

  it('tools 函数形状每次 run 解析一次:按上下文换工具容器,该 run 的每个 step 都用解析出的容器', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'search', input: { q: 'x' } }] },
      { text: 'found it' },
      { text: 'no tools' },
    ]);
    const search = createTool({
      description: 'Searches the web.',
      inputSchema: z.object({ q: z.string() }),
      execute: ({ q }) => `results for ${q}`,
    });
    const tools = vi.fn((ctx: RequestContext) => (ctx.canSearch === true ? { search } : {}));
    const agent = new Agent({ name: 'assistant', instructions: 'You are concise.', model, tools });

    const first = await agent.generate('hi', { canSearch: true });
    const second = await agent.generate('hi', { canSearch: false });

    expect(tools).toHaveBeenCalledTimes(2);
    expect(first.text).toBe('found it');
    expect(first.toolResults).toEqual([
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'search',
        output: 'results for x',
        isError: false,
      },
    ]);
    expect(second.text).toBe('no tools');
    expect(model.streamCalls.map((call) => call.tools?.map((tool) => tool.name))).toEqual([
      ['search'],
      ['search'],
      undefined,
    ]);
  });

  it('description 经 resolveDynamicArgument 逐次解析:静态值 / 函数 / 异步函数同义,缺席为 undefined', async () => {
    const model = fakeModel([]);
    const ctx = (tenant: string): RequestContext => ({
      signal: new AbortController().signal,
      runId: 'run-1',
      tenant,
    });
    const dynamic = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model,
      description: (c) => `Serves ${String(c.tenant)}.`,
    });
    const asyncDynamic = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model,
      description: async (c) => `Serves ${String(c.tenant)}.`,
    });
    const staticAgent = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model,
      description: 'Serves everyone.',
    });
    const bare = new Agent({ name: 'assistant', instructions: 'You are concise.', model });

    expect(await resolveDynamicArgument(dynamic.description, ctx('acme'))).toBe('Serves acme.');
    expect(await resolveDynamicArgument(dynamic.description, ctx('globex'))).toBe('Serves globex.');
    expect(await resolveDynamicArgument(asyncDynamic.description, ctx('acme'))).toBe('Serves acme.');
    expect(await resolveDynamicArgument(staticAgent.description, ctx('acme'))).toBe('Serves everyone.');
    expect(await resolveDynamicArgument(bare.description, ctx('acme'))).toBeUndefined();
  });
});

describe('RequestContext:框架写入 signal / runId + 用户开放袋', () => {
  it('解析上下文与工具 ctx.requestContext 是同一份对象:signal / runId / 用户袋均达,不掺入框架 run options', async () => {
    const model = fakeModel([
      { toolCalls: [{ toolCallId: 'call-1', toolName: 'probe', input: {} }] },
      { text: 'done' },
    ]);
    const controller = new AbortController();
    const seen: RequestContext[] = [];
    let toolContext: RequestContext | undefined;
    const probe = createTool({
      description: 'Probes.',
      execute: (_input, ctx) => {
        toolContext = ctx.requestContext;
        return 'ok';
      },
    });
    const agent = new Agent({
      name: 'assistant',
      instructions: (ctx) => {
        seen.push(ctx);
        return 'You are concise.';
      },
      model: (ctx) => {
        seen.push(ctx);
        return model;
      },
      tools: (ctx) => {
        seen.push(ctx);
        return { probe };
      },
    });

    await agent.generate('hi', {
      signal: controller.signal,
      tenant: 'acme',
      maxSteps: 3,
      modelSettings: { temperature: 0.1 },
      traceId: 'a'.repeat(32),
      parentSpanId: 'b'.repeat(16),
      hideInput: true,
    });

    // 每个配置字段每次 run 解析一次
    expect(seen).toHaveLength(3);
    const [first] = seen;
    for (const ctx of seen) {
      expect(ctx.signal).toBe(controller.signal);
      expect(ctx.runId).toBeTypeOf('string');
      expect(ctx.runId).not.toBe('');
      expect(ctx).toMatchObject({ tenant: 'acme' });
      for (const option of [
        'maxSteps',
        'modelSettings',
        'providerOptions',
        'traceId',
        'parentSpanId',
        'hideInput',
        'hideOutput',
      ]) {
        expect(ctx).not.toHaveProperty(option);
      }
    }
    // 同一次 run 的三次解析与工具 ctx 共事同一份上下文
    expect(new Set(seen.map((ctx) => ctx.runId)).size).toBe(1);
    expect(toolContext).toBe(first);
  });

  it('未传 signal 时解析上下文仍带 AbortSignal(空转信号)', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    let signal: unknown;
    const agent = new Agent({
      name: 'assistant',
      instructions: (ctx) => {
        signal = ctx.signal;
        return 'You are concise.';
      },
      model,
    });

    await agent.generate('hi');

    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('runId 每 run 新生成:两次调用不同,同一次 run 内处处一致', async () => {
    const model = fakeModel([{ text: 'one' }, { text: 'two' }]);
    const ids: string[] = [];
    const agent = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model: (ctx) => {
        ids.push(ctx.runId);
        return model;
      },
    });

    await agent.generate('hi');
    await agent.generate('hi');

    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('异步解析器同样逐次生效(instructions / model / tools 可返回 Promise)', async () => {
    const model = fakeModel([{ text: 'async ok' }]);
    const agent = new Agent({
      name: 'assistant',
      instructions: async (ctx) => `You serve ${String(ctx.tenant)}.`,
      model: async () => model,
      tools: async () => ({}),
    });

    const result = await agent.generate('hi', { tenant: 'acme' });

    expect(result.text).toBe('async ok');
    expect(model.streamCalls[0]?.prompt[0]).toEqual({
      role: 'system',
      content: 'You serve acme.',
    });
  });

  it('解析失败:run 以该错误拒绝,不发出任何模型调用', async () => {
    const model = fakeModel([{ text: 'never sent' }]);
    const agent = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model: () => {
        throw new Error('no model for this tenant');
      },
    });

    await expect(agent.generate('hi')).rejects.toThrow('no model for this tenant');
    expect(model.streamCalls).toHaveLength(0);
  });

  it('未消费的输出对象不解析任何动态参数(run 尚未开始)', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const instructions = vi.fn(() => 'You are concise.');
    const modelInput = vi.fn(() => model);
    const tools = vi.fn(() => ({}));
    const agent = new Agent({ name: 'assistant', instructions, model: modelInput, tools });

    const result = agent.stream('hi');

    expect(instructions).not.toHaveBeenCalled();
    expect(modelInput).not.toHaveBeenCalled();
    expect(tools).not.toHaveBeenCalled();
    expect(model.streamCalls).toHaveLength(0);

    await result.text;

    expect(instructions).toHaveBeenCalledTimes(1);
    expect(modelInput).toHaveBeenCalledTimes(1);
    expect(tools).toHaveBeenCalledTimes(1);
  });
});
