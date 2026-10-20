import { z } from 'zod';
import { Agent } from '@oribos/core/agent';
import type { ModelInput } from '@oribos/core/agent';
import { createTool } from '@oribos/core/tools';
import type { Tool } from '@oribos/core/tools';

/** 测试 fixture:一行 system 指令。多个测试文件从同一份实现取用,不各自复制。 */
export const INSTRUCTIONS = 'You are concise.';

/** 测试 fixture:结构化输出的参考 schema(输入/输出同型)。 */
export const weatherSchema = z.object({
  city: z.string(),
  temperatureCelsius: z.number(),
});

/** 测试 fixture:参考工具(zod 双接口 schema,输入 city)。 */
export function weatherTool(execute: (input: { city: string }) => unknown): Tool {
  return createTool({
    description: 'Looks up the weather.',
    inputSchema: z.object({ city: z.string() }),
    execute,
  });
}

/** 测试 fixture:需要审批的资金转移工具(审批闸拦下的那个)。 */
export function transferTool(execute: (input: { to: string }) => unknown): Tool {
  return createTool({
    description: 'Moves money.',
    inputSchema: z.object({ to: z.string() }),
    execute,
  });
}

/**
 * 测试用 agent 工厂:五字段最小表面(instructions 固定为一行),可选工具容器——多个测试文件从
 * 同一份实现取用,不各自复制(规则见 `helpers/assertions.ts`)。model 接受 `ModelInput` 全形状,
 * 单实例与 fallback 链共用同一份构造。
 */
export function assistant(model: ModelInput): Agent {
  return new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model });
}

/** 同上的带工具版本;工具容器按测试自备。 */
export function assistantWithTools(model: ModelInput, tools: Record<string, Tool>): Agent {
  return new Agent({ name: 'assistant', instructions: INSTRUCTIONS, model, tools });
}
