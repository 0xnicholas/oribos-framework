import type { Logger, Tracer } from '../observability/index.js';
import type { StandardSchema, StandardSchemaV1 } from '../standard-schema.js';
import type { BranchCondition, LoopCondition, SleepDuration, WorkflowEntry } from './entry.js';
import { createWorkflowRun } from './run.js';
import type { WorkflowCreateRunOptions, WorkflowRun } from './run.js';
import type { WorkflowSnapshotStore } from './snapshot.js';
import type { Step } from './step.js';

/**
 * The workflow definition surface (workflow definitions and the builder):
 * a mutable chainable builder whose seven operators each push one flat `{ type, … }` entry, and
 * `.commit()` freezing the definition. There is no DAG — execution is a `for` loop over the entry
 * list (`walker.ts`).
 *
 * Type safety rides a type-state: `TPrevSchema` is replaced along the chain, strictly on the
 * `then` main axis (the step's input schema must accept the previous output), while `parallel` /
 * `branch` infer keyed-object outputs.
 */

/** The `createWorkflow` config. */
export interface WorkflowConfig<
  TInputSchema extends StandardSchema = StandardSchema,
  TOutputSchema extends StandardSchema = StandardSchema,
> {
  /** Workflow id; also the mental anchor for run ids and spans. */
  readonly id: string;
  /** The run's start input schema — validated at `start` (always on). */
  readonly inputSchema: TInputSchema;
  /** The workflow's declared output schema. */
  readonly outputSchema: TOutputSchema;
  /**
   * Tracer the run and its step spans hang under; absent =
   * no span object is ever created.
   */
  readonly tracer?: Tracer | undefined;
  /**
   * The logger channel this definition carries (the composition root distributes it); absent =
   * no logger is attached. The kernel writes no logs of its own — the channel is the one
   * designated path the observability spec reserves for them.
   */
  readonly logger?: Logger | undefined;
  /**
   * Snapshot store for suspend/resume; absent = the run is purely in memory (the core's in-memory
   * default keeps the snapshots for this process only).
   */
  readonly storage?: WorkflowSnapshotStore | undefined;
}

/**
 * The committed workflow — what `.commit()` returns: the frozen definition the walker reads. A
 * builder is not runnable; `createRun` can only ever exist here (the type-state enforces "no run
 * before commit").
 */
export interface Workflow<
  TInputSchema extends StandardSchema = StandardSchema,
  TOutputSchema extends StandardSchema = StandardSchema,
> {
  /** Workflow id. */
  readonly id: string;
  /** The run's start input schema. */
  readonly inputSchema: TInputSchema;
  /** The workflow's declared output schema. */
  readonly outputSchema: TOutputSchema;
  /** The distributed tracer; `undefined` when none was attached. */
  readonly tracer: Tracer | undefined;
  /** The distributed logger channel; `undefined` when none was attached. */
  readonly logger: Logger | undefined;
  /** The snapshot store; `undefined` when none was attached (the run then defaults to in-memory). */
  readonly storage: WorkflowSnapshotStore | undefined;
  /** The frozen, flat entry list the walker interprets. */
  readonly entries: readonly WorkflowEntry[];
  /**
   * Creates a run of this workflow (the run lifecycle): identity now, execution
   * on `start`. The workflow's declared IO schemas type the run's input and output.
   */
  createRun(
    options?: WorkflowCreateRunOptions,
  ): WorkflowRun<
    StandardSchemaV1.InferInput<TInputSchema>,
    StandardSchemaV1.InferOutput<TOutputSchema>
  >;
}

/**
 * The mutable builder (`createWorkflow`'s return): each operator pushes one entry and returns the
 * same object re-typed, so chains stay fluent and the tip schema advances.
 */
export interface WorkflowBuilder<
  TInputSchema extends StandardSchema = StandardSchema,
  TOutputSchema extends StandardSchema = StandardSchema,
  TPrevSchema extends StandardSchema = StandardSchema,
> {
  /**
   * Sequential step: the previous output (validated by this step's input schema) becomes
   * `inputData`. The only strict axis — a step whose input schema does not accept the previous
   * output is a compile-time error.
   */
  then<TId extends string, TStepInputSchema extends StandardSchema, TStepOutputSchema extends StandardSchema>(
    step: Step<TId, TStepInputSchema, TStepOutputSchema> &
      ThenInputAccepts<TPrevSchema, TStepInputSchema>,
  ): WorkflowBuilder<TInputSchema, TOutputSchema, TStepOutputSchema>;

  /** Concurrent block (`Promise.all`, no cap); output = `{ [step.id]: output }`. */
  parallel<const TSteps extends readonly Step[]>(
    steps: TSteps,
  ): WorkflowBuilder<TInputSchema, TOutputSchema, DataSchema<KeyedOutputsOf<TSteps[number]>>>;

  /**
   * Ordered condition list; the first truthy condition's step runs; output = a keyed object of
   * which only the executed branch's key holds a value.
   */
  branch<
    const TBranches extends readonly (
      readonly [BranchCondition<StandardSchemaV1.InferOutput<TPrevSchema>>, Step]
    )[],
  >(
    branches: TBranches,
  ): WorkflowBuilder<TInputSchema, TOutputSchema, DataSchema<Partial<KeyedOutputsOf<BranchStepOf<TBranches>>>>>;

  /** Runs the step over the input array; `concurrency` defaults to 1; output = the output array. */
  foreach<TId extends string, TStepInputSchema extends StandardSchema, TStepOutputSchema extends StandardSchema>(
    step: Step<TId, TStepInputSchema, TStepOutputSchema>,
    options?: { readonly concurrency?: number },
  ): WorkflowBuilder<TInputSchema, TOutputSchema, DataSchema<StandardSchemaV1.InferOutput<TStepOutputSchema>[]>>;

  /** Checks the condition before each iteration and loops while it holds; output = the last iteration's output. */
  dowhile<TId extends string, TStepInputSchema extends StandardSchema, TStepOutputSchema extends StandardSchema>(
    step: Step<TId, TStepInputSchema, TStepOutputSchema>,
    cond: LoopCondition<StandardSchemaV1.InferOutput<TStepInputSchema>>,
  ): WorkflowBuilder<TInputSchema, TOutputSchema, TStepOutputSchema>;

  /** Checks the condition after each iteration (so the step runs at least once) and loops until it holds; output = the last iteration's output. */
  dountil<TId extends string, TStepInputSchema extends StandardSchema, TStepOutputSchema extends StandardSchema>(
    step: Step<TId, TStepInputSchema, TStepOutputSchema>,
    cond: LoopCondition<StandardSchemaV1.InferOutput<TStepOutputSchema>>,
  ): WorkflowBuilder<TInputSchema, TOutputSchema, TStepOutputSchema>;

  /** In-process sleep (`setTimeout` + `AbortSignal`), not durable; the duration is a `DynamicArgument`; the chain tip is unchanged. */
  sleep(duration: SleepDuration): WorkflowBuilder<TInputSchema, TOutputSchema, TPrevSchema>;

  /** Freezes the definition and returns it. Before this call the chain is not runnable. */
  commit(): Workflow<TInputSchema, TOutputSchema>;
}

/** A phantom schema carrying a keyed/arrayed output type through the chain where no real schema exists. */
export type DataSchema<T> = StandardSchema<T, T>;

/** The keyed `{ [step.id]: output }` object a `parallel` block produces. */
export type KeyedOutputsOf<TSteps extends Step> = {
  [TStep in TSteps as TStep['id']]: StandardSchemaV1.InferOutput<TStep['outputSchema']>;
};

/** The steps of an authored branch list, as a union. */
export type BranchStepOf<TBranches extends readonly (readonly [BranchCondition, Step])[]> =
  TBranches[number] extends readonly [unknown, infer TStep extends Step] ? TStep : never;

/**
 * The strict `then` check: the previous output must be accepted by the step's input schema. On a
 * mismatch the extra parameter member is missing, so the error names the rule.
 */
export type ThenInputAccepts<TPrevSchema extends StandardSchema, TStepInputSchema extends StandardSchema> =
  StandardSchemaV1.InferOutput<TPrevSchema> extends StandardSchemaV1.InferInput<TStepInputSchema>
    ? unknown
    : {
        readonly 'then(): the step input schema does not accept the previous output': never;
      };

/** The runtime view of the builder: schemas erased, every operator chaining the same mutable object. */
interface BuilderRuntime<TInputSchema extends StandardSchema, TOutputSchema extends StandardSchema> {
  then(step: Step): BuilderRuntime<TInputSchema, TOutputSchema>;
  parallel(steps: readonly Step[]): BuilderRuntime<TInputSchema, TOutputSchema>;
  branch(
    branches: readonly (readonly [BranchCondition, Step])[],
  ): BuilderRuntime<TInputSchema, TOutputSchema>;
  foreach(
    step: Step,
    options?: { readonly concurrency?: number },
  ): BuilderRuntime<TInputSchema, TOutputSchema>;
  dowhile(step: Step, cond: LoopCondition): BuilderRuntime<TInputSchema, TOutputSchema>;
  dountil(step: Step, cond: LoopCondition): BuilderRuntime<TInputSchema, TOutputSchema>;
  sleep(duration: SleepDuration): BuilderRuntime<TInputSchema, TOutputSchema>;
  commit(): Workflow<TInputSchema, TOutputSchema>;
}

/**
 * Creates a workflow builder. The chain tip starts as the workflow's `inputSchema` — the first
 * `.then` step consumes the run's input — and advances entry by entry until `.commit()` freezes
 * the definition.
 */
export function createWorkflow<
  TInputSchema extends StandardSchema,
  TOutputSchema extends StandardSchema,
>(
  config: WorkflowConfig<TInputSchema, TOutputSchema>,
): WorkflowBuilder<TInputSchema, TOutputSchema, TInputSchema> {
  const entries: WorkflowEntry[] = [];
  let committed: Workflow<TInputSchema, TOutputSchema> | undefined;

  /** Commits the frozen definition once; later `commit()` calls return the same object. */
  function commit(): Workflow<TInputSchema, TOutputSchema> {
    const existing = committed;
    if (existing !== undefined) return existing;
    for (const entry of entries) freezeEntry(entry);
    const base = {
      id: config.id,
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema,
      tracer: config.tracer,
      logger: config.logger,
      storage: config.storage,
      entries: Object.freeze(entries),
    };
    const definition: Workflow<TInputSchema, TOutputSchema> = Object.freeze({
      ...base,
      createRun: (options?: WorkflowCreateRunOptions) =>
        createWorkflowRun<TInputSchema, StandardSchemaV1.InferOutput<TOutputSchema>>(base, options),
    });
    committed = definition;
    return definition;
  }

  function push(entry: WorkflowEntry): void {
    if (committed !== undefined) {
      throw new Error(
        `workflow "${config.id}" is committed: its definition is frozen — build a new workflow to change it`,
      );
    }
    entries.push(entry);
  }

  const builder: BuilderRuntime<TInputSchema, TOutputSchema> = {
    then(step) {
      push({ type: 'then', step });
      return builder;
    },
    parallel(steps) {
      // Copy: the caller's array must not be able to mutate the definition afterwards.
      push({ type: 'parallel', steps: [...steps] });
      return builder;
    },
    branch(branches) {
      push({ type: 'branch', branches: branches.map(([cond, step]) => [cond, step] as const) });
      return builder;
    },
    foreach(step, options) {
      push({ type: 'foreach', step, concurrency: resolveConcurrency(config.id, options?.concurrency) });
      return builder;
    },
    dowhile(step, cond) {
      push({ type: 'dowhile', step, cond });
      return builder;
    },
    dountil(step, cond) {
      push({ type: 'dountil', step, cond });
      return builder;
    },
    sleep(duration) {
      push({ type: 'sleep', duration });
      return builder;
    },
    commit,
  };

  // The runtime view is deliberately erased: the fluent type-state is a call-site view over this
  // one mutable object, and no single parameterization expresses every chain position.
  return builder as unknown as WorkflowBuilder<TInputSchema, TOutputSchema, TInputSchema>;
}

/**
 * Resolves a `.foreach` concurrency cap at definition time (the entry carries the number):
 * omitted → `1` (sequential); anything else must be an integer ≥ 1 — `0`, a negative, a fraction
 * or a non-finite number is a definition error, never a silently different gate.
 */
function resolveConcurrency(workflowId: string, concurrency: number | undefined): number {
  if (concurrency === undefined) return 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(
      `workflow "${workflowId}": the foreach concurrency must be an integer >= 1, got ${String(concurrency)}`,
    );
  }
  return concurrency;
}

/** Freezes one entry and the arrays it owns, so a committed definition cannot be mutated. */
function freezeEntry(entry: WorkflowEntry): void {
  switch (entry.type) {
    case 'parallel':
      Object.freeze(entry.steps);
      break;
    case 'branch':
      for (const pair of entry.branches) Object.freeze(pair);
      Object.freeze(entry.branches);
      break;
    default:
      break;
  }
  Object.freeze(entry);
}
