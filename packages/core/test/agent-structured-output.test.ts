import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, StructuredOutputError } from '@oribos/core/agent';
import type {
  AgentConfig,
  AgentGenerateResult,
  AgentRunOptions,
  Processor,
  RequestContext,
  StructuredOutputConfig,
} from '@oribos/core/agent';
import type { Chunk } from '@oribos/core/model';
import {
  AGENT_RUN_SPAN,
  AGENT_STEP_SPAN,
  createTracer,
  memoryExporter,
} from '@oribos/core/observability';
import type { StandardSchema } from '@oribos/core/tools';
import { fakeModel } from '@oribos/testing';
import { captureRejection, expectAssignable } from './helpers/assertions.js';
import { INSTRUCTIONS } from './helpers/agent.js';
import { collect } from './helpers/collect.js';
import { spanOfType } from './helpers/spans.js';
import { UNKNOWN_USAGE } from './helpers/usage.js';

/**
 * structuredOutput strict(M1-13 #34,agent.md「执行语义」):run option `structuredOutput: { schema }`
 * 走 Standard Schema 契约(ADR-0003)——schema 经 `~standard.jsonSchema` 出 JSON Schema 随
 * `responseFormat` 下发给模型;run 终值文本按 JSON 解析并 strict 校验,合规结果落输出对象的
 * `object`,不合规即显式报错(无 errorStrategy 多选一)。断言只走公开面(@oribos/core/agent)与
 * 脚本化假模型接缝(@see @oribos/testing):假模型录制的 call options 就是"模型收到的
 * responseFormat"。类型级断言(object 类型从 schema 推出)也在本文件。
 */

/** 参考 schema:输入/输出同型,便于"合规值逐字落 object"的断言。 */
const weatherSchema = z.object({
  city: z.string(),
  temperatureCelsius: z.number(),
});

describe('structuredOutput:合规输出落 object', () => {
  it('模型答复合规:object 为 schema 校验后的值,text 仍是模型原文(非结构化路径不受影响)', async () => {
    const answer = '{"city":"San Francisco","temperatureCelsius":21}';
    const model = fakeModel([{ text: answer, usage: { inputTokens: 3, outputTokens: 7 } }]);
    const agent = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model });

    const result = await agent.generate('Weather in San Francisco?', {
      structuredOutput: { schema: weatherSchema },
    });

    expect(result.object).toEqual({ city: 'San Francisco', temperatureCelsius: 21 });
    expect(result.text).toBe(answer);
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 7, totalTokens: 10 });
    expect(result.steps).toEqual([
      {
        text: answer,
        toolCalls: [],
        toolResults: [],
        usage: { inputTokens: 3, outputTokens: 7, totalTokens: 10 },
      },
    ]);
  });

  it('schema 经 ~standard.jsonSchema 出 JSON Schema 随 responseFormat 下发(draft-07,产物原样直通)', async () => {
    const model = fakeModel([{ text: '{"city":"Paris","temperatureCelsius":18}' }]);
    const agent = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model });

    await agent.generate('Weather in Paris?', { structuredOutput: { schema: weatherSchema } });

    expect(model.streamCalls[0]?.responseFormat).toEqual({
      type: 'json',
      schema: weatherSchema['~standard'].jsonSchema.input({ target: 'draft-07' }),
    });
  });

  it('手写 schema 字面量同样合法(Standard Schema 双接口,ADR-0003),异步 validate 一并等待', async () => {
    const schema: StandardSchema<{ city: string }> = {
      '~standard': {
        version: 1,
        vendor: 'probe',
        // 异步校验:契约允许 `Result | Promise<Result>`,框架等待它
        validate: async (value) => {
          const city = (value as { city?: unknown } | null)?.city;
          return typeof city === 'string'
            ? { value: { city } }
            : { issues: [{ message: 'expected an object with a string city' }] };
        },
        jsonSchema: {
          input: () => ({ type: 'object', properties: { city: { type: 'string' } } }),
          output: () => ({ type: 'object' }),
        },
      },
    };
    const model = fakeModel([{ text: '{"city":"Paris"}' }]);
    const agent = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model });

    const result = await agent.generate('Weather?', { structuredOutput: { schema } });

    expect(result.object).toEqual({ city: 'Paris' });
    expect(model.streamCalls[0]?.responseFormat).toEqual({
      type: 'json',
      schema: schema['~standard'].jsonSchema.input({ target: 'draft-07' }),
    });
  });
});

describe('structuredOutput strict:不合规输出即显式报错', () => {
  it('模型答的不是 JSON:以 StructuredOutputError 拒绝,text 为模型原文、cause 为解析错误', async () => {
    const answer = 'San Francisco is 21°C today.';
    const model = fakeModel([{ text: answer }]);
    const agent = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model });

    const error = await captureRejection(() =>
      agent.generate('Weather in San Francisco?', { structuredOutput: { schema: weatherSchema } }),
    );

    expect(error).toBeInstanceOf(StructuredOutputError);
    if (!(error instanceof StructuredOutputError)) throw error;
    expect(error.text).toBe(answer);
    expect(error.cause).toBeInstanceOf(SyntaxError);
    expect(error.issues).toBeUndefined();
    expect(error.message).toMatch(/not valid JSON/);
  });

  it('模型答的 JSON 不合 schema:以 StructuredOutputError 拒绝,issues 携带问题路径', async () => {
    const answer = '{"city":"Paris","temperatureCelsius":"warm"}';
    const model = fakeModel([{ text: answer }]);
    const agent = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model });

    const error = await captureRejection(() =>
      agent.generate('Weather in Paris?', { structuredOutput: { schema: weatherSchema } }),
    );

    expect(error).toBeInstanceOf(StructuredOutputError);
    if (!(error instanceof StructuredOutputError)) throw error;
    expect(error.text).toBe(answer);
    expect(error.cause).toBeUndefined();
    expect(error.issues?.map((issue) => issue.path)).toEqual([['temperatureCelsius']]);
    expect(error.message).toMatch(/does not match the structured output schema/);
    expect(error.message).toMatch(/temperatureCelsius/);
  });

  it('字段缺失同样不合规:JSON 可解析但 schema 不满足即拒绝', async () => {
    const model = fakeModel([{ text: '{"city":"Paris"}' }]);
    const agent = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model });

    await expect(
      agent.generate('Weather in Paris?', { structuredOutput: { schema: weatherSchema } }),
    ).rejects.toBeInstanceOf(StructuredOutputError);
  });

  it('stream():迭代在 finish chunk 之后以该错误拒绝,全部终值(object 在内)同样拒绝', async () => {
    const model = fakeModel([{ text: 'not json at all' }]);
    const agent = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model });
    const result = agent.stream('Weather?', { structuredOutput: { schema: weatherSchema } });
    const chunks: Chunk[] = [];

    const error = await captureRejection(async () => {
      for await (const chunk of result) chunks.push(chunk);
    });

    // chunk 流仍是模型原始产出:不因结构化校验失败而吞掉已产出的 chunk
    expect(chunks).toEqual([
      { type: 'text-delta', textDelta: 'not json at all' },
      { type: 'finish', finishReason: 'stop', usage: UNKNOWN_USAGE },
    ]);
    expect(error).toBeInstanceOf(StructuredOutputError);
    await expect(result.object).rejects.toBeInstanceOf(StructuredOutputError);
    await expect(result.text).rejects.toBeInstanceOf(StructuredOutputError);
    await expect(result.finishReason).rejects.toBeInstanceOf(StructuredOutputError);
  });

  it('maxSteps 耗尽、末步无文本:不返回半截 object,同样显式报错(strict)', async () => {
    const model = fakeModel([{ toolCalls: [{ toolName: 'weather', input: { city: 'Paris' } }] }]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: { weather: { description: 'Looks up the weather.', execute: () => 21 } },
    });

    await expect(
      agent.generate('Weather in Paris?', {
        maxSteps: 1,
        structuredOutput: { schema: weatherSchema },
      }),
    ).rejects.toBeInstanceOf(StructuredOutputError);
  });
});

describe('structuredOutput:与非结构化输出路径互不影响', () => {
  it('不带 structuredOutput 的 run:不发 responseFormat,object 为 undefined,终值形状不变', async () => {
    const model = fakeModel([{ text: 'hello' }]);
    const agent = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model });

    const result = await agent.generate('Hi.');

    expect(result.object).toBeUndefined();
    expect(result.text).toBe('hello');
    // 模型调用仍是纯 prompt:responseFormat 只属于结构化 run
    expect(model.streamCalls[0]).toEqual({
      prompt: [
        { role: 'system', content: INSTRUCTIONS },
        { role: 'user', content: [{ type: 'text', text: 'Hi.' }] },
      ],
    });
  });

  it('structuredOutput 是框架执行选项,不进 RequestContext 用户袋(动态解析看到的上下文)', async () => {
    const model = fakeModel([{ text: '{"city":"Paris","temperatureCelsius":18}' }]);
    const seen: RequestContext[] = [];
    const agent = new Agent({
      name: 'assistant',
      instructions: (ctx) => {
        seen.push(ctx);
        return INSTRUCTIONS;
      },
      model,
    });

    await agent.generate('Weather in Paris?', {
      structuredOutput: { schema: weatherSchema },
      tenant: 'acme',
    });

    expect(seen[0]).toMatchObject({ tenant: 'acme' });
    expect(seen[0]).not.toHaveProperty('structuredOutput');
  });
});

describe('structuredOutput:与工具 / Processor / 观测的接合', () => {
  it('带工具的 run:每一步的模型调用都带 responseFormat,只有末步文本被校验', async () => {
    const answer = '{"city":"Paris","temperatureCelsius":18}';
    const model = fakeModel([
      { text: '', toolCalls: [{ toolName: 'weather', input: { city: 'Paris' } }] },
      { text: answer },
    ]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      tools: { weather: { description: 'Looks up the weather.', execute: () => 18 } },
    });

    const result = await agent.generate('Weather in Paris?', {
      structuredOutput: { schema: weatherSchema },
    });

    expect(model.streamCalls).toHaveLength(2);
    const expectedFormat = {
      type: 'json',
      schema: weatherSchema['~standard'].jsonSchema.input({ target: 'draft-07' }),
    };
    // 每一步的模型调用都带 responseFormat:strict 是 run 级契约,不只是末步才说的
    expect(model.streamCalls.map((call) => call.responseFormat)).toEqual([
      expectedFormat,
      expectedFormat,
    ]);
    expect(result.object).toEqual({ city: 'Paris', temperatureCelsius: 18 });
  });

  it('schema 校验后的值是 object(schema 自带的变换/默认值生效),不是模型给的原始 JSON', async () => {
    const schema = z.object({ city: z.string(), unit: z.string().default('celsius') });
    const model = fakeModel([{ text: '{"city":"Paris"}' }]);
    const agent = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model });

    const result = await agent.generate('Weather in Paris?', { structuredOutput: { schema } });

    expect(result.object).toEqual({ city: 'Paris', unit: 'celsius' });
    expect(result.text).toBe('{"city":"Paris"}');
  });

  it('processOutputStep 改写后的终值才是被校验的文本(处理器是宽严的唯一缝)', async () => {
    const unwrapFence: Processor = {
      processOutputStep: ({ step }) => ({
        step: { ...step, text: step.text.replace(/^```json\n|\n```$/g, '') },
      }),
    };
    const answer = '```json\n{"city":"Paris","temperatureCelsius":18}\n```';
    const model = fakeModel([{ text: answer }]);
    const agent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model,
      processors: [unwrapFence],
    });

    const result = await agent.generate('Weather in Paris?', {
      structuredOutput: { schema: weatherSchema },
    });

    expect(result.text).toBe('{"city":"Paris","temperatureCelsius":18}');
    expect(result.object).toEqual({ city: 'Paris', temperatureCelsius: 18 });
  });

  it('挂 tracer 时 agent-run span 的 output 是结构化结果;校验失败时 run span 记录该错误', async () => {
    const memory = memoryExporter();
    const tracer = createTracer({ exporters: [memory] });
    const model = fakeModel([{ text: '{"city":"Paris","temperatureCelsius":18}' }]);
    const agent = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model, tracer });

    await agent.generate('Weather in Paris?', { structuredOutput: { schema: weatherSchema } });

    const run = spanOfType(memory, AGENT_RUN_SPAN);
    expect(run.output).toEqual({ city: 'Paris', temperatureCelsius: 18 });
    expect(run.error).toBeUndefined();

    const failing = memoryExporter();
    const failingAgent = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel([{ text: 'not json' }]),
      tracer: createTracer({ exporters: [failing] }),
    });

    await expect(
      failingAgent.generate('Weather?', { structuredOutput: { schema: weatherSchema } }),
    ).rejects.toBeInstanceOf(StructuredOutputError);

    expect(spanOfType(failing, AGENT_RUN_SPAN).error?.message).toMatch(/not valid JSON/);
    // 模型调用本身成功:结构化校验失败是 run 的输出契约失败,不归 agent-step span
    expect(spanOfType(failing, AGENT_STEP_SPAN).error).toBeUndefined();
  });

  it('stream() 的 object 与其他终值同源:先 await object 再 for-await,chunk 流照常回放', async () => {
    const answer = '{"city":"Paris","temperatureCelsius":18}';
    const model = fakeModel([{ text: answer, usage: { inputTokens: 1, outputTokens: 2 } }]);
    const agent = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model });
    const result = agent.stream('Weather in Paris?', {
      structuredOutput: { schema: weatherSchema },
    });

    await expect(result.object).resolves.toEqual({ city: 'Paris', temperatureCelsius: 18 });
    expect(await collect(result)).toEqual([
      { type: 'text-delta', textDelta: answer },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    ]);
  });

  it('generate() = stream() + await 终值:含 object 在内的终值一致(单一代码路径)', async () => {
    const script = [{ text: '{"city":"Paris","temperatureCelsius":18}' }] as const;
    const options = { structuredOutput: { schema: weatherSchema } } as const;

    const viaGenerate = await new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel(script),
    }).generate('Weather in Paris?', options);
    const result = new Agent({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel(script),
    }).stream('Weather in Paris?', options);

    expect(await result.object).toEqual(viaGenerate.object);
    expect(await result.text).toBe(viaGenerate.text);
    expect(await result.steps).toEqual(viaGenerate.steps);
  });
});

describe('structuredOutput:类型从 schema 推出(断言在编译期,tsc 阶段生效)', () => {
  /** 类型断言用的 agent:只搭对象,不消费结果(不发起任何 run)。 */
  const agent = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model: fakeModel([]) });

  it('object 类型 = schema 的输出类型(zod@4 InferOutput)', async () => {
    const model = fakeModel([{ text: '{"city":"Paris","temperatureCelsius":18}' }]);
    const typed = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model });

    const result = typed.stream('Weather?', { structuredOutput: { schema: weatherSchema } });

    expectAssignable<Promise<{ city: string; temperatureCelsius: number }>>(result.object);
    // @ts-expect-error 结构化值的类型由 schema 决定,不是另一个形状
    expectAssignable<Promise<string>>(result.object);

    // 收敛该 run:类型断言之外不做别的断言,不留悬空 promise
    await result.object;
  });

  it('generate() 同样推出 object 类型,结果类型随 schema 参数化', async () => {
    const model = fakeModel([{ text: '{"city":"Paris","temperatureCelsius":18}' }]);
    const typed = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model });

    const result = typed.generate('Weather?', { structuredOutput: { schema: weatherSchema } });

    expectAssignable<Promise<AgentGenerateResult<{ city: string; temperatureCelsius: number }>>>(
      result,
    );
    // @ts-expect-error 结果类型随 schema 参数化,不是别的形状
    expectAssignable<Promise<AgentGenerateResult<string>>>(result);

    await result;
  });

  it('schema 带的变换计入类型与值:object 取 schema 的 output(默认值补齐)', async () => {
    const withDefault = z.object({ city: z.string(), unit: z.string().default('celsius') });
    const model = fakeModel([{ text: '{"city":"Paris"}' }]);
    const typed = new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model });

    const result = typed.generate('Weather?', { structuredOutput: { schema: withDefault } });

    expectAssignable<Promise<AgentGenerateResult<{ city: string; unit: string }>>>(result);
    await expect(result).resolves.toMatchObject({ object: { city: 'Paris', unit: 'celsius' } });
  });

  it('不带 structuredOutput、或 options 为动态类型时不谎报结构化值:object 为 unknown', () => {
    // 建结果对象不消费、不发起 run;`typeof` 是类型查询,运行时不求值
    const plain = agent.stream('Weather?');
    expectAssignable<Promise<unknown>>(null as unknown as typeof plain.object);
    // @ts-expect-error 未声明 structuredOutput 时类型不说谎:object 不是某个具体结构化形状
    expectAssignable<Promise<{ city: string }>>(null as unknown as typeof plain.object);

    const dynamic: AgentRunOptions = { structuredOutput: { schema: weatherSchema } };
    const dynamicResult = agent.stream('Weather?', dynamic);
    expectAssignable<Promise<unknown>>(null as unknown as typeof dynamicResult.object);

    // 一般重载(无 structuredOutput 时 object 为 unknown):ReturnType 取最后一条重载签名
    expectAssignable<Promise<AgentGenerateResult>>(
      null as unknown as ReturnType<typeof agent.generate>,
    );
  });

  it('schema 必须是双接口契约:只有 validate 的单接口 schema 被类型拒绝(ADR-0003)', () => {
    const validateOnly = {
      '~standard': {
        version: 1 as const,
        vendor: 'test',
        validate: (value: unknown) => ({ value }),
      },
    };

    // @ts-expect-error 契约要求 ~standard.jsonSchema 一并具备(schema 要下发给模型)
    expectAssignable<StructuredOutputConfig>({ schema: validateOnly });
  });

  it('structuredOutput 是 run option,不是 Agent 定义字段(五字段之外无一物)', () => {
    expectAssignable<AgentRunOptions>({ structuredOutput: { schema: weatherSchema } });
    expectAssignable<AgentConfig>({
      name: 'assistant',
      instructions: INSTRUCTIONS,
      model: fakeModel([]),
      // @ts-expect-error structuredOutput 是 per-call 执行选项,不进 AgentConfig
      structuredOutput: { schema: weatherSchema },
    });
  });
});
