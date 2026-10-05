import { resolveDynamicArgument } from '../agent/dynamic.js';
import type { RequestContext } from '../agent/types.js';
import { WORKFLOW_RUN_SPAN, WORKFLOW_STEP_SPAN } from '../observability/index.js';
import type { Span, Tracer } from '../observability/index.js';
import { normalizeTraceContinuation } from '../observability/span.js';
import type { StandardSchema } from '../standard-schema.js';
import { abortableSleep, throwIfAborted } from './abort.js';
import type {
  BranchEntry,
  DountilEntry,
  DowhileEntry,
  ForeachEntry,
  ParallelEntry,
  SleepEntry,
  WorkflowEntry,
} from './entry.js';
import type { WorkflowEvent } from './events.js';
import type {
  StepStatus,
  WorkflowIterationSite,
  WorkflowRunSnapshot,
  WorkflowRunStatus,
  WorkflowSnapshotStore,
  WorkflowStepResultSnapshot,
} from './snapshot.js';
import type { Step, StepContext } from './step.js';
import { isSuspendSignal, SuspendSignal } from './suspend.js';
import { validateResumeData, validateRunInput, validateStepInput } from './validate.js';
import type { Workflow } from './workflow.js';
import type { WorkflowRunOutcome } from './run.js';
import { executeWithRetries } from './retry.js';

/**
 * The semantic kernel — workflow definitions and builders, the run lifecycle, control-flow
 * operators and suspend/resume with snapshots: a `for` loop over the workflow's flat entry list,
 * interpreting entry by
 * entry — there is no DAG. Each entry receives the previous entry's output (the run's input for the
 * first one) and its output becomes the next entry's value: `then` pipes a step's output through,
 * `parallel` runs every step concurrently and keys the outputs by step id, `branch` runs the first
 * step whose condition is truthy and keys the output the same way, `foreach` maps an array through
 * one step and collects an array, `dowhile` / `dountil` fold a step until their condition stops
 * holding, and `sleep` waits in process for a resolved duration.
 *
 * Running is also suspending: a step's `suspend(payload)` throws the control signal up to this loop,
 * which writes the run's snapshot — with the entry position, plus the block's iteration site when
 * the step ran inside a block (#54) — and returns the `suspended` outcome. The run unwinds, and
 * `run.resume` re-enters this same loop from the snapshot's `position` (inside its block, from
 * the site). Snapshots are written at fixed points, never through hooks: after every completed entry
 * when storage is attached, at a suspend, and at the terminal state.
 *
 * The walk is instrumented at the very boundaries it records: the lifecycle events
 * (run-start / step-start / step-end / run-end) go to the `emit` sink as the boundaries are
 * crossed, and the same points open the `workflow-run` / `workflow-step` spans when a tracer is
 * attached to the definition.
 */

/**
 * What a run reads of its workflow: the identity, the start input schema, the tracer slot and the
 * frozen entries. `tracer` / `storage` are the definition's wiring slots — optional here, so a
 * hand-built definition (a test, a storeless run) only spells the definition surface itself.
 */
export type WorkflowDefinition<TInputSchema extends StandardSchema = StandardSchema> = Pick<
  Workflow<TInputSchema>,
  'id' | 'inputSchema' | 'entries'
> & {
  /** Tracer the run's and its steps' spans hang under; absent = no span object is ever created. */
  readonly tracer?: Tracer | undefined;
  /** Snapshot store attached to the definition; absent = the run keeps its snapshots in memory. */
  readonly storage?: WorkflowSnapshotStore | undefined;
};

/**
 * The point a resumed walk re-enters from (suspend/resume and snapshots):
 * what the snapshot says about the suspension — the suspended step, its raw `resumeData` (validated
 * here, at the third IO boundary), the entry position (`startIdx` equivalent) and the records the
 * completed part of the run left behind.
 */
export interface WalkResumePoint {
  /** The suspended step the run comes back to. */
  readonly stepId: string;
  /** The caller's resume data; validated against the step's `resumeSchema` before anything runs. */
  readonly resumeData: unknown;
  /** The entry index to re-enter the loop from. */
  readonly position: number;
  /** The snapshot's per-step records: the tip is rebuilt from them, never by re-running entries. */
  readonly stepResults: Readonly<Record<string, WorkflowStepResultSnapshot>>;
  /**
   * The block's iteration site (#54): present when the run suspended inside a block, and the walk
   * re-enters that block from it. Absent = the top-level `then` suspension of the earlier shape.
   */
  readonly iterationSite?: WorkflowIterationSite | undefined;
  /**
   * The trace the suspended run's spans belong to (`WorkflowRunSnapshot.traceId`): the resumed
   * segment opens a new `workflow-run` span in it, so a suspension does not break the trace.
   */
  readonly traceId?: string | undefined;
}

/** One walk's outer state: the run's identity, its input, the store it writes and the records it keeps. */
export interface WalkOptions {
  /** Identity of the run being walked. */
  readonly runId: string;
  /** The run's start input, `inputData` of the first entry. */
  readonly inputData: unknown;
  /** The run's request context — the same object every step receives. */
  readonly requestContext: RequestContext;
  /** Cancellation, checked before every entry and propagated into every step. */
  readonly signal: AbortSignal;
  /** The snapshot store the walk writes to: the attached one, or the run's in-memory default. */
  readonly storage: WorkflowSnapshotStore;
  /**
   * Whether a snapshot follows every completed entry (`running`, `position` = the next entry).
   * Only worth writing when a real store is attached — an in-memory store dies with the process.
   */
  readonly persistStepBoundaries: boolean;
  /** Present on a resumed walk: re-enter at this point instead of starting from the run input. */
  readonly resume?: WalkResumePoint | undefined;
  /**
   * Trace the run's first segment continues (`WorkflowCreateRunOptions.traceId` / `parentSpanId`),
   * when the caller passed one. A resume's continuation comes from the snapshot instead.
   */
  readonly trace?: WalkTraceContinuation | undefined;
  /**
   * The lifecycle event sink (streaming events): the output object's
   * buffer on a start, nothing on a resume (which is a promise, not a stream). Absent = the events
   * are built and dropped.
   */
  readonly emit?: ((event: WorkflowEvent) => void) | undefined;
}

/** The trace a start continues — the run-level continuation pair of the external-trace option. */
export interface WalkTraceContinuation {
  /** The trace to continue; an empty string voids the pair (a span with an empty trace id is broken). */
  readonly traceId?: string | undefined;
  /** The parent span inside that trace; requires `traceId`, and an empty string drops the parent. */
  readonly parentSpanId?: string | undefined;
}

/**
 * The walk's mutable state, threaded through the helpers below: the definition and run identity the
 * helpers need, the write policy, and the record table the walk carries (seeded from a resumed
 * snapshot when there is one).
 */
interface WalkState {
  readonly workflow: WorkflowDefinition;
  /** Identity of the run being walked — snapshots and errors carry it. */
  readonly runId: string;
  /** The run's request context — the same object every step receives. */
  readonly requestContext: RequestContext;
  /** Cancellation, checked before every entry and propagated into every step. */
  readonly signal: AbortSignal;
  /** The snapshot store the walk writes to: the attached one, or the run's in-memory default. */
  readonly storage: WorkflowSnapshotStore;
  /** Whether a `running` snapshot follows every completed entry (only worth it with a real store). */
  readonly persistStepBoundaries: boolean;
  /** Per-step records, keyed by step id — the run's stepResults, and the snapshot's body. */
  readonly stepResults: Record<string, WorkflowStepResultSnapshot>;
  /** The run input as it entered the walk: the validated value (defaults / transforms applied). */
  input: unknown;
  /** The step that receives `resumeData` on this walk; cleared once its entry has run. */
  resumingStepId: string | undefined;
  /** The validated resume data for `resumingStepId`. */
  resumeData: unknown;
  /** The resumed block's iteration site, when the walk re-enters a block; cleared with the entry. */
  resumeSite: WorkflowIterationSite | undefined;
  /** Where the walk's lifecycle events go — the caller's sink, or the walk's own drop. */
  readonly emit: (event: WorkflowEvent) => void;
  /** The run's spans (`undefined` without a tracer — the walk's only zero-overhead branch). */
  readonly tracing: WorkflowTracing | undefined;
}

/** The run's observability wiring: the tracer and the root span its step spans hang under. */
interface WorkflowTracing {
  /** The tracer the run's spans are started through — the definition's `tracer` slot. */
  readonly tracer: Tracer;
  /** The run's root span; `workflow-step` spans pass it as their explicit parent. */
  readonly runSpan: Span;
}

/**
 * Walks a committed workflow: validates the walk's entry boundary (the run's start input on a first
 * pass; the snapshot's resume point and `resumeData` on a resume), then interprets every entry in
 * order. Completes with the run's outcome — `success`, or `suspended` when a step raised the suspend
 * signal; throws when the run fails at any boundary.
 */
export async function walk(
  workflow: WorkflowDefinition,
  options: WalkOptions,
): Promise<WorkflowRunOutcome> {
  // Cancellation comes first at the start boundary: a run whose signal is already aborted does
  // nothing at all — not even a span, not even validation, and not even a snapshot write.
  throwIfAborted(options.signal);

  const state: WalkState = {
    workflow,
    runId: options.runId,
    requestContext: options.requestContext,
    signal: options.signal,
    storage: options.storage,
    persistStepBoundaries: options.persistStepBoundaries,
    // A resumed walk continues the suspended run's records: prior steps stay visible to
    // `getStepResult`, and the resumed step replaces its own `suspended` record when it completes.
    stepResults: options.resume === undefined ? {} : { ...options.resume.stepResults },
    input: options.inputData,
    resumingStepId: undefined,
    resumeData: undefined,
    resumeSite: undefined,
    emit: options.emit ?? dropEvent,
    // The run's root span is opened before the entry boundary so a rejected start is recorded too;
    // it ends on every exit path below (automatic instrumentation).
    tracing: toWorkflowTracing(workflow, options),
  };

  try {
    const outcome = await runWalk(state, options);
    // The run span's output is the terminal outcome envelope — a suspension reads as one, and a
    // successful run carries the workflow's terminal value with its per-step records.
    state.tracing?.runSpan.update({ output: outcome });
    state.emit(toRunEndEvent(outcome));
    return outcome;
  } catch (error) {
    // The run failed: the root span carries the error; step spans carry it on their own boundary.
    state.tracing?.runSpan.error(error);
    throw error;
  } finally {
    state.tracing?.runSpan.end();
  }
}

/**
 * The run's observability wiring: `undefined` without a tracer, so the walk's only zero-overhead
 * branch is one presence check. Name = the workflow id; the attributes carry workflowId and runId,
 * the execution identity that looks the trace up from its root span.
 */
function toWorkflowTracing(
  workflow: WorkflowDefinition,
  options: WalkOptions,
): WorkflowTracing | undefined {
  const tracer = workflow.tracer;
  if (tracer === undefined) return undefined;
  const continuation = toTraceContinuation(options);
  return {
    tracer,
    runSpan: tracer.startSpan({
      name: workflow.id,
      type: WORKFLOW_RUN_SPAN,
      attributes: { workflowId: workflow.id, runId: options.runId },
      ...(continuation.traceId === undefined ? {} : { traceId: continuation.traceId }),
      ...(continuation.parentSpanId === undefined
        ? {}
        : { parentSpanId: continuation.parentSpanId }),
    }),
  };
}

/**
 * Resolves the run span's trace continuation: a resume continues the trace its snapshot pinned (the
 * run's own trace, started before the suspension — the snapshot's write side already dropped the
 * empty-string "no trace" encoding, so a resumed id never needs normalizing); a start continues
 * what the caller passed to `createRun`, normalized by the convention's one home
 * (`normalizeTraceContinuation` in observability, next to the `NoOpSpan` encoding).
 */
function toTraceContinuation(options: WalkOptions): WalkTraceContinuation {
  const resuming = options.resume?.traceId;
  if (resuming !== undefined) return { traceId: resuming };
  const trace = options.trace;
  if (trace === undefined) return {};
  return normalizeTraceContinuation(trace.traceId, trace.parentSpanId);
}

/** The run-end event of a terminal outcome — the stream's last event. */
function toRunEndEvent(outcome: WorkflowRunOutcome): WorkflowEvent {
  return outcome.status === 'success'
    ? { type: 'run-end', status: 'success', output: outcome.output }
    : { type: 'run-end', status: 'suspended' };
}

/** The event sink of a walk nobody streams (`resume`): the events are built and dropped. */
function dropEvent(_event: WorkflowEvent): void {}

/** The walk's body: the entry boundary (a start input, or a resume point) and then every entry. */
async function runWalk(state: WalkState, options: WalkOptions): Promise<WorkflowRunOutcome> {
  const { workflow } = state;

  // These two boundaries — the start input, and a resume's position / target / resumeData — sit
  // outside the failure path below: a rejected start means the run never began, and a rejected
  // resume must leave the suspended snapshot untouched so a corrected resume can still find it.
  let value: unknown;
  let position: number;
  if (options.resume === undefined) {
    // The run's start input is the first boundary: its validated value replaces the raw input
    // (defaults / transforms apply), and a rejection here means the run never starts.
    value = await validateRunInput(workflow.id, workflow.inputSchema, options.inputData);
    state.input = value;
    position = 0;
    // The run has begun: the start boundary accepted the input, so the run-start event carries the
    // validated value the run consumes (a rejected start emits nothing — it never began), and the
    // run span records the same value as its input.
    state.emit({ type: 'run-start', runId: state.runId, workflowId: workflow.id, input: value });
    state.tracing?.runSpan.update({ input: value });
  } else {
    ({ value, position } = await enterResume(state, options.resume));
    // A resumed segment is triggered by the validated resumeData, not by the run's start input;
    // `undefined` (a bare resume of a step without `resumeSchema`) leaves the span's input unset.
    state.tracing?.runSpan.update({ input: state.resumeData });
  }

  try {
    for (; position < workflow.entries.length; position += 1) {
      const entry = workflow.entries[position]!;
      throwIfAborted(options.signal);
      try {
        value = await runEntry(state, entry, value);
      } catch (error) {
        if (!isSuspendSignal(error)) throw error;
        // The signal's record was written where it was raised (`runAndRecordStep` for a then step
        // or a parallel / branch arm, the block's aggregate for foreach / the loops), and a block
        // has attached its iteration site. The snapshot pins the entry to re-enter from — its
        // input is rebuilt from the records around it, never stored.
        await persist(state, 'suspended', position, error.iterationSite);
        return { status: 'suspended', stepId: error.stepId, stepResults: state.stepResults };
      }
      // The resumed step has run: resumeData belongs to that one execution alone, later entries
      // and later iterations see a normal pass (`undefined`).
      state.resumingStepId = undefined;
      state.resumeData = undefined;
      state.resumeSite = undefined;
      // A step that ignored the abort at least cannot let the run succeed: the boundary after it
      // re-checks, so cancellation always lands the run in `failed` (AbortError).
      throwIfAborted(options.signal);
      if (state.persistStepBoundaries) await persist(state, 'running', position + 1);
    }
  } catch (error) {
    // The run failed: fix the terminal state for the store, but never let a store failure replace
    // the run's own error — that error is the truth the caller was promised.
    try {
      await persist(state, 'failed', position);
    } catch {
      // Best effort only: the store is failing too, and the run's error still surfaces below.
    }
    throw error;
  }

  await persist(state, 'success', workflow.entries.length);
  return { status: 'success', output: value, stepResults: state.stepResults };
}

/**
 * Interprets one entry: the dispatch the walk's `for` loop runs (control-flow operators). `sleep`
 * consumes and produces nothing, so it hands the tip straight back.
 */
async function runEntry(state: WalkState, entry: WorkflowEntry, value: unknown): Promise<unknown> {
  switch (entry.type) {
    case 'then':
      // The resumed step, when the walk re-entered at this entry, is the one holding resumeData.
      return runAndRecordStep(state, entry.step, value, state.resumingStepId === entry.step.id);
    case 'parallel':
      return runParallel(state, entry, value);
    case 'branch':
      return runBranch(state, entry, value);
    case 'foreach':
      return runForeach(state, entry, value);
    case 'dowhile':
    case 'dountil':
      return runLoop(state, entry, value);
    case 'sleep':
      await runSleep(state, entry);
      return value;
    default: {
      // Every entry type of the spec is handled above; this guards a hand-built definition whose
      // entries were cast past the types (`createWorkflowRun` takes a definition directly).
      const { type } = entry as { readonly type: string };
      throw new Error(`workflow "${state.workflow.id}": unknown workflow entry type "${type}"`);
    }
  }
}

/**
 * Written at every fixed persistence point (suspend/resume and snapshots): a fresh table each time
 * — records are replaced, never mutated, so a shallow copy is
 * enough — with the run's validated input and the entry position to re-enter from.
 */
async function persist(
  state: WalkState,
  status: WorkflowRunStatus,
  position: number,
  iterationSite?: WorkflowIterationSite | undefined,
): Promise<void> {
  const traceId = state.tracing?.runSpan.traceId;
  const snapshot: WorkflowRunSnapshot = {
    runId: state.runId,
    status,
    input: state.input,
    stepResults: { ...state.stepResults },
    position,
    // The iteration site rides only a suspension-inside-a-block snapshot (#54): running and
    // terminal snapshots have none — the walk has left the block, or never had one.
    ...(iterationSite === undefined ? {} : { iterationSite }),
    // The trace rides the snapshot so a resumed segment continues it. An untraced run — or a trace
    // the sampler rejected,
    // whose NoOpSpan carries no id — writes none.
    ...(traceId === undefined || traceId === '' ? {} : { traceId }),
  };
  await state.storage.save(state.runId, snapshot);
}

/**
 * Prepares a resumed walk: checks the snapshot's resume point against the definition, validates the
 * `resumeData` (the third fixed IO boundary) and rebuilds the tip value by replaying the completed
 * entries from the snapshot's records — nothing re-executes, and the conditions of the entries the
 * run already passed are not evaluated again.
 */
async function enterResume(
  state: WalkState,
  resume: WalkResumePoint,
): Promise<{ readonly value: unknown; readonly position: number }> {
  const { workflow } = state;
  // The target first: the snapshot must be suspended at the step `resume` names. Naming a step
  // that is not suspended is a caller bug, and the snapshot knows which steps are waiting — say
  // so. Other suspended records (a second parallel arm that also suspended, #54) are no obstacle:
  // each is resumable in its own right, the un-named ones re-run without resumeData.
  if (state.stepResults[resume.stepId]?.status !== 'suspended') {
    const suspended = Object.entries(state.stepResults).find(
      ([, record]) => record.status === 'suspended',
    );
    if (suspended !== undefined) {
      throw new Error(
        `run "${state.runId}" suspended at step "${suspended[0]}" — resume() was asked for step "${resume.stepId}".`,
      );
    }
    throw new Error(
      `workflow "${workflow.id}": the snapshot has no suspended record for step "${resume.stepId}" — it cannot be resumed`,
    );
  }
  const entry = workflow.entries[resume.position];
  if (entry === undefined) {
    throw new Error(
      `workflow "${workflow.id}": the snapshot's position ${resume.position} is outside the entry list — the definition and the snapshot do not match`,
    );
  }
  const step = resumeTargetStep(entry, resume.stepId);
  if (resume.iterationSite === undefined) {
    // The earlier shape: no site means the top-level `then` suspension, and the entry must hold it.
    if (entry.type !== 'then' || entry.step.id !== resume.stepId) {
      throw new Error(
        `workflow "${workflow.id}": step "${resume.stepId}" cannot be resumed from position ${resume.position} — the snapshot has no iteration site, and the entry is not that step's top-level then entry`,
      );
    }
  } else {
    // The site must agree with the entry — its kind and the named step's membership in that block.
    checkIterationSite(workflow.id, entry, resume.iterationSite, resume.stepId, resume.position);
    state.resumeSite = resume.iterationSite;
  }
  if (step === undefined) {
    throw new Error(
      `workflow "${workflow.id}": step "${resume.stepId}" is not a step of the entry at position ${resume.position} — the definition and the snapshot do not match`,
    );
  }
  state.resumeData = await validateResumeData(workflow.id, step, resume.resumeData);
  state.resumingStepId = resume.stepId;
  return { value: replayEntries(state, resume.position), position: resume.position };
}

/**
 * The step a resume names inside the entry its snapshot points at: a then step, a block arm, or
 * the block's own step. `undefined` when the entry holds no such step (a mismatch the callers
 * report with their own words).
 */
function resumeTargetStep(entry: WorkflowEntry, stepId: string): Step | undefined {
  switch (entry.type) {
    case 'then':
      return entry.step.id === stepId ? entry.step : undefined;
    case 'parallel':
      return entry.steps.find((step) => step.id === stepId);
    case 'branch': {
      const arm = entry.branches.find(([, step]) => step.id === stepId);
      return arm === undefined ? undefined : arm[1];
    }
    case 'foreach':
    case 'dowhile':
    case 'dountil':
      return entry.step.id === stepId ? entry.step : undefined;
    case 'sleep':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * A site and its entry must agree (#54): the site's kind is the entry's block type (the two loop
 * entries share the `loop` kind), and the resumed step must be a step of that block. A snapshot
 * that disagrees with the definition is explicit about it — it cannot be resumed silently wrong.
 */
function checkIterationSite(
  workflowId: string,
  entry: WorkflowEntry,
  site: WorkflowIterationSite,
  stepId: string,
  position: number,
): void {
  const expected = entry.type === 'dowhile' || entry.type === 'dountil' ? 'loop' : entry.type;
  if (site.kind !== expected) {
    throw new Error(
      `workflow "${workflowId}": the snapshot's iteration site (kind "${site.kind}") does not match the ${entry.type} block at position ${position} — the definition and the snapshot do not match`,
    );
  }
  if (resumeTargetStep(entry, stepId) === undefined) {
    throw new Error(
      `workflow "${workflowId}": step "${stepId}" is not a step of the ${entry.type} block at position ${position} — the definition and the snapshot do not match`,
    );
  }
}

/**
 * Rebuilds the tip value entering entry `until` from the snapshot's records — the completed entries
 * of a suspended run, interpreted without executing anything. Sleeps pass the value through, so they
 * replay to their predecessor's value.
 */
function replayEntries(state: WalkState, until: number): unknown {
  let value = state.input;
  for (let index = 0; index < until; index += 1) {
    value = replayEntry(state, state.workflow.entries[index]!, value);
  }
  return value;
}

/** One completed entry's output, reconstructed from its step records — pure bookkeeping, no execution. */
function replayEntry(state: WalkState, entry: WorkflowEntry, value: unknown): unknown {
  switch (entry.type) {
    case 'then':
      return recordedOutput(state, entry.step.id);
    case 'parallel':
      return Object.fromEntries(
        entry.steps.map((step) => [step.id, recordedOutput(state, step.id)] as const),
      );
    case 'branch': {
      // The executed arm is the first one with a record, in definition order; no record at all
      // means no condition was truthy and the block produced `{}`. Records are keyed by step id, so
      // an id reused across entries is inherently ambiguous — the same reading as `getStepResult`.
      const executed = entry.branches.find(([, step]) => state.stepResults[step.id] !== undefined);
      return executed === undefined ? {} : { [executed[1].id]: recordedOutput(state, executed[1].id) };
    }
    case 'foreach':
    case 'dowhile':
    case 'dountil':
      return recordedOutput(state, entry.step.id);
    case 'sleep':
      return value;
    default: {
      const { type } = entry as { readonly type: string };
      throw new Error(
        `workflow "${state.workflow.id}": the snapshot cannot be replayed — entry type "${type}" has no recorded output`,
      );
    }
  }
}

/** The recorded output of a completed step; a snapshot that misses it cannot be replayed. */
function recordedOutput(state: WalkState, stepId: string): unknown {
  const record = state.stepResults[stepId];
  if (record?.status !== 'success') {
    throw new Error(
      `workflow "${state.workflow.id}": the snapshot has no completed record for step "${stepId}" — it cannot be replayed from its position`,
    );
  }
  return record.output;
}

/** The recorded output of an already-run step; `undefined` when it has no recorded result. */
function getStepResult(state: WalkState, stepId: string): unknown {
  return state.stepResults[stepId]?.output;
}

/**
 * Runs one step and records it: status, output and boundary timestamps, keyed by step id. A
 * suspend raised here is recorded `suspended` with its payload — never `failed` — wherever the
 * step runs: a top-level `then` step, a `parallel` arm or a `branch` arm all record their own
 * suspension (#54; `foreach` and the loops record the block's aggregate where they run it).
 * `resumeFor` says whether this execution is the one the walk's resumeData belongs to.
 */
async function runAndRecordStep(
  state: WalkState,
  step: Step,
  inputData: unknown,
  resumeFor: boolean,
): Promise<unknown> {
  const startedAt = Date.now();
  let output: unknown;
  try {
    output = await executeStep(state, step, inputData, resumeFor);
  } catch (error) {
    // A suspend is not a failure: the step is recorded `suspended` with its payload, and the
    // signal keeps travelling to the entry loop.
    if (isSuspendSignal(error)) {
      recordStep(state, step.id, startedAt, {
        status: 'suspended',
        suspendPayload: error.payload,
      });
    } else {
      recordStep(state, step.id, startedAt, { status: 'failed' });
    }
    throw error;
  }
  recordStep(state, step.id, startedAt, { status: 'success', output });
  return output;
}

/** Records one step result under its id: the status, the output when there is one, the timestamps. */
function recordStep(
  state: WalkState,
  stepId: string,
  startedAt: number,
  result:
    | { readonly status: 'success'; readonly output: unknown }
    | { readonly status: 'failed' }
    | { readonly status: 'suspended'; readonly suspendPayload: unknown },
): void {
  state.stepResults[stepId] = { ...result, startedAt, endedAt: Date.now() };
}

/**
 * Executes one step without recording it: the step boundary validation happens here (the upstream
 * value through this step's input schema), and the validated value is what `execute` receives —
 * validated once, then retried as a whole on failure (`step.retries`, the fixed-interval policy of
 * `retry.ts`). `foreach` and the loops call this per iteration, so N runs of one step id become one
 * aggregate record instead of N overwrites. `resumeFor` routes the walk's resumeData to this one
 * execution — the resumed arm, the suspended iteration — never to the step id at large.
 */
async function executeStep(
  state: WalkState,
  step: Step,
  inputData: unknown,
  resumeFor: boolean,
): Promise<unknown> {
  // The step boundary's events frame the whole crossing — the arriving value, the validation, the
  // attempts — and one pair is emitted per execution: a `foreach` iteration is its own crossing,
  // even though the run's records aggregate the block under one step id. The step's span opens at
  // the same boundary, so its input is the validated value `execute` actually receives (set as an
  // update once validation has passed) and a rejected boundary carries no input, only the error.
  state.emit({ type: 'step-start', stepId: step.id, input: inputData });
  const span = startStepSpan(state, step);
  try {
    const validated = await validateStepInput(state.workflow.id, step, inputData);
    span?.update({ input: validated });
    const output = await executeWithRetries(
      async () => step.execute(stepContext(state, step, validated, resumeFor)),
      step.retries ?? 0,
      state.signal,
    );
    state.emit({ type: 'step-end', stepId: step.id, status: 'success', output });
    span?.update({ output });
    return output;
  } catch (error) {
    // A suspend is not a step failure, wherever it was raised (#54): the boundary closes
    // `suspended` and the signal keeps travelling — events, records and snapshot all read the
    // same suspension.
    const suspend = isSuspendSignal(error);
    const status: StepStatus = suspend ? 'suspended' : 'failed';
    state.emit({ type: 'step-end', stepId: step.id, status });
    if (!suspend) span?.error(error);
    throw error;
  } finally {
    span?.end();
  }
}

/**
 * Starts one step's span (automatic instrumentation): hanging under the run's
 * root span (explicit propagation, no AsyncLocalStorage). The name is the step id; the table's
 * `workflow-step` attributes are empty. A run without a tracer creates no span object at all.
 */
function startStepSpan(state: WalkState, step: Step): Span | undefined {
  const tracing = state.tracing;
  if (tracing === undefined) return undefined;
  return tracing.tracer.startSpan({
    name: step.id,
    type: WORKFLOW_STEP_SPAN,
    parent: tracing.runSpan,
  });
}

/**
 * The context bag every step `execute` receives — and every condition, which gets the same bag minus
 * the step's own powers: no step means no `suspend` (a condition cannot suspend a run) and no
 * `resumeData` (resuming is the step's business). `resumeFor` routes the walk's resumeData into
 * this one execution — the resumed step — so the same step id running as a later iteration or a
 * sibling arm never sees it (#54).
 */
function stepContext(
  state: WalkState,
  step: Step | undefined,
  inputData: unknown,
  resumeFor = false,
): StepContext {
  // The erased `StepContext` types `resumeData` as `undefined` (the real type lives on the step's
  // own `createStep` call site); the walker hands the validated value to the resumed execution.
  const resumeData = (resumeFor ? state.resumeData : undefined) as undefined;
  return {
    inputData,
    runId: state.runId,
    signal: state.signal,
    requestContext: state.requestContext,
    getStepResult: (stepId) => getStepResult(state, stepId),
    resumeData,
    suspend:
      step === undefined
        ? suspendOutsideStep
        : (payload: unknown): never => {
            throw new SuspendSignal(step.id, payload);
          },
  };
}

/** Conditions are read-only in spirit: they receive the bag, but they cannot suspend the walk. */
function suspendOutsideStep(): never {
  throw new Error(
    'suspend() is not available in a branch or loop condition — only a step can suspend a run',
  );
}

/**
 * `.parallel([a, b])` (control-flow operators): every step receives the same
 * value (the previous entry's output) and runs concurrently — no concurrency cap. The block is a
 * synchronization point in full (#54): it waits for every arm to settle before leaving — a
 * suspend snapshot must say which arms completed, so a still-running arm's output is not lost to a
 * snapshot written without it — and a suspend outranks a sibling failure settled in the same
 * window (the failed arm keeps its `failed` record and re-runs when the block is re-entered).
 * Output = `{ [step.id]: output }`, keyed in definition order.
 *
 * A resumed walk re-enters the block records-first: an arm with a `success` record replays it and
 * never re-executes; the arms without one — failed, never-run, or a suspending arm the resume did
 * not name — run afresh, and the named arm's execution carries the resumeData. A suspend attaches
 * the site `{ kind: 'parallel' }` to its signal: the records are the site. Each suspending arm kept
 * its own `suspended` record, so any of them can be the next resume target.
 */
async function runParallel(
  state: WalkState,
  entry: ParallelEntry,
  inputData: unknown,
): Promise<Record<string, unknown>> {
  const outputs = new Array<unknown>(entry.steps.length);
  /** Suspends and failures in settle order — the order the block would have rejected in. */
  const suspends: SuspendSignal[] = [];
  const failures: unknown[] = [];
  await Promise.all(
    entry.steps.map(async (step, index) => {
      const record = state.stepResults[step.id];
      if (record?.status === 'success') {
        outputs[index] = record.output;
        return;
      }
      try {
        outputs[index] = await runAndRecordStep(
          state,
          step,
          inputData,
          state.resumingStepId === step.id,
        );
      } catch (error) {
        if (isSuspendSignal(error)) suspends.push(error);
        else failures.push(error);
      }
    }),
  );
  if (suspends.length > 0) {
    const winner = suspends[0]!;
    winner.iterationSite = { kind: 'parallel' };
    throw winner;
  }
  if (failures.length > 0) throw failures[0]!;
  return Object.fromEntries(entry.steps.map((step, index) => [step.id, outputs[index]] as const));
}

/**
 * `.branch([[cond, step], …])` (control-flow operators): conditions are
 * evaluated in definition order with the same context bag a step receives (`inputData` = the
 * previous entry's output), and the first truthy one runs its step — later conditions are not
 * evaluated at all. Output = a keyed object whose only key is the executed step's id; when no
 * condition is truthy the output is `{}` (the tip value is consumed by the block, never passed
 * through). Branch arms are expected to share their IO schemas; each arm still validates the tip
 * value at its own step boundary.
 */
async function runBranch(
  state: WalkState,
  entry: BranchEntry,
  inputData: unknown,
): Promise<Record<string, unknown>> {
  // A resumed walk re-enters the branch records-first: the arm with a record is the one the run
  // chose — conditions are not re-evaluated (the replay philosophy; a condition's answer belongs
  // to the pass that asked it). The recorded arm re-runs holding the resumeData.
  if (state.resumeSite?.kind === 'branch') {
    const chosen = entry.branches.find(([, step]) => state.stepResults[step.id] !== undefined);
    if (chosen === undefined) {
      throw new Error(
        `workflow "${state.workflow.id}": the snapshot's iteration site names a branch block, but no arm of the block at this position has a record — the definition and the snapshot do not match`,
      );
    }
    return { [chosen[1].id]: await reenterRecordedArm(state, chosen[1], inputData) };
  }
  for (const [condition, step] of entry.branches) {
    if (await condition(stepContext(state, undefined, inputData))) {
      try {
        return {
          [step.id]: await runAndRecordStep(state, step, inputData, state.resumingStepId === step.id),
        };
      } catch (error) {
        // The suspending arm's record is already written; the site says the branch's chosen arm —
        // the record names which one (conditions are not re-evaluated on re-entry).
        if (isSuspendSignal(error)) error.iterationSite = { kind: 'branch' };
        throw error;
      }
    }
  }
  return {};
}

/**
 * Re-runs the arm a resumed branch comes back to: the arm whose record the snapshot carries. A
 * suspend here attaches the same site again — the arm may want a second answer before it lets go.
 */
async function reenterRecordedArm(
  state: WalkState,
  step: Step,
  inputData: unknown,
): Promise<unknown> {
  try {
    return await runAndRecordStep(state, step, inputData, state.resumingStepId === step.id);
  } catch (error) {
    if (isSuspendSignal(error)) error.iterationSite = { kind: 'branch' };
    throw error;
  }
}

/**
 * `.foreach(step, { concurrency })` (control-flow operators): the previous
 * entry's output must be an array; every element is one iteration of the same step (validated at
 * the step boundary like any other input) and the outputs are collected in index order.
 * `concurrency` (resolved at definition time, an integer ≥ 1) is the gate width: `1` runs the
 * iterations one after another, `>1` keeps exactly that many in flight and starts the next element
 * as soon as a slot frees — a self-written streaming gate, never a batch of `Promise.all`s. The
 * block is a synchronization point; a failing or suspending iteration stops the gate from pulling
 * new indices, and the block waits for the in-flight ones to settle before it leaves (#54 — a
 * suspend snapshot must be able to say what was collected).
 *
 * A suspend (#54): the first signal to settle is the run's suspension; the block records it under
 * the step id (the aggregate record the block owns, holding the winning iteration's payload) and
 * carries the iteration site — the collected outputs so far (keyed by index) and the suspended
 * index. Iterations that also suspended are holes: unrecorded, re-run without resumeData when the
 * block re-enters (they suspend again if they still want an answer). On a resumed walk the site's
 * collected outputs seed the array — done iterations never re-execute — and `resumeData` goes to
 * the suspended index alone. The step's success record is the collected array, written when the
 * block completes; `getStepResult(step.id)` returns the block's output, and inside its own
 * iterations the id stays unrecorded — like any step reading itself.
 */
async function runForeach(state: WalkState, entry: ForeachEntry, inputData: unknown): Promise<unknown[]> {
  if (!Array.isArray(inputData)) {
    throw new Error(
      `workflow "${state.workflow.id}": the input of the foreach step "${entry.step.id}" must be an array (the previous entry's output), got ${inputData === null ? 'null' : typeof inputData}`,
    );
  }

  const site = state.resumeSite?.kind === 'foreach' ? state.resumeSite : undefined;
  const startedAt = Date.now();
  const outputs = new Array<unknown>(inputData.length);
  /** Which indices already hold an output — seeded from the site, filled as iterations settle. */
  const done = new Array<boolean>(inputData.length).fill(false);
  if (site !== undefined) {
    for (const key of Object.keys(site.collected)) {
      const index = Number(key);
      if (Number.isInteger(index) && index >= 0 && index < inputData.length) {
        outputs[index] = site.collected[key];
        done[index] = true;
      }
    }
  }
  /** Suspends (with their index) and failures in settle order — the order the block would have rejected in. */
  const suspends: { readonly signal: SuspendSignal; readonly index: number }[] = [];
  const failures: unknown[] = [];
  let stopped = false;
  let nextIndex = 0;
  /** One gate slot: pulls the next unconsumed index whenever it frees up, until the block stops. */
  const worker = async (): Promise<void> => {
    while (!stopped && nextIndex < inputData.length) {
      const index = nextIndex++;
      if (done[index]) continue;
      const resumeFor =
        site !== undefined && index === site.suspendedIndex && state.resumingStepId === entry.step.id;
      try {
        outputs[index] = await executeStep(state, entry.step, inputData[index], resumeFor);
        done[index] = true;
      } catch (error) {
        // Stop the gate here, before the error travels: sibling slots see it and stop pulling new
        // indices right away (in-flight iterations keep running; the block waits for them below).
        stopped = true;
        if (isSuspendSignal(error)) suspends.push({ signal: error, index });
        else failures.push(error);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(entry.concurrency, inputData.length) }, worker),
  );
  if (suspends.length > 0) {
    const winner = suspends[0]!;
    recordStep(state, entry.step.id, startedAt, {
      status: 'suspended',
      suspendPayload: winner.signal.payload,
    });
    winner.signal.iterationSite = {
      kind: 'foreach',
      suspendedIndex: winner.index,
      collected: Object.fromEntries(
        done.flatMap((settled, index) => (settled ? [[String(index), outputs[index]] as const] : [])),
      ),
    };
    throw winner.signal;
  }
  if (failures.length > 0) {
    recordStep(state, entry.step.id, startedAt, { status: 'failed' });
    throw failures[0]!;
  }
  recordStep(state, entry.step.id, startedAt, { status: 'success', output: outputs });
  return outputs;
}

/**
 * `.dowhile(step, cond)` / `.dountil(step, cond)` (control-flow operators):
 * the same loop with two condition checkpoints — `dowhile` checks **before** every iteration
 * (a condition false at `iterationCount: 0` runs the step zero times, the tip passing through
 * untouched), `dountil` checks **after** every iteration (the step always runs at least once).
 * Either way the condition sees the value that iteration consumed / produced — the previous entry's
 * output first, the previous iteration's output afterwards — together with `iterationCount`, the
 * number of iterations already completed.
 *
 * The step's output feeds its own input on the next iteration (validated at the boundary like any
 * other input), so the loop is a fold until the condition stops holding. Output = the last
 * iteration's output; the block records one result under the step id, written when the loop
 * completes (like `foreach`: the block has no id of its own, and reading the step id from inside is
 * unrecorded).
 *
 * A suspend inside an iteration (#54): the block records `suspended` under the step id (the
 * aggregate record, holding the winning payload) and carries the site — the completed iteration
 * count and the value the suspended iteration consumed, a mid-block tip no record holds. A
 * resumed walk re-enters at that value and runs the suspended iteration holding the resumeData;
 * a `dowhile` skips its pre-check for that one iteration (it was admitted before the suspension,
 * and conditions are never re-evaluated for a pass that already asked them). Later iterations
 * check as normal, on the same `iterationCount` basis.
 *
 * Throwing from the condition is the maximum-iteration gate: the error fails the run verbatim.
 * `iterationCount` counts completed iterations, so `if (iterationCount >= n) throw` caps the loop
 * at `n` iterations.
 */
async function runLoop(
  state: WalkState,
  entry: DowhileEntry | DountilEntry,
  inputData: unknown,
): Promise<unknown> {
  const site = state.resumeSite?.kind === 'loop' ? state.resumeSite : undefined;
  const startedAt = Date.now();
  let value = site !== undefined ? site.value : inputData;
  let iterationCount = site !== undefined ? site.iterationCount : 0;
  // The re-entered iteration was admitted before the suspension: one pre-check to skip, and one
  // execution holding the resumeData — both spent on the first pass through the body.
  let resuming = site !== undefined && state.resumingStepId === entry.step.id;
  try {
    for (;;) {
      if (
        !resuming &&
        entry.type === 'dowhile' &&
        !(await loopConditionHolds(state, entry, value, iterationCount))
      ) {
        break;
      }
      value = await executeStep(state, entry.step, value, resuming);
      resuming = false;
      iterationCount += 1;
      if (
        entry.type === 'dountil' &&
        (await loopConditionHolds(state, entry, value, iterationCount))
      ) {
        break;
      }
    }
  } catch (error) {
    if (isSuspendSignal(error)) {
      // `value` still holds the suspended iteration's input (the assignment never happened); the
      // site pins it with the completed count — exactly what re-entry needs.
      recordStep(state, entry.step.id, startedAt, {
        status: 'suspended',
        suspendPayload: error.payload,
      });
      error.iterationSite = { kind: 'loop', iterationCount, value };
    } else {
      recordStep(state, entry.step.id, startedAt, { status: 'failed' });
    }
    throw error;
  }
  recordStep(state, entry.step.id, startedAt, { status: 'success', output: value });
  return value;
}

/**
 * Evaluates a loop condition: cancellation first (never hand an aborted run's loop another
 * evaluation), then the condition with the step context bag plus `iterationCount`.
 */
async function loopConditionHolds(
  state: WalkState,
  entry: DowhileEntry | DountilEntry,
  inputData: unknown,
  iterationCount: number,
): Promise<boolean> {
  throwIfAborted(state.signal);
  return entry.cond({ ...stepContext(state, undefined, inputData), iterationCount });
}

/**
 * `.sleep(ms | fn)` (control-flow operators; errors, retries and the state machine): an
 * in-process wait, cut short by the run's signal. The run keeps its `running` reading while it
 * waits — the framework has no `waiting` state — and the wait is not durable: a dying process drops
 * it. The tip passes through untouched and nothing is recorded: a sleep is a delay, not a step.
 *
 * The duration is a `DynamicArgument`: milliseconds, or a resolver the
 * run calls with its `RequestContext` (`signal` / `runId` reachable, the agent config fields'
 * convention) — not a step context, since a delay consumes and produces no value. It must be a
 * finite number of milliseconds; anything else is a broken computation and fails the run loudly. A
 * negative one — a deadline already in the past — means "no wait".
 */
async function runSleep(state: WalkState, entry: SleepEntry): Promise<void> {
  const duration = await resolveDynamicArgument(entry.duration, state.requestContext);
  if (!Number.isFinite(duration)) {
    throw new Error(
      `workflow "${state.workflow.id}": the sleep duration must be a finite number of milliseconds, got ${String(duration)}`,
    );
  }
  await abortableSleep(Math.max(0, duration), state.signal);
}
