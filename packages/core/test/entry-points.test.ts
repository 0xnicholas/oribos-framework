import { describe, expect, it } from 'vitest';
import * as rootEntry from '@oribos/core';
import * as agentEntry from '@oribos/core/agent';
import * as agentRunEntry from '@oribos/core/agent-run';
import * as durableAgentEntry from '@oribos/core/durable-agent';
import * as memoryEntry from '@oribos/core/memory';
import * as modelEntry from '@oribos/core/model';
import * as observabilityEntry from '@oribos/core/observability';
import * as schedulesEntry from '@oribos/core/schedules';
import * as signalsEntry from '@oribos/core/signals';
import * as toolsEntry from '@oribos/core/tools';
import * as workflowsEntry from '@oribos/core/workflows';

/**
 * 每个公开子路径入口都能经工具链加载。vitest 把 `@oribos/core/*` 别名到源码(不依赖构建);
 * 构建产物层的同一个面由 `pnpm check:dist` 用真实包自引用验真。
 */
const ENTRIES = [
  ['@oribos/core', rootEntry],
  ['@oribos/core/model', modelEntry],
  ['@oribos/core/agent', agentEntry],
  ['@oribos/core/agent-run', agentRunEntry],
  ['@oribos/core/tools', toolsEntry],
  ['@oribos/core/observability', observabilityEntry],
  ['@oribos/core/workflows', workflowsEntry],
  ['@oribos/core/memory', memoryEntry],
  ['@oribos/core/signals', signalsEntry],
  ['@oribos/core/durable-agent', durableAgentEntry],
  ['@oribos/core/schedules', schedulesEntry],
] as const;

describe('子路径入口可加载', () => {
  it.each(ENTRIES)('%s 可加载', (_specifier, entry) => {
    expect(entry).toBeTypeOf('object');
  });
});
