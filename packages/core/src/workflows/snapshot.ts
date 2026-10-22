/**
 * The workflow snapshot shapes and the snapshot storage port (suspend/resume and snapshots; the
 * storage port behind them, ADR-0010). Shapes are pinned and JSON-only: the
 * store receives serializable values — large data is referenced, never embedded.
 *
 * The port is the wiring slot `createWorkflow({ storage })` reserves: attach an adapter, or attach
 * nothing and the core's in-memory default (`in-memory-snapshot-store.ts`) keeps the run's
 * snapshots for this process only.
 */

/** The run status a snapshot carries. Terminal runs are the three-state machine; `running` only appears mid-run. */
export type WorkflowRunStatus = 'running' | 'success' | 'failed' | 'suspended';

/**
 * A step result's status in a snapshot: it completed, it failed, or it suspended the run. The same
 * three readings the boundary events report, so the record and the stream never disagree.
 */
export type StepStatus = 'success' | 'failed' | 'suspended';

/**
 * One step's recorded result inside a snapshot: status, output, boundary timestamps and the
 * suspend payload when the step suspended.
 */
export interface WorkflowStepResultSnapshot {
  readonly status: StepStatus;
  /** The step's validated output; absent when it suspended or failed. */
  readonly output?: unknown;
  /** When the step started, milliseconds since epoch. */
  readonly startedAt?: number;
  /** When the step ended, milliseconds since epoch. */
  readonly endedAt?: number;
  /** The payload `suspend(payload)` carried; present only on a suspended step. */
  readonly suspendPayload?: unknown;
}

/**
 * Where inside a block a run suspended (#54): the iteration-site facts the flat `position` cannot
 * express — `position` names the block's entry, the site names the execution inside it. A snapshot
 * carries it only while `suspended` inside a block; a top-level `then` suspension and every
 * running / terminal snapshot have none. The records carry the rest of the site: a completed arm /
 * iteration is a `success` record, a suspending parallel arm a `suspended` record, so the kinds
 * below carry only what records cannot.
 */
export type WorkflowIterationSite =
  | { readonly kind: 'parallel' }
  | { readonly kind: 'branch' }
  | {
      /** The index of the suspended iteration; the one `resumeData` belongs to. */
      readonly kind: 'foreach';
      readonly suspendedIndex: number;
      /** Outputs already collected, keyed by index as a string (JSON-only, holes absent). */
      readonly collected: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'loop';
      /** Iterations completed before the suspended one (the condition's counting basis). */
      readonly iterationCount: number;
      /** The value the suspended iteration consumed — a mid-block tip no record holds. */
      readonly value: unknown;
    };

/**
 * One run's JSON-serializable state (suspend/resume and snapshots):
 * the run identity, its status, the input it started with, the per-step results and the flat entry
 * position to re-enter from — the `startIdx` equivalent — plus the trace the run's spans belong to,
 * so a resumed segment continues the same trace.
 */
export interface WorkflowRunSnapshot {
  /** Identity of the run this snapshot belongs to. */
  readonly runId: string;
  /** Run status at write time (`running` for step-boundary snapshots). */
  readonly status: WorkflowRunStatus;
  /** The run's start input (JSON-only; large data by reference). */
  readonly input: unknown;
  /** Per-step results, keyed by step id. */
  readonly stepResults: Readonly<Record<string, WorkflowStepResultSnapshot>>;
  /**
   * Position in the flat entry list to re-enter from. Its reading depends on `status`: a suspended
   * snapshot points at the suspended entry, a `running` snapshot at the next un-executed entry,
   * and a terminal `success` snapshot equals the entry count (the end of the list). A caller
   * resolving a position to a restart target uses `restartTargetAt`.
   */
  readonly position: number;
  /**
   * Where inside the block at `position` the run suspended (#54, additive — like `traceId`, a
   * snapshot written before the field existed simply lacks it). Present only while the run is
   * suspended inside a block; `resume` re-enters the block from it. A missing site on a suspended
   * snapshot means the top-level `then` suspension of the earlier shape.
   */
  readonly iterationSite?: WorkflowIterationSite;
  /**
   * The trace the run's spans were exported under (32-hex), written whenever a real span exists —
   * an untraced run, or one whose trace the sampler rejected, carries no id. A resume starts a new
   * `workflow-run` span in this trace, so a suspension does not break the observation tree.
   */
  readonly traceId?: string;
}

/**
 * The workflow snapshot storage port: two
 * methods, JSON-only snapshots. Core ships an in-memory default — a workflow without storage runs
 * purely in memory. Evolution is additive-only (ADR-0010): new capabilities arrive as optional
 * methods plus capability flags, never by changing these signatures.
 */
export interface WorkflowSnapshotStore {
  /** Fetch the latest snapshot of a run; `null` when the store has none. */
  load(runId: string): Promise<WorkflowRunSnapshot | null>;
  /** Write the run's snapshot, replacing the previous one. */
  save(runId: string, snapshot: WorkflowRunSnapshot): Promise<void>;
}
