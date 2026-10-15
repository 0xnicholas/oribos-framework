import { describe, expect, it } from 'vitest';
import { createModelRouter } from '@oribos/model-router';
import {
  InvalidModelStringError,
  ModelProviderMissingError,
  UnknownModelError,
  UnknownModelProviderError,
} from '@oribos/model-router';
import type { ModelCatalog, ModelProviderFactory } from '@oribos/model-router';
import { ModelContractError, ModelSpecificationVersionError } from '@oribos/core/model';
import type { Model } from '@oribos/core/model';

/**
 * Resolver 面:目录 + 用户自带的 provider 工厂 → 模型契约实例。目录 fixture 贴 models.dev
 * api.json 的形状(含解析不消费的多余字段——快照原样粘进来即可用)。
 */

/** 最小契约模型:路由只构造不调用,doGenerate / doStream 记录后抛错即可证明「未被调用」。 */
function stubModel(provider: string, modelId: string): Model {
  return {
    specificationVersion: 'v4',
    provider,
    modelId,
    doGenerate: () => {
      throw new Error('routing constructs; it does not call');
    },
    doStream: () => {
      throw new Error('routing constructs; it does not call');
    },
  };
}

/** 录制型工厂:断言「工厂收到的正是目录键里的 model id」。 */
function recordingFactory(
  provider: string,
  calls: string[],
): ModelProviderFactory {
  return (modelId) => {
    calls.push(modelId);
    return stubModel(provider, modelId);
  };
}

const CATALOG: ModelCatalog = {
  groq: {
    id: 'groq',
    name: 'Groq',
    npm: '@ai-sdk/groq',
    env: ['GROQ_API_KEY'],
    // 多余字段(models.dev 快照原样):解析不消费、原样容忍。
    doc: 'https://console.groq.com/docs/',
    models: {
      'llama-3.3-70b-versatile': {
        id: 'llama-3.3-70b-versatile',
        name: 'Llama 3.3 70B Versatile',
        tool_call: true,
        limit: { context: 131072, output: 32768 },
        cost: { input: 0.59, output: 0.79 },
      },
      'deepinfra-style/id-with-slash': {
        name: 'an id that itself contains a slash',
        limit: { context: 8192 },
      },
    },
  },
  cerebras: {
    npm: '@ai-sdk/cerebras',
    models: {
      'qwen-3-32b': { name: 'Qwen 3 32B' },
    },
  },
};

describe('createModelRouter', () => {
  it('routes a catalog-listed model through the registered factory', () => {    const calls: string[] = [];
    const route = createModelRouter({
      catalog: CATALOG,
      providers: { groq: recordingFactory('groq', calls) },
    });

    const model = route('groq/llama-3.3-70b-versatile');

    expect(calls).toEqual(['llama-3.3-70b-versatile']);
    expect(model.provider).toBe('groq');
    expect(model.modelId).toBe('llama-3.3-70b-versatile');
    expect(model.specificationVersion).toBe('v4');
  });

  it('routes model ids that themselves contain slashes as one id', () => {
    const calls: string[] = [];
    const route = createModelRouter({
      catalog: CATALOG,
      providers: { groq: recordingFactory('groq', calls) },
    });

    const model = route('groq/deepinfra-style/id-with-slash');

    expect(calls).toEqual(['deepinfra-style/id-with-slash']);
    expect(model.modelId).toBe('deepinfra-style/id-with-slash');
  });
});

describe('createModelRouter — the catalog as guard', () => {
  const FACTORIES: Readonly<Record<string, ModelProviderFactory>> = {
    groq: (id) => stubModel('groq', id),
    cerebras: (id) => stubModel('cerebras', id),
  };

  it('refuses a provider the catalog does not carry', () => {
    const route = createModelRouter({ catalog: CATALOG, providers: FACTORIES });
    expect(() => route('openai/gpt-4o')).toThrow(UnknownModelProviderError);
    try {
      route('openai/gpt-4o');
      expect.unreachable('route should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('the catalog carries 2 provider(s)');
    }
  });

  it('refuses a model the provider does not list', () => {
    const route = createModelRouter({ catalog: CATALOG, providers: FACTORIES });
    expect(() => route('groq/not-in-the-catalog')).toThrow(UnknownModelError);
  });

  it('refuses a catalog provider with no registered factory, naming its npm package', () => {
    const route = createModelRouter({ catalog: CATALOG, providers: { groq: FACTORIES.groq! } });
    expect(() => route('cerebras/qwen-3-32b')).toThrow(ModelProviderMissingError);
    try {
      route('cerebras/qwen-3-32b');
      expect.unreachable('route should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('@ai-sdk/cerebras');
    }
  });

  it('surfaces an unparseable string as the parse error', () => {
    const route = createModelRouter({ catalog: CATALOG, providers: FACTORIES });
    expect(() => route('no-slash-here')).toThrow(InvalidModelStringError);
  });
});

describe('createModelRouter — contract validation at resolution time', () => {
  it('refuses a factory result that is not a language model', () => {
    const route = createModelRouter({
      catalog: CATALOG,
      providers: { groq: () => ({ not: 'a model' }) },
    });
    expect(() => route('groq/llama-3.3-70b-versatile')).toThrow(ModelContractError);
  });

  it('refuses a factory result of an unsupported specification version', () => {
    const route = createModelRouter({
      catalog: CATALOG,
      providers: {
        groq: () => ({
          specificationVersion: 'v2',
          provider: 'groq',
          modelId: 'stale-generation',
          doGenerate: () => null,
          doStream: () => null,
        }),
      },
    });
    expect(() => route('groq/llama-3.3-70b-versatile')).toThrow(ModelSpecificationVersionError);
  });
});
