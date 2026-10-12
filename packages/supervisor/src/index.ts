/**
 * `@oribos/supervisor` — the supervisor capability package: the as-tool composition
 * (`docs/architecture/agent.md`「多 agent 组合」, ADR-0012) standardized as one factory.
 *
 * `createSupervisor({ ..., agents: { researcher } })` returns a plain `Agent` whose tools container
 * carries one delegation tool per `agents` entry — the record key is the tool name, exactly like a
 * hand-written container. Delegation is an ordinary tool call: the wrapper explicitly constructs
 * the delegated input (zero parent-context passthrough), passes `signal` / `traceId` / `spanId`
 * straight through, and feeds the sub-run's terminal text back as the tool result. The core gains
 * no seam — everything here is composed over the public surface, and the returned supervisor is a
 * real `Agent` (itself composable as a tool, wrappable by the durable gate, and so on).
 *
 * Package face: [`createSupervisor`], [`SupervisorConfig`], [`DelegationOptions`],
 * [`DelegationInput`], [`DelegationResult`].
 */
import { Agent, resolveDynamicArgument } from '@oribos/core/agent';
import type {
  AgentConfig,
  AgentMemoryOptions,
  DynamicArgument,
  RequestContext,
} from '@oribos/core/agent';
import type { FinishReason } from '@oribos/core/model';
import { createTool } from '@oribos/core/tools';
import type { StandardSchema, Tool, ToolContext } from '@oribos/core/tools';

/** The delegation tool's input: one prompt, the whole of what the parent hands the sub-agent. */
export interface DelegationInput {
  readonly prompt: string;
}

/**
 * What a delegation tool feeds back to the supervisor's model: the sub-run's terminal text, bare
 * when the sub-run finished `'stop'`; otherwise an object that also names the finishReason, so a
 * truncated (`'tool-calls'` / `'length'`) or suspended sub-run is visible to the parent model
 * instead of being silently read as a complete answer. A *failing* sub-run never reaches this
 * shape — its throw is framed by the loop as an error tool result, like any tool's.
 */
export type DelegationResult = string | { readonly text: string; readonly finishReason: FinishReason };

/**
 * The per-delegation knobs of `createSupervisor` — everything else a delegation run could take
 * stays with the sub-agent's own config (its model, tools, processors) or is a deliberate
 * delegation-level decision the wrapper makes for you (input construction, trace/signal
 * passthrough).
 */
export interface DelegationOptions {
  /**
   * Step cap of every delegation run (`AgentRunOptions.maxSteps`). Absent = the core default (5).
   * A sub-agent that exhausts it finishes `'tool-calls'` and the parent model sees that (see
   * `DelegationResult`).
   */
  readonly maxSteps?: number;
  /**
   * Memory identity of delegation runs — absent = stateless delegation (the default: the wrapper
   * passes no `memory` option and the sub-run does no memory I/O). A static value fixes one
   * thread/resource for every delegation; a function derives the identity per call from the
   * delegation input and tool context (the thread policy — new thread per delegation, one per
   * caller, … — stays the application's, `agent.md`「多 agent 组合」).
   */
  readonly memory?:
    | AgentMemoryOptions
    | ((
        input: DelegationInput,
        ctx: ToolContext,
      ) => AgentMemoryOptions | undefined | Promise<AgentMemoryOptions | undefined>);
}

/**
 * `createSupervisor`'s config: the full `AgentConfig` plus `agents`, the sub-agent container. The
 * record key is the delegation tool's name (container keys are the single source of a tool's
 * name); the tool's description is the sub-agent's `description` resolved per parent run
 * (`resolveDynamicArgument`), falling back to the sub-agent's `name`.
 */
export interface SupervisorConfig extends Omit<AgentConfig, 'tools'> {
  /** The sub-agents, key = delegation tool name. At least one. */
  readonly agents: Record<string, Agent>;
  /** The supervisor's own tools, merged with the delegation tools; a key collision fails the run. */
  readonly tools?: DynamicArgument<Record<string, Tool>>;
  /** Per-delegation knobs, applied to every delegation run alike. */
  readonly delegation?: DelegationOptions;
}

/**
 * The delegation tool's input schema — `{ prompt: string }` as a hand-written Standard Schema
 * dual interface, so the package carries no schema-library dependency (ADR-0003: any
 * implementation speaks the contract; a fixed one-field shape needs none).
 */
const delegationInputSchema: StandardSchema<DelegationInput> = {
  '~standard': {
    version: 1,
    vendor: '@oribos/supervisor',
    validate: (value) => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return { issues: [{ message: 'delegation input must be an object with a string `prompt`' }] };
      }
      const prompt = (value as Record<string, unknown>)['prompt'];
      if (typeof prompt !== 'string') {
        return {
          issues: [
            {
              message: 'delegation input `prompt` must be a string',
              path: [{ key: 'prompt' }],
            },
          ],
        };
      }
      return { value: { prompt } };
    },
    jsonSchema: {
      input: () => delegationInputJsonSchema,
      output: () => delegationInputJsonSchema,
    },
  },
};

const delegationInputJsonSchema = {
  type: 'object',
  properties: { prompt: { type: 'string' } },
  required: ['prompt'],
  additionalProperties: false,
} as const;

/** One `agents` entry as one delegation tool, built per parent run (descriptions stay dynamic). */
async function toDelegationTool(
  agent: Agent,
  delegation: DelegationOptions | undefined,
  ctx: RequestContext,
): Promise<Tool<DelegationInput>> {
  return createTool({
    description: (await resolveDynamicArgument(agent.description, ctx)) ?? agent.name,
    inputSchema: delegationInputSchema,
    execute: async (input, toolCtx) => {
      const memory =
        delegation?.memory === undefined
          ? undefined
          : typeof delegation.memory === 'function'
            ? await delegation.memory(input, toolCtx)
            : delegation.memory;
      const result = await agent.generate(input.prompt, {
        signal: toolCtx.signal,
        traceId: toolCtx.traceId,
        parentSpanId: toolCtx.spanId,
        ...(delegation?.maxSteps === undefined ? {} : { maxSteps: delegation.maxSteps }),
        ...(memory === undefined ? {} : { memory }),
      });
      return result.finishReason === 'stop'
        ? result.text
        : { text: result.text, finishReason: result.finishReason };
    },
  });
}

/**
 * Builds the supervisor: a plain `Agent` whose `tools` resolve, per run, to the caller's own
 * `tools` merged with one delegation tool per `agents` entry. A key that exists in both fails the
 * run at tools resolution, naming the key — the same place a bad dynamic `tools` resolver fails.
 */
export function createSupervisor(config: SupervisorConfig): Agent {
  const entries = Object.entries(config.agents);
  if (entries.length === 0) {
    throw new Error(
      'createSupervisor: `agents` must name at least one sub-agent — an empty record builds a ' +
        'supervisor with nothing to delegate to.',
    );
  }
  const maxSteps = config.delegation?.maxSteps;
  if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps <= 0)) {
    throw new Error(
      `createSupervisor: \`delegation.maxSteps\` must be a positive integer, got ${String(maxSteps)}.`,
    );
  }
  const { agents, delegation, tools, ...agentConfig } = config;
  const name = config.name;
  const mergedTools: DynamicArgument<Record<string, Tool>> = async (ctx) => {
    const own = tools === undefined ? undefined : await resolveDynamicArgument(tools, ctx);
    const merged: Record<string, Tool> = { ...own };
    for (const [toolName, agent] of entries) {
      if (own !== undefined && Object.hasOwn(own, toolName)) {
        throw new Error(
          `createSupervisor('${name}'): tool name '${toolName}' collides — the same key is in ` +
            'both `tools` and `agents`.',
        );
      }
      merged[toolName] = await toDelegationTool(agent, delegation, ctx);
    }
    return merged;
  };
  return new Agent({ ...agentConfig, tools: mergedTools });
}
