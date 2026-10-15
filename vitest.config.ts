import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coreSource = fileURLToPath(new URL('./packages/core/src', import.meta.url));
const mcpServerSource = fileURLToPath(new URL('./packages/mcp-server/src', import.meta.url));
const mcpClientSource = fileURLToPath(new URL('./packages/mcp-client/src', import.meta.url));
const sqliteSource = fileURLToPath(new URL('./packages/sqlite/src', import.meta.url));
const aiSdkSource = fileURLToPath(new URL('./packages/ai-sdk/src', import.meta.url));
const checkpointsSource = fileURLToPath(new URL('./packages/checkpoints/src', import.meta.url));
const otlpSource = fileURLToPath(new URL('./packages/otlp/src', import.meta.url));
const ragSource = fileURLToPath(new URL('./packages/rag/src', import.meta.url));
const resumableStreamSource = fileURLToPath(new URL('./packages/resumable-stream/src', import.meta.url));
const modelRouterSource = fileURLToPath(new URL('./packages/model-router/src', import.meta.url));
const otelBridgeSource = fileURLToPath(new URL('./packages/otel-bridge/src', import.meta.url));
const semconvSource = fileURLToPath(new URL('./packages/semconv/src', import.meta.url));
const distributedSignalsSource = fileURLToPath(
  new URL('./packages/distributed-signals/src', import.meta.url),
);
const cronerSource = fileURLToPath(new URL('./packages/croner/src', import.meta.url));
const evalsSource = fileURLToPath(new URL('./packages/evals/src', import.meta.url));
const supervisorSource = fileURLToPath(new URL('./packages/supervisor/src', import.meta.url));
const testingSource = fileURLToPath(new URL('./packages/testing/src', import.meta.url));

export default defineConfig({
  // 测试走 `@oribos/core/*` 与 `@oribos/mcp-server` / `@oribos/mcp-client` 公开入口,别名指向源码:不依赖构建,接缝与用户看到的一致。
  // `@oribos/testing`(私有的规范假模型包,#120)同例:别名指 src,包身不进发布面、不建 dist。
  resolve: {
    alias: [
      { find: /^@oribos\/core$/, replacement: `${coreSource}/index.ts` },
      { find: /^@oribos\/core\/(.*)$/, replacement: `${coreSource}/$1/index.ts` },
      { find: /^@oribos\/mcp-server$/, replacement: `${mcpServerSource}/index.ts` },
      { find: /^@oribos\/mcp-client$/, replacement: `${mcpClientSource}/index.ts` },
      { find: /^@oribos\/sqlite$/, replacement: `${sqliteSource}/index.ts` },
      { find: /^@oribos\/ai-sdk$/, replacement: `${aiSdkSource}/index.ts` },
      { find: /^@oribos\/checkpoints$/, replacement: `${checkpointsSource}/index.ts` },
      { find: /^@oribos\/otlp$/, replacement: `${otlpSource}/index.ts` },
      { find: /^@oribos\/rag$/, replacement: `${ragSource}/index.ts` },
      { find: /^@oribos\/resumable-stream$/, replacement: `${resumableStreamSource}/index.ts` },
      { find: /^@oribos\/model-router$/, replacement: `${modelRouterSource}/index.ts` },
      { find: /^@oribos\/otel-bridge$/, replacement: `${otelBridgeSource}/index.ts` },
      { find: /^@oribos\/semconv$/, replacement: `${semconvSource}/index.ts` },
      { find: /^@oribos\/distributed-signals$/, replacement: `${distributedSignalsSource}/index.ts` },
      { find: /^@oribos\/croner$/, replacement: `${cronerSource}/index.ts` },
      { find: /^@oribos\/evals$/, replacement: `${evalsSource}/index.ts` },
      { find: /^@oribos\/supervisor$/, replacement: `${supervisorSource}/index.ts` },
      { find: /^@oribos\/testing$/, replacement: `${testingSource}/index.ts` },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
