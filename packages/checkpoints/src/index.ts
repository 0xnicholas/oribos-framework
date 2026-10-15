/**
 * `@oribos/checkpoints` — the checkpoints capability package: crash-safe agent runs
 * (`docs/architecture/harness.md` CUT-H1, ADR-0017 追赶面中层;#186).
 *
 * The carrying seam is the core's published step boundary, not a new core mechanism:
 * `createCheckpointedAgent({ agent, storage? })` wires `stepBoundary.beforeToolCalls`, so every
 * step that continues a run — the model's calls are known, none has executed — writes one
 * checkpoint of the run's state (the prompt plus that step's own assistant message, the step
 * count, the pending calls, the trace) to an `AgentRunCheckpointStore`. A run the wrapper drives
 * clears its checkpoint as it settles; a checkpoint that remains is the residue of a run whose
 * process died (or exited) mid-flight — its process-side everything is gone, and the store is the
 * only witness.
 *
 * `recover(runId)` replays that residue: boot recovery is this function call — no resident loop,
 * no daemon. The checkpoint re-enters the core's existing resume path. The recorded prompt
 * already ends with the step's assistant message and the recorded calls ride the
 * `AgentRunResume` seed, so the replayed step makes no model call at all — its output came from
 * the checkpoint — and the run continues from where it stopped. `recoverAll()` is the boot sweep:
 * every checkpoint the store holds, replayed in list order, one result per run; a replay that
 * throws is that result's failure and the sweep goes on.
 *
 * The costs are the spec's own and explicit (CUT-H1). A run stops only at step boundaries, so
 * recovery re-sends at most the one model call that was in flight when the process died — every
 * completed step's calls are already answered in the checkpoint's message list and are never
 * re-asked — and the last checkpointed step's tool calls execute again on the replay. Tool side
 * effects must be idempotent; that contract is the application's, not something a package can
 * enforce.
 *
 * Recovery is a boot-time act: call it before new runs start, so every checkpoint the store holds
 * belongs to a process that is gone. A durable store shared by several processes is recovered by
 * each of them unless the deployment gates it (leader election, a lock) — no CAS ships here,
 * along the durable snapshot store's stance — and a run live in another process looks exactly
 * like a dead one through this store. The boot framing is what makes both benign.
 *
 * Suspension composes, it does not mix: a caller's own `stepBoundary` gate that suspends a run
 * parks it exactly as ever. The wrapper writes no checkpoint for a step its gate holds back, and
 * earlier steps' checkpoints are cleared as the parked run settles — so a suspended run stays the
 * suspended machinery's business (the durable wrapper's, or the caller's own resume path).
 *
 * Package face: [`createCheckpointedAgent`], [`CheckpointedAgent`], [`CheckpointedAgentConfig`],
 * [`CheckpointedStreamResult`], [`CheckpointedRunOutcome`], [`RecoveryResult`],
 * [`AgentRunCheckpoint`], [`AgentRunCheckpointStore`], [`createInMemoryAgentRunCheckpointStore`].
 */
import type { Agent } from '@oribos/core/agent';
import type {
  AgentGenerateResult,
  AgentRunOptions,
  AgentRunResume,
  AgentStepBoundary,
  AgentStepBoundaryDecision,
  AgentStreamResult,
  AgentToolCallsBoundaryEvent,
  StructuredOutputConfig,
} from '@oribos/core/agent';
import type { ModelMessage, ToolCallChunk } from '@oribos/core/model';
import type { StandardSchema, StandardSchemaV1 } from '@oribos/core/tools';

/**
 * One run's checkpoint — the run's JSON-serializable state at a step boundary (the checkpoint
 * store port): the run identity (the key `recover(runId)` loads by), the prompt the boundary saw,
 * ending with the step's own assistant message (the shape the core's resume path reads a replayed
 * step's output back from), how many steps the run had completed, the calls the boundary held
 * (never empty — a step with no pending calls ends the run), and the trace the run's spans were
 * exported under, so a recovery continues the same trace (one run, several spans, one trace).
 *
 * Its presence is the state: a checkpoint exists exactly while its run is unfinished, and the
 * wrapper clears it as the run settles. The shape is frozen; evolution of the port is
 * additive-only (ADR-0010), never by changing these fields.
 */
export interface AgentRunCheckpoint {
  /** Identity of the run (checkpoints, spans and `recover`); minted by the wrapper per run. */
  readonly runId: string;
  /** The run's message list at the boundary: prompt + the step's own vendor-shaped assistant message. */
  readonly messages: readonly ModelMessage[];
  /** How many steps the run had completed at the boundary — where a replay continues numbering. */
  readonly stepCount: number;
  /** The calls the boundary held, in call order (the calls a replay executes). */
  readonly toolCalls: readonly ToolCallChunk[];
  /** The trace id (32-hex) the run's spans were exported under; absent when untraced. */
  readonly traceId?: string | undefined;
}

/**
 * The checkpoint storage port (the seam a durable store rides). Unlike the frozen snapshot ports,
 * all four methods are required: the wrapper's settle clear is what keeps a finished run from
 * being replayed, so a store that cannot delete leaves stale checkpoints behind, and a store that
 * cannot list cannot be swept at boot. `list`'s order is the order `recoverAll` replays in.
 *
 * Records are JSON-only (the snapshot ports' discipline): large data is referenced, never
 * embedded. Cross-process safety is the deployment's — no CAS ships here (the module doc's boot
 * framing). The in-memory default ships in this package; a durable store is the deployment's half
 * of the seam.
 */
export interface AgentRunCheckpointStore {
  /** Write the run's checkpoint, replacing the previous one. */
  save(runId: string, checkpoint: AgentRunCheckpoint): Promise<void>;
  /** Fetch the run's latest checkpoint; `null` when the store has none. */
  load(runId: string): Promise<AgentRunCheckpoint | null>;
  /** Forget the run's checkpoint — the wrapper's settle clear. */
  delete(runId: string): Promise<void>;
  /** Every checkpoint the store holds — the boot sweep's discovery, in the store's own order. */
  list(): Promise<readonly AgentRunCheckpoint[]>;
}

/**
 * The in-memory default: a Map of checkpoints, zero dependencies and zero process footprint.
 * Reads and writes cross the port as deep copies (`structuredClone`) — the same discipline as the
 * core's in-memory store defaults, so stored state changes only through the port, exactly like a
 * serializing backend. It does not outlive the process: a real crash recovery needs a durable
 * store attached (the port's whole point).
 */
export function createInMemoryAgentRunCheckpointStore(): AgentRunCheckpointStore {
  const checkpoints = new Map<string, AgentRunCheckpoint>();
  return {
    save: async (runId, checkpoint) => void checkpoints.set(runId, structuredClone(checkpoint)),
    load: async (runId) => {
      const checkpoint = checkpoints.get(runId);
      return checkpoint === undefined ? null : structuredClone(checkpoint);
    },
    delete: async (runId) => void checkpoints.delete(runId),
    list: async () => [...checkpoints.values()].map((checkpoint) => structuredClone(checkpoint)),
  };
}

/** The `createCheckpointedAgent` config. */
export interface CheckpointedAgentConfig {
  /** The agent whose runs this wrapper checkpoints. */
  readonly agent: Agent;
  /**
   * Where a run's per-step checkpoints go. Absent = the package's in-memory default: checkpoints
   * still work, they simply do not outlive the process — and neither would a real crash recovery,
   * so a durable store is the attachment that makes this package's promise matter.
   */
  readonly storage?: AgentRunCheckpointStore | undefined;
}

/**
 * The checkpointed run's surface: `agent.stream`'s output object (same chunk stream, same lazy
 * terminal values), plus the run's durable identity.
 */
export interface CheckpointedStreamResult<TObject = unknown> extends AgentStreamResult<TObject> {
  /** Identity of this run — the key its checkpoints are stored under and `recover` loads by. */
  readonly runId: string;
}

/** What a recovered run ends with: `stream()`'s terminal values, awaited, plus its identity. */
export interface CheckpointedRunOutcome<TObject = unknown> extends AgentGenerateResult<TObject> {
  /** Identity of the run — the same id the dead run ran under. */
  readonly runId: string;
}

/**
 * One entry of a `recoverAll` sweep: the run id the residue was discovered under, and the
 * replay's outcome (`ok: true`) or the error the replay failed with (`ok: false`). A failed
 * entry never aborts the sweep — the remaining runs still recover. The failed run's residue is
 * consumed like any other settled run's: the failure is the application's to handle, and recovery
 * is not a retry loop (a re-run is the application's call).
 */
export type RecoveryResult<TObject = unknown> =
  | { readonly runId: string; readonly ok: true; readonly outcome: CheckpointedRunOutcome<TObject> }
  | { readonly runId: string; readonly ok: false; readonly error: unknown };

/** The checkpointed agent: the agent's run surface wrapped, plus recovery. */
export interface CheckpointedAgent {
  /**
   * Runs the agent once, exactly as `agent.stream` does, with the recording hook attached: every
   * step that continues the run writes a checkpoint before its calls execute, and the run's
   * checkpoint is cleared as the run settles (success, failure or suspension — any settled run is
   * not a crash). The chunks, terminal values and memory behavior are the agent's own.
   */
  stream<TSchema extends StandardSchema>(
    input: string | ModelMessage[],
    options: AgentRunOptions & { readonly structuredOutput: StructuredOutputConfig<TSchema> },
  ): CheckpointedStreamResult<StandardSchemaV1.InferOutput<TSchema>>;
  stream(input: string | ModelMessage[], options?: AgentRunOptions): CheckpointedStreamResult;
  /**
   * Replays a crashed run from its last checkpoint: loads the residue, re-enters the core's
   * resume path (the recorded prompt already ends with the step's assistant message; the
   * recorded calls ride the `AgentRunResume` seed), and drives the run to its next stop. The
   * replayed step makes no model call — its output came from the checkpoint — its tool calls
   * execute (idempotency is the application's contract), and the run continues normally: the
   * only model call a recovery re-sends is the one that was in flight when the process died.
   *
   * `runId` already carries the run's message history, so the options here are the run's shape,
   * not its state: `maxSteps` and everything else the continued segment should keep (`memory`
   * included) is not persisted with the checkpoint, so pass it again (the durable wrapper's
   * `resume` discipline, verbatim). Resolves with the segment's outcome; a run that suspended
   * (a caller gate on the resumed segment) resolves `'suspended'` like any terminal outcome. An
   * unknown `runId` — no checkpoint in this store — is an explicit error. Concurrent recoveries
   * of one residue — the same store and run id — are joined into the one in flight, even across
   * wrapper instances.
   */
  recover(runId: string, options?: AgentRunOptions): Promise<CheckpointedRunOutcome>;
  /**
   * The boot sweep: every checkpoint the store holds, replayed with `recover` in list order, one
   * result per run — a replay that throws is that entry's failure, not the sweep's. The store's
   * own `list` failing rejects the whole call (there is nothing to sweep). The options apply to
   * every replay alike (pass the run's shape: `maxSteps`, `memory`, …). Call it at boot, before
   * new runs start (the module doc's framing).
   */
  recoverAll(options?: AgentRunOptions): Promise<readonly RecoveryResult[]>;
}

/**
 * The package's recovery lock (one registry for the whole package): at most one recovery per
 * checkpoint identity — the `(store, runId)` pair a residue lives under — at a time. A `recover`
 * that finds its identity already in flight joins that promise instead of loading the same
 * residue twice (two replays of one residue would double its side effects); the entry clears
 * when the recovery settles. Keyed by the store object (WeakMap), not the run id alone, so two
 * stores that happen to hold the same run id stay independent — the same mechanism the core's
 * resume lock runs for suspend/resume. Cross-process safety stays the deployment's.
 */
const recoveryLock = createRecoveryLock();

/**
 * Creates the checkpointed agent. See `CheckpointedAgent` for the run surface.
 */
export function createCheckpointedAgent(config: CheckpointedAgentConfig): CheckpointedAgent {
  const { agent } = config;
  const storage = config.storage ?? createInMemoryAgentRunCheckpointStore();

  /**
   * The run's boundary wiring: the wrapper's recording hook around whatever the caller passed,
   * and their `beforeNextStep` (the signals injector's seat) untouched. The caller's gate runs
   * first — a step its gate holds back (a caller-decided suspension) writes no running
   * checkpoint: the parked run's state is the suspended machinery's snapshot, not this package's.
   */
  function boundaryFor(
    record: (event: AgentToolCallsBoundaryEvent) => Promise<void>,
    user: AgentStepBoundary | undefined,
  ): AgentStepBoundary {
    const userGate = user?.beforeToolCalls;
    return {
      ...(user?.beforeNextStep === undefined ? {} : { beforeNextStep: user.beforeNextStep }),
      async beforeToolCalls(
        event: AgentToolCallsBoundaryEvent,
      ): Promise<AgentStepBoundaryDecision | void> {
        const decision = await userGate?.(event);
        if (decision?.suspend !== true) await record(event);
        return decision;
      },
    };
  }

  /**
   * Starts one run of the checkpointed agent — a fresh run (`stream`, id minted) or a recovery
   * (`recover`, the dead run's id and state). The recording hook and the settle clear are wired
   * here, once, for both.
   */
  function startRun(
    runId: string,
    input: string | ModelMessage[],
    options: AgentRunOptions | undefined,
    seed: AgentRunResume | undefined,
  ): AgentStreamResult {
    let clearArmed = false;
    /**
     * Arms the settle clear: once the run has a checkpoint worth clearing (its first boundary
     * write — or, for a replay, the residue it was loaded from), the run's own `finishReason`
     * is read and a branch hangs on it. The read starts the run for a replay that nobody has
     * pulled yet; for a fresh run the boundary hook only ever fires mid-run, so laziness is
     * untouched. The clear is this package's own bookkeeping: it fires after the run settled, so
     * a store that refuses the delete cannot un-settle the run — it leaves a stale checkpoint
     * behind (recovery from a finished run duplicates the tail; the store's own failures are the
     * deployment's to observe).
     */
    function arm(): void {
      if (clearArmed) return;
      clearArmed = true;
      const clear = (): void => {
        void storage.delete(runId).catch(() => undefined);
      };
      void inner.finishReason.then(clear, clear);
    }

    /** The recording hook: the checkpoint goes to the store first, then the clear is armed. */
    async function record(event: AgentToolCallsBoundaryEvent): Promise<void> {
      await storage.save(runId, toCheckpoint(runId, event));
      arm();
    }

    const inner = agent.stream(input, {
      ...options,
      stepBoundary: boundaryFor(record, options?.stepBoundary),
      ...(seed === undefined ? {} : { resume: seed }),
    });
    // A replay starts from an existing residue: even if the replay writes no new checkpoint (a
    // single replayed step that settles the run), the residue must clear when the run ends.
    if (seed !== undefined) arm();
    return inner;
  }

  /** `recover`: load, replay, continue — deduplicated by checkpoint identity (the lock above). */
  function recover(runId: string, options?: AgentRunOptions): Promise<CheckpointedRunOutcome> {
    return recoveryLock.run(storage, runId, () => continueRun(runId, options));
  }

  return {
    stream(input: string | ModelMessage[], options?: AgentRunOptions): CheckpointedStreamResult {
      const runId = crypto.randomUUID();
      // The durable fields ride on the agent's output object without touching its terminal
      // getters — assigning reads no property of the target, so the run stays lazy.
      return Object.assign(startRun(runId, input, options, undefined), { runId });
    },

    recover,

    async recoverAll(options?: AgentRunOptions): Promise<readonly RecoveryResult[]> {
      const checkpoints = await storage.list();
      const results: RecoveryResult[] = [];
      for (const checkpoint of checkpoints) {
        try {
          results.push({ runId: checkpoint.runId, ok: true, outcome: await recover(checkpoint.runId, options) });
        } catch (error) {
          results.push({ runId: checkpoint.runId, ok: false, error });
        }
      }
      return results;
    },
  };

  /** One run's recovery: the load → replay path. */
  async function continueRun(
    runId: string,
    options: AgentRunOptions | undefined,
  ): Promise<CheckpointedRunOutcome> {
    const checkpoint = await storage.load(runId);
    if (checkpoint === null) {
      throw new Error(
        `checkpoints: run '${runId}' has no checkpoint — recover() needs a run whose process ` +
          'died mid-flight with this store (the in-memory default keeps its checkpoints for the ' +
          'wrapper that made them, this process only).',
      );
    }
    // The replayed segment continues the trace the dead run was exported under (the
    // observability anchor): the traceId travels through the existing run option, the only
    // thing a recovery takes from the checkpoint besides the messages and the seed.
    const traced =
      checkpoint.traceId === undefined ? options : { ...options, traceId: checkpoint.traceId };
    const inner = startRun(runId, [...checkpoint.messages], traced, {
      stepCount: checkpoint.stepCount,
      toolCalls: [...checkpoint.toolCalls],
    });
    // The recovered segment's chunks have no consumer — `recover` resolves with the outcome — so
    // they are drained rather than left to buffer behind a reader that never comes (the durable
    // wrapper's resume does the same).
    const iterator = inner[Symbol.asyncIterator]();
    for (;;) {
      if ((await iterator.next()).done) break;
    }
    const result = await materializeTerminals<AgentGenerateResult>(inner);
    return { ...result, runId };
  }
}

/** The checkpoint one boundary produces — spec shape, JSON-only (`AgentRunCheckpoint`). */
function toCheckpoint(runId: string, event: AgentToolCallsBoundaryEvent): AgentRunCheckpoint {
  return {
    runId,
    messages: [...event.messages],
    stepCount: event.stepIndex,
    toolCalls: [...event.pendingCalls],
    ...(event.traceId === '' ? {} : { traceId: event.traceId }),
  };
}

/** The recovery lock's registry shape (see `recoveryLock`). */
interface RecoveryLock {
  /**
   * Runs `task` under the lock for `(store, runId)`: the first caller's task executes, concurrent
   * callers join its promise, and the entry is deleted on settle. `T` flows from the task —
   * joining only ever happens between recoveries of one checkpoint identity, so the joined
   * promise is the caller's own type.
   */
  run<T>(store: object, runId: string, task: () => Promise<T>): Promise<T>;
}

/** Creates one registry. One per package (see `recoveryLock`). */
function createRecoveryLock(): RecoveryLock {
  const inFlight = new WeakMap<object, Map<string, Promise<unknown>>>();
  return {
    run<T>(store: object, runId: string, task: () => Promise<T>): Promise<T> {
      let byRunId = inFlight.get(store);
      if (byRunId === undefined) {
        byRunId = new Map();
        inFlight.set(store, byRunId);
      }
      const running = byRunId.get(runId);
      if (running !== undefined) return running as Promise<T>;
      let locked: Promise<T> | undefined;
      locked = task().finally(() => {
        if (locked !== undefined && byRunId.get(runId) === locked) byRunId.delete(runId);
      });
      byRunId.set(runId, locked);
      return locked;
    },
  };
}

/**
 * A run's terminal record, awaited — a local mirror of the core's internal `materialize` (the one
 * place repo-wide that enumerates the terminal keys, not exported from any entry): a recovery
 * drains its run and reads the same record back. Reading the enumerable getters hands out the
 * agent's own lazy terminals; a terminal field added on the inside flows through untouched.
 */
async function materializeTerminals<TTerminals>(output: object): Promise<TTerminals> {
  const entries = await Promise.all(
    Object.entries(output).map(async ([key, terminal]) => [key, await terminal] as const),
  );
  return Object.fromEntries(entries) as TTerminals;
}
