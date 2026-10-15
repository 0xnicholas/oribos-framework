import { describe, expect, it } from 'vitest';
import { parseModelString } from '@oribos/model-router';
import { InvalidModelStringError } from '@oribos/model-router';

/**
 * `@oribos/model-router` — 字符串路由能力包(追赶面中层,篇级字符串路由行;#185)。
 *
 * 承载缝 = 目录 + 解析映射:核心「无注册表 / 无 magic string」钉子不动,`'provider/model'`
 * 字符串的拆分与目录校验都在包内。断言只走公开面:parse 的纯函数结果、resolver 对目录 +
 * 用户自带 provider 工厂的解析与错误面(issue #21 测试决策)。
 */

describe('parseModelString', () => {
  it('splits a plain provider/model string', () => {
    expect(parseModelString('groq/llama-3.3-70b-versatile')).toEqual({
      providerId: 'groq',
      modelId: 'llama-3.3-70b-versatile',
    });
  });

  it('splits on the first slash only — model ids may themselves contain slashes', () => {
    expect(parseModelString('deepinfra/meta-llama/llama-4-scout')).toEqual({
      providerId: 'deepinfra',
      modelId: 'meta-llama/llama-4-scout',
    });
  });

  it('accepts provider ids with dots and hyphens', () => {
    expect(parseModelString('cloudflare-workers-ai/foo.bar-1')).toEqual({
      providerId: 'cloudflare-workers-ai',
      modelId: 'foo.bar-1',
    });
  });

  it('rejects strings without a slash', () => {
    expect(() => parseModelString('gpt-4o')).toThrow(InvalidModelStringError);
  });

  it('rejects an empty provider or model segment', () => {
    expect(() => parseModelString('/model')).toThrow(InvalidModelStringError);
    expect(() => parseModelString('groq/')).toThrow(InvalidModelStringError);
    expect(() => parseModelString('')).toThrow(InvalidModelStringError);
  });

  it('rejects surrounding whitespace', () => {
    expect(() => parseModelString(' groq/llama-3.3-70b-versatile')).toThrow(InvalidModelStringError);
    expect(() => parseModelString('groq/llama-3.3-70b-versatile ')).toThrow(InvalidModelStringError);
  });
});
