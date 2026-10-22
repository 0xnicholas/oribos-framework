/**
 * `@oribos/distributed-signals` — the distributed-signals capability package: cross-instance
 * signals routing (`docs/architecture/harness.md`「跨实例 signals 能力包」节, ADR-0017 追赶面远层;
 * #194, surface frozen by #187).
 *
 * The base signals subsystem is single-process by design: its registry and queues are process
 * memory, and the process dying drops them. This package wraps a `Signals` instance — the core is
 * untouched, there is no injection seam — and routes the three send primitives across instances
 * over two injected ports:
 *
 * - a [`SignalPubSub`], carrying one JSON [`SignalEnvelope`] per thread channel
 *   (`<prefix>oribos:signals:<threadId>`, at-most-once, callback-style), and
 * - a [`SignalLease`], the thread's active-run ownership (`acquire` / `renew` / `release`) that
 *   arbitrates the idle-wake race: every subscribed instance hears every send, and the lease
 *   converges the broadcast redundancy — the holder injects or keeps its run, exactly one loser-free
 *   winner wakes an idle thread.
 *
 * What stays local, verbatim: `stream` / `generate` always hit the wrapped signals directly, and
 * `subscribeToThread` only ever sees this instance's runs — cross-instance chunk tails are
 * refused by construction in v1 (the same caliber refusal as `@oribos/resumable-stream`'s
 * `RunNotLiveError`: a tail nobody here can see is not followed).
 *
 * Delivery semantics are the core's own, widened one domain: at-most-once — an envelope in flight
 * when a process dies is dropped, exactly like the core's process-memory queues. Ordering across
 * instances is best-effort FIFO (one channel per thread is naturally ordered; no sequence numbers).
 * The lease is the wake-race arbiter, not a global mutex: an expired window (documented per mode)
 * can let two instances wake one thread.
 *
 * Zero cost when unconfigured: without this wrapper the signals path is untouched. No resident
 * pipeline: the only timers are the heartbeat's renewal intervals, and only when `heartbeatMs` is
 * configured (off = renewal at step boundaries plus a pre-injection token self-check; unconfigured
 * means zero timers). Zero external dependencies: both Redis adapters take the client as a
 * structural subset — pass yours (`ioredis` matches the shapes as-is; `node-redis` needs a
 * one-line listener argument swap), keep the dependency yours.
 *
 * Package face: [`createDistributedSignals`], [`DistributedSignals`],
 * [`DistributedSignalsConfig`], [`SignalEnvelope`], [`SignalPubSub`],
 * [`createInMemoryPubSub`], [`RedisPubSubClient`], [`createRedisPubSub`], [`SignalLease`],
 * [`LeaseHandle`], [`createInMemoryLeaseStore`], [`RedisLeaseClient`], [`createRedisLease`].
 */
import type {
  AgentGenerateResult,
  AgentMemoryOptions,
  AgentRunOptions,
  AgentStepBoundary,
  AgentStreamResult,
  StructuredOutputConfig,
} from '@oribos/core/agent';
import type { Chunk, ModelMessage } from '@oribos/core/model';
import type { SignalPayload, Signals } from '@oribos/core/signals';
import type { StandardSchema, StandardSchemaV1 } from '@oribos/core/tools';
import type { Lease, LeaseHandle } from '@oribos/lease';

// ── The Lease port ──────────────────────────────────────────────────────────────────────────────

export type { LeaseHandle };
export type {
  InMemoryLeaseStoreConfig,
  RedisLeaseClient,
  RedisLeaseConfig,
} from '@oribos/lease';
export { createInMemoryLeaseStore, createRedisLease } from '@oribos/lease';

/**
 * The package's lease role: the thread's active-run ownership, the idle-wake race's arbiter.
 * The mechanism — port, in-memory default, Redis adapter, token and TTL — lives in
 * `@oribos/lease` (ADR-0020); this alias keeps the frozen `SignalLease` name. Expiry is the
 * loss domain: a holder that stops renewing (a dead process, a stalled run past the expiry
 * window) loses the thread to the next racer.
 */
export type SignalLease = Lease;

// ── The PubSub port ─────────────────────────────────────────────────────────────────────────────


/**
 * The package's PubSub port: at-most-once, callback-style, payload-opaque (a string — the
 * wrapper's envelopes are JSON). The in-memory default ([`createInMemoryPubSub`]) carries no
 * dependency; [`createRedisPubSub`] adapts any Redis-compatible client. Delivery is fire-and-
 * forget: a topic with no subscriber drops the message (the sender itself subscribes before
 * publishing, so its own sends always come back to it).
 */
export interface SignalPubSub {
  /** Delivers the payload to every current subscriber of the topic; resolves when handed off. */
  publish(topic: string, payload: string): Promise<void>;
  /**
   * Subscribes the handler to every topic in the list; resolves once the subscription is live —
   * publishes after it resolves are delivered. Returns the unsubscribe handle.
   */
  subscribe(
    topics: string | readonly string[],
    handler: (topic: string, payload: string) => void,
  ): Promise<() => Promise<void>>;
}

/** The in-memory `SignalPubSub` default: per-topic handler sets, zero dependencies, zero timers. */
export function createInMemoryPubSub(): SignalPubSub {
  const topics = new Map<string, Set<(topic: string, payload: string) => void>>();
  return {
    publish: async (topic, payload) => {
      for (const handler of [...(topics.get(topic) ?? [])]) handler(topic, payload);
    },
    subscribe: async (topics_, handler) => {
      for (const topic of Array.isArray(topics_) ? topics_ : [topics_]) {
        let set = topics.get(topic);
        if (set === undefined) {
          set = new Set();
          topics.set(topic, set);
        }
        set.add(handler);
      }
      return async () => {
        for (const topic of Array.isArray(topics_) ? topics_ : [topics_]) {
          topics.get(topic)?.delete(handler);
        }
      };
    },
  };
}

/**
 * The structural subset of a Redis-compatible client the PubSub adapter calls. `ioredis`
 * satisfies it as-is — its subscribe listener is called `(channel, message)`. `node-redis`
 * delivers `(message, channel)`: wrap the listener (`(message, channel) => handler(channel,
 * message)` is the one-line adaptation), keep the dependency yours.
 */
export interface RedisPubSubClient {
  /** SUBSCRIBE the channels; the listener receives `(channel, message)` per push. */
  subscribe(
    channels: string | readonly string[],
    listener: (channel: string, message: string) => void,
  ): unknown;
  /** UNSUBSCRIBE the channels from this listener. */
  unsubscribe(
    channels: string | readonly string[],
    listener: (channel: string, message: string) => void,
  ): unknown;
  /** PUBLISH the message to the channel. */
  publish(channel: string, message: string): unknown;
}

/** `createRedisPubSub` config: your client. The adapter holds no state of its own. */
export interface RedisPubSubConfig {
  /** Any Redis-compatible client (the [`RedisPubSubClient`] structural subset). */
  readonly client: RedisPubSubClient;
}

/**
 * The Redis-backed `SignalPubSub`: one forwarder per subscription dispatches the client's pushes
 * to the handler by channel; `publish` rides `client.publish`. The subscription is live once the
 * client's `subscribe` resolves.
 */
export function createRedisPubSub(config: RedisPubSubConfig): SignalPubSub {
  const { client } = config;
  return {
    publish: async (topic, payload) => {
      await client.publish(topic, payload);
    },
    subscribe: async (topics, handler) => {
      const channels = Array.isArray(topics) ? [...topics] : [topics];
      const byChannel = new Map(channels.map((channel) => [channel, handler]));
      const forwarder = (channel: string, message: string): void => {
        byChannel.get(channel)?.(channel, message);
      };
      await client.subscribe(channels, forwarder);
      return async () => {
        await client.unsubscribe(channels, forwarder);
      };
    },
  };
}

// ── The envelope ────────────────────────────────────────────────────────────────────────────────

/**
 * One send crossing instances, JSON-serialized on the wire. The `payload` carries the send's own
 * content verbatim: a `message` / `queue` envelope carries the input (`string` or
 * `ModelMessage[]`), a `signal` envelope the open [`SignalPayload`] object. `thread` is the
 * thread id (the string form of the identity's `thread`), `resource` the identity's resource.
 */
export interface SignalEnvelope {
  /** Which send primitive this is — the receiver replays it against the same method. */
  readonly kind: 'message' | 'queue' | 'signal';
  /** The target thread id. */
  readonly thread: string;
  /** The target resource. */
  readonly resource: string;
  /** The send's own content (see the per-kind shape above). */
  readonly payload: string | readonly ModelMessage[] | SignalPayload;
  /**
   * W3C `traceparent` of the send's trace, honored by the receiver: the wake run continues that
   * trace (`AgentRunOptions.traceId` / `parentSpanId` — the sender as remote parent). A value
   * that fails to parse is treated as absent (the receiver's run starts a fresh trace — the
   * degrade adds no failure surface). v1 senders do not fill the field (the send signatures are
   * frozen and the wrapper holds no tracer); the wire format carries it for the receivers.
   */
  readonly traceparent?: string | undefined;
}

// ── The wrapper ─────────────────────────────────────────────────────────────────────────────────

/** `createDistributedSignals` config: the wrapped signals and the two ports. */
export interface DistributedSignalsConfig {
  /** The signals instance being wrapped (`createSignals` output) — untouched. */
  readonly signals: Signals;
  /** Where cross-instance sends travel. The in-memory default suits tests and single-process use. */
  readonly pubsub: SignalPubSub;
  /**
   * The thread active-run ownership port — the idle-wake race's arbiter. Required: cross-instance
   * semantics are exactly what the lease decides (the core's in-process registry cannot see
   * beyond its own process).
   */
  readonly lease: SignalLease;
  /** Namespace for channels and lease keys; both accept a trailing `:` or not. Absent = none. */
  readonly channelPrefix?: string | undefined;
  /**
   * Heartbeat cadence for held leases: an interval renews every lease this wrapper holds.
   * Absent = no timers at all — renewal happens at the wrapper runs' step boundaries, with a
   * token self-check before every cross-instance injection. With it, the acquire/renew TTL is
   * `3 × heartbeatMs` (the documented expiry window: two missed beats); without it the TTL is a
   * fixed 30 s refreshed per step.
   */
  readonly heartbeatMs?: number | undefined;
}

/** The wrapped entry: the same six-method surface as [`Signals`], routed across instances. */
export interface DistributedSignals extends Signals {}

/** The step-renewal mode's lease TTL (no heartbeat configured): refreshed at every step boundary. */
const BOUNDARY_RENEW_TTL_MS = 30_000;

/** The target hint the wrapper's identity errors carry (the memory identity rule's template). */
const TARGET_HINT = 'pass { thread, resource } with both fields.';

/** One thread this wrapper holds the lease for (a live run — user-driven or woken — sits there). */
interface Ownership {
  handle: LeaseHandle;
  /** False once the lease was lost (a `renew` came back `false`): the thread races again. */
  live: boolean;
  timer: ReturnType<typeof setInterval> | undefined;
}

/**
 * Wraps a [`Signals`] instance with cross-instance routing. See the package doc for the routing
 * table and the delivery semantics; the short form:
 *
 * - `stream` / `generate` with a memory identity claim the thread's lease for the run's lifetime
 *   (another instance holding it rejects the run); without an identity they pass through.
 * - the send primitives inject locally while a run is live here (with a token self-check when
 *   the heartbeat is off), otherwise publish an envelope to the thread's channel.
 * - a received envelope injects into a live local run; otherwise every subscriber races the
 *   lease and the winner wakes the thread — the sender itself included, so "idle = wake" is just
 *   the race the sender usually wins.
 */
export function createDistributedSignals(config: DistributedSignalsConfig): DistributedSignals {
  const { signals, pubsub, lease } = config;
  const rawPrefix = config.channelPrefix;
  const scope =
    rawPrefix === undefined || rawPrefix === ''
      ? ''
      : rawPrefix.endsWith(':')
        ? rawPrefix
        : `${rawPrefix}:`;
  const heartbeatMs = config.heartbeatMs;
  const ttlMs = heartbeatMs === undefined ? BOUNDARY_RENEW_TTL_MS : heartbeatMs * 3;

  const channelOf = (threadId: string) => `${scope}oribos:signals:${threadId}`;
  const leaseKeyOf = (threadId: string) => `${scope}oribos:signals-lease:${threadId}`;

  /** thread id → held lease, exactly while a wrapper-driven run is live there. */
  const owned = new Map<string, Ownership>();
  /** Threads this wrapper listens on (engagement = hosted a run or sent). No unsubscribe. */
  const subscribed = new Set<string>();

  /**
   * Validates a target identity — the memory identity rule, restated locally (the core's helpers
   * are internal): both fields present and non-empty, or the throw carries the label and fix.
   */
  function validateTarget(target: AgentMemoryOptions): { threadId: string; resource: string } {
    const thread = target.thread;
    const id = typeof thread === 'string' ? thread : (thread as { id?: unknown } | undefined)?.id;
    if (typeof id !== 'string' || id === '') {
      throw new Error(`distributed-signals: the memory target is missing its thread — ${TARGET_HINT}`);
    }
    if (typeof target.resource !== 'string' || target.resource === '') {
      throw new Error(`distributed-signals: the memory target is missing its resource — ${TARGET_HINT}`);
    }
    return { threadId: id, resource: target.resource };
  }

  async function ensureSubscribed(threadId: string): Promise<void> {
    if (subscribed.has(threadId)) return;
    subscribed.add(threadId);
    await pubsub.subscribe(channelOf(threadId), (_topic, payload) => {
      void receive(threadId, payload);
    });
  }

  function isEnvelope(value: unknown): value is SignalEnvelope {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Record<string, unknown>;
    if (candidate.kind !== 'message' && candidate.kind !== 'queue' && candidate.kind !== 'signal') {
      return false;
    }
    if (typeof candidate.thread !== 'string' || candidate.thread === '') return false;
    if (typeof candidate.resource !== 'string' || candidate.resource === '') return false;
    return candidate.payload !== undefined;
  }

  function parseTraceparent(value: string | undefined): { traceId: string; spanId: string } | undefined {
    if (value === undefined) return undefined;
    const match = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/.exec(value);
    return match === null ? undefined : { traceId: match[1]!, spanId: match[2]! };
  }

  /** Claims the thread: registers ownership and, with a heartbeat configured, starts renewal. */
  function own(threadId: string, handle: LeaseHandle): Ownership {
    const entry: Ownership = { handle, live: true, timer: undefined };
    owned.set(threadId, entry);
    if (heartbeatMs !== undefined) {
      const timer = setInterval(() => {
        void entry.handle.renew(ttlMs).then((stillOurs) => {
          if (!stillOurs) {
            entry.live = false;
            stopHeartbeat(entry);
          }
        });
      }, heartbeatMs);
      timer.unref?.();
      entry.timer = timer;
    }
    return entry;
  }

  function stopHeartbeat(entry: Ownership): void {
    if (entry.timer !== undefined) {
      clearInterval(entry.timer);
      entry.timer = undefined;
    }
  }

  /** Ends one run's hold: heartbeat off, ownership gone, lease released (a lost one: no-op). */
  function settle(threadId: string, entry: Ownership): void {
    stopHeartbeat(entry);
    if (owned.get(threadId) === entry) owned.delete(threadId);
    void entry.handle.release();
  }

  /** The step boundary composed into wrapper runs when the heartbeat is off: renewal per step. */
  function renewalBoundary(entry: Ownership, userBoundary: AgentStepBoundary | undefined): AgentStepBoundary {
    return {
      async beforeNextStep(event) {
        const stillOurs = await entry.handle.renew(ttlMs);
        if (!stillOurs) entry.live = false;
        const theirs = await userBoundary?.beforeNextStep?.(event);
        return theirs ?? [];
      },
      ...(userBoundary?.beforeToolCalls === undefined
        ? {}
        : { beforeToolCalls: userBoundary.beforeToolCalls }),
    };
  }

  /** Replays a received envelope against the same primitive, into the live local run. */
  function deliverLocal(envelope: SignalEnvelope): void {
    const target: AgentMemoryOptions = { thread: envelope.thread, resource: envelope.resource };
    if (envelope.kind === 'queue') {
      void signals.queueMessage(target, envelope.payload as string | ModelMessage[]);
    } else if (envelope.kind === 'signal') {
      void signals.sendSignal(target, envelope.payload as SignalPayload);
    } else {
      void signals.sendMessage(target, envelope.payload as string | ModelMessage[]);
    }
  }

  /** The wake run's input: the payload back into message form (the signal recipe re-rendered). */
  function toInputMessages(envelope: SignalEnvelope): ModelMessage[] {
    if (envelope.kind === 'signal') {
      return [
        { role: 'user', content: [{ type: 'text', text: `[signal] ${JSON.stringify(envelope.payload)}` }] },
      ];
    }
    if (typeof envelope.payload === 'string') {
      return [{ role: 'user', content: [{ type: 'text', text: envelope.payload }] }];
    }
    return [...(envelope.payload as readonly ModelMessage[])];
  }

  function isMissingMemoryConfigError(error: unknown): boolean {
    return error instanceof Error && error.message.includes('passed a memory option');
  }

  /** Detaches a run output this wrapper is abandoning: its terminal promises must not reject
   * unobserved (an unhandled rejection is a failure surface the semantics don't have). */
  function silenceTerminals(output: AgentStreamResult): void {
    for (const key of Object.keys(output as unknown as Record<string, unknown>)) {
      const value = (output as unknown as Record<string, unknown>)[key];
      if (value !== null && typeof value === 'object' && typeof (value as PromiseLike<unknown>).then === 'function') {
        (value as Promise<unknown>).catch(() => {});
      }
    }
  }

  /** Drives one wake run to completion on the thread just leased (identity optional: retry). */
  async function driveWake(
    target: AgentMemoryOptions,
    messages: readonly ModelMessage[],
    envelope: SignalEnvelope,
    entry: Ownership,
    withIdentity: boolean,
  ): Promise<void> {
    const continuation = parseTraceparent(envelope.traceparent);
    const options: AgentRunOptions = {
      ...(withIdentity ? { memory: target } : {}),
      ...(continuation === undefined ? {} : { traceId: continuation.traceId, parentSpanId: continuation.spanId }),
      ...(heartbeatMs === undefined ? { stepBoundary: renewalBoundary(entry, undefined) } : {}),
    };
    const output = signals.stream([...messages], options);
    try {
      const iterator = output[Symbol.asyncIterator]();
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
      }
    } catch (error) {
      silenceTerminals(output);
      if (!isMissingMemoryConfigError(error)) throw error;
      // Memory-less signals: the same history-free wake the core drives (retry, no identity).
      await driveWake(target, messages, envelope, entry, false);
    }
  }

  /** The wake path: hold the lease, drive the run, settle (release) when it ends. */
  async function wake(threadId: string, envelope: SignalEnvelope, handle: LeaseHandle): Promise<void> {
    const entry = own(threadId, handle);
    const target: AgentMemoryOptions = { thread: envelope.thread, resource: envelope.resource };
    try {
      try {
        await driveWake(target, toInputMessages(envelope), envelope, entry, true);
      } catch (error) {
        if (!isMissingMemoryConfigError(error)) throw error;
        // Memory-less signals: the same history-free wake the core drives (retry, no identity).
        await driveWake(target, toInputMessages(envelope), envelope, entry, false);
      }
    } catch {
      // A woken run's failure never reaches its sender (the core's own stance on wakes).
    }
    settle(threadId, entry);
  }

  /** The receive path: inject into a live local run, or race the lease and wake the winner. */
  async function receive(threadId: string, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // a malformed envelope is dropped, never a failure surface
    }
    if (!isEnvelope(parsed)) return;
    const envelope: SignalEnvelope = parsed;
    const entry = owned.get(threadId);
    if (entry?.live) {
      if (heartbeatMs === undefined) {
        // Token self-check before the injection (heartbeat off): a lost lease means the thread
        // has a new owner somewhere — fall through and race like everyone else.
        const stillOurs = await entry.handle.renew(ttlMs);
        if (!stillOurs) entry.live = false;
        else {
          deliverLocal(envelope);
          return;
        }
      } else {
        deliverLocal(envelope);
        return;
      }
    }
    const handle = await lease.acquire(leaseKeyOf(threadId), ttlMs);
    if (handle === null) return; // someone is active or waking — at-most-once, done
    await wake(threadId, envelope, handle);
  }

  /** The send path: local inject while live here, publish to the thread's channel otherwise. */
  async function send(
    kind: SignalEnvelope['kind'],
    target: AgentMemoryOptions,
    payload: string | readonly ModelMessage[] | SignalPayload,
  ): Promise<void> {
    const { threadId, resource } = validateTarget(target);
    await ensureSubscribed(threadId);
    const envelope: SignalEnvelope = { kind, thread: threadId, resource, payload };
    const entry = owned.get(threadId);
    if (entry?.live) {
      if (heartbeatMs === undefined) {
        const stillOurs = await entry.handle.renew(ttlMs);
        if (!stillOurs) entry.live = false;
        else {
          deliverLocal(envelope);
          return;
        }
      } else {
        deliverLocal(envelope);
        return;
      }
    }
    await pubsub.publish(channelOf(threadId), JSON.stringify(envelope));
  }

  /** The run surface: identity-less calls pass through; identified ones claim the lease first. */
  function streamWrapped(
    input: string | ModelMessage[],
    options: AgentRunOptions | undefined,
  ): AgentStreamResult {
    const target = options?.memory;
    if (target === undefined) return signals.stream(input, options);
    const { threadId } = validateTarget(target);
    // A live local run: delegate and let the core's own single-run error surface, verbatim.
    if (owned.get(threadId)?.live) return signals.stream(input, options);

    const userBoundary = options?.stepBoundary;
    let startPromise: Promise<void> | undefined;
    let inner: AgentStreamResult | undefined;
    let failure: { readonly error: unknown } | undefined;
    let settled = false;
    let abandoned = false;
    const buffered: Chunk[] = [];
    const waiting: { resolve(result: IteratorResult<Chunk>): void; reject(error: unknown): void }[] = [];
    const DONE: IteratorResult<Chunk> = { value: undefined, done: true };

    function deliver(chunk: Chunk): void {
      if (abandoned) return;
      const waiter = waiting.shift();
      if (waiter === undefined) {
        buffered.push(chunk);
        return;
      }
      waiter.resolve({ value: chunk, done: false });
    }

    /** Claims the lease, runs the inner stream to completion on a pump of our own — the lease
     * releases when the run ends, not when the consumer leaves. */
    const start = (): Promise<void> => {
      if (startPromise !== undefined) return startPromise;
      startPromise = (async () => {
        const handle = await lease.acquire(leaseKeyOf(threadId), ttlMs);
        if (handle === null) {
          throw new Error(
            `distributed-signals: thread '${threadId}' has a live run on another instance — ` +
              'the lease is held there; await that run, or route through sendMessage.',
          );
        }
        await ensureSubscribed(threadId);
        const entry = own(threadId, handle);
        try {
          inner = signals.stream(input, {
            ...options,
            ...(heartbeatMs === undefined
              ? { stepBoundary: renewalBoundary(entry, userBoundary) }
              : {}),
          });
          const iterator = inner[Symbol.asyncIterator]();
          for (;;) {
            const next = await iterator.next();
            if (next.done) break;
            deliver(next.value);
          }
          settled = true;
          settle(threadId, entry);
          for (const waiter of waiting.splice(0)) waiter.resolve(DONE);
        } catch (error) {
          settled = true;
          if (inner !== undefined) silenceTerminals(inner);
          settle(threadId, entry);
          failure = { error };
          for (const waiter of waiting.splice(0)) waiter.reject(error);
        }
      })();
      return startPromise;
    };

    const iterator: AsyncIterator<Chunk> = {
      next(): Promise<IteratorResult<Chunk>> {
        const starting = start();
        if (failure !== undefined) return Promise.reject(failure.error);
        const chunk = buffered.shift();
        if (chunk !== undefined) return Promise.resolve({ value: chunk, done: false });
        return starting.then(() => {
          const nextChunk = buffered.shift();
          if (nextChunk !== undefined) return { value: nextChunk, done: false };
          if (failure !== undefined) throw failure.error;
          if (settled) return DONE;
          return new Promise<IteratorResult<Chunk>>((resolve, reject) => {
            waiting.push({ resolve, reject });
          });
        });
      },
      /** Leaving the loop abandons delivery, not the run: the pump keeps going (lease hygiene). */
      return(): Promise<IteratorResult<Chunk>> {
        abandoned = true;
        buffered.length = 0;
        return Promise.resolve(DONE);
      },
    };

    // The inner terminal keys, forwarded lazily: reading one starts the claim and hands back the
    // inner value. `then` stays undefined so the surface itself is never mistaken for a promise.
    const surface = new Proxy(objectPrototype, {
      get(_target, key) {
        if (key === Symbol.asyncIterator) return () => iterator;
        if (key === 'then' || key === 'catch' || key === 'finally') return undefined;
        return start().then(() => (inner as unknown as Record<string | symbol, unknown> | undefined)?.[key]);
      },
    });
    return surface as unknown as AgentStreamResult;
  }

  async function generateWrapped<TSchema extends StandardSchema>(
    input: string | ModelMessage[],
    options: AgentRunOptions & { readonly structuredOutput: StructuredOutputConfig<TSchema> },
  ): Promise<AgentGenerateResult<StandardSchemaV1.InferOutput<TSchema>>>;
  async function generateWrapped(
    input: string | ModelMessage[],
    options?: AgentRunOptions,
  ): Promise<AgentGenerateResult>;
  async function generateWrapped(
    input: string | ModelMessage[],
    options?: AgentRunOptions,
  ): Promise<AgentGenerateResult> {
    const target = options?.memory;
    if (target === undefined) return signals.generate(input, options);
    const { threadId } = validateTarget(target);
    if (owned.get(threadId)?.live) return signals.generate(input, options);
    const handle = await lease.acquire(leaseKeyOf(threadId), ttlMs);
    if (handle === null) {
      throw new Error(
        `distributed-signals: thread '${threadId}' has a live run on another instance — ` +
          'the lease is held there; await that run, or route through sendMessage.',
      );
    }
    await ensureSubscribed(threadId);
    const entry = own(threadId, handle);
    try {
      return await signals.generate(input, {
        ...options,
        ...(heartbeatMs === undefined
          ? { stepBoundary: renewalBoundary(entry, options?.stepBoundary) }
          : {}),
      });
    } finally {
      settle(threadId, entry);
    }
  }

  return {
    stream: streamWrapped,
    generate: generateWrapped,
    sendMessage: (target, input) => send('message', target, input),
    queueMessage: (target, input) => send('queue', target, input),
    sendSignal: (target, payload) => send('signal', target, payload),
    subscribeToThread: (target) => signals.subscribeToThread(target),
  };
}

/** The prototype the stream surface's Proxy hangs off (no inherited trap surprises). */
const objectPrototype = Object.prototype;
