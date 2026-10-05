import { describe, expect, it } from 'vitest';
import { Agent } from '@oribos/core/agent';
import type {
  AgentConfig,
  AgentMemoryOptions,
  AgentRunOptions,
  DynamicArgument,
  ModelInput,
  Processor,
  RequestContext,
} from '@oribos/core/agent';
import { Memory } from '@oribos/core/memory';
import { ModelContractError, ModelSpecificationVersionError } from '@oribos/core/model';
import type { Model } from '@oribos/core/model';
import { createTracer } from '@oribos/core/observability';
import { fakeModel } from '@oribos/testing';
import { captureError, expectAssignable } from './helpers/assertions.js';

/**
 * Agent 五字段配置表面与解析期模型断言(M1-04 #25 / M1-10 #31,ADR-0004/0005):
 * 表面之外无一物;一切配置字段接受静态值或 `(ctx) => T | Promise<T>` 动态形状,逐次解析;模型
 * specificationVersion 不匹配在解析期显式报错(静态模型在构造期,动态解析出的模型在 run 解析时),
 * 不拖到运行中途。
 */
describe('Agent 五字段配置表面', () => {
  it('name / instructions / model 必填,tools / description 可选(静态值)', () => {
    expectAssignable<AgentConfig>({
      name: 'assistant',
      instructions: 'You are concise.',
      model: fakeModel([{ text: 'hi' }]),
    });

    expectAssignable<AgentConfig>({
      name: 'assistant',
      instructions: 'You are concise.',
      model: fakeModel([{ text: 'hi' }]),
      tools: {
        search: { description: 'Searches the web.', execute: () => 'ok' },
        weather: {
          description: 'Looks up the weather.',
          execute: (input: { city: string }) => input.city,
        },
      },
      description: 'Answers questions about the knowledge base.',
    });
  });

  it('instructions 仅 string(动态形状也必须是 string 值):数组形状被类型拒绝', () => {
    expectAssignable<AgentConfig>({
      name: 'a',
      instructions: () => 'You are concise.',
      model: fakeModel([]),
    });
    expectAssignable<AgentConfig>({
      name: 'a',
      instructions: async () => 'You are concise.',
      model: fakeModel([]),
    });
    // @ts-expect-error instructions 只接受 string 或其解析函数,数组形状不存在
    expectAssignable<AgentConfig>({ name: 'a', instructions: ['You are concise.'], model: fakeModel([]) });
  });

  it('一切配置字段接受动态形状 (ctx) => T | Promise<T>(M1-10 #31,ADR-0005)', () => {
    expectAssignable<AgentConfig>({
      name: 'assistant',
      instructions: (ctx) => `You serve ${String(ctx.tenant)}.`,
      model: (ctx) => fakeModel([{ text: String(ctx.tenant) }]),
      tools: async (ctx) =>
        ctx.canSearch === true
          ? { search: { description: 'Searches the web.', execute: () => 'ok' } }
          : {},
      description: (ctx) => `Answers questions for ${String(ctx.tenant)}.`,
    });
  });

  it('DynamicArgument<T> = T | ((ctx) => T | Promise<T>);ModelInput 三形状:实例 / fallback 链 / 解析函数', () => {
    expectAssignable<DynamicArgument<string>>('You are concise.');
    expectAssignable<DynamicArgument<string>>((ctx: RequestContext) => `You serve ${ctx.runId}.`);
    expectAssignable<DynamicArgument<string>>(async (ctx: RequestContext) => ctx.runId);
    expectAssignable<DynamicArgument<readonly string[]>>(['one', 'two']);

    const model = fakeModel([]);
    expectAssignable<ModelInput>(model);
    expectAssignable<ModelInput>(() => model);
    expectAssignable<ModelInput>((ctx: RequestContext) => (ctx.tier === 'pro' ? model : model));
    expectAssignable<ModelInput>(async () => model);
    // fallback 链(M1-11 #32):静态数组,或解析函数选出的数组
    expectAssignable<ModelInput>([model]);
    expectAssignable<ModelInput>([model, model]);
    expectAssignable<ModelInput>((ctx: RequestContext) => (ctx.tier === 'pro' ? [model] : []));
    expectAssignable<ModelInput>(async () => [model, model]);
  });

  it('五字段之外无一物——多余字段被类型拒绝', () => {
    expectAssignable<AgentConfig>({
      name: 'a',
      instructions: 'You are concise.',
      model: fakeModel([]),
      // @ts-expect-error 定义表面之外无一物
      scorers: {},
    });
  });

  it('memory 是一等可选字段(未配 = 无记忆):静态实例或逐 run 解析', () => {
    const memory = new Memory();

    expectAssignable<AgentConfig>({
      name: 'assistant',
      instructions: 'You are concise.',
      model: fakeModel([]),
      memory,
    });
    expectAssignable<AgentConfig>({
      name: 'assistant',
      instructions: 'You are concise.',
      model: fakeModel([]),
      memory: (ctx) => (ctx.tenant === 'acme' ? memory : memory),
    });
    expectAssignable<AgentConfig>({
      name: 'assistant',
      instructions: 'You are concise.',
      model: fakeModel([]),
      memory: async () => memory,
    });
  });

  it('per-call memory 是 run option:thread(string 或 { id, title?, metadata? })+ resource,两者必填', () => {
    expectAssignable<AgentMemoryOptions>({ thread: 'thread-1', resource: 'user-1' });
    expectAssignable<AgentMemoryOptions>({
      thread: { id: 'thread-1', title: 'first chat', metadata: { source: 'test' } },
      resource: 'user-1',
    });
    expectAssignable<AgentRunOptions>({ memory: { thread: 'thread-1', resource: 'user-1' } });
    // @ts-expect-error resource 必填,缺一即不是合法的 per-call identity
    expectAssignable<AgentMemoryOptions>({ thread: 'thread-1' });
    // @ts-expect-error thread 必填
    expectAssignable<AgentMemoryOptions>({ resource: 'user-1' });
  });

  it('tracer 注入缝:横切依赖经配置传入(组合根分发或独立 new 显式传入),不进实例表面', () => {
    const tracer = createTracer({ exporters: [] });

    expectAssignable<AgentConfig>({
      name: 'assistant',
      instructions: 'You are concise.',
      model: fakeModel([]),
      tracer,
    });

    const agent = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model: fakeModel([]),
      tracer,
    });
    // 注入缝不占实例表面(五字段之外无一物);挂上后自动埋点的断言在 agent-observability.test.ts
    expect(agent).not.toHaveProperty('tracer');
  });

  it('processors 是扩展点而非定义字段:可挂载(三钩皆可选),不进实例表面', () => {
    expectAssignable<Processor>({
      processInput: ({ messages }) => ({ messages }),
      processOutputStep: ({ step }) => ({ step }),
      processError: ({ error }) => ({ error }),
    });
    // 钩子全部可选:只实现关心的一两个
    expectAssignable<Processor>({ processOutputStep: ({ step }) => ({ step }) });
    expectAssignable<Processor>({});

    const processor: Processor = { processError: () => ({ error: new Error('masked') }) };
    expectAssignable<AgentConfig>({
      name: 'assistant',
      instructions: 'You are concise.',
      model: fakeModel([]),
      processors: [processor],
    });

    const agent = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model: fakeModel([]),
      processors: [processor],
    });
    // 扩展点接线不进实例表面(与 tracer 同为注入缝;五字段之外无一物)
    expect(agent).not.toHaveProperty('processors');
  });

  it('trace 续接与 hide 覆盖是 run option 的一部分', () => {
    expectAssignable<AgentRunOptions>({
      traceId: '0'.repeat(32),
      parentSpanId: '0'.repeat(16),
      hideInput: true,
      hideOutput: true,
    });
  });

  it('构造后的实例原样持有配置字段(动态形状亦然——解析发生在每次 run 里)', () => {
    const model = fakeModel([{ text: 'hi' }]);
    const tools = { search: { description: 'Searches the web.', execute: () => 'ok' } };
    const memory = new Memory();
    const dynamic = {
      name: 'assistant',
      instructions: (ctx: RequestContext) => `You serve ${String(ctx.tenant)}.`,
      model: (ctx: RequestContext) => (ctx.tier === 'pro' ? model : model),
      tools: (ctx: RequestContext) => (ctx.canSearch === true ? tools : {}),
      description: (ctx: RequestContext) => `Answers questions for ${String(ctx.tenant)}.`,
      memory: (ctx: RequestContext) => (ctx.tenant === 'acme' ? memory : memory),
    };
    expectAssignable<AgentConfig>(dynamic);

    const agent = new Agent(dynamic);

    expect(agent.name).toBe('assistant');
    expect(agent.instructions).toBe(dynamic.instructions);
    expect(agent.model).toBe(dynamic.model);
    expect(agent.tools).toBe(dynamic.tools);
    expect(agent.description).toBe(dynamic.description);
    expect(agent.memory).toBe(dynamic.memory);
  });

  it('静态配置原样持有(解析不重建对象)', () => {
    const model = fakeModel([{ text: 'hi' }]);
    const tools = { search: { description: 'Searches the web.', execute: () => 'ok' } };
    const memory = new Memory();

    const agent = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model,
      tools,
      description: 'Answers questions.',
      memory,
    });

    expect(agent.name).toBe('assistant');
    expect(agent.instructions).toBe('You are concise.');
    expect(agent.model).toBe(model);
    expect(agent.tools).toBe(tools);
    expect(agent.description).toBe('Answers questions.');
    expect(agent.memory).toBe(memory);
  });

  it('缺省 tools / description 时两者为 undefined', () => {
    const agent = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model: fakeModel([{ text: 'hi' }]),
    });

    expect(agent.tools).toBeUndefined();
    expect(agent.description).toBeUndefined();
  });
});

describe('解析期模型断言', () => {
  /** 结构上像模型、但 spec 版本属于上一代的实例(模拟旧 provider 包)。 */
  function outdatedModel(): unknown {
    return {
      specificationVersion: 'v3',
      provider: 'openai',
      modelId: 'gpt-4o',
      doGenerate: async () => ({}),
      doStream: async () => ({}),
    };
  }

  it('specificationVersion 不匹配:构造 Agent 即抛显式错误(不是运行中途)', () => {
    const error = captureError(
      () =>
        new Agent({
          name: 'assistant',
          instructions: 'You are concise.',
          model: outdatedModel() as Model,
        }),
    );

    expect(error).toBeInstanceOf(ModelSpecificationVersionError);
    expect(error.message).toContain("'v3'");
    expect(error.message).toContain("'v4'");
    expect(error.message).toMatch(/upgrade the provider package/);
  });

  it('不是语言模型(如 embedding 模型):构造 Agent 即抛契约错误', () => {
    expect(
      () =>
        new Agent({
          name: 'assistant',
          instructions: 'You are concise.',
          model: { specificationVersion: 'v4', provider: 'openai', modelId: 'text-embedding-3-small' } as Model,
        }),
    ).toThrow(ModelContractError);
  });
});
