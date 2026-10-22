/**
 * `@oribos/background-tasks` — the background-tasks capability package: application-owned work
 * coordinated as task rows (`docs/architecture/harness.md`「后台任务能力包」节, CUT-H5; ADR-0017
 * 追赶面远层; surface frozen by #190, landed by #197).
 *
 * Phase one of background tasks is a recipe and stays one: a tool acks, the application's own
 * worker finishes out-of-band, one `sendSignal` reports back — zero code in the framework. This
 * package is the phase-two manager, and it is exactly as opt-in: it takes a handler you submit,
 * drives it in-process, and it is not wired into anything unless you wire it.
 *
 * The shape is four moves per task: `submit` writes a row (`accepted`), a lease decides who runs
 * it (`running`), the handler executes in-process (renewed by a heartbeat when configured), and
 * `settle` writes the row back (`done` / `failed`), releases the lease and hands the record to
 * your `onSettle` — where the phase-one recipe picks it up: map the record to the thread it
 * belongs to and `sendSignal` it. `adopt()` sweeps for orphans — rows still `running` whose lease
 * has expired — and re-runs the ones this process can execute (at-least-once; idempotency is the
 * application's, the `recover` caliber of `@oribos/checkpoints`). `untilIdle()` is a package-level
 * wait: it resolves when every task this manager is holding has settled. It does not touch the
 * agent's stream or the core's completion semantics — there is no core here to touch (the types
 * are self-contained; no `@oribos/core` peer).
 *
 * Zero cost when unconfigured: without this package the application owns its background as
 * before. No resident pipeline: with `heartbeatMs` absent there are zero timers — the lease TTL
 * (30 s, the documented expiry window) is then best covered by handlers that finish inside it,
 * and deployments with longer work configure the heartbeat. Zero external dependencies: the
 * Redis lease takes your client as a structural subset and keeps the dependency yours.
 *
 * Package face: [`createBackgroundTasks`], [`BackgroundTasks`], [`BackgroundTasksConfig`],
 * [`TaskRecord`], [`TaskStatus`], [`TaskStore`], [`createInMemoryTaskStore`], [`TaskHandler`],
 * [`SubmitOptions`], [`TaskLease`], [`LeaseHandle`], [`createInMemoryLeaseStore`],
 * [`RedisLeaseClient`], [`RedisLeaseConfig`], [`createRedisLease`].
 */
import { createInMemoryLeaseStore, createRedisLease } from '@oribos/lease';
import type { Lease, LeaseHandle } from '@oribos/lease';

// ── The task row and its store ──────────────────────────────────────────────────────────────────

/**
 * A task row's status. `accepted` → `running` → `done` | `failed`; the settled statuses are
 * terminal (v1 has no retries — retry and backoff policy is the deployment's, outside the row).
 */
export type TaskStatus = 'accepted' | 'running' | 'done' | 'failed';

/**
 * One task row, JSON-only. `payload` and `result` must be JSON-serializable (the row is what a
 * persistence-backed [`TaskStore`] writes verbatim); `error` is the failed handler's message;
 * `attempt` counts executions — 1 after the first run, 2 after an `adopt()` re-run — and is the
 * re-run's visible face; `settledAt` marks the terminal write.
 */
export interface TaskRecord {
  /** The row's identity, minted at submit (a UUID: unique across instances sharing the store). */
  readonly id: string;
  /** Where the task stands; see [`TaskStatus`]. */
  readonly status: TaskStatus;
  /** The handler's input, verbatim (JSON-only). */
  readonly payload: unknown;
  /** The handler's return value on `done` (JSON-only). Absent until settled, and on failure. */
  readonly result?: unknown;
  /** The failed handler's message on `failed`. Absent until settled, and on success. */
  readonly error?: string;
  /** Executions so far: 0 while `accepted`, 1 after the first run, +1 per `adopt()` re-run. */
  readonly attempt: number;
  /** When the row was written, ISO 8601. */
  readonly createdAt: string;
  /** When the row reached `done` / `failed`, ISO 8601. Absent while unsettled. */
  readonly settledAt?: string;
}

/**
 * The package's store port: task rows, JSON-only, four methods (the `@oribos/checkpoints` store
 * family). [`createInMemoryTaskStore`] is the zero-dependency default; a persistence-backed
 * implementation (Redis, SQL, …) is the deployment's to write — the port is all a manager needs.
 */
export interface TaskStore {
  /** Writes the row whole (upsert by `id`). */
  save(record: TaskRecord): Promise<void>;
  /** Reads one row, `null` when absent. */
  get(id: string): Promise<TaskRecord | null>;
  /** All rows, in the store's own order (the in-memory default: write order). */
  list(): Promise<readonly TaskRecord[]>;
  /** Removes one row; absent is a no-op. */
  delete(id: string): Promise<void>;
}

/** The in-memory [`TaskStore`] default: one map, deep-copied at the boundary, zero dependencies. */
export function createInMemoryTaskStore(): TaskStore {
  const tasks = new Map<string, TaskRecord>();
  return {
    save: async (record) => void tasks.set(record.id, structuredClone(record)),
    get: async (id) => {
      const row = tasks.get(id);
      return row === undefined ? null : structuredClone(row);
    },
    list: async () => [...tasks.values()].map((row) => structuredClone(row)),
    delete: async (id) => void tasks.delete(id),
  };
}

// ── The lease port ──────────────────────────────────────────────────────────────────────────────

export type { LeaseHandle };
export type {
  InMemoryLeaseStoreConfig,
  RedisLeaseClient,
  RedisLeaseConfig,
} from '@oribos/lease';
export { createInMemoryLeaseStore, createRedisLease };

/**
 * The package's lease role: a task row's execution ownership — whoever holds it runs the row.
 * The mechanism — port, in-memory default, Redis adapter, token and TTL — lives in
 * `@oribos/lease` (ADR-0020); this alias keeps the frozen `TaskLease` name. Expiry is the loss
 * domain: a holder that stops renewing (a dead process, a handler past the expiry window)
 * loses the row to the next `adopt()` racer.
 */
export type TaskLease = Lease;

// ── The manager ─────────────────────────────────────────────────────────────────────────────────

/**
 * A task handler: receives the submitted payload, returns the row's `result` (JSON-only) or
 * throws to fail the row — either way the settle is written, the lease released and `onSettle`
 * called. It runs in-process; v1 refuses cross-process handler execution by construction.
 */
export type TaskHandler<P = unknown> = (payload: P) => unknown | Promise<unknown>;

/** `submit` input: the payload the handler receives, and the handler itself. */
export interface SubmitOptions<P = unknown> {
  /** The handler's input; JSON-only (it is written into the row verbatim). */
  readonly payload: P;
  /** The work itself; runs in-process, exactly once per attempt. */
  readonly run: TaskHandler<P>;
}

/** `createBackgroundTasks` config; every field optional — the defaults are the zero-config shape. */
export interface BackgroundTasksConfig {
  /** Where task rows live. Default [`createInMemoryTaskStore`]; persistence is the deployment's. */
  readonly store?: TaskStore | undefined;
  /**
   * Who owns a row's execution. Default [`createInMemoryLeaseStore`] — single-process, zero
   * config; multi-instance deployments pass `createRedisLease({ client })` (or any `TaskLease`).
   */
  readonly lease?: TaskLease | undefined;
  /**
   * Heartbeat cadence while a handler runs: an interval renews the held lease, and the
   * acquire/renew TTL is `3 × heartbeatMs` (the documented expiry window: two missed beats).
   * Absent = no timers at all — the lease TTL is then a fixed 30 s, so handlers that may run
   * longer than that need the heartbeat configured.
   */
  readonly heartbeatMs?: number | undefined;
  /**
   * Called after every settle (success or failure), the record in hand — the join to the
   * application's own reactions (the phase-one recipe: map it to its thread and `sendSignal`).
   * A promise returned is awaited before the execution counts as settled for `untilIdle`.
   */
  readonly onSettle?: ((record: TaskRecord) => void | Promise<void>) | undefined;
}

/** The manager's surface: submit, row reads, the orphan sweep, and the package-level wait. */
export interface BackgroundTasks {
  /**
   * Registers a task and starts its execution: the row is written `accepted`, the lease is
   * acquired (the holder runs it — a contender does nothing), the row flips to `running` and the
   * handler runs. Resolves with the `accepted` snapshot as soon as the row is written; the
   * execution continues in the background (`untilIdle` waits for it).
   */
  submit<P = unknown>(options: SubmitOptions<P>): Promise<TaskRecord>;
  /** Reads one row, `null` when absent. */
  get(id: string): Promise<TaskRecord | null>;
  /** Reads every row the store holds. */
  list(): Promise<readonly TaskRecord[]>;
  /**
   * The orphan sweep: every row still `running` whose lease this manager can take is re-run with
   * its handler (`attempt` + 1, at-least-once — idempotency is the application's). Rows whose
   * lease is still held (the owner is alive) are left alone; rows with no handler known to this
   * process are left alone too (v1 refuses cross-process handler execution — a restarted process
   * has no handler for old ids, so adopting across a restart is app-level hand-off, not this
   * call). Resolves with the rows it took, already `running` again.
   */
  adopt(): Promise<readonly TaskRecord[]>;
  /** Resolves when every task this manager is holding has settled; idle resolves at once. */
  untilIdle(): Promise<void>;
}

/** The lease-key namespace for task rows (Redis deployments share these keys). */
const TASK_LEASE_KEY_PREFIX = 'oribos:background-tasks:';

/** The no-heartbeat lease TTL — the documented expiry window when zero timers are configured. */
const DEFAULT_LEASE_TTL_MS = 30_000;

/**
 * Creates the manager. See the package doc for the four moves; the short form: submit writes a
 * row and drives it under the lease, `adopt()` sweeps orphans, `untilIdle()` waits for this
 * manager's executions. Nothing here imports the core or starts anything you did not submit.
 */
export function createBackgroundTasks(config: BackgroundTasksConfig = {}): BackgroundTasks {
  const store = config.store ?? createInMemoryTaskStore();
  const lease = config.lease ?? createInMemoryLeaseStore();
  const heartbeatMs = config.heartbeatMs;
  const onSettle = config.onSettle;
  const ttlMs = heartbeatMs === undefined ? DEFAULT_LEASE_TTL_MS : heartbeatMs * 3;

  /** The in-process handler registry: what this manager can execute (submit is the registration). */
  const handlers = new Map<string, TaskHandler>();
  /** The rows this manager is holding — the `untilIdle` set: one entry per task, not per execution. */
  const pending = new Set<string>();
  const idleWaiters = new Set<() => void>();

  /** A row left this manager's hands (settled — or nothing more it can do for it). */
  function releaseRow(rowId: string): void {
    pending.delete(rowId);
    if (pending.size > 0) return;
    for (const resolve of [...idleWaiters]) {
      idleWaiters.delete(resolve);
      resolve();
    }
  }

  /**
   * Runs one tracked execution. The row is released when the chain ends — normally after
   * `onSettle` completed. An execution that never ends (a hung handler) releases nothing by
   * itself; a later `adopt()` re-run of the same row releases it when *its* chain ends.
   */
  function track(rowId: string, work: () => Promise<void>): void {
    void work()
      .catch(() => undefined)
      .finally(() => releaseRow(rowId));
  }

  /** Claims the row: takes its lease and flips it `running`. `null` = someone else holds it. */
  async function claim(
    record: TaskRecord,
  ): Promise<{ record: TaskRecord; handle: LeaseHandle } | null> {
    const handle = await lease.acquire(`${TASK_LEASE_KEY_PREFIX}${record.id}`, ttlMs);
    if (handle === null) return null;
    const running: TaskRecord = { ...record, status: 'running', attempt: record.attempt + 1 };
    try {
      await store.save(running);
    } catch (error) {
      void handle.release().catch(() => undefined);
      throw error;
    }
    return { record: running, handle };
  }

  /** Runs the handler and settles the row: write back, release the lease, hand out `onSettle`. */
  async function execute(record: TaskRecord, run: TaskHandler, handle: LeaseHandle): Promise<void> {
    let timer: ReturnType<typeof setInterval> | undefined;
    const stopHeartbeat = (): void => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    if (heartbeatMs !== undefined) {
      timer = setInterval(() => {
        void handle.renew(ttlMs).then(
          (stillOurs) => {
            if (!stillOurs) stopHeartbeat();
          },
          () => stopHeartbeat(),
        );
      }, heartbeatMs);
      timer.unref?.();
    }

    let settled: TaskRecord;
    try {
      settled = {
        ...record,
        status: 'done',
        result: await run(record.payload),
        settledAt: new Date().toISOString(),
      };
    } catch (error) {
      settled = {
        ...record,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        settledAt: new Date().toISOString(),
      };
    }
    stopHeartbeat();

    try {
      await store.save(settled);
    } catch {
      // A store that refuses the settle write leaves the row running — an orphan to adopt later.
    }
    try {
      await handle.release();
    } catch {
      // A lost lease is already gone; a release that trips changes nothing.
    }
    handlers.delete(record.id);
    await onSettle?.(settled);
  }

  return {
    submit: async (options) => {
      const record: TaskRecord = {
        id: crypto.randomUUID(),
        status: 'accepted',
        payload: options.payload,
        attempt: 0,
        createdAt: new Date().toISOString(),
      };
      await store.save(record);
      const run = options.run as TaskHandler;
      handlers.set(record.id, run);
      pending.add(record.id);
      track(record.id, async () => {
        const claimed = await claim(record);
        if (claimed === null) return;
        await execute(claimed.record, run, claimed.handle);
      });
      return record;
    },
    get: (id) => store.get(id),
    list: () => store.list(),
    adopt: async () => {
      const rows = await store.list();
      const adopted: TaskRecord[] = [];
      for (const row of rows) {
        if (row.status !== 'running') continue;
        const run = handlers.get(row.id);
        if (run === undefined) continue;
        const claimed = await claim(row);
        if (claimed === null) continue;
        adopted.push(claimed.record);
        pending.add(claimed.record.id);
        track(claimed.record.id, () => execute(claimed.record, run, claimed.handle));
      }
      return adopted;
    },
    untilIdle: () => {
      if (pending.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.add(resolve);
      });
    },
  };
}
