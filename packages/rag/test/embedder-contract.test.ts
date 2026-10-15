import { describe, it } from 'vitest';
import type { EmbeddingModelV4 } from '@ai-sdk/provider';
import type { Embedder } from '@oribos/rag';
import { expectAssignable } from './helpers/assertions.js';

/**
 * vendor embedder 契约 ↔ devDependency 中真实 `@ai-sdk/provider` 的类型对校(沿 core 的
 * `model-contract.test.ts` 漂移防护先例,ADR-0004):`pnpm typecheck` 覆盖 `test/`,上游
 * embedding spec 的任何形状漂移都会让 CI 在这个文件变红。生态 provider 包产出的
 * embedding model 实例结构上天然满足本包契约——零适配、零注册表。
 */
describe('vendor embedder 契约 ↔ @ai-sdk/provider', () => {
  it('生态包产出的 embedding model 实例结构上天然满足 vendor 契约(零适配)', () => {
    expectAssignable<Embedder>(null as unknown as EmbeddingModelV4);
  });
});
