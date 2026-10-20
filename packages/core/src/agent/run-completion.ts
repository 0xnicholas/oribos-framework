import type { FinishReason, Usage } from '../model/chunks.js';
import { toStructuredObject } from './structured-output.js';
import type { AgentGenerateResult, AgentStep, StructuredOutputConfig } from './types.js';

/**
 * Run completion (ADR-0019): the one home that turns a run's authoritative step records and its
 * terminal reason into the run's terminal record (`text` / `object` / `toolCalls` / `toolResults` /
 * `usage` / `steps` / `finishReason`). The agent loop delegates here after its last step; failures
 * never reach it — they stay rejections, not terminal values.
 *
 * `finishReason === 'suspended'` is the sole suspended mode; every other reason reaching this
 * module is a completed run. Completion here means "the run reached a terminal record": a provider
 * that reports `'error'` as its finish reason still settles a terminal record, while a run that
 * failed (a model/tool/processor throw, a structured-output contract violation) rejects before it
 * ever reaches this module.
 *
 * The two modes differ in exactly one place:
 *
 * - **Completed** (`'stop'` / `'length'` / `'tool-calls'` / `'error'` at the run level): the last
 *   step's authoritative text settles `text`, and a structured run's text is parsed as JSON and
 *   validated against the schema — strictly, so a non-conforming answer fails the run with
 *   `StructuredOutputError` (execution semantics). A structured run's `object` is the validated
 *   value; a plain run's is `undefined`.
 * - **Suspended**: the step that suspended never completed (no processor hook, no memory save,
 *   no record), so only the completed steps' values are retained: their text (the last completed
 *   step's), flattened calls / results and accumulated usage. The run has no final answer yet, so
 *   `object` is `undefined` and structured validation is skipped — the answer arrives on resume.
 *
 * Internal module: not exported from any entry (the `standard-schema-runtime.ts` pattern). The
 * public seams around run continuation and output objects are separate ratifications (#200).
 */
export async function completeRun(
  steps: readonly AgentStep[],
  finishReason: FinishReason,
  structuredOutput: StructuredOutputConfig | undefined,
): Promise<AgentGenerateResult> {
  const text = steps.at(-1)?.text ?? '';
  return {
    text,
    object: await structuredObject(finishReason, structuredOutput, text),
    toolCalls: steps.flatMap((step) => step.toolCalls),
    toolResults: steps.flatMap((step) => step.toolResults),
    usage: steps.reduce<Usage>((total, step) => addUsage(total, step.usage), UNKNOWN_USAGE),
    finishReason,
    steps,
  };
}

/**
 * Whether a terminal reason means the run suspended. The rule's one home: the completion module
 * decides terminal values from it, and the loop consults it for the one reporting choice that is
 * not part of the terminal record (whether the structured `agent-run` span output settles).
 */
export function isSuspended(finishReason: FinishReason): boolean {
  return finishReason === 'suspended';
}

/**
 * The run's structured result: the terminal text parsed and validated for a completed structured
 * run, `undefined` otherwise. A suspended run's retained text is the last completed step's, not the
 * run's final answer — validating it would turn a normal suspension into a `StructuredOutputError`.
 */
async function structuredObject(
  finishReason: FinishReason,
  structuredOutput: StructuredOutputConfig | undefined,
  text: string,
): Promise<unknown> {
  return isSuspended(finishReason) || structuredOutput === undefined
    ? undefined
    : toStructuredObject(structuredOutput, text);
}

/** Usage before any step reported one: every field unknown. */
export const UNKNOWN_USAGE: Usage = {
  inputTokens: undefined,
  outputTokens: undefined,
  totalTokens: undefined,
};

/**
 * Adds one step's usage onto the run total.
 *
 * Unknown stays unknown: a field no step reported stays `undefined` rather than collapsing to 0.
 * `totalTokens` is derived exactly like the normalization layer derives it per model part
 * (`normalize.ts` `toUsage`): input + output when both are known, unknown otherwise.
 */
function addUsage(total: Usage, stepUsage: Usage): Usage {
  const inputTokens = addTokens(total.inputTokens, stepUsage.inputTokens);
  const outputTokens = addTokens(total.outputTokens, stepUsage.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens === undefined || outputTokens === undefined
        ? undefined
        : inputTokens + outputTokens,
  };
}

function addTokens(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a + b;
}
