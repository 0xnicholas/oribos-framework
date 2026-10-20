import type {
  AgentGenerateResult,
  AgentRunOptions,
  AgentRunResume,
  AgentStreamResult,
} from '../agent/types.js';
import type { ToolCallChunk, ToolResultChunk } from '../model/chunks.js';
import type { ModelMessage } from '../model/contract.js';
import { materialize } from '../output-object.js';

/**
 * The continuation seam for capability packages (ADR-0018): one suspended run's state as a pure
 * record, and the one skeleton that turns it back into a run. Durable agents are the first
 * consumer (their approval resume); checkpoints and other snapshot adapters map their own records
 * onto [`RunContinuation`] rather than re-implementing the load → seed → trace → drain →
 * materialize sequence.
 *
 * `continueRun` owns exactly the mechanics every continuation shares:
 *
 * - the message list becomes the resumed run's input verbatim (the core's resume path skips prompt
 *   assembly, memory recall and the input processors);
 * - the step count, the held calls and any pre-supplied answers become the `AgentRunResume` seed;
 * - the recorded trace id becomes the run option that continues the suspended run's trace;
 * - the continued segment's chunks are drained and its terminal record materialized, since a
 *   continuation resolves with an outcome rather than handing the chunks to a caller.
 *
 * The wrapper supplies `start` — its own `agent.stream` wiring, boundary included — and keeps
 * everything else: storage, the approval decision, and any extra fields on its output object.
 * The returned `output` is the wrapper's own object, already drained and settled, so reading
 * those extra fields (a durable wrapper's `suspendPayload`) after `continueRun` resolves is safe.
 *
 * `createResumeLock` is the in-process `(store, runId)` join-in-flight mechanism, published here
 * so a capability package can deduplicate its own resumes without copying the WeakMap registry.
 * The registry stays per consumer: create one instance per subsystem, as core's own wrappers do.
 *
 * Result construction stays internal (`agent/run-completion.ts`): this seam continues a run, it
 * does not decide what a completed or suspended run's terminal values are.
 */

/**
 * One suspended run's state, pure and storage-agnostic: exactly the facts a continuation needs,
 * mapped from whatever record a wrapper persists (`AgentRunSnapshot`, `AgentRunCheckpoint`, …).
 * The record carries no wrapper identity, no approval decision and no store: those stay the
 * caller's, which is what keeps this seam small.
 */
export interface RunContinuation {
  /**
   * The run's message list at its suspension point — the prompt plus the suspended step's own
   * assistant message. It is used verbatim as the resumed run's input.
   */
  readonly messages: readonly ModelMessage[];
  /**
   * How many steps the run had completed when it suspended — where the continued segment continues
   * numbering (indices, the `maxSteps` cap and seam events all count one run across a resume).
   */
  readonly stepCount: number;
  /**
   * The calls the suspended step held back, in call order: the continued segment replays them as
   * its first step without a model call.
   */
  readonly toolCalls: readonly ToolCallChunk[];
  /**
   * Pre-supplied results for held calls — the durable wrapper's rejection path answers the calls
   * the approval decision governs instead of executing them. Absent = every held call executes.
   */
  readonly answers?: readonly ToolResultChunk[] | undefined;
  /**
   * The trace the suspended run's spans were exported under. Present = the continued segment
   * opens its new `agent-run` span in that trace; absent = the run starts a fresh trace.
   */
  readonly traceId?: string | undefined;
}

/**
 * The wrapper's run starter: handed the resumed run's input, the run options (trace continuation
 * included) and the resume seed, it returns the wrapper's own output object. It is where the
 * wrapper attaches its boundary, its snapshot hook and its extra fields.
 */
export type ContinueRunStart<TStream extends AgentStreamResult> = (
  input: ModelMessage[],
  options: AgentRunOptions,
  resume: AgentRunResume,
) => TStream;

/** What a continuation resolves with: the drained output object and the run's terminal record. */
export interface ContinueRunResult<TStream extends AgentStreamResult> {
  /**
   * The wrapper's own output object, already drained and settled — its extra fields are readable
   * without starting or consuming anything further.
   */
  readonly output: TStream;
  /**
   * The continued segment's terminal record, materialized from the output's enumerable terminals.
   * A wrapper's extra enumerable fields ride along — the output object is the wrapper's — so they
   * must be settled values: `materialize` awaits every enumerable entry.
   */
  readonly result: AgentGenerateResult;
}

/**
 * Continues a suspended run from its pure record. See the module doc for the division of labor:
 * this function owns the record → input / seed / trace mapping, the drain and the materialize;
 * `start` owns the run's wiring and `options` is the continued segment's run shape (`maxSteps`,
 * `memory`, … — the fields not persisted with the snapshot).
 */
export async function continueRun<TStream extends AgentStreamResult>(
  start: ContinueRunStart<TStream>,
  continuation: RunContinuation,
  options: AgentRunOptions = {},
): Promise<ContinueRunResult<TStream>> {
  const resumedOptions =
    continuation.traceId === undefined
      ? { ...options }
      : { ...options, traceId: continuation.traceId };
  const output = start([...continuation.messages], resumedOptions, {
    stepCount: continuation.stepCount,
    toolCalls: [...continuation.toolCalls],
    ...(continuation.answers === undefined ? {} : { answers: [...continuation.answers] }),
  });
  // The continued segment's chunks have no consumer — a continuation resolves with an outcome —
  // so they are drained rather than left to buffer behind a reader that never comes.
  const iterator = output[Symbol.asyncIterator]();
  for (;;) {
    if ((await iterator.next()).done) break;
  }
  return { output, result: await materialize<AgentGenerateResult>(output) };
}

export { createResumeLock } from '../resume-lock.js';
export type { ResumeLock } from '../resume-lock.js';
