/**
 * `@oribos/core/workflows` — workflow engine.
 *
 * The definition surface: `createStep` (id + IO schemas + optional resume/suspend schemas +
 * retries + execute), the `StepContext` bag every step executes with, and the mutable
 * `createWorkflow` builder whose seven operators (then / parallel / branch / foreach / dowhile /
 * dountil / sleep) each push one flat `{ type, … }` entry until `.commit()` freezes the
 * definition. Type safety rides a type-state: `then` is strict, parallel/branch infer keyed
 * objects.
 *
 * The run surface: a committed workflow's `createRun` gives a run identity, `start` returns the
 * output object whose `result` resolves the run's outcome envelope (or rejects when the run fails)
 * and whose `for await` walks the lifecycle events (run-start / step-start / step-end / run-end,
 * carrying the values that cross each boundary), `resume({ step, resumeData? })` continues a run
 * that suspended, and `restart({ step? })` re-enters a snapshotted run from a chosen step with the
 * later records truncated (time-travel). Start is lazy — the walker executes on the first read;
 * resume and restart are eager and resolve
 * with the same outcome envelope. The walker interprets the flat entry list in order: `then` pipes the previous output on, `parallel`
 * runs the steps concurrently and keys the outputs by step id, `branch` runs the first step whose
 * condition is truthy and keys the output the same way, `foreach` maps an array through one step
 * through a concurrency gate and collects an array, `dowhile` / `dountil` fold a step until their
 * condition stops holding, and `sleep` waits in process for a resolved duration. Step-level
 * `retries` retry a failing `execute` at a fixed interval. IO validation (start input + every
 * step's input + a resume's resumeData) is always on, with the schema's value replacing the raw
 * data.
 *
 * Suspend/resume: a step's `suspend(payload)` unwinds the run and suspends it — at a top-level
 * `then` entry or inside a block (a `parallel` arm, a `branch` arm, a `foreach` iteration, a loop
 * body, #54). The step is recorded `suspended`, the run's JSON snapshot goes to the
 * `WorkflowSnapshotStore` (2 methods, JSON-only; the in-memory default ships with the core) —
 * carrying the block's iteration site when the suspension happened inside one — and the outcome
 * envelope reads `suspended`. `resume` loads the snapshot, validates `resumeData` against the
 * step's `resumeSchema` and re-enters the walk from the snapshot's position (inside its block,
 * from the site), replaying the completed executions from the records instead of re-running
 * them; concurrent resumes of one snapshot — the same store and run id — are deduplicated in
 * process. `restart({ step? })` is the same load → re-enter primitive's thin variant
 * (time-travel): it truncates the records at and after the chosen step's entry and re-enters from
 * there — the target re-executes fresh (no `resumeData`, no iteration site, a block re-runs
 * whole), and omitting the step restarts the run from the beginning. An external durable runner
 * resolves a snapshot's `position` to its restart target with `restartTargetAt` — the one public
 * entry-topology answer; the per-kind table that backs it stays internal. Snapshots are written at
 * fixed points — every completed entry with attached storage, plus suspend and the terminal state —
 * never through hooks; a run with a tracer writes the trace it was exported under into the
 * snapshot, so a resumed segment continues the same trace. A tracer attached to the definition
 * opens `workflow-run` / `workflow-step` spans at the same
 * boundaries (run span: input = the validated trigger input, output = the outcome envelope; step
 * span: name = step id, one per execution), and an absent tracer means no span object is ever
 * created.
 */
export { createStep } from './step.js';
export type { ResumeDataOf, Step, StepConfig, StepContext, SuspendPayloadOf } from './step.js';
export { createWorkflow } from './workflow.js';
export type {
  BranchStepOf,
  DataSchema,
  KeyedOutputsOf,
  ThenInputAccepts,
  Workflow,
  WorkflowBuilder,
  WorkflowConfig,
} from './workflow.js';
export { createWorkflowRun } from './run.js';
export type {
  WorkflowCreateRunOptions,
  WorkflowRestartOptions,
  WorkflowResumeOptions,
  WorkflowRun,
  WorkflowRunOutcome,
  WorkflowRunOutput,
  WorkflowRunSuccessOutcome,
  WorkflowRunSuspendedOutcome,
  WorkflowStartOptions,
} from './run.js';
export type { WorkflowDefinition } from './walker.js';
export { WorkflowValidationError } from './validate.js';
export { createInMemorySnapshotStore } from './in-memory-snapshot-store.js';
export { restartTargetAt } from './entry.js';
export type {
  BranchCondition,
  BranchEntry,
  BranchPair,
  DountilEntry,
  DowhileEntry,
  ForeachEntry,
  LoopCondition,
  ParallelEntry,
  SleepDuration,
  SleepEntry,
  ThenEntry,
  WorkflowEntry,
} from './entry.js';
export type {
  WorkflowEvent,
  WorkflowRunEndEvent,
  WorkflowRunStartEvent,
  WorkflowStepEndEvent,
  WorkflowStepStartEvent,
} from './events.js';
export type {
  StepStatus,
  WorkflowIterationSite,
  WorkflowRunSnapshot,
  WorkflowRunStatus,
  WorkflowSnapshotStore,
  WorkflowStepResultSnapshot,
} from './snapshot.js';
export type {
  StandardJSONSchemaV1,
  StandardSchema,
  StandardSchemaV1,
  StandardTypedV1,
} from '../standard-schema.js';
