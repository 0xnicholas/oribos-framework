/**
 * `@oribos/inngest` — the Inngest capability package: trigger-level durable execution for
 * workflows (#195; surface frozen by the design ticket #188).
 *
 * The division of labor is the one the design froze: **trigger-level delegation, not step-level
 * takeover.** The walker and the snapshot store stay in process, untouched — the user authors the
 * workflow exactly as always (`createWorkflow({ storage })`, no second authoring entry) and hands
 * the same snapshot store here. What crosses to Inngest is only the *trigger*: `start(run, input)`
 * and `resume(runId, resumeData?)` send trigger events, and the two created functions receive
 * them and drive the run in process. A suspension still lands its snapshot and the function
 * simply ends — a resumed run is a second trigger event. A process that dies mid-run leaves a
 * `running` snapshot, the engine retries the trigger, and the retry re-enters from that snapshot
 * (completed entries replay from their records, the in-flight entry re-executes — the
 * `@oribos/checkpoints` idempotency-cost stance). The snapshot remains the state truth; Inngest
 * steps are deliberately not used for the run's own state.
 *
 * Registration: definitions are process-resident code, so a trigger event can only be served by
 * a process that registered its workflow — `start(run, input)` registers idempotently and the
 * engine's retry backoff gives a restarted process time to warm up. The run → workflow binding is
 * persisted through the snapshot store (a reserved bookkeeping record — the port is JSON-only two
 * methods, and core stays seam-free) so `resume` and the `recover()` sweep survive a restart.
 *
 * Typed rejections (frozen at #188): no durable sleep is added, workflow cron / scheduling is not
 * exposed (`ScheduleStore` only takes agents / signals), and real-time stream following is not
 * exposed (`@oribos/resumable-stream` / `@oribos/distributed-signals` territory).
 */
import { isInngest } from 'inngest';
import type { Inngest, InngestFunction } from 'inngest';
import type {
  StandardSchema,
  StandardSchemaV1,
  Workflow,
  WorkflowRestartOptions,
  WorkflowRunOutcome,
  WorkflowRunSnapshot,
  WorkflowSnapshotStore,
} from '@oribos/core/workflows';

/** The trigger event a `start(run, input)` sends and the start function serves. */
const START_EVENT = 'oribos-workflow-start';
/** The trigger event a `resume(runId, resumeData?)` sends and the resume function serves. */
const RESUME_EVENT = 'oribos-workflow-resume';

/**
 * The event id a start trigger carries, derived from the run id: Inngest's event idempotency
 * deduplicates a redelivered start of the same run, so a duplicate trigger can never start a
 * second concurrent execution of one run.
 */
const startEventId = (runId: string): string => `oribos-start-${runId}`;

/**
 * The reserved snapshot id the run → workflow registry is persisted under: the snapshot port is
 * JSON-only two methods with no listing, so the runner's bookkeeping rides the same port as one
 * extra record. Run ids are UUIDs (or application-chosen strings); an application run id that
 * collides with this sentinel is a pathological case this package does not defend against.
 */
const REGISTRY_SNAPSHOT_ID = '__oribos-inngest-runs';

/** The persisted run registry: managed run id → the workflow id the run belongs to. */
type RunRegistry = Record<string, string>;

/** The event payload the start function receives. */
interface StartEventData {
  readonly workflowId: string;
  readonly runId: string;
  readonly input: unknown;
}

/** The event payload the resume function receives. */
interface ResumeEventData {
  readonly workflowId: string;
  readonly runId: string;
  readonly resumeData?: unknown;
}

/** The `createInngestRunner` config: the Inngest client triggers ride, and the snapshot store. */
export interface InngestRunnerConfig {
  /**
   * The Inngest client the trigger events are sent through and the functions are created on —
   * the same client the app serves (`serve()`) at its endpoint.
   */
  readonly client: Inngest;
  /**
   * The snapshot store the managed runs persist to: pass the same store the workflows attach via
   * `createWorkflow({ storage })` — the snapshot is the state truth, and the registry record
   * rides this store too.
   */
  readonly store: WorkflowSnapshotStore;
}

/** What a `recover()` sweep found: the buckets an operator acts on. */
export interface InngestRecovery {
  /** Runs re-entered to a terminal or newly suspended state during the sweep. */
  readonly recovered: readonly { readonly runId: string; readonly outcome: WorkflowRunOutcome }[];
  /** Runs whose re-entry failed — the run's snapshot carries the failure; the binding is dropped. */
  readonly failed: readonly { readonly runId: string; readonly error: unknown }[];
  /** Runs left untouched: suspended, waiting for their `resume()` answer. */
  readonly suspended: readonly string[];
  /**
   * Mid-flight runs this process cannot continue: the workflow definition is not registered here.
   * `start(run, input)` registers definitions; the engine's trigger retries cover these until the
   * process that owns the definitions is warm.
   */
  readonly pending: readonly { readonly runId: string; readonly workflowId: string }[];
}

/** The runner surface: the functions to serve, the two triggers, and the recovery sweep. */
export interface InngestRunner {
  /**
   * The two Inngest functions (start / resume) to hand to `serve()` alongside the app's own
   * functions. Both are generic: one serve endpoint carries every workflow registered with
   * `start`.
   */
  readonly functions: readonly InngestFunction.Any[];
  /**
   * Registers the committed workflow (idempotently, under its own id) and sends the start
   * trigger with a fresh run id — which this returns for correlation and later `resume` calls.
   * The run executes in the start function, not here: the promise resolves once the event is
   * accepted, the outcome lands in the snapshot store.
   */
  start<TInputSchema extends StandardSchema, TOutputSchema extends StandardSchema>(
    run: Workflow<TInputSchema, TOutputSchema>,
    input: StandardSchemaV1.InferInput<TInputSchema>,
  ): Promise<string>;
  /**
   * Sends the resume trigger for a managed run: the resume function loads the suspended
   * snapshot, validates `resumeData` against the suspended step's `resumeSchema` and re-enters.
   * The run must have been started by this runner (a `start` trigger registered it).
   */
  resume(runId: string, resumeData?: unknown): Promise<void>;
  /**
   * The recovery sweep (the boot-time counterpart of the engine's own trigger retries): walks the
   * persisted registry, re-enters mid-flight (`running`) runs from their snapshots, and reports
   * what it found. Suspended runs wait for their answers; terminal entries are dropped from the
   * registry; definitions this process does not carry are reported pending.
   */
  recover(): Promise<InngestRecovery>;
}

/** Reads the persisted registry; a store without one starts empty. */
async function loadRegistry(store: WorkflowSnapshotStore): Promise<RunRegistry> {
  const snapshot = await store.load(REGISTRY_SNAPSHOT_ID);
  const registry = snapshot?.input;
  return isRunRegistry(registry) ? registry : {};
}

/** The registry record is a snapshot-shaped envelope around one JSON object (`input`). */
function isRunRegistry(value: unknown): value is RunRegistry {
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).every((workflowId) => typeof workflowId === 'string');
}

/** Writes the registry back as one record (the port's save replaces the previous one). */
async function saveRegistry(store: WorkflowSnapshotStore, registry: RunRegistry): Promise<void> {
  const snapshot: WorkflowRunSnapshot = {
    runId: REGISTRY_SNAPSHOT_ID,
    status: 'running',
    input: registry,
    stepResults: {},
    position: 0,
  };
  await store.save(REGISTRY_SNAPSHOT_ID, snapshot);
}

/** Drops one run's binding: terminal runs leave the registry (the sweep stops revisiting them). */
async function forgetRun(store: WorkflowSnapshotStore, runId: string): Promise<void> {
  const registry = await loadRegistry(store);
  if (registry[runId] === undefined) return;
  const remaining: RunRegistry = { ...registry };
  delete remaining[runId];
  await saveRegistry(store, remaining);
}

/** Settles one run's binding from its outcome: suspended stays (it waits for its resume answer). */
async function settleRun(
  store: WorkflowSnapshotStore,
  runId: string,
  outcome: WorkflowRunOutcome,
): Promise<void> {
  if (outcome.status === 'success') await forgetRun(store, runId);
}

/**
 * The step ids of one entry — the local copy of the walker's entry→step mapping (the core does not
 * export it; importing it would be a core change). A sleep entry holds none.
 */
function entryStepIds(entry: Workflow['entries'][number]): readonly string[] {
  switch (entry.type) {
    case 'then':
      return [entry.step.id];
    case 'parallel':
      return entry.steps.map((step) => step.id);
    case 'branch':
      return entry.branches.map(([, step]) => step.id);
    case 'foreach':
    case 'dowhile':
    case 'dountil':
      return [entry.step.id];
    case 'sleep':
      return [];
    default:
      return [];
  }
}

/**
 * The restart options that re-enter a crashed run from its snapshot: the entry the snapshot's
 * `position` points at (the next un-run entry) is the restart target — everything before replays
 * from records, the target re-executes fresh. The public restart primitive is addressed by step
 * name, so the target is named through its first step id; a trailing window whose entry holds no
 * step (a crash right before a sleep) steps back to the nearest earlier entry, and an empty
 * definition restarts whole. Step ids shared across entries stay the ambiguity they already are
 * in the record table: the restart primitive resolves the first entry holding the name, which
 * re-executes more, never less.
 */
function crashRestartOptions(run: Workflow, snapshot: WorkflowRunSnapshot): WorkflowRestartOptions {
  const { entries } = run;
  if (entries.length === 0) return {};
  for (let index = Math.min(snapshot.position, entries.length - 1); index >= 0; index -= 1) {
    const stepId = entryStepIds(entries[index]!)[0];
    if (stepId !== undefined) return { step: stepId };
  }
  return {};
}

/**
 * Builds the runner: everything hangs off the two closures the config pins — the client the
 * triggers ride and the store the truth lives in. The registry is process state plus one
 * persisted record; the definitions live in a process map only `start` fills.
 */
export function createInngestRunner(config: InngestRunnerConfig): InngestRunner {
  const { client, store } = config;
  // The SDK's own brand check: a wrong object here (a composition root, a hand-rolled shape)
  // would otherwise fail as an unexplained crash at first serve instead of at the factory call.
  if (!isInngest(client)) {
    throw new Error(
      'inngest runner: the client config must be an Inngest instance — create it with ' +
        'new Inngest({ id }) and serve the runner.functions on that same client.',
    );
  }

  /** Process-resident definitions: workflow id → committed workflow. Filled by `start`. */
  const registered = new Map<string, Workflow>();

  /** Runs one managed segment to its outcome, dropping the binding when the run fails. */
  async function runToOutcome(
    runId: string,
    segment: () => Promise<WorkflowRunOutcome>,
  ): Promise<WorkflowRunOutcome> {
    try {
      const outcome = await segment();
      await settleRun(store, runId, outcome);
      return outcome;
    } catch (error) {
      // The walker has already written the failed snapshot (or left the run suspended on a
      // rejected resume boundary): re-read the truth and settle the binding from it, then let the
      // error travel — the engine retries the trigger, and the retry re-reads the same snapshot.
      const after = await store.load(runId);
      if (after !== null && after.status !== 'suspended') await forgetRun(store, runId);
      throw error;
    }
  }

  /** The start function's body: trigger → fresh run or crash re-entry, snapshot-driven. */
  async function handleStart(data: unknown): Promise<WorkflowRunOutcome | undefined> {
    const { workflowId, runId, input } = readEvent('start', ['workflowId', 'runId'], data) as {
      workflowId: string;
      runId: string;
      input: unknown;
    };
    const run = registered.get(workflowId);
    if (run === undefined) {
      throw new Error(
        `inngest runner: workflow "${workflowId}" is not registered in this process — a trigger ` +
          'event can only be served where start(run, input) registered its workflow. The engine ' +
          'retries this trigger; recover() sweeps the runs a restarted process cannot resume.',
      );
    }
    const snapshot = await store.load(runId);
    // A snapshot that is neither mid-flight nor missing is terminal (duplicate delivery) or
    // suspended (awaiting its own resume trigger): the trigger has nothing to drive.
    if (snapshot !== null && snapshot.status !== 'running') return undefined;

    return runToOutcome(runId, async () => {
      const managed = run.createRun({ runId });
      return snapshot === null
        ? await managed.start({ inputData: input }).result
        : await managed.restart(crashRestartOptions(run, snapshot));
    });
  }

  /** The resume function's body: trigger → suspended snapshot → re-enter with the answer. */
  async function handleResume(data: unknown): Promise<WorkflowRunOutcome | undefined> {
    const { runId, resumeData } = readEvent('resume', ['runId'], data) as {
      runId: string;
      resumeData?: unknown;
    };
    const snapshot = await store.load(runId);
    if (snapshot === null) {
      throw new Error(
        `inngest runner: cannot resume run "${runId}" — the store has no snapshot for it ` +
          '(resume re-enters a suspended snapshot; a run the store never saw cannot be resumed).',
      );
    }
    // Only a suspended snapshot is answerable: a duplicate delivery of an already-consumed resume
    // lands here (terminal), as does a resume racing a segment still in flight (`running`).
    if (snapshot.status !== 'suspended') return undefined;

    const registry = await loadRegistry(store);
    const workflowId = registry[runId];
    const run = workflowId === undefined ? undefined : registered.get(workflowId);
    if (run === undefined) {
      // The binding is the source of truth; the event's own workflowId only names the work in the
      // error when the binding is gone (a hand-sent event, a cleared store).
      const named = workflowId ?? (typeof data === 'object' && data !== null
        ? (data as Record<string, unknown>).workflowId
        : undefined);
      throw new Error(
        `inngest runner: workflow "${typeof named === 'string' ? named : '<unknown>'}" of suspended run "${runId}" is ` +
          'not registered in this process — resume re-enters the walk in process, so the process ' +
          'serving this trigger must have registered the workflow via start(run, input).',
      );
    }
    const stepId = suspendedStepId(snapshot);
    if (stepId === undefined) {
      throw new Error(
        `inngest runner: suspended run "${runId}" has no suspended step record in its snapshot ` +
          '— the snapshot and the store disagree.',
      );
    }
    return runToOutcome(runId, async () => {
      const managed = run.createRun({ runId });
      return await managed.resume({ step: stepId, ...(resumeData === undefined ? {} : { resumeData }) });
    });
  }

  /** Reads the first suspended step record of a suspended snapshot — the resume target. */
  function suspendedStepId(snapshot: WorkflowRunSnapshot): string | undefined {
    const entry = Object.entries(snapshot.stepResults).find(
      ([, record]) => record.status === 'suspended',
    );
    return entry?.[0];
  }

  /** Event payload shape check: the two field names the handler cannot proceed without. */
  function readEvent(kind: 'start' | 'resume', required: string[], data: unknown): Record<string, unknown> {
    if (typeof data !== 'object' || data === null) {
      throw new Error(`inngest runner: ${kind} trigger carried no event data`);
    }
    const record = data as Record<string, unknown>;
    for (const field of required) {
      if (typeof record[field] !== 'string' || record[field] === '') {
        throw new Error(`inngest runner: ${kind} trigger carried no "${field}" (non-empty string)`);
      }
    }
    return record;
  }

  const functions: InngestFunction.Any[] = [
    client.createFunction(
      { id: 'oribos-workflow-start', triggers: [{ event: START_EVENT }] },
      ({ event }) => handleStart(event.data),
    ),
    client.createFunction(
      { id: 'oribos-workflow-resume', triggers: [{ event: RESUME_EVENT }] },
      ({ event }) => handleResume(event.data),
    ),
  ];

  return {
    functions,
    async start(run, input) {
      registered.set(run.id, run);
      const runId = crypto.randomUUID();
      const registry = await loadRegistry(store);
      await saveRegistry(store, { ...registry, [runId]: run.id });
      await client.send({
        id: startEventId(runId),
        name: START_EVENT,
        data: { workflowId: run.id, runId, input } satisfies StartEventData,
      });
      return runId;
    },
    async resume(runId, resumeData) {
      const registry = await loadRegistry(store);
      const workflowId = registry[runId];
      if (workflowId === undefined) {
        throw new Error(
          `inngest runner: cannot resume run "${runId}" — no managed run carries that id ` +
            '(resume() only reaches runs this runner started via start(run, input)).',
        );
      }
      await client.send({
        name: RESUME_EVENT,
        data: { workflowId, runId, ...(resumeData === undefined ? {} : { resumeData }) } satisfies ResumeEventData,
      });
    },
    recover,
  };

  /** The recovery sweep: re-enter mid-flight runs, report the rest, rewrite the registry once. */
  async function recover(): Promise<InngestRecovery> {
    const registry = await loadRegistry(store);
    const recovered: { runId: string; outcome: WorkflowRunOutcome }[] = [];
    const failed: { runId: string; error: unknown }[] = [];
    const suspended: string[] = [];
    const pending: { runId: string; workflowId: string }[] = [];

    for (const [runId, workflowId] of Object.entries(registry)) {
      const snapshot = await store.load(runId);
      if (snapshot === null || snapshot.status === 'success' || snapshot.status === 'failed') {
        continue; // stale binding — dropped by the rewrite below
      }
      if (snapshot.status === 'suspended') {
        suspended.push(runId);
        continue;
      }
      const run = registered.get(workflowId);
      if (run === undefined) {
        pending.push({ runId, workflowId });
        continue;
      }
      try {
        const outcome = await runToOutcome(runId, () => {
          const managed = run.createRun({ runId });
          return managed.restart(crashRestartOptions(run, snapshot));
        });
        recovered.push({ runId, outcome });
      } catch (error) {
        failed.push({ runId, error });
      }
    }

    // One rewrite: keep what still waits (suspended runs, recovered-into-suspension runs, pending
    // definitions) and drop everything the sweep settled.
    const settled = new Set<string>([
      ...recovered.filter((entry) => entry.outcome.status === 'success').map((entry) => entry.runId),
      ...failed.map((entry) => entry.runId),
    ]);
    const remaining: RunRegistry = {};
    for (const [runId, workflowId] of Object.entries(registry)) {
      if (!settled.has(runId)) remaining[runId] = workflowId;
    }
    await saveRegistry(store, remaining);
    return { recovered, failed, suspended, pending };
  }
}
