/**
 * `@oribos/core/agent` — agent core.
 *
 * Five-field surface, dynamic arguments and RequestContext, dual-consumption output object,
 * built-in loop, processors, structured output, and as-tool composition.
 */
export { Agent } from './agent.js';
export { resolveDynamicArgument } from './dynamic.js';
export { StructuredOutputError } from './structured-output.js';
export type { DeltaEmission } from '../model/chunks.js';
export type {
  FailureSite,
  ProcessErrorArgs,
  ProcessErrorResult,
  ProcessInputArgs,
  ProcessInputResult,
  ProcessOutputStepArgs,
  ProcessOutputStepResult,
  Processor,
} from './processors.js';
export type {
  AgentConfig,
  AgentGenerateResult,
  AgentMemoryOptions,
  AgentRunOptions,
  AgentRunResume,
  AgentStep,
  AgentStepBoundary,
  AgentStepBoundaryDecision,
  AgentStepBoundaryEvent,
  AgentStreamResult,
  AgentToolCallsBoundaryEvent,
  DynamicArgument,
  ModelInput,
  ModelSettings,
  RequestContext,
  StructuredOutputConfig,
  ToolExecution,
} from './types.js';
