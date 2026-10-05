import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const coreSource = fileURLToPath(new URL('./packages/core/src', import.meta.url));
const mcpServerSource = fileURLToPath(new URL('./packages/mcp-server/src', import.meta.url));
const mcpClientSource = fileURLToPath(new URL('./packages/mcp-client/src', import.meta.url));
const sqliteSource = fileURLToPath(new URL('./packages/sqlite/src', import.meta.url));
const aiSdkSource = fileURLToPath(new URL('./packages/ai-sdk/src', import.meta.url));
const otlpSource = fileURLToPath(new URL('./packages/otlp/src', import.meta.url));
const cronerSource = fileURLToPath(new URL('./packages/croner/src', import.meta.url));
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
      { find: /^@oribos\/otlp$/, replacement: `${otlpSource}/index.ts` },
      { find: /^@oribos\/croner$/, replacement: `${cronerSource}/index.ts` },
      { find: /^@oribos\/testing$/, replacement: `${testingSource}/index.ts` },
    ],
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
