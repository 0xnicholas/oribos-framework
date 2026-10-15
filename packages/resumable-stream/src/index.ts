/**
 * `@oribos/resumable-stream` — the resumable-stream capability package: reconnectable agent
 * streams (`docs/architecture/harness.md` CUT-H1, ADR-0017 追赶面中层;#184).
 *
 * The carrying seam is the output object, not the core: `withEventCache` wraps the chunk
 * stream an agent (or durable agent) already returned, appending every chunk to an
 * `EventCache` as it flows — and `observe(cache, runId)` replays a run's cached chunks in
 * order, then follows the run live until it ends. A client that disconnects mid-stream
 * reconnects with the run id and loses nothing: the recording pass survives the disconnect
 * (the wrapper keeps pumping the inner run for the cache even after its own consumer leaves),
 * and the reconnected observer replays from the cache and rejoins the live tail.
 *
 * Pins kept (CUT-M1 / ADR-0011): the core has no resume endpoint and gets none — the GET
 * endpoint an application exposes is the application's; this package only caches and replays
 * events, it never re-drives a run. Zero cost when unconfigured: without the wrapper the
 * core's stream path is untouched. No resident pipeline: everything happens inline in the
 * request that triggered it — no timers, no polling loops, no background workers.
 *
 * `closeOnSuspend` needs no mechanism of its own: a durable run's stream ends with a
 * `finish` chunk (`finishReason: 'suspended'`) and the wrapper closes the run's cache entry
 * on stream end, so observers see the run end exactly when the stream did. Resuming is the
 * application's orchestration (a new run id, a fresh recording).
 *
 * The cache is the package's own port: an in-memory default ships here, and
 * `createRedisEventCache` adapts any Redis-compatible client (`get` / `set` / `del` — the
 * structural subset `ioredis` and `node-redis` both satisfy) for durable replay across
 * restarts. Live following is in-process: a run recorded in another process (or a process
 * that died mid-run) replays from the cache, but `observe` refuses to wait on a run no one
 * in this process is recording (`RunNotLiveError`) — cross-instance live tails are the
 * PubSub package's territory, not a polling loop smuggled in here.
 *
 * Package face: [`withEventCache`], [`observe`], [`EventCache`], [`RunEventLog`],
 * [`RunEventStatus`], [`createInMemoryEventCache`], [`createRedisEventCache`],
 * [`RedisLikeClient`], [`UnknownRunError`], [`RunNotLiveError`].
 */
import type { AgentStreamResult } from '@oribos/core/agent';
import type { Chunk } from '@oribos/core/model';

/** Where a recorded run stands: still streaming, ended, or failed. */
export type RunEventStatus = 'active' | 'done' | 'error';

/** One run's cached event log: its chunks, in stream order, plus where the run stands. */
export interface RunEventLog {
  /** The run id the events were recorded under. */
  readonly runId: string;
  /** The run's chunks in stream order — the replay source. */
  readonly chunks: readonly Chunk[];
  /** `active` while the recording pass is still appending; terminal once closed/failed. */
  readonly status: RunEventStatus;
  /** Why an `error` run failed (the error's message); absent otherwise. */
  readonly error?: string | undefined;
}

/**
 * The package's event-cache port: the seam an external store rides. The in-memory default
 * ([`createInMemoryEventCache`]) carries no dependency; `createRedisEventCache` adapts any
 * Redis-compatible client. One run has one writer (the `withEventCache` wrapper); readers
 * may be anywhere the cache can be read from.
 */
export interface EventCache {
  /** Append one chunk to the run's log, creating the log (status `active`) on first append. */
  append(runId: string, chunk: Chunk): Promise<void>;
  /** Mark the run `done` — its stream ended. Keeps the chunks for replay. */
  close(runId: string): Promise<void>;
  /** Mark the run `error` with the failure's message. Keeps the chunks already cached. */
  fail(runId: string, error: unknown): Promise<void>;
  /** The run's log, or `undefined` for a run this cache has never heard of. */
  read(runId: string): Promise<RunEventLog | undefined>;
  /** Forget the run entirely — the retention knob (the defaults never evict on their own). */
  drop(runId: string): Promise<void>;
}

/** The in-memory `EventCache` default: a Map of run logs, zero dependencies and zero process footprint. */
export function createInMemoryEventCache(): EventCache {
  const logs = new Map<string, { chunks: Chunk[]; status: RunEventStatus; error?: string }>();
  const entry = (runId: string) => {
    let log = logs.get(runId);
    if (log === undefined) {
      log = { chunks: [], status: 'active' };
      logs.set(runId, log);
    }
    return log;
  };
  return {
    append: async (runId, chunk) => void entry(runId).chunks.push(chunk),
    close: async (runId) => void (entry(runId).status = 'done'),
    fail: async (runId, error) => {
      const log = entry(runId);
      log.status = 'error';
      log.error = errorMessage(error);
    },
    read: async (runId) => {
      const log = logs.get(runId);
      if (log === undefined) return undefined;
      return { runId, chunks: [...log.chunks], status: log.status, error: log.error };
    },
    drop: async (runId) => void logs.delete(runId),
  };
}

/**
 * The structural subset of a Redis-compatible client the adapter calls: `get`, `set`, `del`
 * with string values. `ioredis` and `node-redis` clients both satisfy it as-is — pass yours,
 * keep the dependency yours.
 */
export interface RedisLikeClient {
  /** GET a key; `null` when absent (both major clients' missing-key convention). */
  get(key: string): Promise<string | null>;
  /** SET a key to a string value. */
  set(key: string, value: string): Promise<unknown>;
  /** DEL a key. */
  del(key: string): Promise<unknown>;
}

/** `createRedisEventCache` config: your client, and an optional key prefix. */
export interface RedisEventCacheConfig {
  /** Any Redis-compatible client (`get` / `set` / `del`). */
  readonly client: RedisLikeClient;
  /** Key prefix for this cache's runs; distinct prefixes never collide. Absent = none. */
  readonly prefix?: string | undefined;
}

/**
 * The Redis-backed `EventCache`: one JSON log per run under `<prefix>oribos:stream:<runId>`.
 * Appends are read-modify-write of the whole log (one run has one writer — the wrapper), so
 * the log survives a process restart and any instance sharing the database can replay it.
 * Chunks must be JSON-serializable (the chunk protocol's values are, by construction).
 */
export function createRedisEventCache(config: RedisEventCacheConfig): EventCache {
  const { client } = config;
  const scope = config.prefix === undefined || config.prefix === '' ? '' : `${config.prefix}:`;
  const key = (runId: string) => `${scope}oribos:stream:${runId}`;

  async function load(runId: string): Promise<{
    chunks: Chunk[];
    status: RunEventStatus;
    error?: string | undefined;
  }> {
    const raw = await client.get(key(runId));
    if (raw === null) return { chunks: [], status: 'active' };
    return JSON.parse(raw) as { chunks: Chunk[]; status: RunEventStatus; error?: string };
  }

  async function save(runId: string, log: {
    chunks: Chunk[];
    status: RunEventStatus;
    error?: string | undefined;
  }): Promise<void> {
    await client.set(key(runId), JSON.stringify(log));
  }

  return {
    append: async (runId, chunk) => {
      const log = await load(runId);
      log.chunks.push(chunk);
      await save(runId, log);
    },
    close: async (runId) => {
      const log = await load(runId);
      await save(runId, { ...log, status: 'done' });
    },
    fail: async (runId, error) => {
      const log = await load(runId);
      await save(runId, { ...log, status: 'error', error: errorMessage(error) });
    },
    read: async (runId) => {
      const raw = await client.get(key(runId));
      if (raw === null) return undefined;
      const log = JSON.parse(raw) as { chunks: Chunk[]; status: RunEventStatus; error?: string };
      return { runId, chunks: log.chunks, status: log.status, error: log.error };
    },
    drop: (runId) => Promise.resolve(client.del(key(runId))).then(() => undefined),
  };
}

/** `observe` on a run this cache has never heard of. The application maps it (HTTP: 404). */
export class UnknownRunError extends Error {
  constructor(runId: string) {
    super(`observe: unknown run ${JSON.stringify(runId)} — nothing was recorded under this id`);
    this.name = 'UnknownRunError';
  }
}

/**
 * `observe` on a run the cache says is `active` but no `withEventCache` in this process is
 * recording: the run lives in another instance, or its process died mid-run. The cached
 * chunks replayed fine; waiting for a tail nobody here can see would hang forever, so the
 * refusal is explicit. The application maps it (HTTP: conflict / retry later); cross-instance
 * live tails need a PubSub, which is a different package's seam.
 */
export class RunNotLiveError extends Error {
  constructor(runId: string) {
    super(
      `observe: run ${JSON.stringify(runId)} is active but not recorded in this process — ` +
        'its cached events replayed, but its live tail lives elsewhere (cross-instance live ' +
        'following needs a PubSub; a restarted or crashed recording process leaves the run ' +
        'permanently active in the cache)',
    );
    this.name = 'RunNotLiveError';
  }
}

// ── The live registry: where `observe` finds this process's in-flight recordings ────────────────

/** What a live run's observers hear: appended chunks (with their writer-side position) or the end. */
type LiveEvent =
  | { readonly kind: 'chunk'; readonly seq: number; readonly chunk: Chunk }
  | { readonly kind: 'done' }
  | { readonly kind: 'error'; readonly error: unknown };

/**
 * One in-flight recording. The wrapper is the single writer (chunks hit the cache first, then
 * broadcast with their position); observers subscribe before reading the cache snapshot, so a
 * chunk landing between the two is delivered once — by position, never by timing.
 */
interface LiveRun {
  /** How many chunks have been broadcast (the next chunk's position). */
  seq: number;
  /** True once the run ended; late subscribers hear it immediately. */
  ended: { readonly kind: 'done' } | { readonly kind: 'error'; readonly error: unknown } | undefined;
  readonly subscribers: ((event: LiveEvent) => void)[];
}

/** Live recordings by run id, keyed by cache instance — in-process following only, no globals. */
const liveRuns = new WeakMap<object, Map<string, LiveRun>>();

function liveMap(cache: EventCache): Map<string, LiveRun> {
  let runs = liveRuns.get(cache);
  if (runs === undefined) {
    runs = new Map();
    liveRuns.set(cache, runs);
  }
  return runs;
}

function broadcast(run: LiveRun, event: LiveEvent): void {
  // Chunk events keep the subscribers — a tail has many; a terminal event is one-shot, and
  // detaching on it is what stops a finished run's observer list from growing.
  if (event.kind === 'chunk') {
    for (const subscriber of run.subscribers) subscriber(event);
    return;
  }
  for (const subscriber of run.subscribers.splice(0)) subscriber(event);
}

// ── withEventCache: the recording pass over an output object ───────────────────────────────────

/** `withEventCache` config: the app-chosen run id the events are recorded under, and the cache. */
export interface WithEventCacheConfig {
  /** The id reconnecting clients will `observe` — the application's own key for this run. */
  readonly runId: string;
  /** Where the events go; absent handling = your choice of the two defaults or your own port. */
  readonly cache: EventCache;
}

/**
 * Wraps an agent (or durable agent) stream's output object with event recording: the returned
 * object has the same shape — the same chunk stream to `for await`, the same terminal
 * promises (`text` / `object` / `steps` / `finishReason` / …) — and, as a side effect of the
 * same pass, every chunk is appended to the cache and the run's entry is closed (or failed)
 * when the run ends.
 *
 * The recording survives the consumer: the wrapper's own pump drives the inner run to
 * completion regardless of how it is consumed, so an SSE client hanging up mid-stream leaves
 * the cache holding the whole run — that is the reconnect story's other half (`observe` is
 * the first). A cache that refuses an append fails the wrapped run (the recording is part of
 * the run, not a best-effort side channel — the rag package's fail-the-run precedent). One
 * run id may be recorded once per cache at a time; recording it again while live throws.
 *
 * ```ts
 * const output = withEventCache(agent.stream(input, { memory: { thread, resource } }), {
 *   runId, cache,
 * });
 * ```
 */
export function withEventCache<T extends AgentStreamResult>(
  output: T,
  config: WithEventCacheConfig,
): T {
  const { runId, cache } = config;
  const runs = liveMap(cache);
  if (runs.has(runId)) {
    throw new Error(
      `withEventCache: run ${JSON.stringify(runId)} is already being recorded on this cache — ` +
        'one run id, one recording',
    );
  }
  const run: LiveRun = { seq: 0, ended: undefined, subscribers: [] };
  runs.set(runId, run);

  let started = false;
  let settled = false;
  let failure: { readonly error: unknown } | undefined;
  /** The consumer left the loop; the pump keeps going — the cache is the point. */
  let abandoned = false;
  const buffered: Chunk[] = [];
  const waiting: {
    resolve(result: IteratorResult<Chunk>): void;
    reject(error: unknown): void;
  }[] = [];
  const DONE: IteratorResult<never> = { value: undefined, done: true };

  function start(): void {
    if (started) return;
    started = true;
    void pump();
  }

  async function pump(): Promise<void> {
    const iterator = output[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        await cache.append(runId, next.value);
        const seq = run.seq;
        run.seq += 1;
        if (run.ended === undefined) broadcast(run, { kind: 'chunk', seq, chunk: next.value });
        deliver(next.value);
      }
    } catch (error) {
      await endWithFailure(error);
      return;
    }
    await endWithSuccess();
  }

  /** The run completed: close the cache entry, tell the observers, settle the stream. */
  async function endWithSuccess(): Promise<void> {
    await guard(() => cache.close(runId));
    run.ended = { kind: 'done' };
    broadcast(run, run.ended);
    runs.delete(runId);
    settled = true;
    for (const waiter of waiting.splice(0)) waiter.resolve(DONE);
  }

  /** The run failed (or the cache did): record the failure, settle the stream with the error. */
  async function endWithFailure(error: unknown): Promise<void> {
    await guard(() => cache.fail(runId, error));
    run.ended = { kind: 'error', error };
    broadcast(run, run.ended);
    runs.delete(runId);
    settled = true;
    failure = { error };
    for (const waiter of waiting.splice(0)) waiter.reject(error);
  }

  /** A cache that already failed one call may fail the closing call too — never mask the run's own outcome. */
  async function guard(call: () => Promise<void>): Promise<void> {
    try {
      await call();
    } catch {
      // The recording is broken; the run's own outcome is what the consumer sees.
    }
  }

  /** Hands a chunk to the waiting iterator, or buffers it until one asks. */
  function deliver(chunk: Chunk): void {
    if (abandoned) return;
    const waiter = waiting.shift();
    if (waiter === undefined) {
      buffered.push(chunk);
      return;
    }
    waiter.resolve({ value: chunk, done: false });
  }

  const iterator: AsyncIterator<Chunk> = {
    next(): Promise<IteratorResult<Chunk>> {
      start();
      if (abandoned) return Promise.resolve(DONE);
      const chunk = buffered.shift();
      if (chunk !== undefined) return Promise.resolve({ value: chunk, done: false });
      if (failure !== undefined) return Promise.reject(failure.error);
      if (settled) return Promise.resolve(DONE);
      return new Promise<IteratorResult<Chunk>>((resolve, reject) => {
        waiting.push({ resolve, reject });
      });
    },
    return(): Promise<IteratorResult<Chunk>> {
      abandoned = true;
      buffered.length = 0;
      return Promise.resolve(DONE);
    },
  };

  const surface: Record<string | symbol, unknown> = {
    [Symbol.asyncIterator]: () => iterator,
  };
  // The inner terminal keys, each forwarded lazily: reading one starts the recording pass and
  // hands out the inner promise unchanged (same run, same value, same laziness).
  for (const key of Object.keys(output)) {
    Object.defineProperty(surface, key, {
      enumerable: true,
      configurable: true,
      get() {
        start();
        return (output as Record<string, unknown>)[key];
      },
    });
  }
  return surface as T;
}

/**
 * Replays a run's cached chunks in stream order, then follows the run live until it ends —
 * the reconnecting client's whole read: one call, first the events it missed, then the tail
 * it would have seen had it never left.
 *
 * - A **finished** run replays from anywhere the cache can be read (with the Redis adapter:
 * from any instance sharing the database) and then ends; a **failed** run replays what it
 * produced and then rejects with the recorded failure.
 * - A **live** run (being recorded by a `withEventCache` wrapper in this process) replays
 * and follows in-process, chunk by chunk, ending exactly when the run does — including a
 * durable run's suspension (`finishReason: 'suspended'`): the observer sees the run end and
 * reconnects later with the resume run's id.
 * - An **active-but-not-live** run (recorded in another instance, or its process died
 * mid-run) replays its cached chunks and then throws [`RunNotLiveError`] — waiting on a tail
 * nobody here can see would hang forever. An unknown run throws [`UnknownRunError`].
 *
 * The application owns the endpoint that turns this into HTTP (SSE or otherwise) — the core
 * keeps no resume endpoint (CUT-M1); this is the read side of that application's route.
 */
export function observe(cache: EventCache, runId: string): AsyncIterable<Chunk> {
  return {
    [Symbol.asyncIterator]: () => replayAndFollow(cache, runId),
  };
}

/** The single pass behind `observe`: snapshot the cache, then tail the live broadcast. */
async function* replayAndFollow(cache: EventCache, runId: string): AsyncGenerator<Chunk> {
  const live = liveRuns.get(cache)?.get(runId);

  // Not being recorded here: everything must come from the cache, and the cache must know it.
  if (live === undefined) {
    const log = await cache.read(runId);
    if (log === undefined) throw new UnknownRunError(runId);
    for (const chunk of log.chunks) yield chunk;
    if (log.status === 'done') return;
    if (log.status === 'error') {
      throw new Error(`observe: run ${JSON.stringify(runId)} failed: ${log.error ?? 'unknown error'}`);
    }
    throw new RunNotLiveError(runId);
  }

  // Live here: subscribe first, snapshot second — a chunk landing between the two is carried
  // by its position in the broadcast and skipped against the snapshot, so it arrives once.
  const queue: LiveEvent[] = [];
  let wake: (() => void) | undefined;
  const subscriber = (event: LiveEvent): void => {
    queue.push(event);
    wake?.();
  };
  if (live.ended === undefined) live.subscribers.push(subscriber);
  else queue.push(live.ended);

  const log = await cache.read(runId);
  const snapshot = log?.chunks ?? [];
  for (const chunk of snapshot) yield chunk;

  for (;;) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      continue;
    }
    const event = queue.shift();
    if (event === undefined) continue;
    if (event.kind === 'chunk') {
      // Already inside the snapshot the run replayed from — position, not timing, decides.
      if (event.seq < snapshot.length) continue;
      yield event.chunk;
    } else if (event.kind === 'done') {
      return;
    } else {
      throw event.error;
    }
  }
}

/** The message a failed run's cache entry keeps. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
