import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent } from '@oribos/core/agent';
import { createTool } from '@oribos/core/tools';
import { fakeModel } from '@oribos/testing';

/**
 * 工具容器 → 发给模型的工具列表(M1-06 #27,tools.md):容器键即工具名;每个工具的
 * `inputSchema` 经 `~standard.jsonSchema` 出 JSON Schema 直通给 provider(draft-07);无参工具
 * 自动补空 object schema;无工具时不发 tools 字段。断言只走公开面 + 脚本化假模型接缝:
 * 假模型录制的 call options 就是"模型收到的工具列表"。
 */
describe('工具容器与发给模型的工具列表', () => {
  it('schema 经 ~standard.jsonSchema 直通:模型收到的就是转换器的产物(引用不变)', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    // JSON Schema 直通探针:转换器返回同一对象引用,便于断言"未被框架改写/重建"。
    const parameters = {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      'x-probe': true,
    };
    const probeSchema = {
      '~standard': {
        version: 1 as const,
        vendor: 'probe',
        validate: (value: unknown) => ({ value }),
        jsonSchema: {
          input: () => parameters,
          output: () => parameters,
        },
      },
    };

    const agent = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model,
      tools: {
        search: {
          description: 'Searches the web.',
          inputSchema: probeSchema,
          execute: () => 'ok',
        },
      },
    });

    await agent.generate('Search for oribos.');

    expect(model.streamCalls[0]?.tools).toEqual([
      {
        type: 'function',
        name: 'search',
        description: 'Searches the web.',
        inputSchema: parameters,
      },
    ]);
    const sent = model.streamCalls[0]?.tools?.[0];
    if (sent?.type !== 'function') throw new Error('expected the model to receive a function tool');
    expect(sent.inputSchema).toBe(parameters);
  });

  it('zod@4 工具:schema 直通给 provider,与 ~standard.jsonSchema.input 直调结果一致', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const inputSchema = z.object({
      city: z.string(),
      unit: z.enum(['celsius', 'fahrenheit']).optional(),
    });

    const agent = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model,
      tools: {
        weather: {
          description: 'Looks up the weather.',
          inputSchema,
          execute: () => 'ok',
        },
      },
    });

    await agent.generate('Weather in Paris?');

    expect(model.streamCalls[0]?.tools).toEqual([
      {
        type: 'function',
        name: 'weather',
        description: 'Looks up the weather.',
        inputSchema: inputSchema['~standard'].jsonSchema.input({ target: 'draft-07' }),
      },
    ]);
  });

  it('无参工具省略 inputSchema:发给 provider 的 parameters 是空 object schema', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const agent = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model,
      tools: {
        ping: createTool({ description: 'Pings the service.', execute: () => 'pong' }),
      },
    });

    await agent.generate('Ping.');

    expect(model.streamCalls[0]?.tools).toEqual([
      {
        type: 'function',
        name: 'ping',
        description: 'Pings the service.',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);
  });

  it('工具容器的每个键各成一个工具,键即工具名', async () => {
    const model = fakeModel([{ text: 'ok' }]);
    const agent = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model,
      tools: {
        search: { description: 'Searches the web.', execute: () => 'ok' },
        weather: { description: 'Looks up the weather.', execute: () => 'ok' },
      },
    });

    await agent.generate('Go.');

    expect(model.streamCalls[0]?.tools?.map((tool) => tool.name)).toEqual(['search', 'weather']);
  });

  it('容器键重名:构造 Agent 的字面量在构造处即报错(Record 键唯一性)', () => {
    const model = fakeModel([]);
    const agent = new Agent({
      name: 'assistant',
      instructions: 'You are concise.',
      model,
      tools: {
        search: { description: 'Searches the web.', execute: () => 'a' },
        // @ts-expect-error 键即工具名:同一字面量重名在编译期报错(TS1117),重名不会拖到运行中
        search: { description: 'Searches the archive.', execute: () => 'b' },
      },
    });

    // 运行期语义:对象不能携带重复键,容器只有一个 search——重名早在构造处暴露。
    expect(Object.keys(agent.tools ?? {})).toEqual(['search']);
  });

  it('无 tools 的 agent 不发 tools 字段(空容器同样不发)', async () => {
    const withoutTools = fakeModel([{ text: 'ok' }]);
    await new Agent({ name: 'a', instructions: 'You are concise.', model: withoutTools }).generate(
      'Say hi.',
    );
    expect(withoutTools.streamCalls[0]?.tools).toBeUndefined();

    const emptyContainer = fakeModel([{ text: 'ok' }]);
    await new Agent({
      name: 'a',
      instructions: 'You are concise.',
      model: emptyContainer,
      tools: {},
    }).generate('Say hi.');
    expect(emptyContainer.streamCalls[0]?.tools).toBeUndefined();
  });
});
