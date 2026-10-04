import type { RequestContext } from '../agent/types.js';
import type { StandardSchema, StandardSchemaV1 } from '../standard-schema.js';

/**
 * The context one step executes with (the definition surface): the seven
 * pieces the framework guarantees at every step boundary — the same bag the control-flow
 * conditions receive, read-only in spirit there.
 *
 * - `inputData`: the validated (schema output, transforms applied) upstream value — the workflow
 *   input for the first step, the previous step's output otherwise.
 * - `runId` / `signal`: correlation and cancellation, propagated from the run.
 * - `requestContext`: the run's open bag, framework-written `signal` / `runId` included.
 * - `getStepResult(stepId)`: the recorded output of an already-run step (`undefined` when the step
 *   has no recorded result) — cross-step sharing without a state blackboard.
 * - `resumeData`: the `resumeSchema`-validated data a resumed run comes back with; `undefined` on
 *   a normal first pass (and for steps that declare no `resumeSchema`).
 * - `suspend(payload)`: marks the step suspended and unwinds the run; never returns.
 */
export interface StepContext<TInputData = unknown, TResumeData = undefined, TSuspendPayload = unknown> {
  /** The validated upstream value: workflow input for the first step, previous output otherwise. */
  readonly inputData: TInputData;
  /** Identity of the run this step executes in. */
  readonly runId: string;
  /** Cancellation, propagated from the run down into the step. */
  readonly signal: AbortSignal;
  /** The run's request context (the user's per-call open bag plus `signal` / `runId`). */
  readonly requestContext: RequestContext;
  /** The recorded output of an already-run step; `undefined` when it has no recorded result. */
  getStepResult(stepId: string): unknown;
  /** `resumeSchema`-validated resume data; `undefined` on a first pass. */
  readonly resumeData: TResumeData | undefined;
  /**
   * Marks the step suspended with this payload and unwinds the run — never returns: it throws the
   * suspend control signal, which the walker turns into the run's `suspended` outcome wherever the
   * step sits — a top-level `then` entry or inside a block (a `parallel` arm, a `branch` arm, a
   * `foreach` iteration, a loop body, #54). The snapshot carries the block's iteration site when
   * the suspension happened inside one, so `resume` re-enters the block from it. Never catch it as
   * an exception; run it as the step's last act.
   */
  suspend(payload: TSuspendPayload): never;
}

/**
 * A workflow step (the step shape): id + input/output schemas + optional
 * resume/suspend schemas and `retries`, plus `execute`. The id is the key snapshots and
 * parallel/branch output objects use.
 *
 * This is the container-erased view of a step: with no type arguments a step's IO is `unknown`
 * (`Step`), while `createStep` narrows the inference (`Step<'fetch', TIn, TOut, …>`). `execute` is
 * declared as a method so that concretely typed steps stay assignable into `readonly Step[]`
 * without an `any` hole; the resume/suspend schema parameters default to the erased
 * `StandardSchema | undefined` so a step declaring them stays assignable too.
 */
export interface Step<
  TId extends string = string,
  TInputSchema extends StandardSchema = StandardSchema,
  TOutputSchema extends StandardSchema = StandardSchema,
  TResumeSchema extends StandardSchema | undefined = StandardSchema | undefined,
  TSuspendSchema extends StandardSchema | undefined = StandardSchema | undefined,
> {
  /** The step id: snapshot key and parallel/branch output key. */
  readonly id: TId;
  /** Input schema (Standard Schema dual interface, ADR-0003). */
  readonly inputSchema: TInputSchema;
  /** Output schema. */
  readonly outputSchema: TOutputSchema;
  /** Resume data schema — `resume({ step, resumeData })` validates against it. */
  readonly resumeSchema?: TResumeSchema | undefined;
  /** `suspend(payload)` payload schema. */
  readonly suspendSchema?: TSuspendSchema | undefined;
  /**
   * Fixed-interval retry count (errors, retries and the state machine): `n` buys
   * up to `n` extra attempts at the one fixed interval (`retry.ts`), the last error surfacing
   * verbatim when they run out. A non-negative integer; anything else is a definition error.
   */
  readonly retries?: number | undefined;
  /** Runs the step with the schema-validated upstream value and the framework context. */
  execute(
    ctx: StepContext<
      StandardSchemaV1.InferOutput<TInputSchema>,
      ResumeDataOf<TResumeSchema>,
      SuspendPayloadOf<TSuspendSchema>
    >,
  ): StandardSchemaV1.InferOutput<TOutputSchema> | Promise<StandardSchemaV1.InferOutput<TOutputSchema>>;
}

/**
 * The config `createStep` accepts, with the schema type parameters exposed so that `execute`'s
 * context is derived from them. Annotating with bare `StepConfig` accepts any dual-interface
 * schema and widens the inferred types to `unknown`.
 */
export interface StepConfig<
  TId extends string = string,
  TInputSchema extends StandardSchema = StandardSchema,
  TOutputSchema extends StandardSchema = StandardSchema,
  TResumeSchema extends StandardSchema | undefined = undefined,
  TSuspendSchema extends StandardSchema | undefined = undefined,
> {
  /** The step id: snapshot key and parallel/branch output key. */
  readonly id: TId;
  /** Input schema (Standard Schema dual interface, ADR-0003). */
  readonly inputSchema: TInputSchema;
  /** Output schema. */
  readonly outputSchema: TOutputSchema;
  /** Resume data schema; omitted = the step never reads `resumeData`. */
  readonly resumeSchema?: TResumeSchema;
  /** `suspend(payload)` payload schema; omitted = any payload. */
  readonly suspendSchema?: TSuspendSchema;
  /** Fixed-interval retry count; omitted = no retries. See `Step.retries` for the exact semantics. */
  readonly retries?: number;
  /** Runs the step with the schema-validated upstream value and the framework context. */
  execute(
    ctx: StepContext<
      StandardSchemaV1.InferOutput<TInputSchema>,
      ResumeDataOf<TResumeSchema>,
      SuspendPayloadOf<TSuspendSchema>
    >,
  ): StandardSchemaV1.InferOutput<TOutputSchema> | Promise<StandardSchemaV1.InferOutput<TOutputSchema>>;
}

/** The `resumeData` type a resume schema implies; `undefined` when the step declares none. */
export type ResumeDataOf<TSchema extends StandardSchema | undefined> =
  TSchema extends StandardSchema ? StandardSchemaV1.InferOutput<TSchema> : undefined;

/** The `suspend(payload)` payload type a suspend schema implies; `unknown` when the step declares none. */
export type SuspendPayloadOf<TSchema extends StandardSchema | undefined> =
  TSchema extends StandardSchema ? StandardSchemaV1.InferOutput<TSchema> : unknown;

/**
 * Defines a step — a factory for typing only, returning a frozen plain object. Omitted optional
 * fields stay absent, like `createTool`; the id is a type-level literal so the builder can key
 * parallel/branch outputs by it.
 */
export function createStep<
  TId extends string,
  TInputSchema extends StandardSchema,
  TOutputSchema extends StandardSchema,
  TResumeSchema extends StandardSchema | undefined = undefined,
  TSuspendSchema extends StandardSchema | undefined = undefined,
>(
  config: StepConfig<TId, TInputSchema, TOutputSchema, TResumeSchema, TSuspendSchema>,
): Step<TId, TInputSchema, TOutputSchema, TResumeSchema, TSuspendSchema> {
  if (config.retries !== undefined && (!Number.isInteger(config.retries) || config.retries < 0)) {
    throw new Error(
      `createStep("${config.id}"): retries must be an integer >= 0, got ${String(config.retries)}.`,
    );
  }
  return Object.freeze({
    id: config.id,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    ...(config.resumeSchema === undefined ? {} : { resumeSchema: config.resumeSchema }),
    ...(config.suspendSchema === undefined ? {} : { suspendSchema: config.suspendSchema }),
    ...(config.retries === undefined ? {} : { retries: config.retries }),
    execute: config.execute,
  });
}
