/**
 * The run's lifecycle events (streaming events) — the workflow's
 * minimal streaming vocabulary. One envelope with the chunk protocol (a discriminated union on
 * `type`, kebab-case words), at run / step boundary granularity, carrying the values that cross
 * each boundary: the run's input and terminal value, every step's input and output.
 *
 * The events are the second consumption of `start`'s output object, delivered in the order the
 * boundaries are crossed (concurrent blocks interleave). A failed run emits the failing step's
 * `step-end` and then rejects the stream with the run's error — there is no `failed` run-end, the
 * error is the run's terminal fact.
 */

import type { StepStatus } from './snapshot.js';

/**
 * The run began: the start boundary accepted the input (a rejected start never emits this — the
 * run did not begin). `input` is the validated value the run consumes, defaults and transforms
 * applied.
 */
export interface WorkflowRunStartEvent {
  readonly type: 'run-start';
  /** Identity of the run (`createRun`'s run id). */
  readonly runId: string;
  /** Identity of the workflow being run. */
  readonly workflowId: string;
  /** The run's validated start input. */
  readonly input: unknown;
}

/**
 * A step's boundary was entered: the value that arrived (validated at the boundary; a rejected
 * input emits the `step-end` with status `failed` and no `step-start` value of its own).
 *
 * One pair per step execution: a `foreach` iteration, a loop iteration and a `parallel` arm each
 * cross their step's boundary — the run's records aggregate by step id, the events do not.
 */
export interface WorkflowStepStartEvent {
  readonly type: 'step-start';
  /** The step's id. */
  readonly stepId: string;
  /** The value that arrived at the step's input boundary. */
  readonly input: unknown;
}

/**
 * A step's boundary was left: how it ended, and what it produced when it succeeded. `suspended`
 * means the step suspended the run — a suspend is not a step failure, wherever it was raised (a
 * block's iteration site included, #54): the boundary closes `suspended` and the signal keeps
 * travelling, so the event, the record and the snapshot all read the same way.
 */
export interface WorkflowStepEndEvent {
  readonly type: 'step-end';
  /** The step's id. */
  readonly stepId: string;
  /** How this execution of the step ended. */
  readonly status: StepStatus;
  /** The step's validated output; present only when `status` is `success`. */
  readonly output?: unknown;
}

/**
 * The run reached its terminal state — `success` with the workflow's terminal value, or
 * `suspended` when a step raised the suspend signal. A failed run has no run-end: the stream
 * rejects with the run's error instead.
 */
export interface WorkflowRunEndEvent {
  readonly type: 'run-end';
  /** The run's terminal status. */
  readonly status: 'success' | 'suspended';
  /** The workflow's terminal value; present only on `success`. */
  readonly output?: unknown;
}

/** One event of the core's lifecycle event stream (streaming events). */
export type WorkflowEvent =
  | WorkflowRunStartEvent
  | WorkflowStepStartEvent
  | WorkflowStepEndEvent
  | WorkflowRunEndEvent;
