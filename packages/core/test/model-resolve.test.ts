import { describe, expect, it } from 'vitest';
import {
  MODEL_SPECIFICATION_VERSION,
  ModelContractError,
  ModelSpecificationVersionError,
  assertModel,
} from '@oribos/core/model';
import { fakeModel } from '@oribos/testing';
import { captureError } from './helpers/assertions.js';

/**
 * 模型解析期的 specificationVersion 硬断言(ADR-0004):不匹配必须显式报错,并指点
 * 该升级框架还是降级 provider 包——错误发生在解析期,不在运行中途。
 */

/** 结构上像模型、但不来自运行时的对象:只用来对断言接缝。 */
function modelLike(fields: Record<string, unknown>): unknown {
  return {
    specificationVersion: MODEL_SPECIFICATION_VERSION,
    provider: 'openai',
    modelId: 'gpt-4o',
    doGenerate: async () => ({}),
    doStream: async () => ({}),
    ...fields,
  };
}

describe('assertModel:specificationVersion 硬断言', () => {
  it('接受当前 spec 版本的模型实例并原样返回', () => {
    const model = fakeModel([{ text: 'hi' }]);

    expect(assertModel(model)).toBe(model);
  });

  it('provider 包过旧(v3):报错并指点升级 provider 包或降级框架', () => {
    const error = captureError(() => assertModel(modelLike({ specificationVersion: 'v3' })));

    expect(error).toBeInstanceOf(ModelSpecificationVersionError);
    expect(error).toBeInstanceOf(ModelContractError);
    expect(error.name).toBe('ModelSpecificationVersionError');
    expect(error.message).toContain("'v3'");
    expect(error.message).toContain("'v4'");
    expect(error.message).toMatch(/upgrade the provider package/);
    expect(error.message).toMatch(/downgrade @oribos\/core/);
  });

  it('provider 包过新(v5):报错并指点升级框架或降级 provider 包', () => {
    const error = captureError(() => assertModel(modelLike({ specificationVersion: 'v5' })));

    expect(error).toBeInstanceOf(ModelSpecificationVersionError);
    expect(error.message).toContain("'v5'");
    expect(error.message).toContain("'v4'");
    expect(error.message).toMatch(/upgrade @oribos\/core/);
    expect(error.message).toMatch(/downgrade the provider package/);
  });

  it('版本串无法识别时同样显式报错,并同时给出两个方向的动作', () => {
    const error = captureError(() => assertModel(modelLike({ specificationVersion: 'next' })));

    expect(error).toBeInstanceOf(ModelSpecificationVersionError);
    expect(error.message).toContain("'next'");
    expect(error.message).toMatch(/upgrade the provider package/i);
    expect(error.message).toMatch(/upgrade @oribos\/core/i);
  });

  it('同代但拼写不同的版本串按未知处理,同样给出两个方向的动作', () => {
    const error = captureError(() => assertModel(modelLike({ specificationVersion: 'v4.1' })));

    expect(error).toBeInstanceOf(ModelSpecificationVersionError);
    expect(error.message).toContain("'v4.1'");
    expect(error.message).toMatch(/upgrade the provider package/i);
    expect(error.message).toMatch(/upgrade @oribos\/core/i);
  });

  it('缺 specificationVersion 的对象不是模型', () => {
    const error = captureError(() => assertModel({ doGenerate: async () => ({}), doStream: async () => ({}) }));

    expect(error).toBeInstanceOf(ModelContractError);
    expect(error).not.toBeInstanceOf(ModelSpecificationVersionError);
    expect(error.message).toContain('undefined');
  });

  it('版本匹配但缺 doGenerate / doStream 时(如 embedding 模型)抛结构错误', () => {
    const error = captureError(() =>
      assertModel({ specificationVersion: 'v4', provider: 'openai', modelId: 'text-embedding-3-small' }),
    );

    expect(error).toBeInstanceOf(ModelContractError);
    expect(error).not.toBeInstanceOf(ModelSpecificationVersionError);
    expect(error.name).toBe('ModelContractError');
    expect(error.message).toMatch(/doGenerate/);
    expect(error.message).toMatch(/doStream/);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['字符串', 'openai("gpt-4o")'],
    ['数字', 42],
  ])('非对象输入(%s)抛显式错误', (_label, value) => {
    const error = captureError(() => assertModel(value));

    expect(error).toBeInstanceOf(ModelContractError);
    expect(error.message).toMatch(/language model instance/);
  });
});
