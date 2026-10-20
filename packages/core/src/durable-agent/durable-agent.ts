import type { Agent } from '../agent/agent.js';
import { passThrough } from '../agent/boundary.js';
import type {
  AgentGenerateResult,
  AgentRunOptions,
  AgentRunResume,
  AgentStepBoundary,
  AgentStepBoundaryDecision,
  AgentStreamResult,
  AgentToolCallsBoundaryEvent,
  StructuredOutputConfig,
} from '../agent/types.js';
import type { Chunk, ToolCallChunk, ToolResultChunk } from '../model/chunks.js';
import type { ModelMessage } from '../model/contract.js';
import { materialize, teeOutputObject } from '../output-object.js';
import { createResumeLock } from '../resume-lock.js';
import type { StandardSchema, StandardSchemaV1 } from '../standard-schema.js';
import { createInMemoryAgentRunSnapshotStore } from './in-memory-snapshot-store.js';
import type { AgentRunSnapshot, AgentRunSnapshotStore, AgentRunSuspendPayload } from './snapshot.js';

/**
 * Durable agents: the agent wrapped so a run may suspend at a tool-calling boundary and be resumed
 * with a human's approval decision.
 *
 * The approval declaration lives here, never on `Tool` (`#13` keeps the core permission-free): a
 * call whose tool name is on the list does not execute — the run suspends instead, its loop
 * snapshot goes to the `AgentRunSnapshotStore`, and `finishReason` settles `'suspended'`. `resume`
 * loads the snapshot and continues the run: `approved: true` executes the held calls, `approved:
 * false` answers them with a user-rejected error result and lets the model replan — the run is not
 * terminated by a rejection. The wrapper owns snapshotting and approval; a bare agent run produces
 * `'suspended'` only when it is explicitly handed the public `stepBoundary` seam (the loop itself
 * keeps no snapshot and holds no approval state).
 *
 * Single-process semantics where it matters: the store's in-memory default keeps snapshots for this
 * process, and concurrent resumes of one snapshot — the same store and run id — are deduplicated
 * in process, across wrapper instances. The port is the
 * deployment surface — attaching a durable store and clearing a consumed snapshot are the
 * application's side (no CAS, no cross-process recovery).
 */

/**
 * The approval declaration (durable agents): the tool names whose calls must not run
 * until a resume approves them. Declared on the wrapper, not on the tool — a call whose name is on
 * the list suspends the run at the boundary where the model's calls are known and none has run.
 */
export interface ApprovalConfig {
  /** Tool names awaiting approval; a call to one of them suspends the run instead of executing. */
  readonly tools: readonly string[];
}

/** The `createDurableAgent` config. */
export interface DurableAgentConfig {
  /** The agent whose runs this wrapper gates, snapshots and resumes. */
  readonly agent: Agent;
  /**
   * Where a suspended run's snapshot goes. Absent = the core's in-memory default: suspend/resume
   * still works, the snapshot simply does not outlive the process.
   */
  readonly storage?: AgentRunSnapshotStore | undefined;
  /** The approval gate; absent = no call ever suspends (the wrapper is a pass-through). */
  readonly approval?: ApprovalConfig | undefined;
}

/**
 * The durable run surface: `agent.stream`'s output object, plus the run's durable identity (the key
 * `resume` takes) and what the approval gate held back when it suspended.
 */
export interface DurableStreamResult<TObject = unknown> extends AgentStreamResult<TObject> {
  /** Identity of this run — the `runId` its snapshot is stored under and `resume` loads by. */
  readonly runId: string;
  /**
   * What the run suspended with: the calls the gate held back and the ids awaiting the approval
   * decision. Resolves `undefined` when the run did not suspend (including when it failed) — read
   * it after `finishReason`, or together with it.
   */
  readonly suspendPayload: Promise<AgentRunSuspendPayload | undefined>;
}

/** What a resumed segment ends with: `stream()`'s terminal values, awaited, plus its identity. */
export interface DurableRunOutcome<TObject = unknown> extends AgentGenerateResult<TObject> {
  /** Identity of the run — the same id the suspended segment ran under. */
  readonly runId: string;
  /** The payload of a second suspension, when the resumed segment suspended again; else `undefined`. */
  readonly suspendPayload: AgentRunSuspendPayload | undefined;
}

/**
 * The `resume` options: the approval decision plus the run options the continued segment runs
 * under. The message list, the suspension point and the trace come from the snapshot, never from
 * here; `maxSteps` (and everything else the resumed segment should keep, `memory` included) is not
 * persisted with the snapshot, so pass it again to hold the run's original shape.
 */
export interface DurableResumeOptions extends AgentRunOptions {
  /** `true` executes the held calls, `false` answers them with a user-rejected tool result. */
  readonly approved: boolean;
}

/** The durable agent: the agent's run surface wrapped, plus `resume`. */
export interface DurableAgent {
  /**
   * Runs the agent once, exactly as `agent.stream` does, with the approval gate attached: a step
   * whose pending calls hit the approval list suspends the run (snapshot written, `finishReason`
   * `'suspended'`) instead of executing them. The run's chunks, terminal values and memory behavior
   * are the agent's own — the wrapper only adds the gate, the snapshot and `runId` /
   * `suspendPayload`.
   */
  stream<TSchema extends StandardSchema>(
    input: string | ModelMessage[],
    options: AgentRunOptions & { readonly structuredOutput: StructuredOutputConfig<TSchema> },
  ): DurableStreamResult<StandardSchemaV1.InferOutput<TSchema>>;
  stream(input: string | ModelMessage[], options?: AgentRunOptions): DurableStreamResult;
  /**
   * Continues a suspended run: loads its snapshot, replays the held calls under the approval
   * decision and drives the run to its next stop. Resolves with the segment's outcome (a run that
   * suspended again resolves `'suspended'` and is resumable under the same id). Concurrent resumes
   * of one snapshot — the same store and run id — are joined into the one in flight, even across
   * wrapper instances.
   */
  resume(runId: string, options: DurableResumeOptions): Promise<DurableRunOutcome>;
}

/**
 * What a suspended run's gate captured at the boundary — the snapshot's source, held only until the
 * run's end writes it to the store.
 */
interface Suspension {
  /** The run's message list at the boundary (`AgentStepBoundaryEvent.messages`). */
  readonly messages: readonly ModelMessage[];
  /** The 0-based index of the step that suspended — the snapshot's `stepCount`. */
  readonly stepIndex: number;
  /** The run's trace id, or `''` when untraced (then no `traceId` reaches the snapshot). */
  readonly traceId: string;
  /** The calls held back, with the ids the approval decision governs. */
  readonly payload: AgentRunSuspendPayload;
}

/** One run's gate state: what its suspension captured, if it suspended. */
interface RunState {
  suspension?: Suspension | undefined;
}

/**
 * The durable-agent subsystem's resume-lock registry (the same mechanism as the workflow
 * engine's, one registry per subsystem): one resume per snapshot identity — (store, runId) — at
 * a time. The registry lives at module level, so two wrappers over one store cannot consume the
 * same suspended snapshot twice: a concurrent resume joins the one in flight instead of loading
 * it again; the lock clears when that resume settles. Cross-process safety is the store's concern
 * — there is no CAS (the snapshot-store port).
 */
const resumeLock = createResumeLock();

/**
 * Creates the durable agent. See `DurableAgent` for the run surface.
 */
export function createDurableAgent(config: DurableAgentConfig): DurableAgent {
  const { agent } = config;
  const storage = config.storage ?? createInMemoryAgentRunSnapshotStore();
  const gate = new Set(config.approval?.tools ?? []);

  /**
   * The run's boundary wiring: the durable gate's `beforeToolCalls` around whatever the caller
   * passed, and their `beforeNextStep` (the signals injector's seat) untouched. The gate captures
   * the boundary's snapshot surface the moment it suspends, so the run's end can persist it; the
   * loop itself keeps no snapshot (`agent/loop.ts`).
   */
  function boundaryFor(state: RunState, user: AgentStepBoundary | undefined): AgentStepBoundary {
    const userGate = user?.beforeToolCalls;
    return {
      async beforeToolCalls(
        event: AgentToolCallsBoundaryEvent,
      ): Promise<AgentStepBoundaryDecision | void> {
        const theirs = await userGate?.(event);
        const hits = event.pendingCalls.filter((call) => gate.has(call.toolName));
        if (theirs?.suspend !== true && hits.length === 0) return undefined;
        state.suspension = {
          messages: [...event.messages],
          stepIndex: event.stepIndex,
          traceId: event.traceId,
          payload: {
            toolCalls: [...event.pendingCalls],
            // The approval list's hits are what the decision governs; a suspension decided outside
            // the list (the caller's own gate) holds the whole step, so its calls all await it.
            awaitingApproval: (hits.length > 0 ? hits : event.pendingCalls).map(
              (call) => call.toolCallId,
            ),
          },
        };
        return { suspend: true };
      },
      ...passThrough('beforeNextStep', user?.beforeNextStep),
    };
  }

  /**
   * Starts one run of the durable agent: the agent's own run with the gate wired in, wrapped so the
   * suspension is persisted at the run's end and reported on the output object. A fresh run mints
   * its id (`stream`); a continuation keeps the suspended run's (`resume`), so a second suspension
   * overwrites the same snapshot instead of scattering one run across ids.
   */
  function startRun(
    runId: string,
    input: string | ModelMessage[],
    options: AgentRunOptions | undefined,
    seed: AgentRunResume | undefined,
  ): DurableStreamResult {
    const state: RunState = {};
    const inner = agent.stream(input, {
      ...options,
      stepBoundary: boundaryFor(state, options?.stepBoundary),
      ...(seed === undefined ? {} : { resume: seed }),
    });
    let settlePayload!: (payload: AgentRunSuspendPayload | undefined) => void;
    const suspendPayload = new Promise<AgentRunSuspendPayload | undefined>((resolve) => {
      settlePayload = resolve;
    });
    const stream = teeOutputObject<Chunk, AgentGenerateResult>(inner, {
      // The run settled: the snapshot goes to the store first, so a caller that sees
      // `'suspended'` (its terminal values settle only after this hook) can resume right away —
      // the store already holds what resume loads. A failed run suspends nothing (the gate's
      // state is only ever set on a run that ends `'suspended'`), so its payload resolves
      // `undefined` here.
      beforeSettle: async () => {
        try {
          if (state.suspension !== undefined) {
            await storage.save(runId, toSnapshot(runId, state.suspension));
          }
          settlePayload(state.suspension?.payload);
        } catch (error) {
          // A snapshot the store refused suspends nothing: the payload still resolves
          // (`undefined`), and the save failure fails the run in place of its own outcome.
          settlePayload(undefined);
          throw error;
        }
      },
    });
    // The durable fields ride on the agent's output object without touching its terminal getters —
    // assigning reads no property of the target, so the run stays lazy (a spread would read them
    // all and start it).
    return Object.assign(stream, { runId, suspendPayload });
  }

  /** `resume`: load, decide, continue — deduplicated by snapshot identity (see the lock above). */
  function resume(runId: string, options: DurableResumeOptions): Promise<DurableRunOutcome> {
    if (typeof options.approved !== 'boolean') {
      throw new Error(
        `durable: resume('${runId}') needs an explicit approval decision — pass { approved: true } ` +
          'to execute the held calls, or { approved: false } to answer them with a rejection.',
      );
    }
    return resumeLock.run(storage, runId, () => continueRun(runId, options));
  }

  /** One run's resume: the load → decide → re-enter path. */
  async function continueRun(
    runId: string,
    options: DurableResumeOptions,
  ): Promise<DurableRunOutcome> {
    const snapshot = await storage.load(runId);
    if (snapshot === null) {
      throw new Error(
        `durable: run '${runId}' has no snapshot — resume() needs a run that suspended in this ` +
          'store (a durable agent without storage keeps its snapshots in process memory, for the ' +
          'wrapper that made them).',
      );
    }
    const { approved, ...runOptions } = options;
    const payload = snapshot.suspendPayload;
    // The rejection answers exactly the calls the decision governs: the approval list's hits. Held
    // calls outside the list never needed approval — they execute on either decision.
    const answers = approved
      ? undefined
      : payload.toolCalls
          .filter((call) => payload.awaitingApproval.includes(call.toolCallId))
          .map(toRejection);
    const outcome = startRun(
      runId,
      // The resumed segment continues the trace the suspended run was exported under
      // (the observability anchor): the traceId travels through the existing run option,
      // the only thing a resume takes from the snapshot besides the messages and the seed.
      [...snapshot.messages],
      snapshot.traceId === undefined ? runOptions : { ...runOptions, traceId: snapshot.traceId },
      {
        stepCount: snapshot.stepCount,
        toolCalls: [...payload.toolCalls],
        ...(answers === undefined ? {} : { answers }),
      },
    );
    // The resumed segment's chunks have no consumer — `resume` resolves with the outcome — so they
    // are drained rather than left to buffer behind a reader that never comes.
    const iterator = outcome[Symbol.asyncIterator]();
    for (;;) {
      if ((await iterator.next()).done) break;
    }
    const result = await materialize<AgentGenerateResult>(outcome);
    return { ...result, runId, suspendPayload: await outcome.suspendPayload };
  }

  return {
    stream(input: string | ModelMessage[], options?: AgentRunOptions): DurableStreamResult {
      return startRun(crypto.randomUUID(), input, options, undefined);
    },
    resume,
  };
}

/** The snapshot one suspension produces — spec shape, JSON-only (`snapshot.ts`). */
function toSnapshot(runId: string, suspension: Suspension): AgentRunSnapshot {
  return {
    runId,
    status: 'suspended',
    messages: suspension.messages,
    stepCount: suspension.stepIndex,
    suspendPayload: suspension.payload,
    ...(suspension.traceId === '' ? {} : { traceId: suspension.traceId }),
  };
}

/** The user-rejected result a rejected call is answered with (fed back like a tool failure). */
function toRejection(call: ToolCallChunk): ToolResultChunk {
  return {
    type: 'tool-result',
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: `The user rejected the approval request for tool '${call.toolName}' — it was not executed.`,
    isError: true,
  };
}
